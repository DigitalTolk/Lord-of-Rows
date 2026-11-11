import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

vi.mock('../lib/ipc', () => ({ api: { listHistory: vi.fn(async () => []), listSnippets: vi.fn(async () => []), listDocuments: vi.fn(async () => []) }, IpcError: class extends Error {} }));

import { EMPTY_TAB_STATE, useTableWs } from '../lib/tableWorkspace';
import { useApp, type OpenSession } from '../store';
import { Sidebar } from './Sidebar';
import { TabBar } from './Shell';

afterEach(cleanup);

const session = {
  session_id: 's1',
  server: { engine: 'postgres', version: '16' },
  capabilities: {},
  policy: {},
  config: { id: 'c1', name: 'Local', engine: 'postgres', environment: 'local', tls: { mode: 'disabled' } },
  schemas: ['public'],
  objects: { public: [{ kind: 'table', schema: 'public', name: 'customers' }, { kind: 'table', schema: 'public', name: 'orders' }] },
  activeSchema: 'public',
  healthy: true,
} as unknown as OpenSession;

describe('pending changes highlight', () => {
  it('tints the tree item and marks the tab of a table with staged changes', async () => {
    useApp.setState({
      sessions: { s1: session },
      activeSession: 's1',
      tabs: [
        { id: 't1', kind: 'table', title: 'orders', sessionId: 's1', target: { schema: 'public', table: 'orders' } },
        { id: 't2', kind: 'table', title: 'customers', sessionId: 's1', target: { schema: 'public', table: 'customers' } },
      ],
      activeTab: 't2',
    });
    useTableWs.setState({ tabs: { t1: { ...EMPTY_TAB_STATE, pending: 3 } } });
    await act(async () => {
      render(<><TabBar /><Sidebar sessionId="s1" /></>);
    });
    const orders = screen.getByRole('treeitem', { name: 'orders' });
    expect(orders.className).toContain('bg-warn/35');
    expect(orders.getAttribute('aria-description')).toBe('3 pending changes');
    const customers = screen.getByRole('treeitem', { name: 'customers' });
    expect(customers.className).not.toContain('bg-warn');
    expect(customers.className).toContain('row-selected');
    const tab = screen.getByRole('tab', { name: /orders/ });
    expect(tab.getAttribute('aria-description')).toBe('3 pending changes');
    expect(tab.querySelector('[data-testid=tab-pending]')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /customers/ }).querySelector('[data-testid=tab-pending]')).toBeNull();

    // Selected and pending: keeps the selection style and adds the amber ring.
    await act(async () => {
      useApp.setState({ activeTab: 't1' });
    });
    const sel = screen.getByRole('treeitem', { name: 'orders' });
    expect(sel.className).toContain('row-selected');
    expect(sel.className).toContain('ring-warn');
  });
});
