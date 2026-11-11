//! Parses the sources installed on the machine running the test. Ignored by default;
//! run with `cargo test -p dbs-import --test real_sources -- --ignored --nocapture`.
//! Prints ONLY counts and engine names: no names, hosts, users or paths.

use std::collections::BTreeMap;

use dbs_import::load::{self, Env};

#[test]
#[ignore = "reads the developer's own connection files"]
fn parse_installed_sources() {
    let env = Env::from_process();
    let found = load::candidates(&env);
    println!("sources found: {}", found.len());
    for c in found {
        match load::load_candidate(&c, &env) {
            Ok(rows) => {
                let mut engines: BTreeMap<String, usize> = BTreeMap::new();
                for r in &rows {
                    let e = match &r.config {
                        Some(cfg) => format!("{:?}", cfg.engine),
                        None => "unknown".into(),
                    };
                    *engines.entry(e).or_default() += 1;
                }
                let valid = rows.iter().filter(|r| r.config.as_ref().is_some_and(|c| c.validate().is_ok())).count();
                let invalid: Vec<String> = rows
                    .iter()
                    .filter_map(|r| r.config.as_ref()?.validate().err().map(|e| e.message))
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect();
                let ssh = rows.iter().filter(|r| r.config.as_ref().is_some_and(|c| c.ssh.is_some())).count();
                let grouped = rows.iter().filter(|r| r.config.as_ref().is_some_and(|c| c.group.is_some())).count();
                let mut envs: BTreeMap<String, usize> = BTreeMap::new();
                for r in &rows {
                    if let Some(c) = &r.config {
                        *envs.entry(format!("{:?}", c.environment)).or_default() += 1;
                    }
                }
                let keychain = rows.iter().filter(|r| !r.keychain.is_empty()).count();
                println!(
                    "{}: files={} rows={} engines={engines:?} envs={envs:?} valid={valid} ssh={ssh} grouped={grouped} keychain_refs={keychain} validation_errors(distinct)={}",
                    c.kind.label(),
                    c.paths.len(),
                    rows.len(),
                    invalid.len()
                );
                // Validation messages are generic (no host names); print them so failures are explainable.
                for m in invalid {
                    println!("  invalid: {}", m.chars().take(120).collect::<String>());
                }
            }
            Err(e) => println!("{}: error kind {:?}", c.kind.label(), e.kind),
        }
    }
}
