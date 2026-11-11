import { describe, expect, it } from 'vitest';
import { escapeGlob, flattenTree, isLiteralPattern, keyGridRows, mergeBatch, nodeId, parentPrefix, parentRowId, prefixPattern, prettyJson, separatorOf } from './redisKeys';
import type { KeyRow, KeyspaceInfo } from './types';

const DBS: KeyspaceInfo[] = [
  { name: 'db0', index: 0, keys: 10, expires: 0, current: true },
  { name: 'db1', index: 1, keys: 2, expires: 0, current: false },
];

describe('glob patterns', () => {
  it('escapes metacharacters so prefixes match literally', () => {
    expect(escapeGlob('a*b?[c]\\d')).toBe('a\\*b\\?\\[c\\]\\\\d');
    expect(prefixPattern('app:user:')).toBe('app:user:*');
    expect(prefixPattern('x*y:')).toBe('x\\*y:*');
    expect(isLiteralPattern(escapeGlob('weird*[key]?'))).toBe(true);
    expect(isLiteralPattern('user:*')).toBe(false);
    expect(isLiteralPattern('user:?')).toBe(false);
    expect(isLiteralPattern('plain:key')).toBe(true);
  });
  it('defaults the separator to ":"', () => {
    expect(separatorOf({ key_separator: null })).toBe(':');
    expect(separatorOf({ key_separator: '/' })).toBe('/');
  });
});

describe('namespace tree', () => {
  it('merges load-more batches: counts add up, keys dedupe and sort', () => {
    const a = mergeBatch(undefined, { namespaces: [{ prefix: 'u:', label: 'u', count: 3 }], keys: ['b', 'a'], cursor: 9, done: false, scanned: 5 });
    const b = mergeBatch(a, { namespaces: [{ prefix: 'u:', label: 'u', count: 2 }, { prefix: 'o:', label: 'o', count: 1 }], keys: ['a', 'c'], cursor: 0, done: true, scanned: 4 });
    expect(b.namespaces).toEqual([{ prefix: 'o:', label: 'o', count: 1 }, { prefix: 'u:', label: 'u', count: 5 }]);
    expect(b.keys).toEqual(['a', 'b', 'c']);
    expect(b.done).toBe(true);
    expect(a.namespaces[0].count).toBe(3); // previous state untouched
  });

  it('flattens expanded nodes with levels, load-more and loading rows', () => {
    const nodes = {
      [nodeId('db0', '')]: { namespaces: [{ prefix: 'app:', label: 'app', count: 4 }], keys: ['top'], cursor: 5, done: false },
      [nodeId('db0', 'app:')]: { namespaces: [], keys: ['app:x'], cursor: 0, done: true },
    };
    const rows = flattenTree(DBS, new Set([nodeId('db0', ''), nodeId('db0', 'app:'), nodeId('db1', '')]), nodes);
    expect(rows.map((r) => [r.kind, r.level, 'label' in r ? r.label : r.db])).toEqual([
      ['db', 1, 'db0'],
      ['ns', 2, 'app'],
      ['key', 3, 'x'],
      ['key', 2, 'top'],
      ['more', 2, 'db0'],
      ['db', 1, 'db1'],
      ['loading', 2, 'db1'],
    ]);
    // Collapsed: only databases.
    expect(flattenTree(DBS, new Set(), nodes).map((r) => r.kind)).toEqual(['db', 'db']);
    // Filter keeps databases and matching names.
    const f = flattenTree(DBS, new Set([nodeId('db0', '')]), nodes, 'TOP');
    expect(f.map((r) => r.kind)).toEqual(['db', 'key', 'more', 'db']);
  });

  it('finds parents for Left-arrow navigation', () => {
    const rows = flattenTree(DBS, new Set([nodeId('db0', ''), nodeId('db0', 'app:')]), {
      [nodeId('db0', '')]: { namespaces: [{ prefix: 'app:', label: 'app', count: 1 }], keys: [], cursor: 0, done: true },
      [nodeId('db0', 'app:')]: { namespaces: [], keys: ['app:'], cursor: 0, done: true },
    });
    const key = rows.find((r) => r.kind === 'key')!;
    expect(parentRowId(key, ':')).toBe(`ns:${nodeId('db0', 'app:')}`);
    expect(parentRowId(rows.find((r) => r.kind === 'ns')!, ':')).toBe('db:db0');
    expect(parentRowId(rows[0], ':')).toBeNull();
    expect(parentPrefix('a:b:', ':')).toBe('a:');
    expect(parentPrefix('a:', ':')).toBe('');
    expect(parentPrefix('a::b::', '::')).toBe('a::');
  });
});

describe('key grid', () => {
  it('renders typed rows with string previews and summaries', () => {
    const rows: KeyRow[] = [
      { key: 's', kind: 'string', ttl: 30, size: 64, length: 900, preview: 'x'.repeat(200), preview_truncated: true },
      { key: 'h', kind: 'hash', ttl: -1, size: null, length: 12, preview: null, preview_truncated: false },
    ];
    const g = keyGridRows(rows, (r) => `${r.kind} · ${r.length}`);
    expect(g[0]).toEqual([{ t: 'text', v: 's' }, { t: 'text', v: 'string' }, { t: 'int', v: 30 }, { t: 'int', v: 64 }, { t: 'text', v: 'x'.repeat(200) + '…' }]);
    expect(g[1][3]).toEqual({ t: 'null' });
    expect(g[1][4]).toEqual({ t: 'text', v: 'hash · 12' });
  });

  it('pretty-prints JSON objects and arrays only', () => {
    expect(prettyJson('{"a":1,"b":[true]}')).toBe('{\n  "a": 1,\n  "b": [\n    true\n  ]\n}');
    expect(prettyJson('[1]')).toBe('[\n  1\n]');
    expect(prettyJson('42')).toBeNull();
    expect(prettyJson('{not json}')).toBeNull();
  });
});
