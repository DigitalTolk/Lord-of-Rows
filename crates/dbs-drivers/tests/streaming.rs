//! Streaming execution (`execute_stream`) against real engines.
//! SQLite always runs; Postgres / MySQL / MariaDB run inside docker compose
//! (`DBS_IT` set, hosts from `DBS_IT_*_HOST`), like `integration.rs`:
//! `docker compose run --rm dev cargo test -p dbs-drivers --test streaming`

use std::time::{Duration, Instant};

use dbs_core::*;
use dbs_drivers::driver_for;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn it_host(var: &str) -> Option<String> {
    if std::env::var("DBS_IT").is_err() {
        eprintln!("SKIPPED: DBS_IT not set (run inside docker compose)");
        return None;
    }
    Some(std::env::var(var).unwrap_or("localhost".into()))
}

fn cfg(engine: Engine, host: Option<&str>, db: Option<&str>) -> ConnectionConfig {
    ConnectionConfig {
        id: Uuid::new_v4(),
        name: format!("stream-{engine:?}"),
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
        tunnel: None,
    }
}

async fn connect(c: &ConnectionConfig) -> Box<dyn DatabaseConnection> {
    driver_for(c.engine).expect("driver").connect(c, ConnectSecrets { password: Some("dbs_test".into()) }).await.expect("connect")
}

/// Run `execute_stream` with a reader that collects every event.
async fn stream_all(c: &dyn DatabaseConnection, sql: &str, max_rows: usize) -> (DbResult<()>, Vec<StreamEvent>) {
    let (tx, mut rx) = mpsc::channel(2);
    let sink = RowSink::new(tx, CancellationToken::new(), max_rows);
    let reader = async {
        let mut v = Vec::new();
        while let Some(e) = rx.recv().await {
            v.push(e);
        }
        v
    };
    let opts = ExecOptions { max_rows, timeout_ms: None };
    tokio::join!(c.execute_stream(sql, &opts, CancellationToken::new(), sink), reader)
}

fn batch_sizes(evs: &[StreamEvent]) -> Vec<usize> {
    evs.iter()
        .filter_map(|e| match e {
            StreamEvent::Rows { rows, .. } => Some(rows.len()),
            _ => None,
        })
        .collect()
}

