// Access requests (any provider): pure helpers for the Access view (state, timing, grouping).
import type { AccessLevel, AccessRequest, AccessRequestStatus, AccessRequestView, AccessResource, ConnectionConfig, DbError, EnvironmentKind, StoredConnection } from './types';

/** Shown state: the provider's status, with a ready request past its expiry shown as expired. */
export function requestPhase(r: Pick<AccessRequest, 'status' | 'expires_at'>, nowSec: number): AccessRequestStatus {
  return r.status === 'ready' && !!r.expires_at && r.expires_at <= nowSec ? 'expired' : r.status;
}

/** Requests whose state can still change on its own (worth polling fast). */
export const isInFlight = (p: AccessRequestStatus) => p === 'pending' || p === 'provisioning';
/** Finished for good: offer "Request again". */
export const isEnded = (p: AccessRequestStatus) => p === 'expired' || p === 'revoked' || p === 'rejected' || p === 'failed' || p === 'cancelled';

/** Poll interval: fast while the Access view is open or a request is in flight, slow otherwise; doubles per consecutive error (max 5 min). */
export function pollDelay(o: { visible: boolean; inFlight: boolean; errors: number }): number {
  const base = o.visible || o.inFlight ? 5_000 : 60_000;
  return Math.min(base * 2 ** Math.min(o.errors, 10), 300_000);
}

/** Time left split for display; `null` when there is no expiry. */
export function timeLeft(expiresAt: number | null | undefined, nowSec: number): { d: number; h: number; m: number; secs: number } | null {
  if (!expiresAt) return null;
  const secs = Math.max(0, expiresAt - nowSec);
  const mins = Math.ceil(secs / 60);
  return { d: Math.floor(mins / 1440), h: Math.floor((mins % 1440) / 60), m: mins % 60, secs };
}

/** i18n key + values for a remaining duration ("3 h 12 m", "2 d 4 h", "12 m"). */
export function durationLabel(left: { d: number; h: number; m: number }): { key: 'access.durDh' | 'access.durHm' | 'access.durM'; vars: Record<string, number> } {
  if (left.d > 0) return { key: 'access.durDh', vars: { d: left.d, h: left.h } };
  if (left.h > 0) return { key: 'access.durHm', vars: { h: left.h, m: left.m } };
  return { key: 'access.durM', vars: { m: Math.max(1, left.m) } };
}

/** Requests that just became ready (were known before and not ready then). */
export function newlyReady(prev: AccessRequestView[] | null, next: AccessRequestView[], nowSec: number): AccessRequestView[] {
  if (!prev) return [];
  const before = new Map(prev.map((r) => [r.id, requestPhase(r, nowSec)]));
  return next.filter((r) => requestPhase(r, nowSec) === 'ready' && before.has(r.id) && before.get(r.id) !== 'ready');
}

/** Managed state of a saved connection, if an access provider manages it. */
export function managedState(cfg: ConnectionConfig, nowSec: number): { expired: boolean; left: ReturnType<typeof timeLeft> } | null {
  const m = cfg.managed_by;
  if (!m) return null;
  const expired = m.expired || (!!m.expires_at && m.expires_at <= nowSec);
  return { expired, left: expired ? null : timeLeft(m.expires_at, nowSec) };
}

/** Live managed connections that end within `windowSec` and haven't been warned about yet. */
export function expiringSoon(conns: StoredConnection[], nowSec: number, warned: ReadonlySet<string>, windowSec = 15 * 60): ConnectionConfig[] {
  return conns
    .map((c) => c.config)
    .filter((c) => {
      const s = managedState(c, nowSec);
      return !!s && !s.expired && !!s.left && s.left.secs <= windowSec && !warned.has(c.id);
    });
}

export interface ResourceGroup {
  environment: string;
  kind: EnvironmentKind;
  resources: AccessResource[];
}

/** Resources matching `query` (name, environment, host), grouped by environment (production last). */
export function groupResources(resources: AccessResource[], query: string): ResourceGroup[] {
  const q = query.trim().toLowerCase();
  const hit = (s: AccessResource) => !q || [s.name, s.environment_name, s.host ?? ''].some((v) => v.toLowerCase().includes(q));
  const groups = new Map<string, ResourceGroup>();
  for (const s of resources.filter(hit)) {
    const key = s.environment_name || '—';
    const g = groups.get(key) ?? { environment: key, kind: s.environment, resources: [] };
    g.resources.push(s);
    groups.set(key, g);
  }
  const rank = (k: EnvironmentKind) => ['local', 'development', 'testing', 'staging', 'custom', 'production'].indexOf(k);
  return [...groups.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || a.environment.localeCompare(b.environment));
}

