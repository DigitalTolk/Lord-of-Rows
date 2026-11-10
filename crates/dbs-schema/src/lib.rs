//! Schema comparison, migration generation, and the table designer's DDL.
//!
//! `diff(source, target)` produces the changes needed to turn `target` into
//! `source` (i.e. "make target look like source"). Each change carries:
//! * forward SQL for the dialect,
//! * a reverse SQL **only when the reversal is genuinely lossless**,
//! * flags for destructive / locking / table-rewrite risk.
//!
//! Ordering: drops of foreign keys → drops of indexes → table/column drops →
//! creates → column changes → index creates → foreign-key creates, so
//! dependencies are satisfied. New tables are ordered by FK dependencies.

use std::collections::{BTreeMap, BTreeSet};

use dbs_core::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Change {
    CreateTable { table: TableDescription },
    DropTable { table: TableDescription },
    AddColumn { table: TableTarget, column: ColumnDef },
    DropColumn { table: TableTarget, column: ColumnDef },
    RenameColumn { table: TableTarget, from: String, to: String },
    AlterColumnType { table: TableTarget, column: String, from: String, to: String },
    AlterNullability { table: TableTarget, column: String, nullable: bool },
    AlterDefault { table: TableTarget, column: String, from: Option<String>, to: Option<String> },
    AlterComment { table: TableTarget, column: Option<String>, to: Option<String> },
    CreateIndex { table: TableTarget, index: IndexDef },
    DropIndex { table: TableTarget, index: IndexDef },
    AddForeignKey { table: TableTarget, fk: ForeignKeyDef },
    DropForeignKey { table: TableTarget, fk: ForeignKeyDef },
    AddConstraint { table: TableTarget, constraint: ConstraintDef },
    DropConstraint { table: TableTarget, constraint: ConstraintDef },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MigrationStep {
    pub change: Change,
    pub sql: Vec<String>,
    /// `None` = not reversible without data loss.
    pub reverse_sql: Option<Vec<String>>,
    pub destructive: bool,
    pub may_lock: bool,
    pub may_rewrite: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Migration {
    pub dialect: Dialect,
    pub steps: Vec<MigrationStep>,
}

impl Migration {
    pub fn is_reversible(&self) -> bool {
        self.steps.iter().all(|s| s.reverse_sql.is_some())
    }
    pub fn has_destructive(&self) -> bool {
        self.steps.iter().any(|s| s.destructive)
    }
    pub fn forward_script(&self) -> String {
        let mut out = String::new();
        for s in &self.steps {
            for w in &s.warnings {
                out.push_str(&format!("-- WARNING: {w}\n"));
            }
            for q in &s.sql {
                out.push_str(q);
                out.push_str(";\n");
            }
        }
        out
    }
    /// Reverse script, or `None` if any step is irreversible.
    pub fn reverse_script(&self) -> Option<String> {
        let mut out = String::new();
        for s in self.steps.iter().rev() {
            for q in s.reverse_sql.as_ref()? {
                out.push_str(q);
                out.push_str(";\n");
            }
        }
        Some(out)
    }
}

fn key(t: &TableDescription) -> (String, String) {
    (t.object.schema.clone().unwrap_or_default(), t.object.name.clone())
}

fn target_of(t: &TableDescription, schema_override: &Option<String>) -> TableTarget {
    TableTarget { schema: schema_override.clone().or_else(|| t.object.schema.clone()), table: t.object.name.clone() }
}

/// Options for comparing across environments where schema names differ.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiffOptions {
    /// Compare tables by name only, ignoring schema (e.g. `app_dev` vs `app_prod`).
    pub ignore_schema_names: bool,
    /// Schema to qualify generated SQL with (target's schema).
    pub target_schema: Option<String>,
    pub include_drops: bool,
}

fn norm_type(t: &str) -> String {
    let t = t.trim().to_ascii_lowercase();
    match t.as_str() {
        "int4" | "integer" | "int" => "integer".into(),
        "int8" | "bigint" => "bigint".into(),
        "int2" | "smallint" => "smallint".into(),
        "bool" | "boolean" => "boolean".into(),
        "varchar" | "character varying" => "character varying".into(),
        "timestamptz" | "timestamp with time zone" => "timestamp with time zone".into(),
        "timestamp" | "timestamp without time zone" => "timestamp without time zone".into(),
        _ => t.replace("character varying", "varchar"),
    }
}

pub fn diff(source: &[TableDescription], target: &[TableDescription], opts: &DiffOptions) -> Vec<Change> {
    let k = |t: &TableDescription| if opts.ignore_schema_names { (String::new(), t.object.name.clone()) } else { key(t) };
    let src: BTreeMap<_, _> = source.iter().map(|t| (k(t), t)).collect();
    let tgt: BTreeMap<_, _> = target.iter().map(|t| (k(t), t)).collect();
    let ts = &opts.target_schema;
    let mut changes = Vec::new();

    for (key, s) in &src {
        match tgt.get(key) {
            None => {
                let mut t = (*s).clone();
                if ts.is_some() {
                    t.object.schema = ts.clone();
                }
                changes.push(Change::CreateTable { table: t });
            }
            Some(t) => diff_table(s, t, &target_of(t, ts), opts, &mut changes),
        }
    }
    if opts.include_drops {
        for (key, t) in &tgt {
            if !src.contains_key(key) {
                changes.push(Change::DropTable { table: (*t).clone() });
            }
        }
    }
    order_changes(changes)
}

fn diff_table(s: &TableDescription, t: &TableDescription, tt: &TableTarget, opts: &DiffOptions, out: &mut Vec<Change>) {
    let tcols: BTreeMap<_, _> = t.columns.iter().map(|c| (c.name.as_str(), c)).collect();
    let scols: BTreeMap<_, _> = s.columns.iter().map(|c| (c.name.as_str(), c)).collect();
    for c in &s.columns {
        match tcols.get(c.name.as_str()) {
            None => out.push(Change::AddColumn { table: tt.clone(), column: c.clone() }),
            Some(tc) => {
                if norm_type(&c.data_type) != norm_type(&tc.data_type) {
                    out.push(Change::AlterColumnType { table: tt.clone(), column: c.name.clone(), from: tc.data_type.clone(), to: c.data_type.clone() });
                }
                if c.nullable != tc.nullable {
                    out.push(Change::AlterNullability { table: tt.clone(), column: c.name.clone(), nullable: c.nullable });
                }
                if c.default != tc.default && !c.is_identity {
                    out.push(Change::AlterDefault { table: tt.clone(), column: c.name.clone(), from: tc.default.clone(), to: c.default.clone() });
                }
                if c.comment != tc.comment {
                    out.push(Change::AlterComment { table: tt.clone(), column: Some(c.name.clone()), to: c.comment.clone() });
                }
            }
        }
    }
    if opts.include_drops {
        for c in &t.columns {
            if !scols.contains_key(c.name.as_str()) {
                out.push(Change::DropColumn { table: tt.clone(), column: c.clone() });
            }
        }
    }
    let idx_sig = |i: &IndexDef| (i.columns.clone(), i.unique);
    let tidx: BTreeMap<_, _> = t.indexes.iter().filter(|i| !i.primary).map(|i| (i.name.as_str(), i)).collect();
    let sidx: BTreeMap<_, _> = s.indexes.iter().filter(|i| !i.primary).map(|i| (i.name.as_str(), i)).collect();
    for (n, i) in &sidx {
        match tidx.get(n) {
            None => out.push(Change::CreateIndex { table: tt.clone(), index: (*i).clone() }),
            Some(ti) if idx_sig(ti) != idx_sig(i) => {
                out.push(Change::DropIndex { table: tt.clone(), index: (*ti).clone() });
                out.push(Change::CreateIndex { table: tt.clone(), index: (*i).clone() });
            }
            _ => {}
        }
    }
    if opts.include_drops {
        for (n, i) in &tidx {
            if !sidx.contains_key(n) {
                out.push(Change::DropIndex { table: tt.clone(), index: (*i).clone() });
            }
        }
    }
    let fk_sig = |f: &ForeignKeyDef| (f.columns.clone(), f.ref_table.clone(), f.ref_columns.clone(), f.on_delete.clone(), f.on_update.clone());
    let tfk: BTreeMap<_, _> = t.foreign_keys.iter().map(|f| (f.name.as_str(), f)).collect();
    let sfk: BTreeMap<_, _> = s.foreign_keys.iter().map(|f| (f.name.as_str(), f)).collect();
    for (n, f) in &sfk {
        match tfk.get(n) {
            None => out.push(Change::AddForeignKey { table: tt.clone(), fk: (*f).clone() }),
            Some(tf) if fk_sig(tf) != fk_sig(f) => {
                out.push(Change::DropForeignKey { table: tt.clone(), fk: (*tf).clone() });
                out.push(Change::AddForeignKey { table: tt.clone(), fk: (*f).clone() });
            }
            _ => {}
        }
    }
    if opts.include_drops {
        for (n, f) in &tfk {
            if !sfk.contains_key(n) {
                out.push(Change::DropForeignKey { table: tt.clone(), fk: (*f).clone() });
            }
        }
    }
    let tcon: BTreeMap<_, _> = t.constraints.iter().filter(|c| c.kind != "PRIMARY KEY").map(|c| (c.name.as_str(), c)).collect();
    let scon: BTreeMap<_, _> = s.constraints.iter().filter(|c| c.kind != "PRIMARY KEY").map(|c| (c.name.as_str(), c)).collect();
    for (n, c) in &scon {
        match tcon.get(n) {
            None => out.push(Change::AddConstraint { table: tt.clone(), constraint: (*c).clone() }),
            Some(tc) if tc.definition != c.definition => {
                out.push(Change::DropConstraint { table: tt.clone(), constraint: (*tc).clone() });
                out.push(Change::AddConstraint { table: tt.clone(), constraint: (*c).clone() });
            }
            _ => {}
        }
    }
    if opts.include_drops {
        for (n, c) in &tcon {
            if !scon.contains_key(n) {
                out.push(Change::DropConstraint { table: tt.clone(), constraint: (*c).clone() });
            }
        }
    }
    if s.comment != t.comment {
        out.push(Change::AlterComment { table: tt.clone(), column: None, to: s.comment.clone() });
    }
}

fn rank(c: &Change) -> u8 {
    match c {
        Change::DropForeignKey { .. } => 0,
        Change::DropConstraint { .. } => 1,
        Change::DropIndex { .. } => 2,
        Change::DropColumn { .. } => 3,
        Change::DropTable { .. } => 4,
        Change::CreateTable { .. } => 5,
        Change::AddColumn { .. } | Change::RenameColumn { .. } => 6,
        Change::AlterColumnType { .. } | Change::AlterNullability { .. } | Change::AlterDefault { .. } | Change::AlterComment { .. } => 7,
        Change::AddConstraint { .. } => 8,
        Change::CreateIndex { .. } => 9,
        Change::AddForeignKey { .. } => 10,
    }
}

fn order_changes(mut v: Vec<Change>) -> Vec<Change> {
    v.sort_by_key(rank);
    // Topologically order new tables so referenced tables are created first.
    // FKs are added at the end anyway, so cycles are harmless.
    let creates: Vec<Change> = v.iter().filter(|c| matches!(c, Change::CreateTable { .. })).cloned().collect();
    if creates.len() > 1 {
        let new_names: BTreeSet<String> = creates
            .iter()
            .filter_map(|c| if let Change::CreateTable { table } = c { Some(table.object.name.clone()) } else { None })
            .collect();
        let mut done: BTreeSet<String> = BTreeSet::new();
        let mut ordered = Vec::new();
        let mut pending = creates;
        while !pending.is_empty() {
            let before = pending.len();
            pending.retain(|c| {
                let Change::CreateTable { table } = c else { return false };
                let deps_ok = table.foreign_keys.iter().all(|f| f.ref_table == table.object.name || done.contains(&f.ref_table) || !new_names.contains(&f.ref_table));
                if deps_ok {
                    done.insert(table.object.name.clone());
                    ordered.push(c.clone());
                    false
                } else {
                    true
                }
            });
            if pending.len() == before {
                ordered.append(&mut pending); // cycle: FKs are added afterwards, so any order works
            }
        }
        let first = v.iter().position(|c| matches!(c, Change::CreateTable { .. })).unwrap();
        v.retain(|c| !matches!(c, Change::CreateTable { .. }));
        for (i, c) in ordered.into_iter().enumerate() {
            v.insert(first + i, c);
        }
    }
    v
}

fn cols(d: Dialect, cs: &[String]) -> DbResult<String> {
    Ok(cs.iter().map(|c| d.quote_ident(c)).collect::<DbResult<Vec<_>>>()?.join(", "))
}

fn column_def_sql(d: Dialect, c: &ColumnDef) -> DbResult<String> {
    let mut s = format!("{} {}", d.quote_ident(&c.name)?, c.data_type);
    if c.is_identity && d == Dialect::MySql && !c.data_type.to_ascii_lowercase().contains("auto_increment") {
        s.push_str(" AUTO_INCREMENT");
    }
    if let Some(def) = &c.default {
        s.push_str(&format!(" DEFAULT {def}"));
    }
    if !c.nullable {
        s.push_str(" NOT NULL");
    }
    if d == Dialect::MySql {
        if let Some(cm) = &c.comment {
            s.push_str(&format!(" COMMENT {}", d.literal(&Value::Text(cm.clone()))));
        }
    }
    Ok(s)
}

pub fn create_table_sql(d: Dialect, t: &TableDescription) -> DbResult<Vec<String>> {
    let name = d.qualified(&TableTarget { schema: t.object.schema.clone(), table: t.object.name.clone() })?;
    let mut lines = t.columns.iter().map(|c| column_def_sql(d, c).map(|s| format!("  {s}"))).collect::<DbResult<Vec<_>>>()?;
    if !t.primary_key.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", cols(d, &t.primary_key)?));
    }
    for c in &t.constraints {
        if c.kind == "PRIMARY KEY" {
            continue;
        }
        if let Some(def) = &c.definition {
            let body = if c.kind == "CHECK" && !def.to_ascii_uppercase().starts_with("CHECK") { format!("CHECK ({def})") } else { def.clone() };
            lines.push(format!("  CONSTRAINT {} {body}", d.quote_ident(&c.name)?));
        }
    }
    let mut out = vec![format!("CREATE TABLE {name} (\n{}\n)", lines.join(",\n"))];
    if d == Dialect::Postgres {
        if let Some(cm) = &t.comment {
            out.push(format!("COMMENT ON TABLE {name} IS {}", d.literal(&Value::Text(cm.clone()))));
        }
        for c in &t.columns {
            if let Some(cm) = &c.comment {
                out.push(format!("COMMENT ON COLUMN {name}.{} IS {}", d.quote_ident(&c.name)?, d.literal(&Value::Text(cm.clone()))));
            }
        }
    }
    let tt = TableTarget { schema: t.object.schema.clone(), table: t.object.name.clone() };
    for i in t.indexes.iter().filter(|i| !i.primary) {
        out.extend(create_index_sql(d, &tt, i)?);
    }
    Ok(out)
}

