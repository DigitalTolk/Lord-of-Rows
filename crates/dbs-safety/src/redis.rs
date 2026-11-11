//! Redis command classification. Redis is not SQL: a script is one command per
//! line (`GET key`, `HSET h f v`), tokenised with shell-style quoting. Every
//! command the app runs for the user (query tab, key browser edits) is
//! classified here before it reaches the driver.

use crate::{Classified, Risk};

/// Risk of one Redis command (by name, case-insensitive). Unknown commands are writes.
pub fn classify_redis(cmd: &str) -> Risk {
    match cmd.to_ascii_uppercase().as_str() {
        "GET" | "MGET" | "EXISTS" | "TYPE" | "TTL" | "PTTL" | "EXPIRETIME" | "PEXPIRETIME" | "STRLEN" | "HGET" | "HGETALL" | "HMGET" | "HKEYS" | "HVALS"
        | "HLEN" | "HEXISTS" | "HSTRLEN" | "HRANDFIELD" | "LRANGE" | "LLEN" | "LINDEX" | "LPOS" | "SMEMBERS" | "SCARD" | "SISMEMBER" | "SMISMEMBER"
        | "SRANDMEMBER" | "SINTER" | "SUNION" | "SDIFF" | "ZRANGE" | "ZRANGEBYSCORE" | "ZRANGEBYLEX" | "ZREVRANGE" | "ZREVRANGEBYSCORE" | "ZCARD"
        | "ZSCORE" | "ZMSCORE" | "ZRANK" | "ZREVRANK" | "ZCOUNT" | "ZLEXCOUNT" | "SCAN" | "HSCAN" | "SSCAN" | "ZSCAN" | "INFO" | "DBSIZE" | "PING" | "ECHO"
        | "XRANGE" | "XREVRANGE" | "XLEN" | "XINFO" | "OBJECT" | "MEMORY" | "GETRANGE" | "SUBSTR" | "BITCOUNT" | "BITPOS" | "GETBIT" | "PFCOUNT" | "GEOPOS"
        | "GEODIST" | "GEOHASH" | "GEOSEARCH" | "TIME" | "LASTSAVE" | "ROLE" | "RANDOMKEY" | "TOUCH" | "DUMP" | "LCS" | "JSON.GET" | "JSON.MGET"
        | "JSON.TYPE" | "JSON.STRLEN" | "JSON.ARRLEN" | "JSON.OBJLEN" | "JSON.OBJKEYS" | "JSON.RESP" | "COMMAND" => Risk::Read,
        // Session state only (selected database, protocol, client name).
        "SELECT" | "READONLY" | "READWRITE" | "HELLO" | "AUTH" | "RESET" | "QUIT" => Risk::Session,
        "FLUSHALL" | "FLUSHDB" | "DEL" | "UNLINK" | "SWAPDB" => Risk::Destructive,
        "CONFIG" | "SHUTDOWN" | "DEBUG" | "SLAVEOF" | "REPLICAOF" | "MODULE" | "ACL" | "CLIENT" | "SAVE" | "BGSAVE" | "BGREWRITEAOF" | "MIGRATE"
        | "FAILOVER" | "CLUSTER" | "SCRIPT" | "FUNCTION" | "KEYS" | "MONITOR" | "SYNC" | "PSYNC" | "LATENCY" | "SLOWLOG" => Risk::Admin,
        "EVAL" | "EVALSHA" | "EVAL_RO" | "EVALSHA_RO" | "FCALL" | "FCALL_RO" | "MULTI" | "EXEC" => Risk::Unknown,
        _ => Risk::Write,
    }
}

/// Split one command line respecting "double", 'single' quotes and backslash
/// escapes (`\n`, `\r`, `\t`, `\\`, `\"` inside double quotes).
pub fn tokenize_command(line: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_tok = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' | '\'' => {
                in_tok = true;
                let q = c;
                loop {
                    match chars.next() {
                        Some('\\') if q == '"' => match chars.next() {
                            Some('n') => cur.push('\n'),
                            Some('r') => cur.push('\r'),
                            Some('t') => cur.push('\t'),
                            Some(o) => cur.push(o),
                            None => return Err("unterminated escape".into()),
                        },
                        Some(x) if x == q => break,
                        Some(x) => cur.push(x),
                        None => return Err("unterminated quote".into()),
                    }
                }
            }
            c if c.is_whitespace() => {
                if in_tok {
                    out.push(std::mem::take(&mut cur));
                    in_tok = false;
                }
            }
            c => {
                in_tok = true;
                cur.push(c);
            }
        }
    }
    if in_tok {
        out.push(cur);
    }
    Ok(out)
}

