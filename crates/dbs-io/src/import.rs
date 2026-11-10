use std::io::Read;

use dbs_core::{DbError, DbResult, Dialect, ErrorKind, GeneratedStatement, TableTarget, Value};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportFormat {
    Csv,
    Tsv,
    Json,
    JsonLines,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportOptions {
    pub format: ImportFormat,
    #[serde(default)]
    pub delimiter: Option<char>,
    #[serde(default = "yes")]
    pub has_header: bool,
    #[serde(default = "quote")]
    pub quote: char,
    /// Cell text treated as NULL (exact match). Empty string is NOT null unless listed.
    #[serde(default = "default_nulls")]
    pub null_tokens: Vec<String>,
    /// Only "utf-8" and "latin1" are supported.
    #[serde(default = "utf8")]
    pub encoding: String,
    #[serde(default = "default_batch")]
    pub batch_size: usize,
    /// Hard caps against resource exhaustion.
    #[serde(default = "max_cols")]
    pub max_columns: usize,
    #[serde(default = "max_cell")]
    pub max_cell_bytes: usize,
}

fn yes() -> bool {
    true
}
fn quote() -> char {
    '"'
}
fn default_nulls() -> Vec<String> {
    vec!["NULL".into(), "\\N".into()]
}
fn utf8() -> String {
    "utf-8".into()
}
fn default_batch() -> usize {
    500
}
fn max_cols() -> usize {
    4096
}
fn max_cell() -> usize {
    16 * 1024 * 1024
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            format: ImportFormat::Csv,
            delimiter: None,
            has_header: true,
            quote: '"',
            null_tokens: default_nulls(),
            encoding: utf8(),
            batch_size: 500,
            max_columns: 4096,
            max_cell_bytes: 16 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InferredType {
    Integer,
    Decimal,
    Boolean,
    Date,
    Timestamp,
    Json,
    Text,
}

impl InferredType {
    pub fn sql_type(self, d: Dialect) -> &'static str {
        match (self, d) {
            (InferredType::Integer, _) => "BIGINT",
            (InferredType::Decimal, Dialect::Sqlite) => "NUMERIC",
            (InferredType::Decimal, _) => "NUMERIC(38,10)",
            (InferredType::Boolean, Dialect::MySql) => "TINYINT(1)",
            (InferredType::Boolean, _) => "BOOLEAN",
            (InferredType::Date, _) => "DATE",
            (InferredType::Timestamp, Dialect::Postgres) => "TIMESTAMP",
            (InferredType::Timestamp, _) => "DATETIME",
            (InferredType::Json, Dialect::Postgres) => "JSONB",
            (InferredType::Json, Dialect::MySql) => "JSON",
            (InferredType::Json, _) | (InferredType::Text, _) => "TEXT",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPreview {
    pub columns: Vec<String>,
    pub inferred: Vec<InferredType>,
    pub rows: Vec<Vec<Value>>,
}

fn infer_one(s: &str) -> InferredType {
    let t = s.trim();
    // Identifiers like zip codes / phone numbers ("01234") must stay text.
    let unsigned = t.trim_start_matches(['-', '+']);
    let leading_zero = unsigned.len() > 1 && unsigned.starts_with('0') && !unsigned.starts_with("0.");
    if leading_zero {
        InferredType::Text
    } else if t.parse::<i64>().is_ok() {
        InferredType::Integer
    } else if t.parse::<f64>().is_ok() && t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+')) {
        InferredType::Decimal
    } else if matches!(t.to_ascii_lowercase().as_str(), "true" | "false") {
        InferredType::Boolean
    } else if chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d").is_ok() {
        InferredType::Date
    } else if chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S%.f").is_ok()
        || chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S%.f").is_ok()
        || chrono::DateTime::parse_from_rfc3339(t).is_ok()
    {
        InferredType::Timestamp
    } else if (t.starts_with('{') || t.starts_with('[')) && serde_json::from_str::<serde_json::Value>(t).is_ok() {
        InferredType::Json
    } else {
        InferredType::Text
    }
}

fn merge(a: Option<InferredType>, b: InferredType) -> InferredType {
    use InferredType::*;
    match (a, b) {
        (None, b) => b,
        (Some(a), b) if a == b => a,
        (Some(Integer), Decimal) | (Some(Decimal), Integer) => Decimal,
        (Some(Date), Timestamp) | (Some(Timestamp), Date) => Timestamp,
        _ => Text,
    }
}

/// Convert raw cell text into a typed value according to the target column type.
pub fn typed_value(raw: &str, t: InferredType) -> Value {
    let s = raw.trim();
    match t {
        InferredType::Integer => s.parse::<i64>().map(Value::from_i64).unwrap_or_else(|_| Value::Text(raw.into())),
        InferredType::Decimal => Value::Decimal(s.into()),
        InferredType::Boolean => Value::Bool(s.eq_ignore_ascii_case("true")),
        InferredType::Date => Value::Date(s.into()),
        InferredType::Timestamp => Value::Timestamp { iso: s.into(), tz: s.ends_with('Z') || s.contains('+') },
        InferredType::Json => serde_json::from_str(s).map(Value::Json).unwrap_or_else(|_| Value::Text(raw.into())),
        InferredType::Text => Value::Text(raw.into()),
    }
}

fn decode_bytes(b: Vec<u8>, enc: &str) -> DbResult<String> {
    match enc.to_ascii_lowercase().as_str() {
        "utf-8" | "utf8" => {
            let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF]).map(|x| x.to_vec()).unwrap_or(b);
            String::from_utf8(b).map_err(|_| DbError::invalid("file is not valid UTF-8; choose another encoding"))
        }
        "latin1" | "iso-8859-1" => Ok(b.into_iter().map(|c| c as char).collect()),
        other => Err(DbError::invalid(format!("unsupported encoding {other}"))),
    }
}

