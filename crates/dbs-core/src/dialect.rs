use serde::{Deserialize, Serialize};

use crate::{DbError, DbResult, Engine, RowChange, TableTarget, Value};

/// SQL dialect used for identifier quoting, placeholders and generated SQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dialect {
    Postgres,
    MySql,
    Sqlite,
    SqlServer,
    Generic,
}

impl From<Engine> for Dialect {
    fn from(e: Engine) -> Self {
        match e.wire_family() {
            Some(Engine::Postgres) => Dialect::Postgres,
            Some(Engine::MySql) => Dialect::MySql,
            Some(Engine::Sqlite) => Dialect::Sqlite,
            _ if e == Engine::SqlServer => Dialect::SqlServer,
            _ if e == Engine::DuckDb || e == Engine::LibSql || e == Engine::Turso || e == Engine::CloudflareD1 => Dialect::Sqlite,
            _ => Dialect::Generic,
        }
    }
}

pub const MAX_IDENTIFIER_LEN: usize = 128;

impl Dialect {
    /// Quote an identifier. Rejects NUL and over-long identifiers; embedded quote
    /// characters are escaped by doubling, so any other input is safe to splice.
    pub fn quote_ident(self, ident: &str) -> DbResult<String> {
        if ident.is_empty() || ident.len() > MAX_IDENTIFIER_LEN || ident.contains('\0') {
            return Err(DbError::invalid("invalid identifier"));
        }
        Ok(match self {
            Dialect::MySql => format!("`{}`", ident.replace('`', "``")),
            Dialect::SqlServer => format!("[{}]", ident.replace(']', "]]")),
            _ => format!("\"{}\"", ident.replace('"', "\"\"")),
        })
    }

    /// Statement that creates a new database (MySQL family: `CREATE DATABASE`) or a new
    /// schema in the connected database (Postgres family: `CREATE SCHEMA`), with the name
    /// quoted for the dialect. Surrounding whitespace is trimmed; other dialects are unsupported.
    pub fn create_database_sql(self, name: &str) -> DbResult<String> {
        let name = name.trim();
        match self {
            Dialect::MySql => Ok(format!("CREATE DATABASE {};", self.quote_ident(name)?)),
            Dialect::Postgres => Ok(format!("CREATE SCHEMA {};", self.quote_ident(name)?)),
            _ => Err(DbError::unsupported("creating databases for this engine")),
        }
    }

    pub fn qualified(self, t: &TableTarget) -> DbResult<String> {
        match &t.schema {
            Some(s) if !s.is_empty() => Ok(format!("{}.{}", self.quote_ident(s)?, self.quote_ident(&t.table)?)),
            _ => self.quote_ident(&t.table),
        }
    }

    /// Positional placeholder for the n-th (1-based) parameter.
    pub fn placeholder(self, n: usize) -> String {
        match self {
            Dialect::Postgres => format!("${n}"),
            Dialect::SqlServer => format!("@P{n}"),
            Dialect::Sqlite => format!("?{n}"),
            _ => "?".to_string(),
        }
    }

    /// SQL literal for a value. Used ONLY for human-readable previews and SQL
    /// exports, never for executing application-generated statements (those use
    /// parameters, see [`build_change_sql`]).
    pub fn literal(self, v: &Value) -> String {
        fn q(s: &str, mysql: bool) -> String {
            let mut s = s.replace('\'', "''");
            if mysql {
                s = s.replace('\\', "\\\\");
            }
            format!("'{s}'")
        }
        let mysql = self == Dialect::MySql;
        match v {
            Value::Null => "NULL".into(),
            Value::Bool(b) => match self {
                Dialect::Postgres => if *b { "TRUE" } else { "FALSE" }.into(),
                _ => if *b { "1" } else { "0" }.into(),
            },
            Value::Int(i) => i.to_string(),
            Value::BigInt(s) | Value::Decimal(s) => {
                if s.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | '.' | 'e' | 'E' | '+')) {
                    s.clone()
                } else {
                    q(s, mysql)
                }
            }
            Value::Float(f) if f.is_finite() => f.to_string(),
            Value::Float(f) => q(&f.to_string(), mysql),
            Value::Bytes { hex, .. } => match self {
                Dialect::Postgres => format!("'\\x{hex}'::bytea"),
                Dialect::MySql | Dialect::SqlServer => format!("0x{hex}"),
                _ => format!("X'{hex}'"),
            },
            Value::Json(j) => q(&j.to_string(), mysql),
            other => q(&other.to_plain().unwrap_or_default(), mysql),
        }
    }
}

/// A parameterised statement produced by the application (never from user text).
#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedStatement {
    pub sql: String,
    pub params: Vec<Value>,
}

