//! Integration tests against real servers (docker-compose services).
//! Run: `docker compose run --rm dev cargo test -p dbs-drivers --test integration`
//! Each test is skipped (with a printed notice) when DBS_IT is not set.

use std::time::Duration;

use dbs_core::*;
use dbs_drivers::driver_for;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn it_enabled() -> bool {
    if std::env::var("DBS_IT").is_err() {
        eprintln!("SKIPPED: DBS_IT not set (run inside docker compose)");
        return false;
    }
    true
}

fn cfg(engine: Engine, host: Option<&str>, db: Option<&str>) -> ConnectionConfig {
    ConnectionConfig {
        id: Uuid::new_v4(),
        name: format!("it-{engine:?}"),
        engine,
        host: host.map(String::from),
        port: None,
        database: db.map(String::from),
        username: Some("dbs_test".into()),
        socket_path: None,
        tls: TlsConfig { mode: TlsMode::Disabled, ..Default::default() },
        ssh: None,
        environment: EnvironmentKind::Testing,
        read_only: false,
        color: None,
        group: None,
        tags: vec![],
        notes: None,
        favorite: false,
        connect_timeout_secs: 10,
        query_timeout_secs: None,
        init_sql: None,
        key_separator: None,
        managed_by: None,
        tunnel: None,
    }
}

fn pw() -> ConnectSecrets {
    ConnectSecrets { password: Some("dbs_test".into()) }
}

async fn connect(c: &ConnectionConfig) -> Box<dyn DatabaseConnection> {
    driver_for(c.engine).expect("driver").connect(c, pw()).await.expect("connect")
}

async fn exec(c: &dyn DatabaseConnection, sql: &str) -> Vec<StatementResult> {
    c.execute(sql, &ExecOptions::default(), CancellationToken::new()).await.unwrap_or_else(|e| panic!("{sql}: {e:?}"))
}

fn first_rows(r: &[StatementResult]) -> &Vec<Vec<Value>> {
    &r.iter().rev().find_map(|s| s.result.as_ref()).expect("result set").rows
}

/// Shared CRUD / staged-edit / conflict scenario for SQL engines.
async fn crud_scenario(c: &dyn DatabaseConnection, schema: Option<&str>, table: &str) {
    let t = TableTarget { schema: schema.map(String::from), table: table.into() };
    let report = c
        .apply_changes(
            &t,
            &[
                RowChange::Insert { values: vec![("id".into(), Value::Int(1)), ("name".into(), Value::Text("alice".into()))] },
                RowChange::Insert { values: vec![("id".into(), Value::Int(2)), ("name".into(), Value::Text("".into()))] },
                RowChange::Insert { values: vec![("id".into(), Value::Int(3)), ("name".into(), Value::Null)] },
            ],
        )
        .await
        .expect("insert batch");
    assert!(report.committed);
    assert_eq!(report.rows_affected, 3);

    // NULL and empty string are distinct.
    let page = PageRequest { limit: 100, order_by: vec![("id".into(), SortDir::Asc)], ..Default::default() };
    let rs = c.fetch_table(&t, &page).await.expect("fetch");
    assert_eq!(rs.rows.len(), 3);
    let name_idx = rs.columns.iter().position(|c| c.name == "name").unwrap();
    assert_eq!(rs.rows[1][name_idx], Value::Text(String::new()));
    assert_eq!(rs.rows[2][name_idx], Value::Null);

    // Server-side filter + count.
    let f =
        vec![FilterCondition { column: "name".into(), op: FilterOp::StartsWith, value: Some(Value::Text("ali".into())), values: vec![], ..Default::default() }];
    assert_eq!(c.count_rows(&t, &f).await.unwrap(), 1);
    let f2 = vec![FilterCondition { column: "name".into(), op: FilterOp::IsNull, value: None, values: vec![], ..Default::default() }];
    assert_eq!(c.count_rows(&t, &f2).await.unwrap(), 1);
    // LIKE wildcards in user input are literal.
    let f3 =
        vec![FilterCondition { column: "name".into(), op: FilterOp::Contains, value: Some(Value::Text("%".into())), values: vec![], ..Default::default() }];
    assert_eq!(c.count_rows(&t, &f3).await.unwrap(), 0);

    // Update with optimistic concurrency: succeeds when original matches.
    let ok = c
        .apply_changes(
            &t,
            &[RowChange::Update {
                key: vec![("id".into(), Value::Int(1))],
                original: vec![("name".into(), Value::Text("alice".into()))],
                changes: vec![("name".into(), Value::Text("alicia".into()))],
            }],
        )
        .await
        .unwrap();
    assert!(ok.committed && ok.conflicts.is_empty());

    // Stale original → conflict, nothing committed (whole batch rolled back).
    let stale = c
        .apply_changes(
            &t,
            &[
                RowChange::Delete { key: vec![("id".into(), Value::Int(3))], original: vec![] },
                RowChange::Update {
                    key: vec![("id".into(), Value::Int(1))],
                    original: vec![("name".into(), Value::Text("alice".into()))],
                    changes: vec![("name".into(), Value::Text("overwritten".into()))],
                },
            ],
        )
        .await
        .unwrap();
    assert!(!stale.committed);
    assert_eq!(stale.conflicts, vec![1]);
    assert_eq!(c.count_rows(&t, &[]).await.unwrap(), 3, "delete must have been rolled back");

    // Constraint violation surfaces as Constraint and rolls back.
    let err =
        c.apply_changes(&t, &[RowChange::Insert { values: vec![("id".into(), Value::Int(1)), ("name".into(), Value::Text("dup".into()))] }]).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Constraint, "{err:?}");

    let desc = c.describe_table(&t).await.expect("describe");
    assert_eq!(desc.primary_key, vec!["id".to_string()]);
    assert!(desc.columns.iter().any(|c| c.name == "name" && c.nullable));
    assert!(desc.ddl.is_some());
    let objs = c.list_objects(schema).await.unwrap();
    assert!(objs.iter().any(|o| o.name == table && o.kind == ObjectKind::Table), "{objs:?}");
}

