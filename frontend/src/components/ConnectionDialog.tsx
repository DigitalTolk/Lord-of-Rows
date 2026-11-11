import { Children, cloneElement, isValidElement, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import type { ConnectionConfig, Engine, EnvironmentKind, SshConfig, TlsConfig, TlsMode } from '../lib/types';
import { errMsg, useApp } from '../store';
import { withHostKeyTrust } from '../lib/hostkey';
import { EngineBadge } from './EngineBadge';
import { Icon } from './icons';
import { Dialog, Spinner } from './ui';

export const ENGINE_LABELS: Record<Engine, string> = {
  postgres: 'PostgreSQL', my_sql: 'MySQL', maria_db: 'MariaDB', sqlite: 'SQLite', sql_server: 'SQL Server', oracle: 'Oracle',
  cockroach_db: 'CockroachDB', redshift: 'Redshift', single_store: 'SingleStore', greenplum: 'Greenplum', vertica: 'Vertica',
  duck_db: 'DuckDB', lib_sql: 'libSQL', turso: 'Turso', yugabyte_db: 'YugabyteDB', percona: 'Percona', mongo_db: 'MongoDB',
  redis: 'Redis', cassandra: 'Cassandra', dynamo_db: 'DynamoDB', elasticsearch: 'Elasticsearch', click_house: 'ClickHouse',
  big_query: 'BigQuery', snowflake: 'Snowflake', cloudflare_d1: 'Cloudflare D1',
};

const ENVS: EnvironmentKind[] = ['local', 'development', 'testing', 'staging', 'production', 'custom'];
const COLORS = ['#0a70f5', '#1e9650', '#c47800', '#d72d2d', '#7c4dff', '#787880'];
const DEFAULT_PORT: Partial<Record<Engine, number>> = { postgres: 5432, my_sql: 3306, maria_db: 3306, percona: 3306, single_store: 3306, cockroach_db: 26257, yugabyte_db: 5433, redshift: 5439, greenplum: 5432, redis: 6379 };

/** The five standard SSL modes, in the order shown in the form. */
export const SSL_MODES: { value: TlsMode; label: string; hint: string }[] = [
  { value: 'preferred', label: 'PREFERRED', hint: 'Use TLS when the server supports it (certificate not verified); otherwise connect unencrypted.' },
  { value: 'disabled', label: 'DISABLED', hint: 'No TLS: credentials and data are sent unencrypted.' },
  { value: 'required', label: 'REQUIRED', hint: 'TLS is mandatory, but the server certificate is not verified.' },
  { value: 'verify_ca', label: 'VERIFY-CA', hint: 'TLS, and the server certificate must be signed by a trusted CA (hostname not checked).' },
  { value: 'verify_identity', label: 'VERIFY-IDENTITY', hint: 'TLS, trusted certificate, and the hostname must match it. Most secure.' },
];

/** Older saved configs (pre-5-mode) may still carry the legacy names. */
function normalizeTls(tls: TlsConfig): TlsConfig {
  const legacy: Record<string, TlsMode> = { disable: 'disabled', verify_full: 'verify_identity' };
  return { ...tls, mode: legacy[tls.mode as string] ?? tls.mode };
}

/**
 * Which field groups an engine's form shows. Engine-specific field sets
 * (e.g. cloud endpoints / regions / access keys) belong here as new flags or
 * a new `kind`, so the layout below stays generic.
 */
interface EngineFormSpec {
  /** 'file': a database file path instead of host/port/user/password. */
  /** 'cloud': endpoint URL / region / access keys (DynamoDB). */
  kind: 'network' | 'file' | 'cloud';
  socket: boolean;
  ssl: boolean;
  ssh: boolean;
  bootstrap: boolean;
  databaseLabel: string;
  databasePlaceholder: string;
  /** SSL mode for a new connection. */
  defaultSsl: TlsMode;
}

export function formSpec(engine: Engine): EngineFormSpec {
  const net: EngineFormSpec = { kind: 'network', socket: true, ssl: true, ssh: true, bootstrap: true, databaseLabel: 'Database', databasePlaceholder: 'optional', defaultSsl: 'preferred' };
  switch (engine) {
    case 'sqlite':
    case 'duck_db':
      return { ...net, kind: 'file', socket: false, ssl: false, ssh: false, bootstrap: true };
    case 'dynamo_db':
      // host = optional endpoint URL, database = region, username = access key id / profile:NAME, password = secret key.
      return { ...net, kind: 'cloud', socket: false, ssl: false, ssh: false, bootstrap: false, databaseLabel: 'Region', databasePlaceholder: 'us-east-1', defaultSsl: 'verify_identity' };
    case 'redis':
      // Most Redis servers have no TLS, and a plaintext Redis doesn't answer a TLS hello: PREFERRED
      // would wait for its probe timeout on every connect. TLS stays one click away.
      return { ...net, socket: false, bootstrap: false, databaseLabel: 'Database #', databasePlaceholder: '0', defaultSsl: 'disabled' };
    default:
      return net;
  }
}

export function blankConnection(engine: Engine = 'postgres'): ConnectionConfig {
  const spec = formSpec(engine);
  const file = spec.kind === 'file';
  return {
    id: '00000000-0000-0000-0000-000000000000',
    name: '',
    engine,
    host: file || spec.kind === 'cloud' ? null : '127.0.0.1',
    port: null,
    database: null,
    username: null,
    socket_path: null,
    tls: { mode: spec.defaultSsl },
    ssh: null,
    environment: 'local',
    read_only: false,
    color: null,
    group: null,
    tags: [],
    notes: null,
    favorite: false,
    connect_timeout_secs: 10,
    query_timeout_secs: null,
    init_sql: null,
  };
}

const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '');

