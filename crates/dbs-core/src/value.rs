use serde::{Deserialize, Serialize};

/// A database cell value as it crosses the IPC boundary.
///
/// Precision rules:
/// * 64-bit integers outside the JS safe range and all decimals travel as strings
///   so the frontend never rounds them through `f64`.
/// * Temporal values are ISO-8601 strings; the `tz` flag tells whether the source
///   type carried an offset, so naive timestamps are never shifted.
/// * `Null` is distinct from `Text("")`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "snake_case")]
pub enum Value {
    Null,
    Bool(bool),
    /// Fits in i53 so JS can represent it exactly.
    Int(i64),
    /// Integers needing more than 53 bits (and unsigned 64-bit) as decimal text.
    BigInt(String),
    Float(f64),
    /// Exact decimal / numeric as text.
    Decimal(String),
    Text(String),
    /// Hex-encoded with a size cap; `truncated` set when only a prefix is included.
    Bytes {
        hex: String,
        len: u64,
        truncated: bool,
    },
    Json(serde_json::Value),
    Uuid(String),
    Date(String),
    Time(String),
    Timestamp {
        iso: String,
        tz: bool,
    },
    Array(Vec<Value>),
    /// Engine-specific value rendered as text with its native type name.
    Other {
        type_name: String,
        text: String,
    },
}

pub const JS_MAX_SAFE_INT: i64 = 9_007_199_254_740_991;
pub const MAX_INLINE_BYTES: usize = 64 * 1024;

impl Value {
    pub fn from_i64(v: i64) -> Self {
        if (-JS_MAX_SAFE_INT..=JS_MAX_SAFE_INT).contains(&v) {
            Value::Int(v)
        } else {
            Value::BigInt(v.to_string())
        }
    }
    pub fn from_u64(v: u64) -> Self {
        if v <= JS_MAX_SAFE_INT as u64 {
            Value::Int(v as i64)
        } else {
            Value::BigInt(v.to_string())
        }
    }
    pub fn from_bytes(b: &[u8]) -> Self {
        let truncated = b.len() > MAX_INLINE_BYTES;
        let slice = if truncated { &b[..MAX_INLINE_BYTES] } else { b };
        Value::Bytes { hex: hex_encode(slice), len: b.len() as u64, truncated }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// Plain text rendering used by exporters (CSV/TSV/Markdown). `None` for NULL.
    pub fn to_plain(&self) -> Option<String> {
        Some(match self {
            Value::Null => return None,
            Value::Bool(b) => b.to_string(),
            Value::Int(i) => i.to_string(),
            Value::BigInt(s) | Value::Decimal(s) | Value::Text(s) | Value::Uuid(s) => s.clone(),
            Value::Float(f) => f.to_string(),
            Value::Bytes { hex, .. } => format!("\\x{hex}"),
            Value::Json(j) => j.to_string(),
            Value::Date(s) | Value::Time(s) => s.clone(),
            Value::Timestamp { iso, .. } => iso.clone(),
            Value::Array(items) => {
                let parts: Vec<String> = items.iter().map(|v| v.to_plain().unwrap_or_else(|| "NULL".into())).collect();
                format!("{{{}}}", parts.join(","))
            }
            Value::Other { text, .. } => text.clone(),
        })
    }
}

/// Compact wire form for result rows (≈3× smaller than the tagged form):
/// * `null`, `true/false`, JSON numbers for `Int` and finite `Float`,
/// * strings for Text/BigInt/Decimal/Uuid/Date/Time/Timestamp (types recovered
///   from column metadata on the client; big integers/decimals stay exact strings),
/// * the normal tagged object for Bytes/Json/Array/Other and non-finite floats.
pub mod compact {
    use super::Value;
    use serde::ser::{SerializeSeq, Serializer};
    use serde::Serialize;

    struct Cell<'a>(&'a Value);

