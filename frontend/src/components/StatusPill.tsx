import { useTranslation } from 'react-i18next';
import { readableTextOn } from '../lib/theme';
import type { Engine } from '../lib/types';
import type { OpenSession } from '../store';
import { Icon } from './icons';

const ENGINE_LABEL: Partial<Record<Engine, string>> = {
  postgres: 'PostgreSQL', my_sql: 'MySQL', maria_db: 'MariaDB', sqlite: 'SQLite', redis: 'Redis', cockroach_db: 'CockroachDB',
  sql_server: 'SQL Server', percona: 'Percona', single_store: 'SingleStore', yugabyte_db: 'YugabyteDB', redshift: 'Redshift',
  greenplum: 'Greenplum', duck_db: 'DuckDB', lib_sql: 'libSQL', turso: 'Turso', cloudflare_d1: 'D1',
};
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

/** "MySQL 8.4.7" from the engine and the server's version string. */
export function serverLabel(engine: Engine, version: string): string {
  const v = version.split(' on ')[0].split(',')[0].replace(/\s*\(.*\)/, '').trim();
  const name = ENGINE_LABEL[engine] ?? engine;
  if (!v) return name;
  if (/^[\d.]+/.test(v)) {
    // MariaDB reports "11.4.2-MariaDB-…"; keep the leading version only.
    const num = /^[\d.]+/.exec(v)![0];
    return `${/mariadb/i.test(v) ? 'MariaDB' : name} ${num}`;
  }
  return v;
}

/** TLS part of the pill: negotiated version when the driver reports it. */
export function tlsLabel(s: Pick<OpenSession, 'server' | 'config'>, t: (k: string) => string): string | null {
  if (s.config.engine === 'sqlite' || s.config.engine === 'duck_db') return null;
  const v = s.server.tls_version;
  if (v === '') return t('tableWs.noTls');
  if (v) return v;
  if (s.config.tls.mode === 'disabled') return t('tableWs.noTls');
  // 'preferred' may silently fall back to plaintext when the driver cannot report the outcome.
  return s.config.tls.mode === 'preferred' ? `${t('tableWs.tls')}?` : t('tableWs.tls');
}

/** Whether the session should carry a warning marker, and why. */
export function pillWarning(s: Pick<OpenSession, 'server' | 'config'>, t: (k: string) => string): string | null {
  if (s.config.environment === 'production') return t('tableWs.warnProduction');
  const remote = !!s.config.host && !LOOPBACK.test(s.config.host) && !s.config.ssh;
  const plaintext = s.server.tls_version === '' || (s.server.tls_version == null && s.config.tls.mode === 'disabled');
  if (remote && plaintext && s.config.engine !== 'sqlite') return t('tableWs.warnPlaintext');
  return null;
}

/**
 * Connection status pill for the top bar:
 * `LOCAL | MySQL 8.4.7 : TLSv1.3 : name : database : table`, on the connection's colour.
 */
export function StatusPill({ s, table, onClick, expanded, refreshing }: { s: OpenSession; table?: string | null; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; expanded: boolean; refreshing?: boolean }) {
  const { t } = useTranslation();
  const env = t(`env.${s.config.environment}`).toUpperCase();
  const db = s.server.current_database ?? s.config.database ?? null;
  const schema = s.activeSchema && s.activeSchema !== db ? s.activeSchema : null;
  const parts = [serverLabel(s.config.engine, s.server.version), tlsLabel(s, t), s.config.name, db, schema, table].filter((x): x is string => !!x);
  const warn = pillWarning(s, t);
  const color = s.config.color && /^#[0-9a-f]{6}$/i.test(s.config.color) ? s.config.color : null;
  const prod = s.config.environment === 'production';
  const style = color ? { background: color, color: readableTextOn(color), borderColor: 'transparent' } : undefined;
  const cls = color ? '' : prod ? 'bg-danger-solid text-on-solid border-transparent' : 'bg-raised text-fg border-border';
  return (
    <button
      onClick={onClick}
      aria-haspopup="menu"
      aria-expanded={expanded}
      title={[...parts, warn].filter(Boolean).join(' : ')}
      className={`relative flex h-7 max-w-[46vw] items-center gap-1.5 overflow-hidden rounded-md border px-2.5 text-[0.88rem] shadow-sm hover:brightness-95 ${cls}`}
      aria-busy={refreshing}
      style={style}
      data-testid="status-pill"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${s.healthy ? 'bg-ok' : 'bg-danger'} ring-1 ring-black/10`} role="img" aria-label={s.healthy ? t('status.healthyDot') : t('status.lostDot')} />
      <span className="shrink-0 font-semibold tracking-wide">{env}</span>
      <span className="shrink-0 opacity-60" aria-hidden>|</span>
      <span className="truncate" dir="auto" aria-live="polite">{refreshing ? t('status.refreshing') : parts.join(' : ')}</span>
      {refreshing && <span className="pill-shimmer pointer-events-none absolute inset-0" aria-hidden />}
      {s.config.read_only && <Icon name="lock" size={13} className="shrink-0" />}
      {warn && <Icon name="warning" size={14} className={`shrink-0 ${color || prod ? '' : 'text-warn'}`} aria-hidden={false} aria-label={warn} role="img" />}
    </button>
  );
}
