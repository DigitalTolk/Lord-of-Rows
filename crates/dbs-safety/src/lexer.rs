//! Dialect-aware SQL lexer and statement splitter.
//!
//! Handles: `--` and `#` (MySQL) line comments, nested `/* */` block comments
//! (Postgres nests, others don't, nesting is harmless for splitting), single-quoted
//! strings with doubled-quote and (MySQL) backslash escapes, `E'..'` strings,
//! double-quoted identifiers, backticks (MySQL), `[..]` (SQL Server), Postgres
//! dollar-quoted bodies (`$$..$$`, `$tag$..$tag$`), and `BEGIN ... END` compound
//! bodies in CREATE FUNCTION/PROCEDURE/TRIGGER for MySQL/SQLite/SQL Server so that
//! inner semicolons do not split the statement. MySQL client `DELIMITER` lines are
//! honoured.

use dbs_core::Dialect;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokKind {
    Word,
    QuotedIdent,
    String,
    Number,
    Punct,
    Semicolon,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: TokKind,
    /// Uppercased for `Word`, raw text otherwise.
    pub text: String,
    pub start: usize,
    pub end: usize,
}

impl Token {
    pub fn is_kw(&self, kw: &str) -> bool {
        self.kind == TokKind::Word && self.text == kw
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    /// Exact text of the statement (without trailing delimiter), trimmed.
    pub text: String,
    pub start: usize,
    pub end: usize,
    pub tokens: Vec<Token>,
}

pub fn tokenize(sql: &str, d: Dialect) -> Vec<Token> {
    split_statements(sql, d).into_iter().flat_map(|s| s.tokens).collect()
}

/// Split a script into statements. Empty statements are dropped.
pub fn split_statements(sql: &str, d: Dialect) -> Vec<Statement> {
    let b = sql.as_bytes();
    let n = b.len();
    let mut i = 0usize;
    let mut out = Vec::new();
    let mut cur_tokens: Vec<Token> = Vec::new();
    let mut stmt_start = 0usize;
    let mut delimiter: Vec<u8> = b";".to_vec();
    // Depth of BEGIN..END / CASE..END blocks inside routine bodies.
    let mut block_depth = 0i32;

    let flush = |out: &mut Vec<Statement>, tokens: &mut Vec<Token>, start: usize, end: usize| {
        let raw = &sql[start..end];
        let trimmed = raw.trim();
        if !tokens.is_empty() && !trimmed.is_empty() {
            let lead = raw.len() - raw.trim_start().len();
            out.push(Statement { text: trimmed.to_string(), start: start + lead, end: start + lead + trimmed.len(), tokens: std::mem::take(tokens) });
        }
        tokens.clear();
    };

    while i < n {
        let c = b[i];
        // MySQL client DELIMITER directive at start of a line.
        if d == Dialect::MySql && cur_tokens.is_empty() && at_line_start(b, i) && starts_with_ci(&b[i..], b"DELIMITER ") {
            let line_end = b[i..].iter().position(|&x| x == b'\n').map(|p| i + p).unwrap_or(n);
            let newd = sql[i + 10..line_end].trim();
            if !newd.is_empty() {
                delimiter = newd.as_bytes().to_vec();
            }
            i = line_end;
            stmt_start = i;
            continue;
        }
        // Delimiter (only at block depth 0).
        if block_depth <= 0 && b[i..].starts_with(&delimiter) {
            flush(&mut out, &mut cur_tokens, stmt_start, i);
            i += delimiter.len();
            stmt_start = i;
            block_depth = 0;
            continue;
        }
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        // Comments
        if c == b'-' && i + 1 < n && b[i + 1] == b'-' || (c == b'#' && d == Dialect::MySql) {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            let mut depth = 1;
            i += 2;
            while i < n && depth > 0 {
                if b[i] == b'/' && i + 1 < n && b[i + 1] == b'*' {
                    depth += 1;
                    i += 2;
                } else if b[i] == b'*' && i + 1 < n && b[i + 1] == b'/' {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        let start = i;
        // Strings
        let estring = (c == b'E' || c == b'e') && i + 1 < n && b[i + 1] == b'\'' && d == Dialect::Postgres;
        if c == b'\'' || estring {
            if estring {
                i += 1;
            }
            i += 1;
            let backslash = d == Dialect::MySql || estring;
            while i < n {
                if backslash && b[i] == b'\\' {
                    i += 2;
                    continue;
                }
                if b[i] == b'\'' {
                    if i + 1 < n && b[i + 1] == b'\'' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            let i2 = i.min(n);
            cur_tokens.push(Token { kind: TokKind::String, text: sql[start..i2].to_string(), start, end: i2 });
            i = i2;
            continue;
        }
        // Quoted identifiers
        let close = match c {
            b'"' => Some(b'"'),
            b'`' if d == Dialect::MySql => Some(b'`'),
            b'[' if d == Dialect::SqlServer => Some(b']'),
            _ => None,
        };
        if let Some(cl) = close {
            i += 1;
            while i < n {
                if b[i] == cl {
                    if i + 1 < n && b[i + 1] == cl {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            let i2 = i.min(n);
            cur_tokens.push(Token { kind: TokKind::QuotedIdent, text: sql[start..i2].to_string(), start, end: i2 });
            i = i2;
            continue;
        }
        // Dollar quoting (Postgres)
        if c == b'$' && d == Dialect::Postgres {
            if let Some(tag_end) = dollar_tag_end(b, i) {
                let tag = &b[i..=tag_end];
                let body_start = tag_end + 1;
                let close_at = find(&b[body_start..], tag).map(|p| body_start + p + tag.len()).unwrap_or(n);
                cur_tokens.push(Token { kind: TokKind::String, text: sql[start..close_at].to_string(), start, end: close_at });
                i = close_at;
                continue;
            }
        }
        // Words
        if c.is_ascii_alphabetic() || c == b'_' || c >= 0x80 {
            while i < n && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$' || b[i] >= 0x80) {
                i += 1;
            }
            // keep char boundary
            while i < n && !sql.is_char_boundary(i) {
                i += 1;
            }
            let word = sql[start..i].to_ascii_uppercase();
            if d != Dialect::Postgres {
                block_depth += block_delta(&cur_tokens, &word);
            }
            cur_tokens.push(Token { kind: TokKind::Word, text: word, start, end: i });
            continue;
        }
        if c.is_ascii_digit() {
            while i < n && (b[i].is_ascii_alphanumeric() || b[i] == b'.') {
                i += 1;
            }
            cur_tokens.push(Token { kind: TokKind::Number, text: sql[start..i].to_string(), start, end: i });
            continue;
        }
        // punctuation (one UTF-8 char)
        let ch_len = sql[i..].chars().next().map(|ch| ch.len_utf8()).unwrap_or(1);
        i += ch_len;
        cur_tokens.push(Token { kind: TokKind::Punct, text: sql[start..i].to_string(), start, end: i });
    }
    flush(&mut out, &mut cur_tokens, stmt_start, n);
    out
}

/// Track BEGIN...END bodies for routine definitions in non-Postgres dialects.
/// Only active once the statement is a CREATE [..] FUNCTION/PROCEDURE/TRIGGER/EVENT
/// (or a bare BEGIN..END block in SQL Server), so `BEGIN;` as a transaction start
/// still splits normally.
fn block_delta(prev: &[Token], word: &str) -> i32 {
    let is_routine = prev.first().is_some_and(|t| t.is_kw("CREATE") || t.is_kw("ALTER"))
        && prev.iter().take(6).any(|t| matches!(t.text.as_str(), "FUNCTION" | "PROCEDURE" | "TRIGGER" | "EVENT" | "PROC"));
    if !is_routine {
        return 0;
    }
    let after_end = prev.last().is_some_and(|t| t.is_kw("END"));
    match word {
        // `END CASE` closes the CASE opened earlier; END already decremented.
        "CASE" if after_end => 0,
        "BEGIN" | "CASE" => 1,
        "END" => -1,
        // `END IF` / `END LOOP` / ... close blocks that never incremented,
        // so undo the decrement applied for END.
        "IF" | "LOOP" | "WHILE" | "REPEAT" if after_end => 1,
        _ => 0,
    }
}

fn dollar_tag_end(b: &[u8], i: usize) -> Option<usize> {
    let mut j = i + 1;
    while j < b.len() {
        if b[j] == b'$' {
            return Some(j);
        }
        if !(b[j].is_ascii_alphanumeric() || b[j] == b'_') || (j == i + 1 && b[j].is_ascii_digit()) {
            return None;
        }
        j += 1;
    }
    None
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn at_line_start(b: &[u8], i: usize) -> bool {
    b[..i].iter().rev().take_while(|&&c| c != b'\n').all(|c| c.is_ascii_whitespace())
}

fn starts_with_ci(hay: &[u8], needle: &[u8]) -> bool {
    hay.len() >= needle.len() && hay[..needle.len()].eq_ignore_ascii_case(needle)
}

/// Return the statement containing byte offset `pos` (for "run statement at cursor").
pub fn statement_at(sql: &str, d: Dialect, pos: usize) -> Option<Statement> {
    let stmts = split_statements(sql, d);
    stmts.iter().find(|s| pos >= s.start && pos <= s.end).or_else(|| stmts.iter().rev().find(|s| s.end <= pos)).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str, d: Dialect) -> Vec<String> {
        split_statements(sql, d).into_iter().map(|s| s.text).collect()
    }

    #[test]
    fn splits_simple() {
        assert_eq!(texts("select 1; select 2 ;\n\n", Dialect::Postgres), vec!["select 1", "select 2"]);
    }

    #[test]
    fn ignores_semicolons_in_strings_comments_idents() {
        let sql = "select ';' , \"a;b\" -- x;y\n from t /* ; */; select 2";
        assert_eq!(texts(sql, Dialect::Postgres).len(), 2);
        let sql = "select 'it''s; ok', `a;b` # c;\n; select 'a\\';b'";
        assert_eq!(texts(sql, Dialect::MySql).len(), 2);
    }

    #[test]
    fn dollar_quoted_function_body() {
        let sql = "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN; RETURN 1; END; $body$ LANGUAGE plpgsql; SELECT f()";
        let t = texts(sql, Dialect::Postgres);
        assert_eq!(t.len(), 2, "{t:?}");
        assert!(t[0].ends_with("plpgsql"));
    }

    #[test]
    fn mysql_procedure_begin_end() {
        let sql = "CREATE PROCEDURE p() BEGIN SELECT 1; IF 1 THEN SELECT 2; END IF; END; CALL p()";
        let t = texts(sql, Dialect::MySql);
        assert_eq!(t.len(), 2, "{t:?}");
        assert!(t[1].starts_with("CALL"));
    }

    #[test]
    fn mysql_delimiter_directive() {
        let sql = "DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END//\nDELIMITER ;\nSELECT 2;";
        let t = texts(sql, Dialect::MySql);
        assert_eq!(t.len(), 2, "{t:?}");
    }

    #[test]
    fn transaction_begin_still_splits() {
        assert_eq!(texts("BEGIN; UPDATE t SET a=1 WHERE id=1; COMMIT;", Dialect::Sqlite).len(), 3);
    }

    #[test]
    fn unterminated_string_does_not_panic() {
        let _ = split_statements("select 'abc", Dialect::Postgres);
        let _ = split_statements("select $$abc", Dialect::Postgres);
        let _ = split_statements("/* abc", Dialect::Postgres);
        let _ = split_statements("ä; ö ;'", Dialect::MySql);
    }

    #[test]
    fn statement_at_cursor() {
        let sql = "select 1;\nselect 2;\nselect 3";
        let s = statement_at(sql, Dialect::Postgres, sql.find("2").unwrap()).unwrap();
        assert_eq!(s.text, "select 2");
    }

    #[test]
    fn fuzz_like_random_inputs_never_panic() {
        // Deterministic pseudo-random bytes across all dialects.
        let alphabet = "a';\"`[]$-#/*\\ \nEé€0BEGINEND";
        let chars: Vec<char> = alphabet.chars().collect();
        let mut seed: u64 = 0x9e3779b97f4a7c15;
        for _ in 0..3000 {
            let mut s = String::new();
            for _ in 0..(seed % 40) {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                s.push(chars[(seed >> 33) as usize % chars.len()]);
            }
            for d in [Dialect::Postgres, Dialect::MySql, Dialect::Sqlite, Dialect::SqlServer, Dialect::Generic] {
                for st in split_statements(&s, d) {
                    assert!(st.start <= st.end && st.end <= s.len());
                }
            }
        }
    }
}
