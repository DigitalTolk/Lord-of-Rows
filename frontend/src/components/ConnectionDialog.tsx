import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import type { ConnectionConfig, Engine, EnvironmentKind, TlsMode } from '../lib/types';
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
const ENV_DOT: Record<EnvironmentKind, string> = { local: 'bg-ok', development: 'bg-accent', testing: 'bg-purple', staging: 'bg-warn', production: 'bg-danger', custom: 'bg-muted' };
const DEFAULT_PORT: Partial<Record<Engine, number>> = { postgres: 5432, my_sql: 3306, maria_db: 3306, percona: 3306, single_store: 3306, cockroach_db: 26257, yugabyte_db: 5433, redshift: 5439, greenplum: 5432, redis: 6379 };

export function blankConnection(engine: Engine = 'postgres'): ConnectionConfig {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    name: '',
    engine,
    // DynamoDB: host is an optional endpoint URL; empty = the AWS endpoint for the region.
    host: engine === 'sqlite' || engine === 'dynamo_db' ? null : '127.0.0.1',
    port: null,
    database: null,
    username: null,
    socket_path: null,
    tls: { mode: 'disable' },
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

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="grid grid-cols-[120px_1fr] items-center gap-x-3 py-1">
      <span className="text-right text-[0.92rem] text-muted">{label}</span>
      <span className="flex min-w-0 items-center gap-2">{children}</span>
      {hint && <span className="col-start-2 mt-0.5 text-[0.82rem] text-muted">{hint}</span>}
    </label>
  );
}

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

