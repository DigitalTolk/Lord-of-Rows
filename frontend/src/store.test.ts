import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store talks to Rust over IPC; here only the calls the tested actions make are stubbed.
const ipc = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  label: 'main',
  openWindow: vi.fn(async () => 'window-1'),
}));
vi.mock('./lib/ipc', () => ({
  api: {
    appInfo: async () => ({ version: 'test' }),
    getSettings: async () => ipc.settings,
    listConnections: async () => [],
    openWindow: ipc.openWindow,
  },
  IpcError: Error,
}));
vi.mock('./lib/updates', () => ({ autoCheckForUpdates: async () => undefined }));
vi.mock('./lib/windows', async (orig) => ({ ...(await orig<typeof import('./lib/windows')>()), currentWindowLabel: () => ipc.label }));

import { restoreWorkspace, useApp, workspaceSnapshot, type Tab } from './store';
import { persistsWorkspace, windowTitle } from './lib/windows';

const reset = () => useApp.setState({ tabs: [], activeTab: undefined, closedTabs: [], sessions: {}, activeSession: undefined, toasts: [] });

describe('split editor state', () => {
  beforeEach(reset);

  it('toggles a query tab between single, right and down layouts', () => {
    const id = useApp.getState().openTab({ kind: 'query', title: 'Q', sql: 'select 1' });
    const tab = () => useApp.getState().tabs.find((t) => t.id === id)!;
    useApp.getState().toggleSplit(id);
    expect(tab().split).toBe('right');
    expect(tab().sql2).toBe('');
    useApp.getState().toggleSplit(id, 'down');
    expect(tab().split).toBe('down');
    useApp.getState().toggleSplit(id, 'down');
    expect(tab().split).toBeUndefined();
    expect(tab().sql).toBe('select 1');
  });

  it('keeps the second pane text when the split is closed and reopened', () => {
    const id = useApp.getState().openTab({ kind: 'query', title: 'Q', sql: 'a' });
    useApp.getState().toggleSplit(id, 'right');
    useApp.getState().updateTab(id, { sql2: 'select 2' });
    useApp.getState().toggleSplit(id);
    useApp.getState().toggleSplit(id);
    const t = useApp.getState().tabs.find((x) => x.id === id)!;
    expect(t.split).toBe('right');
    expect(t.sql2).toBe('select 2');
  });

  it('only splits query tabs', () => {
    const id = useApp.getState().openTab({ kind: 'settings', title: 'Settings' });
    useApp.getState().toggleSplit(id);
    expect(useApp.getState().tabs[0].split).toBeUndefined();
  });

  it('persists and restores split layout and both panes with the tab', () => {
    const tabs: Tab[] = [
      { id: 'q1', kind: 'query', title: 'Q1', sql: 'select 1', sql2: 'select 2', split: 'down', sessionId: 's1' },
      { id: 'q2', kind: 'query', title: 'Q2', sql: 'x' },
      { id: 't1', kind: 'table', title: 'users', sessionId: 's1', target: { schema: null, table: 'users' } },
    ];
    const saved = JSON.parse(JSON.stringify(workspaceSnapshot(tabs)));
    expect(saved).toHaveLength(2);
    expect(saved[0]).not.toHaveProperty('sessionId');
    const restored = restoreWorkspace(saved);
    expect(restored[0]).toMatchObject({ id: 'q1', sql: 'select 1', sql2: 'select 2', split: 'down', sessionId: undefined });
    expect(restored[1].split).toBeUndefined();
    // Junk in the saved setting is ignored.
    expect(restoreWorkspace([{ id: 'z', kind: 'query', split: 'diagonal' }, null, { kind: 'table', id: 'y' }])).toEqual([{ id: 'z', kind: 'query', split: undefined, sessionId: undefined }]);
    expect(restoreWorkspace('nope')).toEqual([]);
  });
});

describe('window-scoped workspace', () => {
  beforeEach(reset);
  const saved = [{ id: 'q1', kind: 'query', title: 'Saved', sql: 'select 42', split: 'right', sql2: 'select 43' }];

  it('the main window restores the saved tabs', async () => {
    ipc.label = 'main';
    ipc.settings = { 'workspace.tabs': saved };
    await useApp.getState().init();
    expect(useApp.getState().tabs.map((t) => t.title)).toEqual(['Saved']);
    expect(useApp.getState().tabs[0].split).toBe('right');
    expect(useApp.getState().activeTab).toBe('q1');
  });

  it('a secondary window starts with an empty workspace and does not persist', async () => {
    ipc.label = 'window-3';
    ipc.settings = { 'workspace.tabs': saved };
    await useApp.getState().init();
    expect(useApp.getState().tabs).toEqual([]);
    expect(persistsWorkspace('window-3')).toBe(false);
    expect(persistsWorkspace('main')).toBe(true);
  });

  it('opens a new window through the backend and reports failures', async () => {
    await useApp.getState().openWindow();
    expect(ipc.openWindow).toHaveBeenCalledTimes(1);
    ipc.openWindow.mockRejectedValueOnce(new Error('no window for you'));
    await useApp.getState().openWindow();
    expect(useApp.getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'no window for you' });
  });

  it('titles windows "Lord of the Rows — <connection>"', () => {
    expect(windowTitle('Lord of the Rows', 'Prod DB')).toBe('Lord of the Rows — Prod DB');
    expect(windowTitle('Lord of the Rows')).toBe('Lord of the Rows');
  });
});