/** Draft for the request form (also used by "Request again"). */
export interface RequestDraft {
  resourceId: string;
  access: AccessLevel;
  databases: string[];
  reason: string;
  /** Optional ticket reference. */
  ticket?: string;
}

export function draftFrom(r: Pick<AccessRequest, 'resource_id' | 'access' | 'databases' | 'create_database' | 'reason' | 'ticket'>): RequestDraft {
  const d: RequestDraft = { resourceId: r.resource_id, access: r.access === 'read_write' ? 'read_write' : 'read_only', databases: r.create_database ? [] : [...r.databases], reason: r.reason };
  if (r.ticket) d.ticket = r.ticket;
  return d;
}

/** A ticket reference: letters, digits and - _ . # / (1-40), same rule as the backend. */
export const validTicket = (t: string) => /^[A-Za-z0-9\-_.#/]{1,40}$/.test(t);

export type DraftProblem = 'resource' | 'databases' | 'newDatabase' | 'ticket' | 'reason' | null;

/** First problem with a draft (same rules the backend applies). */
export function draftProblem(d: RequestDraft, createDatabase: string | null): DraftProblem {
  if (!d.resourceId) return 'resource';
  if (createDatabase !== null) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(createDatabase.trim())) return 'newDatabase';
  } else if (d.databases.length === 0) return 'databases';
  if (d.ticket?.trim() && !validTicket(d.ticket.trim())) return 'ticket';
  if (!d.reason.trim()) return 'reason';
  return null;
}

/** Seconds since an RFC 3339 timestamp (0 if unparseable). */
export function ageSeconds(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 1000)) : 0;
}

/** i18n key + values for "how long ago" (minutes / hours / days). */
export function ageLabel(secs: number): { key: 'access.ageM' | 'access.ageH' | 'access.ageD'; vars: { count: number } } {
  if (secs < 3600) return { key: 'access.ageM', vars: { count: Math.max(1, Math.floor(secs / 60)) } };
  if (secs < 86400) return { key: 'access.ageH', vars: { count: Math.floor(secs / 3600) } };
  return { key: 'access.ageD', vars: { count: Math.floor(secs / 86400) } };
}

export const errCode = (e: unknown): string | null => (e && typeof e === 'object' && 'err' in e ? ((e as { err: DbError }).err?.code ?? null) : null);
export const isSignedOutError = (e: unknown) => errCode(e) === 'access_signed_out';

/** Ready first, then in flight, then finished; newest first within each. */
export function sortRequests(rs: AccessRequestView[], nowSec: number): AccessRequestView[] {
  const w = (r: AccessRequestView) => ({ ready: 0, provisioning: 1, pending: 1, failed: 2, rejected: 3, revoked: 3, expired: 3, cancelled: 3 })[requestPhase(r, nowSec)];
  return [...rs].sort((a, b) => w(a) - w(b) || b.created_at.localeCompare(a.created_at));
}

/** Requests ready to connect that have no live saved connection yet (launcher badge). */
export const readyCount = (rs: AccessRequestView[] | null, nowSec: number) =>
  (rs ?? []).filter((r) => requestPhase(r, nowSec) === 'ready' && (!r.connection_id || r.connection_expired)).length;

// ---- request list filters (My requests: Active · Pending · History; Approvals: search + env)

export type Segment = 'active' | 'pending' | 'history';
export const SEGMENTS: Segment[] = ['active', 'pending', 'history'];

export function segmentOf(p: AccessRequestStatus): Segment {
  return isEnded(p) ? 'history' : 'active';
}

export interface ListFilter {
  query: string;
  envs: ReadonlySet<EnvironmentKind>;
}

export const isFiltered = (f: ListFilter) => f.query.trim() !== '' || f.envs.size > 0;

/** Search over resource, environment, databases and reason (plus requester for approvals). */
export function matchesFilter(r: AccessRequest, f: ListFilter): boolean {
  if (f.envs.size && !f.envs.has(r.environment)) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  return [r.resource_name, r.environment_name, r.reason, r.ticket ?? '', ...r.databases, r.requester.name, r.requester.email].some((v) => (v ?? '').toLowerCase().includes(q));
}

const newest = (a: AccessRequest, b: AccessRequest) => b.created_at.localeCompare(a.created_at);

