//! Parsers against synthetic fixtures (made-up hosts only).

use dbs_core::{Engine, EnvironmentKind, SshAuth, TlsMode};
use dbs_import::load::{self, sniff};
use dbs_import::{datagrip, dbeaver, pgadmin, sequel, tableplus, urls, Ctx, ImportedConnection, SourceKind};
use dbs_secrets::SecretKind;

const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIX}/{name}")).unwrap()
}

fn ctx() -> Ctx {
    Ctx { home: Some("/home/tester".into()) }
}

fn by_name<'a>(rows: &'a [ImportedConnection], name: &str) -> &'a ImportedConnection {
    rows.iter().find(|r| r.name == name).unwrap_or_else(|| panic!("no row {name}"))
}

#[test]
fn tableplus_connections() {
    let rows = tableplus::parse(&fixture("tableplus-connections.plist"), Some(&fixture("tableplus-groups.plist")), &ctx()).unwrap();
    assert_eq!(rows.len(), 6);

    let shop = by_name(&rows, "Shop production");
    let c = shop.config.as_ref().unwrap();
    assert_eq!(
        (c.engine, c.host.as_deref(), c.port, c.database.as_deref(), c.username.as_deref()),
        (Engine::Postgres, Some("db.example.com"), Some(5432), Some("shop"), Some("shop_app"))
    );
    assert_eq!(c.environment, EnvironmentKind::Production);
    assert_eq!(c.tls.mode, TlsMode::VerifyIdentity);
    assert_eq!(c.tls.ca_cert_path.as_deref(), Some("/certs/ca.pem"));
    assert_eq!(c.tls.client_key_path, None);
    assert_eq!(c.group.as_deref(), Some("Clients / Shop"));
    assert_eq!(c.color.as_deref(), Some("#c0392b"));
    assert!(c.validate().is_ok());
    assert_eq!(shop.keychain.len(), 1);
    assert_eq!(shop.keychain[0].kind, SecretKind::DbPassword);
    assert_eq!(shop.keychain[0].service, "com.tableplus.TablePlus");
    assert_eq!(shop.keychain[0].account, "11111111-AAAA-4BBB-8CCC-000000000001_database");

    let orders = by_name(&rows, "Orders via bastion");
    let c = orders.config.as_ref().unwrap();
    assert_eq!((c.engine, c.port, c.environment, c.tls.mode), (Engine::MySql, None, EnvironmentKind::Staging, TlsMode::Preferred));
    let ssh = c.ssh.as_ref().unwrap();
    assert_eq!((ssh.host.as_str(), ssh.port, ssh.user.as_str(), ssh.auth), ("bastion.example.com", 2222, "deploy", SshAuth::PrivateKey));
    assert_eq!(ssh.private_key_path.as_deref(), Some("/home/tester/.ssh/id_ed25519"));
    assert_eq!(c.group, None);

    let cache = by_name(&rows, "Cache");
    let c = cache.config.as_ref().unwrap();
    assert_eq!((c.engine, c.tls.mode, c.environment), (Engine::Redis, TlsMode::Disabled, EnvironmentKind::Local));
    assert_eq!(c.ssh.as_ref().unwrap().auth, SshAuth::Password);
    let kinds: Vec<_> = cache.keychain.iter().map(|k| (k.kind, k.account.ends_with("_server"))).collect();
    assert_eq!(kinds, vec![(SecretKind::DbPassword, false), (SecretKind::SshPassword, true)]);

    let mssql = by_name(&rows, "Legacy warehouse");
    assert_eq!(mssql.config.as_ref().unwrap().engine, Engine::SqlServer);
    assert_eq!(mssql.source_engine, "Microsoft SQL Server");

    let notes = by_name(&rows, "Notes file").config.as_ref().unwrap();
    assert_eq!((notes.engine, notes.database.as_deref(), notes.environment), (Engine::Sqlite, Some("/home/tester/data/notes.db"), EnvironmentKind::Local));

    // A key kept inside the source app: falls back to the agent, with a note.
    let plain = by_name(&rows, "Plain prod");
    let c = plain.config.as_ref().unwrap();
    assert_eq!(c.ssh.as_ref().unwrap().auth, SshAuth::Agent);
    assert!(!plain.notes.is_empty());
    assert!(c.validate().is_ok(), "SSH tunnel makes TLS DISABLED acceptable for production");
}

