import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import type { ConnectionConfig, Engine, EnvironmentKind, TlsMode } from '../lib/types';
import { errMsg, useApp } from '../store';
import { Dialog, ErrorBox, Field, Spinner } from './ui';

export const ENGINE_LABELS: Record<Engine, string> = {
  postgres: 'PostgreSQL', my_sql: 'MySQL', maria_db: 'MariaDB', sqlite: 'SQLite', sql_server: 'SQL Server', oracle: 'Oracle',
  cockroach_db: 'CockroachDB', redshift: 'Amazon Redshift', single_store: 'SingleStore', greenplum: 'Greenplum', vertica: 'Vertica',
  duck_db: 'DuckDB', lib_sql: 'libSQL', turso: 'Turso', yugabyte_db: 'YugabyteDB', percona: 'Percona Server', mongo_db: 'MongoDB',
  redis: 'Redis', cassandra: 'Cassandra', dynamo_db: 'DynamoDB', elasticsearch: 'Elasticsearch', click_house: 'ClickHouse',
  big_query: 'BigQuery', snowflake: 'Snowflake', cloudflare_d1: 'Cloudflare D1',
};

const ENVS: EnvironmentKind[] = ['local', 'development', 'testing', 'staging', 'production', 'custom'];

export function blankConnection(engine: Engine = 'postgres'): ConnectionConfig {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    name: '',
    engine,
    host: engine === 'sqlite' ? null : 'localhost',
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

export function ConnectionDialog() {
  const { t } = useTranslation();
  const { connectionDialog, connections, info, reloadConnections, toast } = useApp();
  const existing = connections.find((c) => c.config.id === (connectionDialog?.id ?? connectionDialog?.duplicateOf))?.config;
  const [cfg, setCfg] = useState<ConnectionConfig>(() => {
    if (!existing) return blankConnection();
    if (connectionDialog?.duplicateOf) return { ...existing, id: blankConnection().id, name: `${existing.name} copy` };
    return existing;
  });
  const isNew = !connectionDialog?.id;
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const supported = useMemo(() => new Set(info?.supported_engines ?? []), [info]);

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const close = () => useApp.setState({ connectionDialog: null });
  const pw = password === '' ? null : password;
  const isFile = cfg.engine === 'sqlite' || cfg.engine === 'duck_db';

  const importUrl = async () => {
    setError(null);
    try {
      const p = await api.parseConnectionUrl(url.trim());
      setCfg({ ...p.config, id: cfg.id });
      if (p.password) setPassword(p.password);
      setUrl('');
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const test = async () => {
    setBusy(true);
    setError(null);
    setTestMsg(null);
    try {
      const r = await api.testConnection({ ...cfg, name: cfg.name || 'test' }, pw);
      setTestMsg(t('conn.testOk', { version: r.server.version.split(' on ')[0], ms: r.latency_ms }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const toSave = { ...cfg, id: connectionDialog?.duplicateOf ? blankConnection().id : cfg.id };
      // null = leave the stored password unchanged
      await api.saveConnection(toSave, pw, remember);
      await reloadConnections();
      toast('ok', `Saved ${cfg.name}`);
      close();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={isNew ? t('conn.new') : t('conn.edit')}
      onClose={close}
      wide
      footer={
        <>
          {busy && <Spinner />}
          <button className="btn" onClick={test} disabled={busy || !supported.has(cfg.engine)}>{t('common.test')}</button>
          <button className="btn" onClick={close}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !cfg.name.trim()}>{t('common.save')}</button>
        </>
      }
    >
      <div className="mb-3 flex gap-2">
        <input className="input font-mono" placeholder={t('conn.pasteUrl')} value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t('conn.importUrl')} />
        <button className="btn whitespace-nowrap" onClick={importUrl} disabled={!url.trim()}>{t('conn.importUrl')}</button>
      </div>
      <div className="grid grid-cols-2 gap-x-4">
        <div>
          <Field label={t('conn.name')}>
            <input className="input" value={cfg.name} onChange={(e) => set('name', e.target.value)} autoFocus />
          </Field>
          <Field label={t('conn.engine')} hint={!supported.has(cfg.engine) ? t('conn.unsupported') : undefined}>
            <select className="input" value={cfg.engine} onChange={(e) => set('engine', e.target.value as Engine)}>
              {(info?.all_engines ?? []).map((e) => (
                <option key={e} value={e}>{ENGINE_LABELS[e]}{supported.has(e) ? '' : ' — not available'}</option>
              ))}
            </select>
          </Field>
          {isFile ? (
            <Field label={t('conn.file')}>
              <input className="input font-mono" value={cfg.database ?? ''} onChange={(e) => set('database', e.target.value || null)} />
            </Field>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <Field label={t('conn.host')}>
                  <input className="input" value={cfg.host ?? ''} onChange={(e) => set('host', e.target.value || null)} />
                </Field>
                <Field label={t('conn.port')}>
                  <input className="input" inputMode="numeric" value={cfg.port ?? ''} placeholder="default" onChange={(e) => set('port', e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null)} />
                </Field>
              </div>
              <Field label={t('conn.socket')}>
                <input className="input font-mono" value={cfg.socket_path ?? ''} onChange={(e) => set('socket_path', e.target.value || null)} />
              </Field>
              <Field label={t('conn.user')}>
                <input className="input" value={cfg.username ?? ''} onChange={(e) => set('username', e.target.value || null)} autoComplete="off" />
              </Field>
              <Field label={t('conn.password')} hint={!isNew ? t('conn.passwordUnchanged') : undefined}>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </Field>
              <label className="mb-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                {t('conn.rememberPassword', { backend: info?.secret_backend ?? 'keychain' })}
              </label>
              <Field label={t('conn.database')}>
                <input className="input" value={cfg.database ?? ''} onChange={(e) => set('database', e.target.value || null)} />
              </Field>
            </>
          )}
        </div>
        <div>
          <Field label={t('conn.environment')}>
            <select className="input" value={cfg.environment} onChange={(e) => set('environment', e.target.value as EnvironmentKind)}>
              {ENVS.map((e) => <option key={e} value={e}>{t(`env.${e}`)}</option>)}
            </select>
          </Field>
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={cfg.read_only} onChange={(e) => set('read_only', e.target.checked)} />
            {t('conn.readOnly')}
          </label>
          {!isFile && (
            <fieldset className="mb-2 rounded border border-border p-2">
              <legend className="px-1 text-xs text-muted">{t('conn.tls')}</legend>
              <select className="input mb-2" aria-label={t('conn.tlsMode')} value={cfg.tls.mode} onChange={(e) => set('tls', { ...cfg.tls, mode: e.target.value as TlsMode })}>
                <option value="verify_full">{t('conn.tlsVerifyFull')}</option>
                <option value="verify_ca">{t('conn.tlsVerifyCa')}</option>
                <option value="disable">{t('conn.tlsDisable')}</option>
              </select>
              {cfg.tls.mode === 'disable' && cfg.host && !['localhost', '127.0.0.1', '::1'].includes(cfg.host) && (
                <p className="mb-2 text-xs text-warn">{t('conn.plaintextWarning')}</p>
              )}
              {cfg.tls.mode !== 'disable' && (
                <>
                  <Field label={t('conn.caCert')}><input className="input font-mono" value={cfg.tls.ca_cert_path ?? ''} onChange={(e) => set('tls', { ...cfg.tls, ca_cert_path: e.target.value || null })} /></Field>
                  <Field label={t('conn.clientCert')}><input className="input font-mono" value={cfg.tls.client_cert_path ?? ''} onChange={(e) => set('tls', { ...cfg.tls, client_cert_path: e.target.value || null })} /></Field>
                  <Field label={t('conn.clientKey')}><input className="input font-mono" value={cfg.tls.client_key_path ?? ''} onChange={(e) => set('tls', { ...cfg.tls, client_key_path: e.target.value || null })} /></Field>
                </>
              )}
            </fieldset>
          )}
          <fieldset className="mb-2 rounded border border-border p-2">
            <legend className="px-1 text-xs text-muted">{t('conn.ssh')}</legend>
            <p className="text-xs text-muted">{t('conn.sshUnavailable')}</p>
          </fieldset>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('conn.group')}><input className="input" value={cfg.group ?? ''} onChange={(e) => set('group', e.target.value || null)} /></Field>
            <Field label={t('conn.color')}><input className="input h-7 p-0" type="color" value={cfg.color ?? '#2563eb'} onChange={(e) => set('color', e.target.value)} /></Field>
            <Field label={t('conn.connectTimeout')}><input className="input" inputMode="numeric" value={cfg.connect_timeout_secs} onChange={(e) => set('connect_timeout_secs', Number(e.target.value.replace(/\D/g, '')) || 10)} /></Field>
            <Field label={t('conn.queryTimeout')}><input className="input" inputMode="numeric" value={cfg.query_timeout_secs ?? ''} onChange={(e) => set('query_timeout_secs', e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null)} /></Field>
          </div>
          <Field label={t('conn.tags')}><input className="input" value={cfg.tags.join(', ')} onChange={(e) => set('tags', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></Field>
          <Field label={t('conn.notes')}><textarea className="input" rows={2} value={cfg.notes ?? ''} onChange={(e) => set('notes', e.target.value || null)} /></Field>
          <Field label={t('conn.initSql')}><textarea className="input font-mono" rows={2} value={cfg.init_sql ?? ''} onChange={(e) => set('init_sql', e.target.value || null)} /></Field>
        </div>
      </div>
      {testMsg && <div role="status" className="rounded border border-ok/50 bg-ok/10 p-2 text-sm text-ok">{testMsg}</div>}
      <ErrorBox error={error} />
    </Dialog>
  );
}
