import { describe, expect, it } from 'vitest';
import { buildItems, filterItems, isSystemSchema, moveIndex } from './openDatabase';

describe('open database picker helpers', () => {
  it('recognises MySQL and Postgres system schemas', () => {
    for (const s of ['information_schema', 'performance_schema', 'mysql', 'sys', 'pg_catalog', 'pg_toast', 'pg_toast_temp_1', 'pg_temp_3', 'INFORMATION_SCHEMA']) expect(isSystemSchema(s), s).toBe(true);
    for (const s of ['public', 'shop', 'app', 'mysql_app', 'system']) expect(isSystemSchema(s), s).toBe(false);
  });

  it('orders user schemas first (server order), system ones after, then other databases', () => {
    const items = buildItems(['information_schema', 'shop', 'mysql', 'app', 'sys'], 'app');
    expect(items.map((x) => [x.name, x.section])).toEqual([
      ['shop', 'user'], ['app', 'user'], ['information_schema', 'system'], ['mysql', 'system'], ['sys', 'system'],
    ]);
    expect(items.filter((x) => x.current).map((x) => x.name)).toEqual(['app']);
    const pg = buildItems(['public', 'pg_catalog'], 'public', ['dbs_test', 'postgres', 'other'], 'dbs_test');
    expect(pg.map((x) => `${x.section}:${x.name}`)).toEqual(['user:public', 'system:pg_catalog', 'other:postgres', 'other:other']);
    expect(pg.find((x) => x.section === 'other' && x.name === 'public')).toBeUndefined();
  });

  it('filters case-insensitively by substring and keeps the order', () => {
    const items = buildItems(['Orders', 'shop', 'performance_schema', 'order_archive'], null);
    expect(filterItems(items, ' ORD ').map((x) => x.name)).toEqual(['Orders', 'order_archive']);
    expect(filterItems(items, '').length).toBe(4);
    expect(filterItems(items, 'zzz')).toEqual([]);
  });

  it('moves the active index with arrows and pages, clamped to the list', () => {
    expect(moveIndex(0, 'ArrowDown', 3)).toBe(1);
    expect(moveIndex(2, 'ArrowDown', 3)).toBe(2);
    expect(moveIndex(0, 'ArrowUp', 3)).toBe(0);
    expect(moveIndex(1, 'PageDown', 30)).toBe(11);
    expect(moveIndex(5, 'PageUp', 30)).toBe(0);
    expect(moveIndex(0, 'Enter', 3)).toBeNull();
    expect(moveIndex(0, 'ArrowDown', 0)).toBeNull();
  });
});