#[test]
fn tableplus_binary_plist_and_missing_keys() {
    let v = plist::Value::from_reader(std::io::Cursor::new(fixture("tableplus-connections.plist"))).unwrap();
    let mut bin = Vec::new();
    v.to_writer_binary(&mut bin).unwrap();
    assert_eq!(sniff(&bin, "Connections.plist"), Some(SourceKind::TablePlus));
    assert_eq!(tableplus::parse(&bin, None, &ctx()).unwrap().len(), 6);

    // Minimal / renamed keys still parse.
    let minimal = br#"<?xml version="1.0"?><plist version="1.0"><array>
        <dict><key>Driver</key><string>MariaDB</string><key>Host</key><string>m.example.com</string><key>Environment</key><string>testing</string><key>TlsMode</key><string>require</string></dict>
        <dict><key>Driver</key><string>Firebird</string><key>ConnectionName</key><string>Old</string></dict>
        <string>not a dict</string>
    </array></plist>"#;
    let rows = tableplus::parse(minimal, None, &ctx()).unwrap();
    assert_eq!(rows.len(), 2);
    let c = rows[0].config.as_ref().unwrap();
    assert_eq!((c.engine, c.host.as_deref(), c.environment, c.tls.mode), (Engine::MariaDb, Some("m.example.com"), EnvironmentKind::Testing, TlsMode::Required));
    assert_eq!(c.name, "m.example.com");
    assert!(rows[0].keychain.is_empty(), "no ID, no keychain lookup");
    assert!(rows[1].config.is_none());
    assert_eq!(rows[1].source_engine, "Firebird");

    assert!(tableplus::parse(b"garbage", None, &ctx()).is_err());
}

#[test]
fn dbeaver_data_sources() {
    let rows = dbeaver::parse(&fixture("dbeaver-data-sources.json"), &ctx()).unwrap();
    assert_eq!(rows.len(), 4);
    let billing = by_name(&rows, "Billing prod").config.as_ref().unwrap();
    assert_eq!(
        (billing.engine, billing.port, billing.environment, billing.tls.mode),
        (Engine::Postgres, Some(5433), EnvironmentKind::Production, TlsMode::VerifyIdentity)
    );
    assert_eq!(billing.tls.ca_cert_path.as_deref(), Some("/certs/billing-ca.pem"));
    assert_eq!(billing.group.as_deref(), Some("Team / Billing"));
    assert_eq!(billing.username, None);
    assert!(rows.iter().find(|r| r.name == "Billing prod").unwrap().keychain.is_empty());

    let an = by_name(&rows, "Analytics");
    let c = an.config.as_ref().unwrap();
    assert_eq!(
        (c.engine, c.username.as_deref(), c.environment, c.tls.mode),
        (Engine::MySql, Some("analyst"), EnvironmentKind::Development, TlsMode::Preferred)
    );
    let ssh = c.ssh.as_ref().unwrap();
    assert_eq!((ssh.host.as_str(), ssh.auth, ssh.private_key_path.as_deref()), ("bastion.example.com", SshAuth::PrivateKey, Some("/keys/id_rsa")));
    assert!(an.notes.iter().any(|n| n.contains("SSH user")));

    let lc = by_name(&rows, "Local cache").config.as_ref().unwrap();
    assert_eq!((lc.engine, lc.database.as_deref(), lc.environment), (Engine::Sqlite, Some("/tmp/cache.sqlite"), EnvironmentKind::Testing));
    assert_eq!(lc.color.as_deref(), Some("#0080ff"));

    assert_eq!(by_name(&rows, "ERP").config.as_ref().unwrap().engine, Engine::Oracle);
}

#[test]
fn sequel_favorites() {
    let rows = sequel::parse(&fixture("sequel-favorites.plist"), &ctx()).unwrap();
    assert_eq!(rows.len(), 2);
    let blog = by_name(&rows, "Blog").config.as_ref().unwrap();
    assert_eq!((blog.engine, blog.port, blog.tls.mode, blog.environment), (Engine::MySql, Some(3307), TlsMode::VerifyCa, EnvironmentKind::Development));
    assert_eq!(blog.color.as_deref(), Some("#22c55e"));
    assert_eq!(blog.group, None);
    let a = by_name(&rows, "Client A").config.as_ref().unwrap();
    assert_eq!(a.group.as_deref(), Some("Clients"));
    let ssh = a.ssh.as_ref().unwrap();
    assert_eq!(
        (ssh.host.as_str(), ssh.port, ssh.auth, ssh.private_key_path.as_deref()),
        ("ssh.example.com", 22, SshAuth::PrivateKey, Some("/home/tester/.ssh/client_a"))
    );
    assert_eq!(a.color, None);
}

#[test]
fn pgadmin_servers() {
    let rows = pgadmin::parse(&fixture("pgadmin-servers.json"), &ctx()).unwrap();
    assert_eq!(rows.len(), 2);
    let r = by_name(&rows, "Reporting").config.as_ref().unwrap();
    assert_eq!(
        (r.tls.mode, r.group.as_deref(), r.notes.as_deref(), r.color.as_deref()),
        (TlsMode::Required, Some("Analytics"), Some("read replica"), Some("#336699"))
    );
    let i = by_name(&rows, "Inventory").config.as_ref().unwrap();
    assert_eq!((i.port, i.tls.mode, i.tls.ca_cert_path.as_deref(), i.connect_timeout_secs), (Some(6432), TlsMode::VerifyCa, Some("/certs/inv-ca.pem"), 15));
    let ssh = i.ssh.as_ref().unwrap();
    assert_eq!((ssh.host.as_str(), ssh.auth, ssh.private_key_path.as_deref()), ("gw.example.com", SshAuth::PrivateKey, Some("/keys/gw")));
}

