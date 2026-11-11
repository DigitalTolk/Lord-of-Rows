// Row detail panel preference: auto-open on row selection, 'closed'
// after an explicit close, back to 'auto' after an explicit open; persisted via setSetting.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

const { setSetting, columns } = vi.hoisted(() => ({
  setSetting: vi.fn<(key: string, value: unknown) => Promise<void>>(async () => undefined),
  columns: [
    { name: 'id', type_name: 'int4' },
    { name: 'name', type_name: 'text' },
  ],
}));
vi.mock('../lib/ipc', () => {
  const defaults: Record<string, unknown> = {
    describeTable: { object: { schema: 'public', name: 't', kind: 'table' }, columns: [], primary_key: ['id'], indexes: [], foreign_keys: [], constraints: [], estimated_rows: 2 },
    fetchTable: {
      columns,
      rows: [
        [{ t: 'int', v: 1 }, { t: 'text', v: 'Ada' }],
        [{ t: 'int', v: 2 }, { t: 'text', v: 'Bob' }],
      ],
      truncated: false,
    },
    countRows: 2,
  };
  const api = new Proxy({}, { get: (_t, k: string) => (k === 'setSetting' ? setSetting : async () => (k in defaults ? defaults[k] : [])) });
  return { api, IpcError: class extends Error {} };
});
vi.mock('@monaco-editor/react', () => ({ default: () => null }));
vi.mock('../lib/monaco', () => ({ useEditorTheme: () => 'vs' }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));

import { DETAIL_PREF_KEY, DETAIL_WIDTH_KEY, detailPref, detailWidth, onRowsSelected, saveDetailWidth, setDetailPanel } from '../lib/detailPanel';
import { useTableWs } from '../lib/tableWorkspace';
import { useApp, type OpenSession, type Tab } from '../store';
import { TableView } from '../views/TableView';
import { TopBar } from './Shell';

const TAB: Tab = { id: 'tt', kind: 'table', title: 't', sessionId: 's1', target: { schema: 'public', table: 't' } };
const session = {
  session_id: 's1',
  server: { engine: 'postgres', version: 'PostgreSQL 16' },
  capabilities: { inline_edit: true, schemas: true },
  policy: { name: 'default' },
  config: { id: 'c1', name: 'dev', engine: 'postgres', environment: 'local', read_only: false, tls: { mode: 'disable' } },
  schemas: ['public'],
  objects: {},
  activeSchema: 'public',
  healthy: true,
} as unknown as OpenSession;

const isOpen = (id = TAB.id) => !!useTableWs.getState().tabs[id]?.detailOpen;
const pref = () => detailPref(useApp.getState().settings);

beforeEach(() => {
  setSetting.mockClear();
  useApp.setState({ settings: {}, sessions: { s1: session }, activeSession: 's1', tabs: [TAB], activeTab: TAB.id });
  useTableWs.setState({ tabs: {} });
  // jsdom has no layout: give the grid's virtualizer a viewport so rows render.
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, bottom: 600, right: 800, width: 800, height: 600, toJSON: () => ({}) } as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('detail panel preference', () => {
  it('defaults to auto: a new tab stays closed until a row is selected, then opens', () => {
    expect(pref()).toBe('auto');
    onRowsSelected(TAB.id, []);
    expect(isOpen()).toBe(false);
    onRowsSelected(TAB.id, [0]);
    expect(isOpen()).toBe(true);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('closing switches to closed (persisted) and further selections do not open it', async () => {
    onRowsSelected(TAB.id, [0]);
    setDetailPanel(TAB.id, false);
    expect(isOpen()).toBe(false);
    expect(pref()).toBe('closed');
    expect(setSetting).toHaveBeenCalledWith(DETAIL_PREF_KEY, 'closed');
    onRowsSelected(TAB.id, [1]);
    expect(isOpen()).toBe(false);
    // Other (new) table tabs follow the preference too.
    onRowsSelected('other', [0]);
    expect(isOpen('other')).toBe(false);
  });

  it('an explicit open (toggle) switches back to auto and persists it', () => {
    useApp.setState({ settings: { [DETAIL_PREF_KEY]: 'closed' } });
    setDetailPanel(TAB.id);
    expect(isOpen()).toBe(true);
    expect(pref()).toBe('auto');
    expect(setSetting).toHaveBeenCalledWith(DETAIL_PREF_KEY, 'auto');
    // Toggling again closes and switches to closed.
    setDetailPanel(TAB.id);
    expect(isOpen()).toBe(false);
    expect(setSetting).toHaveBeenLastCalledWith(DETAIL_PREF_KEY, 'closed');
  });

  it('remembers the panel width (clamped) and survives a failing backend', () => {
    setSetting.mockRejectedValueOnce(new Error('boom'));
    saveDetailWidth(5000);
    expect(setSetting).toHaveBeenCalledWith(DETAIL_WIDTH_KEY, 720);
    expect(detailWidth(useApp.getState().settings)).toBe(720);
    expect(detailWidth({ [DETAIL_WIDTH_KEY]: 'x' })).toBe(320);
  });
});

describe('table view and toolbar', () => {
  const cell = (text: string) => screen.getAllByRole('gridcell').find((c) => c.textContent?.startsWith(text))!;
  const panel = () => screen.queryByRole('complementary', { name: 'Row details' });

  it('clicking a row opens the panel; × closes it and later clicks keep it closed; ⌘⇧D reopens', async () => {
    render(<TableView tab={TAB} />);
    await screen.findByText('Ada');
    expect(panel()).toBeNull();
    act(() => void fireEvent.mouseDown(cell('Ada'), { button: 0 }));
    expect(panel()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(panel()).toBeNull();
    expect(setSetting).toHaveBeenCalledWith(DETAIL_PREF_KEY, 'closed');
    act(() => void fireEvent.mouseDown(cell('Bob'), { button: 0 }));
    expect(panel()).toBeNull();
    fireEvent.keyDown(cell('Bob'), { key: 'D', metaKey: true, ctrlKey: true, shiftKey: true });
    expect(panel()).not.toBeNull();
    expect(pref()).toBe('auto');
  });

  it('toolbar button reflects the state with aria-pressed and toggles via the same action', () => {
    render(<TopBar onToggleSidebar={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Toggle row details' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toMatch(/Toggle row details \((⌘⇧|Ctrl\+Shift\+)D\)/);
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(pref()).toBe('auto');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(setSetting).toHaveBeenLastCalledWith(DETAIL_PREF_KEY, 'closed');
  });

  it('toolbar button is disabled without an active table tab', () => {
    useApp.setState({ tabs: [{ id: 'q', kind: 'query', title: 'Q', sessionId: 's1' }], activeTab: 'q' });
    render(<TopBar onToggleSidebar={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Toggle row details' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });
});
