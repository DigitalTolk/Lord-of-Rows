use std::io::Write;

use dbs_core::{ColumnMeta, DbError, DbResult, Dialect, ErrorKind, TableTarget, Value};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Csv,
    Tsv,
    Json,
    JsonLines,
    SqlInsert,
    Markdown,
    Xml,
    Xlsx,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportOptions {
    pub format: ExportFormat,
    #[serde(default = "yes")]
    pub header: bool,
    /// Text written for NULL in delimited formats.
    #[serde(default)]
    pub null_text: String,
    /// Neutralise spreadsheet formulas (=, +, -, @, tab, CR prefixes). On by default.
    #[serde(default = "yes")]
    pub formula_guard: bool,
    /// For SqlInsert.
    #[serde(default)]
    pub dialect: Option<Dialect>,
    #[serde(default)]
    pub table: Option<TableTarget>,
    #[serde(default = "default_batch")]
    pub rows_per_insert: usize,
}

fn yes() -> bool {
    true
}
fn default_batch() -> usize {
    100
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            format: ExportFormat::Csv,
            header: true,
            null_text: String::new(),
            formula_guard: true,
            dialect: None,
            table: None,
            rows_per_insert: 100,
        }
    }
}

fn io(e: std::io::Error) -> DbError {
    DbError::new(ErrorKind::Io, e.to_string())
}

/// OWASP CSV-injection mitigation: prefix risky leading characters with `'`
/// unless the cell is a plain number.
pub fn guard_formula(s: &str) -> std::borrow::Cow<'_, str> {
    let risky = matches!(s.chars().next(), Some('=' | '+' | '-' | '@' | '\t' | '\r'));
    if risky && s.parse::<f64>().is_err() {
        std::borrow::Cow::Owned(format!("'{s}"))
    } else {
        std::borrow::Cow::Borrowed(s)
    }
}

/// Incremental writer: `begin` → many `write_rows` → `finish`.
pub struct Exporter<W: Write> {
    out: W,
    opts: ExportOptions,
    columns: Vec<ColumnMeta>,
    rows_written: u64,
    csv_delim: Option<u8>,
    xlsx: Option<(rust_xlsxwriter::Workbook, u32)>,
}

