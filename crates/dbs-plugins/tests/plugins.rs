use std::io::Write;

use dbs_plugins::*;

const EXAMPLE: &[u8] = include_bytes!("../../../examples/plugins/uppercase-keywords/uppercase-keywords.dbsplugin");
const TEST_KEY: [u8; 32] = [7u8; 32];

fn manifest(caps: &[Capability]) -> Manifest {
    let mut m = Manifest {
        id: "com.example.test".into(),
        name: "Test".into(),
        version: "1.2.3".into(),
        api_version: 1,
        min_app_version: "0.1.0".into(),
        description: String::new(),
        author: String::new(),
        capabilities: caps.to_vec(),
        export: None,
        settings: vec![],
        public_key: None,
        signature: None,
    };
    if m.has(Capability::ExportFormat) {
        m.export = Some(ExportInfo { label: "Test".into(), extension: "txt".into() });
    }
    m
}

/// Bump allocator over one page + echo exports; `$body` is spliced into `format_sql`.
fn wat_module(format_body: &str, extra: &str) -> Vec<u8> {
    wat::parse_str(format!(
        r#"(module
          (memory (export "memory") 1)
          (global $heap (mut i32) (i32.const 1024))
          (func (export "alloc") (param $len i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $heap))
            (global.set $heap (i32.add (global.get $heap) (local.get $len)))
            (if (i32.gt_u (global.get $heap) (i32.mul (memory.size) (i32.const 65536)))
              (then (drop (memory.grow (i32.add (i32.div_u (local.get $len) (i32.const 65536)) (i32.const 1))))))
            (local.get $p))
          (func (export "format_sql") (param $ptr i32) (param $len i32) (result i64)
            {format_body})
          {extra})"#
    ))
    .unwrap()
}

const ECHO: &str = "(i64.or (i64.shl (i64.extend_i32_u (local.get $ptr)) (i64.const 32)) (i64.extend_i32_u (local.get $len)))";

fn rt() -> Runtime {
    Runtime::new(Limits { fuel: 50_000_000, memory_bytes: 4 * 1024 * 1024, ..Default::default() }).unwrap()
}

fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, data) in entries {
        w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

// ---------------------------------------------------------------- manifest

#[test]
fn manifest_validation() {
    assert!(manifest(&[Capability::FormatSql]).validate().is_ok());
    for id in ["", "noreverse", "Com.Example.x", "com..x", "com.example.", "1com.example", "com.exa mple", "com.example/../x"] {
        let mut m = manifest(&[Capability::FormatSql]);
        m.id = id.into();
        assert!(matches!(m.validate(), Err(PluginError::Manifest(_))), "id {id:?} should be rejected");
    }
    for v in ["", "1", "1.0", "v1.0.0", "1.0.0.0", "../1.0.0"] {
        let mut m = manifest(&[Capability::FormatSql]);
        m.version = v.into();
        assert!(m.validate().is_err(), "version {v:?} should be rejected");
    }
    assert!(manifest(&[]).validate().is_err(), "no capabilities");
    assert!(manifest(&[Capability::FormatSql, Capability::FormatSql]).validate().is_err(), "duplicate");
    assert!(manifest(&[Capability::ExportFormat]).validate().is_err(), "export without read_query_results");
    let mut m = manifest(&[Capability::FormatSql]);
    m.api_version = 2;
    assert!(matches!(m.validate(), Err(PluginError::Incompatible(_))));

    let good = br#"{"id":"com.example.x","name":"X","version":"1.0.0","min_app_version":"0.1.0","capabilities":["format_sql"]}"#;
    assert!(Manifest::parse(good).is_ok());
    let unknown_cap = br#"{"id":"com.example.x","name":"X","version":"1.0.0","min_app_version":"0.1.0","capabilities":["network"]}"#;
    assert!(matches!(Manifest::parse(unknown_cap), Err(PluginError::Manifest(_))));
    let unknown_field = br#"{"id":"com.example.x","name":"X","version":"1.0.0","min_app_version":"0.1.0","capabilities":["format_sql"],"filesystem":true}"#;
    assert!(Manifest::parse(unknown_field).is_err());
}

#[test]
fn compatibility_check() {
    let mut m = manifest(&[Capability::FormatSql]);
    m.min_app_version = "0.2.0".into();
    assert!(matches!(m.check_compatible("0.1.0"), Err(PluginError::Incompatible(_))));
    assert!(m.check_compatible("0.2.0").is_ok());
    assert!(m.check_compatible("0.2.0-dev").is_ok());
    assert!(m.check_compatible("1.0.0").is_ok());
}

#[test]
fn settings_are_typed_and_defaulted() {
    let mut m = manifest(&[Capability::FormatSql]);
    m.settings = vec![SettingSpec { key: "upper".into(), label: "Upper".into(), kind: SettingKind::Bool, default: serde_json::json!(true) }];
    assert!(m.validate().is_ok());
    assert_eq!(m.resolve_settings(&serde_json::Value::Null).unwrap()["upper"], serde_json::json!(true));
    assert!(m.resolve_settings(&serde_json::json!({"upper": "yes"})).is_err());
    assert!(m.resolve_settings(&serde_json::json!({"other": 1})).is_err());
}

// ---------------------------------------------------------------- package

#[test]
fn package_round_trip() {
    let m = manifest(&[Capability::FormatSql]);
    let wasm = wat_module(ECHO, "");
    let pkg = read_package(&build_package(&m, &wasm).unwrap()).unwrap();
    assert_eq!(pkg.manifest, m);
    assert_eq!(pkg.wasm, wasm);
    assert_eq!(pkg.signer, SignerInfo::Unsigned);
}

#[test]
fn zip_path_traversal_and_extra_entries_rejected() {
    let json = serde_json::to_vec(&manifest(&[Capability::FormatSql])).unwrap();
    let wasm = wat_module(ECHO, "");
    for bad in ["../plugin.json", "/plugin.json", "a/../../plugin.wasm", "..\\plugin.json", "C:/plugin.json"] {
        let z = zip_of(&[(bad, &json), ("plugin.wasm", &wasm)]);
        let err = read_package(&z).unwrap_err();
        assert!(matches!(&err, PluginError::Package(m) if m.contains("unsafe path")), "{bad}: {err}");
    }
    let z = zip_of(&[("plugin.json", &json), ("plugin.wasm", &wasm), ("evil.sh", b"rm -rf /")]);
    assert!(read_package(&z).is_err());
    let z = zip_of(&[("plugin.json", &json), ("other.wasm", &wasm)]);
    assert!(read_package(&z).is_err());
    let z = zip_of(&[("plugin.json", &json)]);
    assert!(read_package(&z).is_err(), "missing wasm");
    assert!(read_package(b"not a zip").is_err());
}

#[test]
fn oversized_entries_rejected() {
    let wasm = wat_module(ECHO, "");
    // Manifest over 64 KiB (compresses to almost nothing: the cap is on uncompressed size).
    let mut big = serde_json::to_vec(&manifest(&[Capability::FormatSql])).unwrap();
    big.pop();
    big.extend_from_slice(format!(r#","description":"{}"}}"#, "a".repeat(70 * 1024)).as_bytes());
    let z = zip_of(&[("plugin.json", &big), ("plugin.wasm", &wasm)]);
    let err = read_package(&z).unwrap_err();
    assert!(matches!(&err, PluginError::Package(m) if m.contains("too large")), "{err}");
    // Wasm over 32 MiB (a zip bomb of zeros).
    let json = serde_json::to_vec(&manifest(&[Capability::FormatSql])).unwrap();
    let huge = vec![0u8; 33 * 1024 * 1024];
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    w.start_file("plugin.json", opts).unwrap();
    w.write_all(&json).unwrap();
    w.start_file("plugin.wasm", opts).unwrap();
    w.write_all(&huge).unwrap();
    let z = w.finish().unwrap().into_inner();
    assert!(z.len() < 1024 * 1024, "compressed bomb should be small");
    let err = read_package(&z).unwrap_err();
    assert!(matches!(&err, PluginError::Package(m) if m.contains("too large")), "{err}");
}

// ---------------------------------------------------------------- signing

#[test]
fn signature_verifies_and_detects_tampering() {
    let wasm = wat_module(ECHO, "");
    let mut m = manifest(&[Capability::FormatSql]);
    sign(&mut m, &wasm, &TEST_KEY);
    let pkg = read_package(&build_package(&m, &wasm).unwrap()).unwrap();
    let SignerInfo::Verified { fingerprint: fp, public_key } = &pkg.signer else { panic!("expected verified") };
    assert_eq!(fp, &fingerprint(&hex::decode(public_key).unwrap()));

    // Tampered wasm.
    let mut evil = wasm.clone();
    evil.extend_from_slice(&[0, 1, 2]);
    assert_eq!(verify_signature(&m, &evil).unwrap_err(), PluginError::BadSignature);
    // Escalated capabilities with the old signature.
    let mut m2 = m.clone();
    m2.capabilities.push(Capability::ReadSchema);
    assert_eq!(verify_signature(&m2, &wasm).unwrap_err(), PluginError::BadSignature);
    // Key swapped for another key.
    let mut m3 = m.clone();
    let mut other = manifest(&[Capability::FormatSql]);
    sign(&mut other, &wasm, &[9u8; 32]);
    m3.public_key = other.public_key.clone();
    assert_eq!(verify_signature(&m3, &wasm).unwrap_err(), PluginError::BadSignature);
    // Garbage hex.
    let mut m4 = m.clone();
    m4.signature = Some("zz".into());
    assert_eq!(verify_signature(&m4, &wasm).unwrap_err(), PluginError::BadSignature);
    // Through a package.
    assert_eq!(read_package(&build_package(&m2, &wasm).unwrap()).unwrap_err(), PluginError::BadSignature);
}

// ---------------------------------------------------------------- runtime

#[test]
fn echo_plugin_runs() {
    let m = manifest(&[Capability::FormatSql]);
    let p = rt().load(&m, &wat_module(ECHO, "")).unwrap();
    assert_eq!(p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "select 1").unwrap(), "select 1");
    // Fresh instance per call: a second call works the same.
    assert_eq!(p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "").unwrap(), "");
}

#[test]
fn capability_gating() {
    let m = manifest(&[Capability::FormatSql]);
    let p = rt().load(&m, &wat_module(ECHO, "")).unwrap();
    // Declared but not granted.
    assert_eq!(p.format_sql(&[], &serde_json::Value::Null, "x").unwrap_err(), PluginError::NotGranted(Capability::FormatSql));
    // Granted list mentions it but manifest does not declare it.
    let rows = br#"{"columns":[],"rows":[]}"#;
    let all = Capability::ALL;
    assert!(matches!(p.export_rows(&all, &serde_json::Value::Null, rows), Err(PluginError::NotGranted(_))));
    assert!(matches!(p.describe_schema(&all, &serde_json::Value::Null, b"{}"), Err(PluginError::NotGranted(_))));

    // Exporter needs both export_format and read_query_results granted.
    let m = manifest(&[Capability::ExportFormat, Capability::ReadQueryResults]);
    let extra = format!(r#"(func (export "export_rows") (param $ptr i32) (param $len i32) (result i64) {ECHO})"#);
    let p = rt().load(&m, &wat_module(ECHO, &extra)).unwrap();
    assert_eq!(p.export_rows(&[Capability::ExportFormat], &serde_json::Value::Null, rows).unwrap_err(), PluginError::NotGranted(Capability::ReadQueryResults));
    assert_eq!(p.export_rows(&[Capability::ExportFormat, Capability::ReadQueryResults], &serde_json::Value::Null, rows).unwrap(), rows);
}

#[test]
fn imports_are_rejected() {
    let wasm = wat::parse_str(
        r#"(module (import "wasi_snapshot_preview1" "fd_write" (func (param i32 i32 i32 i32) (result i32)))
            (memory (export "memory") 1)
            (func (export "alloc") (param i32) (result i32) (i32.const 0))
            (func (export "format_sql") (param i32 i32) (result i64) (i64.const 0)))"#,
    )
    .unwrap();
    let err = rt().load(&manifest(&[Capability::FormatSql]), &wasm).err().unwrap();
    assert!(matches!(&err, PluginError::Package(m) if m.contains("may not import")), "{err}");
}

#[test]
fn missing_or_mistyped_exports_are_rejected() {
    // Declares read_schema but has no describe_schema export.
    let m = manifest(&[Capability::FormatSql, Capability::ReadSchema]);
    assert!(rt().load(&m, &wat_module(ECHO, "")).is_err());
    // format_sql with the wrong signature.
    let wasm = wat::parse_str(r#"(module (memory (export "memory") 1) (func (export "alloc") (param i32) (result i32) (i32.const 0)) (func (export "format_sql") (param i32) (result i32) (i32.const 0)))"#).unwrap();
    assert!(rt().load(&manifest(&[Capability::FormatSql]), &wasm).is_err());
}

#[test]
fn infinite_loop_is_interrupted() {
    let p = rt().load(&manifest(&[Capability::FormatSql]), &wat_module("(loop $l (br $l)) (i64.const 0)", "")).unwrap();
    let t = std::time::Instant::now();
    assert_eq!(p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "x").unwrap_err(), PluginError::OutOfFuel);
    assert!(t.elapsed() < std::time::Duration::from_secs(10));
    assert!(PluginError::OutOfFuel.is_runtime_failure());
}

#[test]
fn memory_hog_hits_limit() {
    // Grow one page at a time forever; growth past 4 MiB traps.
    let hog = "(loop $l (drop (memory.grow (i32.const 1))) (br $l)) (i64.const 0)";
    let p = rt().load(&manifest(&[Capability::FormatSql]), &wat_module(hog, "")).unwrap();
    assert_eq!(p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "x").unwrap_err(), PluginError::MemoryLimit);
    // A module whose *initial* memory is over the limit cannot even start.
    let wasm = wat::parse_str(r#"(module (memory (export "memory") 1000) (func (export "alloc") (param i32) (result i32) (i32.const 0)) (func (export "format_sql") (param i32 i32) (result i64) (i64.const 0)))"#).unwrap();
    let p = rt().load(&manifest(&[Capability::FormatSql]), &wasm).unwrap();
    assert_eq!(p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "x").unwrap_err(), PluginError::MemoryLimit);
}

