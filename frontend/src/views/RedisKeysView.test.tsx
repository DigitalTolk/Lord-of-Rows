import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

const keyRow = (key: string, kind = 'string', length = 3) => ({ key, kind, ttl: -1, size: 50, length, preview: kind === 'string' ? `v-${key}` : null, preview_truncated: false });

vi.mock('../lib/ipc', () => ({
  api: {
    kvScanKeys: vi.fn(),
    kvReadValue: vi.fn(),
    kvPreviewEdits: vi.fn(),
    kvApplyEdits: vi.fn(),
    kvKeyspaces: vi.fn(async () => []),
    setSetting: vi.fn(async () => undefined),
  },
  IpcError: class extends Error {},
}));

import { api } from '../lib/ipc';
import { KeyPatternBar } from '../components/FilterBar';
import { useTableWs } from '../lib/tableWorkspace';
import { useApp, type OpenSession } from '../store';
import { RedisKeysView } from './RedisKeysView';

const session = {
  session_id: 'k1',
  server: { engine: 'redis', version: '7', current_database: 'db0' },
  capabilities: {},
  policy: {},
  config: { id: 'c1', name: 'Cache', engine: 'redis', environment: 'local', read_only: false, tls: { mode: 'disabled' } },
  schemas: ['db0'],
  keyspaces: [{ name: 'db0', index: 0, keys: 3, expires: 0, current: true }],
  objects: {},
  activeSchema: 'db0',
  healthy: true,
} as unknown as OpenSession;
const tab = { id: 'kt', kind: 'table' as const, title: 'db0', sessionId: 'k1', target: { schema: 'db0', table: '*' } };

beforeEach(() => {
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, bottom: 600, right: 800, width: 800, height: 600, toJSON: () => ({}) } as DOMRect);
  useApp.setState({ sessions: { k1: session }, activeSession: 'k1', tabs: [tab], activeTab: 'kt', settings: {} });
  useTableWs.setState({ tabs: {} });
  vi.mocked(api.kvScanKeys).mockReset();
  vi.mocked(api.kvReadValue).mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

