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
        tls: TlsConfig { mode: TlsMode::Disable, ..Default::default() },
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
    let f = vec![FilterCondition { column: "name".into(), op: FilterOp::StartsWith, value: Some(Value::Text("ali".into())), values: vec![] }];
    assert_eq!(c.count_rows(&t, &f).await.unwrap(), 1);
    let f2 = vec![FilterCondition { column: "name".into(), op: FilterOp::IsNull, value: None, values: vec![] }];
    assert_eq!(c.count_rows(&t, &f2).await.unwrap(), 1);
    // LIKE wildcards in user input are literal.
    let f3 = vec![FilterCondition { column: "name".into(), op: FilterOp::Contains, value: Some(Value::Text("%".into())), values: vec![] }];
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

    // TLS required against a server without TLS → Tls error, never silent plaintext.
    let mut tls = cfg(Engine::Postgres, Some(&host), Some("dbs_test"));
    tls.tls.mode = TlsMode::VerifyFull;
    // Server cert is signed by the test CA, which is not in the system trust store: must be rejected.
    let e = driver_for(Engine::Postgres).unwrap().connect(&tls, pw()).await.err().expect("untrusted cert must be rejected");
    assert!(matches!(e.kind, ErrorKind::Tls | ErrorKind::Connection), "{e:?}");
    // With the CA configured, verified TLS (certificate + hostname) succeeds.
    if std::path::Path::new("/certs/ca.crt").exists() {
        tls.tls.ca_cert_path = Some("/certs/ca.crt".into());
        let c2 = driver_for(Engine::Postgres).unwrap().connect(&tls, pw()).await.expect("verified TLS connect");
        let r = exec(&*c2, "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()").await;
        assert_eq!(first_rows(&r)[0][0], Value::Bool(true), "session must be encrypted");
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

#[tokio::test]
async fn redis_end_to_end() {
    if !it_enabled() {
        return;
    }
    let host = std::env::var("DBS_IT_REDIS_HOST").unwrap_or("localhost".into());
    let mut conf = cfg(Engine::Redis, Some(&host), Some("0"));
    conf.username = None;
    let c = driver_for(Engine::Redis).unwrap().connect(&conf, ConnectSecrets::default()).await.unwrap();
    assert!(!c.server_info().await.unwrap().version.is_empty());
    exec(&*c, "DEL it:list it:str\nRPUSH it:list a b c\nSET it:str \"hello world\"").await;
    let r = exec(&*c, "GET it:str").await;
    assert_eq!(first_rows(&r)[0][0], Value::Text("hello world".into()));
    let keys = c.list_objects(Some("it:*")).await.unwrap();
    assert_eq!(keys.len(), 2);
    let rs = c.fetch_table(&TableTarget { schema: None, table: "it:list".into() }, &PageRequest { limit: 10, ..Default::default() }).await.unwrap();
    assert_eq!(rs.rows.len(), 3);
    assert_eq!(c.count_rows(&TableTarget { schema: None, table: "it:list".into() }, &[]).await.unwrap(), 3);

    conf.read_only = true;
    let ro = driver_for(Engine::Redis).unwrap().connect(&conf, ConnectSecrets::default()).await.unwrap();
    let e = ro.execute("SET it:str x", &ExecOptions::default(), CancellationToken::new()).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::PolicyBlocked);
    exec(&*c, "DEL it:list it:str").await;
}
