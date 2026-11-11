import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import type { AccessProviderInfo, AccessRequestView, AccessStatus } from '../lib/types';

const NOW = Math.floor(Date.now() / 1000);
const PROVIDER: AccessProviderInfo = { id: 'p1', kind: 'passhub', name: 'Company access', base_url: 'https://access.example.com', capabilities: { approvals: true, create_database: true, cancel: true, targets: true, decided_history: false }, has_session: true };

const req = (id: string, extra: Partial<AccessRequestView> = {}): AccessRequestView => ({
  id,
  resource_id: 'res-1',
  resource_name: 'orders',
  environment_name: 'staging',
  environment: 'staging',
  access: 'read_only',
  reason: 'ticket',
  databases: ['shop'],
  create_database: false,
  status: 'pending',
  requester: { id: 'u1', name: 'Dev', email: 'dev@example.com' },
  log: [],
  created_at: new Date().toISOString(),
  connection_expired: false,
  ...extra,
});

const state = vi.hoisted(() => ({
  providers: [] as AccessProviderInfo[],
  status: { signed_in: false, signing_in: false } as AccessStatus,
  requests: [] as AccessRequestView[],
  approvals: [] as AccessRequestView[],
  decided: [] as AccessRequestView[],
  decidedUnsupported: false,
}));
const api = vi.hoisted(() => ({
  accessProviders: vi.fn(async () => state.providers),
  accessProviderKinds: vi.fn(async () => [{ kind: 'passhub', label: 'passhub', default_name: 'passhub' }]),
  accessAddProvider: vi.fn(async (kind: string, name: string, base_url: string) => {
    state.providers = [{ ...PROVIDER, kind, name, base_url, has_session: false }];
    return state.providers[0];
  }),
  accessStatus: vi.fn(async () => state.status),
  accessSignIn: vi.fn(async () => ({ id: 'u1', email: 'dev@example.com', name: 'Dev', role: 'developer', can_approve: false })),
  accessListRequests: vi.fn(async () => ({ requests: state.requests, expired_connections: [] })),
  accessListApprovals: vi.fn(async () => state.approvals),
  accessConnectCheck: vi.fn(async () => ({ reusable: false, connection_id: null, reveals_remaining: 4, details: { engine: 'postgres', host: 'db.example.com', port: 5432, database: 'shop', username: 'dev_r2' } })),
  accessGetRequest: vi.fn(async (_p: string, id: string) => ({ ...state.requests.concat(state.approvals).find((r) => r.id === id)!, log: [{ ts: '2027-01-01T10:00:05Z', level: 'info', msg: 'created user dev_r2' }] })),
  accessApprove: vi.fn(async () => state.approvals[0]),
  accessSweep: vi.fn(async () => []),
  accessCreateRequest: vi.fn(async (_p: string, input: { resource_id: string }) => req('new', { resource_id: input.resource_id })),
  accessConnect: vi.fn(async () => ({ connection_id: 'conn-1', reused: false, reveals_remaining: 3, password_in_memory: false })),
  accessReject: vi.fn(async () => state.approvals[0]),
  listConnections: vi.fn(async () => []),
  accessListResources: vi.fn(async () => [{ id: 'res-1', name: 'billing', environment_name: 'staging', environment: 'staging', engine: 'postgres', host: 'db.example.com', access_levels: ['read_only', 'read_write'] }]),
  accessResourceTargets: vi.fn(async () => ({ targets: ['ledger'], error: null })),
  accessListDecided: vi.fn(async (_p: string, cursor: string | null): Promise<{ items: AccessRequestView[]; next: string | null }> => {
    if (state.decidedUnsupported) throw Object.assign(new Error('no history'), { err: { kind: 'unsupported', message: 'no history', code: 'access_unsupported' } });
    return cursor ? { items: state.decided.slice(1), next: null } : { items: state.decided.slice(0, 1), next: state.decided.length > 1 ? 'c2' : null };
  }),
}));
vi.mock('../lib/ipc', () => ({ api, IpcError: class extends Error {} }));

