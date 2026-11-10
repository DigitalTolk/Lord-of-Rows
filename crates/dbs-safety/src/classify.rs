use dbs_core::Dialect;
use serde::{Deserialize, Serialize};

use crate::lexer::{split_statements, Statement, TokKind, Token};

/// Ordered by severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    /// Reads data (may still call functions with side effects; see crate docs).
    Read,
    /// Session/transaction control.
    Session,
    /// Inserts or modifies rows.
    Write,
    /// Creates or alters schema objects.
    Schema,
    /// Cannot be classified confidently (procedures, dynamic SQL, unknown verbs).
    Unknown,
    /// Privileges, server administration, maintenance, file/program access.
    Admin,
    /// Drops, truncates, or modifies/deletes all rows.
    Destructive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Flag {
    NoWhereClause,
    TautologicalWhere,
    WritableCte,
    SelectInto,
    ExplainAnalyzeExecutes,
    MayLockTable,
    MayRewriteTable,
    SideEffectFunction,
    DisablesReadOnly,
    FileOrProgramAccess,
    DynamicSql,
    PrivilegeChange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Classified {
    pub index: usize,
    pub verb: String,
    pub risk: Risk,
    pub flags: Vec<Flag>,
    pub start: usize,
    pub end: usize,
    pub excerpt: String,
}

/// Functions known to have side effects or privileged behaviour even inside SELECT.
const SIDE_EFFECT_FUNCS: &[&str] = &[
    "PG_TERMINATE_BACKEND",
    "PG_CANCEL_BACKEND",
    "PG_RELOAD_CONF",
    "PG_ROTATE_LOGFILE",
    "SETVAL",
    "NEXTVAL",
    "SET_CONFIG",
    "LO_UNLINK",
    "LO_IMPORT",
    "LO_EXPORT",
    "LO_FROM_BYTEA",
    "DBLINK_EXEC",
    "DBLINK",
    "PG_READ_FILE",
    "PG_READ_BINARY_FILE",
    "PG_LS_DIR",
    "PG_FILE_WRITE",
    "PG_ADVISORY_LOCK",
    "PG_ADVISORY_XACT_LOCK",
    "PG_SWITCH_WAL",
    "PG_PROMOTE",
    "PG_CREATE_RESTORE_POINT",
    "PG_DROP_REPLICATION_SLOT",
    "PG_CREATE_LOGICAL_REPLICATION_SLOT",
    "LOAD_FILE",
    "SLEEP",
    "BENCHMARK",
    "GET_LOCK",
    "RELEASE_LOCK",
    "LOAD_EXTENSION",
    "XP_CMDSHELL",
    "OPENROWSET",
    "OPENDATASOURCE",
];

pub fn classify_script(sql: &str, d: Dialect) -> Vec<Classified> {
    split_statements(sql, d).into_iter().enumerate().map(|(i, s)| classify_statement(i, &s, d)).collect()
}

fn excerpt(s: &str) -> String {
    let mut e: String = s.chars().take(200).collect();
    if s.chars().count() > 200 {
        e.push('…');
    }
    e
}

pub fn classify_statement(index: usize, st: &Statement, d: Dialect) -> Classified {
    let toks = &st.tokens;
    let words: Vec<&Token> = toks.iter().filter(|t| t.kind == TokKind::Word).collect();
    let kw = |i: usize| words.get(i).map(|t| t.text.as_str()).unwrap_or("");
    let has_kw = |k: &str| words.iter().any(|t| t.text == k);
    let mut flags = Vec::new();

    let first = kw(0);
    let (verb, mut risk) = match first {
        "SELECT" | "VALUES" | "TABLE" | "SHOW" | "DESCRIBE" | "DESC" | "PRAGMA" if first != "PRAGMA" => (first.to_string(), Risk::Read),
        "PRAGMA" => {
            if toks.iter().any(|t| t.text == "=") || toks.iter().any(|t| t.text == "(") && !is_readonly_pragma(kw(1)) {
                ("PRAGMA".into(), Risk::Admin)
            } else {
                ("PRAGMA".into(), Risk::Read)
            }
        }
        "WITH" => {
            let writes = words.iter().skip(1).any(|t| matches!(t.text.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE"));
            if writes {
                flags.push(Flag::WritableCte);
                ("WITH".into(), Risk::Write)
            } else {
                ("SELECT".into(), Risk::Read)
            }
        }
        "INSERT" | "REPLACE" | "UPSERT" | "MERGE" => (first.into(), Risk::Write),
        "UPDATE" | "DELETE" => (first.into(), Risk::Write),
        "LOAD" => ("LOAD".into(), Risk::Write),
        "COPY" => {
            if has_kw("PROGRAM") || (has_kw("TO") && toks.iter().any(|t| t.kind == TokKind::String)) {
                flags.push(Flag::FileOrProgramAccess);
                ("COPY".into(), Risk::Admin)
            } else if has_kw("FROM") {
                ("COPY".into(), Risk::Write)
            } else {
                ("COPY".into(), Risk::Read)
            }
        }
        "CREATE" => {
            if words.iter().take(4).any(|t| matches!(t.text.as_str(), "USER" | "ROLE" | "LOGIN")) {
                flags.push(Flag::PrivilegeChange);
                ("CREATE".into(), Risk::Admin)
            } else {
                if has_kw("INDEX") && !has_kw("CONCURRENTLY") {
                    flags.push(Flag::MayLockTable);
                }
                ("CREATE".into(), Risk::Schema)
            }
        }
        "ALTER" => {
            if kw(1) == "SYSTEM" || words.iter().take(3).any(|t| matches!(t.text.as_str(), "USER" | "ROLE" | "LOGIN")) {
                flags.push(Flag::PrivilegeChange);
                ("ALTER".into(), Risk::Admin)
            } else {
                if kw(1) == "TABLE" {
                    flags.push(Flag::MayLockTable);
                    if has_kw("TYPE")
                        || (has_kw("ALTER") && has_kw("COLUMN") && has_kw("SET") && has_kw("DATA"))
                        || (d == Dialect::MySql && (has_kw("MODIFY") || has_kw("CHANGE")))
                    {
                        flags.push(Flag::MayRewriteTable);
                    }
                }
                if has_kw("DROP") {
                    ("ALTER".into(), Risk::Destructive)
                } else {
                    ("ALTER".into(), Risk::Schema)
                }
            }
        }
        "RENAME" | "COMMENT" => (first.into(), Risk::Schema),
        "DROP" | "TRUNCATE" => (first.into(), Risk::Destructive),
        "GRANT" | "REVOKE" => {
            flags.push(Flag::PrivilegeChange);
            (first.into(), Risk::Admin)
        }
        "VACUUM" | "ANALYZE" | "ANALYSE" | "REINDEX" | "CLUSTER" | "CHECKPOINT" | "OPTIMIZE" | "REPAIR" | "FLUSH" | "KILL" | "SHUTDOWN" | "LOCK" | "UNLOCK"
        | "ATTACH" | "DETACH" | "INSTALL" | "UNINSTALL" | "PURGE" | "RESET"
            if !(first == "RESET" && d != Dialect::MySql) =>
        {
            if matches!(first, "LOCK") {
                flags.push(Flag::MayLockTable);
            }
            (first.into(), Risk::Admin)
        }
        "BEGIN" if d == Dialect::SqlServer && !matches!(kw(1), "TRAN" | "TRANSACTION" | "DISTRIBUTED") => {
            flags.push(Flag::DynamicSql);
            ("BEGIN".into(), Risk::Unknown)
        }
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "END" | "ABORT" => (first.into(), Risk::Session),
        "SET" | "USE" | "RESET" | "DISCARD" => {
            let joined: Vec<&str> = words.iter().map(|t| t.text.as_str()).collect();
            let disables_ro = joined.windows(2).any(|w| w == ["READ", "WRITE"])
                || joined
                    .iter()
                    .any(|w| matches!(*w, "DEFAULT_TRANSACTION_READ_ONLY" | "TRANSACTION_READ_ONLY" | "TX_READ_ONLY" | "ROLE" | "AUTHORIZATION" | "ALL"));
            if disables_ro {
                flags.push(Flag::DisablesReadOnly);
            }
            if kw(1) == "GLOBAL" || kw(1) == "PERSIST" || kw(1) == "PERSIST_ONLY" {
                (first.into(), Risk::Admin)
            } else {
                (first.into(), Risk::Session)
            }
        }
        "EXPLAIN" => {
            let analyze = words.iter().skip(1).take(6).any(|t| matches!(t.text.as_str(), "ANALYZE" | "ANALYSE"));
            if analyze {
                // EXPLAIN ANALYZE actually runs the statement.
                let inner_pos =
                    words.iter().position(|t| matches!(t.text.as_str(), "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "WITH" | "MERGE" | "VALUES" | "TABLE"));
                let inner_kw = inner_pos.map(|p| words[p].text.as_str()).unwrap_or("");
                if inner_kw == "SELECT"
                    || inner_kw == "VALUES"
                    || inner_kw == "TABLE"
                    || (inner_kw == "WITH" && !words.iter().any(|t| matches!(t.text.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE")))
                {
                    ("EXPLAIN".into(), Risk::Read)
                } else {
                    flags.push(Flag::ExplainAnalyzeExecutes);
                    ("EXPLAIN".into(), Risk::Write)
                }
            } else {
                ("EXPLAIN".into(), Risk::Read)
            }
        }
        "CALL" | "EXEC" | "EXECUTE" | "DO" | "PREPARE" | "DEALLOCATE" | "HANDLER" | "LISTEN" | "NOTIFY" | "UNLISTEN" => {
            if matches!(first, "EXEC" | "EXECUTE" | "DO" | "PREPARE") {
                flags.push(Flag::DynamicSql);
            }
            (first.into(), Risk::Unknown)
        }
        "" => ("".into(), Risk::Read),
        other => (other.into(), Risk::Unknown),
    };

    // SELECT ... INTO (creates a table in PG/SQL Server, writes a file in MySQL).
    if verb == "SELECT" && has_kw("INTO") {
        flags.push(Flag::SelectInto);
        if has_kw("OUTFILE") || has_kw("DUMPFILE") {
            flags.push(Flag::FileOrProgramAccess);
            risk = Risk::Admin;
        } else if risk < Risk::Write {
            risk = Risk::Write;
        }
    }

    // UPDATE / DELETE without a top-level WHERE affects every row.
    let dml_main = match verb.as_str() {
        "UPDATE" | "DELETE" => Some(verb.as_str()),
        "WITH" => main_dml_after_cte(toks),
        _ => None,
    };
    if let Some(main) = dml_main {
        if main == "UPDATE" || main == "DELETE" {
            match top_level_where(toks) {
                None => {
                    flags.push(Flag::NoWhereClause);
                    risk = Risk::Destructive;
                }
                Some(wi) if is_tautology(&toks[wi + 1..]) => {
                    flags.push(Flag::TautologicalWhere);
                    risk = Risk::Destructive;
                }
                _ => {}
            }
        }
    }

    // Known side-effect functions anywhere in the statement.
    let calls_side_effect = toks.windows(2).any(|w| w[0].kind == TokKind::Word && w[1].text == "(" && SIDE_EFFECT_FUNCS.contains(&w[0].text.as_str()))
        || words.iter().any(|t| t.text == "XP_CMDSHELL");
    if calls_side_effect {
        flags.push(Flag::SideEffectFunction);
        if risk < Risk::Admin {
            risk = Risk::Admin;
        }
    }

    Classified { index, verb, risk, flags, start: st.start, end: st.end, excerpt: excerpt(&st.text) }
}

fn is_readonly_pragma(name: &str) -> bool {
    matches!(
        name,
        "TABLE_INFO"
            | "TABLE_XINFO"
            | "INDEX_LIST"
            | "INDEX_INFO"
            | "INDEX_XINFO"
            | "FOREIGN_KEY_LIST"
            | "INTEGRITY_CHECK"
            | "QUICK_CHECK"
            | "FUNCTION_LIST"
            | "PRAGMA_LIST"
            | "COLLATION_LIST"
            | "DATABASE_LIST"
            | "TABLE_LIST"
    )
}

/// Index (in `toks`) of a WHERE at paren depth 0, if any.
fn top_level_where(toks: &[Token]) -> Option<usize> {
    let mut depth = 0i32;
    for (i, t) in toks.iter().enumerate() {
        match t.text.as_str() {
            "(" => depth += 1,
            ")" => depth -= 1,
            _ if depth == 0 && t.is_kw("WHERE") => return Some(i),
            _ => {}
        }
    }
    None
}

/// For `WITH ... <main>`: the first DML/SELECT keyword at paren depth 0 after the CTE list.
fn main_dml_after_cte(toks: &[Token]) -> Option<&'static str> {
    let mut depth = 0i32;
    for t in toks.iter().skip(1) {
        match t.text.as_str() {
            "(" => depth += 1,
            ")" => depth -= 1,
            "SELECT" if depth == 0 && t.kind == TokKind::Word => return Some("SELECT"),
            "INSERT" if depth == 0 && t.kind == TokKind::Word => return Some("INSERT"),
            "UPDATE" if depth == 0 && t.kind == TokKind::Word => return Some("UPDATE"),
            "DELETE" if depth == 0 && t.kind == TokKind::Word => return Some("DELETE"),
            _ => {}
        }
    }
    None
}

/// `WHERE TRUE`, `WHERE 1`, `WHERE 1=1`, `WHERE 'a'='a'` (and nothing else follows except LIMIT/RETURNING/ORDER).
fn is_tautology(rest: &[Token]) -> bool {
    let end = rest.iter().position(|t| t.kind == TokKind::Word && matches!(t.text.as_str(), "LIMIT" | "RETURNING" | "ORDER" | "OR")).unwrap_or(rest.len());
    let cond: Vec<&str> = rest[..end].iter().map(|t| t.text.as_str()).filter(|s| *s != "(" && *s != ")").collect();
    match cond.as_slice() {
        ["TRUE"] | ["1"] => true,
        [a, "=", b] => a == b && !rest[..end].iter().any(|t| t.kind == TokKind::Word && t.text != "TRUE"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(sql: &str, d: Dialect) -> Classified {
        let v = classify_script(sql, d);
        assert_eq!(v.len(), 1, "{sql}");
        v.into_iter().next().unwrap()
    }
    fn risk(sql: &str) -> Risk {
        one(sql, Dialect::Postgres).risk
    }

    #[test]
    fn reads() {
        assert_eq!(risk("select * from t where a = 1"), Risk::Read);
        assert_eq!(risk("  -- c\n /* x */ SELECT 1"), Risk::Read);
        assert_eq!(risk("with x as (select 1) select * from x"), Risk::Read);
        assert_eq!(risk("explain select 1"), Risk::Read);
        assert_eq!(risk("explain analyze select 1"), Risk::Read);
        assert_eq!(one("show tables", Dialect::MySql).risk, Risk::Read);
        assert_eq!(one("pragma table_info('t')", Dialect::Sqlite).risk, Risk::Read);
    }

    #[test]
    fn writes_and_where() {
        assert_eq!(risk("insert into t values (1)"), Risk::Write);
        assert_eq!(risk("update t set a = 1 where id = 2"), Risk::Write);
        let c = one("update t set a = (select 1 where true)", Dialect::Postgres);
        assert_eq!(c.risk, Risk::Destructive);
        assert!(c.flags.contains(&Flag::NoWhereClause));
        assert_eq!(risk("delete from t"), Risk::Destructive);
        assert_eq!(risk("delete from t where 1=1"), Risk::Destructive);
        assert_eq!(risk("delete from t where true"), Risk::Destructive);
        assert_eq!(risk("delete from t where id = id"), Risk::Write); // column comparison, not a literal tautology
        assert_eq!(risk("delete from t where id = 1"), Risk::Write);
    }

    #[test]
    fn writable_cte() {
        let c = one("with d as (delete from t returning *) select * from d", Dialect::Postgres);
        assert!(c.flags.contains(&Flag::WritableCte));
        assert!(c.risk >= Risk::Write);
        let c = one("with x as (select 1) delete from t", Dialect::Postgres);
        assert_eq!(c.risk, Risk::Destructive);
    }

    #[test]
    fn explain_analyze_executes_writes() {
        let c = one("explain analyze delete from t where id = 1", Dialect::Postgres);
        assert!(c.flags.contains(&Flag::ExplainAnalyzeExecutes));
        assert_eq!(c.risk, Risk::Write);
    }

    #[test]
    fn ddl_and_admin() {
        assert_eq!(risk("create table t (id int)"), Risk::Schema);
        assert_eq!(risk("drop table t"), Risk::Destructive);
        assert_eq!(risk("truncate t"), Risk::Destructive);
        assert_eq!(risk("alter table t drop column a"), Risk::Destructive);
        let c = one("alter table t alter column a type bigint", Dialect::Postgres);
        assert!(c.flags.contains(&Flag::MayRewriteTable));
        assert_eq!(risk("grant select on t to bob"), Risk::Admin);
        assert_eq!(risk("create role x"), Risk::Admin);
        assert_eq!(risk("vacuum full"), Risk::Admin);
        assert_eq!(risk("alter system set work_mem = '1GB'"), Risk::Admin);
        assert!(one("create index i on t(a)", Dialect::Postgres).flags.contains(&Flag::MayLockTable));
        assert!(!one("create index concurrently i on t(a)", Dialect::Postgres).flags.contains(&Flag::MayLockTable));
    }

    #[test]
    fn side_effects_inside_select() {
        assert_eq!(risk("select pg_terminate_backend(123)"), Risk::Admin);
        assert_eq!(risk("select nextval('s')"), Risk::Admin);
        assert_eq!(one("select * into outfile '/tmp/x' from t", Dialect::MySql).risk, Risk::Admin);
        assert_eq!(risk("select * into newtable from t"), Risk::Write);
        assert_eq!(risk("copy t to program 'rm -rf /'"), Risk::Admin);
    }

    #[test]
    fn unknowns() {
        assert_eq!(risk("call do_things()"), Risk::Unknown);
        assert_eq!(risk("do $$ begin delete from t; end $$"), Risk::Unknown);
        assert_eq!(one("exec sp_who", Dialect::SqlServer).risk, Risk::Unknown);
        assert_eq!(risk("frobnicate the database"), Risk::Unknown);
    }

    #[test]
    fn read_only_bypass_attempts_are_flagged() {
        for s in [
            "set session characteristics as transaction read write",
            "set default_transaction_read_only = off",
            "set transaction_read_only = off",
            "reset all",
            "discard all",
            "set role admin",
            "set session authorization postgres",
        ] {
            let c = one(s, Dialect::Postgres);
            assert!(c.flags.contains(&Flag::DisablesReadOnly), "{s}");
        }
        assert!(one("SET SESSION TRANSACTION READ WRITE", Dialect::MySql).flags.contains(&Flag::DisablesReadOnly));
        assert_eq!(one("pragma query_only = 0", Dialect::Sqlite).risk, Risk::Admin);
    }

    #[test]
    fn keyword_inside_string_is_not_a_keyword() {
        assert_eq!(risk("select 'drop table x; delete from y'"), Risk::Read);
        assert_eq!(risk("select \"delete\" from t"), Risk::Read);
    }

    #[test]
    fn multi_statement_script() {
        let v = classify_script("select 1; delete from t; drop table x", Dialect::Postgres);
        let r: Vec<Risk> = v.iter().map(|c| c.risk).collect();
        assert_eq!(r, vec![Risk::Read, Risk::Destructive, Risk::Destructive]);
    }
}