#[test]
fn out_of_bounds_pointers_rejected() {
    // Output pointer far outside the 1-page memory.
    let oob = "(i64.or (i64.shl (i64.const 0x7fff0000) (i64.const 32)) (i64.const 16))";
    let p = rt().load(&manifest(&[Capability::FormatSql]), &wat_module(oob, "")).unwrap();
    assert_eq!(p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "x").unwrap_err(), PluginError::BadPointer);
    // In-bounds pointer with a length running past the end (ptr + len overflow check).
    let tail = "(i64.or (i64.shl (i64.const 65000) (i64.const 32)) (i64.const 1000))";
    let p = rt().load(&manifest(&[Capability::FormatSql]), &wat_module(tail, "")).unwrap();
    assert_eq!(p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "x").unwrap_err(), PluginError::BadPointer);
    // Length beyond the I/O cap.
    let huge = "(i64.const 0xffffffff)";
    let p = rt().load(&manifest(&[Capability::FormatSql]), &wat_module(huge, "")).unwrap();
    assert!(matches!(p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "x").unwrap_err(), PluginError::TooLarge(_)));
    // alloc returning a pointer where the input does not fit.
    let wasm = wat::parse_str(format!(
        r#"(module (memory (export "memory") 1) (func (export "alloc") (param i32) (result i32) (i32.const 65530))
            (func (export "format_sql") (param $ptr i32) (param $len i32) (result i64) {ECHO}))"#
    ))
    .unwrap();
    let p = rt().load(&manifest(&[Capability::FormatSql]), &wasm).unwrap();
    assert_eq!(p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "0123456789").unwrap_err(), PluginError::BadPointer);
}

