//! Streaming query results.
//!
//! A driver writes into a [`RowSink`], which groups rows into batches (a small
//! first batch so the UI can paint quickly, then larger ones) and sends
//! [`StreamEvent`]s over a *bounded* channel. When the consumer is slow the
//! driver waits on the channel instead of buffering, so memory stays bounded by
//! `channel capacity × batch size`. The per-result-set `max_rows` cap is applied
//! here: rows beyond it are dropped and the result is flagged `truncated`.

use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{ColumnMeta, DbError, DbResult, ErrorKind, ResultSet, StatementResult, Value};

/// Rows in the first batch of each result set (sent as soon as it is full).
pub const FIRST_BATCH_ROWS: usize = 500;
/// Rows in later batches.
pub const BATCH_ROWS: usize = 4000;
/// A partial batch is flushed when a row arrives this long after the last flush,
/// so slow queries still show progress.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(200);

/// One message of a streamed execution, in order. Rows use the compact wire form.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    /// A new result set starts. `result_index` counts result sets across the whole
    /// script (one statement, e.g. a MySQL `CALL`, can produce several).
    ResultStart { statement_index: usize, result_index: usize, sql_excerpt: String, columns: Vec<ColumnMeta> },
    /// Rows for result set `result_index`. `seq` numbers row batches across the
    /// whole execution (0, 1, 2, …) for acknowledgement / flow control.
    Rows {
        result_index: usize,
        seq: u64,
        #[serde(serialize_with = "crate::value::compact::serialize_rows")]
        rows: Vec<Vec<Value>>,
    },
    /// A statement (or one of its result sets) finished.
    StatementDone {
        statement_index: usize,
        /// The result set this completes, if the statement returned rows.
        result_index: Option<usize>,
        sql_excerpt: String,
        rows_affected: Option<u64>,
        duration_ms: u64,
        notices: Vec<String>,
        /// Rows delivered for this result set (after the cap).
        row_count: u64,
        /// More rows existed than `max_rows`; they were not delivered.
        truncated: bool,
    },
}

/// What a driver reports when a statement finishes.
#[derive(Debug, Clone, Default)]
pub struct StatementSummary {
    pub statement_index: usize,
    pub sql_excerpt: String,
    pub rows_affected: Option<u64>,
    pub duration_ms: u64,
    pub notices: Vec<String>,
}

struct Current {
    result_index: usize,
    rows: u64,
    truncated: bool,
}

/// Batching, capping writer handed to [`crate::DatabaseConnection::execute_stream`].
pub struct RowSink {
    tx: mpsc::Sender<StreamEvent>,
    cancel: CancellationToken,
    max_rows: usize,
    first_batch: usize,
    batch: usize,
    buf: Vec<Vec<Value>>,
    next_result: usize,
    seq: u64,
    cur: Option<Current>,
    last_flush: Instant,
}

fn closed() -> DbError {
    DbError::new(ErrorKind::Cancelled, "query cancelled")
}

impl RowSink {
    pub fn new(tx: mpsc::Sender<StreamEvent>, cancel: CancellationToken, max_rows: usize) -> Self {
        Self {
            tx,
            cancel,
            max_rows: max_rows.max(1),
            first_batch: FIRST_BATCH_ROWS,
            batch: BATCH_ROWS,
            buf: Vec::new(),
            next_result: 0,
            seq: 0,
            cur: None,
            last_flush: Instant::now(),
        }
    }

    /// Override batch sizes (tests, tuning).
    pub fn with_batch_sizes(mut self, first: usize, rest: usize) -> Self {
        self.first_batch = first.max(1);
        self.batch = rest.max(1);
        self
    }

    pub fn max_rows(&self) -> usize {
        self.max_rows
    }

    /// True once the current result set reached `max_rows`; further rows are
    /// discarded (drivers can skip decoding them).
    pub fn is_full(&self) -> bool {
        self.cur.as_ref().is_some_and(|c| c.rows as usize >= self.max_rows)
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled() || self.tx.is_closed()
    }

    // ---- pure state transitions (return the event to send, if any)

