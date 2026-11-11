//! Redaction applied to everything before it can appear in a prompt.

/// SQL text: credentials are always removed; literals (strings and numbers)
/// become `?` when `literals` is set.
pub fn redact_sql(sql: &str, literals: bool) -> String {
    let s = redact_credential_literals(sql);
    let s = dbs_core::redact_secrets(&s);
    if literals {
        dbs_audit::redact_literals(&s)
    } else {
        s
    }
}

/// Natural-language text (e.g. "top 10 customers"): only secrets are removed;
/// literal redaction would destroy the meaning.
pub fn redact_free_text(s: &str) -> String {
    dbs_core::redact_secrets(&redact_credential_literals(s))
}

/// Error messages and plans: secrets are removed; with `literals`, quoted
/// values ('…') and PostgreSQL detail values `Key (col)=(value)` become `?`.
/// Numbers are kept (costs, row estimates and positions matter here).
pub fn redact_quoted_values(s: &str, literals: bool) -> String {
    let s = redact_free_text(s);
    if !literals {
        return s;
    }
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\'' {
            for n in chars.by_ref() {
                if n == '\'' {
                    break;
                }
            }
            out.push_str("'?'");
        } else if c == '=' && out.ends_with(')') && chars.peek() == Some(&'(') {
            // Key (email)=(alice@example.com) → Key (email)=(?)
            chars.next();
            let mut depth = 1;
            for n in chars.by_ref() {
                match n {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
            }
            out.push_str("=(?)");
        } else {
            out.push(c);
        }
    }
    out
}

/// `PASSWORD 'x'`, `IDENTIFIED BY 'x'`, `PASSWORD = 'x'` → `'***'`, regardless
/// of the literal-redaction setting.
fn redact_credential_literals(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let rest = &lower[i..];
        let kw = ["password", "identified by"].iter().find(|k| rest.starts_with(**k)).map(|k| k.len());
        if let Some(k) = kw {
            out.push_str(&s[i..i + k]);
            i += k;
            let mut j = i;
            let b = s.as_bytes();
            while j < b.len() && (b[j] == b' ' || b[j] == b'=' || b[j] == b'\t') {
                j += 1;
            }
            if j < b.len() && (b[j] == b'\'' || b[j] == b'"') {
                let q = b[j];
                let mut end = j + 1;
                while end < b.len() && b[end] != q {
                    end += 1;
                }
                out.push_str(&s[i..j]);
                out.push(q as char);
                out.push_str("***");
                out.push(q as char);
                i = (end + 1).min(s.len());
            }
            continue;
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_password_assignments_and_url_userinfo() {
        let r = redact_sql("-- conn: postgres://admin:hunter2@db.example.com/app password=hunter2\nSELECT 1", false);
        assert!(!r.contains("hunter2"), "{r}");
        assert!(r.contains("admin:***@db.example.com"), "{r}");
        let r = redact_free_text("connect with pwd=s3cr3t and token=abc");
        assert!(!r.contains("s3cr3t") && !r.contains("abc"), "{r}");
    }

    #[test]
    fn removes_password_literals_even_without_literal_redaction() {
        let r = redact_sql("ALTER USER bob WITH PASSWORD 'Tr0ub4dor';", false);
        assert!(!r.contains("Tr0ub4dor"), "{r}");
        let r = redact_sql("CREATE USER 'x'@'%' IDENTIFIED BY \"pa'ss\"", false);
        assert!(!r.contains("pa'ss"), "{r}");
    }

    #[test]
    fn literals_redacted_when_enabled_only() {
        let sql = "SELECT * FROM users WHERE email = 'alice@example.com' AND age > 42";
        let on = redact_sql(sql, true);
        assert!(!on.contains("alice@example.com") && !on.contains("42"), "{on}");
        assert!(on.contains("users") && on.contains("email"), "identifiers kept: {on}");
        let off = redact_sql(sql, false);
        assert!(off.contains("alice@example.com"));
    }

    #[test]
    fn error_values_redacted() {
        let e = "ERROR: duplicate key value violates unique constraint \"users_email_key\"\nDETAIL: Key (email)=(alice@example.com) already exists.";
        let r = redact_quoted_values(e, true);
        assert!(!r.contains("alice@example.com"), "{r}");
        assert!(r.contains("users_email_key") && r.contains("Key (email)=(?)"), "{r}");
        let plan = "Seq Scan on users  (cost=0.00..35.50 rows=10 width=4)\n  Filter: (email = 'bob@example.com'::text)";
        let r = redact_quoted_values(plan, true);
        assert!(!r.contains("bob@example.com") && r.contains("cost=0.00..35.50"), "{r}");
        assert!(redact_quoted_values(plan, false).contains("bob@example.com"));
    }
}
