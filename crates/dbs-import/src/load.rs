//! File access: default locations per platform, reading a source's files, and
//! recognising a file the user picked.

use std::path::{Path, PathBuf};

use dbs_core::{DbError, DbResult};

use crate::{datagrip, dbeaver, pgadmin, sequel, tableplus, urls, Ctx, ImportedConnection, Parsed, SourceKind, MAX_FILE_BYTES};

/// Directories the default locations are relative to.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub home: Option<PathBuf>,
    /// `$XDG_DATA_HOME` (Linux), default `~/.local/share`.
    pub xdg_data_home: Option<PathBuf>,
    /// `$XDG_CONFIG_HOME` (Linux), default `~/.config`.
    pub xdg_config_home: Option<PathBuf>,
    /// `%APPDATA%` (Windows).
    pub appdata: Option<PathBuf>,
}

impl Env {
    pub fn from_process() -> Self {
        let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        let home = var("HOME").or_else(|| var("USERPROFILE"));
        Env {
            xdg_data_home: var("XDG_DATA_HOME").or_else(|| home.as_ref().map(|h| h.join(".local/share"))),
            xdg_config_home: var("XDG_CONFIG_HOME").or_else(|| home.as_ref().map(|h| h.join(".config"))),
            appdata: var("APPDATA"),
            home,
        }
    }

    pub fn ctx(&self) -> Ctx {
        Ctx { home: self.home.as_ref().map(|h| h.to_string_lossy().into_owned()) }
    }
}

/// Files of one source found on this machine.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub kind: SourceKind,
    pub paths: Vec<PathBuf>,
}

fn existing(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    paths.into_iter().filter(|p| p.is_file()).collect()
}