#[test]
fn trap_and_bad_utf8_are_contained() {
    let p = rt().load(&manifest(&[Capability::FormatSql]), &wat_module("unreachable", "")).unwrap();
    let e = p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "x").unwrap_err();
    assert!(matches!(e, PluginError::Trap(_)) && e.is_runtime_failure(), "{e}");
    // Returns two bytes that are not valid UTF-8, written via a data segment.
    let wasm = wat::parse_str(
        r#"(module (memory (export "memory") 1) (data (i32.const 16) "\ff\fe")
            (func (export "alloc") (param i32) (result i32) (i32.const 1024))
            (func (export "format_sql") (param i32 i32) (result i64) (i64.or (i64.shl (i64.const 16) (i64.const 32)) (i64.const 2))))"#,
    )
    .unwrap();
    let p = rt().load(&manifest(&[Capability::FormatSql]), &wasm).unwrap();
    assert_eq!(p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "x").unwrap_err(), PluginError::BadUtf8);
}

#[test]
fn oversized_input_rejected_before_running() {
    let p = Runtime::new(Limits { max_io_bytes: 8, ..Default::default() }).unwrap().load(&manifest(&[Capability::FormatSql]), &wat_module(ECHO, "")).unwrap();
    assert_eq!(p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "0123456789").unwrap_err(), PluginError::InputTooLarge);
}

