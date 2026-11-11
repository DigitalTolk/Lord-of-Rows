import { describe, expect, it } from 'vitest';
import { allState, defaultSelection, rowTarget, toggleAll } from './importConnections';
import type { ConnImportRow } from './types';

const r = (key: string, status: ConnImportRow['status'], extra: Partial<ConnImportRow> = {}): ConnImportRow => ({
  key,
  name: key,
  source_engine: 'MySQL',
  engine: 'my_sql',
  host: 'db.example.com',
  port: null,
  database: 'app',
  username: null,
  environment: 'development',
  group: null,
  ssh: false,
  color: null,
  status,
  reason: null,
  notes: [],
  password: 'none',
  ...extra,
});

describe('import helpers', () => {
  const rows = [r('a', 'ready'), r('b', 'exists'), r('c', 'unsupported'), r('d', 'invalid')];
  it('selects ready rows by default; existing ones start unchecked', () => {
    expect([...defaultSelection(rows)]).toEqual(['a']);
  });
  it('select-all covers importable rows only', () => {
    expect(allState(rows, new Set(['a']))).toBe('some');
    const all = toggleAll(rows, new Set(['a']));
    expect([...all].sort()).toEqual(['a', 'b']);
    expect(allState(rows, all)).toBe('all');
    expect(toggleAll(rows, all).size).toBe(0);
  });
  it('formats host : database like the launcher', () => {
    expect(rowTarget(r('a', 'ready'))).toBe('db.example.com : app');
    expect(rowTarget(r('a', 'ready', { port: 3307, database: null }))).toBe('db.example.com:3307');
    expect(rowTarget(r('a', 'ready', { engine: 'sqlite', host: null, database: '/tmp/x/notes.db' }))).toBe('notes.db');
  });
});
