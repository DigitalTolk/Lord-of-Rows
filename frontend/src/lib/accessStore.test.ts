import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';

const api = vi.hoisted(() => ({
  accessProviders: vi.fn(async () => [{ id: 'p1', kind: 'passhub', name: 'Company access', base_url: 'https://access.example.com', capabilities: { approvals: true, create_database: true, cancel: true, targets: true, decided_history: true }, has_session: true }]),
  accessStatus: vi.fn(async () => ({ signed_in: true, signing_in: false, user: { id: 'u1', email: 'dev@example.com', name: 'Dev', role: 'developer', can_approve: false } })),
  accessListRequests: vi.fn(async () => ({ requests: [], expired_connections: [] })),
  accessListApprovals: vi.fn(async () => []),
  accessTakeDeepLink: vi.fn(async (): Promise<unknown> => null),
  accessGetRequest: vi.fn(async (_p: string, id: string) => ({ id, resource_name: 'orders', status: 'ready' })),
  accessAddProvider: vi.fn(async () => ({ id: 'p2' })),
}));
vi.mock('./ipc', () => ({ api, IpcError: class extends Error {} }));

import { useApp } from '../store';
import { accessCommands, handleDeepLink, offerRequestAgain, openAccessView, useAccess } from './accessStore';

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

  describe('deep links', () => {
    it('known provider + request: opens the Access tab and the request drawer, never connects', async () => {
      api.accessTakeDeepLink.mockResolvedValueOnce({ provider_url: 'https://access.example.com', request_id: 'r7', kind: 'passhub', provider_id: 'p1' });
      const confirm = vi.fn(async () => true);
      await handleDeepLink(confirm);
      expect(confirm).not.toHaveBeenCalled();
      expect(useApp.getState().launcher).toBe(true);
      expect(useAccess.getState()).toMatchObject({ providerId: 'p1', launcherTab: 'access', detail: { mode: 'mine', request: { id: 'r7' } } });
      useAccess.setState({ detail: null });
    });

    it('unknown provider: asks first; declining adds nothing', async () => {
      api.accessTakeDeepLink.mockResolvedValueOnce({ provider_url: 'https://new.example.com', request_id: null, kind: 'passhub', provider_id: null });
      const confirm = vi.fn(async () => false);
      await handleDeepLink(confirm);
      expect(confirm).toHaveBeenCalledWith('new.example.com');
      expect(api.accessAddProvider).not.toHaveBeenCalled();
      expect(useApp.getState().launcher).toBe(false);
    });

    it('unknown provider accepted: added (then sign in); the request opens after sign-in', async () => {
      api.accessTakeDeepLink.mockResolvedValueOnce({ provider_url: 'https://new.example.com', request_id: 'r9', kind: 'passhub', provider_id: null });
      api.accessStatus.mockResolvedValue({ signed_in: false, signing_in: false, user: null } as never);
      await handleDeepLink(async () => true);
      expect(api.accessAddProvider).toHaveBeenCalledWith('passhub', 'new.example.com', 'https://new.example.com');
      expect(useAccess.getState().linkRequest).toBe('r9');
      expect(useAccess.getState().detail).toBeNull();
    });

    it('nothing pending / malformed answers are ignored', async () => {
      api.accessTakeDeepLink.mockResolvedValueOnce([] as never);
      await handleDeepLink(async () => true);
      api.accessTakeDeepLink.mockRejectedValueOnce(new Error('not in the app'));
      await handleDeepLink(async () => true);
      expect(useApp.getState().launcher).toBe(false);
    });
  });
});