describe('key grid paging', () => {
  it('pages with scan positions: Next continues at `next`, Previous reuses the cached start, a new pattern restarts', async () => {
    vi.mocked(api.kvScanKeys).mockImplementation(async (_s, _db, pattern, from) =>
      from === 0 ? { keys: [keyRow('a'), keyRow('b')], next: 7, done: false, total: pattern === '*' ? 3 : null } : { keys: [keyRow('c')], next: 9, done: true, total: 3 },
    );
    render(<RedisKeysView tab={tab} />);
    await flush();
    expect(api.kvScanKeys).toHaveBeenLastCalledWith('k1', 'db0', '*', 0, 200, true);
    expect(screen.getByText(/~3 keys/)).toBeTruthy();
    expect(screen.getAllByRole('gridcell').some((c) => c.textContent === 'v-a')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await flush();
    expect(api.kvScanKeys).toHaveBeenLastCalledWith('k1', 'db0', '*', 7, 200, false);
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await flush();
    expect(api.kvScanKeys).toHaveBeenLastCalledWith('k1', 'db0', '*', 0, 200, false);

    const input = within(screen.getByRole('search')).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'user:*' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(api.kvScanKeys).toHaveBeenLastCalledWith('k1', 'db0', 'user:*', 0, 200, true);
    expect(screen.getByText(/7\+ matching keys so far/)).toBeTruthy();
  });

  it('opens a literal key with its value; edits are staged and committed through the policy', async () => {
    vi.mocked(api.kvScanKeys).mockResolvedValue({ keys: [keyRow('h', 'hash', 2)], next: 1, done: true, total: null });
    vi.mocked(api.kvReadValue).mockResolvedValue({
      key: 'h', kind: 'hash', ttl: -1, size: 90, length: 2, columns: ['field', 'value'],
      rows: [[{ t: 'text', v: 'f1' }, { t: 'text', v: 'x' }], [{ t: 'text', v: 'f2' }, { t: 'text', v: '{"a":1}' }]],
      text: null, next: 'cursor-2',
    });
    vi.mocked(api.kvPreviewEdits).mockResolvedValue({ statements: ['SELECT 0', 'HDEL h f1'], decision: { decision: 'allow' } });
    vi.mocked(api.kvApplyEdits).mockResolvedValue({ applied: 1, rows_affected: 1, conflicts: [], committed: true });
    const t2 = { ...tab, id: 'kt2', title: 'h', target: { schema: 'db0', table: 'h' } };
    render(<RedisKeysView tab={t2} />);
    await flush();
    await flush();
    // A literal pattern selects its key and opens the value panel.
    const panel = screen.getByRole('complementary', { name: 'Key value' });
    expect(api.kvReadValue).toHaveBeenCalledWith('k1', 'db0', 'h', { cursor: '', count: 200 });
    expect(within(panel).getByText('f2')).toBeTruthy();

    // Load more continues from the returned cursor.
    fireEvent.click(within(panel).getByRole('button', { name: /Load more/ }));
    await flush();
    expect(api.kvReadValue).toHaveBeenLastCalledWith('k1', 'db0', 'h', { cursor: 'cursor-2', count: 200 });

    fireEvent.click(within(panel).getAllByRole('button', { name: 'Remove: f1' })[0]);
    await flush();
    expect(useTableWs.getState().tabs.kt2.pending).toBe(1);
    // Preview through the pending-changes actions: plain commands, no SQL terminators.
    const actions = useTableWs.getState().tabs.kt2.actions!;
    expect(actions.plain).toBe(true);
    expect(await actions.statements()).toEqual(['SELECT 0', 'HDEL h f1']);
    expect(api.kvPreviewEdits).toHaveBeenLastCalledWith('k1', 'db0', [{ op: 'hash_delete', key: 'h', field: 'f1' }]);
    await act(async () => {
      await actions.commit();
    });
    expect(api.kvApplyEdits).toHaveBeenCalledWith('k1', 'db0', [{ op: 'hash_delete', key: 'h', field: 'f1' }], null, undefined);
    expect(useTableWs.getState().tabs.kt2.pending).toBe(0);
  });

  it('read-only connections show no edit controls', async () => {
    useApp.setState({ sessions: { k1: { ...session, config: { ...session.config, read_only: true } } } });
    vi.mocked(api.kvScanKeys).mockResolvedValue({ keys: [keyRow('s')], next: 1, done: true, total: 1 });
    vi.mocked(api.kvReadValue).mockResolvedValue({ key: 's', kind: 'string', ttl: 5, size: 1, length: 7, columns: [], rows: [], text: '{"a":1}', next: null });
    render(<RedisKeysView tab={{ ...tab, id: 'kt3', target: { schema: 'db0', table: 's' } }} />);
    await flush();
    await flush();
    expect(screen.queryByRole('button', { name: 'New string key' })).toBeNull();
    const panel = screen.getByRole('complementary', { name: 'Key value' });
    expect(within(panel).getByText(/Read-only connection/)).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Delete key' })).toBeNull();
    // JSON strings are pretty-printed.
    expect(within(panel).getByLabelText('Key value').textContent).toBe('{\n  "a": 1\n}');
  });
});

describe('KeyPatternBar', () => {
  it('applies on Enter, Clear resets to *, Escape restores', () => {
    const onApply = vi.fn();
    render(<KeyPatternBar value="app:*" onApply={onApply} />);
    const input = screen.getByRole('textbox');
    expect(screen.getByText('Key pattern')).toBeTruthy();
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onApply).toHaveBeenLastCalledWith('*');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((input as HTMLInputElement).value).toBe('app:*');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onApply).toHaveBeenLastCalledWith('*');
  });
});
