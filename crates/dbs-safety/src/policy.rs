use dbs_core::{Dialect, EnvironmentKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::classify::{classify_script, Classified, Flag, Risk};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafetyPolicy {
    pub name: String,
    /// Block everything above `Risk::Read` (plus read-only bypass attempts).
    pub read_only: bool,
    /// Statements at or above this risk require confirmation. `None` = never.
    pub confirm_at: Option<Risk>,
    /// Statements at or above this risk are refused outright. `None` = never.
    pub block_at: Option<Risk>,
    /// Destructive statements require the user to type the connection name.
    pub typed_confirmation_for_destructive: bool,
}

impl SafetyPolicy {
    pub fn for_environment(env: EnvironmentKind) -> Self {
        match env {
            EnvironmentKind::Local | EnvironmentKind::Development | EnvironmentKind::Custom => SafetyPolicy {
                name: "development".into(),
                read_only: false,
                confirm_at: Some(Risk::Destructive),
                block_at: None,
                typed_confirmation_for_destructive: false,
            },
            EnvironmentKind::Testing | EnvironmentKind::Staging => SafetyPolicy {
                name: "staging".into(),
                read_only: false,
                confirm_at: Some(Risk::Schema),
                block_at: None,
                typed_confirmation_for_destructive: false,
            },
            EnvironmentKind::Production => SafetyPolicy {
                name: "production".into(),
                read_only: false,
                confirm_at: Some(Risk::Write),
                block_at: None,
                typed_confirmation_for_destructive: true,
            },
        }
    }

    pub fn read_only() -> Self {
        SafetyPolicy { name: "read-only".into(), read_only: true, confirm_at: None, block_at: Some(Risk::Write), typed_confirmation_for_destructive: false }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub statement: usize,
    pub risk: Risk,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Confirm {
        findings: Vec<Finding>,
        /// Present the user must type this text (connection name) to proceed.
        typed_phrase: Option<String>,
        /// Opaque token bound to (connection, exact SQL). Resubmit to proceed.
        token: String,
    },
    Block {
        findings: Vec<Finding>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evaluation {
    pub statements: Vec<Classified>,
    pub decision: Decision,
}

/// Issues and verifies confirmation tokens. The key is random per app launch,
/// kept only in backend memory, so the frontend cannot forge a token for SQL the
/// user did not see.
pub struct ConfirmationGuard {
    key: [u8; 32],
}

impl ConfirmationGuard {
    pub fn new(key: [u8; 32]) -> Self {
        Self { key }
    }

    pub fn token(&self, connection_id: &str, sql: &str) -> String {
        let mut h = Sha256::new();
        h.update(self.key);
        h.update((connection_id.len() as u64).to_le_bytes());
        h.update(connection_id.as_bytes());
        h.update((sql.len() as u64).to_le_bytes());
        h.update(sql.as_bytes());
        hex::encode(h.finalize())
    }

    pub fn verify(&self, connection_id: &str, sql: &str, token: &str) -> bool {
        let expected = self.token(connection_id, sql);
        constant_time_eq(expected.as_bytes(), token.as_bytes())
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn describe(c: &Classified) -> String {
    let mut parts = vec![format!("{} ({:?})", if c.verb.is_empty() { "statement" } else { &c.verb }, c.risk)];
    for f in &c.flags {
        parts.push(
            match f {
                Flag::NoWhereClause => "affects every row (no WHERE clause)",
                Flag::TautologicalWhere => "WHERE clause is always true",
                Flag::WritableCte => "contains a data-modifying CTE",
                Flag::SelectInto => "SELECT INTO creates or writes data",
                Flag::ExplainAnalyzeExecutes => "EXPLAIN ANALYZE executes the statement",
                Flag::MayLockTable => "may lock the table",
                Flag::MayRewriteTable => "may rewrite the whole table",
                Flag::SideEffectFunction => "calls a function with side effects",
                Flag::DisablesReadOnly => "may change session role or read-only mode",
                Flag::FileOrProgramAccess => "accesses server files or programs",
                Flag::DynamicSql => "runs dynamic SQL or procedural code that cannot be inspected",
                Flag::PrivilegeChange => "changes privileges or roles",
            }
            .to_string(),
        );
    }
    parts.join("; ")
}

/// Evaluate a script against a policy. Enforcement happens in the backend
/// command handler, which refuses to call the driver unless this returns
/// `Allow`, or `Confirm` and the caller presented a valid token (and typed phrase).
pub fn evaluate(sql: &str, d: Dialect, policy: &SafetyPolicy, guard: &ConfirmationGuard, connection_id: &str, connection_name: &str) -> Evaluation {
    evaluate_classified(classify_script(sql, d), sql, policy, guard, connection_id, connection_name)
}

/// Same as [`evaluate`] for statements classified elsewhere (e.g. Redis commands).
/// `token_text` is the exact text the confirmation token is bound to.
pub fn evaluate_classified(
    statements: Vec<Classified>,
    token_text: &str,
    policy: &SafetyPolicy,
    guard: &ConfirmationGuard,
    connection_id: &str,
    connection_name: &str,
) -> Evaluation {
    let sql = token_text;
    let mut block = Vec::new();
    let mut confirm = Vec::new();
    let mut destructive = false;
    for c in &statements {
        let f = Finding { statement: c.index, risk: c.risk, reason: describe(c) };
        if policy.read_only && (c.risk > Risk::Session || c.flags.contains(&Flag::DisablesReadOnly)) {
            block.push(f);
            continue;
        }
        if policy.block_at.is_some_and(|b| c.risk >= b) {
            block.push(f);
            continue;
        }
        if policy.confirm_at.is_some_and(|t| c.risk >= t) || c.flags.contains(&Flag::DisablesReadOnly) {
            destructive |= c.risk == Risk::Destructive;
            confirm.push(f);
        }
    }
    let decision = if !block.is_empty() {
        Decision::Block { findings: block }
    } else if !confirm.is_empty() {
        Decision::Confirm {
            findings: confirm,
            typed_phrase: (destructive && policy.typed_confirmation_for_destructive).then(|| connection_name.to_string()),
            token: guard.token(connection_id, sql),
        }
    } else {
        Decision::Allow
    };
    Evaluation { statements, decision }
}

/// Final gate used by the command handler.
pub fn authorize(eval: &Evaluation, guard: &ConfirmationGuard, connection_id: &str, sql: &str, token: Option<&str>, typed: Option<&str>) -> Result<(), String> {
    match &eval.decision {
        Decision::Allow => Ok(()),
        Decision::Block { findings } => {
            Err(format!("blocked by safety policy: {}", findings.iter().map(|f| f.reason.as_str()).collect::<Vec<_>>().join(" | ")))
        }
        Decision::Confirm { typed_phrase, .. } => {
            let Some(t) = token else { return Err("confirmation required".into()) };
            if !guard.verify(connection_id, sql, t) {
                return Err("confirmation token does not match this SQL".into());
            }
            if let Some(p) = typed_phrase {
                if typed.map(str::trim) != Some(p.as_str()) {
                    return Err("typed confirmation does not match the connection name".into());
                }
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g() -> ConfirmationGuard {
        ConfirmationGuard::new([7u8; 32])
    }

    #[test]
    fn dev_allows_writes_confirms_destructive() {
        let p = SafetyPolicy::for_environment(EnvironmentKind::Development);
        let e = evaluate("update t set a=1 where id=1", Dialect::Postgres, &p, &g(), "c", "n");
        assert_eq!(e.decision, Decision::Allow);
        let e = evaluate("delete from t", Dialect::Postgres, &p, &g(), "c", "n");
        assert!(matches!(e.decision, Decision::Confirm { typed_phrase: None, .. }));
    }

    #[test]
    fn production_requires_token_and_typed_name_for_destructive() {
        let p = SafetyPolicy::for_environment(EnvironmentKind::Production);
        let sql = "drop table orders";
        let e = evaluate(sql, Dialect::Postgres, &p, &g(), "conn1", "Prod DB");
        let Decision::Confirm { token, typed_phrase, .. } = &e.decision else { panic!() };
        assert_eq!(typed_phrase.as_deref(), Some("Prod DB"));
        assert!(authorize(&e, &g(), "conn1", sql, None, None).is_err());
        assert!(authorize(&e, &g(), "conn1", sql, Some(token), None).is_err());
        assert!(authorize(&e, &g(), "conn1", sql, Some(token), Some("Prod DB")).is_ok());
        // token bound to SQL text and connection
        assert!(authorize(&e, &g(), "conn1", "drop table users", Some(token), Some("Prod DB")).is_err());
        assert!(authorize(&e, &g(), "conn2", sql, Some(token), Some("Prod DB")).is_err());
        // token bound to key
        assert!(authorize(&e, &ConfirmationGuard::new([8; 32]), "conn1", sql, Some(token), Some("Prod DB")).is_err());
    }

    #[test]
    fn production_reads_are_allowed() {
        let p = SafetyPolicy::for_environment(EnvironmentKind::Production);
        let e = evaluate("select * from orders where id = 1", Dialect::Postgres, &p, &g(), "c", "n");
        assert_eq!(e.decision, Decision::Allow);
    }

    #[test]
    fn read_only_blocks_writes_and_bypasses() {
        let p = SafetyPolicy::read_only();
        for s in ["insert into t values(1)", "call p()", "set transaction_read_only = off", "select nextval('s')", "begin; delete from t where id=1; commit"] {
            let e = evaluate(s, Dialect::Postgres, &p, &g(), "c", "n");
            assert!(matches!(e.decision, Decision::Block { .. }), "{s}");
        }
        let e = evaluate("select 1; begin; select 2; commit", Dialect::Postgres, &p, &g(), "c", "n");
        assert_eq!(e.decision, Decision::Allow);
    }
}
