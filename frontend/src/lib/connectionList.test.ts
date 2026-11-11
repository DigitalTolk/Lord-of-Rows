import { describe, expect, it } from 'vitest';
import { buildSections, connectionSubtitle, connectionSubtitleTitle, matchesSearch, navItems } from './connectionList';
import type { ConnectionConfig, ConnectionGroup, EnvironmentKind, StoredConnection } from './types';

let n = 0;
function conn(p: Partial<ConnectionConfig> = {}): StoredConnection {
  n += 1;
  return {
    sort: n,
    config: {
      id: `id-${n}`,
      name: `conn ${n}`,
      engine: 'postgres',
      host: 'db.example.com',
      database: 'app',
      tls: { mode: 'preferred' },
      environment: 'local',
      read_only: false,
      tags: [],
      favorite: false,
      connect_timeout_secs: 10,
      ...p,
    },
  };
}
const grp = (name: string, p: Partial<ConnectionGroup> = {}): ConnectionGroup => ({ name, color: null, collapsed: false, sort: 0, ...p });
const names = (s: ReturnType<typeof buildSections>) => s.map((x) => [x.group?.name ?? null, x.items.map((c) => c.config.name)]);

describe('connectionSubtitle', () => {
  it('formats host : database', () => {
    expect(connectionSubtitle(conn({ host: 'pg.local', database: 'shop' }).config)).toBe('pg.local : shop');
    expect(connectionSubtitle(conn({ host: 'pg.local', database: null }).config)).toBe('pg.local');
    expect(connectionSubtitle(conn({ host: null, socket_path: '/tmp/.s.PGSQL.5432', database: 'x' }).config)).toBe('/tmp/.s.PGSQL.5432 : x');
  });

  it('shows SSH : database when tunnelled, with the full route in the tooltip', () => {
    const ssh = { host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'agent' as const, jump_hosts: [], keepalive_secs: 30 };
    const c = conn({ host: '10.0.0.5', database: 'orders', ssh }).config;
    expect(connectionSubtitle(c)).toBe('SSH : orders');
    expect(connectionSubtitleTitle(c)).toBe('SSH deploy@bastion.example.com:22 : 10.0.0.5 : orders');
    expect(connectionSubtitle(conn({ host: '10.0.0.5', database: null, ssh }).config)).toBe('SSH : 10.0.0.5');
  });

  it('shows the file name for SQLite / DuckDB and the full path as the tooltip', () => {
    const c = conn({ engine: 'sqlite', host: null, database: '/Users/me/data/very/long/path/app.sqlite3' }).config;
    expect(connectionSubtitle(c)).toBe('app.sqlite3');
    expect(connectionSubtitleTitle(c)).toBe('/Users/me/data/very/long/path/app.sqlite3');
    expect(connectionSubtitle(conn({ engine: 'duck_db', host: null, database: 'C:\\data\\w.duckdb' }).config)).toBe('w.duckdb');
  });

  it('shows endpoint or region for DynamoDB', () => {
    expect(connectionSubtitle(conn({ engine: 'dynamo_db', host: 'http://localhost:8000', database: 'us-east-1' }).config)).toBe('http://localhost:8000');
    expect(connectionSubtitle(conn({ engine: 'dynamo_db', host: '', database: 'eu-central-1' }).config)).toBe('eu-central-1');
  });
});

describe('matchesSearch', () => {
  const c = conn({ name: 'Billing', host: 'pg-billing.internal', database: 'ledger', group: 'Finance', environment: 'staging', tags: ['payments', 'eu'], username: 'svc' }).config;
  const label = (e: EnvironmentKind) => ({ staging: 'Staging' })[e as 'staging'] ?? e;

  it.each([['billing'], ['PG-BILL'], ['ledger'], ['finance'], ['staging'], ['payments'], ['eu'], ['svc']])('matches %s', (q) => {
    expect(matchesSearch(c, q, label)).toBe(true);
  });

  it('requires every term to match and ignores blank queries', () => {
    expect(matchesSearch(c, 'finance ledger', label)).toBe(true);
    expect(matchesSearch(c, 'finance production', label)).toBe(false);
    expect(matchesSearch(c, '   ', label)).toBe(true);
    expect(matchesSearch(c, 'nomatch', label)).toBe(false);
  });

  it('matches the translated environment label', () => {
    const p = conn({ environment: 'production' }).config;
    expect(matchesSearch(p, 'produktion', () => 'Produktion')).toBe(true);
  });
});

describe('buildSections', () => {
  const a = conn({ name: 'a', group: 'Work', environment: 'production' });
  const b = conn({ name: 'b', group: 'Work', favorite: true });
  const c = conn({ name: 'c', group: null, environment: 'staging' });
  const d = conn({ name: 'd', group: 'Side', environment: 'development' });
  const e = conn({ name: 'e', group: ' Implicit ' });
  const all = [a, b, c, d, e];
  const groups = [grp('Side', { sort: 1 }), grp('Work', { sort: 0 }), grp('Empty', { sort: 2 })];

  it('lists groups in stored order (implicit ones after, empty kept), favorites first, ungrouped last', () => {
    expect(names(buildSections(all, groups))).toEqual([
      ['Work', ['b', 'a']],
      ['Side', ['d']],
      ['Empty', []],
      ['Implicit', ['e']],
      [null, ['c']],
    ]);
  });

  it('hides groups without matches while searching', () => {
    expect(names(buildSections(all, groups, { q: 'work' }))).toEqual([['Work', ['b', 'a']]]);
    expect(names(buildSections(all, groups, { q: 'staging' }))).toEqual([[null, ['c']]]);
  });

  it('filters by environment (multi-select, empty = all)', () => {
    expect(names(buildSections(all, groups, { envs: new Set(['production']) }))).toEqual([['Work', ['a']]]);
    expect(names(buildSections(all, groups, { envs: new Set(['staging', 'development'] as EnvironmentKind[]) }))).toEqual([
      ['Side', ['d']],
      [null, ['c']],
    ]);
    expect(buildSections(all, groups, { envs: new Set() }).length).toBe(5);
  });

  it('combines search and environment filter', () => {
    expect(names(buildSections(all, groups, { q: 'side', envs: new Set(['production']) }))).toEqual([]);
  });
});

describe('navItems', () => {
  it('includes headers and skips rows of collapsed groups', () => {
    const a = conn({ group: 'G1' });
    const b = conn({ group: 'G2' });
    const c = conn({ group: null });
    const s = buildSections([a, b, c], [grp('G1', { collapsed: true }), grp('G2', { sort: 1 })]);
    expect(navItems(s, (g) => !g.collapsed)).toEqual([
      { kind: 'group', name: 'G1' },
      { kind: 'group', name: 'G2' },
      { kind: 'conn', id: b.config.id, group: 'G2' },
      { kind: 'conn', id: c.config.id, group: null },
    ]);
  });
});
