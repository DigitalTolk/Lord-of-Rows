import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import type { AccessProviderInfo, AccessRequestView, AccessStatus } from '../lib/types';

const NOW = Math.floor(Date.now() / 1000);
const PROVIDER: AccessProviderInfo = { id: 'p1', kind: 'passhub', name: 'Company access', base_url: 'https://access.example.com', capabilities: { approvals: true, create_database: true, cancel: true, targets: true }, has_session: true };

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
  accessConnectCheck: vi.fn(async () => ({ reusable: false, connection_id: null, reveals_remaining: 4 })),
  accessConnect: vi.fn(async () => ({ connection_id: 'conn-1', reused: false, reveals_remaining: 3, password_in_memory: false })),
  accessReject: vi.fn(async () => state.approvals[0]),
  listConnections: vi.fn(async () => []),
}));
vi.mock('../lib/ipc', () => ({ api, IpcError: class extends Error {} }));

import { useAccess } from '../lib/accessStore';
import { useApp } from '../store';
import { AccessPanel } from './AccessPanel';

const openSession = vi.fn(async () => 'session-1');

async function show() {
  render(<AccessPanel />);
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  useAccess.setState({ providers: null, providerId: null, status: null, requests: null, approvals: null, error: null, notice: null, sheet: null, accessTab: 'mine', visible: 0 });
  useApp.setState({ openSession, reloadConnections: vi.fn(async () => undefined) });
  state.providers = [];
  state.status = { signed_in: false, signing_in: false };
  state.requests = [];
  state.approvals = [];
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
    const list = screen.getByRole('list', { name: 'My requests' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0].getAttribute('aria-label')).toBe('billing'); // ready first
    expect(within(items[0]).getByText(/expires in 3 h 1[12] m/)).toBeTruthy();
    expect(screen.getByText('Waiting for Morgan')).toBeTruthy();
    expect(screen.getByText(/Rejected by Morgan/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request again' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(items[0]).getByRole('button', { name: /Connect/ }));
    });
    expect(api.accessConnectCheck).toHaveBeenCalledWith('p1', 'r2');
    expect(api.accessConnect).toHaveBeenCalledWith('p1', 'r2');
    expect(openSession).toHaveBeenCalledWith('conn-1');
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
});
