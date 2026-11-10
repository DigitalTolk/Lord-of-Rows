//! Lossless decoding/encoding of PostgreSQL binary wire values to `dbs_core::Value`.
//! NUMERIC is converted digit-by-digit (never through f64); int8 beyond 2^53
//! becomes `BigInt`; timestamps without time zone stay naive.

use std::error::Error;

use bytes::{BufMut, BytesMut};
use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime};
use dbs_core::{hex_decode, Value};
use tokio_postgres::types::{FromSql, IsNull, Kind, ToSql, Type};

type BoxErr = Box<dyn Error + Sync + Send>;

pub struct PgAny(pub Value);

fn be_i16(b: &[u8], at: usize) -> Result<i16, BoxErr> {
    Ok(i16::from_be_bytes(b.get(at..at + 2).ok_or("short")?.try_into()?))
}
fn be_i32(b: &[u8], at: usize) -> Result<i32, BoxErr> {
    Ok(i32::from_be_bytes(b.get(at..at + 4).ok_or("short")?.try_into()?))
}
fn be_i64(b: &[u8], at: usize) -> Result<i64, BoxErr> {
    Ok(i64::from_be_bytes(b.get(at..at + 8).ok_or("short")?.try_into()?))
}

fn epoch_date() -> NaiveDate {
    NaiveDate::from_ymd_opt(2000, 1, 1).unwrap()
}

pub fn decode_numeric(b: &[u8]) -> Result<String, BoxErr> {
    let ndigits = be_i16(b, 0)? as usize;
    let weight = be_i16(b, 2)? as i32;
    let sign = be_i16(b, 4)? as u16;
    let dscale = be_i16(b, 6)? as usize;
    match sign {
        0xC000 => return Ok("NaN".into()),
        0xD000 => return Ok("Infinity".into()),
        0xF000 => return Ok("-Infinity".into()),
        _ => {}
    }
    let mut digits = Vec::with_capacity(ndigits);
    for i in 0..ndigits {
        digits.push(be_i16(b, 8 + 2 * i)?);
    }
    let group = |i: i32| -> i16 {
        if i >= 0 && (i as usize) < digits.len() {
            digits[i as usize]
        } else {
            0
        }
    };
    let mut s = String::new();
    if sign == 0x4000 {
        s.push('-');
    }
    if weight < 0 {
        s.push('0');
    } else {
        for i in 0..=weight {
            if i == 0 {
                s.push_str(&group(i).to_string());
            } else {
                s.push_str(&format!("{:04}", group(i)));
            }
        }
    }
    if dscale > 0 {
        s.push('.');
        let mut frac = String::new();
        let mut i = weight + 1;
        while frac.len() < dscale {
            frac.push_str(&format!("{:04}", group(i)));
            i += 1;
        }
        frac.truncate(dscale);
        s.push_str(&frac);
    }
    if s == "-0" || (s.starts_with("-0") && s[1..].chars().all(|c| c == '0' || c == '.')) {
        s.remove(0);
    }
    Ok(s)
}

pub fn encode_numeric(text: &str, out: &mut BytesMut) -> Result<(), BoxErr> {
    let t = text.trim();
    if t == "NaN" {
        out.put_i16(0);
        out.put_i16(0);
        out.put_u16(0xC000);
        out.put_i16(0);
        return Ok(());
    }
    let (neg, body) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let (int_part, frac_part) = body.split_once('.').unwrap_or((body, ""));
    if int_part.is_empty() && frac_part.is_empty() || !int_part.chars().all(|c| c.is_ascii_digit()) || !frac_part.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("invalid numeric literal: {text}").into());
    }
    let int_part = int_part.trim_start_matches('0');
    let dscale = frac_part.len();
    let pad_l = (4 - int_part.len() % 4) % 4;
    let pad_r = (4 - frac_part.len() % 4) % 4;
    let ints = format!("{}{}", "0".repeat(pad_l), int_part);
    let fracs = format!("{}{}", frac_part, "0".repeat(pad_r));
    let mut groups: Vec<i16> = Vec::new();
    for ch in ints.as_bytes().chunks(4).chain(fracs.as_bytes().chunks(4)) {
        groups.push(std::str::from_utf8(ch)?.parse()?);
    }
    let mut weight = (ints.len() / 4) as i32 - 1;
    // strip leading zero groups
    while groups.first() == Some(&0) {
        groups.remove(0);
        weight -= 1;
    }
    while groups.last() == Some(&0) {
        groups.pop();
    }
    if groups.is_empty() {
        weight = 0;
    }
    out.put_i16(groups.len() as i16);
    out.put_i16(weight as i16);
    out.put_u16(if neg && !groups.is_empty() { 0x4000 } else { 0 });
    out.put_u16(dscale as u16);
    for g in groups {
        out.put_i16(g);
    }
    Ok(())
}