/**
 * A label + control pair laid out on the parent grid (`display: contents`).
 * The `<label><span>text</span>…control…</label>` shape is what the E2E `fill()` helper finds;
 * form controls also get the label as `aria-label` (a wrapping label's text would
 * otherwise include a select's option texts).
 */
function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  const named = Children.map(children, (c) => {
    if (!isValidElement(c) || !['input', 'select', 'textarea'].includes(c.type as string)) return c;
    const el = c as ReactElement<{ 'aria-label'?: string }>;
    return el.props['aria-label'] ? el : cloneElement(el, { 'aria-label': label });
  });
  return (
    <label className="contents">
      <span className="justify-self-end text-right text-[0.9rem] text-muted">{label}</span>
      <span className={`flex min-w-0 items-center gap-2 ${wide ? 'col-span-3' : ''}`}>{named}</span>
    </label>
  );
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-border bg-panel p-3 ${className}`}>{children}</div>;
}

const GRID = 'grid grid-cols-[92px_minmax(0,1fr)_auto_minmax(0,170px)] items-center gap-x-2.5 gap-y-2';

function EnginePicker({ onPick }: { onPick: (e: Engine) => void }) {
  const { info } = useApp();
  const supported = new Set(info?.supported_engines ?? []);
  const all = info?.all_engines ?? [];
  const sorted = [...all].sort((a, b) => Number(supported.has(b)) - Number(supported.has(a)));
  return (
    <div>
      <p className="mb-3 text-muted">Choose a database type.</p>
      <div className="grid grid-cols-5 gap-2">
        {sorted.map((e) => {
          const ok = supported.has(e);
          return (
            <button
              key={e}
              disabled={!ok}
              onClick={() => onPick(e)}
              title={ok ? ENGINE_LABELS[e] : `${ENGINE_LABELS[e]}: driver not available yet`}
              className="group flex flex-col items-center gap-1.5 rounded-lg border border-transparent p-2.5 transition-colors hover:border-border hover:bg-panel disabled:cursor-not-allowed"
            >
              <EngineBadge engine={e} size={40} dim={!ok} />
              <span className={`text-[0.85rem] ${ok ? '' : 'text-muted/70'}`}>{ENGINE_LABELS[e]}</span>
              {!ok && <span className="-mt-1 text-[0.68rem] text-muted/70">coming soon</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Small modal for the statements run after connect (`init_sql`). Portalled so it is the topmost dialog. */
function BootstrapSheet({ value, onDone, onClose }: { value: string; onDone: (v: string) => void; onClose: () => void }) {
  const [text, setText] = useState(value);
  return createPortal(
    <Dialog
      title="Bootstrap commands"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onDone(text)}>Done</button>
        </>
      }
    >
      <p className="mb-2 text-[0.88rem] text-muted">Statements run once after every connect (e.g. <code className="font-mono">SET search_path = app</code>). They go through the same safety policy as your own SQL.</p>
      <textarea className="input font-mono" rows={6} aria-label="Bootstrap SQL" data-autofocus value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
    </Dialog>,
    document.body,
  );
}

function fileName(p: string) {
  return p.split(/[\\/]/).pop() || p;
}

export function ConnectionDialog() {
  const { t } = useTranslation();
  const { connectionDialog, connections, info, reloadConnections, toast, openSession } = useApp();
  const existing = connections.find((c) => c.config.id === (connectionDialog?.id ?? connectionDialog?.duplicateOf))?.config;
  const isNew = !connectionDialog?.id;
  const [cfg, setCfg] = useState<ConnectionConfig | null>(() => {
    if (!existing) return null; // show engine picker first
    const base = { ...existing, tls: normalizeTls(existing.tls) };
    if (connectionDialog?.duplicateOf) return { ...base, id: blankConnection().id, name: `${existing.name} copy` };
    return base;
  });
  const [password, setPassword] = useState('');
  const [pwMode, setPwMode] = useState<'keychain' | 'ask'>('keychain');
  const [sshPassword, setSshPassword] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');
  const [busy, setBusy] = useState<null | 'test' | 'save' | 'connect'>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [url, setUrl] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [bootstrap, setBootstrap] = useState(false);
  const [socketMode, setSocketMode] = useState(!!existing?.socket_path);
  const supported = useMemo(() => new Set(info?.supported_engines ?? []), [info]);
  const close = () => useApp.setState({ connectionDialog: null });

  if (!cfg) {
    return (
      <Dialog title={t('conn.new')} onClose={close} wide>
        <div className="mb-4 flex gap-2">
          <input className="input font-mono" placeholder="Paste a URL, e.g. postgresql://user:pass@host:5432/db" value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t('conn.importUrl')} />
          <button
            className="btn"
            disabled={!url.trim()}
            onClick={async () => {
              try {
                const p = await api.parseConnectionUrl(url.trim());
                setCfg({ ...p.config, id: blankConnection().id, tls: normalizeTls(p.config.tls) });
                setSocketMode(!!p.config.socket_path);
                if (p.password) setPassword(p.password);
                setStatus(null);
              } catch (e) {
                setStatus({ ok: false, text: errMsg(e) });
              }
            }}
          >
            {t('conn.importUrl')}
          </button>
        </div>
        {status && !status.ok && <p className="mb-2 text-danger">{status.text}</p>}
        <EnginePicker onPick={(e) => setCfg(blankConnection(e))} />
      </Dialog>
    );
  }

  const spec = formSpec(cfg.engine);
  const isFile = spec.kind === 'file';
  const isCloud = spec.kind === 'cloud';
  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => setCfg((c) => (c ? { ...c, [k]: v } : c));
  const setTls = (patch: Partial<TlsConfig>) => setCfg((c) => (c ? { ...c, tls: { ...c.tls, ...patch } } : c));
  const autoName = cfg.name.trim() || (isFile ? (cfg.database ?? '').split('/').pop() || ENGINE_LABELS[cfg.engine] : `${cfg.database || ENGINE_LABELS[cfg.engine]}${cfg.host ? ' @ ' + cfg.host : ''}`);
  const finalCfg = { ...cfg, name: autoName };
  const pw = password === '' ? null : password;
  const askEveryTime = pwMode === 'ask';
  const ssh = cfg.ssh;
  const remoteHost = !!cfg.host && !['localhost', '127.0.0.1', '::1'].includes(cfg.host) && !ssh;
  const mayBePlain = cfg.tls.mode === 'disabled' || cfg.tls.mode === 'preferred';
  // null = keep what is stored in the keychain
  const sshSecrets = { password: sshPassword === '' ? null : sshPassword, passphrase: sshPassphrase === '' ? null : sshPassphrase };
  const setSsh = (patch: Partial<SshConfig>) => set('ssh', ssh ? { ...ssh, ...patch } : null);
  const toggleSsh = () => set('ssh', ssh ? null : { host: '', port: 22, user: '', auth: 'password', private_key_path: null, jump_hosts: [], keepalive_secs: 30 });
  const sslHint = SSL_MODES.find((m) => m.value === cfg.tls.mode)?.hint;
  const hasKeys = !!(cfg.tls.client_key_path || cfg.tls.client_cert_path || cfg.tls.ca_cert_path);

  const pickCert = async (kind: 'key' | 'cert' | 'ca') => {
    try {
      const p = await api.pickCertPath(kind);
      if (p) setTls(kind === 'key' ? { client_key_path: p } : kind === 'cert' ? { client_cert_path: p } : { ca_cert_path: p });
    } catch (e) {
      setStatus({ ok: false, text: errMsg(e) });
    }
  };

  const test = async () => {
    setBusy('test');
    setStatus(null);
    try {
      const r = await withHostKeyTrust((trust) => api.testConnection(finalCfg, pw, sshSecrets, trust));
      setStatus({ ok: true, text: t('conn.testOk', { version: r.server.version.split(' on ')[0].split(',')[0], ms: r.latency_ms }) });
    } catch (e) {
      setStatus({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };

  const save = async (andConnect: boolean) => {
    setBusy(andConnect ? 'connect' : 'save');
    setStatus(null);
    try {
      // "Ask every time": nothing is stored (an empty password clears any saved one);
      // the typed password is used for this connect only, later connects prompt.
      const saved = await api.saveConnection(finalCfg, askEveryTime ? '' : pw, !askEveryTime, sshSecrets);
      await reloadConnections();
      if (andConnect) await openSession(saved.id, askEveryTime ? pw ?? undefined : undefined);
      else toast('ok', `Saved “${saved.name}”`);
      close();
    } catch (e) {
      setStatus({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };

  const keyButton = (kind: 'key' | 'cert' | 'ca', label: string, path: string | null | undefined) => (
    <button type="button" className={`btn min-w-0 flex-1 justify-start ${path ? 'text-fg' : 'text-muted'}`} onClick={() => pickCert(kind)} title={path ?? `Choose ${label.replace('…', '')} file`} aria-label={path ? `${label.replace('…', '')}: ${fileName(path)}` : label}>
      <Icon name="key" size={13} className="shrink-0" />
      <span className="truncate">{path ? fileName(path) : label}</span>
    </button>
  );

  return (
    <Dialog
      title={`${ENGINE_LABELS[cfg.engine]} Connection`}
      icon={<EngineBadge engine={cfg.engine} size={22} />}
      onClose={close}
      footer={
        <>
          <div className="mr-auto flex items-center gap-1.5">
            {isNew && (
              <button className="btn btn-ghost" onClick={() => setCfg(null)} aria-label={t('common.back')} title={t('common.back')}>
                ‹
              </button>
            )}
            {spec.ssh && (
              <button className={`btn ${ssh ? 'border-accent/60 bg-accent/10 text-accent' : ''}`} aria-pressed={!!ssh} onClick={toggleSsh}>
                <Icon name="lock" size={13} /> Over SSH
              </button>
            )}
            <button className="btn w-8 px-0" aria-label="More options" aria-expanded={advanced} title="More options" onClick={() => setAdvanced(!advanced)}>
              <Icon name="chevronDown" size={14} className={advanced ? 'rotate-180' : ''} />
            </button>
          </div>
          <button className="btn" onClick={() => save(false)} disabled={!!busy}>
            {busy === 'save' ? <Spinner /> : t('common.save')}
          </button>
          <button className="btn" onClick={test} disabled={!!busy || !supported.has(cfg.engine)}>
            {busy === 'test' ? <Spinner /> : t('common.test')}
          </button>
          <button className="btn btn-primary" onClick={() => save(true)} disabled={!!busy || !supported.has(cfg.engine)}>
            {busy === 'connect' ? <Spinner /> : t('common.connect')}
          </button>
        </>
      }
    >
      {!supported.has(cfg.engine) && <p className="mb-2 rounded-md bg-warn/10 px-2 py-1 text-[0.85rem] text-warn">{t('conn.unsupported')}</p>}

      {/* Identity / safety card */}
      <Card className="mb-3">
        <div className={GRID}>
          <Field label={t('conn.name')} wide>
            <input className="input" data-autofocus value={cfg.name} placeholder={autoName} onChange={(e) => set('name', e.target.value)} />
          </Field>

          <span className="justify-self-end text-[0.9rem] text-muted" id="status-color-label">Status color</span>
          <div className="flex items-center gap-1" role="radiogroup" aria-labelledby="status-color-label">
            {COLORS.map((c) => {
              const on = cfg.color === c;
              return (
                <button
                  key={c}
                  role="radio"
                  aria-checked={on}
                  aria-label={c}
                  onClick={() => set('color', on ? null : c)}
                  className={`h-[18px] rounded-full transition-all ${on ? 'w-8 ring-2 ring-fg/50 ring-offset-1 ring-offset-panel' : 'w-[18px] hover:scale-110'}`}
                  style={{ background: c }}
                />
              );
            })}
          </div>
          <Field label="Tag">
            <select className="input" value={cfg.environment} onChange={(e) => set('environment', e.target.value as EnvironmentKind)}>
              {ENVS.map((e) => (
                <option key={e} value={e}>{t(`env.${e}`)}</option>
              ))}
            </select>
          </Field>

          <Field label="Safe mode" wide>
            <Icon name="shield" size={15} className={`shrink-0 ${cfg.read_only ? 'text-ok' : 'text-muted'}`} />
            <select className="input" value={cfg.read_only ? 'read_only' : 'default'} onChange={(e) => set('read_only', e.target.value === 'read_only')}>
              <option value="default">Default for tag (confirm per environment policy)</option>
              <option value="read_only">{t('conn.readOnly')}</option>
            </select>
          </Field>
        </div>
        {cfg.environment === 'production' && (
          <p className="ml-[102px] mt-2 rounded-md bg-danger/10 px-2 py-1 text-[0.85rem] text-danger">Writes need confirmation; destructive statements need the connection name typed. Consider also enabling read-only.</p>
        )}
      </Card>

      {/* Connection card */}
      <Card>
        <div className={GRID}>
          {isFile ? (
            <Field label={t('conn.file')} wide>
              <input className="input font-mono" value={cfg.database ?? ''} placeholder="/path/to/database.sqlite" onChange={(e) => set('database', e.target.value || null)} />
            </Field>
          ) : isCloud ? (
            <>
              <Field label="Endpoint URL" wide>
                <input className="input font-mono" aria-label="Endpoint URL" value={cfg.host ?? ''} placeholder="empty = AWS · http://localhost:4566 for LocalStack" onChange={(e) => set('host', e.target.value.trim() || null)} spellCheck={false} />
              </Field>
              <Field label="Region" wide>
                <input className="input" aria-label="Region" value={cfg.database ?? ''} placeholder="us-east-1" onChange={(e) => set('database', e.target.value.trim() || null)} spellCheck={false} />
              </Field>
              <Field label="Access key ID" wide>
                <input className="input font-mono" aria-label="Access key ID" value={cfg.username ?? ''} placeholder="empty = default AWS credential chain · profile:NAME" onChange={(e) => set('username', e.target.value.trim() || null)} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Secret key">
                <input className="input" aria-label="Secret access key" type="password" value={password} placeholder={!isNew && !askEveryTime ? 'unchanged' : ''} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </Field>
              <select className="input col-span-2" aria-label="Password storage" value={pwMode} onChange={(e) => setPwMode(e.target.value as 'keychain' | 'ask')}>
                <option value="keychain">Store in keychain</option>
                <option value="ask">Ask every time</option>
              </select>
            </>
          ) : (
            <>
              {spec.socket ? (
                <select
                  className="input h-6 justify-self-end border-transparent bg-transparent pl-1 text-right text-[0.9rem] text-muted shadow-none focus:bg-raised"
                  aria-label="Address type"
                  value={socketMode ? 'socket' : 'host'}
                  onChange={(e) => {
                    const sock = e.target.value === 'socket';
                    setSocketMode(sock);
                    setCfg((c) => (c ? (sock ? { ...c, host: null } : { ...c, socket_path: null, host: c.host ?? '127.0.0.1' }) : c));
                  }}
                >
                  <option value="host">Host/IP</option>
                  <option value="socket">Socket</option>
                </select>
              ) : (
                <span className="justify-self-end text-[0.9rem] text-muted">Host/IP</span>
              )}
              {socketMode ? (
                <input className="input font-mono" aria-label={t('conn.socket')} value={cfg.socket_path ?? ''} placeholder="/var/run/postgresql" onChange={(e) => set('socket_path', e.target.value || null)} />
              ) : (
                <input className="input" aria-label="Host/IP" value={cfg.host ?? ''} placeholder="127.0.0.1" onChange={(e) => set('host', e.target.value || null)} spellCheck={false} />
              )}
              <Field label={t('conn.port')}>
                <input className="input" inputMode="numeric" value={cfg.port ?? ''} placeholder={String(DEFAULT_PORT[cfg.engine] ?? '')} onChange={(e) => set('port', e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null)} />
              </Field>

              <Field label={t('conn.user')}>
                <input className="input" value={cfg.username ?? ''} onChange={(e) => set('username', e.target.value || null)} autoComplete="off" spellCheck={false} />
              </Field>
              <button className="btn btn-ghost col-span-2 justify-start text-muted" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
                <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={14} /> Other options
              </button>

              <Field label={t('conn.password')}>
                <input className="input" type="password" value={password} placeholder={!isNew && !askEveryTime ? 'unchanged' : ''} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </Field>
              <select
                className="input col-span-2"
                aria-label="Password storage"
                title={pwMode === 'keychain' ? t('conn.rememberPassword', { backend: info?.secret_backend ?? 'keychain' }) : 'Not saved: you are asked for it when connecting'}
                value={pwMode}
                onChange={(e) => setPwMode(e.target.value as 'keychain' | 'ask')}
              >
                <option value="keychain">Store in keychain</option>
                <option value="ask">Ask every time</option>
              </select>
            </>
          )}

          {!isFile && !isCloud && (
            <Field label={spec.databaseLabel} wide={!spec.bootstrap}>
              <input className="input" value={cfg.database ?? ''} placeholder={spec.databasePlaceholder} onChange={(e) => set('database', e.target.value || null)} />
            </Field>
          )}
          {spec.bootstrap && (
            <button className={`btn ${isFile ? 'col-span-3 col-start-2 justify-self-start' : 'col-span-2'}`} onClick={() => setBootstrap(true)} title={cfg.init_sql ?? 'Statements run after connecting'}>
              <Icon name="sql" size={13} /> Bootstrap commands{cfg.init_sql ? ' •' : ''}
            </button>
          )}

          {spec.ssl && (
            <>
              <Field label="SSL mode" wide>
                <select className="input" value={cfg.tls.mode} title={SSL_MODES.map((m) => `${m.label}: ${m.hint}`).join('\n')} onChange={(e) => setTls({ mode: e.target.value as TlsMode })}>
                  {SSL_MODES.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </Field>
              <span />
              <p className="col-span-3 -mt-1 text-[0.82rem] text-muted">
                {sslHint}
                {mayBePlain && remoteHost && (
                  <span className={`block ${cfg.environment === 'production' ? 'text-danger' : 'text-warn'}`}>
                    {cfg.environment === 'production' ? 'Production connections to a remote host need REQUIRED or stronger (or Over SSH).' : t('conn.plaintextWarning')}
                  </span>
                )}
                {cfg.tls.ca_cert_path && (cfg.tls.mode === 'required' || cfg.tls.mode === 'preferred') && <span className="block">The CA certificate is only checked with VERIFY-CA or VERIFY-IDENTITY.</span>}
              </p>

              <span className="justify-self-end text-[0.9rem] text-muted">SSL keys</span>
              <div className="col-span-3 flex min-w-0 items-center gap-1.5" role="group" aria-label="SSL keys">
                {keyButton('key', 'Key…', cfg.tls.client_key_path)}
                {keyButton('cert', 'Cert…', cfg.tls.client_cert_path)}
                {keyButton('ca', 'CA Cert…', cfg.tls.ca_cert_path)}
                <button className="btn w-8 shrink-0 px-0" aria-label="Clear SSL keys" title="Clear SSL keys" disabled={!hasKeys} onClick={() => setTls({ client_key_path: null, client_cert_path: null, ca_cert_path: null })}>
                  —
                </button>
              </div>
            </>
          )}
        </div>
      </Card>

      {ssh && spec.ssh && (
        <Card className="mt-3">
          <div className="mb-2 flex items-center gap-2 text-[0.9rem] font-medium">
            <Icon name="lock" size={14} /> SSH tunnel
          </div>
          <div className={GRID}>
            <Field label="SSH host">
              <input className="input" value={ssh.host} placeholder="bastion.example.com" onChange={(e) => setSsh({ host: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="SSH port">
              <input className="input" inputMode="numeric" value={ssh.port} onChange={(e) => setSsh({ port: Number(e.target.value.replace(/\D/g, '')) || 22 })} />
            </Field>
            <Field label="SSH user">
              <input className="input" value={ssh.user} autoComplete="off" onChange={(e) => setSsh({ user: e.target.value })} />
            </Field>
            <Field label="SSH auth">
              <select className="input" value={ssh.auth} onChange={(e) => setSsh({ auth: e.target.value as SshConfig['auth'] })}>
                <option value="password">Password</option>
                <option value="private_key">Private key</option>
                <option value="agent">SSH agent</option>
              </select>
            </Field>
            {ssh.auth === 'password' && (
              <Field label="SSH password" wide>
                <input className="input" type="password" value={sshPassword} placeholder={!isNew ? 'unchanged' : ''} autoComplete="new-password" onChange={(e) => setSshPassword(e.target.value)} />
              </Field>
            )}
            {ssh.auth === 'private_key' && (
              <>
                <Field label="Private key">
                  <input className="input font-mono" value={ssh.private_key_path ?? ''} placeholder="~/.ssh/id_ed25519" onChange={(e) => setSsh({ private_key_path: e.target.value || null })} />
                </Field>
                <Field label="Passphrase">
                  <input className="input" type="password" value={sshPassphrase} placeholder="if encrypted" autoComplete="new-password" onChange={(e) => setSshPassphrase(e.target.value)} />
                </Field>
              </>
            )}
            <Field label="Jump hosts" wide>
              <input className="input font-mono" value={ssh.jump_hosts.join(', ')} placeholder="optional: user@bastion1:22, bastion2" onChange={(e) => setSsh({ jump_hosts: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
            </Field>
          </div>
          <p className="ml-[102px] mt-2 text-[0.8rem] text-muted">Host/IP above is resolved from the SSH server. Host keys are verified; you'll be asked to confirm a new server's fingerprint.</p>
        </Card>
      )}

      {advanced && (
        <Card className="mt-3">
          <div className={GRID}>
            <span className="justify-self-end text-[0.9rem] text-muted">Timeouts</span>
            <div className="col-span-3 flex items-center gap-2">
              <input className="input w-20" inputMode="numeric" aria-label={t('conn.connectTimeout')} value={cfg.connect_timeout_secs} onChange={(e) => set('connect_timeout_secs', Number(e.target.value.replace(/\D/g, '')) || 10)} />
              <span className="text-muted">s connect</span>
              <input className="input w-20" inputMode="numeric" aria-label={t('conn.queryTimeout')} placeholder="none" value={cfg.query_timeout_secs ?? ''} onChange={(e) => set('query_timeout_secs', e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null)} />
              <span className="text-muted">s query</span>
            </div>
            <Field label={t('conn.group')}>
              <input className="input" value={cfg.group ?? ''} onChange={(e) => set('group', e.target.value || null)} />
            </Field>
            <Field label="Tags">
              <input className="input" value={cfg.tags.join(', ')} placeholder="comma separated" onChange={(e) => set('tags', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
            </Field>
            <Field label={t('conn.notes')} wide>
              <textarea className="input" rows={2} value={cfg.notes ?? ''} onChange={(e) => set('notes', e.target.value || null)} />
            </Field>
          </div>
        </Card>
      )}

      {status && (
        <div role={status.ok ? 'status' : 'alert'} className={`mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-[0.92rem] ${status.ok ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'}`}>
          <span>{status.ok ? '●' : '▲'}</span>
          <span className="selectable min-w-0 flex-1 whitespace-pre-wrap">{status.text}</span>
          {!status.ok && /Local Network/.test(status.text) && isMac() && (
            <button className="btn shrink-0" onClick={() => api.openPrivacySettings('local_network').catch((e) => setStatus({ ok: false, text: errMsg(e) }))}>
              Open Local Network Settings
            </button>
          )}
        </div>
      )}

      {bootstrap && (
        <BootstrapSheet
          value={cfg.init_sql ?? ''}
          onClose={() => setBootstrap(false)}
          onDone={(v) => {
            set('init_sql', v.trim() ? v : null);
            setBootstrap(false);
          }}
        />
      )}
    </Dialog>
  );
}
