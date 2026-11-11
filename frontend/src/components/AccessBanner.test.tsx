import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import type { OpenSession } from '../store';

const api = vi.hoisted(() => ({ closeSession: vi.fn(async () => undefined), cancelQuery: vi.fn(async () => true) }));
vi.mock('../lib/ipc', () => ({ api, IpcError: class extends Error {} }));
const again = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/accessStore', () => ({ requestAgainFor: again }));

import { SESSION_ENDING_EVENT, useApp } from '../store';
import { AccessEndedOverlay, AccessExpiryBanner, warningLevel } from './AccessBanner';

const NOW = Math.floor(Date.now() / 1000);
const session = (expires_at: number, extra: Partial<OpenSession> = {}): OpenSession =>
  ({
    session_id: 's1',
    server: { version: 'PostgreSQL 16' },
    capabilities: {},
    policy: { name: 'staging' },
    config: { id: 'c1', name: 'orders · shop', engine: 'postgres', tls: { mode: 'required' }, environment: 'staging', read_only: false, tags: [], favorite: false, connect_timeout_secs: 10, managed_by: { provider_id: 'p1', provider_kind: 'passhub', request_id: 'r1', expires_at, expired: false } },
    schemas: [],
    objects: {},
    activeSchema: null,
    healthy: true,
    ...extra,
  }) as unknown as OpenSession;

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  useApp.setState({ sessions: {}, activeSession: undefined, tabs: [] });
});

describe('access expiry in the workspace', () => {
  it('warning levels: 15 then 5 minutes', () => {
    expect(warningLevel(3600)).toBeNull();
    expect(warningLevel(15 * 60)).toBe(15);
    expect(warningLevel(6 * 60)).toBe(15);
    expect(warningLevel(5 * 60)).toBe(5);
  });

  it('banner shows in the last 15 minutes, offers Request again, can be dismissed', () => {
    useApp.setState({ sessions: { s1: session(NOW + 10 * 60) }, activeSession: 's1' });
    render(<AccessExpiryBanner />);
    expect(screen.getByRole('status').textContent).toMatch(/Access to orders · shop ends in 10 m/);
    fireEvent.click(screen.getByRole('button', { name: 'Request again' }));
    expect(again).toHaveBeenCalledWith(expect.objectContaining({ request_id: 'r1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('no banner with plenty of time or for unmanaged connections', () => {
    useApp.setState({ sessions: { s1: session(NOW + 3600) }, activeSession: 's1' });
    const { rerender } = render(<AccessExpiryBanner />);
    expect(screen.queryByRole('status')).toBeNull();
    const plain = session(0);
    plain.config.managed_by = null;
    useApp.setState({ sessions: { s1: plain } });
    rerender(<AccessExpiryBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ending a session cancels queries via the event, closes it and keeps query tabs', async () => {
    const heard = vi.fn();
    window.addEventListener(SESSION_ENDING_EVENT, heard);
    useApp.setState({
      sessions: { s1: session(NOW - 1) },
      activeSession: 's1',
      tabs: [
        { id: 'q', kind: 'query', title: 'Query', sessionId: 's1', sql: 'select 1' },
        { id: 't', kind: 'table', title: 'customers', sessionId: 's1' },
      ],
      activeTab: 'q',
    });
    await act(async () => {
      await useApp.getState().endSession('s1');
    });
    expect(heard).toHaveBeenCalled();
    expect(api.closeSession).toHaveBeenCalledWith('s1');
    expect(useApp.getState().sessions.s1.ended).toBe(true);
    expect(useApp.getState().tabs).toHaveLength(2);
    render(<AccessEndedOverlay />);
    expect(screen.getByRole('alertdialog').textContent).toMatch(/Access ended/);
    fireEvent.click(screen.getByRole('button', { name: 'Close connection' }));
    const tabs = useApp.getState().tabs;
    expect(tabs).toEqual([{ id: 'q', kind: 'query', title: 'Query', sessionId: undefined, sql: 'select 1' }]);
    expect(useApp.getState().sessions.s1).toBeUndefined();
    window.removeEventListener(SESSION_ENDING_EVENT, heard);
  });
});