/// Shared scenario. `big` must return `n` rows with an integer first column 1..=n in order.
async fn scenario(c: &dyn DatabaseConnection, big: &dyn Fn(u64) -> String) {
    // 1. Streamed results equal the materialised path, across a multi-statement script.
    let script = format!("{}; SELECT 1 AS a, 'x' AS b; {}", big(1200), big(3));
    let (r, evs) = stream_all(c, &script, 10_000).await;
    r.expect("stream ok");
    let streamed = collect_events(evs.clone());
    let materialised = c.execute(&script, &ExecOptions::default(), CancellationToken::new()).await.expect("execute");
    assert_eq!(streamed.len(), materialised.len());
    for (s, m) in streamed.iter().zip(&materialised) {
        assert_eq!(s.statement_index, m.statement_index);
        assert_eq!(s.result.as_ref().map(|r| (&r.columns, &r.rows, r.truncated)), m.result.as_ref().map(|r| (&r.columns, &r.rows, r.truncated)));
    }
    // Ordering: statement 0's result set is complete before statement 1 starts.
    let order: Vec<(usize, &str)> = evs
        .iter()
        .filter_map(|e| match e {
            StreamEvent::ResultStart { statement_index, .. } => Some((*statement_index, "start")),
            StreamEvent::StatementDone { statement_index, .. } => Some((*statement_index, "done")),
            _ => None,
        })
        .collect();
    assert_eq!(order, vec![(0, "start"), (0, "done"), (1, "start"), (1, "done"), (2, "start"), (2, "done")]);
    // First batch is small so the grid can paint early.
    let sizes = batch_sizes(&evs);
    assert_eq!(sizes[0], FIRST_BATCH_ROWS, "{sizes:?}");
    assert_eq!(sizes.iter().sum::<usize>(), 1200 + 1 + 3);

    // 2. Cap: truncated flag, exactly max_rows delivered, connection stays usable.
    let (r, evs) = stream_all(c, &big(2500), 1000).await;
    r.expect("capped stream ok");
    let res = collect_events(evs.clone());
    let rs = res[0].result.as_ref().unwrap();
    assert_eq!(rs.rows.len(), 1000);
    assert!(rs.truncated);
    assert!(matches!(evs.last(), Some(StreamEvent::StatementDone { row_count: 1000, truncated: true, .. })));
    // Exactly at the cap is not truncated.
    let (_, evs) = stream_all(c, &big(1000), 1000).await;
    assert!(!collect_events(evs)[0].result.as_ref().unwrap().truncated);

    // 3. Errors: the earlier statements' events are delivered, then the error.
    let (r, evs) = stream_all(c, "SELECT 1 AS ok; SELECT * FROM no_such_table_xyz", 100).await;
    let e = r.expect_err("second statement fails");
    assert!(e.message.contains("statement 2"), "{e:?}");
    assert_eq!(collect_events(evs).len(), 1);

    // 4. Cancellation with a stalled reader: stops promptly, releases the connection.
    let token = CancellationToken::new();
    let (tx, mut rx) = mpsc::channel(1);
    let sink = RowSink::new(tx, token.clone(), 1_000_000);
    let t2 = token.clone();
    let reader = async move {
        let mut rows = 0usize;
        while let Some(e) = rx.recv().await {
            if let StreamEvent::Rows { rows: r, .. } = e {
                rows += r.len();
                // Got the first batch: stop reading for a while, then cancel.
                tokio::time::sleep(Duration::from_millis(200)).await;
                t2.cancel();
                break;
            }
        }
        // Keep the receiver alive briefly so cancellation (not a closed channel) is what stops it.
        tokio::time::sleep(Duration::from_millis(100)).await;
        rows
    };
    let started = Instant::now();
    let (sql, opts) = (big(200_000), ExecOptions::default());
    let (r, rows) = tokio::join!(c.execute_stream(&sql, &opts, token, sink), reader);
    assert_eq!(r.expect_err("cancelled").kind, ErrorKind::Cancelled);
    assert!(rows >= FIRST_BATCH_ROWS);
    assert!(started.elapsed() < Duration::from_secs(10), "cancel took {:?}", started.elapsed());
    c.ping().await.expect("usable after cancel");
    let (r, evs) = stream_all(c, &big(5), 100).await;
    r.expect("query after cancel");
    assert_eq!(collect_events(evs)[0].result.as_ref().unwrap().rows.len(), 5, "connection is back in sync");

    // 5. A result set's completion names it.
    let (r, evs) = stream_all(c, "SELECT 1", 10).await;
    r.unwrap();
    assert!(matches!(evs.last(), Some(StreamEvent::StatementDone { result_index: Some(0), .. })));
}

#[tokio::test]
async fn sqlite_streaming() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.db");
    rusqlite::Connection::open(&path).unwrap().execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)").unwrap();
    let c = connect(&cfg(Engine::Sqlite, None, Some(path.to_str().unwrap()))).await;
    scenario(&*c, &|n| format!("WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < {n}) SELECT n, 'row ' || n AS label FROM s")).await;

    let (r, evs) = stream_all(&*c, "INSERT INTO t (name) VALUES ('a'), ('b'); SELECT count(*) FROM t", 10).await;
    r.unwrap();
    let res = collect_events(evs);
    assert_eq!(res[0].rows_affected, Some(2));
    assert_eq!(res[1].result.as_ref().unwrap().rows[0][0], Value::Int(2));
}

#[tokio::test]
async fn sqlite_stream_respects_read_only() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ro.db");
    rusqlite::Connection::open(&path).unwrap().execute_batch("CREATE TABLE t (id INTEGER)").unwrap();
    let mut conf = cfg(Engine::Sqlite, None, Some(path.to_str().unwrap()));
    conf.read_only = true;
    let c = connect(&conf).await;
    let (r, _) = stream_all(&*c, "INSERT INTO t VALUES (1)", 10).await;
    assert!(r.is_err(), "read-only session must reject writes on the streaming path too");
}

fn pg_big(n: u64) -> String {
    format!("SELECT g AS n, md5(g::text) AS label FROM generate_series(1, {n}) g ORDER BY g")
}

fn mysql_big(n: u64) -> String {
    // Portable (MySQL + MariaDB) row generator: 10^6 combinations of digits.
    let d = "(SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
    format!(
        "SELECT x.n, MD5(x.n) AS label FROM (SELECT a.d + 10*b.d + 100*c.d + 1000*e.d + 10000*f.d + 100000*g.d + 1 AS n FROM {d} a, {d} b, {d} c, {d} e, {d} f, {d} g) x WHERE x.n <= {n} ORDER BY x.n"
    )
}