import { useAccess } from '../lib/accessStore';
import { useApp } from '../store';
import { AccessPanel } from './AccessPanel';
import { AccessWatcher } from './AccessWatcher';
import { AskHost } from './ask';

const openSession = vi.fn(async () => 'session-1');

async function show() {
  render(<AccessPanel />);
  // Let the provider/status/request loads (several chained promises) settle.
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  useAccess.setState({ providers: null, providerId: null, status: null, requests: null, approvals: null, error: null, notice: null, sheet: null, accessTab: 'mine', visible: 0 });
  useApp.setState({ openSession, reloadConnections: vi.fn(async () => undefined) });
  state.providers = [];
  state.status = { signed_in: false, signing_in: false };
  state.requests = [];
  state.approvals = [];
  state.decided = [];
  state.decidedUnsupported = false;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('AccessPanel', () => {
  it('asks for a provider first and adds one', async () => {
    await show();
    expect(screen.getByText('Database access')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Provider URL'), { target: { value: 'https://access.example.com' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    });
    expect(api.accessAddProvider).toHaveBeenCalledWith('passhub', 'passhub', 'https://access.example.com');
    expect(await screen.findByRole('button', { name: /Sign in to passhub/ })).toBeTruthy();
  });

  it('signed out: generic sign-in button for the provider', async () => {
    state.providers = [PROVIDER];
    await show();
    const btn = screen.getByRole('button', { name: /Sign in to Company access/ });
    expect(screen.getByText(/access\.example\.com/)).toBeTruthy();
    state.status = { signed_in: true, signing_in: false, user: { id: 'u1', email: 'dev@example.com', name: 'Dev', role: 'developer', can_approve: false } };
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(api.accessSignIn).toHaveBeenCalledWith('p1');
  });

  it('lists my requests; Connect fetches once and opens the connection', async () => {
    state.providers = [PROVIDER];
    state.status = { signed_in: true, signing_in: false, user: { id: 'u1', email: 'dev@example.com', name: 'Dev', role: 'developer', can_approve: false } };
    state.requests = [
      req('r1', { approver: { id: '', name: 'Morgan', email: 'manager@example.com' } }),
      req('r2', { status: 'ready', resource_name: 'billing', expires_at: NOW + 3 * 3600 + 12 * 60 }),
      req('r3', { status: 'rejected', resource_name: 'audit', status_detail: 'not needed', approver: { id: '', name: 'Morgan', email: '' } }),
    ];
    await show();
    expect(screen.queryByRole('tab', { name: /Approvals/ })).toBeNull();
    const list = screen.getByRole('list', { name: 'Active' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual(['billing', 'orders']); // ready first, then pending
    expect(within(items[0]).getByText(/expires in 3 h 1[12] m/)).toBeTruthy();
    expect(screen.getByText('Waiting for Morgan')).toBeTruthy();
    expect(screen.queryByText(/Rejected by Morgan/)).toBeNull(); // ended requests live in History
    await act(async () => {
      fireEvent.click(within(items[0]).getByRole('button', { name: /Connect/ }));
    });
    expect(api.accessConnectCheck).toHaveBeenCalledWith('p1', 'r2');
    expect(api.accessConnect).toHaveBeenCalledWith('p1', 'r2');
    expect(openSession).toHaveBeenCalledWith('conn-1');
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    expect(screen.getByText(/Rejected by Morgan/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request again' })).toBeTruthy();
  });

  it('approvers get an inbox; rejecting needs a reason', async () => {
    state.providers = [PROVIDER];
    state.status = { signed_in: true, signing_in: false, user: { id: 'm1', email: 'manager@example.com', name: 'Manager', role: 'manager', can_approve: true } };
    state.approvals = [req('a1', { reason: 'debug ticket' })];
    await show();
    const tab = screen.getByRole('tab', { name: /Approvals/ });
    expect(within(tab).getByText('1')).toBeTruthy();
    fireEvent.click(tab);
    expect(screen.getByText('debug ticket')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'not now' } });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(api.accessReject).toHaveBeenCalledWith('p1', 'a1', 'not now');
  });

  it('hides approvals when the provider has none, even for managers', async () => {
    state.providers = [{ ...PROVIDER, capabilities: { ...PROVIDER.capabilities, approvals: false } }];
    state.status = { signed_in: true, signing_in: false, user: { id: 'm1', email: 'manager@example.com', name: 'Manager', role: 'manager', can_approve: true } };
    await show();
    expect(screen.queryByRole('tab', { name: /Approvals/ })).toBeNull();
    expect(screen.getByText('No access requests yet')).toBeTruthy();
  });

  it('signed in: the provider switcher is always shown and can add a provider', async () => {
    state.providers = [PROVIDER];
    state.status = { signed_in: true, signing_in: false, user: { id: 'u1', email: 'dev@example.com', name: 'Dev', role: 'developer', can_approve: false } };
    await show();
    const picker = screen.getByLabelText('Access provider') as HTMLSelectElement;
    expect(picker.value).toBe('p1');
    expect(within(picker).getByText('Company access')).toBeTruthy();
    expect(screen.queryByLabelText('Provider URL')).toBeNull();
    fireEvent.change(picker, { target: { value: '__add' } });
    expect(await screen.findByLabelText('Provider URL')).toBeTruthy();
    expect(picker.value).toBe('p1');
    fireEvent.change(screen.getByLabelText('Provider URL'), { target: { value: 'https://other.example.com' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    });
    expect(api.accessAddProvider).toHaveBeenCalledWith('passhub', 'passhub', 'https://other.example.com');
  });

  it('signed in: the + button next to the switcher opens the add form too', async () => {
    state.providers = [PROVIDER, { ...PROVIDER, id: 'p2', name: 'Second access' }];
    state.status = { signed_in: true, signing_in: false, user: { id: 'u1', email: 'dev@example.com', name: 'Dev', role: 'developer', can_approve: false } };
    await show();
    expect(within(screen.getByLabelText('Access provider')).getByText('Second access')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add another provider' }));
    expect(screen.getByRole('region', { name: 'Add another provider' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Provider URL')).toBeNull();
  });

  it('signed out: "Add another provider" shows the add form', async () => {
    state.providers = [PROVIDER];
    await show();
    expect((screen.getByLabelText('Access provider') as HTMLSelectElement).value).toBe('p1');
    const links = screen.getAllByRole('button', { name: 'Add another provider' });
    expect(links).toHaveLength(2); // the + next to the switcher and the link under the sign-in button
    fireEvent.click(links[1]);
    expect(screen.getByLabelText('Provider URL')).toBeTruthy();
    expect((screen.getByLabelText('Provider URL') as HTMLInputElement).value).toBe('');
  });

  describe('request filters', () => {
    const signedIn = () => {
      state.providers = [PROVIDER];
      state.status = { signed_in: true, signing_in: false, user: { id: 'u1', email: 'dev@example.com', name: 'Dev', role: 'developer', can_approve: false } };
    };
    beforeEach(() => {
      try {
        localStorage.clear();
      } catch {
        /* no storage */
      }
    });

    it('segments with live counts, Active by default, remembered per provider', async () => {
      signedIn();
      state.requests = [
        req('p1', { resource_name: 'orders' }),
        req('r1', { status: 'ready', resource_name: 'billing', expires_at: NOW + 7200 }),
        req('r2', { status: 'ready', resource_name: 'events', expires_at: NOW + 600 }),
        req('v1', { status: 'provisioning', resource_name: 'audit' }),
        // Fixed times: History is newest first, and `new Date()` defaults can tie or flip by a millisecond.
        req('h1', { status: 'revoked', resource_name: 'old', created_at: '2026-01-02T00:00:00.000Z' }),
        req('h2', { status: 'cancelled', resource_name: 'older', created_at: '2026-01-01T00:00:00.000Z' }),
      ];
      await show();
      const tabs = screen.getAllByRole('tab').filter((t) => t.hasAttribute('data-segment'));
      expect(tabs.map((t) => t.textContent)).toEqual(['Active4', 'Pending1', 'History2']);
      expect(tabs[0].getAttribute('aria-selected')).toBe('true');
      const names = () => within(screen.getByRole('list', { name: /Active|Pending|History/ })).getAllByRole('listitem').map((i) => i.getAttribute('aria-label'));
      expect(names()).toEqual(['events', 'billing', 'audit', 'orders']); // ready (soonest expiry first), provisioning, pending
      // Arrow keys move between segments.
      tabs[0].focus();
      fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
      expect(names()).toEqual(['orders']);
      fireEvent.keyDown(screen.getByRole('tab', { name: /Pending/ }), { key: 'End' });
      expect(names()).toEqual(['old', 'older']);
      expect(screen.getByRole('tab', { name: /History/ }).getAttribute('aria-selected')).toBe('true');
      expect(localStorage.getItem('lotr.accessSegment.p1')).toBe('history');
      cleanup();
      await show();
      expect(screen.getByRole('tab', { name: /History/ }).getAttribute('aria-selected')).toBe('true');
    });

    it('search and environment chips filter; clear filters; empty states', async () => {
      signedIn();
      state.requests = [
        req('a', { status: 'ready', resource_name: 'billing', environment: 'production', environment_name: 'prod', expires_at: NOW + 60 }),
        req('b', { status: 'ready', resource_name: 'orders', environment: 'staging', reason: 'ticket ABC-42', expires_at: NOW + 60 }),
      ];
      await show();
      const search = screen.getByRole('searchbox', { name: 'Search requests' });
      fireEvent.change(search, { target: { value: 'abc-42' } });
      expect(within(screen.getByRole('list', { name: 'Active' })).getAllByRole('listitem').map((i) => i.getAttribute('aria-label'))).toEqual(['orders']);
      fireEvent.change(search, { target: { value: '' } });
      const chips = within(screen.getByRole('group', { name: 'Filter by environment' })).getAllByRole('button');
      expect(chips).toHaveLength(2); // only environments present: staging, production
      fireEvent.click(chips.find((c) => /prod/i.test(c.textContent ?? ''))!);
      expect(within(screen.getByRole('list', { name: 'Active' })).getAllByRole('listitem').map((i) => i.getAttribute('aria-label'))).toEqual(['billing']);
      fireEvent.change(search, { target: { value: 'nothing-like-this' } });
      expect(screen.getByText('No requests match')).toBeTruthy();
      fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
      expect(within(screen.getByRole('list', { name: 'Active' })).getAllByRole('listitem')).toHaveLength(2);
      fireEvent.click(screen.getByRole('tab', { name: /Pending/ }));
      expect(screen.getByText('Nothing waiting for approval')).toBeTruthy();
      fireEvent.click(screen.getByRole('tab', { name: /History/ }));
      expect(screen.getByText('No past requests')).toBeTruthy();
    });

    it('active empty offers a request; long history pages by 20; Mod+F focuses search', async () => {
      signedIn();
      state.requests = Array.from({ length: 25 }, (_, i) => req(`h${i}`, { status: 'expired', resource_name: `db${i}`, created_at: new Date(Date.now() - i * 60e3).toISOString() }));
      await show();
      expect(screen.getByText('No active access')).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'Request access' }).length).toBeGreaterThan(1);
      fireEvent.click(screen.getByRole('tab', { name: /History/ }));
      const list = () => within(screen.getByRole('list', { name: 'History' })).getAllByRole('listitem');
      expect(list()).toHaveLength(20);
      fireEvent.click(screen.getByRole('button', { name: 'Show 5 more' }));
      expect(list()).toHaveLength(25);
      const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
      fireEvent.keyDown(window, { key: 'f', ctrlKey: !mac, metaKey: mac });
      expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search requests' }));
    });

    it('a request that just became ready is highlighted', async () => {
      signedIn();
      state.requests = [req('x', { status: 'ready', resource_name: 'billing', expires_at: NOW + 600 })];
      useAccess.setState({ justReady: ['x'] });
      await show();
      expect(screen.getByRole('listitem', { name: 'billing' }).getAttribute('data-highlight')).toBe('true');
      useAccess.setState({ justReady: [] });
    });

    it('approvals: search by requester and environment', async () => {
      state.providers = [PROVIDER];
      state.status = { signed_in: true, signing_in: false, user: { id: 'm1', email: 'manager@example.com', name: 'Manager', role: 'manager', can_approve: true } };
      state.approvals = [req('a1', { requester: { id: 'u2', name: 'Robin', email: 'robin@example.com' } }), req('a2', { requester: { id: 'u3', name: 'Sam', email: 'sam@example.com' }, resource_name: 'billing' })];
      await show();
      fireEvent.click(screen.getByRole('tab', { name: /Approvals/ }));
      expect(screen.getByText('2 waiting')).toBeTruthy();
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search requests' }), { target: { value: 'robin' } });
      expect(within(screen.getByRole('list', { name: 'Approvals' })).getAllByRole('listitem')).toHaveLength(1);
    });
  });

  it('a ready request with under 30 minutes left offers a pre-filled Request again', async () => {
    state.providers = [PROVIDER];
    state.status = { signed_in: true, signing_in: false, user: { id: 'u1', email: 'dev@example.com', name: 'Dev', role: 'developer', can_approve: false } };
    state.requests = [
      req('soon', { status: 'ready', resource_name: 'billing', expires_at: NOW + 20 * 60, access: 'read_write', databases: ['ledger'], reason: 'month end' }),
      req('later', { status: 'ready', resource_name: 'orders', expires_at: NOW + 5 * 3600 }),
    ];
    await show();
    expect(within(screen.getByRole('listitem', { name: 'orders' })).queryByRole('button', { name: 'Request again' })).toBeNull();
    fireEvent.click(within(screen.getByRole('listitem', { name: 'billing' })).getByRole('button', { name: 'Request again' }));
    expect(useAccess.getState().sheet).toEqual({ draft: { resourceId: 'res-1', access: 'read_write', databases: ['ledger'], reason: 'month end' } });
    useAccess.setState({ sheet: null });
  });

  describe('approvals: Waiting / Decided', () => {
    const manager = () => {
      state.providers = [{ ...PROVIDER, capabilities: { ...PROVIDER.capabilities, decided_history: true } }];
      state.status = { signed_in: true, signing_in: false, user: { id: 'm1', email: 'manager@example.com', name: 'Manager', role: 'manager', can_approve: true } };
    };

    it('Decided lists my decisions with outcome, later state, reason, and pages', async () => {
      manager();
      state.approvals = [req('w1')];
      state.decided = [
        req('d1', { status: 'rejected', status_detail: 'use the replica', requester: { id: 'u2', name: 'Robin', email: '' }, decided_at: new Date(Date.now() - 2 * 3600e3 - 60e3).toISOString() }),
        req('d2', { status: 'expired', resource_name: 'billing', requester: { id: 'u3', name: 'Sam', email: '' } }),
      ];
      await show();
      fireEvent.click(screen.getByRole('tab', { name: /^Approvals/ }));
      const waiting = screen.getByRole('tab', { name: /Waiting/ });
      expect(waiting.getAttribute('aria-selected')).toBe('true');
      expect(waiting.textContent).toBe('Waiting1');
      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: /Decided/ }));
      });
      const robin = screen.getByRole('listitem', { name: 'Robin · orders' });
      expect(robin.getAttribute('data-outcome')).toBe('rejected');
      expect(within(robin).getByText('use the replica')).toBeTruthy();
      expect(robin.textContent).toContain('decided 2 h ago');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      });
      const sam = screen.getByRole('listitem', { name: 'Sam · billing' });
      expect(sam.getAttribute('data-outcome')).toBe('approved');
      expect(within(sam).getByText('now Expired')).toBeTruthy();
      expect(api.accessListDecided).toHaveBeenLastCalledWith('p1', 'c2', 50);
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search requests' }), { target: { value: 'sam' } });
      expect(within(screen.getByRole('list', { name: 'Decided' })).getAllByRole('listitem')).toHaveLength(1);
    });

    it('an older provider without decision history hides the Decided tab', async () => {
      manager();
      state.approvals = [req('w1')];
      state.decidedUnsupported = true;
      await show();
      fireEvent.click(screen.getByRole('tab', { name: /^Approvals/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: /Decided/ }));
      });
      expect(screen.queryByRole('tab', { name: /Decided/ })).toBeNull();
      expect(screen.getByText('1 waiting')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('request detail drawer', () => {
    it('mine: timeline, log, reveals left and copyable connection details (no password)', async () => {
      state.providers = [PROVIDER];
      state.status = { signed_in: true, signing_in: false, user: { id: 'u1', email: 'dev@example.com', name: 'Dev', role: 'developer', can_approve: false } };
      state.requests = [req('r2', { status: 'ready', resource_name: 'billing', expires_at: NOW + 3600, approver: { id: '', name: 'Morgan', email: '' } })];
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await show();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'billing' }));
      });
      const drawer = screen.getByRole('dialog', { name: 'billing' });
      expect([...drawer.querySelectorAll('[data-step]')].map((x) => x.getAttribute('data-step'))).toEqual(['requested', 'approved', 'provisioned', 'expires']);
      expect(within(drawer).getByText(/Morgan/)).toBeTruthy();
      expect(within(drawer).getByText(/created user dev_r2/)).toBeTruthy();
      expect(within(drawer).getByText('4 password reveals left.')).toBeTruthy();
      expect(within(drawer).getByText('db.example.com')).toBeTruthy();
      expect(drawer.textContent).not.toMatch(/password:/i);
      fireEvent.click(within(drawer).getByRole('button', { name: 'Copy Host' }));
      expect(writeText).toHaveBeenCalledWith('db.example.com');
      fireEvent.click(within(drawer).getByRole('button', { name: 'Copy User' }));
      expect(writeText).toHaveBeenLastCalledWith('dev_r2');
      expect(api.accessConnect).not.toHaveBeenCalled();
    });

    it('approvals: requester, reason, scope, and Approve from the drawer', async () => {
      state.providers = [PROVIDER];
      state.status = { signed_in: true, signing_in: false, user: { id: 'm1', email: 'manager@example.com', name: 'Manager', role: 'manager', can_approve: true } };
      state.approvals = [req('a1', { requester: { id: 'u2', name: 'Robin', email: 'robin@example.com' }, reason: 'INC-9 debugging', databases: ['ledger', 'audit'], access: 'read_write' })];
      await show();
      fireEvent.click(screen.getByRole('tab', { name: /^Approvals/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Robin' }));
      });
      const drawer = screen.getByRole('dialog', { name: 'orders' });
      expect(within(drawer).getAllByText('INC-9 debugging').length).toBeGreaterThan(0); // scope + timeline note
      expect(within(drawer).getByText('ledger, audit')).toBeTruthy();
      expect(within(drawer).getByText('Read & write')).toBeTruthy();
      expect(within(drawer).queryByText(/password reveals/)).toBeNull();
      await act(async () => {
        fireEvent.click(within(drawer).getByRole('button', { name: 'Approve' }));
      });
      // Confirmation dialog (AskHost is not mounted here): approval needs it, so nothing was sent yet.
      expect(api.accessApprove).not.toHaveBeenCalled();
    });
  });

  it('ticket: chip on cards, kept when requesting again, sent with the request', async () => {
    state.providers = [PROVIDER];
    state.status = { signed_in: true, signing_in: false, user: { id: 'u1', email: 'dev@example.com', name: 'Dev', role: 'developer', can_approve: false } };
    state.requests = [req('h', { status: 'expired', resource_name: 'billing', ticket: 'OPS-123', databases: ['ledger'] })];
    await show();
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    const card = screen.getByRole('listitem', { name: 'billing' });
    expect(card.querySelector('[data-ticket="OPS-123"]')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Request again' }));
    });
    expect((screen.getByLabelText('Ticket (optional)') as HTMLInputElement).value).toBe('OPS-123');
    api.accessCreateRequest.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Submit request/ }));
    });
    expect(api.accessCreateRequest).toHaveBeenCalledWith('p1', expect.objectContaining({ ticket: 'OPS-123', databases: ['ledger'], resource_id: 'res-1' }));
    useAccess.setState({ sheet: null });
  });

  describe('manager speed', () => {
    const manager = () => {
      state.providers = [PROVIDER];
      state.status = { signed_in: true, signing_in: false, user: { id: 'm1', email: 'manager@example.com', name: 'Manager', role: 'manager', can_approve: true } };
    };

    it('multi-select approves the chosen requests after one confirmation (own requests excluded)', async () => {
      manager();
      state.approvals = [
        req('a1', { requester: { id: 'u2', name: 'Robin', email: '' } }),
        req('a2', { requester: { id: 'u3', name: 'Sam', email: '' }, resource_name: 'billing' }),
        req('own', { requester: { id: 'm1', name: 'Manager', email: '' } }),
      ];
      render(
        <>
          <AccessPanel />
          <AskHost />
        </>,
      );
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      fireEvent.click(screen.getByRole('tab', { name: /^Approvals/ }));
      expect((screen.getByRole('checkbox', { name: 'Select the request from Manager' }) as HTMLInputElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select the request from Robin' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select the request from Sam' }));
      fireEvent.click(screen.getByRole('button', { name: 'Approve 2' }));
      const confirm = await screen.findByRole('dialog', { name: 'Approve 2 requests?' });
      expect(confirm.textContent).toMatch(/Robin — orders/);
      expect(confirm.textContent).toMatch(/Sam — billing/);
      expect(api.accessApprove).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(within(confirm).getByRole('button', { name: 'OK' }));
      });
      expect(api.accessApprove.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['a1', 'a2']);
    });

    it('a new approval shows a toast with Review that opens its drawer', async () => {
      manager();
      useApp.setState({ toasts: [] });
      state.approvals = [req('a1', { requester: { id: 'u2', name: 'Robin', email: '' } })];
      render(<AccessWatcher />);
      useAccess.setState({ providers: [PROVIDER], providerId: 'p1', status: state.status });
      await act(async () => {
        await useAccess.getState().refreshApprovals();
      });
      expect(useApp.getState().toasts).toHaveLength(0); // first load is not "new"
      state.approvals = [...state.approvals, req('a2', { requester: { id: 'u3', name: 'Sam', email: '' }, resource_name: 'billing' })];
      await act(async () => {
        await useAccess.getState().refreshApprovals();
      });
      const toast = useApp.getState().toasts.find((x) => x.action);
      expect(toast?.text).toBe('Sam requests access to billing');
      expect(toast?.action?.label).toBe('Review');
      act(() => toast!.action!.run());
      expect(useAccess.getState().detail).toMatchObject({ mode: 'approval', actionable: true, request: { id: 'a2' } });
      expect(useAccess.getState().accessTab).toBe('approvals');
      useAccess.setState({ detail: null });
    });
  });

  it('a provider managed by the organisation can be used but not edited or removed', async () => {
    state.providers = [{ ...PROVIDER, managed: true }];
    await show();
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit provider' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove provider' })).toBeNull();
    expect(screen.getByRole('button', { name: /Sign in to Company access/ })).toBeTruthy();
  });
});
