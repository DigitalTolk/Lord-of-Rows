# AI assistant (optional)

The AI assistant explains SQL, writes SQL from a description, suggests optimizations and indexes, explains
errors and execution plans, and summarizes selected tables. It is **off by default** (`ai.enabled = false`)
and does nothing until the user turns it on in **Settings → AI assistant**.

## Privacy model

| Rule | How it is enforced |
|---|---|
| Disabled by default | `AiSettings` defaults to disabled; `ai_preview`, `ai_send` and `ai_test` refuse while `ai.enabled` is not exactly `true` (`dbs-ai` UT `disabled_by_default_and_refuses`). The toolbar button and panel are not rendered while it is off. |
| No automatic context | The default prompt contains only the text in the panel's input box (editor selection/SQL, the error, the plan or the request). The database type, the failed SQL and table column definitions are added only when their checkbox is ticked. Table **data**, column defaults, comments, index predicates and connection settings are never included (UT `default_context_is_only_the_input`, `includes_only_approved_tables_and_dialect`). |
| Visible preview + explicit approval | `ai_preview` (Rust) builds and redacts the prompt and returns its exact text, byte size, model and endpoint. Nothing is sent until the user presses **Send**. Editing anything discards the preview (vitest `AiPanel`). |
| Only previewed text can be sent | The preview carries a token = SHA-256(per-run random key, provider, model, base URL, task, system prompt, user prompt). `ai_send` re-checks the token against the text it receives and the *current* settings; different text or changed settings are refused (UT `guard_binds_prompt_task_and_endpoint`). Same design as the SQL `ConfirmationGuard`. |
| Secret redaction | Always: `password=` / `pwd=` / `secret=` / `token=` values and URL userinfo (`dbs_core::redact_secrets`), `PASSWORD '…'` / `IDENTIFIED BY '…'` literals. With **Redact literal values** (default on): SQL string/number literals become `?` (`dbs_audit::redact_literals`); quoted values and `Key (col)=(value)` details in errors and plans become `?` (numbers kept so plan costs stay meaningful). Natural-language requests only get secret redaction. |
| AI SQL is never executed | Answers are shown as plain text (never HTML). Extracted SQL can only be inserted into the editor; running it is the normal Run path with the normal safety policy and confirmations. There is no IPC path from an AI answer to the database. |
| API keys | Stored in the OS keychain (`SecretKind::AiApiKey`, one fixed owner UUID per provider so one vendor's key is never sent to another). The webview can save or delete a key and learn whether one exists, never read it. Changing the OpenAI-compatible base URL deletes that key. Keys go only in the auth header (`x-api-key` / `Authorization: Bearer`), never the body (mock-server UTs). |
| Transport | Requests are made in Rust (`reqwest`, native TLS, 10 s connect / 180 s total timeout, redirects never followed). `https://` is required except for `localhost`/loopback (e.g. Ollama). The Anthropic endpoint is fixed to `https://api.anthropic.com`. The webview CSP is unchanged: the renderer still cannot reach the network. |
| Audit | Each send (and connection test) writes an `ai_request` audit event with provider, model, task, byte count, duration and outcome — never prompt or answer text. Enabling/disabling the assistant and toggling literal redaction are logged as `security_policy_changed`; key changes as `credential_changed`/`credential_deleted`. |

## Providers

- **Anthropic** (default): Messages API, `anthropic-version: 2026-10-21`, default model `claude-opus-5-5`.
  For current Claude models the request opts into server-side refusal fallbacks (`fallbacks: "default"`).
  A refusal is shown as a clear error.
- **OpenAI-compatible**: `POST {base}/chat/completions` — OpenAI, Azure-style gateways, Ollama
  (`http://localhost:11434/v1`, no key needed), LM Studio, vLLM. Model name is free text.

## Residual risks

- Whatever the user approves is sent to a third party (or a local server) and is subject to that provider's
  retention policy. Identifiers (table/column names) are not redacted.
- Redaction is heuristic: secrets in unusual forms (e.g. inside comments without `password=`) can survive.
  The preview is the final control — the user sees every byte.
- A compromised webview could request a preview and send it (the token prevents *mismatched* text, not a
  malicious renderer). It still cannot read the API key, choose a non-HTTPS remote endpoint, or run SQL.