fn create_index_sql(d: Dialect, t: &TableTarget, i: &IndexDef) -> DbResult<Vec<String>> {
    // Prefer the engine's own definition (keeps partial/expression indexes exact).
    if let Some(def) = &i.definition {
        if def.to_ascii_uppercase().starts_with("CREATE") {
            return Ok(vec![def.clone()]);
        }
    }
    let name = d.quote_ident(&i.name)?;
    let on = d.qualified(t)?;
    Ok(vec![format!("CREATE {}INDEX {name} ON {on} ({})", if i.unique { "UNIQUE " } else { "" }, cols(d, &i.columns)?)])
}

fn drop_index_sql(d: Dialect, t: &TableTarget, i: &IndexDef) -> DbResult<String> {
    Ok(match d {
        Dialect::MySql => format!("DROP INDEX {} ON {}", d.quote_ident(&i.name)?, d.qualified(t)?),
        _ => format!("DROP INDEX {}", d.qualified(&TableTarget { schema: t.schema.clone(), table: i.name.clone() })?),
    })
}

fn fk_sql(d: Dialect, t: &TableTarget, f: &ForeignKeyDef) -> DbResult<String> {
    let rt = d.qualified(&TableTarget { schema: f.ref_schema.clone().or_else(|| t.schema.clone()), table: f.ref_table.clone() })?;
    Ok(format!(
        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {rt} ({}) ON UPDATE {} ON DELETE {}",
        d.qualified(t)?,
        d.quote_ident(&f.name)?,
        cols(d, &f.columns)?,
        cols(d, &f.ref_columns)?,
        f.on_update.as_deref().unwrap_or("NO ACTION"),
        f.on_delete.as_deref().unwrap_or("NO ACTION")
    ))
}