fn fmt_uuid(b: &[u8]) -> String {
    let h = dbs_core::hex_encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn fmt_micros_time(us: i64) -> String {
    let t = NaiveTime::from_hms_opt(0, 0, 0).unwrap() + Duration::microseconds(us);
    t.format("%H:%M:%S%.f").to_string()
}

fn decode(ty: &Type, raw: &[u8]) -> Result<Value, BoxErr> {
    if let Kind::Domain(inner) = ty.kind() {
        return decode(inner, raw);
    }
    if let Kind::Enum(_) = ty.kind() {
        return Ok(Value::Text(std::str::from_utf8(raw)?.to_string()));
    }
    if let Kind::Array(elem) = ty.kind() {
        return decode_array(elem, raw);
    }
    Ok(match *ty {
        Type::BOOL => Value::Bool(raw.first().copied().unwrap_or(0) != 0),
        Type::INT2 => Value::Int(be_i16(raw, 0)? as i64),
        Type::INT4 => Value::Int(be_i32(raw, 0)? as i64),
        Type::INT8 => Value::from_i64(be_i64(raw, 0)?),
        Type::OID | Type::XID | Type::CID | Type::REGPROC | Type::REGCLASS | Type::REGTYPE => {
            Value::Int(u32::from_be_bytes(raw.get(0..4).ok_or("short")?.try_into()?) as i64)
        }
        Type::FLOAT4 => Value::Float(f32::from_be_bytes(raw.get(0..4).ok_or("short")?.try_into()?) as f64),
        Type::FLOAT8 => Value::Float(f64::from_be_bytes(raw.get(0..8).ok_or("short")?.try_into()?)),
        Type::NUMERIC => Value::Decimal(decode_numeric(raw)?),
        Type::MONEY => {
            let cents = be_i64(raw, 0)?;
            Value::Decimal(format!("{}{}.{:02}", if cents < 0 { "-" } else { "" }, (cents / 100).abs(), (cents % 100).abs()))
        }
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN | Type::XML | Type::CHAR => {
            Value::Text(String::from_utf8_lossy(raw).into_owned())
        }
        Type::BYTEA => Value::from_bytes(raw),
        Type::UUID => Value::Uuid(fmt_uuid(raw.get(0..16).ok_or("short")?)),
        Type::JSON => Value::Json(serde_json::from_slice(raw)?),
        Type::JSONB => Value::Json(serde_json::from_slice(raw.get(1..).ok_or("short")?)?),
        Type::DATE => {
            let d = be_i32(raw, 0)?;
            match d {
                i32::MAX => Value::Date("infinity".into()),
                i32::MIN => Value::Date("-infinity".into()),
                _ => Value::Date((epoch_date() + Duration::days(d as i64)).format("%Y-%m-%d").to_string()),
            }
        }
        Type::TIME => Value::Time(fmt_micros_time(be_i64(raw, 0)?)),
        Type::TIMETZ => {
            let us = be_i64(raw, 0)?;
            let off = -be_i32(raw, 8)?; // stored as seconds west of UTC
            let sign = if off < 0 { '-' } else { '+' };
            let a = off.abs();
            Value::Time(format!("{}{}{:02}:{:02}", fmt_micros_time(us), sign, a / 3600, (a % 3600) / 60))
        }
        Type::TIMESTAMP | Type::TIMESTAMPTZ => {
            let us = be_i64(raw, 0)?;
            let tz = *ty == Type::TIMESTAMPTZ;
            let iso = match us {
                i64::MAX => "infinity".into(),
                i64::MIN => "-infinity".into(),
                _ => {
                    let dt: NaiveDateTime = epoch_date().and_hms_opt(0, 0, 0).unwrap() + Duration::microseconds(us);
                    if tz {
                        format!("{}Z", dt.format("%Y-%m-%dT%H:%M:%S%.f"))
                    } else {
                        dt.format("%Y-%m-%dT%H:%M:%S%.f").to_string()
                    }
                }
            };
            Value::Timestamp { iso, tz }
        }
        Type::INTERVAL => {
            let us = be_i64(raw, 0)?;
            let days = be_i32(raw, 8)?;
            let months = be_i32(raw, 12)?;
            let neg = us < 0;
            let a = us.unsigned_abs();
            let text = format!(
                "{} mons {} days {}{:02}:{:02}:{:02}.{:06}",
                months,
                days,
                if neg { "-" } else { "" },
                a / 3_600_000_000,
                (a / 60_000_000) % 60,
                (a / 1_000_000) % 60,
                a % 1_000_000
            );
            Value::Other { type_name: "interval".into(), text }
        }
        Type::INET | Type::CIDR => {
            let family = raw.first().copied().ok_or("short")?;
            let bits = raw.get(1).copied().ok_or("short")?;
            let addr = raw.get(4..).ok_or("short")?;
            let ip = if family == 2 && addr.len() >= 4 {
                std::net::IpAddr::from(<[u8; 4]>::try_from(&addr[..4])?).to_string()
            } else if addr.len() >= 16 {
                std::net::IpAddr::from(<[u8; 16]>::try_from(&addr[..16])?).to_string()
            } else {
                return Err("bad inet".into());
            };
            let full = if family == 2 { 32 } else { 128 };
            let text = if bits == full && *ty == Type::INET { ip } else { format!("{ip}/{bits}") };
            Value::Other { type_name: ty.name().into(), text }
        }
        _ => {
            // Unknown/extension types (e.g. PostGIS geometry): hex of the binary form,
            // which for geometry is EWKB, the same as its text output.
            Value::Other { type_name: ty.name().into(), text: dbs_core::hex_encode(raw) }
        }
    })
}

fn decode_array(elem: &Type, raw: &[u8]) -> Result<Value, BoxErr> {
    let ndim = be_i32(raw, 0)?;
    if ndim == 0 {
        return Ok(Value::Array(vec![]));
    }
    let mut pos = 12usize;
    let mut dims = Vec::new();
    for _ in 0..ndim {
        dims.push(be_i32(raw, pos)? as usize);
        pos += 8;
    }
    let total: usize = dims.iter().product();
    let mut flat = Vec::with_capacity(total.min(100_000));
    for _ in 0..total {
        let len = be_i32(raw, pos)?;
        pos += 4;
        if len < 0 {
            flat.push(Value::Null);
        } else {
            let l = len as usize;
            flat.push(decode(elem, raw.get(pos..pos + l).ok_or("short")?)?);
            pos += l;
        }
    }
    // Rebuild nesting for multi-dimensional arrays.
    for &d in dims.iter().skip(1).rev() {
        flat = flat.chunks(d.max(1)).map(|c| Value::Array(c.to_vec())).collect();
    }
    Ok(Value::Array(flat))
}

impl<'a> FromSql<'a> for PgAny {
    fn from_sql(ty: &Type, raw: &'a [u8]) -> Result<Self, BoxErr> {
        decode(ty, raw).map(PgAny)
    }
    fn from_sql_null(_: &Type) -> Result<Self, BoxErr> {
        Ok(PgAny(Value::Null))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}

/// Parameter that encodes a `Value` into whatever type the server inferred.
#[derive(Debug)]
pub struct PgParam(pub Value);

fn as_text(v: &Value) -> String {
    v.to_plain().unwrap_or_default()
}

fn parse_i64(v: &Value) -> Result<i64, BoxErr> {
    match v {
        Value::Int(i) => Ok(*i),
        Value::Bool(b) => Ok(*b as i64),
        Value::Float(f) if f.fract() == 0.0 => Ok(*f as i64),
        other => Ok(as_text(other).trim().parse()?),
    }
}

fn parse_ts(s: &str) -> Result<NaiveDateTime, BoxErr> {
    let s = s.trim().trim_end_matches('Z');
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"] {
        if let Ok(t) = NaiveDateTime::parse_from_str(s, f) {
            return Ok(t);
        }
    }
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(t.naive_utc());
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Ok(d.and_hms_opt(0, 0, 0).unwrap());
    }
    Err(format!("invalid timestamp: {s}").into())
}

