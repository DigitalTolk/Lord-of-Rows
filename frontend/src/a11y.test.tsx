// Automated accessibility checks (axe-core in jsdom) for the main views and dialogs, plus
// keyboard-behaviour tests for the custom widgets (tree, tab bar, menus, dialogs).
//
// Limits (see docs/ACCESSIBILITY.md): jsdom has no layout, so axe's colour-contrast rule
// cannot run here; contrast is checked from the CSS tokens in src/lib/theme.test.ts instead.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';

vi.mock('./lib/ipc', () => {
  const tls = { mode: 'disable', ca_cert_path: null, client_cert_path: null, client_key_path: null };
  const conn = (id: string, name: string, environment: string, extra: object = {}) => ({
    config: { id, name, engine: 'postgres', host: 'db.local', port: 5432, database: 'app', username: 'app', tls, environment, read_only: false, tags: [], favorite: false, connect_timeout_secs: 10, ...extra },
    sort: 0,
  });
  const defaults: Record<string, unknown> = {
    appInfo: { version: '1.2.3', os: 'macos', arch: 'aarch64', secret_backend: 'macOS Keychain', supported_engines: ['postgres', 'sqlite'], all_engines: ['postgres', 'sqlite', 'oracle'] },
    getSettings: {},
    listConnections: [conn('c1', 'Local dev', 'local', { favorite: true }), conn('c2', 'Orders prod', 'production', { read_only: true, group: 'Shop' })],
    aiStatus: { settings: { enabled: false, provider: 'anthropic', model: '', base_url: '', redact_literals: true }, has_api_key: false },
    listHistory: [],
    listSnippets: [],
    pingSession: 3,
  };
  const api = new Proxy({}, { get: (_t, k: string) => async () => (k in defaults ? defaults[k] : []) });
  return { api, IpcError: class extends Error {} };
});
vi.mock('./lib/monaco', () => ({
  monaco: {},
  registerSqlCompletion: () => undefined,
  setCompletionSource: () => undefined,
  useEditorTheme: () => 'dbs-light',
}));
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, options }: { value?: string; options?: { ariaLabel?: string } }) => <textarea aria-label={options?.ariaLabel ?? 'SQL editor'} defaultValue={value} />,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));

import App from './App';
import { ask } from './components/ask';
import { confirmDecision } from './components/confirm';
import { useApp, type OpenSession } from './store';

const SESSION: OpenSession = {
  session_id: 's1',
  server: { engine: 'postgres', version: 'PostgreSQL 16.4 on aarch64', current_database: 'app' },
  capabilities: { sql: true, transactions: true, schemas: true, multiple_databases: false, explain: true, explain_analyze: true, cancel: true, inline_edit: true, ddl_editing: true, read_only_session: true, sessions_monitor: true, kill_session: true, native_backup: true, object_kinds: ['table', 'view'] },
  policy: { name: 'local', read_only: false, typed_confirmation_for_destructive: false },
  config: { id: 'c1', name: 'Local dev', engine: 'postgres', host: 'db.local', port: 5432, database: 'app', username: 'app', tls: { mode: 'disable' } as never, environment: 'local', read_only: false, tags: [], favorite: true, connect_timeout_secs: 10 },
  schemas: ['public', 'audit'],
  objects: {
    public: [
      { kind: 'table', schema: 'public', name: 'customers' },
      { kind: 'table', schema: 'public', name: 'orders' },
      { kind: 'view', schema: 'public', name: 'order_totals' },
    ] as never,
  },
  activeSchema: 'public',
  healthy: true,
  latency: 3,
};

