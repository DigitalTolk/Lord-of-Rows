import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

vi.mock('../lib/ipc', () => ({ api: {}, IpcError: class extends Error {} }));

import { DataGrid, type CellEdit } from './DataGrid';
import type { ColumnMeta, Value } from '../lib/types';

const columns: ColumnMeta[] = [
  { name: 'id', type_name: 'int8' },
  { name: 'name', type_name: 'text' },
  { name: 'customer_id', type_name: 'int4' },
];
const rows: Value[][] = [
  [{ t: 'big_int', v: '9007199254740993' }, { t: 'text', v: "O'Brien" }, { t: 'int', v: 1 }],
  [{ t: 'int', v: 2 }, { t: 'null' }, { t: 'int', v: 2 }],
];

let clip = '';
beforeEach(() => {
  clip = '';
  // jsdom has no layout: give the virtualizer a viewport so rows render.
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, bottom: 600, right: 800, width: 800, height: 600, toJSON: () => ({}) } as DOMRect);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async (s: string) => void (clip = s)), readText: vi.fn(async () => clip) } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const cell = (text: string) => screen.getAllByRole('gridcell').find((c) => c.textContent?.startsWith(text))!;
const item = (label: string) => screen.getAllByRole('menuitem').find((m) => m.textContent?.startsWith(label))!;

function setup(extra: Partial<Parameters<typeof DataGrid>[0]> = {}) {
  const edits: CellEdit[][] = [];
  const props = {
    columns,
    rows,
    editable: true,
    engine: 'postgres' as const,
    table: { schema: 'shop', table: 'orders' },
    keyColumns: ['id'],
    foreignKeys: [{ name: 'fk', columns: ['customer_id'], ref_table: 'customers', ref_columns: ['id'] }],
    onEditMany: (e: CellEdit[]) => void edits.push(e),
    onDeleteRows: vi.fn(),
    onDuplicateRows: vi.fn(),
    onQuickFilter: vi.fn(),
    onOpenForeignKey: vi.fn(),
    onRefresh: vi.fn(),
    ...extra,
  };
  render(<DataGrid {...props} />);
  return { props, edits };
}

describe('DataGrid context menu', () => {
  it('copies rows as SQL INSERT with exact big integers and escaped strings', async () => {
    setup();
    fireEvent.contextMenu(cell("O'Brien"));
    expect(screen.getByRole('menu', { name: 'Cell actions' })).toBeTruthy();
    fireEvent.mouseEnter(item('Copy Rows As'));
    await act(async () => {
      fireEvent.click(item('SQL INSERT'));
    });
    expect(clip).toBe(`INSERT INTO "shop"."orders" ("id", "name", "customer_id") VALUES (9007199254740993, 'O''Brien', 1);`);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Set Value ▸ NULL stages an edit for every selected cell', () => {
    const { edits } = setup();
    fireEvent.mouseDown(cell("O'Brien"), { button: 0 });
    fireEvent.mouseDown(cell('NULL'), { button: 0, shiftKey: true });
    fireEvent.contextMenu(cell("O'Brien"));
    fireEvent.mouseEnter(item('Set Value'));
    fireEvent.click(screen.getAllByRole('menuitem').find((m) => m.textContent === 'NULL')!);
    expect(edits).toEqual([[{ row: 0, col: 'name', value: { t: 'null' } }, { row: 1, col: 'name', value: { t: 'null' } }]]);
  });

  it('is keyboard navigable: arrows, submenu with →, Escape closes', () => {
    setup();
    fireEvent.contextMenu(cell("O'Brien"));
    const menu = screen.getByRole('menu', { name: 'Cell actions' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toMatch(/^Quick Look Editor/);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toMatch(/^Set Value/);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    expect(document.activeElement?.textContent).toBe('NULL');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Quick Filter passes a typed condition to the adapter', () => {
    const { props } = setup();
    fireEvent.contextMenu(cell("O'Brien"));
    fireEvent.mouseEnter(item('Quick Filter'));
    fireEvent.click(item("name = 'O'Brien'"));
    expect(props.onQuickFilter).toHaveBeenCalledWith({ column: 'name', op: 'eq', value: { t: 'text', v: "O'Brien" } });
  });

  it('Delete key stages deletion of the selected rows; Cmd/Ctrl+D duplicates', () => {
    const { props } = setup();
    fireEvent.mouseDown(cell("O'Brien"), { button: 0 });
    const grid = screen.getByRole('grid');
    fireEvent.keyDown(grid, { key: 'Backspace', code: 'Backspace' });
    expect(props.onDeleteRows).toHaveBeenCalledWith([0]);
    fireEvent.keyDown(grid, { key: 'd', code: 'KeyD', ctrlKey: true, metaKey: true });
    expect(props.onDuplicateRows).toHaveBeenCalledWith([0]);
  });

  it('hides editing items when the grid is read-only (query results)', () => {
    setup({ editable: false, onDeleteRows: undefined, onDuplicateRows: undefined, onQuickFilter: undefined, keyColumns: [] });
    fireEvent.contextMenu(cell("O'Brien"));
    const labels = screen.getAllByRole('menuitem').map((m) => m.textContent ?? '');
    expect(labels.some((l) => l.startsWith('Set Value') || l.startsWith('Paste') || l.startsWith('Delete'))).toBe(false);
    expect(labels.some((l) => l.startsWith('Copy Rows'))).toBe(true);
  });

  it('foreign-key cells link to the referenced row', () => {
    const { props } = setup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open the referenced row in customers' })[0]);
    expect(props.onOpenForeignKey).toHaveBeenCalledWith(expect.objectContaining({ ref_table: 'customers' }), [{ t: 'int', v: 1 }]);
  });
});