#[test]
fn datagrip_data_sources() {
    let ds = String::from_utf8(fixture("datagrip-dataSources.xml")).unwrap();
    let local = String::from_utf8(fixture("datagrip-dataSources.local.xml")).unwrap();
    let ssh = String::from_utf8(fixture("datagrip-sshConfigs.xml")).unwrap();
    let rows = datagrip::parse(&ds, Some(&local), Some(&ssh), &ctx()).unwrap();
    assert_eq!(rows.len(), 4);
    let p = by_name(&rows, "Payments").config.as_ref().unwrap();
    assert_eq!((p.engine, p.host.as_deref(), p.port, p.database.as_deref()), (Engine::Postgres, Some("pay.example.com"), Some(5432), Some("payments")));
    assert_eq!((p.username.as_deref(), p.tls.mode, p.group.as_deref()), (Some("payer"), TlsMode::VerifyIdentity, Some("Fintech / EU")));
    let t = p.ssh.as_ref().unwrap();
    assert_eq!(
        (t.host.as_str(), t.port, t.user.as_str(), t.auth, t.private_key_path.as_deref()),
        ("bastion.example.com", 2200, "dg", SshAuth::PrivateKey, Some("/home/tester/.ssh/id_rsa"))
    );

    let cms = by_name(&rows, "CMS & blog");
    let c = cms.config.as_ref().unwrap();
    assert_eq!((c.engine, c.host.as_deref(), c.port, c.username.as_deref()), (Engine::MariaDb, Some("cms.example.com"), None, Some("editor")));
    assert!(c.ssh.is_none() && !cms.notes.is_empty(), "unknown SSH config id is reported, not invented");

    assert_eq!(by_name(&rows, "Mongo").config.as_ref().unwrap().engine, Engine::MongoDb);
    let s = by_name(&rows, "Scratch").config.as_ref().unwrap();
    assert_eq!((s.engine, s.database.as_deref()), (Engine::Sqlite, Some("/tmp/scratch.db")));

    // Without the local file: still parses, just no user names.
    assert!(datagrip::parse(&ds, None, None, &ctx()).unwrap().iter().all(|r| r.config.as_ref().is_none_or(|c| c.username.is_none())));
    assert!(datagrip::parse("<html/>", None, None, &ctx()).is_err());
}

#[test]
fn url_list_fixture() {
    let rows = urls::parse_list(&String::from_utf8(fixture("urls.txt")).unwrap()).unwrap();
    assert_eq!(rows.len(), 5);
    assert_eq!(rows.iter().filter(|r| r.config.is_some()).count(), 4);
    assert_eq!(rows[2].config.as_ref().unwrap().port, Some(6380));
    assert!(rows[4].error.is_some());
}

#[test]
fn load_file_reads_companions() {
    let env = load::Env { home: Some("/home/tester".into()), ..Default::default() };
    // Copy fixtures under the names the apps use, then load the main file.
    let d = std::env::temp_dir().join(format!("dbs-import-load-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("Connections.plist"), fixture("tableplus-connections.plist")).unwrap();
    std::fs::write(d.join("ConnectionGroups.plist"), fixture("tableplus-groups.plist")).unwrap();
    std::fs::write(d.join("dataSources.xml"), fixture("datagrip-dataSources.xml")).unwrap();
    std::fs::write(d.join("dataSources.local.xml"), fixture("datagrip-dataSources.local.xml")).unwrap();
    std::fs::write(d.join("sshConfigs.xml"), fixture("datagrip-sshConfigs.xml")).unwrap();
    let tp = load::load_file(SourceKind::TablePlus, &d.join("Connections.plist"), &env).unwrap();
    assert_eq!(by_name(&tp, "Shop production").config.as_ref().unwrap().group.as_deref(), Some("Clients / Shop"));
    let dg = load::load_file(SourceKind::DataGrip, &d.join("dataSources.xml"), &env).unwrap();
    assert_eq!(by_name(&dg, "Payments").config.as_ref().unwrap().ssh.as_ref().unwrap().port, 2200);
    for (f, k) in [
        ("dbeaver-data-sources.json", SourceKind::Dbeaver),
        ("pgadmin-servers.json", SourceKind::PgAdmin),
        ("sequel-favorites.plist", SourceKind::SequelAce),
        ("datagrip-dataSources.xml", SourceKind::DataGrip),
        ("urls.txt", SourceKind::UrlList),
        ("tableplus-connections.plist", SourceKind::TablePlus),
    ] {
        assert_eq!(sniff(&fixture(f), f), Some(k), "{f}");
    }
    std::fs::remove_dir_all(&d).unwrap();
}