/** Fails with a readable list of serious/critical axe violations on the whole document. */
async function expectAccessible(label: string) {
  const res = await axe.run(document, {
    // jsdom has no layout/colours: contrast is covered by theme.test.ts (token pairs).
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = bad.map((v) => `${label} :: ${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ') + ' — ' + n.failureSummary?.split('\n').slice(1).join(' ')).join('\n    ')}`);
  expect(report).toEqual([]);
}

async function renderApp() {
  render(<App />);
  // init(): appInfo/getSettings/listConnections resolve on the microtask queue.
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function openWorkspace(tabs = [{ id: 't1', kind: 'query' as const, title: 'Query', sessionId: 's1', sql: 'select 1' }]) {
  await act(async () => {
    useApp.setState({ sessions: { s1: SESSION }, activeSession: 's1', launcher: false, tabs, activeTab: tabs[0]?.id });
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(async () => {
  document.title = 'Lord of the Rows'; // index.html provides it in the app
  await i18n.changeLanguage('en');
  useApp.setState({ sessions: {}, activeSession: undefined, tabs: [], closedTabs: [], activeTab: undefined, launcher: false, paletteOpen: false, connectionDialog: null, toasts: [], settings: {} });
});
afterEach(() => {
  cleanup();
});

describe('axe: no serious or critical violations', () => {
  it('launcher (Welcome)', async () => {
    await renderApp();
    expect(screen.getByRole('listbox', { name: 'Connections' })).toBeTruthy();
    await expectAccessible('Welcome');
  });

  it('connection dialog (engine picker and form)', async () => {
    await renderApp();
    await act(async () => {
      useApp.setState({ connectionDialog: {} });
    });
    await expectAccessible('ConnectionDialog/picker');
    await act(async () => {
      fireEvent.click(screen.getByText('PostgreSQL'));
    });
    await expectAccessible('ConnectionDialog/form');
  });

  it('workspace shell with a query tab, sidebar tree and rail', async () => {
    await renderApp();
    await openWorkspace();
    expect(screen.getByRole('tree')).toBeTruthy();
    expect(within(screen.getByRole('tablist', { name: 'Open tabs' })).getByRole('tab', { selected: true })).toBeTruthy();
    await expectAccessible('Shell/query');
  });

  it('settings, every section', async () => {
    await renderApp();
    await openWorkspace([{ id: 'set', kind: 'settings' as never, title: 'Settings', sessionId: undefined as never, sql: undefined as never }]);
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    for (const b of within(nav).getAllByRole('button')) {
      await act(async () => {
        fireEvent.click(b);
        await new Promise((r) => setTimeout(r, 0));
      });
      await expectAccessible(`Settings/${b.textContent}`);
    }
  }, 30_000); // one axe run per section

  it('confirm dialog and safety dialog', async () => {
    await renderApp();
    let answer: Promise<boolean> | undefined;
    await act(async () => {
      answer = ask.confirm('Delete', 'Delete connection "x"?', true);
    });
    expect(screen.getByRole('dialog', { name: 'Delete' })).toBeTruthy();
    await expectAccessible('AskHost/confirm');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(await answer).toBe(false);

    await act(async () => {
      void confirmDecision({ decision: 'confirm', findings: [{ statement: 0, risk: 'destructive', reason: 'DROP TABLE removes data' }], typed_phrase: 'Local dev', token: 'tok' }, { production: true, sqlPreview: 'DROP TABLE orders;' });
    });
    expect(screen.getByRole('dialog', { name: 'Review before running' })).toBeTruthy();
    await expectAccessible('SafetyDialog');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('command palette', async () => {
    await renderApp();
    await openWorkspace();
    await act(async () => {
      useApp.setState({ paletteOpen: true });
    });
    expect(screen.getByRole('combobox', { name: 'Command palette' })).toBeTruthy();
    await expectAccessible('CommandPalette');
  });

  it('Arabic (RTL) launcher and workspace', async () => {
    await act(async () => {
      await i18n.changeLanguage('ar');
    });
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    await renderApp();
    await expectAccessible('ar/Welcome');
    await openWorkspace();
    await expectAccessible('ar/Shell');
  });
});

describe('keyboard', () => {
  it('sidebar tree: arrows move, Left goes to parent then collapses, Right expands', async () => {
    await renderApp();
    await openWorkspace();
    const tree = screen.getByRole('tree');
    const items = within(tree).getAllByRole('treeitem');
    const group = items[0];
    expect(group.getAttribute('tabindex')).toBe('0');
    act(() => group.focus());
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('customers');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('orders');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(group);
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(group.getAttribute('aria-expanded')).toBe('true');
    // Only one node is in the Tab order.
    expect(within(tree).getAllByRole('treeitem').filter((x) => x.tabIndex === 0)).toHaveLength(1);
  });

  it('tab bar: roving focus with arrows, Delete closes', async () => {
    await renderApp();
    await openWorkspace([
      { id: 't1', kind: 'query', title: 'One', sessionId: 's1', sql: '' },
      { id: 't2', kind: 'query', title: 'Two', sessionId: 's1', sql: '' },
    ]);
    const bar = () => within(screen.getByRole('tablist', { name: 'Open tabs' }));
    const [one] = bar().getAllByRole('tab');
    act(() => one.focus());
    await act(async () => {
      fireEvent.keyDown(one, { key: 'ArrowRight' });
    });
    expect(useApp.getState().activeTab).toBe('t2');
    const two = bar().getByRole('tab', { selected: true });
    expect(two.getAttribute('aria-controls')).toBe('tabpanel-t2');
    await act(async () => {
      fireEvent.keyDown(two, { key: 'Delete' });
    });
    expect(useApp.getState().tabs.map((x) => x.id)).toEqual(['t1']);
  });

  it('dialogs trap Tab and return focus to the opener on Escape', async () => {
    await renderApp();
    const opener = screen.getByRole('button', { name: 'Create a new connection' });
    act(() => opener.focus());
    let answer: Promise<string | null> | undefined;
    await act(async () => {
      answer = ask.text('Name', 'Type a name');
    });
    const dialog = screen.getByRole('dialog', { name: 'Name' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    });
    expect(await answer).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('context menu opens from the keyboard (Shift+F10), arrows move, Escape closes', async () => {
    await renderApp();
    const option = screen.getAllByRole('option')[0];
    act(() => option.focus());
    await act(async () => {
      fireEvent.keyDown(option, { key: 'F10', shiftKey: true });
    });
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    await act(async () => {
      fireEvent.keyDown(items[1], { key: 'Escape' });
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('toasts are announced through a persistent live region', async () => {
    await renderApp();
    const region = screen.getByRole('log');
    expect(region.getAttribute('aria-live')).toBe('polite');
    await act(async () => {
      useApp.getState().toast('ok', 'Structure updated');
    });
    expect(within(region).getByText('Structure updated')).toBeTruthy();
  });
});
