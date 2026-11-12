import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';

vi.mock('../lib/ipc', () => ({
  api: {
    saveConnection: vi.fn(async (c) => ({ ...c, id: '11111111-1111-1111-1111-111111111111' })),
    listConnections: vi.fn(async () => []),
    testConnection: vi.fn(async () => ({ server: { version: 'PostgreSQL 16.4', engine: 'postgres' }, latency_ms: 3 })),
    parseConnectionUrl: vi.fn(),
    pickCertPath: vi.fn(async (kind: string) => `/home/me/certs/${kind}-file.pem`),
    openPrivacySettings: vi.fn(async () => undefined),
  },
  IpcError: class extends Error {},
}));

import { useApp } from '../store';
import { ConnectionDialog } from './ConnectionDialog';
import { api } from '../lib/ipc';

describe('ConnectionDialog', () => {
  afterEach(cleanup);
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

  const openPg = () => {
    render(<ConnectionDialog />);
    fireEvent.click(screen.getByText('PostgreSQL'));
  };

  it('shows the five SSL modes, PREFERRED by default', () => {
    openPg();
    expect(screen.getByText('PostgreSQL Connection')).toBeTruthy();
    const select = screen.getByLabelText('SSL mode') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['PREFERRED', 'DISABLED', 'REQUIRED', 'VERIFY-CA', 'VERIFY-IDENTITY']);
    expect(select.value).toBe('preferred');
    fireEvent.change(select, { target: { value: 'verify_ca' } });
    expect(screen.getByText(/signed by a trusted CA/)).toBeTruthy();
  });

  it('tagging a remote connection Production raises PREFERRED to REQUIRED, but keeps a stronger mode', () => {
    openPg();
    fireEvent.change(screen.getByPlaceholderText('127.0.0.1'), { target: { value: 'db.example.com' } });
    const ssl = screen.getByLabelText('SSL mode') as HTMLSelectElement;
    const tag = screen.getByLabelText('Tag') as HTMLSelectElement;
    fireEvent.change(tag, { target: { value: 'production' } });
    expect(ssl.value).toBe('required');
    expect(screen.getByText(/because this connection is tagged Production/)).toBeTruthy();
    expect(screen.queryByText(/need REQUIRED or stronger/)).toBeNull();

    fireEvent.change(tag, { target: { value: 'staging' } });
    fireEvent.change(ssl, { target: { value: 'verify_identity' } });
    fireEvent.change(tag, { target: { value: 'production' } });
    expect(ssl.value).toBe('verify_identity');
    expect(screen.queryByText(/because this connection is tagged Production/)).toBeNull();
  });

  it('a local Production connection keeps PREFERRED', () => {
    openPg();
    fireEvent.change(screen.getByPlaceholderText('127.0.0.1'), { target: { value: 'localhost' } });
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'production' } });
    expect((screen.getByLabelText('SSL mode') as HTMLSelectElement).value).toBe('preferred');
  });

  it('SSL key buttons store the picked path and the clear button resets them', async () => {
    openPg();
    await act(async () => {
      fireEvent.click(screen.getByText('CA Cert…'));
    });
    expect(api.pickCertPath).toHaveBeenCalledWith('ca');
    expect(screen.getByText('ca-file.pem')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Clear SSL keys'));
    expect(screen.queryByText('ca-file.pem')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Key…'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    const saved = vi.mocked(api.saveConnection).mock.calls.at(-1)![0];
    expect(saved.tls).toMatchObject({ mode: 'preferred', client_key_path: '/home/me/certs/key-file.pem', ca_cert_path: null });
  });

  it('Over SSH reveals the SSH fields', () => {
    openPg();
    expect(screen.queryByLabelText('SSH host')).toBeNull();
    const toggle = screen.getByText('Over SSH').closest('button')!;
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('SSH host')).toBeTruthy();
    expect(screen.getByLabelText('SSH user')).toBeTruthy();
    expect(screen.getByLabelText('SSH password')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByLabelText('SSH host')).toBeNull();
  });

  it('Bootstrap commands edits init_sql', async () => {
    openPg();
    fireEvent.click(screen.getByText(/Bootstrap commands/));
    fireEvent.change(screen.getByLabelText('Bootstrap SQL'), { target: { value: 'SET search_path = app' } });
    fireEvent.click(screen.getByText('Done'));
    expect(screen.queryByLabelText('Bootstrap SQL')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(vi.mocked(api.saveConnection).mock.calls.at(-1)![0].init_sql).toBe('SET search_path = app');
  });

  it('Ask every time does not store the password', async () => {
    openPg();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('Password storage'), { target: { value: 'ask' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    const call = vi.mocked(api.saveConnection).mock.calls.at(-1)!;
    expect(call[1]).toBe('');
    expect(call[2]).toBe(false);
  });

  it('SQLite shows a file path and no SSL / SSH', () => {
    render(<ConnectionDialog />);
    fireEvent.click(screen.getByText('SQLite'));
    expect(screen.getByPlaceholderText('/path/to/database.sqlite')).toBeTruthy();
    expect(screen.queryByLabelText('SSL mode')).toBeNull();
    expect(screen.queryByText('Over SSH')).toBeNull();
  });

  it('offers to open Local Network settings on macOS for Local Network errors', async () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    try {
      vi.mocked(api.testConnection).mockRejectedValueOnce(new Error('No route to host. Allow it in System Settings → Privacy & Security → Local Network.'));
      openPg();
      await act(async () => {
        fireEvent.click(screen.getByText('Test'));
      });
      const btn = screen.getByText('Open Local Network Settings');
      await act(async () => {
        fireEvent.click(btn);
      });
      expect(api.openPrivacySettings).toHaveBeenCalledWith('local_network');
      // Not offered for other errors / platforms.
      Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
      vi.mocked(api.testConnection).mockRejectedValueOnce(new Error('No route to host. Allow it in System Settings → Privacy & Security → Local Network.'));
      await act(async () => {
        fireEvent.click(screen.getByText('Test'));
      });
      expect(screen.queryByText('Open Local Network Settings')).toBeNull();
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
      else delete (navigator as { platform?: string }).platform;
    }
  });

  it('unsupported engines are disabled', () => {
    render(<ConnectionDialog />);
    expect((screen.getByText('Oracle').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