#[tokio::test]
async fn postgres_end_to_end() {
    if !it_enabled() {
        return;
    }
    let host = std::env::var("DBS_IT_PG_HOST").unwrap_or("localhost".into());
    let c = connect(&cfg(Engine::Postgres, Some(&host), Some("dbs_test"))).await;
    let info = c.server_info().await.unwrap();
    assert!(info.version.contains("PostgreSQL"), "{info:?}");

    exec(&*c, "DROP SCHEMA IF EXISTS it CASCADE; CREATE SCHEMA it; CREATE TABLE it.people (id int PRIMARY KEY, name text)").await;
    crud_scenario(&*c, Some("it"), "people").await;

    // Selecting a schema makes unqualified names resolve to it.
    assert!(c.execute("SELECT count(*) FROM people", &ExecOptions::default(), CancellationToken::new()).await.is_err());
    c.use_schema("it").await.unwrap();
    let r = exec(&*c, "SELECT count(*) FROM people").await;
    assert_eq!(first_rows(&r)[0][0], Value::Int(3));
    c.use_schema("public").await.unwrap();

    // Type fidelity.
    let r = exec(
        &*c,
        "SELECT 9223372036854775807::int8 AS big, 12345678901234567890.123456789::numeric AS num, NULL::text AS n, ''::text AS e,
                '2024-03-01 12:34:56.789'::timestamp AS ts, '2024-03-01 12:34:56+02'::timestamptz AS tstz, '{\"a\":1}'::jsonb AS j,
                'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS u, '\\xdeadbeef'::bytea AS b, ARRAY[1,NULL,3] AS arr, true AS flag,
                '2024-02-29'::date AS d, 1.5::float8 AS f",
    )
    .await;
    let row = &first_rows(&r)[0];
    assert_eq!(row[0], Value::BigInt("9223372036854775807".into()));
    assert_eq!(row[1], Value::Decimal("12345678901234567890.123456789".into()));
    assert_eq!(row[2], Value::Null);
    assert_eq!(row[3], Value::Text("".into()));
    assert_eq!(row[4], Value::Timestamp { iso: "2024-03-01T12:34:56.789".into(), tz: false });
    assert_eq!(row[5], Value::Timestamp { iso: "2024-03-01T10:34:56Z".into(), tz: true });
    assert_eq!(row[6], Value::Json(serde_json::json!({"a": 1})));
    assert_eq!(row[7], Value::Uuid("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11".into()));
    assert_eq!(row[8], Value::Bytes { hex: "deadbeef".into(), len: 4, truncated: false });
    assert_eq!(row[9], Value::Array(vec![Value::Int(1), Value::Null, Value::Int(3)]));
    assert_eq!(row[10], Value::Bool(true));
    assert_eq!(row[11], Value::Date("2024-02-29".into()));
    assert_eq!(row[12], Value::Float(1.5));

    // Editing typed columns through parameters (numeric, timestamptz, jsonb, uuid).
    exec(&*c, "CREATE TABLE it.typed (id bigint PRIMARY KEY, amount numeric(30,10), at timestamptz, doc jsonb, ref uuid)").await;
    let t = TableTarget { schema: Some("it".into()), table: "typed".into() };
    let rep = c
        .apply_changes(
            &t,
            &[RowChange::Insert {
                values: vec![
                    ("id".into(), Value::BigInt("9007199254740993".into())),
                    ("amount".into(), Value::Decimal("12345678901234567890.0123456789".into())),
                    ("at".into(), Value::Timestamp { iso: "2024-01-01T00:00:00Z".into(), tz: true }),
                    ("doc".into(), Value::Json(serde_json::json!({"k": [1, 2]}))),
                    ("ref".into(), Value::Uuid("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11".into())),
                ],
            }],
        )
        .await
        .expect("typed insert");
    assert!(rep.committed);
    let r = exec(&*c, "SELECT id, amount::text FROM it.typed").await;
    assert_eq!(first_rows(&r)[0][0], Value::BigInt("9007199254740993".into()));
    assert_eq!(first_rows(&r)[0][1], Value::Text("12345678901234567890.0123456789".into()));

    // Multi-statement with notices and affected rows.
    let r = exec(&*c, "UPDATE it.people SET name = 'x' WHERE id IN (2,3); DO $$ BEGIN RAISE NOTICE 'hello %', 42; END $$;").await;
    assert_eq!(r[0].rows_affected, Some(2));
    assert!(r.iter().flat_map(|s| s.notices.iter()).any(|n| n.contains("hello 42")), "{r:?}");

    // Row limit → truncated.
    let r = c.execute("SELECT g FROM generate_series(1, 5000) g", &ExecOptions { max_rows: 100, timeout_ms: None }, CancellationToken::new()).await.unwrap();
    let rs = r[0].result.as_ref().unwrap();
    assert_eq!(rs.rows.len(), 100);
    assert!(rs.truncated);

    // Cancellation reaches the server.
    let tok = CancellationToken::new();
    let t2 = tok.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        t2.cancel();
    });
    let started = std::time::Instant::now();
    let err = c.execute("SELECT pg_sleep(30)", &ExecOptions::default(), tok).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(10));
    c.ping().await.expect("connection usable after cancel");

    // Timeout.
    let err = c.execute("SELECT pg_sleep(30)", &ExecOptions { max_rows: 10, timeout_ms: Some(300) }, CancellationToken::new()).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Timeout);

    // Syntax error with SQLSTATE.
    let err = c.execute("SELEC 1", &ExecOptions::default(), CancellationToken::new()).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Syntax);
    assert_eq!(err.code.as_deref(), Some("42601"));

    // Explain + sessions.
    let plan = c.explain("SELECT * FROM it.people WHERE id = 1", false).await.unwrap();
    assert!(!plan.rows.is_empty());
    let sessions = c.list_sessions().await.unwrap();
    assert!(!sessions.is_empty());

    // DDL for view/function/enum.
    exec(&*c, "CREATE VIEW it.v AS SELECT id FROM it.people; CREATE TYPE it.mood AS ENUM ('ok','sad'); CREATE FUNCTION it.f(a int) RETURNS int LANGUAGE sql AS 'SELECT a + 1'").await;
    let objs = c.list_objects(Some("it")).await.unwrap();
    for (k, n) in [(ObjectKind::View, "v"), (ObjectKind::Enum, "mood"), (ObjectKind::Function, "f(a integer)")] {
        let o = objs.iter().find(|o| o.kind == k && o.name == n).unwrap_or_else(|| panic!("{n} missing in {objs:?}"));
        let ddl = c.object_ddl(o).await.unwrap();
        assert!(ddl.to_uppercase().contains("CREATE"), "{ddl}");
    }

    // Database-enforced read-only session.
    let mut ro = cfg(Engine::Postgres, Some(&host), Some("dbs_test"));
    ro.read_only = true;
    let roc = connect(&ro).await;
    let err = roc.execute("INSERT INTO it.people VALUES (99, 'nope')", &ExecOptions::default(), CancellationToken::new()).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Permission, "{err:?}");

    // Wrong password → Authentication.
    let bad = driver_for(Engine::Postgres)
        .unwrap()
        .connect(&cfg(Engine::Postgres, Some(&host), Some("dbs_test")), ConnectSecrets { password: Some("wrong".into()) })
        .await
        .err()
        .unwrap();
    assert_eq!(bad.kind, ErrorKind::Authentication, "{bad:?}");
    assert!(!bad.message.contains("wrong"));

    // SSL modes against a server with TLS on (cert signed by the test CA, CN/SAN "postgres").
    const PG_SSL: &str = "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()";
    let pg_tls = |mode: TlsMode, ca: bool| {
        let mut t = cfg(Engine::Postgres, Some(&host), Some("dbs_test"));
        t.tls.mode = mode;
        t.tls.ca_cert_path = ca.then(|| "/certs/ca.crt".into());
        t
    };
    let encrypted = |r: Vec<StatementResult>| first_rows(&r)[0][0] == Value::Bool(true);
    // DISABLED: plaintext.
    let plain = connect(&pg_tls(TlsMode::Disabled, false)).await;
    assert!(!encrypted(exec(&*plain, PG_SSL).await), "DISABLED must not use TLS");
    // PREFERRED: the server offers TLS, so the session is encrypted (no CA needed).
    let pref = connect(&pg_tls(TlsMode::Preferred, false)).await;
    assert!(encrypted(exec(&*pref, PG_SSL).await), "PREFERRED must use TLS when available");
    // REQUIRED: encrypted, works without the CA (certificate not verified).
    let req = connect(&pg_tls(TlsMode::Required, false)).await;
    assert!(encrypted(exec(&*req, PG_SSL).await), "REQUIRED must be encrypted");
    // VERIFY-IDENTITY without the CA: the test CA isn't in the system trust store → rejected.
    let e = driver_for(Engine::Postgres).unwrap().connect(&pg_tls(TlsMode::VerifyIdentity, false), pw()).await.err().expect("untrusted cert must be rejected");
    assert!(matches!(e.kind, ErrorKind::Tls | ErrorKind::Connection), "{e:?}");
    let e = driver_for(Engine::Postgres).unwrap().connect(&pg_tls(TlsMode::VerifyCa, false), pw()).await.err().expect("VERIFY-CA without CA must fail");
    assert!(matches!(e.kind, ErrorKind::Tls | ErrorKind::Connection), "{e:?}");
    if std::path::Path::new("/certs/ca.crt").exists() {
        // VERIFY-CA and VERIFY-IDENTITY with the CA configured succeed and are encrypted.
        for mode in [TlsMode::VerifyCa, TlsMode::VerifyIdentity] {
            let c2 = driver_for(Engine::Postgres).unwrap().connect(&pg_tls(mode, true), pw()).await.unwrap_or_else(|e| panic!("{mode:?}: {e:?}"));
            assert!(encrypted(exec(&*c2, PG_SSL).await), "{mode:?} session must be encrypted");
        }
        // VERIFY-IDENTITY checks the hostname: connecting by IP (not in the certificate) fails,
        // while VERIFY-CA (chain only) accepts it.
        if let Ok(ip) = tokio::net::lookup_host(format!("{host}:5432")).await.map(|mut a| a.next().unwrap().ip().to_string()) {
            let mut by_ip = pg_tls(TlsMode::VerifyIdentity, true);
            by_ip.host = Some(ip.clone());
            assert!(driver_for(Engine::Postgres).unwrap().connect(&by_ip, pw()).await.is_err(), "hostname mismatch must be rejected");
            by_ip.tls.mode = TlsMode::VerifyCa;
            connect(&by_ip).await;
        }
    }

    exec(&*c, "DROP SCHEMA it CASCADE").await;
}

