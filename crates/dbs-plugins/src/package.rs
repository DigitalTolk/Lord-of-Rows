//! `.dbsplugin` packages: a zip holding exactly `plugin.json` and
//! `plugin.wasm`. Entries are never extracted by name, so path tricks cannot
//! reach the filesystem; they are still rejected loudly. Optional ed25519
//! signatures bind the publisher key to the id, version, capabilities and the
//! exact wasm bytes.

use std::io::{Cursor, Read, Write};

use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::manifest::Manifest;
use crate::{PluginError, PluginResult};

pub const MANIFEST_FILE: &str = "plugin.json";
pub const WASM_FILE: &str = "plugin.wasm";
pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
pub const MAX_WASM_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_PACKAGE_BYTES: u64 = MAX_WASM_BYTES + MAX_MANIFEST_BYTES + 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SignerInfo {
    Unsigned,
    /// The signature is valid for this key. Says nothing about who owns the key.
    Verified {
        public_key: String,
        fingerprint: String,
    },
}

#[derive(Debug, Clone)]
pub struct Package {
    pub manifest: Manifest,
    pub wasm: Vec<u8>,
    pub signer: SignerInfo,
}

impl Package {
    pub fn wasm_sha256(&self) -> String {
        hex::encode(Sha256::digest(&self.wasm))
    }
}

fn bad(msg: impl Into<String>) -> PluginError {
    PluginError::Package(msg.into())
}

fn unsafe_name(n: &str) -> bool {
    n.starts_with('/') || n.contains('\\') || n.contains(':') || n.contains('\0') || n.split('/').any(|p| p == ".." || p == ".")
}

/// Parses and validates a package from memory. Does not check app compatibility.
pub fn read_package(bytes: &[u8]) -> PluginResult<Package> {
    if bytes.len() as u64 > MAX_PACKAGE_BYTES {
        return Err(bad("package is too large"));
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| bad(format!("not a valid zip: {e}")))?;
    if zip.len() > 2 {
        return Err(bad("package must contain only plugin.json and plugin.wasm"));
    }
    let (mut manifest, mut wasm) = (None, None);
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| bad(e.to_string()))?;
        let name = f.name().map_err(|e| bad(e.to_string()))?.into_owned();
        if unsafe_name(&name) {
            return Err(bad(format!("unsafe path in package: {name:?}")));
        }
        if f.is_dir() || f.is_symlink() || !f.is_file() {
            return Err(bad(format!("unexpected entry type: {name:?}")));
        }
        if f.encrypted() {
            return Err(bad("encrypted entries are not supported"));
        }
        let (slot, cap) = match name.as_str() {
            MANIFEST_FILE => (&mut manifest, MAX_MANIFEST_BYTES),
            WASM_FILE => (&mut wasm, MAX_WASM_BYTES),
            _ => return Err(bad(format!("unexpected file in package: {name:?}"))),
        };
        if slot.is_some() {
            return Err(bad(format!("duplicate entry: {name}")));
        }
        if f.size() > cap {
            return Err(bad(format!("{name} is too large")));
        }
        // Don't trust the declared size: read at most cap+1 bytes.
        let mut buf = Vec::new();
        (&mut f).take(cap + 1).read_to_end(&mut buf).map_err(|e| bad(format!("{name}: {e}")))?;
        if buf.len() as u64 > cap {
            return Err(bad(format!("{name} is too large")));
        }
        *slot = Some(buf);
    }
    let manifest = Manifest::parse(&manifest.ok_or_else(|| bad("plugin.json is missing"))?)?;
    let wasm = wasm.ok_or_else(|| bad("plugin.wasm is missing"))?;
    let signer = verify_signature(&manifest, &wasm)?;
    Ok(Package { manifest, wasm, signer })
}

/// Reads a package from disk with a size check before loading it.
pub fn read_package_file(path: &std::path::Path) -> PluginResult<Package> {
    let f = std::fs::File::open(path).map_err(|e| bad(e.to_string()))?;
    let len = f.metadata().map_err(|e| bad(e.to_string()))?.len();
    if len > MAX_PACKAGE_BYTES {
        return Err(bad("package is too large"));
    }
    let mut buf = Vec::with_capacity(len as usize);
    f.take(MAX_PACKAGE_BYTES + 1).read_to_end(&mut buf).map_err(|e| bad(e.to_string()))?;
    read_package(&buf)
}

/// Builds a `.dbsplugin` zip (used by the `pack` example and tests).
pub fn build_package(manifest: &Manifest, wasm: &[u8]) -> PluginResult<Vec<u8>> {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let json = serde_json::to_vec_pretty(manifest).map_err(|e| bad(e.to_string()))?;
    for (name, data) in [(MANIFEST_FILE, json.as_slice()), (WASM_FILE, wasm)] {
        w.start_file(name, opts).map_err(|e| bad(e.to_string()))?;
        w.write_all(data).map_err(|e| bad(e.to_string()))?;
    }
    Ok(w.finish().map_err(|e| bad(e.to_string()))?.into_inner())
}

/// The exact bytes a publisher signs. Binds key → id, version, compatibility,
/// requested capabilities and the wasm bytes, so none can be swapped.
pub fn signing_message(m: &Manifest, wasm: &[u8]) -> Vec<u8> {
    let mut caps: Vec<&str> = m.capabilities.iter().map(|c| c.as_str()).collect();
    caps.sort_unstable();
    format!(
        "dbstudio-plugin-signature-v1\nid={}\nversion={}\nmin_app_version={}\napi_version={}\ncapabilities={}\nwasm_sha256={}\n",
        m.id,
        m.version,
        m.min_app_version,
        m.api_version,
        caps.join(","),
        hex::encode(Sha256::digest(wasm))
    )
    .into_bytes()
}

/// Short, human-comparable fingerprint of a publisher key.
pub fn fingerprint(public_key: &[u8]) -> String {
    let h = hex::encode(&Sha256::digest(public_key)[..16]);
    h.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join(":")
}

/// `Unsigned` if no signature; `Verified` if valid; error if present but wrong.
pub fn verify_signature(m: &Manifest, wasm: &[u8]) -> PluginResult<SignerInfo> {
    let (Some(pk), Some(sig)) = (&m.public_key, &m.signature) else { return Ok(SignerInfo::Unsigned) };
    let pk_bytes: [u8; 32] = hex::decode(pk).ok().and_then(|b| b.try_into().ok()).ok_or(PluginError::BadSignature)?;
    let sig_bytes: [u8; 64] = hex::decode(sig).ok().and_then(|b| b.try_into().ok()).ok_or(PluginError::BadSignature)?;
    let key = VerifyingKey::from_bytes(&pk_bytes).map_err(|_| PluginError::BadSignature)?;
    key.verify_strict(&signing_message(m, wasm), &Signature::from_bytes(&sig_bytes)).map_err(|_| PluginError::BadSignature)?;
    Ok(SignerInfo::Verified { public_key: hex::encode(pk_bytes), fingerprint: fingerprint(&pk_bytes) })
}

/// Signs `m` in place with a 32-byte ed25519 secret key.
pub fn sign(m: &mut Manifest, wasm: &[u8], secret_key: &[u8; 32]) {
    let sk = SigningKey::from_bytes(secret_key);
    m.public_key = Some(hex::encode(sk.verifying_key().to_bytes()));
    m.signature = Some(hex::encode(sk.sign(&signing_message(m, wasm)).to_bytes()));
}
