//! Sandboxed execution with wasmtime.
//!
//! Isolation model:
//! - The module may not import anything (no WASI, no host functions), so it
//!   can only compute over the bytes we copy into its linear memory.
//! - Each call gets a fresh `Store` + instance: no state survives between
//!   calls and a crash cannot affect the next one.
//! - Fuel bounds CPU (an infinite loop traps), a resource limiter bounds
//!   memory/table growth, and every pointer/length the guest returns is
//!   checked against its memory before the host reads it.
//!
//! Guest ABI (all i32 are guest addresses/lengths):
//! - `memory`                         exported linear memory
//! - `alloc(len: i32) -> i32`         buffer for host input
//! - `dealloc(ptr: i32, len: i32)`    optional, never required
//! - `configure(ptr: i32, len: i32)`  optional, receives settings JSON
//! - `format_sql(ptr, len) -> i64`    UTF-8 in, UTF-8 out
//! - `export_rows(ptr, len) -> i64`   JSON `{columns, rows}` in, bytes out
//! - `describe_schema(ptr, len) -> i64` JSON `{tables}` in, UTF-8 out
//!
//! Return values pack the output as `(ptr << 32) | len`.

use wasmtime::{Config, Engine, ExternType, Instance, Memory, Module, ResourceLimiter, Store, TypedFunc, ValType};

use crate::manifest::{Capability, Manifest};
use crate::{PluginError, PluginResult};

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Fuel per call (roughly one unit per wasm instruction).
    pub fuel: u64,
    /// Maximum linear memory per instance, in bytes.
    pub memory_bytes: usize,
    /// Maximum table elements per table.
    pub table_elements: usize,
    /// Cap on bytes copied into, and read out of, the guest per call.
    pub max_io_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { fuel: 3_000_000_000, memory_bytes: 128 * 1024 * 1024, table_elements: 20_000, max_io_bytes: 16 * 1024 * 1024 }
    }
}

struct Limiter {
    memory_bytes: usize,
    table_elements: usize,
    hit_memory: bool,
}

impl ResourceLimiter for Limiter {
    fn memory_growing(&mut self, _current: usize, desired: usize, _max: Option<usize>) -> wasmtime::Result<bool> {
        if desired > self.memory_bytes {
            self.hit_memory = true;
            wasmtime::bail!("plugin memory limit exceeded");
        }
        Ok(true)
    }
    fn table_growing(&mut self, _current: usize, desired: usize, _max: Option<usize>) -> wasmtime::Result<bool> {
        Ok(desired <= self.table_elements)
    }
    fn instances(&self) -> usize {
        1
    }
    fn tables(&self) -> usize {
        4
    }
    fn memories(&self) -> usize {
        1
    }
}

/// Shared compiler/runtime. Cheap to clone.
#[derive(Clone)]
pub struct Runtime {
    engine: Engine,
    limits: Limits,
}

impl Runtime {
    pub fn new(limits: Limits) -> PluginResult<Self> {
        let mut cfg = Config::new();
        // Compile to Pulley bytecode and interpret it: no executable memory is
        // ever mapped, so the app keeps its no-JIT hardened-runtime entitlements
        // and a compiler bug cannot become native code execution.
        cfg.target("pulley64").map_err(|e| PluginError::Package(format!("wasm engine: {e}")))?;
        cfg.consume_fuel(true);
        cfg.max_wasm_stack(512 * 1024);
        let engine = Engine::new(&cfg).map_err(|e| PluginError::Package(format!("wasm engine: {e}")))?;
        Ok(Self { engine, limits })
    }

    /// Compiles and checks the module against the manifest: no imports, the
    /// required ABI exports exist with the right signatures.
    pub fn load(&self, manifest: &Manifest, wasm: &[u8]) -> PluginResult<LoadedPlugin> {
        let module = Module::new(&self.engine, wasm).map_err(|e| PluginError::Package(format!("invalid wasm module: {e}")))?;
        if let Some(i) = module.imports().next() {
            return Err(PluginError::Package(format!("plugins may not import host functions or WASI (found import {}::{})", i.module(), i.name())));
        }
        if !matches!(module.get_export("memory"), Some(ExternType::Memory(_))) {
            return Err(PluginError::Package("module must export `memory`".into()));
        }
        check_fn(&module, "alloc", &[ValType::I32], &[ValType::I32], true)?;
        check_fn(&module, "dealloc", &[ValType::I32, ValType::I32], &[], false)?;
        check_fn(&module, "configure", &[ValType::I32, ValType::I32], &[], false)?;
        for c in &manifest.capabilities {
            if let Some(name) = c.export_name() {
                check_fn(&module, name, &[ValType::I32, ValType::I32], &[ValType::I64], true)?;
            }
        }
        Ok(LoadedPlugin { module, rt: self.clone(), manifest: manifest.clone() })
    }
}

fn check_fn(m: &Module, name: &str, params: &[ValType], results: &[ValType], required: bool) -> PluginResult<()> {
    let same = |a: &mut dyn ExactSizeIterator<Item = ValType>, b: &[ValType]| a.len() == b.len() && a.zip(b).all(|(x, y)| ValType::eq(&x, y));
    match m.get_export(name) {
        Some(ExternType::Func(f)) if same(&mut f.params(), params) && same(&mut f.results(), results) => Ok(()),
        Some(_) => Err(PluginError::Package(format!("export `{name}` has the wrong type"))),
        None if required => Err(PluginError::Package(format!("module must export `{name}`"))),
        None => Ok(()),
    }
}

