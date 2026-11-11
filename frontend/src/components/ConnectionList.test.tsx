import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import type { ConnectionConfig, ConnectionGroup, StoredConnection } from '../lib/types';

const groups: ConnectionGroup[] = [
  { name: 'Work', color: '#3b82f6', collapsed: false, sort: 0 },
  { name: 'Archive', color: null, collapsed: true, sort: 1 },
];

vi.mock('../lib/ipc', () => ({
  api: {
    listConnections: vi.fn(async () => []),
    listConnectionGroups: vi.fn(async () => groups),
    saveConnectionGroup: vi.fn(async (g) => g),
    renameConnectionGroup: vi.fn(async () => undefined),
    deleteConnectionGroup: vi.fn(async () => 1),
    reorderConnectionGroups: vi.fn(async () => undefined),
    setConnectionGroup: vi.fn(async () => ({})),
  },
  IpcError: class extends Error {},
}));

import { useApp } from '../store';
import { api } from '../lib/ipc';
import { ConnectionList } from './ConnectionList';
import { AskHost } from './ask';

const conn = (id: string, p: Partial<ConnectionConfig>): StoredConnection => ({
  sort: 0,
  config: { id, name: id, engine: 'postgres', host: 'h', database: 'd', tls: { mode: 'preferred' }, environment: 'local', read_only: false, tags: [], favorite: false, connect_timeout_secs: 10, ...p },
});

const connections = [
  conn('Orders', { group: 'Work', environment: 'production', host: 'orders.db', database: 'orders' }),
  conn('Reports', { group: 'Work', environment: 'staging', tags: ['bi'] }),
  conn('Old', { group: 'Archive', environment: 'testing' }),
  conn('Scratch', { engine: 'sqlite', host: null, database: '/home/me/scratch.db' }),
];

const props = { sel: null as string | null, onSelect: vi.fn(), busy: null, onConnect: vi.fn(), onAction: vi.fn() };

async function renderList(sel: string | null = null) {
  await act(async () => {
    render(
      <>
        <ConnectionList {...props} sel={sel} />
        <AskHost />
      </>,
    );
  });
}
const options = () => screen.getAllByRole('option').map((o) => o.getAttribute('data-nav'));
const header = (name: string) => screen.getByRole('group', { name: new RegExp(`^${name},`) });

describe('ConnectionList', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    useApp.setState({ connections, reloadConnections: vi.fn(async () => undefined) });
  });

  it('renders groups first (collapsed ones hide rows), then ungrouped, with env pills and subtitles', async () => {
    await renderList();
    expect(header('Work').getAttribute('aria-expanded')).toBe('true');
    expect(header('Archive').getAttribute('aria-expanded')).toBe('false');
    expect(options()).toEqual(['c:Orders', 'c:Reports', 'c:Scratch']);
    const orders = screen.getByText('Orders').closest('[role=option]') as HTMLElement;
    expect(within(orders).getByText('Production')).toBeTruthy();
    expect(within(orders).getByText('orders.db : orders')).toBeTruthy();
    expect(orders.className).toContain('border-danger-solid');
    const scratch = screen.getByText('Scratch').closest('[role=option]') as HTMLElement;
    expect(within(scratch).getByText('scratch.db').getAttribute('title')).toBe('/home/me/scratch.db');
  });

  it('persists collapse / expand of a group', async () => {
    await renderList();
    await act(async () => {
      fireEvent.click(header('Work'));
    });
    expect(api.saveConnectionGroup).toHaveBeenCalledWith({ ...groups[0], collapsed: true });
    expect(options()).toEqual(['c:Scratch']);
  });

  it('search hides non-matching groups and searches tags', async () => {
    await renderList();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'bi' } });
    expect(options()).toEqual(['c:Reports']);
    expect(screen.queryByRole('group', { name: /^Archive,/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'archive' } });
    // Collapsed groups are expanded while searching.
    expect(options()).toEqual(['c:Old']);
  });

  it('filters by environment chips (multi-select, All resets)', async () => {
    await renderList();
    const chips = screen.getByRole('group', { name: 'Filter by environment' });
    fireEvent.click(within(chips).getByText('Prod'));
    expect(options()).toEqual(['c:Orders']);
    fireEvent.click(within(chips).getByText('Local'));
    expect(options()).toEqual(['c:Orders', 'c:Scratch']);
    expect(within(chips).getByText('Local').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(chips).getByText('All'));
    expect(options()).toEqual(['c:Orders', 'c:Reports', 'c:Scratch']);
  });

  it('arrow keys move through headers and rows, ←/→ collapse/expand, Enter connects', async () => {
    await renderList('Orders');
    const orders = screen.getByText('Orders').closest('[role=option]') as HTMLElement;
    expect(orders.tabIndex).toBe(0);
    fireEvent.keyDown(orders, { key: 'ArrowDown' });
    expect(props.onSelect).toHaveBeenLastCalledWith('Reports');
    fireEvent.keyDown(orders, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(header('Work'));
    fireEvent.keyDown(header('Archive'), { key: 'ArrowRight' });
    expect(api.saveConnectionGroup).toHaveBeenCalledWith({ ...groups[1], collapsed: false });
    fireEvent.keyDown(orders, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(header('Work'));
    fireEvent.keyDown(orders, { key: 'Enter' });
    expect(props.onConnect).toHaveBeenCalledWith('Orders');
    fireEvent.doubleClick(orders);
    expect(props.onConnect).toHaveBeenCalledTimes(2);
  });

  it('moves a connection with the context menu "Move to group"', async () => {
    await renderList();
    fireEvent.contextMenu(screen.getByText('Scratch'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Move to group/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Work' }));
    });
    expect(api.setConnectionGroup).toHaveBeenCalledWith('Scratch', 'Work');
  });

  it('moves a connection by drag and drop onto a group, or out of it', async () => {
    await renderList();
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '', get types() { return [...data.keys()]; }, effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(screen.getByText('Scratch').closest('[role=option]')!, { dataTransfer });
    fireEvent.dragOver(header('Archive'), { dataTransfer });
    await act(async () => {
      fireEvent.drop(header('Archive'), { dataTransfer });
    });
    expect(api.setConnectionGroup).toHaveBeenCalledWith('Scratch', 'Archive');
    fireEvent.dragStart(screen.getByText('Orders').closest('[role=option]')!, { dataTransfer });
    await act(async () => {
      fireEvent.drop(screen.getByText('Scratch'), { dataTransfer });
    });
    expect(api.setConnectionGroup).toHaveBeenCalledWith('Orders', null);
  });

  it('deletes a group after confirmation via its context menu', async () => {
    await renderList();
    fireEvent.contextMenu(header('Work'), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete group…' }));
    expect(await screen.findByText(/Its 2 connections move to Ungrouped/)).toBeTruthy();
    expect(api.deleteConnectionGroup).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    });
    expect(api.deleteConnectionGroup).toHaveBeenCalledWith('Work');
  });

  it('creates a new group from the toolbar button', async () => {
    await renderList();
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    fireEvent.change(await screen.findByLabelText('New group', { selector: 'input' }), { target: { value: ' Clients ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    });
    expect(api.saveConnectionGroup).toHaveBeenCalledWith({ name: 'Clients', color: null, collapsed: false, sort: 0 });
  });
});