fn drop_fk_sql(d: Dialect, t: &TableTarget, f: &ForeignKeyDef) -> DbResult<String> {
    Ok(match d {
        Dialect::MySql => format!("ALTER TABLE {} DROP FOREIGN KEY {}", d.qualified(t)?, d.quote_ident(&f.name)?),
        _ => format!("ALTER TABLE {} DROP CONSTRAINT {}", d.qualified(t)?, d.quote_ident(&f.name)?),
    })
}

/// Generate SQL for each change. SQLite cannot ALTER column type/nullability/
/// constraints in place; those steps return an Unsupported error describing the
/// required table rebuild instead of emitting incorrect SQL.
pub fn plan(d: Dialect, changes: &[Change], current: &[TableDescription]) -> DbResult<Migration> {
    let mut steps = Vec::new();
    let col_of = |t: &TableTarget, c: &str| {
        current.iter().find(|x| x.object.name == t.table).and_then(|x| x.columns.iter().find(|cc| cc.name == c)).cloned()
    };
    for ch in changes {
        let mut st = MigrationStep { change: ch.clone(), sql: vec![], reverse_sql: None, destructive: false, may_lock: false, may_rewrite: false, warnings: vec![] };
        match ch {
            Change::CreateTable { table } => {
                st.sql = create_table_sql(d, table)?;
                let n = d.qualified(&TableTarget { schema: table.object.schema.clone(), table: table.object.name.clone() })?;
                st.reverse_sql = Some(vec![format!("DROP TABLE {n}")]);
            }
            Change::DropTable { table } => {
                let n = d.qualified(&TableTarget { schema: table.object.schema.clone(), table: table.object.name.clone() })?;
                st.sql = vec![format!("DROP TABLE {n}")];
                st.destructive = true;
                st.warnings.push(format!("drops table {} and all of its data; not reversible", table.object.name));
            }
            Change::AddColumn { table, column } => {
                let t = d.qualified(table)?;
                st.sql = vec![format!("ALTER TABLE {t} ADD COLUMN {}", column_def_sql(d, column)?)];
                st.reverse_sql = Some(vec![format!("ALTER TABLE {t} DROP COLUMN {}", d.quote_ident(&column.name)?)]);
                st.may_lock = true;
                if !column.nullable && column.default.is_none() {
                    st.warnings.push(format!("adding NOT NULL column {} without a default fails if the table has rows", column.name));
                }
                if d == Dialect::MySql {
                    st.may_rewrite = true;
                }
            }
            Change::DropColumn { table, column } => {
                st.sql = vec![format!("ALTER TABLE {} DROP COLUMN {}", d.qualified(table)?, d.quote_ident(&column.name)?)];
                st.destructive = true;
                st.may_lock = true;
                st.warnings.push(format!("drops column {} and its data; not reversible", column.name));
            }
            Change::RenameColumn { table, from, to } => {
                let t = d.qualified(table)?;
                st.sql = vec![format!("ALTER TABLE {t} RENAME COLUMN {} TO {}", d.quote_ident(from)?, d.quote_ident(to)?)];
                st.reverse_sql = Some(vec![format!("ALTER TABLE {t} RENAME COLUMN {} TO {}", d.quote_ident(to)?, d.quote_ident(from)?)]);
                st.may_lock = true;
            }
            Change::AlterColumnType { table, column, from, to } => {
                let t = d.qualified(table)?;
                let c = d.quote_ident(column)?;
                st.sql = vec![match d {
                    Dialect::Postgres => format!("ALTER TABLE {t} ALTER COLUMN {c} TYPE {to} USING {c}::{to}"),
                    Dialect::MySql => {
                        let mut def = col_of(table, column).ok_or_else(|| DbError::invalid("unknown column"))?;
                        def.data_type = to.clone();
                        format!("ALTER TABLE {t} MODIFY COLUMN {}", column_def_sql(d, &def)?)
                    }
                    Dialect::SqlServer => format!("ALTER TABLE {t} ALTER COLUMN {c} {to}"),
                    _ => return Err(DbError::unsupported("changing a column type in SQLite (requires rebuilding the table)")),
                }];
                st.may_lock = true;
                st.may_rewrite = true;
                st.warnings.push(format!("type change {from} → {to} may rewrite the table and can fail or truncate values"));
                // Reversal is lossless only when widening; we can't prove that generally.
                st.reverse_sql = None;
            }
            Change::AlterNullability { table, column, nullable } => {
                let t = d.qualified(table)?;
                let c = d.quote_ident(column)?;
                let (fwd, rev) = match d {
                    Dialect::Postgres => (
                        format!("ALTER TABLE {t} ALTER COLUMN {c} {} NOT NULL", if *nullable { "DROP" } else { "SET" }),
                        format!("ALTER TABLE {t} ALTER COLUMN {c} {} NOT NULL", if *nullable { "SET" } else { "DROP" }),
                    ),
                    Dialect::MySql => {
                        let mut def = col_of(table, column).ok_or_else(|| DbError::invalid("unknown column"))?;
                        def.nullable = *nullable;
                        let fwd = format!("ALTER TABLE {t} MODIFY COLUMN {}", column_def_sql(d, &def)?);
                        def.nullable = !*nullable;
                        (fwd, format!("ALTER TABLE {t} MODIFY COLUMN {}", column_def_sql(d, &def)?))
                    }
                    _ => return Err(DbError::unsupported("changing nullability in SQLite (requires rebuilding the table)")),
                };
                st.sql = vec![fwd];
                st.may_lock = true;
                if !*nullable {
                    st.warnings.push(format!("SET NOT NULL on {column} fails if NULLs exist and scans the table"));
                    st.reverse_sql = Some(vec![rev]);
                } else {
                    // Reverting DROP NOT NULL may fail once NULLs are written.
                    st.reverse_sql = Some(vec![rev]);
                    st.warnings.push("reverting requires that no NULLs were inserted meanwhile".into());
                }
            }
            Change::AlterDefault { table, column, from, to } => {
                let t = d.qualified(table)?;
                let c = d.quote_ident(column)?;
                let set = |v: &Option<String>| match v {
                    Some(x) => format!("ALTER TABLE {t} ALTER COLUMN {c} SET DEFAULT {x}"),
                    None => format!("ALTER TABLE {t} ALTER COLUMN {c} DROP DEFAULT"),
                };
                if d == Dialect::Sqlite {
                    return Err(DbError::unsupported("changing a column default in SQLite (requires rebuilding the table)"));
                }
                st.sql = vec![set(to)];
                st.reverse_sql = Some(vec![set(from)]);
            }
            Change::AlterComment { table, column, to } => {
                let t = d.qualified(table)?;
                let lit = to.as_ref().map(|s| d.literal(&Value::Text(s.clone()))).unwrap_or_else(|| "NULL".into());
                st.sql = vec![match (d, column) {
                    (Dialect::Postgres, Some(c)) => format!("COMMENT ON COLUMN {t}.{} IS {lit}", d.quote_ident(c)?),
                    (Dialect::Postgres, None) => format!("COMMENT ON TABLE {t} IS {lit}"),
                    (Dialect::MySql, None) => format!("ALTER TABLE {t} COMMENT = {}", to.as_ref().map(|s| d.literal(&Value::Text(s.clone()))).unwrap_or("''".into())),
                    (Dialect::MySql, Some(c)) => {
                        let mut def = col_of(table, c).ok_or_else(|| DbError::invalid("unknown column"))?;
                        def.comment = to.clone();
                        format!("ALTER TABLE {t} MODIFY COLUMN {}", column_def_sql(d, &def)?)
                    }
                    _ => return Err(DbError::unsupported("comments in this engine")),
                }];
                st.reverse_sql = None;
            }
            Change::CreateIndex { table, index } => {
                st.sql = create_index_sql(d, table, index)?;
                st.reverse_sql = Some(vec![drop_index_sql(d, table, index)?]);
                st.may_lock = !(d == Dialect::Postgres && st.sql[0].to_ascii_uppercase().contains("CONCURRENTLY"));
                if st.may_lock && d == Dialect::Postgres {
                    st.warnings.push(format!("CREATE INDEX {} blocks writes; consider CREATE INDEX CONCURRENTLY outside a transaction", index.name));
                }
            }
            Change::DropIndex { table, index } => {
                st.sql = vec![drop_index_sql(d, table, index)?];
                st.reverse_sql = Some(create_index_sql(d, table, index)?);
                st.may_lock = true;
            }
            Change::AddForeignKey { table, fk } => {
                if d == Dialect::Sqlite {
                    return Err(DbError::unsupported("adding a foreign key in SQLite (requires rebuilding the table)"));
                }
                st.sql = vec![fk_sql(d, table, fk)?];
                st.reverse_sql = Some(vec![drop_fk_sql(d, table, fk)?]);
                st.may_lock = true;
            }
            Change::DropForeignKey { table, fk } => {
                if d == Dialect::Sqlite {
                    return Err(DbError::unsupported("dropping a foreign key in SQLite (requires rebuilding the table)"));
                }
                st.sql = vec![drop_fk_sql(d, table, fk)?];
                st.reverse_sql = Some(vec![fk_sql(d, table, fk)?]);
            }
            Change::AddConstraint { table, constraint } => {
                let t = d.qualified(table)?;
                let def = constraint.definition.clone().ok_or_else(|| DbError::invalid("constraint has no definition"))?;
                st.sql = vec![format!("ALTER TABLE {t} ADD CONSTRAINT {} {def}", d.quote_ident(&constraint.name)?)];
                let drop_kw = if d == Dialect::MySql && constraint.kind == "UNIQUE" { "INDEX" } else if d == Dialect::MySql { "CHECK" } else { "CONSTRAINT" };
                st.reverse_sql = Some(vec![format!("ALTER TABLE {t} DROP {drop_kw} {}", d.quote_ident(&constraint.name)?)]);
                st.may_lock = true;
            }
            Change::DropConstraint { table, constraint } => {
                let t = d.qualified(table)?;
                let drop_kw = if d == Dialect::MySql && constraint.kind == "UNIQUE" { "INDEX" } else if d == Dialect::MySql { "CHECK" } else { "CONSTRAINT" };
                st.sql = vec![format!("ALTER TABLE {t} DROP {drop_kw} {}", d.quote_ident(&constraint.name)?)];
                if let Some(def) = &constraint.definition {
                    st.reverse_sql = Some(vec![format!("ALTER TABLE {t} ADD CONSTRAINT {} {def}", d.quote_ident(&constraint.name)?)]);
                }
            }
        }
        steps.push(st);
    }
    Ok(Migration { dialect: d, steps })
}

