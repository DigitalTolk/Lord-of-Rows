import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

vi.mock('../lib/ipc', () => {
  const api = new Proxy({}, { get: () => async () => [] });
  return { api, IpcError: class extends Error {} };
});

import { useApp, type OpenSession } from '../store';
import type { StoredConnection } from '../lib/types';
import { Welcome } from './Welcome';

const conn: StoredConnection = {
  sort: 0,
  config: { id: 'c1', name: 'Orders', engine: 'my_sql', host: 'db.example.com', database: 'orders', tls: { mode: 'required' }, environment: 'staging', read_only: false, tags: [], favorite: false, connect_timeout_secs: 10 },
} as unknown as StoredConnection;

describe('Welcome: opening a connection', () => {
  afterEach(cleanup);
  let openSession: ReturnType<typeof vi.fn>;
  let switchSession: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    openSession = vi.fn(() => new Promise<string>(() => {})); // stays "connecting"
    switchSession = vi.fn();
    useApp.setState({ connections: [conn], sessions: {}, openSession, switchSession, reloadConnections: vi.fn(async () => undefined) } as never);
  });

  it('a double-click while connecting opens the connection once', async () => {
    render(<Welcome />);
    const row = await screen.findByRole('option', { name: /Orders/ });
    await act(async () => {
      fireEvent.doubleClick(row);
      fireEvent.doubleClick(row);
      fireEvent.keyDown(row, { key: 'Enter' });
    });
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it('a connection already open in this window is switched to, not opened again', async () => {
    useApp.setState({ sessions: { s1: { session_id: 's1', config: conn.config } as unknown as OpenSession } });
    render(<Welcome />);
    await act(async () => fireEvent.doubleClick(await screen.findByRole('option', { name: /Orders/ })));
    expect(openSession).not.toHaveBeenCalled();
    expect(switchSession).toHaveBeenCalledWith('s1');
  });
});