#[derive(Clone)]
pub struct LoadedPlugin {
    module: Module,
    rt: Runtime,
    manifest: Manifest,
}

impl LoadedPlugin {
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// Fails with `NotGranted` unless every capability is both declared by the
    /// manifest and present in `granted`.
    fn require(&self, granted: &[Capability], caps: &[Capability]) -> PluginResult<()> {
        match caps.iter().find(|c| !self.manifest.has(**c) || !granted.contains(c)) {
            Some(c) => Err(PluginError::NotGranted(*c)),
            None => Ok(()),
        }
    }

    pub fn format_sql(&self, granted: &[Capability], settings: &serde_json::Value, sql: &str) -> PluginResult<String> {
        self.require(granted, &[Capability::FormatSql])?;
        String::from_utf8(self.invoke("format_sql", settings, sql.as_bytes())?).map_err(|_| PluginError::BadUtf8)
    }

    /// `input` is JSON `{ "columns": [..names], "rows": [[..values]] }`.
    pub fn export_rows(&self, granted: &[Capability], settings: &serde_json::Value, input: &[u8]) -> PluginResult<Vec<u8>> {
        self.require(granted, &[Capability::ExportFormat, Capability::ReadQueryResults])?;
        self.invoke("export_rows", settings, input)
    }

    /// `input` is JSON `{ "tables": [{ "schema", "name", "columns": [..] }] }`.
    pub fn describe_schema(&self, granted: &[Capability], settings: &serde_json::Value, input: &[u8]) -> PluginResult<String> {
        self.require(granted, &[Capability::ReadSchema])?;
        String::from_utf8(self.invoke("describe_schema", settings, input)?).map_err(|_| PluginError::BadUtf8)
    }

    fn invoke(&self, export: &str, settings: &serde_json::Value, input: &[u8]) -> PluginResult<Vec<u8>> {
        let lim = self.rt.limits;
        if input.len() > lim.max_io_bytes {
            return Err(PluginError::InputTooLarge);
        }
        let settings = self.manifest.resolve_settings(settings)?;
        let mut store = Store::new(&self.rt.engine, Limiter { memory_bytes: lim.memory_bytes, table_elements: lim.table_elements, hit_memory: false });
        store.limiter(|l| l);
        store.set_fuel(lim.fuel).map_err(|e| PluginError::Trap(e.to_string()))?;
        let res = (|| {
            let inst = Instance::new(&mut store, &self.module, &[])?;
            let mem = inst.get_memory(&mut store, "memory").ok_or_else(|| wasmtime::format_err!("no memory"))?;
            let alloc: TypedFunc<i32, i32> = inst.get_typed_func(&mut store, "alloc")?;
            if !self.manifest.settings.is_empty() {
                if let Ok(configure) = inst.get_typed_func::<(i32, i32), ()>(&mut store, "configure") {
                    let json = serde_json::to_vec(&settings).expect("settings serialize");
                    let ptr = write_input(&mut store, &mem, &alloc, &json)?;
                    configure.call(&mut store, (ptr, json.len() as i32))?;
                }
            }
            let f: TypedFunc<(i32, i32), i64> = inst.get_typed_func(&mut store, export)?;
            let ptr = write_input(&mut store, &mem, &alloc, input)?;
            let packed = f.call(&mut store, (ptr, input.len() as i32))? as u64;
            let (optr, olen) = ((packed >> 32) as usize, (packed & 0xffff_ffff) as usize);
            if olen > lim.max_io_bytes {
                return Err(wasmtime::Error::new(PluginError::TooLarge("output")));
            }
            let data = mem.data(&store);
            let end = optr.checked_add(olen).filter(|e| *e <= data.len()).ok_or_else(|| wasmtime::Error::new(PluginError::BadPointer))?;
            Ok(data[optr..end].to_vec())
        })();
        res.map_err(|e| classify(e, &store))
    }
}

/// Copies `bytes` into guest memory at a buffer the guest allocated, after
/// checking the returned pointer is in bounds.
fn write_input(store: &mut Store<Limiter>, mem: &Memory, alloc: &TypedFunc<i32, i32>, bytes: &[u8]) -> wasmtime::Result<i32> {
    let ptr = alloc.call(&mut *store, bytes.len() as i32)?;
    let start = ptr as u32 as usize;
    let end = start.checked_add(bytes.len()).filter(|e| *e <= mem.data_size(&*store)).ok_or_else(|| wasmtime::Error::new(PluginError::BadPointer))?;
    mem.data_mut(&mut *store)[start..end].copy_from_slice(bytes);
    Ok(ptr)
}

fn classify(e: wasmtime::Error, store: &Store<Limiter>) -> PluginError {
    if let Some(p) = e.downcast_ref::<PluginError>() {
        return p.clone();
    }
    if store.data().hit_memory {
        return PluginError::MemoryLimit;
    }
    if matches!(e.downcast_ref::<wasmtime::Trap>(), Some(wasmtime::Trap::OutOfFuel)) || store.get_fuel().is_ok_and(|f| f == 0) {
        return PluginError::OutOfFuel;
    }
    // Keep the message short: no host paths or backtraces leak to the UI.
    let msg = e.downcast_ref::<wasmtime::Trap>().map(|t| t.to_string()).unwrap_or_else(|| e.to_string());
    PluginError::Trap(msg.lines().next().unwrap_or_default().chars().take(300).collect())
}
