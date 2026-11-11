# Performance

Measured by `e2e/tests/30-perf.test.mjs` (WebDriver against the real app). Results are written to
`e2e/artifacts/perf.json` on every run.

## Reference environment (current numbers)
Linux arm64 in Docker Desktop (4 vCPU, 6 GB, shared with other workloads), Xvfb with **software rendering**
(no GPU), **debug build**. Native macOS release builds are expected to be substantially faster; they cannot be
measured with WebDriver (no WKWebView driver), so macOS numbers are pending a manual protocol.

| Metric | Budget (spec) | Result | Status |
|---|---|---|---|
| Cold start to launcher | < 2 s where feasible | 1.7 s (incl. WebDriver session setup) | ✔ |
| Connect + load object tree (Postgres) | — | 1.0 s | ✔ |
| 100,000-row query → visible grid | responsive | 3.4 s (was 11.0 s before the compact wire format) | ✔ (improving) |
| DOM rows rendered for 100k results | virtualized | 37 | ✔ |
| Scroll through 100k rows | smooth | 22 fps avg, worst frame 65 ms (software rendering) | ⚠ measure on GPU |
| UI responsiveness during a 5 s query | no freeze | max 17 ms round-trip | ✔ |
| Results held in memory | bounded | capped by `query.maxRows` (default 10,000); rows beyond are drained, not stored | ✔ |

## Optimisations done
- Compact result encoding: plain JSON scalars per cell, exact types rebuilt from column metadata
  (100k rows: 17.6 MB → 8.3 MB on the wire).
- Virtualized grid (only visible rows in the DOM), PK-ordered server-side paging for tables.
- Long queries run off the UI thread; cancellation reaches the server (pg cancel / KILL QUERY / sqlite interrupt).

## Streaming results (SQL editor)
The SQL editor runs queries through `run_sql_stream`: rows are sent to the webview in batches (first
batch 500 rows, then 4,000) over a Tauri Channel, in the compact format. Each batch is acknowledged and
the backend allows at most 4 unacknowledged batches, with a bounded driver→IPC channel, so a slow
webview makes the backend stop reading from the database instead of buffering.

Backend-only measurement, **SQLite, 100,000 rows × 4 columns** (`id`, 32-char hex text, numeric,
timestamp), native **release** build on an Apple M2 laptop shared with other builds. Run with
`cargo test -p dbs-drivers --release --test streaming -- --ignored --nocapture sqlite_stream_perf`.
Numbers include JSON serialisation; they do not include IPC delivery or rendering.

| | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| Materialised (`execute` + serialise one payload) | 137.8 ms, 7.22 MB in one message | 212.2 ms | 196.4 ms |
| Streamed: first row batch ready | 0.78 ms | 1.82 ms | 35.6 ms |
| Streamed: complete | 149.8 ms | 229.5 ms | 221.3 ms |
| Streamed: messages | 26 batches, largest 0.29 MB, 7.22 MB total | same | same |

The third run's first batch took longer because the machine was loaded at the time; the numbers are shown as measured.
Streaming adds ~5–10 % to total backend time here, and the largest single IPC message drops from 7.2 MB to 0.29 MB.
Postgres/MySQL streaming and the end-to-end time to first rows in the app (`query100kFirstRowsMs` in
`e2e/tests/30-perf.test.mjs`) have **not been measured yet**.

## Next
- Release-build measurement in CI; macOS manual protocol (Activity Monitor RSS + frame timing).
