import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import type { ConnImportPreview, ConnImportRow } from '../lib/types';

const row = (key: string, name: string, extra: Partial<ConnImportRow> = {}): ConnImportRow => ({
  key,
  name,
  source_engine: 'PostgreSQL',
  engine: 'postgres',
  host: 'db.example.com',
  port: 5432,
  database: 'app',
  username: 'app',
  environment: 'production',
  group: 'Shop',
  ssh: false,
  color: null,
  status: 'ready',
  reason: null,
  notes: [],
  password: 'keychain',
  ...extra,
});

const PREVIEW: ConnImportPreview = {
  preview_id: 'p1',
  source: 'table_plus',
  label: 'TablePlus',
  passwords_supported: true,
  rows: [
    row('a', 'Shop prod'),
    row('b', 'Orders', { status: 'exists', environment: 'staging', ssh: true }),
    row('c', 'Warehouse', { status: 'unsupported', engine: 'sql_server', source_engine: 'Microsoft SQL Server' }),
    row('d', 'Broken', { status: 'invalid', reason: 'host is required' }),
  ],
};

const api = vi.hoisted(() => ({
  importConnectionsDetect: vi.fn(async () => [{ source: 'table_plus', label: 'TablePlus', count: 14, error: null }]),
  importConnectionsPreview: vi.fn(async (...args: unknown[]) => {
    void args;
    return PREVIEW;
  }),
  importConnectionsApply: vi.fn(async (...args: unknown[]) => {
    void args;
    return { imported: [{ key: 'a', id: 'n1' }], failed: [], passwords_imported: 1, passwords_deferred: 0, password_errors: [], groups_created: 1 };
  }),
  pickFile: vi.fn(async () => null),
  listConnections: vi.fn(async () => []),
  listConnectionGroups: vi.fn(async () => []),
}));
vi.mock('../lib/ipc', () => ({ api, IpcError: class extends Error {} }));

import { ImportConnectionsHost, openImportDialog } from './ImportConnectionsDialog';

async function show() {
  render(<ImportConnectionsHost />);
  await act(async () => {
    openImportDialog();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  openImportDialog(false);
});

describe('ImportConnectionsDialog', () => {
  it('lists detected sources with counts and previews the chosen one', async () => {
    await show();
    const dialog = screen.getByRole('dialog', { name: 'Import connections' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /TablePlus: 14 connections found/ }));
    });
    expect(api.importConnectionsPreview).toHaveBeenCalledWith({ kind: 'detected', source: 'table_plus' });
    const box = (name: string) => screen.getByRole('checkbox', { name: `Import ${name}` }) as HTMLInputElement;
    expect(box('Shop prod').checked).toBe(true);
    expect(box('Orders').checked).toBe(false); // already exists: unchecked by default
    expect(box('Warehouse').disabled).toBe(true);
    expect(box('Broken').disabled).toBe(true);
    expect(screen.getByText('Already exists')).toBeTruthy();
    expect(screen.getByText('Will skip: unsupported engine SQL Server')).toBeTruthy();
    expect(screen.getByText('Will skip: host is required')).toBeTruthy();
    expect(screen.getAllByText('db.example.com:5432 : app', { selector: 'td' }).length).toBe(4);

    const pw = screen.getByRole('checkbox', { name: /Bring saved passwords from the macOS Keychain/ }) as HTMLInputElement;
    expect(pw.checked).toBe(true); // on by default: nothing is read until first connect
    fireEvent.click(box('Orders'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import 2 connections' }));
    });
    expect(api.importConnectionsApply).toHaveBeenCalledWith('p1', ['a', 'b'], { keep_groups: true, keep_environment: true, import_passwords: true });
    expect(screen.getByText('Imported 1 connection')).toBeTruthy();
    expect(screen.getByText('Imported 1 saved password')).toBeTruthy();
  });

  it('select all toggles only importable rows', async () => {
    await show();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /TablePlus/ }));
    });
    const all = screen.getByRole('checkbox', { name: 'Select all' }) as HTMLInputElement;
    fireEvent.click(all);
    expect(screen.getByRole('button', { name: 'Import 2 connections' })).toBeTruthy();
    fireEvent.click(all);
    expect((screen.getByRole('button', { name: 'Import 0 connections' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('pasted URLs are sent as a URL list', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Paste connection URLs' }));
    fireEvent.change(screen.getByLabelText('Connection URLs, one per line'), { target: { value: 'postgres://u@db.example.com/app' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    });
    expect(api.importConnectionsPreview).toHaveBeenCalledWith({ kind: 'urls', text: 'postgres://u@db.example.com/app' });
  });
});
