//! Validation of user-written "Raw SQL" filter expressions (table filter bar).
//!
//! The expression is spliced verbatim into `SELECT * FROM t WHERE (<expr>) ...`,
//! so it must be a single, self-contained boolean expression that can neither
//! escape its parentheses nor write. Rules (all enforced on lexer tokens, so
//! quoted strings and identifiers are never misread):
//!
//! * 1..=4000 bytes, no NUL;
//! * no statement delimiter, no comments of any kind (MySQL `/*! */` executes,
//!   and a line comment would swallow the rest of the generated query);
//! * every string, quoted identifier and dollar-quoted body is terminated;
//! * parentheses balanced and never closing below the wrapper;
//! * no bind placeholders (`?`, `$1`, `@P1`) and no `:=` assignment;
//! * no statement keywords that write, lock, or change the session
//!   (INSERT, UPDATE, DELETE, INTO, CALL, ...);
//! * as a whole, `SELECT 1 WHERE (<expr>)` must classify as a plain read with no
//!   flags (catches known side-effect functions such as `pg_sleep`/`nextval`).
//!
//! Like every client-side check this cannot prove that a user-defined function
//! called from the expression is free of side effects.

use dbs_core::{Dialect, MAX_RAW_FILTER_LEN};

use crate::classify::{classify_statement, Risk};
use crate::lexer::{split_statements, TokKind};

/// Keywords that never belong in a boolean filter expression.
const FORBIDDEN_WORDS: &[&str] = &[
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "UPSERT",
    "DROP",
    "ALTER",
    "CREATE",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "INTO",
    "CALL",
    "EXEC",
    "EXECUTE",
    "COPY",
    "LOCK",
    "UNLOCK",
    "PREPARE",
    "DEALLOCATE",
    "HANDLER",
    "ATTACH",
    "DETACH",
    "PRAGMA",
    "VACUUM",
    "SHUTDOWN",
    "KILL",
    "LOAD",
    "OUTFILE",
    "DUMPFILE",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "DECLARE",
    "LISTEN",
    "NOTIFY",
];

/// Functions that block, notify or otherwise act, on top of the classifier's list.
const FORBIDDEN_FUNCS: &[&str] = &["PG_SLEEP", "PG_SLEEP_FOR", "PG_SLEEP_UNTIL", "PG_NOTIFY", "LO_CREATE", "LO_PUT", "LO_TRUNCATE", "WAITFOR"];

