import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

const api = vi.hoisted(() => ({
  listSchemas: vi.fn(async () => ['information_schema', 'shop', 'mysql', 'app', 'sys']),
  listDatabases: vi.fn(async () => [] as string[]),
  useSchema: vi.fn(async () => {}),
  listObjects: vi.fn(async () => []),
  createDatabaseSql: vi.fn(async (_s: string, n: string) => `CREATE DATABASE \`${n}\`;`),
  evaluateSql: vi.fn(async () => ({ statements: [], decision: { decision: 'allow' } })),
  runMigration: vi.fn(async () => ({ results: [], duration_ms: 1 })),
}));
vi.mock('../lib/ipc', () => ({ api, IpcError: class extends Error {} }));

import { useApp, type OpenSession } from '../store';
import { useOpenedSchemas } from './ConnectionRail';
import { OpenDatabaseHost, openDatabasePicker } from './OpenDatabaseDialog';
import { AskHost } from './ask';

const session = (engine: string, extra: Partial<OpenSession> = {}) =>
  ({
    session_id: 's1',
    server: { engine, version: '8.4', current_database: 'app' },
    capabilities: { schemas: true },
    policy: {},
    config: { id: 'c1', name: 'Local', engine, environment: 'local', tls: { mode: 'disabled' }, database: 'app' },
    schemas: ['app'],
    objects: { app: [] },
    activeSchema: 'app',
    healthy: true,
    ...extra,
  }) as unknown as OpenSession;

const names = () => within(screen.getByRole('listbox', { name: 'Available databases' })).queryAllByRole('option').map((o) => o.getAttribute('data-name'));
const activeName = () => {
  const input = screen.getByRole('combobox', { name: 'Search for database…' });
  return document.getElementById(input.getAttribute('aria-activedescendant') ?? '')?.getAttribute('data-name');
};

async function show(s: OpenSession) {
  useApp.setState({ sessions: { s1: s }, activeSession: 's1', tabs: [] });
  render(<><OpenDatabaseHost /><AskHost /></>);
  await act(async () => {
    openDatabasePicker();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  useOpenedSchemas.setState({ bySession: {} });
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  openDatabasePicker(false);
});

describe('OpenDatabaseDialog', () => {
  it('lists user databases first and system ones last, marks and highlights the current one', async () => {
    await show(session('my_sql'));
    expect(api.listSchemas).toHaveBeenCalledWith('s1');
    expect(names()).toEqual(['shop', 'app', 'information_schema', 'mysql', 'sys']);
    expect(screen.getByRole('group', { name: 'System' })).toBeTruthy();
    expect(activeName()).toBe('app');
    expect(screen.getByText('current')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Search for database…' }));
    // The refreshed list is written back to the session (sidebar dropdown).
    expect(useApp.getState().sessions.s1.schemas).toHaveLength(5);
  });

  it('typing filters; arrows move; Enter opens and adds it to the schema rail', async () => {
    await show(session('my_sql'));
    const input = screen.getByRole('combobox', { name: 'Search for database…' });
    fireEvent.change(input, { target: { value: 'S' } });
    expect(names()).toEqual(['shop', 'information_schema', 'mysql', 'sys']);
    expect(activeName()).toBe('shop');
    fireEvent.change(input, { target: { value: 'p' } });
    expect(names()).toEqual(['shop', 'app']);
    // The current database stays highlighted while it matches.
    expect(activeName()).toBe('app');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeName()).toBe('shop');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeName()).toBe('shop');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeName()).toBe('app');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeName()).toBe('shop');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(api.useSchema).toHaveBeenCalledWith('s1', 'shop');
    expect(useApp.getState().sessions.s1.activeSchema).toBe('shop');
    expect(useOpenedSchemas.getState().bySession.s1).toContain('shop');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('double-click opens; Escape cancels', async () => {
    await show(session('my_sql'));
    await act(async () => {
      fireEvent.doubleClick(screen.getByRole('option', { name: /mysql/ }));
    });
    expect(useApp.getState().sessions.s1.activeSchema).toBe('mysql');
    await act(async () => {
      openDatabasePicker();
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search for database…' }), { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('New… builds the statement in Rust and runs it through the safety gate', async () => {
    await show(session('my_sql'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New…' }));
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'New database' }), { target: { value: ' sales ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.createDatabaseSql).toHaveBeenCalledWith('s1', 'sales');
    expect(api.evaluateSql).toHaveBeenCalledWith('s1', 'CREATE DATABASE `sales`;');
    expect(api.runMigration).toHaveBeenCalledWith('s1', 'CREATE DATABASE `sales`;', null, undefined);
    expect(api.listSchemas).toHaveBeenCalledTimes(2);
  });

  it('hides New… for engines without CREATE DATABASE/SCHEMA', async () => {
    await show(session('sqlite', { activeSchema: 'main' }));
    expect(screen.queryByRole('button', { name: 'New…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  });

  it('Postgres: lists other databases on the server in their own section', async () => {
    api.listSchemas.mockResolvedValueOnce(['public', 'pg_catalog', 'shop']);
    api.listDatabases.mockResolvedValueOnce(['app', 'postgres', 'analytics']);
    await show(session('postgres', { activeSchema: 'public' }));
    expect(names()).toEqual(['public', 'shop', 'pg_catalog', 'postgres', 'analytics']);
    expect(screen.getByRole('group', { name: 'Other databases on this server' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Schemas in app' })).toBeTruthy();
  });
});
