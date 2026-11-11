import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

vi.mock('../lib/ipc', () => ({ api: { useSchema: vi.fn(async () => {}), listObjects: vi.fn(async () => []) }, IpcError: class extends Error {} }));

import { useApp, type OpenSession } from '../store';
import { ConnectionRail, useOpenedSchemas } from './ConnectionRail';

afterEach(cleanup);

const session = {
  session_id: 's1',
  server: { engine: 'my_sql', version: '8.4.7' },
  capabilities: {},
  policy: {},
  config: { id: 'c1', name: 'Local MySQL', engine: 'my_sql', environment: 'local', tls: { mode: 'disabled' } },
  schemas: ['inventory', 'billing_archive', 'reporting'],
  objects: { inventory: [], billing_archive: [] },
  activeSchema: 'inventory',
  healthy: true,
} as unknown as OpenSession;

describe('ConnectionRail', () => {
  it('labels connections and lists opened databases with names; click switches', async () => {
    useOpenedSchemas.setState({ bySession: { s1: ['billing_archive'] } });
    useApp.setState({ sessions: { s1: session }, activeSession: 's1', tabs: [] });
    render(<ConnectionRail />);
    expect(screen.getByText('Local MySQL')).toBeTruthy();
    const list = screen.getByRole('listbox', { name: 'Databases' });
    const options = [...list.querySelectorAll('[role=option]')];
    expect(options.map((o) => o.textContent)).toEqual(['billing_archive', 'inventory']);
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTitle('reporting')).toBeNull();
    await act(async () => fireEvent.click(options[0]));
    expect(useApp.getState().sessions.s1.activeSchema).toBe('billing_archive');
  });
});
