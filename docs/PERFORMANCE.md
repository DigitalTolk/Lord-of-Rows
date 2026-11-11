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

## Next
- Streaming result batches to the grid (first rows visible before the full set arrives).
- Release-build measurement in CI; macOS manual protocol (Activity Monitor RSS + frame timing).
