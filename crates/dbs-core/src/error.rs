use serde::{Deserialize, Serialize};

/// Normalised error category. Drivers map native errors into one of these so the
/// UI can offer consistent guidance. Messages must never contain secrets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Connection,
    Authentication,
    Tls,
    Ssh,
    Permission,
    Syntax,
    Constraint,
    TransactionConflict,
    Timeout,
    Cancelled,
    NotFound,
    Unsupported,
    InvalidInput,
    PolicyBlocked,
    ConfirmationRequired,
    Io,
    Internal,
}

#[derive(Debug, Clone, thiserror::Error, Serialize, Deserialize)]
#[error("{kind:?}: {message}")]
pub struct DbError {
    pub kind: ErrorKind,
    pub message: String,
    /// Native vendor code (e.g. SQLSTATE `23505`, MySQL `1062`).
    pub code: Option<String>,
    /// Safe, user-facing hint.
    pub hint: Option<String>,
}

impl DbError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: redact_secrets(&message.into()), code: None, hint: None }
    }
    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    pub fn unsupported(what: &str) -> Self {
        Self::new(ErrorKind::Unsupported, format!("{what} is not supported by this engine"))
    }
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidInput, msg)
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, msg)
    }
}

pub type DbResult<T> = Result<T, DbError>;

/// Best-effort redaction of credential-looking fragments in error text.
/// Drivers sometimes echo connection strings; this strips `password=...`,
/// `pwd=...` and `scheme://user:pass@` userinfo.
pub fn redact_secrets(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let lower = input.to_ascii_lowercase();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rest = &lower[i..];
        let key_len = ["password=", "pwd=", "passwd=", "secret=", "token="]
            .iter()
            .find(|k| rest.starts_with(**k))
            .map(|k| k.len());
        if let Some(k) = key_len {
            out.push_str(&input[i..i + k]);
            out.push_str("***");
            i += k;
            while i < bytes.len() && !matches!(bytes[i], b' ' | b';' | b'&' | b'\'' | b'"') {
                i += 1;
            }
            continue;
        }
        if rest.starts_with("://") {
            out.push_str("://");
            i += 3;
            // userinfo ends at '@' before the next '/', whitespace or end
            let tail = &input[i..];
            let end = tail.find(|c: char| c == '/' || c.is_whitespace()).unwrap_or(tail.len());
            if let Some(at) = tail[..end].rfind('@') {
                let userinfo = &tail[..at];
                if let Some(colon) = userinfo.find(':') {
                    out.push_str(&userinfo[..colon]);
                    out.push_str(":***");
                } else {
                    out.push_str(userinfo);
                }
                out.push('@');
                i += at + 1;
            }
            continue;
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_key_value_passwords() {
        let s = redact_secrets("could not connect host=x password=hunter2 user=bob");
        assert!(!s.contains("hunter2"), "{s}");
        assert!(s.contains("password=***"));
        assert!(s.contains("user=bob"));
    }

    #[test]
    fn redacts_url_userinfo() {
        let s = redact_secrets("failed: postgres://alice:s3cr3t@db.local:5432/app");
        assert_eq!(s, "failed: postgres://alice:***@db.local:5432/app");
    }

    #[test]
    fn leaves_plain_text_alone() {
        assert_eq!(redact_secrets("syntax error near 'FROM'"), "syntax error near 'FROM'");
        assert_eq!(redact_secrets("ünïcödé ok"), "ünïcödé ok");
    }

    #[test]
    fn new_error_is_redacted() {
        let e = DbError::new(ErrorKind::Connection, "mysql://root:pw@h/db");
        assert!(!e.message.contains(":pw@"));
    }
}
