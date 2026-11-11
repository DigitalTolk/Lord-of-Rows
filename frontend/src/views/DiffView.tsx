import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirmDecision } from '../components/confirm';
import { ErrorBox, Spinner, Toolbar } from '../components/ui';
import { api } from '../lib/ipc';
import type { DiffResult } from '../lib/types';
import { fmtNumber } from '../lib/format';
import { errMsg, useApp } from '../store';

/** Compare two schemas (possibly across connections/environments) and generate a migration for the target. */
export function DiffView() {
  const { t } = useTranslation();
  const { sessions, toast } = useApp();
  const list = Object.values(sessions);
  const [src, setSrc] = useState({ session: list[0]?.session_id ?? '', schema: list[0]?.activeSchema ?? '' });
  const [tgt, setTgt] = useState({ session: list[1]?.session_id ?? list[0]?.session_id ?? '', schema: list[1]?.activeSchema ?? list[0]?.activeSchema ?? '' });
  const [drops, setDrops] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'forward' | 'reverse'>('forward');

  const compare = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await api.schemaDiff(src.session, src.schema || null, tgt.session, tgt.schema || null, drops));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    const target = sessions[tgt.session];
    if (!res?.forward_sql || !target) return;
    try {
      const ev = await api.evaluateSql(target.session_id, res.forward_sql);
      const c = await confirmDecision(ev.decision, { production: target.config.environment === 'production', sqlPreview: res.forward_sql });
      if (!c) return;
      await api.runMigration(target.session_id, res.forward_sql, c.token || null, c.typed);
      toast('ok', t('diff.applied'));
      await compare();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const Pick = ({ v, set, label }: { v: { session: string; schema: string }; set: (x: { session: string; schema: string }) => void; label: string }) => (
    <fieldset className="rounded border border-border p-2">
      <legend className="px-1 text-xs text-muted">{label}</legend>
      <select className="input mb-1" aria-label={t('diff.connectionOf', { side: label })} value={v.session} onChange={(e) => set({ session: e.target.value, schema: sessions[e.target.value]?.activeSchema ?? '' })}>
        {list.map((s) => <option key={s.session_id} value={s.session_id}>{s.config.name} ({t(`env.${s.config.environment}`)})</option>)}
      </select>
      {(sessions[v.session]?.schemas.length ?? 0) > 0 && (
        <select className="input" aria-label={t('diff.schemaOf', { side: label })} value={v.schema} onChange={(e) => set({ ...v, schema: e.target.value })}>
          {sessions[v.session].schemas.map((x) => <option key={x}>{x}</option>)}
        </select>
      )}
    </fieldset>
  );

  if (!list.length) return <div className="p-4 text-muted">{t('diff.needConnection')}</div>;
  const destructive = res?.migration?.steps.some((s) => s.destructive);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <span className="font-semibold">{t('diff.title')}</span>
      </Toolbar>
      <div className="grid grid-cols-2 gap-2 p-2">
        <Pick v={src} set={setSrc} label={t('diff.source')} />
        <Pick v={tgt} set={setTgt} label={t('diff.target')} />
      </div>
      <div className="flex items-center gap-2 px-2">
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={drops} onChange={(e) => setDrops(e.target.checked)} />{t('diff.includeDrops')}</label>
        <button className="btn btn-primary" onClick={compare} disabled={busy}>{t('diff.compare')}</button>
        {busy && <Spinner label={t('diff.comparing')} />}
        {res?.forward_sql && <button className={`btn ms-auto ${destructive ? 'btn-danger' : ''}`} onClick={run}>{t('diff.run')}</button>}
      </div>
      <ErrorBox error={error ?? res?.plan_error?.message} />
      {res && (
        <div className="min-h-0 flex-1 overflow-auto p-2" aria-live="polite">
          {res.changes.length === 0 ? (
            <p className="text-ok">{t('diff.noChanges')}</p>
          ) : (
            <>
              <p className="mb-2 text-sm">{t('diff.changes', { count: res.changes.length, formatted: fmtNumber(res.changes.length) })}{destructive && <span className="ms-2 rounded bg-danger-solid px-1 text-on-solid">{t('diff.destructive')}</span>}</p>
              <div className="mb-2 flex gap-1" role="tablist" aria-label={t('diff.scripts')}>
                <button role="tab" aria-selected={tab === 'forward'} className={`btn ${tab === 'forward' ? 'btn-primary' : ''}`} onClick={() => setTab('forward')}>{t('diff.forward')}</button>
                <button role="tab" aria-selected={tab === 'reverse'} className={`btn ${tab === 'reverse' ? 'btn-primary' : ''}`} onClick={() => setTab('reverse')}>{t('diff.reverse')}</button>
                <button className="btn ms-auto" onClick={() => navigator.clipboard.writeText((tab === 'forward' ? res.forward_sql : res.reverse_sql) ?? '')}>{t('common.copy')}</button>
              </div>
              {tab === 'forward' ? (
                <pre dir="ltr" className="rounded border border-border bg-panel p-2 font-mono text-xs">{res.forward_sql}</pre>
              ) : res.reverse_sql ? (
                <pre dir="ltr" className="rounded border border-border bg-panel p-2 font-mono text-xs">{res.reverse_sql}</pre>
              ) : (
                <p className="text-warn">{t('diff.notReversible')}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