/// Ok when `expr` is acceptable as a raw WHERE fragment; Err(reason) otherwise.
pub fn validate_filter_expression(expr: &str, d: Dialect) -> Result<(), String> {
    let expr = expr.trim();
    if expr.is_empty() {
        return Err("the raw SQL filter is empty".into());
    }
    if expr.len() > MAX_RAW_FILTER_LEN || expr.contains('\0') {
        return Err("the raw SQL filter is too long".into());
    }

    // A sentinel token on the same line must survive lexing as its own token;
    // otherwise an unterminated string/identifier/comment swallowed it.
    let probe = format!("{expr} 0");
    let stmts = split_statements(&probe, d);
    if stmts.len() != 1 {
        return Err("the raw SQL filter must be a single expression (no ';')".into());
    }
    let toks = &stmts[0].tokens;
    match toks.last() {
        Some(t) if t.kind == TokKind::Number && t.text == "0" && t.start == expr.len() + 1 => {}
        _ => return Err("the raw SQL filter has an unterminated string, identifier or comment".into()),
    }
    let toks = &toks[..toks.len() - 1];
    if toks.is_empty() {
        return Err("the raw SQL filter is empty".into());
    }

    // Anything between tokens must be whitespace: rejects comments and ';'.
    let mut pos = stmts[0].start;
    for t in toks {
        if !probe[pos..t.start].chars().all(char::is_whitespace) {
            return Err("comments and ';' are not allowed in a raw SQL filter".into());
        }
        pos = t.end;
    }
    if !probe[pos..expr.len()].chars().all(char::is_whitespace) {
        return Err("comments and ';' are not allowed in a raw SQL filter".into());
    }

    let mut depth = 0i32;
    for (i, t) in toks.iter().enumerate() {
        match t.kind {
            TokKind::Punct => match t.text.as_str() {
                "(" => depth += 1,
                ")" => {
                    depth -= 1;
                    if depth < 0 {
                        return Err("unbalanced ')' in the raw SQL filter".into());
                    }
                }
                "?" | "$" => return Err("bind placeholders are not allowed in a raw SQL filter".into()),
                ":" if toks.get(i + 1).is_some_and(|n| n.text == "=") => return Err("assignments (:=) are not allowed in a raw SQL filter".into()),
                "@" if d == Dialect::SqlServer && toks.get(i + 1).is_some_and(|n| n.text.starts_with('P')) => {
                    return Err("bind placeholders are not allowed in a raw SQL filter".into())
                }
                _ => {}
            },
            TokKind::Semicolon => return Err("the raw SQL filter must be a single expression (no ';')".into()),
            TokKind::Word => {
                if t.text.starts_with('$') {
                    return Err("bind placeholders are not allowed in a raw SQL filter".into());
                }
                let call = toks.get(i + 1).is_some_and(|n| n.text == "(");
                if FORBIDDEN_WORDS.contains(&t.text.as_str()) || (call && FORBIDDEN_FUNCS.contains(&t.text.as_str())) {
                    return Err(format!("{} is not allowed in a raw SQL filter", t.text));
                }
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err("unbalanced '(' in the raw SQL filter".into());
    }

    // Whole-query classification as a final gate.
    let wrapped = format!("SELECT 1 WHERE ({expr})");
    let ws = split_statements(&wrapped, d);
    if ws.len() != 1 {
        return Err("the raw SQL filter must be a single expression (no ';')".into());
    }
    let c = classify_statement(0, &ws[0], d);
    if c.risk != Risk::Read || !c.flags.is_empty() {
        return Err(format!("the raw SQL filter is not a plain read (classified as {:?})", c.risk).to_lowercase());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(e: &str, d: Dialect) {
        assert_eq!(validate_filter_expression(e, d), Ok(()), "{e}");
    }
    fn bad(e: &str, d: Dialect) {
        assert!(validate_filter_expression(e, d).is_err(), "should reject: {e}");
    }

    #[test]
    fn accepts_boolean_expressions() {
        for d in [Dialect::Postgres, Dialect::MySql, Dialect::Sqlite] {
            ok("age > 30", d);
            ok("  age > 30 AND (name LIKE 'A%' OR name IS NULL)  ", d);
            ok("status IN ('a', 'b') AND NOT deleted", d);
            ok("lower(email) = 'x;y -- not a comment'", d);
            ok("id IN (SELECT user_id FROM orders WHERE total > 10)", d);
            ok("created_at BETWEEN '2024-01-01' AND '2024-12-31'", d);
            ok("comment IS NOT NULL", d);
            ok("CASE WHEN a > 1 THEN true ELSE false END", d);
        }
        ok("\"weird name\" = 'a''b'", Dialect::Postgres);
        ok("`select` = 1", Dialect::MySql);
        ok("data->>'k' = 'v'", Dialect::Postgres);
        ok("tags @> ARRAY['x']", Dialect::Postgres);
    }

    #[test]
    fn rejects_statements_and_delimiters() {
        for d in [Dialect::Postgres, Dialect::MySql, Dialect::Sqlite] {
            bad("", d);
            bad("   ", d);
            bad("1=1; DROP TABLE users", d);
            bad("1=1;", d);
            bad("id = 1; DELETE FROM t", d);
            bad("id IN (DELETE FROM t RETURNING id)", d);
            bad("id IN (WITH x AS (UPDATE t SET a = 1 RETURNING id) SELECT id FROM x)", d);
            bad("1=1 UNION SELECT * INTO new_t FROM t", d);
            bad("EXISTS (SELECT 1 FROM t FOR UPDATE)", d);
        }
        bad("1=1 INTO OUTFILE '/tmp/x'", Dialect::MySql);
    }

    #[test]
    fn rejects_comments_and_unterminated_tokens() {
        for d in [Dialect::Postgres, Dialect::MySql, Dialect::Sqlite] {
            bad("1=1 -- trailing", d);
            bad("1=1 /* c */", d);
            bad("a = 'unterminated", d);
            bad("\"unterminated = 1", d);
            bad("1=1 /* open", d);
        }
        bad("1=1 /*!50000 OR 1=1 */", Dialect::MySql);
        bad("1=1 # hash comment", Dialect::MySql);
        bad("a = 'x\\'", Dialect::MySql);
        bad("a = $$open", Dialect::Postgres);
    }

    #[test]
    fn rejects_paren_escapes_and_placeholders() {
        for d in [Dialect::Postgres, Dialect::MySql, Dialect::Sqlite] {
            bad("1=1) OR (1=1", d);
            bad("(1=1", d);
            bad("1=1)", d);
            bad("a = ?", d);
        }
        bad("a = $1", Dialect::Postgres);
        bad("a = ?1", Dialect::Sqlite);
        bad("(@x := 1) = 1", Dialect::MySql);
    }

    #[test]
    fn rejects_side_effect_functions() {
        bad("pg_sleep(10) IS NOT NULL", Dialect::Postgres);
        bad("nextval('s') > 0", Dialect::Postgres);
        bad("set_config('a.b', 'c', false) = 'c'", Dialect::Postgres);
        bad("SLEEP(5) = 0", Dialect::MySql);
        bad("BENCHMARK(1000000, MD5('x')) = 0", Dialect::MySql);
        bad("load_extension('x') IS NULL", Dialect::Sqlite);
        bad("pg_terminate_backend(123)", Dialect::Postgres);
        bad("pg_notify('c', 'x') IS NULL", Dialect::Postgres);
        ok("sleep_minutes > 3", Dialect::MySql);
    }
}