export function ConnectionDialog() {
  const { t } = useTranslation();
  const { connectionDialog, connections, info, reloadConnections, toast, openSession } = useApp();
  const existing = connections.find((c) => c.config.id === (connectionDialog?.id ?? connectionDialog?.duplicateOf))?.config;
  const isNew = !connectionDialog?.id;
  const [cfg, setCfg] = useState<ConnectionConfig | null>(() => {
    if (!existing) return null; // show engine picker first
    if (connectionDialog?.duplicateOf) return { ...existing, id: blankConnection().id, name: `${existing.name} copy` };
    return existing;
  });
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [sshPassword, setSshPassword] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');
  const [busy, setBusy] = useState<null | 'test' | 'save' | 'connect'>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [url, setUrl] = useState('');
  const [advanced, setAdvanced] = useState(false);
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
                setCfg({ ...p.config, id: blankConnection().id });
                if (p.password) setPassword(p.password);
              } catch (e) {
                setStatus({ ok: false, text: errMsg(e) });
              }
            }}
          >
            {t('conn.importUrl')}
          </button>
        </div>
        {status && !status.ok && <p className="mb-2 text-danger">{status.text}</p>}
        <EnginePicker onPick={(e) => setCfg({ ...blankConnection(e), tls: { mode: 'disable' } })} />
      </Dialog>
    );
  }

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => setCfg((c) => (c ? { ...c, [k]: v } : c));
  const isFile = cfg.engine === 'sqlite' || cfg.engine === 'duck_db';
  const isDynamo = cfg.engine === 'dynamo_db';
  const autoName = cfg.name.trim() || (isFile ? (cfg.database ?? '').split('/').pop() || ENGINE_LABELS[cfg.engine] : `${cfg.database || ENGINE_LABELS[cfg.engine]}${cfg.host ? ' @ ' + cfg.host : ''}`);
  const finalCfg = { ...cfg, name: autoName };
  const pw = password === '' ? null : password;
  const remoteHost = cfg.host && !['localhost', '127.0.0.1', '::1'].includes(cfg.host) && !cfg.ssh;
  // null = keep what is stored in the keychain
  const sshSecrets = { password: sshPassword === '' ? null : sshPassword, passphrase: sshPassphrase === '' ? null : sshPassphrase };
  const ssh = cfg.ssh;
  const setSsh = (patch: Partial<NonNullable<ConnectionConfig['ssh']>>) => set('ssh', ssh ? { ...ssh, ...patch } : null);

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
      const saved = await api.saveConnection(finalCfg, pw, remember, sshSecrets);
      await reloadConnections();
      if (andConnect) await openSession(saved.id, remember ? undefined : pw ?? undefined);
      else toast('ok', `Saved “${saved.name}”`);
      close();
    } catch (e) {
      setStatus({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      title={isNew ? t('conn.new') : t('conn.edit')}
      onClose={close}
      footer={
        <>
          {isNew && (
            <button className="btn btn-ghost mr-auto" onClick={() => setCfg(null)}>
              ‹ {t('common.back')}
            </button>
          )}
          <button className="btn" onClick={test} disabled={!!busy || !supported.has(cfg.engine)}>
            {busy === 'test' ? <Spinner /> : t('common.test')}
          </button>
          <button className="btn" onClick={() => save(false)} disabled={!!busy}>
            {busy === 'save' ? <Spinner /> : t('common.save')}
          </button>
          <button className="btn btn-primary" onClick={() => save(true)} disabled={!!busy || !supported.has(cfg.engine)}>
            {busy === 'connect' ? <Spinner /> : t('common.connect')}
          </button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-3 rounded-lg bg-panel p-3">
        <EngineBadge engine={cfg.engine} size={36} />
        <div className="min-w-0">
          <div className="font-semibold">{ENGINE_LABELS[cfg.engine]}</div>
          <div className="truncate text-[0.85rem] text-muted">{supported.has(cfg.engine) ? 'Native driver' : t('conn.unsupported')}</div>
        </div>
        <div className="ml-auto flex items-center gap-1" role="radiogroup" aria-label={t('conn.color')}>
          {['#0a70f5', '#1e9650', '#c47800', '#d72d2d', '#7c4dff', '#787880'].map((c) => (
            <button key={c} role="radio" aria-checked={cfg.color === c} aria-label={c} onClick={() => set('color', cfg.color === c ? null : c)} className={`h-4 w-4 rounded-full ring-offset-1 ring-offset-bg ${cfg.color === c ? 'ring-2 ring-fg/60' : ''}`} style={{ background: c }} />
          ))}
        </div>
      </div>

      <Row label={t('conn.name')}>
        <input className="input" data-autofocus value={cfg.name} placeholder={autoName} onChange={(e) => set('name', e.target.value)} />
      </Row>
      <Row label={t('conn.environment')}>
        <div className="seg" role="radiogroup" aria-label={t('conn.environment')}>
          {ENVS.map((e) => (
            <button key={e} role="radio" aria-checked={cfg.environment === e} onClick={() => set('environment', e)} className="flex items-center gap-1">
              <span className={`h-2 w-2 rounded-full ${ENV_DOT[e]}`} />
              {t(`env.${e}`)}
            </button>
          ))}
        </div>
      </Row>
      {cfg.environment === 'production' && (
        <p className="mb-1 ml-[132px] rounded-md bg-danger/10 px-2 py-1 text-[0.85rem] text-danger">Writes need confirmation; destructive statements need the connection name typed. Consider also enabling read-only.</p>
      )}

      <div className="my-2 border-t border-border" />

      {isFile ? (
        <Row label={t('conn.file')}>
          <input className="input font-mono" value={cfg.database ?? ''} placeholder="/path/to/database.sqlite" onChange={(e) => set('database', e.target.value || null)} />
        </Row>
      ) : isDynamo ? (
        <>
          <Row label="Endpoint URL" hint="Optional. Leave empty for AWS; e.g. http://localhost:8000 for DynamoDB Local / LocalStack">
            <input className="input font-mono" value={cfg.host ?? ''} placeholder="https://dynamodb.<region>.amazonaws.com" onChange={(e) => set('host', e.target.value.trim() || null)} spellCheck={false} />
          </Row>
          <Row label="Region">
            <input className="input" value={cfg.database ?? ''} placeholder="us-east-1" onChange={(e) => set('database', e.target.value.trim() || null)} spellCheck={false} />
          </Row>
          <Row label="Access key ID" hint="Empty = default AWS credential chain (env, ~/.aws, SSO). profile:NAME uses a named profile.">
            <input className="input font-mono" value={cfg.username ?? ''} onChange={(e) => set('username', e.target.value.trim() || null)} autoComplete="off" spellCheck={false} />
          </Row>
          <Row label="Secret access key" hint={!isNew && !password ? t('conn.passwordUnchanged') : undefined}>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <label className="flex shrink-0 items-center gap-1.5 text-[0.88rem] text-muted" title={t('conn.rememberPassword', { backend: info?.secret_backend ?? 'keychain' })}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <Icon name="lock" size={13} /> Keychain
            </label>
          </Row>
        </>
      ) : (
        <>
          <Row label={t('conn.host')}>
            <input className="input" value={cfg.host ?? ''} placeholder="127.0.0.1" onChange={(e) => set('host', e.target.value || null)} />
            <span className="text-muted">{t('conn.port')}</span>
            <input className="input w-20" inputMode="numeric" value={cfg.port ?? ''} placeholder={String(DEFAULT_PORT[cfg.engine] ?? '')} onChange={(e) => set('port', e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null)} />
          </Row>
          <Row label={t('conn.user')}>
            <input className="input" value={cfg.username ?? ''} onChange={(e) => set('username', e.target.value || null)} autoComplete="off" spellCheck={false} />
          </Row>
          <Row label={t('conn.password')} hint={!isNew && !password ? t('conn.passwordUnchanged') : undefined}>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <label className="flex shrink-0 items-center gap-1.5 text-[0.88rem] text-muted" title={t('conn.rememberPassword', { backend: info?.secret_backend ?? 'keychain' })}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <Icon name="lock" size={13} /> Keychain
            </label>
          </Row>
          <Row label={cfg.engine === 'redis' ? 'Database #' : t('conn.database')}>
            <input className="input" value={cfg.database ?? ''} placeholder={cfg.engine === 'redis' ? '0' : 'optional'} onChange={(e) => set('database', e.target.value || null)} />
          </Row>
          <Row label="SSL / TLS" hint={cfg.tls.mode === 'disable' && remoteHost ? <span className="text-warn">{t('conn.plaintextWarning')}</span> : undefined}>
            <select className="input" value={cfg.tls.mode} onChange={(e) => set('tls', { ...cfg.tls, mode: e.target.value as TlsMode })}>
              <option value="disable">{t('conn.tlsDisable')}</option>
              <option value="verify_full">{t('conn.tlsVerifyFull')}</option>
              <option value="verify_ca">{t('conn.tlsVerifyCa')}</option>
            </select>
          </Row>
        </>
      )}
      {!isFile && !isDynamo && (
        <>
          <Row label="">
            <label className="flex items-center gap-2 text-[0.92rem]">
              <input
                type="checkbox"
                checked={!!ssh}
                onChange={(e) => set('ssh', e.target.checked ? { host: '', port: 22, user: '', auth: 'password', private_key_path: null, jump_hosts: [], keepalive_secs: 30 } : null)}
              />
              Connect through an SSH tunnel
            </label>
          </Row>
          {ssh && (
            <div className="mb-1 rounded-lg border border-border bg-panel/60 py-1 pr-2">
              <Row label="SSH host">
                <input className="input" value={ssh.host} placeholder="bastion.example.com" onChange={(e) => setSsh({ host: e.target.value })} />
                <span className="text-muted">Port</span>
                <input className="input w-20" inputMode="numeric" value={ssh.port} onChange={(e) => setSsh({ port: Number(e.target.value.replace(/\D/g, '')) || 22 })} />
              </Row>
              <Row label="SSH user"><input className="input" value={ssh.user} autoComplete="off" onChange={(e) => setSsh({ user: e.target.value })} /></Row>
              <Row label="SSH auth">
                <div className="seg" role="radiogroup" aria-label="SSH authentication">
                  {(['password', 'private_key', 'agent'] as const).map((a) => (
                    <button key={a} role="radio" aria-checked={ssh.auth === a} onClick={() => setSsh({ auth: a })}>{a === 'password' ? 'Password' : a === 'private_key' ? 'Private key' : 'SSH agent'}</button>
                  ))}
                </div>
              </Row>
              {ssh.auth === 'password' && (
                <Row label="SSH password" hint={!isNew && !sshPassword ? 'Leave empty to keep the saved SSH password' : undefined}>
                  <input className="input" type="password" value={sshPassword} autoComplete="new-password" onChange={(e) => setSshPassword(e.target.value)} />
                </Row>
              )}
              {ssh.auth === 'private_key' && (
                <>
                  <Row label="Private key"><input className="input font-mono" value={ssh.private_key_path ?? ''} placeholder="~/.ssh/id_ed25519" onChange={(e) => setSsh({ private_key_path: e.target.value || null })} /></Row>
                  <Row label="Passphrase" hint="Only if the key is encrypted"><input className="input" type="password" value={sshPassphrase} autoComplete="new-password" onChange={(e) => setSshPassphrase(e.target.value)} /></Row>
                </>
              )}
              <Row label="Jump hosts" hint="Optional, comma separated: user@bastion1:22, bastion2">
                <input className="input font-mono" value={ssh.jump_hosts.join(', ')} onChange={(e) => setSsh({ jump_hosts: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
              </Row>
              <p className="ml-[132px] text-[0.8rem] text-muted">Host above is resolved from the SSH server. Host keys are verified; you'll be asked to confirm a new server's fingerprint.</p>
            </div>
          )}
        </>
      )}
      <Row label="">
        <label className="flex items-center gap-2 text-[0.92rem]">
          <input type="checkbox" checked={cfg.read_only} onChange={(e) => set('read_only', e.target.checked)} />
          {t('conn.readOnly')}
        </label>
      </Row>

      <button className="mt-1 flex items-center gap-1 text-[0.9rem] text-muted hover:text-fg" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
        <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={14} /> Advanced
      </button>
      {advanced && (
        <div className="mt-1">
          {!isFile && !isDynamo && cfg.tls.mode !== 'disable' && (
            <>
              <Row label="CA cert"><input className="input font-mono" value={cfg.tls.ca_cert_path ?? ''} placeholder="path to CA bundle (PEM)" onChange={(e) => set('tls', { ...cfg.tls, ca_cert_path: e.target.value || null })} /></Row>
              <Row label="Client cert"><input className="input font-mono" value={cfg.tls.client_cert_path ?? ''} onChange={(e) => set('tls', { ...cfg.tls, client_cert_path: e.target.value || null })} /></Row>
              <Row label="Client key"><input className="input font-mono" value={cfg.tls.client_key_path ?? ''} onChange={(e) => set('tls', { ...cfg.tls, client_key_path: e.target.value || null })} /></Row>
            </>
          )}
          {!isFile && !isDynamo && <Row label={t('conn.socket')}><input className="input font-mono" value={cfg.socket_path ?? ''} onChange={(e) => set('socket_path', e.target.value || null)} /></Row>}
          <Row label="Timeouts">
            <input className="input w-20" inputMode="numeric" value={cfg.connect_timeout_secs} onChange={(e) => set('connect_timeout_secs', Number(e.target.value.replace(/\D/g, '')) || 10)} />
            <span className="text-muted">s connect</span>
            <input className="input w-20" inputMode="numeric" placeholder="none" value={cfg.query_timeout_secs ?? ''} onChange={(e) => set('query_timeout_secs', e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null)} />
            <span className="text-muted">s query</span>
          </Row>
          <Row label={t('conn.group')}><input className="input" value={cfg.group ?? ''} onChange={(e) => set('group', e.target.value || null)} /></Row>
          <Row label="Tags"><input className="input" value={cfg.tags.join(', ')} placeholder="comma separated" onChange={(e) => set('tags', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></Row>
          <Row label={t('conn.initSql')}><textarea className="input font-mono" rows={2} value={cfg.init_sql ?? ''} onChange={(e) => set('init_sql', e.target.value || null)} /></Row>
          <Row label={t('conn.notes')}><textarea className="input" rows={2} value={cfg.notes ?? ''} onChange={(e) => set('notes', e.target.value || null)} /></Row>
        </div>
      )}

      {status && (
        <div role={status.ok ? 'status' : 'alert'} className={`mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-[0.92rem] ${status.ok ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'}`}>
          <span>{status.ok ? '●' : '▲'}</span>
          <span className="selectable whitespace-pre-wrap">{status.text}</span>
        </div>
      )}
    </Dialog>
  );
}