/**
 * Requests of one segment, filtered and ordered by what needs action:
 * Active = ready (soonest expiry first), then provisioning, then pending (newest first);
 * Pending = awaiting approval, newest first; History = ended, newest first.
 */
export function segmentRequests<T extends AccessRequest>(rs: T[], segment: Segment, f: ListFilter, nowSec: number): T[] {
  const phase = (r: T) => requestPhase(r, nowSec);
  const inSeg = rs.filter((r) => (segment === 'pending' ? phase(r) === 'pending' : segmentOf(phase(r)) === segment) && matchesFilter(r, f));
  if (segment !== 'active') return inSeg.sort(newest);
  const rank = (r: T) => ({ ready: 0, provisioning: 1, pending: 2 } as Record<string, number>)[phase(r)] ?? 3;
  return inSeg.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? (a.expires_at ?? Infinity) - (b.expires_at ?? Infinity) : 0) || newest(a, b));
}

/** Live counts per segment (independent of search and environment filters). */
export function segmentCounts(rs: AccessRequest[], nowSec: number): Record<Segment, number> {
  const c: Record<Segment, number> = { active: 0, pending: 0, history: 0 };
  for (const r of rs) {
    const p = requestPhase(r, nowSec);
    c[segmentOf(p)] += 1;
    if (p === 'pending') c.pending += 1;
  }
  return c;
}

/** Environments present in the data, in the usual order (for the env chips). */
export function envsPresent(rs: AccessRequest[]): EnvironmentKind[] {
  const order: EnvironmentKind[] = ['local', 'development', 'testing', 'staging', 'production', 'custom'];
  const have = new Set(rs.map((r) => r.environment));
  return order.filter((e) => have.has(e));
}

/** Per-provider remembered segment (browser storage; falls back to Active). */
export function savedSegment(providerId: string | null): Segment {
  try {
    const v = providerId ? localStorage.getItem(`lotr.accessSegment.${providerId}`) : null;
    return SEGMENTS.includes(v as Segment) ? (v as Segment) : 'active';
  } catch {
    return 'active';
  }
}

export function saveSegment(providerId: string | null, s: Segment) {
  try {
    if (providerId) localStorage.setItem(`lotr.accessSegment.${providerId}`, s);
  } catch {
    /* storage unavailable */
  }
}

/** History is paged in steps of this many cards. */
export const HISTORY_PAGE = 20;

// ---- request detail timeline

export type StepState = 'done' | 'current' | 'upcoming' | 'failed';
export interface TimelineStep {
  key: 'requested' | 'approved' | 'rejected' | 'waiting' | 'provisioning' | 'provisioned' | 'failed' | 'saved' | 'expires' | 'expired' | 'cancelled' | 'revoked';
  state: StepState;
  /** RFC 3339 or unix seconds (expiry). */
  at?: string | number | null;
  by?: string | null;
  note?: string | null;
}

/** requested → approved / rejected (by whom, why) → provisioned → saved to the keychain → expires / expired. */
export function timeline(r: AccessRequestView | AccessRequest, nowSec: number): TimelineStep[] {
  const p = requestPhase(r, nowSec);
  const who = (x?: { name: string; email: string } | null) => (x ? x.name || x.email : null) || null;
  const steps: TimelineStep[] = [{ key: 'requested', state: 'done', at: r.created_at, by: who(r.requester), note: r.reason || null }];
  if (p === 'pending') return [...steps, { key: 'waiting', state: 'current', by: who(r.approver) }];
  if (p === 'cancelled') return [...steps, { key: 'cancelled', state: 'failed' }];
  if (p === 'rejected') return [...steps, { key: 'rejected', state: 'failed', at: r.decided_at, by: who(r.approver), note: r.status_detail }];
  steps.push({ key: 'approved', state: 'done', at: r.decided_at, by: who(r.approver) });
  if (p === 'provisioning') return [...steps, { key: 'provisioning', state: 'current' }];
  if (p === 'failed') return [...steps, { key: 'failed', state: 'failed', note: r.status_detail }];
  steps.push({ key: 'provisioned', state: 'done' });
  if ('connection_id' in r && r.connection_id) steps.push({ key: 'saved', state: 'done' });
  if (p === 'revoked') steps.push({ key: 'revoked', state: 'failed' });
  else if (p === 'expired') steps.push({ key: 'expired', state: 'failed', at: r.expires_at });
  else if (r.expires_at) steps.push({ key: 'expires', state: 'upcoming', at: r.expires_at });
  return steps;
}