#[tokio::test]
async fn mysql_end_to_end() {
    if !it_enabled() {
        return;
    }
    let host = std::env::var("DBS_IT_MYSQL_HOST").unwrap_or("localhost".into());
    let c = connect(&cfg(Engine::MySql, Some(&host), Some("dbs_test"))).await;
    assert!(!c.server_info().await.unwrap().version.is_empty());
    exec(&*c, "DROP TABLE IF EXISTS people; CREATE TABLE people (id int PRIMARY KEY, name varchar(50) NULL)").await;
    crud_scenario(&*c, None, "people").await;
    c.use_schema("dbs_test").await.unwrap();
    assert!(c.use_schema("no_such_db").await.is_err());

    let r = exec(
        &*c,
        "SELECT CAST(18446744073709551615 AS UNSIGNED) AS big, CAST('12345678901234567890.123456789' AS DECIMAL(40,9)) AS num,
                NULL AS n, '' AS e, CAST('2024-03-01 12:34:56.789' AS DATETIME(3)) AS ts, JSON_OBJECT('a', 1) AS j,
                CAST(x'DEADBEEF' AS BINARY(4)) AS b, CAST('2024-02-29' AS DATE) AS d",
    )
    .await;
    let row = &first_rows(&r)[0];
    assert_eq!(row[0], Value::BigInt("18446744073709551615".into()));
    assert_eq!(row[1], Value::Decimal("12345678901234567890.123456789".into()));
    assert_eq!(row[2], Value::Null);
    assert_eq!(row[3], Value::Text("".into()));
    assert_eq!(row[4], Value::Timestamp { iso: "2024-03-01T12:34:56.789".into(), tz: false });
    assert_eq!(row[5], Value::Json(serde_json::json!({"a": 1})));
    assert_eq!(row[6], Value::Bytes { hex: "deadbeef".into(), len: 4, truncated: false });
    assert_eq!(row[7], Value::Date("2024-02-29".into()));

    // Procedure with BEGIN...END body and multiple result sets.
    exec(&*c, "DROP PROCEDURE IF EXISTS p2").await;
    exec(&*c, "CREATE PROCEDURE p2() BEGIN SELECT 1 AS a; SELECT 2 AS b; END").await;
    let r = exec(&*c, "CALL p2()").await;
    assert!(r.iter().filter(|s| s.result.is_some()).count() >= 2, "{r:?}");

    // Cancel via KILL QUERY.
    let tok = CancellationToken::new();
    let t2 = tok.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        t2.cancel();
    });
    let started = std::time::Instant::now();
    let err = c.execute("SELECT SLEEP(30)", &ExecOptions::default(), tok).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(10));
    c.ping().await.expect("usable after cancel");

    let err = c.execute("SELEC 1", &ExecOptions::default(), CancellationToken::new()).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Syntax);
    assert!(!c.list_sessions().await.unwrap().is_empty());
    let ddl = c.object_ddl(&ObjectRef { kind: ObjectKind::Procedure, database: None, schema: None, name: "p2".into() }).await.unwrap();
    assert!(ddl.contains("CREATE"));

    let mut ro = cfg(Engine::MySql, Some(&host), Some("dbs_test"));
    ro.read_only = true;
    let roc = connect(&ro).await;
    let err = roc.execute("INSERT INTO people VALUES (99, 'nope')", &ExecOptions::default(), CancellationToken::new()).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Permission, "{err:?}");
    exec(&*c, "DROP TABLE people; DROP PROCEDURE p2").await;
}

#[tokio::test]
async fn mariadb_end_to_end() {
    if !it_enabled() {
        return;
    }
    let host = std::env::var("DBS_IT_MARIADB_HOST").unwrap_or("localhost".into());
    let c = connect(&cfg(Engine::MariaDb, Some(&host), Some("dbs_test"))).await;
    let info = c.server_info().await.unwrap();
    assert!(info.version.contains("MariaDB"), "{info:?}");
    exec(&*c, "DROP TABLE IF EXISTS people; CREATE TABLE people (id int PRIMARY KEY, name varchar(50) NULL)").await;
    crud_scenario(&*c, None, "people").await;

    let r = exec(
        &*c,
        "SELECT CAST(18446744073709551615 AS UNSIGNED) AS big, CAST('12345678901234567890.123456789' AS DECIMAL(40,9)) AS num,
                NULL AS n, '' AS e, CAST('2024-03-01 12:34:56.789' AS DATETIME(3)) AS ts, CAST('2024-02-29' AS DATE) AS d",
    )
    .await;
    let row = &first_rows(&r)[0];
    assert_eq!(row[0], Value::BigInt("18446744073709551615".into()));
    assert_eq!(row[1], Value::Decimal("12345678901234567890.123456789".into()));
    assert_eq!(row[2], Value::Null);
    assert_eq!(row[3], Value::Text("".into()));
    assert_eq!(row[4], Value::Timestamp { iso: "2024-03-01T12:34:56.789".into(), tz: false });
    assert_eq!(row[5], Value::Date("2024-02-29".into()));

    // Procedures with BEGIN...END, multiple result sets, DDL retrieval.
    exec(&*c, "DROP PROCEDURE IF EXISTS p2").await;
    exec(&*c, "CREATE PROCEDURE p2() BEGIN SELECT 1 AS a; SELECT 2 AS b; END").await;
    let r = exec(&*c, "CALL p2()").await;
    assert!(r.iter().filter(|s| s.result.is_some()).count() >= 2, "{r:?}");
    let objs = c.list_objects(None).await.unwrap();
    assert!(objs.iter().any(|o| o.kind == ObjectKind::Procedure && o.name == "p2"));
    let ddl = c.object_ddl(&ObjectRef { kind: ObjectKind::Procedure, database: None, schema: None, name: "p2".into() }).await.unwrap();
    assert!(ddl.contains("CREATE"));

    // Cancel via KILL QUERY, syntax errors, sessions, explain, USE.
    let tok = CancellationToken::new();
    let t2 = tok.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        t2.cancel();
    });
    let err = c.execute("SELECT SLEEP(30)", &ExecOptions::default(), tok).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled);
    c.ping().await.expect("usable after cancel");
    let err = c.execute("SELEC 1", &ExecOptions::default(), CancellationToken::new()).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Syntax);
    assert!(!c.list_sessions().await.unwrap().is_empty());
    assert!(!c.explain("SELECT * FROM people WHERE id = 1", false).await.unwrap().rows.is_empty());
    c.use_schema("dbs_test").await.unwrap();

    // DB-enforced read-only.
    let mut ro = cfg(Engine::MariaDb, Some(&host), Some("dbs_test"));
    ro.read_only = true;
    let roc = connect(&ro).await;
    let err = roc.execute("INSERT INTO people VALUES (99, 'nope')", &ExecOptions::default(), CancellationToken::new()).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Permission, "{err:?}");
    exec(&*c, "DROP TABLE people; DROP PROCEDURE p2").await;
}

#[tokio::test]
async fn sqlite_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    rusqlite::Connection::open(&path).unwrap().execute_batch("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, meta JSON, born DATE)").unwrap();
    let p = path.to_str().unwrap();
    let c = connect(&cfg(Engine::Sqlite, None, Some(p))).await;
    crud_scenario(&*c, None, "people").await;

    let r = exec(&*c, "SELECT 9223372036854775807 AS big, NULL AS n, '' AS e, x'dead' AS b").await;
    let row = &first_rows(&r)[0];
    assert_eq!(row[0], Value::BigInt("9223372036854775807".into()));
    assert_eq!(row[1], Value::Null);
    assert_eq!(row[2], Value::Text("".into()));
    assert_eq!(row[3], Value::Bytes { hex: "dead".into(), len: 2, truncated: false });

    // Cancellation via interrupt.
    let tok = CancellationToken::new();
    let t2 = tok.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        t2.cancel();
    });
    let err =
        c.execute("WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r) SELECT count(*) FROM r", &ExecOptions::default(), tok).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled, "{err:?}");

    // Missing file is NOT silently created.
    let missing = dir.path().join("nope.db");
    assert!(driver_for(Engine::Sqlite).unwrap().connect(&cfg(Engine::Sqlite, None, Some(missing.to_str().unwrap())), pw()).await.is_err());
    assert!(!missing.exists());

    // Read-only is enforced by SQLite itself.
    let mut ro = cfg(Engine::Sqlite, None, Some(p));
    ro.read_only = true;
    let roc = connect(&ro).await;
    let err = roc.execute("DELETE FROM people", &ExecOptions::default(), CancellationToken::new()).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Permission, "{err:?}");

    // Consistent backup.
    let bpath = dir.path().join("backup.db");
    dbs_drivers::sqlite::backup_to(p, bpath.to_str().unwrap()).await.unwrap();
    let b = connect(&cfg(Engine::Sqlite, None, Some(bpath.to_str().unwrap()))).await;
    assert_eq!(b.count_rows(&TableTarget { schema: None, table: "people".into() }, &[]).await.unwrap(), 3);
}

/// Redis test server: `DBS_IT_REDIS_HOST` (default localhost) and optional `DBS_IT_REDIS_PORT`
/// (e.g. the host-mapped port of the compose service when running outside the container).
fn redis_cfg(db: &str) -> ConnectionConfig {
    let host = std::env::var("DBS_IT_REDIS_HOST").unwrap_or("localhost".into());
    let mut c = cfg(Engine::Redis, Some(&host), Some(db));
    c.port = std::env::var("DBS_IT_REDIS_PORT").ok().and_then(|p| p.parse().ok());
    c.username = None;
    c
}

