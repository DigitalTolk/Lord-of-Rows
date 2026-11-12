import { describe, expect, it } from 'vitest';
import { ageLabel, draftFrom, timeline, validTicket, envsPresent, isFiltered, matchesFilter, segmentCounts, segmentRequests, draftProblem, durationLabel, expiringSoon, groupResources, isEnded, managedState, newlyReady, pollDelay, readyCount, requestPhase, sortRequests, shortDurationLabel, timeLeft } from './access';
import type { AccessRequestView, AccessResource, ConnectionConfig, StoredConnection } from './types';

const NOW = 1_800_000_000;

const req = (id: string, extra: Partial<AccessRequestView> = {}): AccessRequestView => ({
  id,
  resource_id: 'res-1',
  resource_name: 'orders',
  environment_name: 'staging',
  environment: 'staging',
  engine: 'postgres',
  access: 'read_only',
  reason: 'ticket',
  databases: ['shop'],
  create_database: false,
  status: 'pending',
  requester: { id: 'u1', name: 'Dev', email: 'dev@example.com' },
  log: [],
  created_at: '2027-01-15T08:00:00Z',
  connection_expired: false,
  ...extra,
});

const conn = (id: string, managed: ConnectionConfig['managed_by']): StoredConnection => ({
  sort: 0,
  config: { id, name: id, engine: 'postgres', tls: { mode: 'required' }, environment: 'staging', read_only: false, tags: [], favorite: false, connect_timeout_secs: 10, managed_by: managed },
});
const managed = (expires_at: number | null, expired = false) => ({ provider_id: 'p1', provider_kind: 'access-api', request_id: 'r1', expires_at, expired });

