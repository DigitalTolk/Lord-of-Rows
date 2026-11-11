import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ask } from '../components/ask';
import { ErrorBox, Field, Spinner, Toolbar } from '../components/ui';
import { api, IpcError } from '../lib/ipc';
import { fmtBytes } from '../lib/format';
import { errMsg, useApp, type Tab } from '../store';

export function BackupView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const { sessions, toast } = useApp();
  const s = tab.sessionId ? sessions[tab.sessionId] : undefined;
  const [tools, setTools] = useState<{ tool: string; path?: string | null; version?: string | null }[]>([]);
  const [scope, setScope] = useState<'full' | 'schema_only' | 'data_only'>('full');
  const [tables, setTables] = useState('');
  const [compress, setCompress] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    void api.backupTools().then(setTools);
  }, []);

  if (!s) return <div className="p-4 text-muted">{t('status.disconnected')}</div>;
  const ext = s.config.engine === 'postgres' ? 'dump' : s.config.engine === 'sqlite' ? 'sqlite' : 'sql';

  const backup = async () => {
    const f = await api.pickFile(true, `${s.config.name.replace(/\W+/g, '_')}-${new Date().toISOString().slice(0, 10)}.${ext}`, [ext]);
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.runBackup(s.session_id, f.grant, { scope, tables: tables.split(',').map((x) => x.trim()).filter(Boolean), compress });
      setLog([`${r.tool}: ${fmtBytes(r.bytes)} → ${f.display_path}`, r.verified ? `✓ ${t('backup.verified')}` : `⚠ ${t('backup.notVerified')}`, ...r.notes]);
      toast('ok', t('backup.complete'));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    const f = await api.pickFile(false, undefined, [ext]);
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      try {
        await api.runRestore(s.session_id, f.grant);
      } catch (e) {
        if (!(e instanceof IpcError) || e.kind !== 'confirmation_required' || !e.err.hint) throw e;
        if (!(await ask.confirm(t('backup.restore'), `${t('backup.restoreWarning')}\n\n${f.display_path} → ${s.config.name}`, true))) return;
        let typed: string | null = null;
        if (s.config.environment === 'production') {
          typed = await ask.text(t('safety.productionBanner'), t('safety.typeToConfirm', { phrase: s.config.name }));
          if (typed === null) return;
        }
        const r = await api.runRestore(s.session_id, f.grant, e.err.hint, typed);
        setLog([`${r.tool}: ${t('backup.restored', { path: f.display_path })}`, ...r.notes]);
        toast('ok', t('backup.restoreComplete'));
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar><span className="font-semibold">{t('backup.title')} — {s.config.name}</span></Toolbar>
      <div className="grid min-h-0 flex-1 grid-cols-[360px_1fr] gap-4 overflow-auto p-3">
        <div>
          <Field label={t('backup.scope')}>
            <select className="input" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="full">{t('backup.full')}</option><option value="schema_only">{t('backup.schemaOnly')}</option><option value="data_only">{t('backup.dataOnly')}</option>
            </select>
          </Field>
          <Field label={t('backup.tables')}><input className="input" value={tables} onChange={(e) => setTables(e.target.value)} placeholder={t('backup.tablesPlaceholder')} /></Field>
          <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={compress} onChange={(e) => setCompress(e.target.checked)} />{t('backup.compress')}</label>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={backup} disabled={busy}>{t('backup.run')}</button>
            <button className="btn text-danger" onClick={restore} disabled={busy || s.config.read_only}>{t('backup.restore')}</button>
            {busy && <Spinner label={t('backup.working')} />}
          </div>
          <ErrorBox error={error} />
          <p className="mt-3 text-xs text-muted">{t('backup.logicalNote')}</p>
        </div>
        <div>
          <h3 className="mb-1 font-semibold">{t('backup.tools')}</h3>
          <ul className="mb-4 text-sm">
            {tools.map((x) => <li key={x.tool} className="font-mono">{x.tool}: {x.path ? <span className="text-ok">{x.version ?? x.path}</span> : <span className="text-warn">{t('backup.missing')}</span>}</li>)}
          </ul>
          {log.length > 0 && <pre role="status" className="whitespace-pre-wrap rounded border border-border bg-panel p-2 font-mono text-xs">{log.join('\n')}</pre>}
        </div>
      </div>
    </div>
  );
}
