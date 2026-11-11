import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '../i18n';
import type { OpenSession } from '../store';
import { StatusPill } from './StatusPill';

const s = {
  healthy: true,
  activeSchema: 'shop',
  server: { engine: 'my_sql', version: '8.4.7', tls_version: 'TLSv1.3', current_database: 'shop' },
  config: { engine: 'my_sql', environment: 'local', name: 'LOCAL', host: 'db', tls: { mode: 'required' }, read_only: false, color: null },
} as unknown as OpenSession;

afterEach(cleanup);

describe('status pill refresh state', () => {
  it('shows connection details normally', () => {
    render(<StatusPill s={s} table="orders" expanded={false} onClick={() => undefined} />);
    const pill = screen.getByTestId('status-pill');
    expect(pill.textContent).toContain('MySQL 8.4.7');
    expect(pill.textContent).toContain('orders');
    expect(pill.getAttribute('aria-busy')).not.toBe('true');
    expect(pill.querySelector('.pill-shimmer')).toBeNull();
    expect(pill.querySelector('.pill-progress')).toBeNull();
  });

  it('shows "Refreshing…" with the shimmer while refreshing', () => {
    render(<StatusPill s={s} table="orders" refreshing expanded={false} onClick={() => undefined} />);
    const pill = screen.getByTestId('status-pill');
    expect(pill.textContent).toContain('LOCAL');
    expect(pill.textContent).toContain('Refreshing');
    expect(pill.querySelector('.pill-spinner')).not.toBeNull();
    expect(pill.querySelector('.pill-progress')).not.toBeNull();
    expect(pill.textContent).not.toContain('orders');
    expect(pill.getAttribute('aria-busy')).toBe('true');
    expect(pill.querySelector('.pill-shimmer')).not.toBeNull();
  });
});
