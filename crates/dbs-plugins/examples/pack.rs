//! Packs (and optionally signs) a DB Studio plugin.
//!
//! ```text
//! cargo run -p dbs-plugins --example pack -- plugin.json plugin.wasm out.dbsplugin [secret-key.hex]
//! ```
//!
//! The secret key file holds 32 bytes as 64 hex characters, e.g. created with
//! `openssl rand -hex 32 > key.hex`. Keep it out of version control.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !(3..=4).contains(&args.len()) {
        eprintln!("usage: pack <plugin.json> <plugin.wasm> <out.dbsplugin> [secret-key.hex]");
        return ExitCode::from(2);
    }
    match run(&args) {
        Ok(msg) => {
            println!("{msg}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<String, String> {
    let json = std::fs::read(&args[0]).map_err(|e| format!("{}: {e}", args[0]))?;
    let wasm = std::fs::read(&args[1]).map_err(|e| format!("{}: {e}", args[1]))?;
    let mut manifest = dbs_plugins::Manifest::parse(&json).map_err(|e| e.to_string())?;
    manifest.public_key = None;
    manifest.signature = None;
    if let Some(key_file) = args.get(3) {
        let hex_key = std::fs::read_to_string(key_file).map_err(|e| format!("{key_file}: {e}"))?;
        let key: [u8; 32] = hex::decode(hex_key.trim()).ok().and_then(|b| b.try_into().ok()).ok_or("secret key must be 64 hex characters")?;
        dbs_plugins::sign(&mut manifest, &wasm, &key);
    }
    // Validate the module before shipping it.
    dbs_plugins::Runtime::new(Default::default()).and_then(|rt| rt.load(&manifest, &wasm)).map_err(|e| e.to_string())?;
    let bytes = dbs_plugins::build_package(&manifest, &wasm).map_err(|e| e.to_string())?;
    let pkg = dbs_plugins::read_package(&bytes).map_err(|e| e.to_string())?;
    std::fs::write(&args[2], &bytes).map_err(|e| format!("{}: {e}", args[2]))?;
    Ok(format!("wrote {} ({} bytes, {:?})", args[2], bytes.len(), pkg.signer))
}