#[test]
fn settings_are_passed_to_configure() {
    // configure stores the first byte of the settings JSON; format_sql returns it.
    let wasm = wat::parse_str(
        r#"(module (memory (export "memory") 1) (global $h (mut i32) (i32.const 1024))
            (func (export "alloc") (param $n i32) (result i32) (local $p i32)
              (local.set $p (global.get $h)) (global.set $h (i32.add (global.get $h) (local.get $n))) (local.get $p))
            (func (export "configure") (param $p i32) (param $n i32) (i32.store8 (i32.const 0) (i32.load8_u (local.get $p))))
            (func (export "format_sql") (param i32 i32) (result i64) (i64.const 1)))"#,
    )
    .unwrap();
    let mut m = manifest(&[Capability::FormatSql]);
    m.settings = vec![SettingSpec { key: "k".into(), label: "K".into(), kind: SettingKind::Number, default: serde_json::json!(1) }];
    let p = rt().load(&m, &wasm).unwrap();
    assert_eq!(p.format_sql(&[Capability::FormatSql], &serde_json::Value::Null, "x").unwrap(), "{");
    assert!(matches!(p.format_sql(&[Capability::FormatSql], &serde_json::json!({"k": "no"}), "x"), Err(PluginError::Manifest(_))));
}

// ---------------------------------------------------------------- example plugin

#[test]
fn example_plugin_formats_sql() {
    let pkg = read_package(EXAMPLE).unwrap();
    assert_eq!(pkg.manifest.id, "dev.dbstudio.examples.uppercase-keywords");
    assert_eq!(pkg.signer, SignerInfo::Unsigned);
    pkg.manifest.check_compatible(env!("CARGO_PKG_VERSION")).unwrap();
    let p = Runtime::new(Limits::default()).unwrap().load(&pkg.manifest, &pkg.wasm).unwrap();
    let g = [Capability::FormatSql];
    let n = serde_json::Value::Null;
    assert_eq!(
        p.format_sql(&g, &n, "select a, t.from from t where x = 'select from' -- order by\nand \"group\" is not null order by 1").unwrap(),
        "SELECT a, t.from FROM t WHERE x = 'select from' -- order by\nAND \"group\" IS NOT NULL ORDER BY 1"
    );
    assert_eq!(
        p.format_sql(&g, &n, "insert into s(v) values ('it''s from') /* select */ returning id").unwrap(),
        "INSERT INTO s(v) VALUES ('it''s from') /* select */ RETURNING id"
    );
    assert_eq!(p.format_sql(&g, &n, "").unwrap(), "");
    // Non-ASCII passes through untouched.
    assert_eq!(p.format_sql(&g, &n, "select 'héllo' as naïve").unwrap(), "SELECT 'héllo' AS naïve");
    // A large input stays within the budget.
    let big = "select * from t where a = 1;\n".repeat(100_000);
    assert_eq!(p.format_sql(&g, &n, &big).unwrap(), "SELECT * FROM t WHERE a = 1;\n".repeat(100_000));
    // Re-signed example verifies.
    let mut m = pkg.manifest.clone();
    sign(&mut m, &pkg.wasm, &TEST_KEY);
    assert!(matches!(read_package(&build_package(&m, &pkg.wasm).unwrap()).unwrap().signer, SignerInfo::Verified { .. }));
}
