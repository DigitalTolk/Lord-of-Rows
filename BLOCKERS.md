# Blockers

| # | Blocker | Impact | What is needed |
|---|---|---|---|
| B1 | Development host has no Rust/Node; all builds run in a Linux Docker container (by choice) | Only Linux builds are produced and tested | A macOS machine/runner with Rust + Node for macOS builds; a Windows runner for Windows builds |
| B2 | No Apple Developer ID / notarization credentials | Cannot sign, notarize or staple macOS builds | Apple Developer account, Developer ID Application certificate, app-specific password or API key |
| B3 | No Windows code-signing certificate | Cannot produce signed MSI/MSIX | EV or OV code-signing certificate (or Azure Trusted Signing) |
| B4 | No accounts for licensed/cloud engines (Oracle, SQL Server licensing, Snowflake, BigQuery, DynamoDB, D1) | Those drivers cannot be verified | Test accounts / containers (SQL Server and Oracle Free have dev containers; cloud services need credentials) |
| B5 | Docker Desktop VM has ~6 GB RAM shared with other projects; daemon crashed several times under load | Long test runs occasionally aborted | Increase Docker memory or stop unrelated stacks during test runs |
| B6 | Native file dialogs (import/export/backup) cannot be driven by WebDriver | Those UI flows have backend tests only | Add a test-only path injection hook, or test manually on each OS |
