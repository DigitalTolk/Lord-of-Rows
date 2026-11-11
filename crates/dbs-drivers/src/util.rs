use std::future::Future;
use std::time::Duration;

use dbs_core::{DbError, DbResult, ErrorKind};
use tokio_util::sync::CancellationToken;

/// Run `fut` racing against cancellation and an optional timeout. On either,
/// `on_abort` is invoked (to send a server-side cancel) and the future is
/// still awaited briefly so the connection is left in a consistent state.
pub async fn guarded<T, F, A, AF>(fut: F, cancel: CancellationToken, timeout_ms: Option<u64>, on_abort: A) -> DbResult<T>
where
    F: Future<Output = DbResult<T>>,
    A: FnOnce() -> AF,
    AF: Future<Output = ()>,
{
    guarded_inner(fut, cancel, timeout_ms, on_abort, true).await
}

/// Like [`guarded`] for engines without server-side cancel (HTTP APIs such as
/// DynamoDB): on cancel/timeout the in-flight future is dropped immediately,
/// which aborts the request.
pub async fn guarded_abort<T, F>(fut: F, cancel: CancellationToken, timeout_ms: Option<u64>) -> DbResult<T>
where
    F: Future<Output = DbResult<T>>,
{
    guarded_inner(fut, cancel, timeout_ms, || async {}, false).await
}

async fn guarded_inner<T, F, A, AF>(fut: F, cancel: CancellationToken, timeout_ms: Option<u64>, on_abort: A, drain: bool) -> DbResult<T>
where
    F: Future<Output = DbResult<T>>,
    A: FnOnce() -> AF,
    AF: Future<Output = ()>,
{
    tokio::pin!(fut);
    let sleep = async {
        match timeout_ms {
            Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(sleep);
    let kind = tokio::select! {
        r = &mut fut => return r,
        _ = cancel.cancelled() => ErrorKind::Cancelled,
        _ = &mut sleep => ErrorKind::Timeout,
    };
    on_abort().await;
    if drain {
        // Let the driver observe the server's cancellation response.
        let _ = tokio::time::timeout(Duration::from_secs(10), &mut fut).await;
    }
    Err(DbError::new(kind, if kind == ErrorKind::Timeout { "query timed out" } else { "query cancelled" }))
}

pub fn excerpt(sql: &str) -> String {
    let mut e: String = sql.chars().take(200).collect();
    if sql.chars().count() > 200 {
        e.push('…');
    }
    e
}

pub fn elapsed_ms(t: std::time::Instant) -> u64 {
    t.elapsed().as_millis() as u64
}