impl<W: Write> Exporter<W> {
    pub fn begin(mut out: W, columns: &[ColumnMeta], opts: ExportOptions) -> DbResult<Self> {
        let mut csv_delim = None;
        let mut xlsx = None;
        match opts.format {
            ExportFormat::Csv | ExportFormat::Tsv => {
                let d = if opts.format == ExportFormat::Tsv { b'\t' } else { b',' };
                if opts.header {
                    let names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
                    out.write_all(&csv_bytes(d, &[names])?).map_err(io)?;
                }
                csv_delim = Some(d);
            }
            ExportFormat::Json => out.write_all(b"[\n").map_err(io)?,
            ExportFormat::Markdown => {
                let names: Vec<String> = columns.iter().map(|c| md_escape(&c.name)).collect();
                writeln!(out, "| {} |", names.join(" | ")).map_err(io)?;
                writeln!(out, "|{}", " --- |".repeat(columns.len())).map_err(io)?;
            }
            ExportFormat::Xml => {
                out.write_all(b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rows>\n").map_err(io)?;
            }
            ExportFormat::Xlsx => {
                let mut wb = rust_xlsxwriter::Workbook::new();
                let ws = wb.add_worksheet_with_constant_memory().map_err(xl)?;
                if opts.header {
                    let bold = rust_xlsxwriter::Format::new().set_bold();
                    for (i, c) in columns.iter().enumerate() {
                        ws.write_string_with_format(0, i as u16, &c.name, &bold).map_err(xl)?;
                    }
                }
                xlsx = Some((wb, if opts.header { 1 } else { 0 }));
            }
            ExportFormat::SqlInsert => {
                if opts.table.is_none() {
                    return Err(DbError::invalid("SQL export requires a target table name"));
                }
            }
            ExportFormat::JsonLines => {}
        }
        Ok(Self { out, opts, columns: columns.to_vec(), rows_written: 0, csv_delim, xlsx })
    }

    fn cell_text<'a>(&self, v: &'a Value) -> std::borrow::Cow<'a, str> {
        match v.to_plain() {
            None => std::borrow::Cow::Owned(self.opts.null_text.clone()),
            Some(s) => {
                if self.opts.formula_guard && matches!(v, Value::Text(_) | Value::Other { .. } | Value::Json(_)) {
                    std::borrow::Cow::Owned(guard_formula(&s).into_owned())
                } else {
                    std::borrow::Cow::Owned(s)
                }
            }
        }
    }

    pub fn write_rows(&mut self, rows: &[Vec<Value>]) -> DbResult<()> {
        match self.opts.format {
            ExportFormat::Csv | ExportFormat::Tsv => {
                let recs: Vec<Vec<String>> = rows.iter().map(|r| r.iter().map(|v| self.cell_text(v).into_owned()).collect()).collect();
                let bytes = csv_bytes(self.csv_delim.unwrap_or(b','), &recs)?;
                self.out.write_all(&bytes).map_err(io)?;
            }
            ExportFormat::Json | ExportFormat::JsonLines => {
                for r in rows {
                    let obj: serde_json::Map<String, serde_json::Value> =
                        self.columns.iter().zip(r).map(|(c, v)| (c.name.clone(), to_json(v))).collect();
                    let s = serde_json::to_string(&obj).map_err(|e| DbError::internal(e.to_string()))?;
                    if self.opts.format == ExportFormat::Json {
                        if self.rows_written > 0 {
                            self.out.write_all(b",\n").map_err(io)?;
                        }
                        self.out.write_all(b"  ").map_err(io)?;
                    }
                    self.out.write_all(s.as_bytes()).map_err(io)?;
                    if self.opts.format == ExportFormat::JsonLines {
                        self.out.write_all(b"\n").map_err(io)?;
                    }
                    self.rows_written += 1;
                }
                return Ok(());
            }
            ExportFormat::Markdown => {
                for r in rows {
                    let cells: Vec<String> = r.iter().map(|v| md_escape(&v.to_plain().unwrap_or_else(|| "NULL".into()))).collect();
                    writeln!(self.out, "| {} |", cells.join(" | ")).map_err(io)?;
                }
            }
            ExportFormat::Xml => {
                for r in rows {
                    self.out.write_all(b"  <row>").map_err(io)?;
                    for (c, v) in self.columns.iter().zip(r) {
                        let tag = xml_name(&c.name);
                        match v.to_plain() {
                            None => write!(self.out, "<{tag} null=\"true\"/>").map_err(io)?,
                            Some(s) => write!(self.out, "<{tag}>{}</{tag}>", xml_escape(&s)).map_err(io)?,
                        }
                    }
                    self.out.write_all(b"</row>\n").map_err(io)?;
                }
            }
            ExportFormat::SqlInsert => {
                let d = self.opts.dialect.unwrap_or(Dialect::Generic);
                let t = d.qualified(self.opts.table.as_ref().unwrap())?;
                let cols = self.columns.iter().map(|c| d.quote_ident(&c.name)).collect::<DbResult<Vec<_>>>()?.join(", ");
                for chunk in rows.chunks(self.opts.rows_per_insert.max(1)) {
                    let vals: Vec<String> =
                        chunk.iter().map(|r| format!("({})", r.iter().map(|v| d.literal(v)).collect::<Vec<_>>().join(", "))).collect();
                    writeln!(self.out, "INSERT INTO {t} ({cols}) VALUES\n  {};", vals.join(",\n  ")).map_err(io)?;
                }
            }
            ExportFormat::Xlsx => {
                let guard = self.opts.formula_guard;
                let (wb, row) = self.xlsx.as_mut().unwrap();
                let ws = wb.worksheet_from_index(0).map_err(xl)?;
                for r in rows {
                    if *row >= 1_048_576 {
                        return Err(DbError::invalid("XLSX is limited to 1,048,576 rows; use CSV for larger exports"));
                    }
                    for (i, v) in r.iter().enumerate() {
                        let col = i as u16;
                        match v {
                            Value::Null => {}
                            Value::Int(n) => {
                                ws.write_number(*row, col, *n as f64).map_err(xl)?;
                            }
                            Value::Float(f) => {
                                ws.write_number(*row, col, *f).map_err(xl)?;
                            }
                            Value::Bool(b) => {
                                ws.write_boolean(*row, col, *b).map_err(xl)?;
                            }
                            other => {
                                // Strings are written as strings, never as formulas.
                                let s = other.to_plain().unwrap_or_default();
                                let s = if guard { guard_formula(&s).into_owned() } else { s };
                                let s: String = s.chars().take(32_767).collect();
                                ws.write_string(*row, col, &s).map_err(xl)?;
                            }
                        }
                    }
                    *row += 1;
                }
            }
        }
        self.rows_written += rows.len() as u64;
        Ok(())
    }

    pub fn finish(mut self) -> DbResult<u64> {
        match self.opts.format {
            ExportFormat::Json => self.out.write_all(b"\n]\n").map_err(io)?,
            ExportFormat::Xml => self.out.write_all(b"</rows>\n").map_err(io)?,
            ExportFormat::Xlsx => {
                let (mut wb, _) = self.xlsx.take().unwrap();
                let buf = wb.save_to_buffer().map_err(xl)?;
                self.out.write_all(&buf).map_err(io)?;
            }
            _ => {}
        }
        self.out.flush().map_err(io)?;
        Ok(self.rows_written)
    }
}

fn csv_bytes(delim: u8, recs: &[Vec<String>]) -> DbResult<Vec<u8>> {
    let mut w = csv::WriterBuilder::new().delimiter(delim).has_headers(false).from_writer(Vec::new());
    for r in recs {
        w.write_record(r).map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
    }
    w.into_inner().map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))
}

fn xl(e: rust_xlsxwriter::XlsxError) -> DbError {
    DbError::new(ErrorKind::Io, e.to_string())
}