/// Streaming record source over CSV/TSV/JSONL/JSON.
pub struct RecordReader {
    pub columns: Vec<String>,
    inner: Inner,
    opts: ImportOptions,
    pub line: u64,
}

enum Inner {
    Csv(csv::StringRecordsIntoIter<std::io::Cursor<String>>),
    Json(std::vec::IntoIter<serde_json::Map<String, serde_json::Value>>),
    JsonLines(std::io::Lines<std::io::Cursor<String>>),
}

impl RecordReader {
    /// `max_bytes` bounds how much input is read (defence against huge files in
    /// a single buffer; large files should be split or use CSV streaming).
    pub fn open<R: Read>(mut src: R, opts: ImportOptions, max_bytes: u64) -> DbResult<Self> {
        let mut raw = Vec::new();
        src.by_ref().take(max_bytes + 1).read_to_end(&mut raw).map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
        if raw.len() as u64 > max_bytes {
            return Err(DbError::invalid(format!("file exceeds the {max_bytes}-byte import limit")));
        }
        let text = decode_bytes(raw, &opts.encoding)?;
        match opts.format {
            ImportFormat::Csv | ImportFormat::Tsv => {
                let delim = opts.delimiter.unwrap_or(if opts.format == ImportFormat::Tsv { '\t' } else { ',' });
                if !delim.is_ascii() || !opts.quote.is_ascii() {
                    return Err(DbError::invalid("delimiter and quote must be ASCII"));
                }
                let mut rdr = csv::ReaderBuilder::new()
                    .delimiter(delim as u8)
                    .quote(opts.quote as u8)
                    .has_headers(opts.has_header)
                    .flexible(true)
                    .from_reader(std::io::Cursor::new(text));
                let columns: Vec<String> = if opts.has_header {
                    rdr.headers().map_err(|e| DbError::invalid(e.to_string()))?.iter().map(|s| s.trim().to_string()).collect()
                } else {
                    vec![]
                };
                if columns.len() > opts.max_columns {
                    return Err(DbError::invalid("too many columns"));
                }
                Ok(Self { columns, inner: Inner::Csv(rdr.into_records()), opts, line: 0 })
            }
            ImportFormat::Json => {
                let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| DbError::invalid(format!("invalid JSON: {e}")))?;
                let arr = match v {
                    serde_json::Value::Array(a) => a,
                    _ => return Err(DbError::invalid("JSON import expects an array of objects")),
                };
                let mut columns: Vec<String> = Vec::new();
                let mut objs = Vec::with_capacity(arr.len());
                for item in arr {
                    let serde_json::Value::Object(o) = item else { return Err(DbError::invalid("JSON array items must be objects")) };
                    for k in o.keys() {
                        if !columns.contains(k) {
                            columns.push(k.clone());
                        }
                    }
                    objs.push(o);
                }
                if columns.len() > opts.max_columns {
                    return Err(DbError::invalid("too many columns"));
                }
                Ok(Self { columns, inner: Inner::Json(objs.into_iter()), opts, line: 0 })
            }
            ImportFormat::JsonLines => {
                use std::io::BufRead;
                // Columns from the first object; later unknown keys are an error reported per line.
                let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("{}");
                let o: serde_json::Map<String, serde_json::Value> = serde_json::from_str(first).map_err(|e| DbError::invalid(format!("line 1: {e}")))?;
                let columns = o.keys().cloned().collect();
                Ok(Self { columns, inner: Inner::JsonLines(std::io::Cursor::new(text).lines()), opts, line: 0 })
            }
        }
    }

    /// Next raw record as Option<String> cells (None = NULL).
    pub fn next_record(&mut self) -> Option<DbResult<Vec<Option<String>>>> {
        self.line += 1;
        let nulls = &self.opts.null_tokens;
        let max_cell = self.opts.max_cell_bytes;
        let ncols = self.columns.len();
        let rec = match &mut self.inner {
            Inner::Csv(it) => it.next().map(|r| {
                r.map_err(|e| DbError::invalid(format!("row {}: {e}", self.line)))
                    .map(|r| r.iter().map(|c| if nulls.iter().any(|n| n == c) { None } else { Some(c.to_string()) }).collect::<Vec<_>>())
            }),
            Inner::Json(it) => it.next().map(|o| Ok(json_cells(&self.columns, &o))),
            Inner::JsonLines(it) => loop {
                match it.next() {
                    None => break None,
                    Some(Err(e)) => break Some(Err(DbError::new(ErrorKind::Io, e.to_string()))),
                    Some(Ok(l)) if l.trim().is_empty() => continue,
                    Some(Ok(l)) => {
                        break Some(
                            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&l)
                                .map_err(|e| DbError::invalid(format!("line {}: {e}", self.line)))
                                .map(|o| json_cells(&self.columns, &o)),
                        )
                    }
                }
            },
        };
        rec.map(|r| {
            r.and_then(|mut cells| {
                if cells.iter().flatten().any(|c| c.len() > max_cell) {
                    return Err(DbError::invalid(format!("row {}: cell exceeds size limit", self.line)));
                }
                if ncols > 0 {
                    cells.resize(ncols, None);
                }
                Ok(cells)
            })
        })
    }

    /// Read up to `n` records for preview and infer column types from them.
    pub fn preview(mut self, n: usize) -> DbResult<ImportPreview> {
        let mut raw = Vec::new();
        while raw.len() < n {
            match self.next_record() {
                None => break,
                Some(r) => raw.push(r?),
            }
        }
        if self.columns.is_empty() {
            let w = raw.iter().map(|r| r.len()).max().unwrap_or(0);
            self.columns = (1..=w).map(|i| format!("column_{i}")).collect();
        }
        let inferred = infer_types(&self.columns, &raw);
        let rows = raw
            .iter()
            .map(|r| r.iter().zip(&inferred).map(|(c, t)| c.as_deref().map(|s| typed_value(s, *t)).unwrap_or(Value::Null)).collect())
            .collect();
        Ok(ImportPreview { columns: self.columns, inferred, rows })
    }
}

