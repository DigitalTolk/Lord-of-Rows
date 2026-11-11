import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <pre data-testid="monaco">{value}</pre> }));
vi.mock('../lib/monaco', () => ({ useEditorTheme: () => 'vs' }));

import { emptyStaged, pendingCount, type StagedState } from '../lib/changes';
import { useTableWs } from '../lib/tableWorkspace';
import type { ColumnMeta, Value } from '../lib/types';
import { useApp, type OpenSession } from '../store';
import { PendingChangesBar } from './PendingChangesBar';
import { RowDetailPanel } from './RowDetailPanel';
import { pillWarning, serverLabel, tlsLabel } from './StatusPill';
import { selectionStatus } from './TableBottomBar';

afterEach(cleanup);

const cols: ColumnMeta[] = [
  { name: 'id', type_name: 'int4' },
  { name: 'name', type_name: 'varchar' },
];
const rows: Value[][] = [
  [{ t: 'int', v: 1 }, { t: 'text', v: 'Ada' }],
  [{ t: 'int', v: 2 }, { t: 'null' }],
];

describe('PendingChangesBar', () => {
  beforeEach(() => {
    useApp.setState({ tabs: [{ id: 'tab1', kind: 'table', title: 't', sessionId: 's1', target: { table: 't' } }], activeTab: 'tab1', activeSession: 's1' });
    useTableWs.setState({ tabs: {} });
  });

  it('is disabled without pending changes and shows a badge with the count', () => {
    render(<PendingChangesBar />);
    expect((screen.getByLabelText('Commit pending changes') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Discard pending changes') as HTMLButtonElement).disabled).toBe(true);
    const actions = { discard: vi.fn(), statements: vi.fn(async () => ['UPDATE `db`.`t` SET `name` = \'x\' WHERE `id` = 4']), commit: vi.fn(async () => {}), openInQueryTab: vi.fn() };
    act(() => useTableWs.getState().patch('tab1', { pending: 3, actions }));
    expect((screen.getByLabelText('Commit pending changes') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByLabelText('3 pending').textContent).toBe('3');
  });

  it('previews the exact statements, opens them in a tab, and commits via the table view', async () => {
    const actions = { discard: vi.fn(), statements: vi.fn(async () => ['UPDATE `db`.`t` SET `name` = \'x\' WHERE `id` = 4']), commit: vi.fn(async () => {}), openInQueryTab: vi.fn() };
    useTableWs.getState().patch('tab1', { pending: 1, actions });
    render(<PendingChangesBar />);
    await act(async () => fireEvent.click(screen.getByLabelText('Preview pending changes')));
    expect(screen.getByTestId('monaco').textContent).toBe("UPDATE `db`.`t` SET `name` = 'x' WHERE `id` = 4;");
    fireEvent.click(screen.getByText('Open in Window'));
    expect(actions.openInQueryTab).toHaveBeenCalledWith("UPDATE `db`.`t` SET `name` = 'x' WHERE `id` = 4;");
    await act(async () => fireEvent.click(screen.getByLabelText('Commit pending changes')));
    expect(actions.commit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Discard pending changes'));
    expect(actions.discard).toHaveBeenCalled();
  });

  it('renders nothing for non-table tabs', () => {
    useApp.setState({ tabs: [{ id: 'q', kind: 'query', title: 'Q', sessionId: 's1' }], activeTab: 'q' });
    const { container } = render(<PendingChangesBar />);
    expect(container.childElementCount).toBe(0);
  });
});

describe('RowDetailPanel', () => {
  it('editing a field stages a cell edit; multiple rows show "multiple values"', () => {
    let staged: StagedState = emptyStaged();
    const onStage = vi.fn((s: StagedState) => (staged = s));
    const { rerender } = render(<RowDetailPanel columns={cols} rows={rows} staged={staged} selection={[0]} editable canEditExisting onStage={onStage} onClose={() => {}} />);
    screen.getByText('var_string');
    const input = screen.getByLabelText('name') as HTMLInputElement;
    expect(input.value).toBe('Ada');
    fireEvent.change(input, { target: { value: 'Grace' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onStage).toHaveBeenCalledTimes(1);
    expect(staged.edits[0]).toEqual({ name: { t: 'text', v: 'Grace' } });
    expect(pendingCount(staged)).toBe(1);
    rerender(<RowDetailPanel columns={cols} rows={rows} staged={staged} selection={[0, 1]} editable canEditExisting onStage={onStage} onClose={() => {}} />);
    expect((screen.getByLabelText('name') as HTMLInputElement).placeholder).toBe('multiple values');
    screen.getByText('2 rows selected');
  });

  it('filters fields by the search box and shows NULL as a placeholder', () => {
    render(<RowDetailPanel columns={cols} rows={rows} staged={emptyStaged()} selection={[1]} editable canEditExisting onStage={() => {}} onClose={() => {}} />);
    expect((screen.getByLabelText('name') as HTMLInputElement).placeholder).toBe('NULL');
    fireEvent.change(screen.getByLabelText('Search for field'), { target: { value: 'nam' } });
    expect(screen.queryByLabelText('id')).toBeNull();
  });

  it('is read-only without a primary key for loaded rows', () => {
    render(<RowDetailPanel columns={cols} rows={rows} staged={emptyStaged()} selection={[0]} editable canEditExisting={false} onStage={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText('name').hasAttribute('readonly')).toBe(true);
  });
});

describe('status pill and bottom bar helpers', () => {
  const t = (k: string) => ({ 'tableWs.tls': 'TLS', 'tableWs.noTls': 'no TLS', 'tableWs.warnProduction': 'prod', 'tableWs.warnPlaintext': 'plain' })[k] ?? k;
  const sess = (p: Partial<OpenSession['config']>, tls?: string | null) =>
    ({ server: { engine: 'my_sql', version: '8.4.7', tls_version: tls }, config: { engine: 'my_sql', environment: 'local', host: 'localhost', tls: { mode: 'verify_full' }, ...p } }) as unknown as OpenSession;

  it('labels server and TLS', () => {
    expect(serverLabel('my_sql', '8.4.7')).toBe('MySQL 8.4.7');
    expect(serverLabel('maria_db', '11.4.2-MariaDB-ubu2404')).toBe('MariaDB 11.4.2');
    expect(serverLabel('postgres', 'PostgreSQL 16.4 on aarch64-unknown-linux-gnu, compiled by gcc')).toBe('PostgreSQL 16.4');
    expect(tlsLabel(sess({}, 'TLSv1.3'), t)).toBe('TLSv1.3');
    expect(tlsLabel(sess({}, ''), t)).toBe('no TLS');
    expect(tlsLabel(sess({}, null), t)).toBe('TLS');
    expect(tlsLabel(sess({ tls: { mode: 'disable' } }, null), t)).toBe('no TLS');
    expect(tlsLabel(sess({ engine: 'sqlite' }), t)).toBeNull();
  });

  it('warns for production and plaintext remote connections', () => {
    expect(pillWarning(sess({ environment: 'production' }, 'TLSv1.3'), t)).toBe('prod');
    expect(pillWarning(sess({ host: 'db.example.com' }, ''), t)).toBe('plain');
    expect(pillWarning(sess({ host: '127.0.0.1' }, ''), t)).toBeNull();
    expect(pillWarning(sess({ host: 'db.example.com' }, 'TLSv1.2'), t)).toBeNull();
  });

  it('marks estimated counts with ~', () => {
    expect(selectionStatus(1, { n: 859591, exact: false }, 500)).toEqual({ sel: 1, total: '~859,591' });
    expect(selectionStatus(0, { n: 500, exact: true }, 500)).toEqual({ sel: 0, total: '500' });
    expect(selectionStatus(2, null, 300).total).toBe('300');
  });
});