describe('access helpers', () => {
  it('shows a ready request past its expiry as expired', () => {
    expect(requestPhase({ status: 'ready', expires_at: NOW + 1 }, NOW)).toBe('ready');
    expect(requestPhase({ status: 'ready', expires_at: NOW }, NOW)).toBe('expired');
    expect(requestPhase({ status: 'ready', expires_at: null }, NOW)).toBe('ready');
    expect(requestPhase({ status: 'cancelled' }, NOW)).toBe('cancelled');
    expect(isEnded('cancelled') && isEnded('failed') && !isEnded('pending')).toBe(true);
  });

  it('polls fast when visible or in flight and backs off on errors', () => {
    expect(pollDelay({ visible: true, inFlight: false, errors: 0 })).toBe(5000);
    expect(pollDelay({ visible: false, inFlight: true, errors: 0 })).toBe(5000);
    expect(pollDelay({ visible: false, inFlight: false, errors: 0 })).toBe(60000);
    expect(pollDelay({ visible: true, inFlight: false, errors: 2 })).toBe(20000);
    expect(pollDelay({ visible: false, inFlight: false, errors: 9 })).toBe(300000);
  });

  it('formats time left', () => {
    expect(timeLeft(null, NOW)).toBeNull();
    const l = timeLeft(NOW + 3 * 3600 + 12 * 60, NOW)!;
    expect(durationLabel(l)).toEqual({ key: 'access.durHm', vars: { h: 3, m: 12 } });
    expect(durationLabel(timeLeft(NOW + 2 * 86400 + 4 * 3600, NOW)!)).toEqual({ key: 'access.durDh', vars: { d: 2, h: 4 } });
    expect(durationLabel(timeLeft(NOW + 20, NOW)!)).toEqual({ key: 'access.durM', vars: { m: 1 } });
    expect(ageLabel(30).key).toBe('access.ageM');
    expect(ageLabel(7200)).toEqual({ key: 'access.ageH', vars: { count: 2 } });
    expect(ageLabel(3 * 86400).vars.count).toBe(3);
  });

  it('detects requests that just became ready', () => {
    const before = [req('a'), req('b', { status: 'provisioning' }), req('c', { status: 'ready' })];
    const after = [req('a'), req('b', { status: 'ready' }), req('c', { status: 'ready' }), req('d', { status: 'ready' })];
    expect(newlyReady(null, after, NOW)).toEqual([]);
    expect(newlyReady(before, after, NOW).map((r) => r.id)).toEqual(['b']);
  });

  it('managed connections: countdown, expiry and 15-minute warnings', () => {
    expect(managedState(conn('x', null).config, NOW)).toBeNull();
    expect(managedState(conn('x', managed(NOW - 1)).config, NOW)?.expired).toBe(true);
    expect(managedState(conn('x', managed(NOW + 600, true)).config, NOW)?.expired).toBe(true);
    expect(managedState(conn('x', managed(NOW + 600)).config, NOW)?.left?.secs).toBe(600);
    const list = [conn('soon', managed(NOW + 600)), conn('later', managed(NOW + 7200)), conn('gone', managed(NOW - 5)), conn('plain', null)];
    expect(expiringSoon(list, NOW, new Set()).map((c) => c.id)).toEqual(['soon']);
    expect(expiringSoon(list, NOW, new Set(['soon']))).toEqual([]);
  });

  it('groups resources by environment, production last, with search', () => {
    const r = (id: string, env: string, kind: AccessResource['environment'], host = 'db.example.com'): AccessResource => ({ id, name: id, environment_name: env, environment: kind, engine: 'postgres', host, access_levels: ['read_only'] });
    const all = [r('billing', 'prod', 'production'), r('orders', 'staging', 'staging'), r('events', 'dev', 'development', 'events.internal.example.com')];
    expect(groupResources(all, '').map((g) => g.environment)).toEqual(['dev', 'staging', 'prod']);
    expect(groupResources(all, 'EVENTS.internal').flatMap((g) => g.resources.map((x) => x.id))).toEqual(['events']);
    expect(groupResources(all, 'prod').map((g) => g.environment)).toEqual(['prod']);
  });

  it('drafts and validation for (re)requests', () => {
    const d = draftFrom(req('a', { access: 'read_write', databases: ['shop', 'audit'] }));
    expect(d).toEqual({ resourceId: 'res-1', access: 'read_write', databases: ['shop', 'audit'], reason: 'ticket' });
    expect(draftFrom(req('b', { create_database: true })).databases).toEqual([]);
    expect(draftProblem({ ...d, resourceId: '' }, null)).toBe('resource');
    expect(draftProblem({ ...d, databases: [] }, null)).toBe('databases');
    expect(draftProblem({ ...d, databases: [] }, 'bad name')).toBe('newDatabase');
    expect(draftProblem({ ...d, databases: [] }, 'new_db')).toBeNull();
    expect(draftProblem({ ...d, reason: '  ' }, null)).toBe('reason');
    expect(draftProblem(d, null)).toBeNull();
  });

  it('sorts ready first and counts what needs a connect', () => {
    const rs = [req('old', { status: 'expired', created_at: '2027-01-01T00:00:00Z' }), req('new', { created_at: '2027-01-02T00:00:00Z' }), req('go', { status: 'ready', created_at: '2026-12-01T00:00:00Z' })];
    expect(sortRequests(rs, NOW).map((r) => r.id)).toEqual(['go', 'new', 'old']);
    expect(readyCount(rs, NOW)).toBe(1);
    expect(readyCount([req('x', { status: 'ready', connection_id: 'c1' })], NOW)).toBe(0);
    expect(readyCount([req('x', { status: 'ready', connection_id: 'c1', connection_expired: true })], NOW)).toBe(1);
  });

  it('segments: Active orders by what needs action, Pending and History newest first', () => {
    const at = (m: number) => new Date(Date.UTC(2027, 0, 1, 0, m)).toISOString();
    const rs = [
      req('pend-old', { created_at: at(1) }),
      req('pend-new', { created_at: at(5) }),
      req('ready-late', { status: 'ready', expires_at: NOW + 7200, created_at: at(2) }),
      req('ready-soon', { status: 'ready', expires_at: NOW + 60, created_at: at(0) }),
      req('prov', { status: 'provisioning', created_at: at(3) }),
      req('gone', { status: 'ready', expires_at: NOW - 1, created_at: at(9) }),
      req('rej', { status: 'rejected', created_at: at(4) }),
      req('cxl', { status: 'cancelled', created_at: at(8) }),
      req('fail', { status: 'failed', created_at: at(6) }),
    ];
    const none = { query: '', envs: new Set<never>() };
    const ids = (s: 'active' | 'pending' | 'history') => segmentRequests(rs, s, none, NOW).map((r) => r.id);
    expect(ids('active')).toEqual(['ready-soon', 'ready-late', 'prov', 'pend-new', 'pend-old']);
    expect(ids('pending')).toEqual(['pend-new', 'pend-old']);
    expect(ids('history')).toEqual(['gone', 'cxl', 'fail', 'rej']);
    expect(segmentCounts(rs, NOW)).toEqual({ active: 5, pending: 2, history: 4 });
  });

  it('filters by text over resource, environment, databases, reason and requester, and by environment', () => {
    const r = req('a', { resource_name: 'billing', environment: 'production', environment_name: 'prod-eu', databases: ['ledger'], reason: 'INC-7' });
    const f = (query: string, envs: string[] = []) => ({ query, envs: new Set(envs) as Set<never> });
    for (const q of ['BILL', 'prod-eu', 'ledger', 'inc-7', 'dev@example.com']) expect(matchesFilter(r, f(q))).toBe(true);
    expect(matchesFilter(r, f('orders'))).toBe(false);
    expect(matchesFilter(r, f('', ['staging']))).toBe(false);
    expect(matchesFilter(r, f('', ['production']))).toBe(true);
    expect(isFiltered(f(' '))).toBe(false);
    expect(isFiltered(f('', ['production']))).toBe(true);
    expect(envsPresent([r, req('b', { environment: 'staging' }), req('c', { environment: 'staging' })])).toEqual(['staging', 'production']);
  });

  it('timeline: requested → decided (by whom, why) → provisioned → saved → expires', () => {
    const keys = (r: AccessRequestView) => timeline(r, NOW).map((x) => `${x.key}:${x.state}`);
    expect(keys(req('a', { approver: { id: '', name: 'Morgan', email: '' } }))).toEqual(['requested:done', 'waiting:current']);
    expect(timeline(req('a', { approver: { id: '', name: 'Morgan', email: '' } }), NOW)[1].by).toBe('Morgan');
    const rej = timeline(req('b', { status: 'rejected', status_detail: 'no', approver: { id: '', name: 'Morgan', email: '' }, decided_at: 'x' }), NOW);
    expect(rej.map((x) => x.key)).toEqual(['requested', 'rejected']);
    expect(rej[1]).toMatchObject({ state: 'failed', by: 'Morgan', note: 'no', at: 'x' });
    expect(keys(req('c', { status: 'provisioning' }))).toEqual(['requested:done', 'approved:done', 'provisioning:current']);
    expect(keys(req('d', { status: 'failed', status_detail: 'boom' }))).toEqual(['requested:done', 'approved:done', 'failed:failed']);
    expect(keys(req('e', { status: 'ready', expires_at: NOW + 60, connection_id: 'c1' }))).toEqual(['requested:done', 'approved:done', 'provisioned:done', 'saved:done', 'expires:upcoming']);
    expect(keys(req('f', { status: 'ready', expires_at: NOW - 1 }))).toEqual(['requested:done', 'approved:done', 'provisioned:done', 'expired:failed']);
    expect(keys(req('g', { status: 'revoked' })).pop()).toBe('revoked:failed');
    expect(keys(req('h', { status: 'cancelled' }))).toEqual(['requested:done', 'cancelled:failed']);
  });

  it('ticket references: kept by Request again, validated, searchable', () => {
    const r = req('t', { ticket: 'OPS-123' });
    expect(draftFrom(r).ticket).toBe('OPS-123');
    expect(draftFrom(req('u')).ticket).toBeUndefined();
    const d = draftFrom(r);
    expect(draftProblem({ ...d, ticket: 'OPS 1' }, null)).toBe('ticket');
    expect(draftProblem({ ...d, ticket: '  ' }, null)).toBeNull();
    for (const ok of ['OPS-123', 'ops/42', 'JIRA#7', 'a.b_c']) expect(validTicket(ok)).toBe(true);
    for (const bad of ['', 'a b', '[x]', 'x'.repeat(41)]) expect(validTicket(bad)).toBe(false);
    expect(matchesFilter(r, { query: 'ops-1', envs: new Set() })).toBe(true);
  });
});

describe('shortDurationLabel', () => {
  it('keeps only the largest unit, never less than a minute', () => {
    expect(shortDurationLabel({ d: 29, h: 23, m: 59 })).toEqual({ key: 'access.durShortD', vars: { d: 29 } });
    expect(shortDurationLabel({ d: 0, h: 5, m: 12 })).toEqual({ key: 'access.durShortH', vars: { h: 5 } });
    expect(shortDurationLabel({ d: 0, h: 0, m: 0 })).toEqual({ key: 'access.durShortM', vars: { m: 1 } });
  });
});