fn json_cells(columns: &[String], o: &serde_json::Map<String, serde_json::Value>) -> Vec<Option<String>> {
    columns
        .iter()
        .map(|c| match o.get(c) {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(s)) => Some(s.clone()),
            Some(v) => Some(v.to_string()),
        })
        .collect()
}

pub fn infer_types(columns: &[String], rows: &[Vec<Option<String>>]) -> Vec<InferredType> {
    (0..columns.len())
        .map(|i| {
            let mut t = None;
            for r in rows {
                if let Some(Some(s)) = r.get(i) {
                    if !s.is_empty() {
                        t = Some(merge(t, infer_one(s)));
                    }
                }
            }
            t.unwrap_or(InferredType::Text)
        })
        .collect()
}

/// Column mapping: source column index → target column name (None = skip).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMapping {
    pub source_index: usize,
    pub target: String,
    pub kind: InferredType,
}

/// Multi-row parameterised INSERT for one batch.
pub fn build_insert_batch(d: Dialect, target: &TableTarget, mapping: &[ColumnMapping], batch: &[Vec<Option<String>>]) -> DbResult<GeneratedStatement> {
    if mapping.is_empty() {
        return Err(DbError::invalid("no columns mapped"));
    }
    let t = d.qualified(target)?;
    let cols = mapping.iter().map(|m| d.quote_ident(&m.target)).collect::<DbResult<Vec<_>>>()?.join(", ");
    let mut params = Vec::with_capacity(batch.len() * mapping.len());
    let mut tuples = Vec::with_capacity(batch.len());
    for row in batch {
        let mut ph = Vec::with_capacity(mapping.len());
        for m in mapping {
            let v = match row.get(m.source_index).cloned().flatten() {
                None => Value::Null,
                Some(s) => typed_value(&s, m.kind),
            };
            params.push(v);
            ph.push(d.placeholder(params.len()));
        }
        tuples.push(format!("({})", ph.join(", ")));
    }
    Ok(GeneratedStatement { sql: format!("INSERT INTO {t} ({cols}) VALUES {}", tuples.join(", ")), params })
}