impl GeneratedStatement {
    /// Inline literals for display only. Single left-to-right pass over the
    /// generated SQL, so a literal that itself contains `?` or `$1` is never
    /// re-substituted.
    pub fn preview(&self, d: Dialect) -> String {
        let src = self.sql.as_str();
        let mut out = String::with_capacity(src.len() + 16 * self.params.len());
        let mut next = 0usize;
        let mut i = 0usize;
        let bytes = src.as_bytes();
        let digits_at = |j: usize| {
            let mut k = j;
            while k < bytes.len() && bytes[k].is_ascii_digit() {
                k += 1;
            }
            k
        };
        while i < bytes.len() {
            let (prefix_len, numbered) = match d {
                Dialect::Postgres if bytes[i] == b'$' => (1, true),
                Dialect::Sqlite if bytes[i] == b'?' => (1, true),
                Dialect::SqlServer if src[i..].starts_with("@P") => (2, true),
                Dialect::MySql | Dialect::Generic if bytes[i] == b'?' => (1, false),
                _ => (0, false),
            };
            if prefix_len > 0 {
                if numbered {
                    let end = digits_at(i + prefix_len);
                    if end > i + prefix_len {
                        let n: usize = src[i + prefix_len..end].parse().unwrap_or(0);
                        if let Some(p) = n.checked_sub(1).and_then(|n| self.params.get(n)) {
                            out.push_str(&d.literal(p));
                            i = end;
                            continue;
                        }
                    }
                } else if let Some(p) = self.params.get(next) {
                    out.push_str(&d.literal(p));
                    next += 1;
                    i += 1;
                    continue;
                }
            }
            let ch = src[i..].chars().next().unwrap_or_default();
            out.push(ch);
            i += ch.len_utf8().max(1);
        }
        out
    }
}