/// Quote one argument so [`tokenize_command`] reads it back unchanged.
pub fn quote_arg(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Classify a script (one command per line; blank lines and `#` comments skipped).
/// A line that does not tokenise is reported as `Unknown`.
pub fn classify_redis_script(script: &str) -> Vec<Classified> {
    let mut pos = 0;
    let mut out = Vec::new();
    for (i, l) in script.split('\n').enumerate() {
        let start = pos;
        pos += l.len() + 1;
        let t = l.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let (verb, risk) = match tokenize_command(t).ok().and_then(|v| v.into_iter().next()) {
            Some(cmd) => (cmd.to_ascii_uppercase(), classify_redis(&cmd)),
            None => ("?".to_string(), Risk::Unknown),
        };
        out.push(Classified { index: i, verb, risk, flags: vec![], start, end: start + l.len(), excerpt: t.chars().take(200).collect() });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{evaluate_classified, ConfirmationGuard, Decision, SafetyPolicy};
    use dbs_core::EnvironmentKind;

    #[test]
    fn classifies_commands() {
        assert_eq!(classify_redis("get"), Risk::Read);
        assert_eq!(classify_redis("SCAN"), Risk::Read);
        assert_eq!(classify_redis("memory"), Risk::Read);
        assert_eq!(classify_redis("JSON.GET"), Risk::Read);
        assert_eq!(classify_redis("select"), Risk::Session);
        assert_eq!(classify_redis("set"), Risk::Write);
        assert_eq!(classify_redis("HSET"), Risk::Write);
        assert_eq!(classify_redis("renamenx"), Risk::Write);
        assert_eq!(classify_redis("PERSIST"), Risk::Write);
        assert_eq!(classify_redis("DEL"), Risk::Destructive);
        assert_eq!(classify_redis("unlink"), Risk::Destructive);
        assert_eq!(classify_redis("FLUSHDB"), Risk::Destructive);
        assert_eq!(classify_redis("flushall"), Risk::Destructive);
        assert_eq!(classify_redis("KEYS"), Risk::Admin);
        assert_eq!(classify_redis("config"), Risk::Admin);
        assert_eq!(classify_redis("eval"), Risk::Unknown);
    }

    #[test]
    fn tokenizes_and_quotes_roundtrip() {
        assert_eq!(tokenize_command(r#"SET "my key" 'a b' c\d"#).unwrap(), vec!["SET", "my key", "a b", "c\\d"]);
        assert_eq!(tokenize_command(r#"SET k "line\nnext""#).unwrap(), vec!["SET", "k", "line\nnext"]);
        assert!(tokenize_command("SET \"oops").is_err());
        for s in ["plain", "with space", "q\"uote", "back\\slash", "multi\nline\r\ttab", "", "ünï ☃"] {
            assert_eq!(tokenize_command(&format!("SET {} x", quote_arg(s))).unwrap(), vec!["SET", s, "x"], "{s:?}");
        }
    }

    #[test]
    fn script_policy() {
        let g = ConfirmationGuard::new([3; 32]);
        let script = "SELECT 1\nHSET \"h\" \"f\" \"v\"\nUNLINK \"k\"";
        let c = classify_redis_script(script);
        assert_eq!(c.iter().map(|x| x.risk).collect::<Vec<_>>(), vec![Risk::Session, Risk::Write, Risk::Destructive]);
        assert_eq!(&script[c[2].start..c[2].end], "UNLINK \"k\"");
        // Read-only: writes are blocked, selecting a database is not.
        let ro = evaluate_classified(c.clone(), script, &SafetyPolicy::read_only(), &g, "c", "n");
        assert!(matches!(ro.decision, Decision::Block { ref findings } if findings.len() == 2));
        let sel = evaluate_classified(classify_redis_script("SELECT 2\nGET k"), "SELECT 2\nGET k", &SafetyPolicy::read_only(), &g, "c", "n");
        assert_eq!(sel.decision, Decision::Allow);
        // Production: confirmation with the typed connection name for the destructive UNLINK.
        let prod = evaluate_classified(c, script, &SafetyPolicy::for_environment(EnvironmentKind::Production), &g, "c", "Prod");
        assert!(matches!(prod.decision, Decision::Confirm { typed_phrase: Some(ref p), .. } if p == "Prod"));
        // Production without destructive commands: confirmation, no typed phrase.
        let w = "SELECT 0\nSET \"a\" \"b\"";
        let prod = evaluate_classified(classify_redis_script(w), w, &SafetyPolicy::for_environment(EnvironmentKind::Production), &g, "c", "Prod");
        assert!(matches!(prod.decision, Decision::Confirm { typed_phrase: None, .. }));
    }
}