    impl Serialize for Cell<'_> {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            match self.0 {
                Value::Null => s.serialize_unit(),
                Value::Bool(b) => s.serialize_bool(*b),
                Value::Int(i) => s.serialize_i64(*i),
                Value::Float(f) if f.is_finite() => s.serialize_f64(*f),
                Value::BigInt(v) | Value::Decimal(v) | Value::Text(v) | Value::Uuid(v) | Value::Date(v) | Value::Time(v) => s.serialize_str(v),
                Value::Timestamp { iso, .. } => s.serialize_str(iso),
                // NaN/±Infinity aren't JSON numbers: send them as typed text.
                Value::Float(f) => Value::Other { type_name: "float".into(), text: f.to_string() }.serialize(s),
                other => other.serialize(s),
            }
        }
    }

    struct Row<'a>(&'a [Value]);

    impl Serialize for Row<'_> {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            let mut seq = s.serialize_seq(Some(self.0.len()))?;
            for v in self.0 {
                seq.serialize_element(&Cell(v))?;
            }
            seq.end()
        }
    }

    pub fn serialize_rows<S: Serializer>(rows: &[Vec<Value>], s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(rows.len()))?;
        for r in rows {
            seq.serialize_element(&Row(r))?;
        }
        seq.end()
    }
}

pub fn hex_encode(b: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push(HEX[(byte >> 4) as usize] as char);
        s.push(HEX[(byte & 0xf) as usize] as char);
    }
    s
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.strip_prefix("\\x").or_else(|| s.strip_prefix("0x")).unwrap_or(s);
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_ints_become_strings() {
        assert_eq!(Value::from_i64(42), Value::Int(42));
        assert_eq!(Value::from_i64(i64::MAX), Value::BigInt("9223372036854775807".into()));
        assert_eq!(Value::from_u64(u64::MAX), Value::BigInt("18446744073709551615".into()));
        assert_eq!(Value::from_i64(-JS_MAX_SAFE_INT - 1), Value::BigInt("-9007199254740992".into()));
    }

    #[test]
    fn null_vs_empty() {
        assert_eq!(Value::Null.to_plain(), None);
        assert_eq!(Value::Text(String::new()).to_plain(), Some(String::new()));
    }

    #[test]
    fn bytes_roundtrip_and_truncate() {
        let v = Value::from_bytes(&[0xde, 0xad]);
        assert_eq!(v, Value::Bytes { hex: "dead".into(), len: 2, truncated: false });
        assert_eq!(hex_decode("\\xdead").unwrap(), vec![0xde, 0xad]);
        let big = vec![0u8; MAX_INLINE_BYTES + 1];
        match Value::from_bytes(&big) {
            Value::Bytes { truncated, len, hex } => {
                assert!(truncated);
                assert_eq!(len as usize, MAX_INLINE_BYTES + 1);
                assert_eq!(hex.len(), MAX_INLINE_BYTES * 2);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn compact_rows_shape() {
        let rs = crate::ResultSet {
            columns: vec![],
            rows: vec![vec![
                Value::Null,
                Value::Bool(true),
                Value::Int(7),
                Value::Float(1.5),
                Value::BigInt("9223372036854775807".into()),
                Value::Decimal("0.10".into()),
                Value::Text("".into()),
                Value::Timestamp { iso: "2024-01-01T00:00:00Z".into(), tz: true },
                Value::Json(serde_json::json!({"a": 1})),
                Value::Float(f64::NAN),
            ]],
            truncated: false,
        };
        let j = serde_json::to_value(&rs).unwrap();
        assert_eq!(
            j["rows"][0],
            serde_json::json!([null, true, 7, 1.5, "9223372036854775807", "0.10", "", "2024-01-01T00:00:00Z", {"t": "json", "v": {"a": 1}}, {"t": "other", "v": {"type_name": "float", "text": "NaN"}}])
        );
    }

    #[test]
    fn serde_shape_is_tagged() {
        let j = serde_json::to_string(&Value::BigInt("1".into())).unwrap();
        assert_eq!(j, r#"{"t":"big_int","v":"1"}"#);
        let j = serde_json::to_string(&Value::Null).unwrap();
        assert_eq!(j, r#"{"t":"null"}"#);
    }
}