#[tokio::test]
async fn postgres_streaming() {
    let Some(host) = it_host("DBS_IT_PG_HOST") else { return };
    let mut conf = cfg(Engine::Postgres, Some(&host), Some("dbs_test"));
    conf.port = std::env::var("DBS_IT_PG_PORT").ok().and_then(|p| p.parse().ok());
    let c = connect(&conf).await;
    scenario(&*c, &pg_big).await;
    // Notices arrive with the statement that raised them.
    let (r, evs) = stream_all(&*c, "DO $$ BEGIN RAISE NOTICE 'hello from stream'; END $$", 10).await;
    r.unwrap();
    assert!(collect_events(evs)[0].notices.iter().any(|n| n.contains("hello from stream")));
}

#[tokio::test]
async fn mysql_streaming() {
    let Some(host) = it_host("DBS_IT_MYSQL_HOST") else { return };
    let mut conf = cfg(Engine::MySql, Some(&host), Some("dbs_test"));
    conf.port = std::env::var("DBS_IT_MYSQL_PORT").ok().and_then(|p| p.parse().ok());
    let c = connect(&conf).await;
    scenario(&*c, &mysql_big).await;
}

#[tokio::test]
async fn mariadb_streaming() {
    let Some(host) = it_host("DBS_IT_MARIADB_HOST") else { return };
    let mut conf = cfg(Engine::MariaDb, Some(&host), Some("dbs_test"));
    conf.port = std::env::var("DBS_IT_MARIADB_PORT").ok().and_then(|p| p.parse().ok());
    let c = connect(&conf).await;
    scenario(&*c, &mysql_big).await;
}

/// Manual measurement for docs/PERFORMANCE.md (not a pass/fail test):
/// `cargo test -p dbs-drivers --release --test streaming -- --ignored --nocapture sqlite_stream_perf`
#[tokio::test]
#[ignore]
async fn sqlite_stream_perf() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.db");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE p (id INTEGER PRIMARY KEY, hash TEXT, amount NUMERIC, ts TIMESTAMP);
             WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 100000)
             INSERT INTO p SELECT n, hex(randomblob(16)), n * 1.5, datetime(1700000000 - n, 'unixepoch') FROM s;",
        )
        .unwrap();
    let c = connect(&cfg(Engine::Sqlite, None, Some(path.to_str().unwrap()))).await;
    let sql = "SELECT id, hash, amount, ts FROM p";
    let opts = ExecOptions { max_rows: 200_000, timeout_ms: None };
    for round in 0..3 {
        // Materialised: execute + serialise the whole payload (what run_sql returns).
        let t = Instant::now();
        let r = c.execute(sql, &opts, CancellationToken::new()).await.unwrap();
        let bytes = serde_json::to_vec(&r).unwrap().len();
        let full_ms = t.elapsed().as_secs_f64() * 1e3;

        // Streaming: time until the first serialised row batch, and until the end.
        let (tx, mut rx) = mpsc::channel(2);
        let sink = RowSink::new(tx, CancellationToken::new(), opts.max_rows);
        let t = Instant::now();
        let reader = async {
            let mut first = None;
            let (mut total, mut largest, mut batches) = (0usize, 0usize, 0usize);
            while let Some(e) = rx.recv().await {
                let n = serde_json::to_vec(&e).unwrap().len();
                total += n;
                largest = largest.max(n);
                if matches!(e, StreamEvent::Rows { .. }) {
                    batches += 1;
                    first.get_or_insert(t.elapsed().as_secs_f64() * 1e3);
                }
            }
            (first.unwrap(), total, largest, batches)
        };
        let (res, (first_ms, total, largest, batches)) = tokio::join!(c.execute_stream(sql, &opts, CancellationToken::new(), sink), reader);
        res.unwrap();
        let stream_ms = t.elapsed().as_secs_f64() * 1e3;
        println!(
            "round {round}: materialised {full_ms:.1} ms, one {:.2} MB payload | streamed: first batch {first_ms:.2} ms, complete {stream_ms:.1} ms, {batches} batches, largest message {:.2} MB, total {:.2} MB",
            bytes as f64 / 1e6,
            largest as f64 / 1e6,
            total as f64 / 1e6
        );
    }
}