fn encode(ty: &Type, v: &Value, out: &mut BytesMut) -> Result<(), BoxErr> {
    if let Kind::Domain(inner) = ty.kind() {
        return encode(inner, v, out);
    }
    if let Kind::Enum(_) = ty.kind() {
        out.put_slice(as_text(v).as_bytes());
        return Ok(());
    }
    match *ty {
        Type::BOOL => {
            let b = match v {
                Value::Bool(b) => *b,
                other => matches!(as_text(other).trim().to_ascii_lowercase().as_str(), "t" | "true" | "1" | "yes" | "y" | "on"),
            };
            out.put_u8(b as u8);
        }
        Type::INT2 => out.put_i16(i16::try_from(parse_i64(v)?)?),
        Type::INT4 => out.put_i32(i32::try_from(parse_i64(v)?)?),
        Type::INT8 => out.put_i64(parse_i64(v)?),
        Type::OID => out.put_u32(u32::try_from(parse_i64(v)?)?),
        Type::FLOAT4 => out.put_f32(match v {
            Value::Float(f) => *f as f32,
            o => as_text(o).trim().parse()?,
        }),
        Type::FLOAT8 => out.put_f64(match v {
            Value::Float(f) => *f,
            o => as_text(o).trim().parse()?,
        }),
        Type::NUMERIC => encode_numeric(&as_text(v), out)?,
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN | Type::XML | Type::CHAR => out.put_slice(as_text(v).as_bytes()),
        Type::JSON => out.put_slice(json_text(v)?.as_bytes()),
        Type::JSONB => {
            out.put_u8(1);
            out.put_slice(json_text(v)?.as_bytes());
        }
        Type::BYTEA => match v {
            Value::Bytes { hex, truncated: false, .. } => out.put_slice(&hex_decode(hex).ok_or("invalid hex")?),
            Value::Bytes { truncated: true, .. } => return Err("cannot write a truncated binary value".into()),
            o => out.put_slice(&hex_decode(&as_text(o)).ok_or("bytea expects hex (\\x...)")?),
        },
        Type::UUID => {
            let s: String = as_text(v).chars().filter(|c| *c != '-' && *c != '{' && *c != '}').collect();
            let b = hex_decode(&s).filter(|b| b.len() == 16).ok_or("invalid uuid")?;
            out.put_slice(&b);
        }
        Type::DATE => {
            let d = NaiveDate::parse_from_str(as_text(v).trim().get(..10).unwrap_or(""), "%Y-%m-%d")?;
            out.put_i32((d - epoch_date()).num_days() as i32);
        }
        Type::TIME => {
            let s = as_text(v);
            let t = NaiveTime::parse_from_str(s.trim(), "%H:%M:%S%.f").or_else(|_| NaiveTime::parse_from_str(s.trim(), "%H:%M"))?;
            out.put_i64((t - NaiveTime::from_hms_opt(0, 0, 0).unwrap()).num_microseconds().ok_or("overflow")?);
        }
        Type::TIMESTAMP | Type::TIMESTAMPTZ => {
            let s = as_text(v);
            let t = if *ty == Type::TIMESTAMPTZ {
                chrono::DateTime::parse_from_rfc3339(s.trim()).map(|d| d.naive_utc()).or_else(|_| parse_ts(&s))?
            } else {
                parse_ts(&s)?
            };
            let base = epoch_date().and_hms_opt(0, 0, 0).unwrap();
            out.put_i64((t - base).num_microseconds().ok_or("overflow")?);
        }
        _ => return Err(format!("editing values of type `{}` is not supported; use the SQL editor", ty.name()).into()),
    }
    Ok(())
}