#[tokio::test]
async fn redis_end_to_end() {
    if !it_enabled() {
        return;
    }
    let mut conf = redis_cfg("0");
    let c = driver_for(Engine::Redis).unwrap().connect(&conf, ConnectSecrets::default()).await.unwrap();
    assert!(!c.server_info().await.unwrap().version.is_empty());
    exec(&*c, "DEL it:list it:str\nRPUSH it:list a b c\nSET it:str \"hello world\"").await;
    let r = exec(&*c, "GET it:str").await;
    assert_eq!(first_rows(&r)[0][0], Value::Text("hello world".into()));
    // Keys are browsed with bounded SCAN pages, not listed as objects.
    assert!(c.list_objects(None).await.unwrap().is_empty());
    let page = c.key_value().unwrap().scan_keys("db0", "it:*", 0, 100, true).await.unwrap();
    let mut names: Vec<_> = page.keys.iter().map(|k| k.key.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["it:list", "it:str"]);
    let rs = c.fetch_table(&TableTarget { schema: None, table: "it:list".into() }, &PageRequest { limit: 10, ..Default::default() }).await.unwrap();
    assert_eq!(rs.rows.len(), 3);
    assert_eq!(c.count_rows(&TableTarget { schema: None, table: "it:list".into() }, &[]).await.unwrap(), 3);

    conf.read_only = true;
    let ro = driver_for(Engine::Redis).unwrap().connect(&conf, ConnectSecrets::default()).await.unwrap();
    let e = ro.execute("SET it:str x", &ExecOptions::default(), CancellationToken::new()).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::PolicyBlocked);
    // Selecting a database is a session command, allowed on a read-only connection.
    exec(&*ro, "SELECT 1\nGET it:none").await;
    exec(&*c, "DEL it:list it:str").await;
}

const KB: &str = "itkb:";
const KB_BULK: usize = 10_000;

