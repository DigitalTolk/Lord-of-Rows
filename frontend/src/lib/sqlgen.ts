// SQL text generation for editor templates. Output is placed in an editor for
// the user to review; it is never executed directly.
import type { Engine, TableDescription } from './types';

export type DialectFamily = 'pg' | 'mysql' | 'sqlite' | 'mssql' | 'generic';

export function family(e: Engine): DialectFamily {
  if (['postgres', 'cockroach_db', 'yugabyte_db', 'redshift', 'greenplum'].includes(e)) return 'pg';
  if (['my_sql', 'maria_db', 'percona', 'single_store'].includes(e)) return 'mysql';
  if (['sqlite', 'duck_db', 'lib_sql', 'turso', 'cloudflare_d1'].includes(e)) return 'sqlite';
  if (e === 'sql_server') return 'mssql';
  return 'generic';
}

export function quoteIdent(e: Engine, s: string): string {
  switch (family(e)) {
    case 'mysql':
      return '`' + s.replace(/`/g, '``') + '`';
    case 'mssql':
      return '[' + s.replace(/]/g, ']]') + ']';
    default:
      return '"' + s.replace(/"/g, '""') + '"';
  }
}

export function qualify(e: Engine, schema: string | null | undefined, name: string): string {
  return schema ? `${quoteIdent(e, schema)}.${quoteIdent(e, name)}` : quoteIdent(e, name);
}

export function generateSql(kind: 'select' | 'insert' | 'update' | 'delete', e: Engine, d: TableDescription): string {
  const t = qualify(e, d.object.schema, d.object.name);
  const cols = d.columns.map((c) => quoteIdent(e, c.name));
  const pk = d.primary_key.length ? d.primary_key : d.columns.slice(0, 1).map((c) => c.name);
  const where = pk.map((k) => `${quoteIdent(e, k)} = ?`).join(' AND ');
  switch (kind) {
    case 'select':
      return `SELECT\n  ${cols.join(',\n  ')}\nFROM ${t}\nLIMIT 100;`;
    case 'insert':
      return `INSERT INTO ${t} (${cols.join(', ')})\nVALUES (${cols.map(() => '?').join(', ')});`;
    case 'update':
      return `UPDATE ${t}\nSET\n  ${d.columns.filter((c) => !pk.includes(c.name)).map((c) => `${quoteIdent(e, c.name)} = ?`).join(',\n  ')}\nWHERE ${where};`;
    case 'delete':
      return `DELETE FROM ${t}\nWHERE ${where};`;
  }
}