/// CREATE TABLE for "import into new table".
pub fn create_table_sql(d: Dialect, target: &TableTarget, mapping: &[ColumnMapping]) -> DbResult<String> {
    let t = d.qualified(target)?;
    let cols = mapping.iter().map(|m| Ok(format!("  {} {}", d.quote_ident(&m.target)?, m.kind.sql_type(d)))).collect::<DbResult<Vec<_>>>()?;
    Ok(format!("CREATE TABLE {t} (\n{}\n)", cols.join(",\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_preview_infers_types_and_nulls() {
        let data = "id,price,ok,day,name,doc\n1,1.50,true,2024-01-02,alice,\"{\"\"a\"\":1}\"\n2,3,false,2024-01-03,,NULL\n";
        let p = RecordReader::open(data.as_bytes(), ImportOptions::default(), 1 << 20).unwrap().preview(10).unwrap();
        assert_eq!(p.columns, vec!["id", "price", "ok", "day", "name", "doc"]);
        use InferredType::*;
        assert_eq!(p.inferred, vec![Integer, Decimal, Boolean, Date, Text, Json]);
        assert_eq!(p.rows[1][4], Value::Text("".into()), "empty string is not NULL");
        assert_eq!(p.rows[1][5], Value::Null);
    }

    #[test]
    fn leading_zero_stays_text() {
        let p = RecordReader::open("zip\n01234\n".as_bytes(), ImportOptions::default(), 1 << 20).unwrap().preview(10).unwrap();
        assert_eq!(p.inferred, vec![InferredType::Text]);
    }

    #[test]
    fn json_and_jsonl() {
        let j = r#"[{"a":1,"b":"x"},{"a":2,"c":true}]"#;
        let p = RecordReader::open(j.as_bytes(), ImportOptions { format: ImportFormat::Json, ..Default::default() }, 1 << 20).unwrap().preview(10).unwrap();
        assert_eq!(p.columns, vec!["a", "b", "c"]);
        assert_eq!(p.rows[1][1], Value::Null);
        let l = "{\"a\":1}\n\n{\"a\":2}\n";
        let p = RecordReader::open(l.as_bytes(), ImportOptions { format: ImportFormat::JsonLines, ..Default::default() }, 1 << 20).unwrap().preview(10).unwrap();
        assert_eq!(p.rows.len(), 2);
    }

    #[test]
    fn size_limits_enforced() {
        assert!(RecordReader::open("a\n1234567890\n".as_bytes(), ImportOptions::default(), 5).is_err());
        let o = ImportOptions { max_cell_bytes: 3, ..Default::default() };
        let mut r = RecordReader::open("a\n12345\n".as_bytes(), o, 1 << 20).unwrap();
        assert!(r.next_record().unwrap().is_err());
    }

    #[test]
    fn malformed_inputs_error_not_panic() {
        assert!(RecordReader::open("[1,2]".as_bytes(), ImportOptions { format: ImportFormat::Json, ..Default::default() }, 1 << 20).is_err());
        assert!(RecordReader::open("{".as_bytes(), ImportOptions { format: ImportFormat::Json, ..Default::default() }, 1 << 20).is_err());
        assert!(RecordReader::open(&[0xff, 0xfe, 0x00][..], ImportOptions::default(), 1 << 20).is_err());
        let p = RecordReader::open(&[b'a', b'\n', 0xe9, b'\n'][..], ImportOptions { encoding: "latin1".into(), ..Default::default() }, 1 << 20).unwrap().preview(5).unwrap();
        assert_eq!(p.rows[0][0], Value::Text("é".into()));
    }

    #[test]
    fn insert_batch_is_parameterised() {
        let m = vec![
            ColumnMapping { source_index: 0, target: "id".into(), kind: InferredType::Integer },
            ColumnMapping { source_index: 2, target: "na\"me".into(), kind: InferredType::Text },
        ];
        let b = vec![vec![Some("1".into()), None, Some("x'); drop".into())], vec![Some("2".into()), None, None]];
        let g = build_insert_batch(Dialect::Postgres, &TableTarget { schema: None, table: "t".into() }, &m, &b).unwrap();
        assert_eq!(g.sql, "INSERT INTO \"t\" (\"id\", \"na\"\"me\") VALUES ($1, $2), ($3, $4)");
        assert_eq!(g.params, vec![Value::Int(1), Value::Text("x'); drop".into()), Value::Int(2), Value::Null]);
    }
}