/// Build the parameterised SQL for a staged grid change. UPDATE and DELETE include
/// the original values of edited columns in the WHERE clause, so a concurrent
/// remote modification makes the statement affect 0 rows (reported as a conflict)
/// instead of silently overwriting.
pub fn build_change_sql(d: Dialect, target: &TableTarget, change: &RowChange) -> DbResult<GeneratedStatement> {
    let table = d.qualified(target)?;
    let mut params = Vec::new();
    let mut ph = |v: &Value, params: &mut Vec<Value>| {
        params.push(v.clone());
        d.placeholder(params.len())
    };
    fn where_clause(
        d: Dialect,
        cols: &[(String, Value)],
        params: &mut Vec<Value>,
        ph: &mut dyn FnMut(&Value, &mut Vec<Value>) -> String,
    ) -> DbResult<Vec<String>> {
        let mut parts = Vec::new();
        for (c, v) in cols {
            let qc = d.quote_ident(c)?;
            if v.is_null() {
                parts.push(format!("{qc} IS NULL"));
            } else {
                let p = ph(v, params);
                parts.push(format!("{qc} = {p}"));
            }
        }
        Ok(parts)
    }
    let sql = match change {
        RowChange::Insert { values } => {
            if values.is_empty() {
                return Ok(GeneratedStatement {
                    sql: match d {
                        Dialect::MySql => format!("INSERT INTO {table} () VALUES ()"),
                        _ => format!("INSERT INTO {table} DEFAULT VALUES"),
                    },
                    params,
                });
            }
            let mut cols = Vec::new();
            let mut phs = Vec::new();
            for (c, v) in values {
                cols.push(d.quote_ident(c)?);
                phs.push(ph(v, &mut params));
            }
            format!("INSERT INTO {table} ({}) VALUES ({})", cols.join(", "), phs.join(", "))
        }
        RowChange::Update { key, original, changes } => {
            if key.is_empty() {
                return Err(DbError::invalid("refusing UPDATE without a row key"));
            }
            if changes.is_empty() {
                return Err(DbError::invalid("no changes"));
            }
            let mut sets = Vec::new();
            for (c, v) in changes {
                let qc = d.quote_ident(c)?;
                let p = ph(v, &mut params);
                sets.push(format!("{qc} = {p}"));
            }
            let mut conds = where_clause(d, key, &mut params, &mut ph)?;
            let extra: Vec<_> = original.iter().filter(|(c, _)| !key.iter().any(|(k, _)| k == c)).cloned().collect();
            conds.extend(where_clause(d, &extra, &mut params, &mut ph)?);
            format!("UPDATE {table} SET {} WHERE {}", sets.join(", "), conds.join(" AND "))
        }
        RowChange::Delete { key, original } => {
            if key.is_empty() {
                return Err(DbError::invalid("refusing DELETE without a row key"));
            }
            let mut conds = where_clause(d, key, &mut params, &mut ph)?;
            let extra: Vec<_> = original.iter().filter(|(c, _)| !key.iter().any(|(k, _)| k == c)).cloned().collect();
            conds.extend(where_clause(d, &extra, &mut params, &mut ph)?);
            format!("DELETE FROM {table} WHERE {}", conds.join(" AND "))
        }
    };
    Ok(GeneratedStatement { sql, params })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_escapes_injection() {
        assert_eq!(Dialect::Postgres.quote_ident("a\"; DROP TABLE x; --").unwrap(), "\"a\"\"; DROP TABLE x; --\"");
        assert_eq!(Dialect::MySql.quote_ident("a`b").unwrap(), "`a``b`");
        assert_eq!(Dialect::SqlServer.quote_ident("a]b").unwrap(), "[a]]b]");
        assert!(Dialect::Postgres.quote_ident("").is_err());
        assert!(Dialect::Postgres.quote_ident("a\0b").is_err());
        assert!(Dialect::Postgres.quote_ident(&"x".repeat(129)).is_err());
    }

    #[test]
    fn create_database_sql_quotes_per_dialect() {
        assert_eq!(Dialect::MySql.create_database_sql("shop").unwrap(), "CREATE DATABASE `shop`;");
        assert_eq!(Dialect::MySql.create_database_sql(" a`b; DROP DATABASE x ").unwrap(), "CREATE DATABASE `a``b; DROP DATABASE x`;");
        assert_eq!(Dialect::Postgres.create_database_sql("Sales 2026").unwrap(), "CREATE SCHEMA \"Sales 2026\";");
        assert_eq!(Dialect::Postgres.create_database_sql("a\"; DROP SCHEMA public; --").unwrap(), "CREATE SCHEMA \"a\"\"; DROP SCHEMA public; --\";");
        assert!(Dialect::Postgres.create_database_sql("   ").is_err());
        assert!(Dialect::MySql.create_database_sql("a\0b").is_err());
        assert!(Dialect::MySql.create_database_sql(&"x".repeat(129)).is_err());
        for d in [Dialect::Sqlite, Dialect::SqlServer, Dialect::Generic] {
            assert_eq!(d.create_database_sql("x").unwrap_err().kind, crate::ErrorKind::Unsupported);
        }
    }

    #[test]
    fn literal_escapes_quotes() {
        assert_eq!(Dialect::Postgres.literal(&Value::Text("O'Brien".into())), "'O''Brien'");
        assert_eq!(Dialect::MySql.literal(&Value::Text("a\\'b".into())), "'a\\\\''b'");
        assert_eq!(Dialect::Postgres.literal(&Value::Null), "NULL");
        assert_eq!(Dialect::Postgres.literal(&Value::Decimal("1; DROP".into())), "'1; DROP'");
    }

    #[test]
    fn update_is_parameterised_with_concurrency_guard() {
        let t = TableTarget { schema: Some("public".into()), table: "users".into() };
        let ch = RowChange::Update {
            key: vec![("id".into(), Value::Int(7))],
            original: vec![("name".into(), Value::Text("old".into())), ("note".into(), Value::Null)],
            changes: vec![("name".into(), Value::Text("new".into()))],
        };
        let s = build_change_sql(Dialect::Postgres, &t, &ch).unwrap();
        assert_eq!(s.sql, "UPDATE \"public\".\"users\" SET \"name\" = $1 WHERE \"id\" = $2 AND \"name\" = $3 AND \"note\" IS NULL");
        assert_eq!(s.params.len(), 3);
        assert_eq!(s.preview(Dialect::Postgres), "UPDATE \"public\".\"users\" SET \"name\" = 'new' WHERE \"id\" = 7 AND \"name\" = 'old' AND \"note\" IS NULL");
    }

    #[test]
    fn mysql_uses_question_marks() {
        let t = TableTarget { schema: None, table: "t".into() };
        let ch = RowChange::Insert { values: vec![("a".into(), Value::Int(1)), ("b".into(), Value::Text("x".into()))] };
        let s = build_change_sql(Dialect::MySql, &t, &ch).unwrap();
        assert_eq!(s.sql, "INSERT INTO `t` (`a`, `b`) VALUES (?, ?)");
        assert_eq!(s.preview(Dialect::MySql), "INSERT INTO `t` (`a`, `b`) VALUES (1, 'x')");
    }

    #[test]
    fn refuses_keyless_update_delete() {
        let t = TableTarget { schema: None, table: "t".into() };
        let d = RowChange::Delete { key: vec![], original: vec![] };
        assert!(build_change_sql(Dialect::Sqlite, &t, &d).is_err());
    }

    #[test]
    fn placeholder_preview_handles_double_digits() {
        let vals: Vec<(String, Value)> = (1..=11).map(|i| (format!("c{i}"), Value::Int(i))).collect();
        let t = TableTarget { schema: None, table: "t".into() };
        let s = build_change_sql(Dialect::Postgres, &t, &RowChange::Insert { values: vals }).unwrap();
        assert!(s.preview(Dialect::Postgres).ends_with("VALUES (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)"));
    }

    #[test]
    fn preview_never_resubstitutes_inside_literals() {
        let t = TableTarget { schema: Some("db".into()), table: "t".into() };
        let ch = RowChange::Update {
            key: vec![("id".into(), Value::Int(4))],
            original: vec![("col".into(), Value::Text("$2 ?".into()))],
            changes: vec![("col".into(), Value::Text("what? $1".into()))],
        };
        for d in [Dialect::MySql, Dialect::Postgres, Dialect::Sqlite] {
            let p = build_change_sql(d, &t, &ch).unwrap().preview(d);
            assert!(p.contains("'what? $1'") && p.contains("'$2 ?'") && p.contains("= 4"), "{d:?}: {p}");
        }
        let my = build_change_sql(Dialect::MySql, &t, &ch).unwrap().preview(Dialect::MySql);
        assert!(my.starts_with("UPDATE `db`.`t` SET `col` = 'what? $1' WHERE `id` = 4"), "{my}");
    }
}
