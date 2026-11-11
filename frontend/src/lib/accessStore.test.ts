import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';

const api = vi.hoisted(() => ({
  accessProviders: vi.fn(async () => [{ id: 'p1', kind: 'passhub', name: 'Company access', base_url: 'https://access.example.com', capabilities: { approvals: true, create_database: true, cancel: true, targets: true, decided_history: true }, has_session: true }]),
  accessStatus: vi.fn(async () => ({ signed_in: true, signing_in: false, user: { id: 'u1', email: 'dev@example.com', name: 'Dev', role: 'developer', can_approve: false } })),
  accessListRequests: vi.fn(async () => ({ requests: [], expired_connections: [] })),
}));
vi.mock('./ipc', () => ({ api, IpcError: class extends Error {} }));

import { useApp } from '../store';
import { accessCommands, offerRequestAgain, openAccessView, useAccess } from './accessStore';

const t = i18n.t.bind(i18n) as (k: string, o?: Record<string, unknown>) => string;

afterEach(() => {
  useAccess.setState({ launcherTab: 'connections', accessTab: 'mine', sheet: null, providers: null, providerId: null, status: null });
  useApp.setState({ launcher: false, toasts: [] });
});

describe('access entry points', () => {
  it('palette commands: request / show for everyone, approvals only for approvers', () => {
    expect(accessCommands(t).map((c) => c.label)).toEqual(['Request access…', 'Show access requests']);
    useAccess.setState({
      providers: [{ id: 'p1', kind: 'passhub', name: 'x', base_url: 'https://x.example.com', capabilities: { approvals: true, create_database: true, cancel: true, targets: true, decided_history: false }, has_session: true }],
      providerId: 'p1',
      status: { signed_in: true, signing_in: false, user: { id: 'm', email: 'm@example.com', name: 'M', role: 'manager', can_approve: true } },
    });
    const cmds = accessCommands(t);
    expect(cmds.map((c) => c.id)).toEqual(['access-request', 'access-show', 'access-approvals']);
    cmds[2].run();
    expect(useAccess.getState()).toMatchObject({ launcherTab: 'access', accessTab: 'approvals' });
    expect(useApp.getState().launcher).toBe(true);
    cmds[0].run();
    expect(useAccess.getState().sheet).toEqual({});
  });

  it('openAccessView keeps an open draft', () => {
    useAccess.setState({ sheet: { draft: { resourceId: 'r', access: 'read_only', databases: [], reason: 'x' } } });
    openAccessView({ sheet: true });
    expect(useAccess.getState().sheet?.draft?.resourceId).toBe('r');
  });

  it('a failed managed connection offers "Request access again", which pre-opens the request sheet', async () => {
    offerRequestAgain({ provider_id: 'p1', provider_kind: 'passhub', request_id: 'r1', expires_at: 1, expired: false }, 'orders · shop', 'password authentication failed', t);
    const toast = useApp.getState().toasts[0];
    expect(toast.kind).toBe('error');
    expect(toast.text).toMatch(/Couldn't open orders · shop/);
    expect(toast.action?.label).toBe('Request access again');
    toast.action!.run();
    await vi.waitFor(() => expect(useApp.getState().launcher).toBe(true));
    expect(useAccess.getState()).toMatchObject({ launcherTab: 'access', sheet: { draft: undefined } });
  });
});