async fn redis_raw(db: i64) -> redis::aio::MultiplexedConnection {
    let host = std::env::var("DBS_IT_REDIS_HOST").unwrap_or("localhost".into());
    let port = std::env::var("DBS_IT_REDIS_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(6379);
    redis::Client::open(format!("redis://{host}:{port}/{db}")).unwrap().get_multiplexed_async_connection().await.unwrap()
}

/// Remove every `itkb:*` key with SCAN + UNLINK.
async fn redis_clean(c: &mut redis::aio::MultiplexedConnection) {
    let mut cursor = 0u64;
    loop {
        let (next, keys): (u64, Vec<String>) =
            redis::cmd("SCAN").arg(cursor).arg("MATCH").arg(format!("{KB}*")).arg("COUNT").arg(1000).query_async(c).await.unwrap();
        if !keys.is_empty() {
            let _: () = redis::cmd("UNLINK").arg(&keys).query_async(c).await.unwrap();
        }
        cursor = next;
        if cursor == 0 {
            break;
        }
    }
}

/// db0: 10k bulk strings + one key of every type + nested namespaces; db1: two keys.
async fn redis_seed() {
    let mut c0 = redis_raw(0).await;
    redis_clean(&mut c0).await;
    for chunk in (0..KB_BULK).collect::<Vec<_>>().chunks(1000) {
        let mut p = redis::pipe();
        for i in chunk {
            p.cmd("SET").arg(format!("{KB}bulk:{i:05}")).arg(i).ignore();
        }
        let _: () = p.query_async(&mut c0).await.unwrap();
    }
    let mut p = redis::pipe();
    p.cmd("SET").arg(format!("{KB}str")).arg(r#"{"a":1,"b":[true,null]}"#).arg("EX").arg(1000).ignore();
    p.cmd("SET").arg(format!("{KB}long")).arg("x".repeat(1000)).ignore();
    for i in 0..300 {
        p.cmd("HSET").arg(format!("{KB}hash")).arg(format!("f{i}")).arg(format!("v{i}")).ignore();
        p.cmd("SADD").arg(format!("{KB}set")).arg(format!("m{i}")).ignore();
        p.cmd("ZADD").arg(format!("{KB}zset")).arg(i).arg(format!("z{i}")).ignore();
    }
    for i in 0..500 {
        p.cmd("RPUSH").arg(format!("{KB}list")).arg(format!("item{i}")).ignore();
    }
    for i in 0..250 {
        p.cmd("XADD").arg(format!("{KB}stream")).arg("*").arg("n").arg(i).ignore();
    }
    for k in ["ns:a:b:1", "ns:a:c", "ns:x", "glob*key"] {
        p.cmd("SET").arg(format!("{KB}{k}")).arg("1").ignore();
    }
    let _: () = p.query_async(&mut c0).await.unwrap();
    let mut c1 = redis_raw(1).await;
    redis_clean(&mut c1).await;
    let _: () = redis::pipe()
        .cmd("SET")
        .arg(format!("{KB}db1:one"))
        .arg("1")
        .ignore()
        .cmd("HSET")
        .arg(format!("{KB}db1:h"))
        .arg("f")
        .arg("v")
        .ignore()
        .query_async(&mut c1)
        .await
        .unwrap();
}

#[tokio::test]
async fn redis_key_browser() {
    if !it_enabled() {
        return;
    }
    redis_seed().await;
    let conf = redis_cfg("0");
    let c = driver_for(Engine::Redis).unwrap().connect(&conf, ConnectSecrets::default()).await.unwrap();
    let kv = c.key_value().expect("key browser");
    assert!(c.capabilities().schemas);
    assert_eq!(c.server_info().await.unwrap().current_database.as_deref(), Some("db0"));

    // Databases as schemas, with key counts from INFO keyspace.
    let schemas = c.list_schemas(None).await.unwrap();
    assert!(schemas.contains(&"db0".to_string()) && schemas.contains(&"db1".to_string()), "{schemas:?}");
    let ks = kv.keyspaces().await.unwrap();
    let db0 = ks.iter().find(|k| k.name == "db0").unwrap();
    assert!(db0.current && db0.keys >= KB_BULK as u64, "{db0:?}");
    assert!(ks.iter().find(|k| k.name == "db1").unwrap().keys >= 2);

    // Paging the 10k bulk keys with SCAN: every key exactly once, pages bounded.
    let pat = format!("{KB}bulk:*");
    let mut from = 0;
    let mut seen = std::collections::HashSet::new();
    let mut starts = vec![];
    let mut first = true;
    loop {
        let page = kv.scan_keys("db0", &pat, from, 500, first).await.unwrap();
        first = false;
        assert!(page.keys.len() <= 500);
        assert!(page.total.is_none(), "no exact total for a pattern");
        starts.push((from, page.keys.iter().map(|k| k.key.clone()).collect::<Vec<_>>()));
        for k in &page.keys {
            assert_eq!(k.kind, "string");
            assert!(seen.insert(k.key.clone()), "duplicate {}", k.key);
        }
        from = page.next;
        if page.done {
            break;
        }
    }
    assert_eq!(seen.len(), KB_BULK);
    assert!(starts.len() >= 20, "{} pages", starts.len());
    // Re-reading an earlier page resumes from the cached cursor: the same page of keys.
    // SCAN only guarantees full coverage, not identical batches: while Redis is still
    // rehashing after the 10k inserts, a batch can shift by a key at the page edge.
    // So compare as sets and allow a small difference at the boundary.
    let (at, keys) = &starts[3];
    let again = kv.scan_keys("db0", &pat, *at, 500, false).await.unwrap();
    let before: std::collections::HashSet<&String> = keys.iter().collect();
    let after: Vec<String> = again.keys.iter().map(|k| k.key.clone()).collect();
    assert!(after.iter().all(|k| k.starts_with(&format!("{KB}bulk:"))), "{after:?}");
    let common = after.iter().filter(|k| before.contains(k)).count();
    assert!(common + 5 >= keys.len() && after.len() + 5 >= keys.len(), "re-read page drifted: {common} of {} keys in common", keys.len());

    // Match-all pages carry the DBSIZE total.
    let all = kv.scan_keys("db0", "*", 0, 100, true).await.unwrap();
    assert!(all.total.unwrap() >= KB_BULK as u64);
    assert!(all.keys.len() <= 100);

    // MATCH narrows server-side; typed rows with TTL, size, length and preview.
    let typed = kv.scan_keys("db0", &format!("{KB}[a-z]*"), 0, 1000, true).await.unwrap();
    let mut rows = typed.keys.clone();
    let mut f = typed.next;
    let mut done = typed.done;
    while !done {
        let p = kv.scan_keys("db0", &format!("{KB}[a-z]*"), f, 1000, false).await.unwrap();
        rows.extend(p.keys);
        f = p.next;
        done = p.done;
    }
    let row = |k: &str| rows.iter().find(|r| r.key == format!("{KB}{k}")).unwrap_or_else(|| panic!("{k}"));
    assert_eq!((row("hash").kind.as_str(), row("hash").length), ("hash", Some(300)));
    assert_eq!((row("list").kind.as_str(), row("list").length), ("list", Some(500)));
    assert_eq!((row("set").kind.as_str(), row("set").length), ("set", Some(300)));
    assert_eq!((row("zset").kind.as_str(), row("zset").length), ("zset", Some(300)));
    assert_eq!((row("stream").kind.as_str(), row("stream").length), ("stream", Some(250)));
    let s = row("str");
    assert!(s.ttl > 0 && s.ttl <= 1000, "{s:?}");
    assert_eq!(s.preview.as_deref(), Some(r#"{"a":1,"b":[true,null]}"#));
    assert!(s.size.is_some_and(|n| n > 0));
    let long = row("long");
    assert_eq!(long.preview.as_ref().unwrap().len(), 200);
    assert!(long.preview_truncated);
    assert_eq!(row("hash").ttl, -1);
    let ns_only = kv.scan_keys("db0", &format!("{KB}ns:*"), 0, 100, true).await.unwrap();
    assert_eq!(ns_only.keys.len(), 3);
    assert!(ns_only.done);

    // Namespace tree: bounded batches with "load more", grouped by the separator.
    let mut cursor = 0;
    let mut namespaces = std::collections::BTreeMap::<String, u64>::new();
    let mut leaves = std::collections::BTreeSet::new();
    let mut batches = 0;
    loop {
        let b = kv.namespace_children("db0", KB, ":", cursor, 2000).await.unwrap();
        batches += 1;
        assert!(b.scanned <= 2000 + 1000, "batch scanned {}", b.scanned);
        for n in b.namespaces {
            *namespaces.entry(n.prefix).or_default() += n.count;
        }
        leaves.extend(b.keys);
        cursor = b.cursor;
        if b.done {
            break;
        }
    }
    assert!(batches > 1, "10k keys need several batches");
    assert_eq!(namespaces.get(&format!("{KB}bulk:")), Some(&(KB_BULK as u64)));
    assert_eq!(namespaces.get(&format!("{KB}ns:")), Some(&3));
    assert!(leaves.contains(&format!("{KB}hash")) && leaves.contains(&format!("{KB}glob*key")));
    let ns = kv.namespace_children("db0", &format!("{KB}ns:"), ":", 0, 2000).await.unwrap();
    assert!(ns.done);
    assert_eq!(ns.namespaces.iter().map(|n| (n.label.as_str(), n.count)).collect::<Vec<_>>(), vec![("a", 2)]);
    assert_eq!(ns.keys, vec![format!("{KB}ns:x")]);
    // Glob characters in a prefix match literally.
    let lit = kv.namespace_children("db0", &format!("{KB}glob*"), ":", 0, 100).await.unwrap();
    assert_eq!(lit.keys, vec![format!("{KB}glob*key")]);

    // Value detail by type, paged.
    let page_all = |key: &'static str, count: u32| {
        let kv = c.key_value().unwrap();
        async move {
            let mut rows = vec![];
            let mut cur = String::new();
            let mut kind;
            loop {
                let p = kv.read_value("db0", &format!("{KB}{key}"), &ValueRequest { cursor: cur.clone(), count }).await.unwrap();
                // HSCAN/SSCAN COUNT is a hint (small encodings come back whole); offset pages are exact.
                assert!(matches!(key, "hash" | "set") || p.rows.len() <= count as usize, "{key} page of {}", p.rows.len());
                kind = p.kind.clone();
                rows.extend(p.rows);
                match p.next {
                    Some(n) => cur = n,
                    None => break,
                }
            }
            (kind, rows)
        }
    };
    let (k, r) = page_all("hash", 50).await;
    assert_eq!(k, "hash");
    assert_eq!(r.iter().map(|x| x[0].to_plain().unwrap_or_default()).collect::<std::collections::HashSet<_>>().len(), 300);
    let (_, r) = page_all("list", 200).await;
    assert_eq!(r.len(), 500);
    assert_eq!(r[499], vec![Value::Int(499), Value::Text("item499".into())]);
    let (_, r) = page_all("set", 100).await;
    assert_eq!(r.iter().map(|x| x[0].to_plain().unwrap_or_default()).collect::<std::collections::HashSet<_>>().len(), 300);
    let (_, r) = page_all("zset", 120).await;
    assert_eq!(r.len(), 300);
    assert_eq!(r[0], vec![Value::Text("z0".into()), Value::Float(0.0)]);
    let (_, r) = page_all("stream", 100).await;
    assert_eq!(r.len(), 250);
    assert!(matches!(&r[249][1], Value::Json(j) if j["n"] == "249"));
    let s = kv.read_value("db0", &format!("{KB}str"), &ValueRequest::default()).await.unwrap();
    assert_eq!(s.text.as_deref(), Some(r#"{"a":1,"b":[true,null]}"#));
    assert!(s.next.is_none() && s.ttl > 0);
    assert_eq!(kv.read_value("db0", &format!("{KB}missing"), &ValueRequest::default()).await.unwrap_err().kind, ErrorKind::NotFound);

    // Switching database (use_schema) affects the query tab; browse calls name their database.
    c.use_schema("db1").await.unwrap();
    let r = exec(&*c, &format!("GET {KB}db1:one")).await;
    assert_eq!(first_rows(&r)[0][0], Value::Text("1".into()));
    let db1 = kv.scan_keys("db1", &format!("{KB}*"), 0, 100, true).await.unwrap();
    assert_eq!(db1.keys.len(), 2);
    assert!(kv.keyspaces().await.unwrap().iter().any(|k| k.name == "db1" && k.current));
    // Still db1 for the query tab after browsing db0.
    kv.scan_keys("db0", "*", 0, 10, true).await.unwrap();
    let r = exec(&*c, &format!("EXISTS {KB}db1:one")).await;
    assert_eq!(first_rows(&r)[0][0], Value::Int(1));

    // Staged edits in db1: one transaction.
    let edits = vec![
        KvEdit::SetString { key: format!("{KB}db1:new"), value: "fresh".into() },
        KvEdit::HashSet { key: format!("{KB}db1:h"), field: "g".into(), value: "w".into() },
        KvEdit::HashDelete { key: format!("{KB}db1:h"), field: "f".into() },
        KvEdit::Expire { key: format!("{KB}db1:new"), seconds: 500 },
        KvEdit::Rename { key: format!("{KB}db1:one"), to: format!("{KB}db1:renamed") },
        KvEdit::ListPush { key: format!("{KB}db1:l"), value: "a".into() },
        KvEdit::SetAdd { key: format!("{KB}db1:s"), member: "m".into() },
        KvEdit::ZsetAdd { key: format!("{KB}db1:z"), member: "m".into(), score: 2.5 },
    ];
    let lines = kv.edit_commands("db1", &edits).unwrap();
    assert_eq!(lines[0], "SELECT 1");
    assert_eq!(lines.len(), edits.len() + 1);
    let rep = kv.apply_edits("db1", &edits).await.unwrap();
    assert!(rep.committed && rep.conflicts.is_empty() && rep.applied == edits.len(), "{rep:?}");
    let h = kv.read_value("db1", &format!("{KB}db1:h"), &ValueRequest::default()).await.unwrap();
    assert_eq!(h.rows, vec![vec![Value::Text("g".into()), Value::Text("w".into())]]);
    let n = kv.read_value("db1", &format!("{KB}db1:new"), &ValueRequest::default()).await.unwrap();
    assert_eq!(n.text.as_deref(), Some("fresh"));
    assert!(n.ttl > 0 && n.ttl <= 500);
    // Rename onto an existing key is a conflict, nothing applied.
    let rep = kv.apply_edits("db1", &[KvEdit::Rename { key: format!("{KB}db1:renamed"), to: format!("{KB}db1:new") }]).await.unwrap();
    assert!(!rep.committed && rep.conflicts == vec![0]);
    let rep = kv
        .apply_edits("db1", &[KvEdit::Expire { key: format!("{KB}db1:new"), seconds: -1 }, KvEdit::Delete { key: format!("{KB}db1:renamed") }])
        .await
        .unwrap();
    assert!(rep.committed);
    assert_eq!(kv.read_value("db1", &format!("{KB}db1:new"), &ValueRequest::default()).await.unwrap().ttl, -1);
    assert!(kv.read_value("db1", &format!("{KB}db1:renamed"), &ValueRequest::default()).await.is_err());

    // Safety: a read-only connection refuses edits in the driver, and the policy blocks
    // the generated commands before they reach it.
    let mut ro_conf = redis_cfg("0");
    ro_conf.read_only = true;
    let ro = driver_for(Engine::Redis).unwrap().connect(&ro_conf, ConnectSecrets::default()).await.unwrap();
    let del = [KvEdit::Delete { key: format!("{KB}hash") }];
    assert_eq!(ro.key_value().unwrap().apply_edits("db0", &del).await.unwrap_err().kind, ErrorKind::PolicyBlocked);
    let text = ro.key_value().unwrap().edit_commands("db0", &del).unwrap().join("\n");
    let g = dbs_safety::ConfirmationGuard::new([1; 32]);
    let ev = dbs_safety::evaluate_classified(dbs_safety::classify_redis_script(&text), &text, &dbs_safety::SafetyPolicy::read_only(), &g, "c", "n");
    assert!(matches!(ev.decision, dbs_safety::Decision::Block { .. }));
    let prod = dbs_safety::evaluate_classified(
        dbs_safety::classify_redis_script(&text),
        &text,
        &dbs_safety::SafetyPolicy::for_environment(EnvironmentKind::Production),
        &g,
        "c",
        "Prod",
    );
    assert!(matches!(prod.decision, dbs_safety::Decision::Confirm { typed_phrase: Some(_), .. }));
    // Read-only browsing still works.
    assert!(!ro.key_value().unwrap().scan_keys("db0", &format!("{KB}ns:*"), 0, 10, true).await.unwrap().keys.is_empty());
    assert!(redis::cmd("EXISTS").arg(format!("{KB}hash")).query_async::<bool>(&mut redis_raw(0).await).await.unwrap(), "read-only connection deleted nothing");

    redis_clean(&mut redis_raw(0).await).await;
    redis_clean(&mut redis_raw(1).await).await;
}

/// Accounts using the deprecated-but-common `sha256_password` plugin (MySQL 5.7/8.x).
/// Plaintext connection exercises the RSA public-key exchange (patched mysql_async).
#[tokio::test]
async fn mysql_sha256_password_auth() {
    if !it_enabled() {
        return;
    }
    let host = std::env::var("DBS_IT_MYSQL_HOST").unwrap_or("localhost".into());
    let port = std::env::var("DBS_IT_MYSQL_PORT").ok().and_then(|p| p.parse().ok());
    let mut root = cfg(Engine::MySql, Some(&host), None);
    root.port = port;
    root.username = Some("root".into());
    let rc = driver_for(Engine::MySql).unwrap().connect(&root, ConnectSecrets { password: Some("dbs_root_test".into()) }).await.expect("root connect");
    exec(
        &*rc,
        "DROP USER IF EXISTS 'it_sha256'@'%', 'it_sha256_empty'@'%';
         CREATE USER 'it_sha256'@'%' IDENTIFIED WITH sha256_password BY 'S3cret-sha256!';
         CREATE USER 'it_sha256_empty'@'%' IDENTIFIED WITH sha256_password BY ''",
    )
    .await;

    let mut u = cfg(Engine::MySql, Some(&host), None);
    u.port = port;
    u.username = Some("it_sha256".into());
    let c = driver_for(Engine::MySql)
        .unwrap()
        .connect(&u, ConnectSecrets { password: Some("S3cret-sha256!".into()) })
        .await
        .expect("sha256_password connect over plaintext (RSA)");
    let r = exec(&*c, "SELECT CURRENT_USER()").await;
    assert!(format!("{:?}", first_rows(&r)[0][0]).contains("it_sha256"));

    let bad = driver_for(Engine::MySql).unwrap().connect(&u, ConnectSecrets { password: Some("wrong".into()) }).await;
    assert!(bad.is_err(), "wrong password must be rejected");

    u.username = Some("it_sha256_empty".into());
    driver_for(Engine::MySql).unwrap().connect(&u, ConnectSecrets { password: None }).await.expect("sha256_password with empty password");

    exec(&*rc, "DROP USER 'it_sha256'@'%', 'it_sha256_empty'@'%'").await;
}

/// `SHOW STATUS LIKE 'Ssl_cipher'` value (empty = plaintext session).
async fn mysql_cipher(c: &dyn DatabaseConnection) -> String {
    let r = exec(c, "SHOW SESSION STATUS LIKE 'Ssl_cipher'").await;
    match &first_rows(&r)[0][1] {
        Value::Text(s) => s.clone(),
        Value::Null => String::new(),
        other => format!("{other:?}"),
    }
}

#[tokio::test]
async fn mysql_ssl_modes() {
    if !it_enabled() {
        return;
    }
    // MySQL 8.4 auto-generates a self-signed server certificate.
    let host = std::env::var("DBS_IT_MYSQL_HOST").unwrap_or("localhost".into());
    let with = |mode: TlsMode| {
        let mut c = cfg(Engine::MySql, Some(&host), Some("dbs_test"));
        c.tls.mode = mode;
        c
    };
    let plain = connect(&with(TlsMode::Disabled)).await;
    assert_eq!(mysql_cipher(&*plain).await, "", "DISABLED must not use TLS");
    for mode in [TlsMode::Preferred, TlsMode::Required] {
        let c = driver_for(Engine::MySql).unwrap().connect(&with(mode), pw()).await.unwrap_or_else(|e| panic!("{mode:?}: {e:?}"));
        assert!(!mysql_cipher(&*c).await.is_empty(), "{mode:?} session must be encrypted");
    }
    // The self-signed certificate isn't trusted: verification must fail, never downgrade.
    for mode in [TlsMode::VerifyIdentity, TlsMode::VerifyCa] {
        let e = driver_for(Engine::MySql).unwrap().connect(&with(mode), pw()).await.err().unwrap_or_else(|| panic!("{mode:?} must reject an untrusted cert"));
        assert!(matches!(e.kind, ErrorKind::Tls | ErrorKind::Connection), "{mode:?}: {e:?}");
    }
}

#[tokio::test]
async fn mariadb_ssl_preferred() {
    if !it_enabled() {
        return;
    }
    // MariaDB may or may not have TLS configured: PREFERRED must connect either way
    // (exercising the no-TLS fallback when the server doesn't offer it).
    let host = std::env::var("DBS_IT_MARIADB_HOST").unwrap_or("localhost".into());
    let mut c = cfg(Engine::MariaDb, Some(&host), Some("dbs_test"));
    c.tls.mode = TlsMode::Preferred;
    let conn = connect(&c).await;
    let cipher = mysql_cipher(&*conn).await;
    eprintln!("MariaDB PREFERRED session cipher: {cipher:?}");
    assert!(!conn.server_info().await.unwrap().version.is_empty());
}

#[tokio::test]
async fn redis_ssl_modes() {
    if !it_enabled() {
        return;
    }
    // The test Redis has no TLS: DISABLED works, PREFERRED falls back to plain TCP,
    // REQUIRED fails (never silently plaintext).
    let with = |mode: TlsMode| {
        let mut c = redis_cfg("0");
        c.connect_timeout_secs = 5;
        c.tls.mode = mode;
        c
    };
    for mode in [TlsMode::Disabled, TlsMode::Preferred] {
        let c = driver_for(Engine::Redis).unwrap().connect(&with(mode), ConnectSecrets::default()).await.unwrap_or_else(|e| panic!("{mode:?}: {e:?}"));
        c.ping().await.unwrap();
    }
    assert!(driver_for(Engine::Redis).unwrap().connect(&with(TlsMode::Required), ConnectSecrets::default()).await.is_err(), "REQUIRED must not fall back");
}

// ---------------------------------------------------------------- DynamoDB (DynamoDB Local)

const DYN_EXACT: &str = "12345678901234567890.123456789";

fn dyn_cfg() -> (ConnectionConfig, ConnectSecrets) {
    let endpoint = std::env::var("DBS_IT_DYNAMO_ENDPOINT").unwrap_or("http://localhost:58000".into());
    let mut c = cfg(Engine::DynamoDb, Some(&endpoint), Some("us-east-1"));
    c.username = Some("dbstest".into()); // DynamoDB Local accepts any alphanumeric key id
    (c, ConnectSecrets { password: Some("dbstestsecret".into()) })
}

fn eq_filter(col: &str, v: Value) -> FilterCondition {
    FilterCondition { column: col.into(), op: FilterOp::Eq, value: Some(v), values: vec![], ..Default::default() }
}

fn cell<'a>(rs: &'a ResultSet, row: usize, col: &str) -> &'a Value {
    let i = rs.columns.iter().position(|c| c.name == col).unwrap_or_else(|| panic!("column {col} in {:?}", rs.columns));
    &rs.rows[row][i]
}

async fn dyn_setup(table: &str) -> aws_sdk_dynamodb::Client {
    use aws_sdk_dynamodb::types::*;
    let (c, _) = dyn_cfg();
    let sdk = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(aws_sdk_dynamodb::config::Region::new("us-east-1"))
        .endpoint_url(c.host.unwrap())
        .credentials_provider(aws_sdk_dynamodb::config::Credentials::new("dbstest", "dbstestsecret", None, None, "it"))
        .load()
        .await;
    let client = aws_sdk_dynamodb::Client::new(&sdk);
    let attr = |n: &str, t: ScalarAttributeType| AttributeDefinition::builder().attribute_name(n).attribute_type(t).build().unwrap();
    let key = |n: &str, t: KeyType| KeySchemaElement::builder().attribute_name(n).key_type(t).build().unwrap();
    client
        .create_table()
        .table_name(table)
        .attribute_definitions(attr("pk", ScalarAttributeType::S))
        .attribute_definitions(attr("sk", ScalarAttributeType::N))
        .attribute_definitions(attr("gsi_pk", ScalarAttributeType::S))
        .key_schema(key("pk", KeyType::Hash))
        .key_schema(key("sk", KeyType::Range))
        .global_secondary_indexes(
            GlobalSecondaryIndex::builder()
                .index_name("by_gsi")
                .key_schema(key("gsi_pk", KeyType::Hash))
                .projection(Projection::builder().projection_type(ProjectionType::All).build())
                .build()
                .unwrap(),
        )
        .billing_mode(BillingMode::PayPerRequest)
        .send()
        .await
        .expect("create table");
    let s = |v: &str| AttributeValue::S(v.into());
    let n = |v: &str| AttributeValue::N(v.into());
    for i in 0..25 {
        client
            .put_item()
            .table_name(table)
            .item("pk", s(&format!("p{}", i % 3)))
            .item("sk", n(&i.to_string()))
            .item("name", s(&format!("item{i}")))
            .item("gsi_pk", s(&format!("g{}", i % 2)))
            .send()
            .await
            .unwrap();
    }
    client
        .put_item()
        .table_name(table)
        .item("pk", s("types"))
        .item("sk", n("0"))
        .item("s", s("héllo"))
        .item("n", n(DYN_EXACT))
        .item("big", n("9007199254740993"))
        .item("int", n("42"))
        .item("flag", AttributeValue::Bool(true))
        .item("nul", AttributeValue::Null(true))
        .item("bin", AttributeValue::B(aws_sdk_dynamodb::primitives::Blob::new(vec![0xde, 0xad, 0xbe, 0xef])))
        .item("list", AttributeValue::L(vec![s("a"), n("1")]))
        .item("map", AttributeValue::M([("a".to_string(), n("1")), ("b".to_string(), s("x"))].into()))
        .item("ss", AttributeValue::Ss(vec!["x".into(), "y".into()]))
        .item("ns", AttributeValue::Ns(vec!["1".into(), "2.5".into()]))
        .send()
        .await
        .unwrap();
    client
}

#[tokio::test]
async fn dynamo_end_to_end() {
    if !it_enabled() {
        return;
    }
    let table = format!("it_items_{}", Uuid::new_v4().simple());
    let client = dyn_setup(&table).await;
    let (conf, secrets) = dyn_cfg();
    let c = driver_for(Engine::DynamoDb).unwrap().connect(&conf, secrets).await.expect("connect");
    let caps = c.capabilities();
    assert!(caps.sql && caps.inline_edit && !caps.transactions && !caps.schemas && !caps.explain);
    assert!(c.server_info().await.unwrap().version.starts_with("DynamoDB us-east-1"));
    let t = TableTarget { schema: None, table: table.clone() };

    // list / describe
    assert!(c.list_objects(None).await.unwrap().iter().any(|o| o.name == table && o.kind == ObjectKind::Table));
    let d = c.describe_table(&t).await.unwrap();
    assert_eq!(d.primary_key, vec!["pk", "sk"]);
    assert_eq!(d.columns[0].name, "pk");
    assert_eq!(d.columns[1].data_type, "N");
    let gsi = d.indexes.iter().find(|i| i.name == "by_gsi").expect("gsi");
    assert_eq!(gsi.columns, vec!["gsi_pk"]);
    assert!(d.ddl.unwrap().contains("by_gsi"));
    let missing = c.describe_table(&TableTarget { schema: None, table: "no_such_table".into() }).await.unwrap_err();
    assert_eq!(missing.kind, ErrorKind::NotFound);

    // paging by continuation key: 26 items over three pages, no duplicates, keys first
    let mut seen = std::collections::HashSet::new();
    let mut pages = Vec::new();
    for p in 0..3 {
        let rs = c.fetch_table(&t, &PageRequest { offset: p * 10, limit: 10, ..Default::default() }).await.unwrap();
        assert_eq!(rs.columns[0].name, "pk");
        assert_eq!(rs.columns[1].name, "sk");
        assert_eq!(rs.columns[1].type_name, "N");
        for r in 0..rs.rows.len() {
            assert!(seen.insert(format!("{:?}/{:?}", cell(&rs, r, "pk"), cell(&rs, r, "sk"))), "duplicate row across pages");
        }
        pages.push(rs.rows.len());
    }
    assert_eq!(pages, vec![10, 10, 6]);
    // A jump on a fresh connection (no cached cursors) scans forward to the offset.
    let (conf2, secrets2) = dyn_cfg();
    let fresh = driver_for(Engine::DynamoDb).unwrap().connect(&conf2, secrets2).await.unwrap();
    let jump = fresh.fetch_table(&t, &PageRequest { offset: 23, limit: 10, ..Default::default() }).await.unwrap();
    assert_eq!(jump.rows.len(), 3);

    // exact values and type mapping
    let rs = c.fetch_table(&t, &PageRequest { limit: 50, filters: vec![eq_filter("pk", Value::Text("types".into()))], ..Default::default() }).await.unwrap();
    assert_eq!(rs.rows.len(), 1);
    assert_eq!(cell(&rs, 0, "n"), &Value::Decimal(DYN_EXACT.into()));
    assert_eq!(rs.columns.iter().find(|c| c.name == "n").unwrap().type_name, "N");
    assert_eq!(cell(&rs, 0, "big"), &Value::Decimal("9007199254740993".into()));
    assert_eq!(cell(&rs, 0, "int"), &Value::Int(42));
    assert_eq!(cell(&rs, 0, "s"), &Value::Text("héllo".into()));
    assert_eq!(cell(&rs, 0, "flag"), &Value::Bool(true));
    assert_eq!(cell(&rs, 0, "nul"), &Value::Null);
    assert_eq!(cell(&rs, 0, "bin"), &Value::Bytes { hex: "deadbeef".into(), len: 4, truncated: false });
    assert_eq!(cell(&rs, 0, "list"), &Value::Json(serde_json::json!(["a", 1])));
    assert_eq!(cell(&rs, 0, "map"), &Value::Json(serde_json::json!({"a": 1, "b": "x"})));
    assert_eq!(cell(&rs, 0, "ss"), &Value::Array(vec![Value::Text("x".into()), Value::Text("y".into())]));
    assert_eq!(cell(&rs, 0, "ns"), &Value::Array(vec![Value::Int(1), Value::Decimal("2.5".into())]));

    // filters (FilterExpression with placeholders) and counts
    let count = |f: Vec<FilterCondition>| {
        let c = &c;
        let t = &t;
        async move { c.count_rows(t, &f).await.unwrap() }
    };
    assert_eq!(count(vec![]).await, 26);
    assert_eq!(count(vec![eq_filter("pk", Value::Text("p1".into()))]).await, 8);
    assert_eq!(
        count(vec![FilterCondition {
            column: "name".into(),
            op: FilterOp::StartsWith,
            value: Some(Value::Text("item1".into())),
            values: vec![],
            ..Default::default()
        }])
        .await,
        11
    );
    assert_eq!(
        count(vec![FilterCondition { column: "sk".into(), op: FilterOp::Ge, value: Some(Value::Int(20)), values: vec![], ..Default::default() }]).await,
        5
    );
    assert_eq!(
        count(vec![FilterCondition {
            column: "pk".into(),
            op: FilterOp::In,
            value: None,
            values: vec![Value::Text("p0".into()), Value::Text("p2".into())],
            ..Default::default()
        }])
        .await,
        17
    );
    assert_eq!(count(vec![FilterCondition { column: "s".into(), op: FilterOp::IsNotNull, value: None, values: vec![], ..Default::default() }]).await, 1);
    assert_eq!(count(vec![FilterCondition { column: "nul".into(), op: FilterOp::IsNull, value: None, values: vec![], ..Default::default() }]).await, 26);
    assert_eq!(
        count(vec![FilterCondition {
            column: "name".into(),
            op: FilterOp::Contains,
            value: Some(Value::Text("m2".into())),
            values: vec![],
            ..Default::default()
        }])
        .await,
        6
    );
    let filtered =
        c.fetch_table(&t, &PageRequest { limit: 3, offset: 3, filters: vec![eq_filter("pk", Value::Text("p1".into()))], ..Default::default() }).await.unwrap();
    assert_eq!(filtered.rows.len(), 3);
    assert!(filtered.rows.iter().all(|r| r[0] == Value::Text("p1".into())));
    // Injection attempt in a value is just a value.
    assert_eq!(count(vec![eq_filter("pk", Value::Text("p1' OR '1'='1".into()))]).await, 0);

    // PartiQL
    let q = format!("\"{table}\"");
    let r = exec(&*c, &format!("SELECT * FROM {q} WHERE pk = 'types' AND sk = 0")).await;
    let rs = r[0].result.as_ref().unwrap();
    assert_eq!(cell(rs, 0, "n"), &Value::Decimal(DYN_EXACT.into()));
    let r = exec(&*c, &format!("INSERT INTO {q} VALUE {{'pk': 'pq', 'sk': 1, 'name': 'partiql', 'amount': {DYN_EXACT}}}")).await;
    assert_eq!(r[0].rows_affected, Some(1));
    exec(&*c, &format!("UPDATE {q} SET name = 'changed' WHERE pk = 'pq' AND sk = 1")).await;
    let r = exec(&*c, &format!("SELECT name, amount FROM {q} WHERE pk = 'pq'")).await;
    assert_eq!(first_rows(&r)[0], vec![Value::Decimal(DYN_EXACT.into()), Value::Text("changed".into())]);
    // Two statements in one script, each its own ExecuteStatement.
    let r = exec(&*c, &format!("DELETE FROM {q} WHERE pk = 'pq' AND sk = 1;\nSELECT * FROM {q} WHERE pk = 'pq'")).await;
    assert_eq!(r.len(), 2);
    assert_eq!(r[1].result.as_ref().unwrap().rows.len(), 0);
    let e = c.execute("SELEC * FROM nowhere", &ExecOptions::default(), CancellationToken::new()).await.unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Syntax | ErrorKind::InvalidInput), "{e:?}");
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let e = c.execute(&format!("SELECT * FROM {q}"), &ExecOptions::default(), cancelled).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Cancelled);
    // max_rows bounds the result
    let r = c.execute(&format!("SELECT * FROM {q}"), &ExecOptions { max_rows: 5, timeout_ms: None }, CancellationToken::new()).await.unwrap();
    let rs = r[0].result.as_ref().unwrap();
    assert_eq!(rs.rows.len(), 5);
    assert!(rs.truncated);

    // PartiQL goes through the same SQL classifier as other engines.
    let risk = |s: &str| dbs_safety::classify_script(s, Dialect::Generic)[0].risk;
    assert_eq!(risk(&format!("SELECT * FROM {q}")), dbs_safety::Risk::Read);
    assert_eq!(risk(&format!("UPDATE {q} SET a = 1 WHERE pk = 'x' AND sk = 1")), dbs_safety::Risk::Write);
    assert_eq!(risk(&format!("UPDATE {q} SET a = 1")), dbs_safety::Risk::Destructive);
    assert_eq!(risk(&format!("DELETE FROM {q}")), dbs_safety::Risk::Destructive);
    assert_eq!(risk(&format!("INSERT INTO {q} VALUE {{'pk': 'x', 'sk': 1}}")), dbs_safety::Risk::Write);

    // Grid edits: TransactWriteItems with optimistic-concurrency conditions.
    let key = vec![("pk".to_string(), Value::Text("edit".into())), ("sk".to_string(), Value::Int(1))];
    let rep = c
        .apply_changes(
            &t,
            &[RowChange::Insert {
                values: vec![
                    ("pk".into(), Value::Text("edit".into())),
                    ("sk".into(), Value::Int(1)),
                    ("name".into(), Value::Text("orig".into())),
                    ("price".into(), Value::Decimal("10.50".into())),
                    ("note".into(), Value::Null),
                ],
            }],
        )
        .await
        .unwrap();
    assert!(rep.committed);
    let upd = RowChange::Update {
        key: key.clone(),
        original: vec![("name".into(), Value::Text("orig".into())), ("price".into(), Value::Decimal("10.50".into())), ("note".into(), Value::Null)],
        changes: vec![
            ("name".into(), Value::Text("new".into())),
            ("price".into(), Value::Decimal(DYN_EXACT.into())),
            ("note".into(), Value::Text("hi".into())),
        ],
    };
    assert!(c.preview_changes(&t, std::slice::from_ref(&upd)).unwrap()[0].starts_with("UpdateItem"));
    let rep = c.apply_changes(&t, std::slice::from_ref(&upd)).await.unwrap();
    assert!(rep.committed && rep.rows_affected == 1, "{rep:?}");
    let get = || async {
        c.fetch_table(&t, &PageRequest { limit: 10, filters: vec![eq_filter("pk", Value::Text("edit".into()))], ..Default::default() }).await.unwrap()
    };
    let rs = get().await;
    assert_eq!(cell(&rs, 0, "name"), &Value::Text("new".into()));
    assert_eq!(cell(&rs, 0, "price"), &Value::Decimal(DYN_EXACT.into()));
    // Stale original: zero applied, nothing overwritten.
    let stale = RowChange::Update {
        key: key.clone(),
        original: vec![("name".into(), Value::Text("orig".into()))],
        changes: vec![("name".into(), Value::Text("mine".into()))],
    };
    let rep = c.apply_changes(&t, std::slice::from_ref(&stale)).await.unwrap();
    assert!(!rep.committed);
    assert_eq!(rep.applied, 0);
    assert_eq!(rep.conflicts, vec![0]);
    assert_eq!(cell(&get().await, 0, "name"), &Value::Text("new".into()));
    // Atomic batch: a valid change plus a stale one commits nothing.
    let ok_insert =
        RowChange::Insert { values: vec![("pk".into(), Value::Text("edit".into())), ("sk".into(), Value::Int(2)), ("name".into(), Value::Text("two".into()))] };
    let rep = c.apply_changes(&t, &[ok_insert.clone(), stale.clone()]).await.unwrap();
    assert!(!rep.committed);
    assert_eq!(rep.conflicts, vec![1]);
    assert_eq!(get().await.rows.len(), 1, "insert in the failed batch must not be applied");
    // Inserting over an existing item is a conflict, not an overwrite.
    let dup =
        RowChange::Insert { values: vec![("pk".into(), Value::Text("edit".into())), ("sk".into(), Value::Int(1)), ("name".into(), Value::Text("dup".into()))] };
    assert_eq!(c.apply_changes(&t, &[dup]).await.unwrap().conflicts, vec![0]);
    // Key attributes cannot be edited.
    let bad = RowChange::Update { key: key.clone(), original: vec![], changes: vec![("sk".into(), Value::Int(9))] };
    assert_eq!(c.apply_changes(&t, &[bad]).await.unwrap_err().kind, ErrorKind::InvalidInput);
    // Setting NULL removes the attribute; delete with stale original is a conflict, then succeeds.
    let rep = c
        .apply_changes(
            &t,
            &[RowChange::Update { key: key.clone(), original: vec![("note".into(), Value::Text("hi".into()))], changes: vec![("note".into(), Value::Null)] }],
        )
        .await
        .unwrap();
    assert!(rep.committed);
    let r = exec(&*c, &format!("SELECT * FROM {q} WHERE pk = 'edit' AND sk = 1")).await;
    assert!(!r[0].result.as_ref().unwrap().columns.iter().any(|c| c.name == "note"), "note removed");
    let rep = c.apply_changes(&t, &[RowChange::Delete { key: key.clone(), original: vec![("name".into(), Value::Text("stale".into()))] }]).await.unwrap();
    assert_eq!(rep.conflicts, vec![0]);
    let rep = c.apply_changes(&t, &[RowChange::Delete { key: key.clone(), original: vec![("name".into(), Value::Text("new".into()))] }]).await.unwrap();
    assert!(rep.committed);
    assert_eq!(get().await.rows.len(), 0);

    // Read-only connection: reads work, writes are blocked in the driver.
    let (mut ro_conf, ro_secrets) = dyn_cfg();
    ro_conf.read_only = true;
    let ro = driver_for(Engine::DynamoDb).unwrap().connect(&ro_conf, ro_secrets).await.unwrap();
    exec(&*ro, &format!("SELECT * FROM {q} WHERE pk = 'types'")).await;
    for w in [format!("INSERT INTO {q} VALUE {{'pk': 'ro', 'sk': 1}}"), format!("UPDATE {q} SET a = 1 WHERE pk = 'p1' AND sk = 1"), format!("DELETE FROM {q}")]
    {
        let e = ro.execute(&w, &ExecOptions::default(), CancellationToken::new()).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::PolicyBlocked, "{w}");
    }
    assert_eq!(ro.apply_changes(&t, &[ok_insert]).await.unwrap_err().kind, ErrorKind::PolicyBlocked);
    assert_eq!(c.count_rows(&t, &[]).await.unwrap(), 26);

    // Bad credentials / endpoint / missing secret; secrets never echoed.
    let (mut bad_conf, _) = dyn_cfg();
    bad_conf.username = Some("bad-key!".into());
    let e = driver_for(Engine::DynamoDb).unwrap().connect(&bad_conf, ConnectSecrets { password: Some("topsecretvalue".into()) }).await.err().expect("bad key");
    assert_eq!(e.kind, ErrorKind::Authentication, "{e:?}");
    assert!(!e.message.contains("topsecretvalue"));
    let (no_secret, _) = dyn_cfg();
    let e = driver_for(Engine::DynamoDb).unwrap().connect(&no_secret, ConnectSecrets::default()).await.err().expect("missing secret");
    assert_eq!(e.kind, ErrorKind::Authentication);
    let (mut bad_ep, _) = dyn_cfg();
    bad_ep.host = Some("http://127.0.0.1:1".into());
    bad_ep.connect_timeout_secs = 2;
    let e =
        driver_for(Engine::DynamoDb).unwrap().connect(&bad_ep, ConnectSecrets { password: Some("topsecretvalue".into()) }).await.err().expect("bad endpoint");
    assert!(matches!(e.kind, ErrorKind::Connection | ErrorKind::Timeout), "{e:?}");
    assert!(!e.message.contains("topsecretvalue"));

    client.delete_table().table_name(&table).send().await.unwrap();
}