    fn start(&mut self, statement_index: usize, sql_excerpt: String, columns: Vec<ColumnMeta>) -> StreamEvent {
        let result_index = self.next_result;
        self.next_result += 1;
        self.buf.clear();
        self.cur = Some(Current { result_index, rows: 0, truncated: false });
        self.last_flush = Instant::now();
        StreamEvent::ResultStart { statement_index, result_index, sql_excerpt, columns }
    }

    fn take_batch(&mut self) -> Option<StreamEvent> {
        let cur = self.cur.as_ref()?;
        if self.buf.is_empty() {
            return None;
        }
        let ev = StreamEvent::Rows { result_index: cur.result_index, seq: self.seq, rows: std::mem::take(&mut self.buf) };
        self.seq += 1;
        self.last_flush = Instant::now();
        Some(ev)
    }

    fn add(&mut self, row: Vec<Value>) -> Option<StreamEvent> {
        let max = self.max_rows;
        let cur = self.cur.as_mut()?;
        if cur.rows as usize >= max {
            cur.truncated = true;
            return None;
        }
        cur.rows += 1;
        let first = cur.rows as usize <= self.first_batch;
        self.buf.push(row);
        // The first batch is cut exactly at `first_batch` rows; later ones at `batch`.
        let full = self.buf.len() >= if first { self.first_batch } else { self.batch };
        if full || self.last_flush.elapsed() >= FLUSH_INTERVAL || cur.rows as usize == max {
            self.take_batch()
        } else {
            None
        }
    }

    fn done(&mut self, s: StatementSummary) -> (Option<StreamEvent>, StreamEvent) {
        let tail = self.take_batch();
        let cur = self.cur.take();
        let ev = StreamEvent::StatementDone {
            statement_index: s.statement_index,
            result_index: cur.as_ref().map(|c| c.result_index),
            sql_excerpt: s.sql_excerpt,
            rows_affected: s.rows_affected,
            duration_ms: s.duration_ms,
            notices: s.notices,
            row_count: cur.as_ref().map_or(0, |c| c.rows),
            truncated: cur.as_ref().is_some_and(|c| c.truncated),
        };
        (tail, ev)
    }

    // ---- async API (tokio drivers)

    async fn send(&self, ev: StreamEvent) -> DbResult<()> {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(closed()),
            r = self.tx.send(ev) => r.map_err(|_| closed()),
        }
    }

    /// Begin a result set with these columns.
    pub async fn begin_result(&mut self, statement_index: usize, sql_excerpt: String, columns: Vec<ColumnMeta>) -> DbResult<()> {
        let ev = self.start(statement_index, sql_excerpt, columns);
        self.send(ev).await
    }

    /// Add a row to the current result set (dropped and flagged once the cap is reached).
    pub async fn push_row(&mut self, row: Vec<Value>) -> DbResult<()> {
        match self.add(row) {
            Some(ev) => self.send(ev).await,
            None => Ok(()),
        }
    }

    /// Mark the current result set truncated without supplying the extra row.
    pub fn mark_truncated(&mut self) {
        if let Some(c) = self.cur.as_mut() {
            c.truncated = true;
        }
    }

    /// Flush pending rows and report the statement (closing the current result set, if any).
    pub async fn end_statement(&mut self, s: StatementSummary) -> DbResult<()> {
        let (tail, ev) = self.done(s);
        if let Some(t) = tail {
            self.send(t).await?;
        }
        self.send(ev).await
    }

    // ---- blocking API (drivers running on a blocking thread, e.g. SQLite)

    fn send_blocking(&self, ev: StreamEvent) -> DbResult<()> {
        if self.cancel.is_cancelled() {
            return Err(closed());
        }
        // Waits while the channel is full; returns as soon as the receiver is dropped.
        self.tx.blocking_send(ev).map_err(|_| closed())
    }

    pub fn begin_result_blocking(&mut self, statement_index: usize, sql_excerpt: String, columns: Vec<ColumnMeta>) -> DbResult<()> {
        let ev = self.start(statement_index, sql_excerpt, columns);
        self.send_blocking(ev)
    }

    pub fn push_row_blocking(&mut self, row: Vec<Value>) -> DbResult<()> {
        match self.add(row) {
            Some(ev) => self.send_blocking(ev),
            None => Ok(()),
        }
    }

    pub fn end_statement_blocking(&mut self, s: StatementSummary) -> DbResult<()> {
        let (tail, ev) = self.done(s);
        if let Some(t) = tail {
            self.send_blocking(t)?;
        }
        self.send_blocking(ev)
    }

    /// Replay already-materialised results (engines without native streaming).
    pub async fn replay(&mut self, results: Vec<StatementResult>) -> DbResult<()> {
        for r in results {
            if let Some(rs) = r.result {
                self.begin_result(r.statement_index, r.sql_excerpt.clone(), rs.columns).await?;
                for row in rs.rows {
                    self.push_row(row).await?;
                }
                if rs.truncated {
                    self.mark_truncated();
                }
            }
            self.end_statement(StatementSummary {
                statement_index: r.statement_index,
                sql_excerpt: r.sql_excerpt,
                rows_affected: r.rows_affected,
                duration_ms: r.duration_ms,
                notices: r.notices,
            })
            .await?;
        }
        Ok(())
    }
}