/// Table designer: compare the original description with the edited one and
/// produce a migration (with renames, which a diff can't infer, supplied explicitly).
pub fn designer_migration(d: Dialect, original: Option<&TableDescription>, edited: &TableDescription, renames: &[(String, String)]) -> DbResult<Migration> {
    let Some(orig) = original else {
        return plan(d, &[Change::CreateTable { table: edited.clone() }], &[]);
    };
    let tt = TableTarget { schema: orig.object.schema.clone(), table: orig.object.name.clone() };
    let mut renamed = orig.clone();
    let mut changes = Vec::new();
    for (from, to) in renames {
        if let Some(c) = renamed.columns.iter_mut().find(|c| &c.name == from) {
            c.name = to.clone();
            changes.push(Change::RenameColumn { table: tt.clone(), from: from.clone(), to: to.clone() });
        }
    }
    let mut e2 = edited.clone();
    e2.object = renamed.object.clone();
    let mut rest = diff(&[e2], &[renamed.clone()], &DiffOptions { include_drops: true, target_schema: tt.schema.clone(), ignore_schema_names: false });
    changes.append(&mut rest);
    let changes = order_changes(changes);
    let mut m = plan(d, &changes, std::slice::from_ref(&renamed))?;
    if edited.object.name != orig.object.name {
        let from = d.qualified(&tt)?;
        let to_ident = d.quote_ident(&edited.object.name)?;
        let sql = match d {
            Dialect::MySql => format!("RENAME TABLE {from} TO {}", d.qualified(&TableTarget { schema: tt.schema.clone(), table: edited.object.name.clone() })?),
            _ => format!("ALTER TABLE {from} RENAME TO {to_ident}"),
        };
        let back = match d {
            Dialect::MySql => format!("RENAME TABLE {} TO {from}", d.qualified(&TableTarget { schema: tt.schema.clone(), table: edited.object.name.clone() })?),
            _ => format!("ALTER TABLE {} RENAME TO {}", d.qualified(&TableTarget { schema: tt.schema.clone(), table: edited.object.name.clone() })?, d.quote_ident(&orig.object.name)?),
        };
        m.steps.push(MigrationStep {
            change: Change::RenameColumn { table: tt, from: orig.object.name.clone(), to: edited.object.name.clone() },
            sql: vec![sql],
            reverse_sql: Some(vec![back]),
            destructive: false,
            may_lock: true,
            may_rewrite: false,
            warnings: vec!["renaming a table breaks queries and views that reference the old name".into()],
        });
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(n: &str, ty: &str, nullable: bool) -> ColumnDef {
        ColumnDef { name: n.into(), data_type: ty.into(), nullable, default: None, is_primary_key: false, is_identity: false, comment: None, ordinal: 0 }
    }
    fn table(name: &str, cols: Vec<ColumnDef>) -> TableDescription {
        TableDescription {
            object: ObjectRef { kind: ObjectKind::Table, database: None, schema: Some("public".into()), name: name.into() },
            primary_key: vec!["id".into()],
            columns: cols,
            indexes: vec![],
            foreign_keys: vec![],
            constraints: vec![],
            ddl: None,
            estimated_rows: None,
            comment: None,
        }
    }

    #[test]
    fn detects_column_changes_and_orders_steps() {
        let target = vec![table("users", vec![col("id", "int4", false), col("name", "text", true), col("old", "text", true)])];
        let mut s = table("users", vec![col("id", "integer", false), col("name", "varchar(100)", false), col("email", "text", true)]);
        s.indexes.push(IndexDef { name: "users_email".into(), columns: vec!["email".into()], unique: true, primary: false, definition: None });
        let source = vec![s, table("orders", vec![col("id", "int", false)])];
        let ch = diff(&source, &target, &DiffOptions { include_drops: true, ..Default::default() });
        let m = plan(Dialect::Postgres, &ch, &target).unwrap();
        let script = m.forward_script();
        assert!(!script.contains("ALTER COLUMN \"id\" TYPE"), "int4 == integer: {script}");
        assert!(script.contains("ADD COLUMN \"email\" text"));
        assert!(script.contains("ALTER COLUMN \"name\" TYPE varchar(100)"));
        assert!(script.contains("ALTER COLUMN \"name\" SET NOT NULL"));
        assert!(script.contains("DROP COLUMN \"old\""));
        assert!(script.contains("CREATE TABLE \"public\".\"orders\""));
        assert!(script.contains("CREATE UNIQUE INDEX \"users_email\""));
        assert!(m.has_destructive());
        assert!(!m.is_reversible(), "drop column + type change are irreversible");
        assert!(m.reverse_script().is_none());
        // drops come before creates
        assert!(script.find("DROP COLUMN").unwrap() < script.find("CREATE TABLE").unwrap());
    }

    #[test]
    fn additive_migration_is_reversible() {
        let target = vec![table("t", vec![col("id", "int", false)])];
        let source = vec![table("t", vec![col("id", "int", false), col("note", "text", true)])];
        let m = plan(Dialect::MySql, &diff(&source, &target, &DiffOptions::default()), &target).unwrap();
        assert!(m.is_reversible());
        assert_eq!(m.reverse_script().unwrap(), "ALTER TABLE `public`.`t` DROP COLUMN `note`;\n");
    }

    #[test]
    fn drops_excluded_unless_requested() {
        let target = vec![table("t", vec![col("id", "int", false), col("x", "int", true)]), table("gone", vec![])];
        let source = vec![table("t", vec![col("id", "int", false)])];
        assert!(diff(&source, &target, &DiffOptions::default()).is_empty());
    }

    #[test]
    fn sqlite_refuses_unsupported_alters() {
        let target = vec![table("t", vec![col("id", "int", false)])];
        let source = vec![table("t", vec![col("id", "bigint", false)])];
        let e = plan(Dialect::Sqlite, &diff(&source, &target, &DiffOptions::default()), &target).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Unsupported);
    }

    #[test]
    fn cross_environment_ignores_schema_name() {
        let mut a = table("t", vec![col("id", "int", false)]);
        a.object.schema = Some("app_dev".into());
        let mut b = table("t", vec![col("id", "int", false)]);
        b.object.schema = Some("app_prod".into());
        let ch = diff(&[a], &[b], &DiffOptions { ignore_schema_names: true, target_schema: Some("app_prod".into()), include_drops: true });
        assert!(ch.is_empty(), "{ch:?}");
    }

    #[test]
    fn designer_rename_and_add() {
        let orig = table("t", vec![col("id", "int", false), col("nm", "text", true)]);
        let mut edited = table("t2", vec![col("id", "int", false), col("name", "text", true), col("age", "int", true)]);
        edited.object.schema = Some("public".into());
        let m = designer_migration(Dialect::Postgres, Some(&orig), &edited, &[("nm".into(), "name".into())]).unwrap();
        let s = m.forward_script();
        assert!(s.contains("RENAME COLUMN \"nm\" TO \"name\""), "{s}");
        assert!(s.contains("ADD COLUMN \"age\" int"));
        assert!(!s.contains("DROP COLUMN"), "{s}");
        assert!(s.contains("RENAME TO \"t2\""));
        assert!(m.is_reversible());
    }

    #[test]
    fn identifiers_are_quoted_in_ddl() {
        let t = table("we\"ird", vec![col("a\"b", "int", true)]);
        let s = create_table_sql(Dialect::Postgres, &t).unwrap();
        assert!(s[0].contains("\"we\"\"ird\""));
        assert!(s[0].contains("\"a\"\"b\" int"));
    }
}