fn json_text(v: &Value) -> Result<String, BoxErr> {
    Ok(match v {
        Value::Json(j) => j.to_string(),
        o => {
            let s = as_text(o);
            serde_json::from_str::<serde_json::Value>(&s)?;
            s
        }
    })
}

impl ToSql for PgParam {
    fn to_sql(&self, ty: &Type, out: &mut BytesMut) -> Result<IsNull, BoxErr> {
        if self.0.is_null() {
            return Ok(IsNull::Yes);
        }
        encode(ty, &self.0, out)?;
        Ok(IsNull::No)
    }
    fn accepts(_: &Type) -> bool {
        true
    }
    tokio_postgres::types::to_sql_checked!();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(s: &str) -> String {
        let mut b = BytesMut::new();
        encode_numeric(s, &mut b).unwrap();
        decode_numeric(&b).unwrap()
    }

    #[test]
    fn numeric_roundtrip_is_exact() {
        for s in ["0", "1", "-1", "12345.6789", "0.0001", "-0.5", "100000000000000000000000000001.000000000000000000001", "9999", "10000", "0.10"] {
            assert_eq!(rt(s), s, "{s}");
        }
        assert_eq!(rt("007.50"), "7.50");
        assert_eq!(rt("-0.00"), "0.00");
    }

    #[test]
    fn numeric_rejects_garbage() {
        let mut b = BytesMut::new();
        assert!(encode_numeric("1e5", &mut b).is_err());
        assert!(encode_numeric("abc", &mut b).is_err());
        assert!(encode_numeric("1;drop", &mut b).is_err());
    }

    #[test]
    fn timestamp_decode() {
        let us: i64 = 86_400_000_000 + 1_500_000; // 2000-01-02 00:00:01.5
        let v = decode(&Type::TIMESTAMP, &us.to_be_bytes()).unwrap();
        assert_eq!(v, Value::Timestamp { iso: "2000-01-02T00:00:01.500".into(), tz: false });
        let v = decode(&Type::TIMESTAMPTZ, &us.to_be_bytes()).unwrap();
        assert_eq!(v, Value::Timestamp { iso: "2000-01-02T00:00:01.500Z".into(), tz: true });
    }

    #[test]
    fn int8_large_is_string() {
        let v = decode(&Type::INT8, &i64::MAX.to_be_bytes()).unwrap();
        assert_eq!(v, Value::BigInt(i64::MAX.to_string()));
    }

    #[test]
    fn encode_rejects_unsupported() {
        let mut b = BytesMut::new();
        assert!(encode(&Type::POINT, &Value::Text("(1,2)".into()), &mut b).is_err());
    }
}