/// Rebuild materialised results from a sequence of events (tests, and callers
/// that want the streaming path but a single value at the end).
pub fn collect_events(events: impl IntoIterator<Item = StreamEvent>) -> Vec<StatementResult> {
    let mut out: Vec<StatementResult> = Vec::new();
    let mut open: Vec<(usize, ResultSet, usize, String)> = Vec::new(); // (result_index, rs, statement_index, excerpt)
    for ev in events {
        match ev {
            StreamEvent::ResultStart { statement_index, result_index, sql_excerpt, columns } => {
                open.push((result_index, ResultSet { columns, rows: vec![], truncated: false }, statement_index, sql_excerpt));
            }
            StreamEvent::Rows { result_index, rows, .. } => {
                if let Some(o) = open.iter_mut().find(|o| o.0 == result_index) {
                    o.1.rows.extend(rows);
                }
            }
            StreamEvent::StatementDone { statement_index, result_index, sql_excerpt, rows_affected, duration_ms, notices, truncated, .. } => {
                let result = result_index.and_then(|ri| open.iter().position(|o| o.0 == ri)).map(|p| {
                    let mut rs = open.remove(p).1;
                    rs.truncated = truncated;
                    rs
                });
                out.push(StatementResult { statement_index, sql_excerpt, result, rows_affected, duration_ms, notices });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(n: &str) -> ColumnMeta {
        ColumnMeta { name: n.into(), type_name: "int".into(), nullable: None, table: None }
    }

    async fn drain(mut rx: mpsc::Receiver<StreamEvent>) -> Vec<StreamEvent> {
        let mut v = vec![];
        while let Some(e) = rx.recv().await {
            v.push(e);
        }
        v
    }

    #[tokio::test]
    async fn batches_first_small_then_large_and_caps() {
        let (tx, rx) = mpsc::channel(4);
        let h = tokio::spawn(drain(rx));
        let mut s = RowSink::new(tx, CancellationToken::new(), 25).with_batch_sizes(3, 10);
        s.begin_result(0, "select".into(), vec![col("a")]).await.unwrap();
        for i in 0..40 {
            s.push_row(vec![Value::Int(i)]).await.unwrap();
        }
        assert!(s.is_full());
        s.end_statement(StatementSummary { statement_index: 0, sql_excerpt: "select".into(), ..Default::default() }).await.unwrap();
        drop(s);
        let evs = h.await.unwrap();
        let sizes: Vec<usize> = evs
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Rows { rows, .. } => Some(rows.len()),
                _ => None,
            })
            .collect();
        assert_eq!(sizes, vec![3, 10, 10, 2]);
        let seqs: Vec<u64> = evs.iter().filter_map(|e| if let StreamEvent::Rows { seq, .. } = e { Some(*seq) } else { None }).collect();
        assert_eq!(seqs, vec![0, 1, 2, 3]);
        match evs.last().unwrap() {
            StreamEvent::StatementDone { row_count, truncated, result_index, .. } => {
                assert_eq!(*row_count, 25);
                assert!(*truncated);
                assert_eq!(*result_index, Some(0));
            }
            e => panic!("{e:?}"),
        }
        let r = collect_events(evs);
        assert_eq!(r.len(), 1);
        let rs = r[0].result.as_ref().unwrap();
        assert_eq!(rs.rows.len(), 25);
        assert!(rs.truncated);
        assert_eq!(rs.rows[24], vec![Value::Int(24)]);
    }

    #[tokio::test]
    async fn exactly_max_rows_is_not_truncated() {
        let (tx, rx) = mpsc::channel(4);
        let h = tokio::spawn(drain(rx));
        let mut s = RowSink::new(tx, CancellationToken::new(), 5).with_batch_sizes(2, 2);
        s.begin_result(0, "q".into(), vec![col("a")]).await.unwrap();
        for i in 0..5 {
            s.push_row(vec![Value::Int(i)]).await.unwrap();
        }
        s.end_statement(StatementSummary::default()).await.unwrap();
        drop(s);
        let r = collect_events(h.await.unwrap());
        assert_eq!(r[0].result.as_ref().unwrap().rows.len(), 5);
        assert!(!r[0].result.as_ref().unwrap().truncated);
    }

    #[tokio::test]
    async fn statement_without_rows_and_multiple_results() {
        let (tx, rx) = mpsc::channel(16);
        let mut s = RowSink::new(tx, CancellationToken::new(), 100);
        s.end_statement(StatementSummary { statement_index: 0, sql_excerpt: "insert".into(), rows_affected: Some(3), ..Default::default() }).await.unwrap();
        s.begin_result(1, "call".into(), vec![col("a")]).await.unwrap();
        s.push_row(vec![Value::Int(1)]).await.unwrap();
        s.end_statement(StatementSummary { statement_index: 1, sql_excerpt: "call".into(), ..Default::default() }).await.unwrap();
        s.begin_result(1, "call".into(), vec![col("b")]).await.unwrap();
        s.end_statement(StatementSummary { statement_index: 1, sql_excerpt: "call".into(), ..Default::default() }).await.unwrap();
        drop(s);
        let r = collect_events(drain(rx).await);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].rows_affected, Some(3));
        assert!(r[0].result.is_none());
        assert_eq!(r[1].result.as_ref().unwrap().rows.len(), 1);
        assert_eq!(r[2].result.as_ref().unwrap().columns[0].name, "b");
        assert!(r[2].result.as_ref().unwrap().rows.is_empty());
    }

    #[tokio::test]
    async fn bounded_channel_applies_backpressure_and_cancel_unblocks() {
        let (tx, mut rx) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        let mut s = RowSink::new(tx, cancel.clone(), 1_000_000).with_batch_sizes(1, 1);
        s.begin_result(0, "q".into(), vec![col("a")]).await.unwrap(); // fills the channel
                                                                      // Nobody reads: the next send must wait, not buffer.
        let blocked = tokio::time::timeout(Duration::from_millis(50), s.push_row(vec![Value::Int(1)])).await;
        assert!(blocked.is_err(), "send should wait while the channel is full");
        cancel.cancel();
        let e = s.push_row(vec![Value::Int(2)]).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Cancelled);
        assert!(matches!(rx.recv().await, Some(StreamEvent::ResultStart { .. })));
    }

    #[tokio::test]
    async fn dropped_receiver_stops_blocking_sender() {
        let (tx, rx) = mpsc::channel(1);
        let mut s = RowSink::new(tx, CancellationToken::new(), 100).with_batch_sizes(1, 1);
        let h = std::thread::spawn(move || {
            s.begin_result_blocking(0, "q".into(), vec![col("a")]).unwrap();
            let mut err = None;
            for i in 0..1000 {
                if let Err(e) = s.push_row_blocking(vec![Value::Int(i)]) {
                    err = Some(e);
                    break;
                }
            }
            err
        });
        std::thread::sleep(Duration::from_millis(30));
        drop(rx);
        let e = h.join().unwrap().expect("sender must observe the closed channel");
        assert_eq!(e.kind, ErrorKind::Cancelled);
    }

    #[test]
    fn rows_event_uses_compact_form() {
        let ev = StreamEvent::Rows { result_index: 0, seq: 7, rows: vec![vec![Value::Int(1), Value::Null, Value::Text("x".into())]] };
        let j = serde_json::to_value(&ev).unwrap();
        assert_eq!(j, serde_json::json!({"type": "rows", "result_index": 0, "seq": 7, "rows": [[1, null, "x"]]}));
    }
}
