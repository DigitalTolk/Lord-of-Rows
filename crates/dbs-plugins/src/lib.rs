//! Sandboxed plugins for DB Studio.
//!
//! A plugin is a `.dbsplugin` zip with a `plugin.json` manifest and a
//! `plugin.wasm` module. Plugins run in wasmtime with no imports at all: no
//! WASI, no network, no filesystem, no credentials, no database handle. They
//! only see bytes the host explicitly passes for a granted capability, and
//! every call is bounded in CPU (fuel), memory and I/O size.

pub mod manifest;
pub mod package;
pub mod runtime;

pub use manifest::{Capability, ExportInfo, Manifest, SettingKind, SettingSpec, API_VERSION};
pub use package::{build_package, fingerprint, read_package, read_package_file, sign, signing_message, verify_signature, Package, SignerInfo};
pub use runtime::{Limits, LoadedPlugin, Runtime};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PluginError {
    #[error("invalid plugin manifest: {0}")]
    Manifest(String),
    #[error("invalid plugin package: {0}")]
    Package(String),
    #[error("plugin signature does not match its contents or key")]
    BadSignature,
    #[error("plugin is not compatible: {0}")]
    Incompatible(String),
    #[error("capability '{0}' has not been granted to this plugin")]
    NotGranted(Capability),
    #[error("plugin exceeded its execution budget (possible infinite loop) and was stopped")]
    OutOfFuel,
    #[error("plugin exceeded its memory limit and was stopped")]
    MemoryLimit,
    #[error("plugin returned an out-of-bounds pointer")]
    BadPointer,
    #[error("plugin {0} is too large")]
    TooLarge(&'static str),
    #[error("input is too large to pass to a plugin")]
    InputTooLarge,
    #[error("plugin output is not valid UTF-8")]
    BadUtf8,
    #[error("plugin crashed: {0}")]
    Trap(String),
}

impl PluginError {
    /// True for failures caused by the plugin misbehaving at run time; the
    /// host marks such plugins failed and disables them.
    pub fn is_runtime_failure(&self) -> bool {
        matches!(
            self,
            PluginError::OutOfFuel
                | PluginError::MemoryLimit
                | PluginError::BadPointer
                | PluginError::TooLarge(_)
                | PluginError::BadUtf8
                | PluginError::Trap(_)
        )
    }
}

pub type PluginResult<T> = Result<T, PluginError>;