/// Sorted entries of `dir` whose name satisfies `f`.
fn entries(dir: &Path, f: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).filter(|e| f(&e.file_name().to_string_lossy())).map(|e| e.path()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

fn dbeaver_dirs(env: &Env) -> Vec<PathBuf> {
    let mut roots = vec![];
    if let Some(h) = &env.home {
        roots.push(h.join("Library/DBeaverData"));
    }
    if let Some(x) = &env.xdg_data_home {
        roots.push(x.join("DBeaverData"));
    }
    if let Some(a) = &env.appdata {
        roots.push(a.join("DBeaverData"));
    }
    roots.into_iter().map(|r| r.join("workspace6/General/.dbeaver")).collect()
}

/// Directories holding JetBrains IDE options (newest DataGrip first).
fn jetbrains_option_dirs(env: &Env) -> Vec<PathBuf> {
    let mut roots = vec![];
    if let Some(h) = &env.home {
        roots.push(h.join("Library/Application Support/JetBrains"));
    }
    if let Some(x) = &env.xdg_config_home {
        roots.push(x.join("JetBrains"));
    }
    if let Some(a) = &env.appdata {
        roots.push(a.join("JetBrains"));
    }
    let mut out = vec![];
    for r in roots {
        let mut v = entries(&r, |n| n.to_ascii_lowercase().starts_with("datagrip") || n.starts_with("IntelliJIdea"));
        v.reverse();
        out.extend(v.into_iter().map(|d| d.join("options")));
    }
    out
}

/// Sources with at least one file in its default location.
pub fn candidates(env: &Env) -> Vec<Candidate> {
    let mut out = vec![];
    let mut push = |kind, paths: Vec<PathBuf>| {
        if !paths.is_empty() {
            out.push(Candidate { kind, paths });
        }
    };
    if let Some(h) = &env.home {
        let tp =
            ["com.tinyapp.TablePlus", "com.tinyapp.TablePlus-setapp"].map(|id| h.join("Library/Application Support").join(id).join("Data/Connections.plist"));
        push(SourceKind::TablePlus, existing(tp));
    }
    let dbeaver: Vec<PathBuf> = dbeaver_dirs(env).iter().flat_map(|d| entries(d, |n| n.starts_with("data-sources") && n.ends_with(".json"))).collect();
    push(SourceKind::Dbeaver, dbeaver);
    if let Some(h) = &env.home {
        push(
            SourceKind::SequelAce,
            existing([h.join("Library/Containers/com.sequel-ace.sequel-ace/Data/Library/Application Support/Sequel Ace/Data/Favorites.plist")]),
        );
        push(SourceKind::SequelPro, existing([h.join("Library/Application Support/Sequel Pro/Data/Favorites.plist")]));
        let mut dg: Vec<PathBuf> = entries(&h.join("DataGripProjects"), |_| true).into_iter().map(|p| p.join(".idea/dataSources.xml")).collect();
        dg.extend(jetbrains_option_dirs(env).into_iter().map(|d| d.join("dataSources.xml")));
        push(SourceKind::DataGrip, existing(dg));
    }
    out
}

pub fn read_capped(path: &Path) -> DbResult<Vec<u8>> {
    let meta = std::fs::metadata(path).map_err(|e| DbError::new(dbs_core::ErrorKind::Io, format!("cannot read file: {e}")))?;
    if meta.len() as usize > MAX_FILE_BYTES {
        return Err(DbError::invalid("the file is too large"));
    }
    std::fs::read(path).map_err(|e| DbError::new(dbs_core::ErrorKind::Io, format!("cannot read file: {e}")))
}

fn read_opt(path: &Path) -> Option<Vec<u8>> {
    path.is_file().then(|| read_capped(path).ok()).flatten()
}

fn text(b: &[u8]) -> DbResult<String> {
    String::from_utf8(b.to_vec()).map_err(|_| DbError::invalid("the file is not UTF-8 text"))
}

/// Parses one file of `kind`, reading the companion files the source keeps next to it.
pub fn load_file(kind: SourceKind, path: &Path, env: &Env) -> Parsed {
    let ctx = env.ctx();
    let data = read_capped(path)?;
    let dir = path.parent().unwrap_or(Path::new("."));
    match kind {
        SourceKind::TablePlus => tableplus::parse(&data, read_opt(&dir.join("ConnectionGroups.plist")).as_deref(), &ctx),
        SourceKind::Dbeaver => dbeaver::parse(&data, &ctx),
        SourceKind::SequelAce | SourceKind::SequelPro => sequel::parse(&data, &ctx),
        SourceKind::PgAdmin => pgadmin::parse(&data, &ctx),
        SourceKind::DataGrip => {
            let local = read_opt(&dir.join("dataSources.local.xml")).map(|b| text(&b)).transpose()?;
            // SSH hosts: next to the file (IDE options dir) or in the newest IDE options dir.
            let ssh = std::iter::once(dir.to_path_buf())
                .chain(jetbrains_option_dirs(env))
                .find_map(|d| read_opt(&d.join("sshConfigs.xml")))
                .map(|b| text(&b))
                .transpose()?;
            datagrip::parse(&text(&data)?, local.as_deref(), ssh.as_deref(), &ctx)
        }
        SourceKind::UrlList => urls::parse_list(&text(&data)?),
    }
}

/// Loads every file of a candidate; row keys are made unique across files.
pub fn load_candidate(c: &Candidate, env: &Env) -> Parsed {
    let mut out: Vec<ImportedConnection> = vec![];
    let mut first_err = None;
    for (i, p) in c.paths.iter().enumerate() {
        match load_file(c.kind, p, env) {
            Ok(rows) => out.extend(rows.into_iter().map(|mut r| {
                if c.paths.len() > 1 {
                    r.key = format!("{i}:{}", r.key);
                }
                r
            })),
            Err(e) => first_err = first_err.or(Some(e)),
        }
    }
    match first_err {
        Some(e) if out.is_empty() => Err(e),
        _ => Ok(out),
    }
}

/// Recognises the format of a file the user picked.
pub fn sniff(data: &[u8], file_name: &str) -> Option<SourceKind> {
    let head = String::from_utf8_lossy(&data[..data.len().min(4096)]);
    let lower = file_name.to_ascii_lowercase();
    if data.starts_with(b"bplist") || head.contains("<plist") {
        let v = plist::Value::from_reader(std::io::Cursor::new(data)).ok()?;
        return match v {
            plist::Value::Array(_) => Some(SourceKind::TablePlus),
            plist::Value::Dictionary(d) if d.contains_key("Favorites Root") => {
                Some(if lower.contains("sequel pro") { SourceKind::SequelPro } else { SourceKind::SequelAce })
            }
            _ => None,
        };
    }
    let trimmed = head.trim_start_matches('\u{feff}').trim_start();
    if trimmed.starts_with('{') {
        let v: serde_json::Value = serde_json::from_slice(data).ok()?;
        if v.get("connections").is_some_and(|c| c.is_object()) {
            return Some(SourceKind::Dbeaver);
        }
        if v.get("Servers").is_some_and(|c| c.is_object()) {
            return Some(SourceKind::PgAdmin);
        }
        return None;
    }
    if trimmed.starts_with('<') {
        return (head.contains("DataSourceManagerImpl") || head.contains("<data-source")).then_some(SourceKind::DataGrip);
    }
    let any_url = head.lines().map(str::trim).any(|l| !l.starts_with('#') && (l.contains("://") || l.starts_with("sqlite:")));
    any_url.then_some(SourceKind::UrlList)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_formats() {
        assert_eq!(sniff(br#"{"connections":{}}"#, "data-sources.json"), Some(SourceKind::Dbeaver));
        assert_eq!(sniff(br#"{"Servers":{}}"#, "servers.json"), Some(SourceKind::PgAdmin));
        assert_eq!(sniff(b"<project><component name=\"DataSourceManagerImpl\"/></project>", "dataSources.xml"), Some(SourceKind::DataGrip));
        assert_eq!(sniff(b"postgres://h/db\n", "list.txt"), Some(SourceKind::UrlList));
        assert_eq!(sniff(b"hello", "x.txt"), None);
        assert_eq!(sniff(b"{\"a\":1}", "x.json"), None);
    }

    #[test]
    fn finds_default_locations() {
        // nosemgrep: rust.lang.security.temp-dir.temp-dir -- test scratch dir with a unique name
        let d = std::env::temp_dir().join(format!("dbs-import-detect-{}", std::process::id()));
        let dbv = d.join("share/DBeaverData/workspace6/General/.dbeaver");
        std::fs::create_dir_all(&dbv).unwrap();
        std::fs::write(dbv.join("data-sources.json"), br#"{"connections":{}}"#).unwrap();
        std::fs::write(dbv.join("credentials-config.json"), b"x").unwrap();
        let env = Env { home: Some(d.join("home")), xdg_data_home: Some(d.join("share")), ..Default::default() };
        let c = candidates(&env);
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].kind, c[0].paths.len()), (SourceKind::Dbeaver, 1));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