pub fn to_json(v: &Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Null => J::Null,
        Value::Bool(b) => J::Bool(*b),
        Value::Int(i) => J::from(*i),
        Value::Float(f) => serde_json::Number::from_f64(*f).map(J::Number).unwrap_or(J::Null),
        Value::Json(j) => j.clone(),
        Value::Array(a) => J::Array(a.iter().map(to_json).collect()),
        // BigInt/Decimal stay strings to preserve precision.
        other => J::String(other.to_plain().unwrap_or_default()),
    }
}

fn md_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('|', "\\|").replace('\n', "<br>").replace('\r', "")
}

fn xml_escape(s: &str) -> String {
    s.chars()
        .filter(|c| matches!(*c, '\t' | '\n' | '\r') || !c.is_control())
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn xml_name(s: &str) -> String {
    let mut n: String = s.chars().map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    if n.is_empty() || n.chars().next().is_some_and(|c| c.is_ascii_digit() || c == '-') {
        n.insert(0, '_');
    }
    n
}

/// Convenience: export a whole in-memory result (selection / clipboard).
pub fn export_to_string(columns: &[ColumnMeta], rows: &[Vec<Value>], opts: ExportOptions) -> DbResult<String> {
    if opts.format == ExportFormat::Xlsx {
        return Err(DbError::invalid("XLSX cannot be copied as text"));
    }
    let mut buf = Vec::new();
    let mut e = Exporter::begin(&mut buf, columns, opts)?;
    e.write_rows(rows)?;
    e.finish()?;
    String::from_utf8(buf).map_err(|e| DbError::internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<ColumnMeta> {
        ["id", "name"].iter().map(|n| ColumnMeta { name: n.to_string(), type_name: String::new(), nullable: None, table: None }).collect()
    }
    fn rows() -> Vec<Vec<Value>> {
        vec![
            vec![Value::Int(1), Value::Text("=HYPERLINK(\"http://evil\")".into())],
            vec![Value::Int(-2), Value::Null],
            vec![Value::BigInt("9007199254740993".into()), Value::Text("a,\"b\"\nc".into())],
        ]
    }

    #[test]
    fn csv_guards_formulas_and_quotes() {
        let s = export_to_string(&cols(), &rows(), ExportOptions::default()).unwrap();
        assert!(s.starts_with("id,name\n"));
        assert!(s.contains("'=HYPERLINK"), "{s}");
        assert!(s.contains("-2,"), "negative numbers untouched: {s}");
        assert!(s.contains("\"a,\"\"b\"\"\nc\""));
    }

    #[test]
    fn guard_rules() {
        assert_eq!(guard_formula("=1+1"), "'=1+1");
        assert_eq!(guard_formula("-5"), "-5");
        assert_eq!(guard_formula("-cmd"), "'-cmd");
        assert_eq!(guard_formula("@SUM(A1)"), "'@SUM(A1)");
        assert_eq!(guard_formula("plain"), "plain");
    }

    #[test]
    fn json_keeps_bigints_as_strings() {
        let s = export_to_string(&cols(), &rows(), ExportOptions { format: ExportFormat::Json, ..Default::default() }).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v[2]["id"], serde_json::json!("9007199254740993"));
        assert_eq!(v[1]["name"], serde_json::Value::Null);
    }

    #[test]
    fn jsonl_and_markdown() {
        let s = export_to_string(&cols(), &rows(), ExportOptions { format: ExportFormat::JsonLines, ..Default::default() }).unwrap();
        assert_eq!(s.lines().count(), 3);
        let s = export_to_string(&cols(), &rows(), ExportOptions { format: ExportFormat::Markdown, ..Default::default() }).unwrap();
        assert!(s.contains("| id | name |"));
        assert!(s.contains("<br>"));
    }

    #[test]
    fn sql_insert_escapes() {
        let o = ExportOptions {
            format: ExportFormat::SqlInsert,
            dialect: Some(Dialect::Postgres),
            table: Some(TableTarget { schema: Some("public".into()), table: "t".into() }),
            rows_per_insert: 2,
            ..Default::default()
        };
        let r = vec![vec![Value::Int(1), Value::Text("O'Brien'); DROP TABLE x; --".into())]];
        let s = export_to_string(&cols(), &r, o).unwrap();
        assert_eq!(s, "INSERT INTO \"public\".\"t\" (\"id\", \"name\") VALUES\n  (1, 'O''Brien''); DROP TABLE x; --');\n");
    }

    #[test]
    fn xml_escapes() {
        let r = vec![vec![Value::Int(1), Value::Text("<a>&\u{1}".into())]];
        let s = export_to_string(&cols(), &r, ExportOptions { format: ExportFormat::Xml, ..Default::default() }).unwrap();
        assert!(s.contains("<name>&lt;a&gt;&amp;</name>"), "{s}");
    }

    #[test]
    fn xlsx_produces_zip() {
        let mut buf = Vec::new();
        let mut e = Exporter::begin(&mut buf, &cols(), ExportOptions { format: ExportFormat::Xlsx, ..Default::default() }).unwrap();
        e.write_rows(&rows()).unwrap();
        e.finish().unwrap();
        assert_eq!(&buf[..2], b"PK");
    }
}
