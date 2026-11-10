import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

vi.mock('../lib/ipc', () => ({
  api: {
    saveConnection: vi.fn(async (c) => ({ ...c, id: '11111111-1111-1111-1111-111111111111' })),
    listConnections: vi.fn(async () => []),
    testConnection: vi.fn(async () => ({ server: { version: 'PostgreSQL 16.4', engine: 'postgres' }, latency_ms: 3 })),
    parseConnectionUrl: vi.fn(),
  },
  IpcError: class extends Error {},
}));

import { useApp } from '../store';
import { ConnectionDialog } from './ConnectionDialog';
import { api } from '../lib/ipc';

describe('ConnectionDialog', () => {
  beforeEach(() => {
    useApp.setState({
      connectionDialog: {},
      connections: [],
      info: { version: '0.1.0', os: 'linux', arch: 'x86_64', secret_backend: 'test', supported_engines: ['postgres', 'sqlite'], all_engines: ['postgres', 'sqlite', 'oracle'] },
    });
  });

  it('picks an engine, keeps typed focus, and saves with an auto name', async () => {
    render(<ConnectionDialog />);
    fireEvent.click(screen.getByText('PostgreSQL'));
    expect(useApp.getState().connectionDialog).not.toBeNull();
    const host = screen.getByPlaceholderText('127.0.0.1') as HTMLInputElement;
    host.focus();
    fireEvent.change(host, { target: { value: 'postgres' } });
    // Typing must not move focus away (regression: focus trap re-ran every render).
    expect(document.activeElement).toBe(host);
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(api.saveConnection).toHaveBeenCalled();
    const saved = vi.mocked(api.saveConnection).mock.calls[0][0];
    expect(saved.name).toBe('PostgreSQL @ postgres');
    expect(saved.host).toBe('postgres');
  });

  it('unsupported engines are disabled', () => {
    render(<ConnectionDialog />);
    expect((screen.getByText('Oracle').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
