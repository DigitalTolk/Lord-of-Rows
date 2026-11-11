//! One-time move of the app data directory when the bundle identifier changed
//! (`dev.dbstudio.app` -> `dev.lordoftherows.app`). Saved connections, settings,
//! history and the audit log are copied; OS-keychain passwords are keyed by a
//! fixed service name and need no migration. The old directory is left in place.

use std::fs;
use std::io;
use std::path::Path;

pub const LEGACY_IDENTIFIERS: &[&str] = &["dev.dbstudio.app"];

/// If `dir` does not exist yet and a sibling directory from a legacy identifier does,
/// copy the legacy contents into `dir`. Returns the legacy directory that was copied.
pub fn migrate_legacy_data_dir(dir: &Path) -> io::Result<Option<std::path::PathBuf>> {
    if dir.exists() {
        return Ok(None);
    }
    let Some(parent) = dir.parent() else { return Ok(None) };
    for id in LEGACY_IDENTIFIERS {
        let old = parent.join(id);
        if old.is_dir() && old != dir {
            copy_dir(&old, dir)?;
            return Ok(Some(old));
        }
    }
    Ok(None)
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if ty.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), dest)?;
        } // symlinks are not followed or copied
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_legacy_dir_once_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("dev.dbstudio.app");
        fs::create_dir_all(old.join("plugins")).unwrap();
        fs::write(old.join("app.db"), b"connections").unwrap();
        fs::write(old.join("plugins/x.wasm"), b"wasm").unwrap();
        let new = root.path().join("dev.lordoftherows.app");

        assert_eq!(migrate_legacy_data_dir(&new).unwrap(), Some(old.clone()));
        assert_eq!(fs::read(new.join("app.db")).unwrap(), b"connections");
        assert_eq!(fs::read(new.join("plugins/x.wasm")).unwrap(), b"wasm");
        assert!(old.join("app.db").exists(), "legacy data is left in place");

        // Second launch: the new dir exists, nothing is copied again.
        fs::write(old.join("app.db"), b"changed").unwrap();
        assert_eq!(migrate_legacy_data_dir(&new).unwrap(), None);
        assert_eq!(fs::read(new.join("app.db")).unwrap(), b"connections");
    }

    #[test]
    fn fresh_install_without_legacy_dir_does_nothing() {
        let root = tempfile::tempdir().unwrap();
        let new = root.path().join("dev.lordoftherows.app");
        assert_eq!(migrate_legacy_data_dir(&new).unwrap(), None);
        assert!(!new.exists());
    }
}
