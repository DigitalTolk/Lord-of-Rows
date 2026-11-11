import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ask } from '../components/ask';
import { ErrorBox, Toolbar } from '../components/ui';
import { api } from '../lib/ipc';
import type { AuditEntry, AuditFilter } from '../lib/types';
import { fmtDateTime, fmtNumber } from '../lib/format';
import { errMsg, useApp } from '../store';

const CATEGORIES = ['connection_created', 'connection_modified', 'connection_deleted', 'connection_opened', 'connection_failed', 'credential_changed', 'credential_deleted', 'query_executed', 'ddl_executed', 'dml_executed', 'data_edited', 'safety_blocked', 'safety_confirmed', 'import', 'export', 'backup', 'restore', 'privilege_change', 'session_killed', 'settings_changed', 'security_policy_changed', 'audit_exported', 'audit_purged', 'ai_request'];

export function AuditView() {
  const { t } = useTranslation();
  const toast = useApp((s) => s.toast);
  const [filter, setFilter] = useState<AuditFilter>({ limit: 500 });
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [sel, setSel] = useState<AuditEntry | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setRows(await api.auditQuery(filter));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  };
  useEffect(() => {
    void load();
  }, [filter.category, filter.outcome]); // eslint-disable-line react-hooks/exhaustive-deps

  const doVerify = async () => {
    const r = await api.auditVerify();
    setVerify({ ok: r.ok, text: r.ok ? t('audit.verifyOk', { count: r.entries, formatted: fmtNumber(r.entries) }) : t('audit.verifyBad', { seq: r.first_bad_seq }) });
  };
  const doExport = async () => {
    const f = await api.pickFile(true, 'audit.jsonl', ['jsonl']);
    if (!f) return;
    const n = await api.auditExport(filter, f.grant);
    toast('ok', t('audit.exported', { count: n, formatted: fmtNumber(n) }));
  };
  const doPurge = async () => {
    const d = await ask.text(t('audit.purge'), t('audit.purgePrompt'));
    if (!d) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return toast('error', t('audit.purgeDateFormat'));
    if (!(await ask.confirm(t('audit.purge'), t('audit.purgeConfirm', { date: d }), true))) return;
    const n = await api.auditPurge(`${d}T00:00:00Z`);
    toast('ok', t('audit.purged', { count: n, formatted: fmtNumber(n) }));
    void load();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <span className="font-semibold">{t('audit.title')}</span>
        <select className="input w-56" aria-label={t('audit.category')} value={filter.category ?? ''} onChange={(e) => setFilter({ ...filter, category: e.target.value || undefined })}>
          <option value="">{t('audit.allCategories')}</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{t(`audit.categories.${c}`)}</option>)}
        </select>
        <select className="input w-32" aria-label={t('audit.outcome')} value={filter.outcome ?? ''} onChange={(e) => setFilter({ ...filter, outcome: e.target.value || undefined })}>
          <option value="">{t('audit.anyOutcome')}</option><option value="success">{t('audit.success')}</option><option value="failure">{t('audit.failure')}</option><option value="denied">{t('audit.denied')}</option>
        </select>
        <input className="input w-56" placeholder={t('common.search')} aria-label={t('common.search')} value={filter.text ?? ''} onChange={(e) => setFilter({ ...filter, text: e.target.value || undefined })} onKeyDown={(e) => e.key === 'Enter' && load()} />
        <button className="btn" onClick={load} aria-label={t('common.refresh')} title={t('common.refresh')}>⟳</button>
        <button className="btn" onClick={doVerify}>{t('audit.verify')}</button>
        <button className="btn" onClick={doExport}>{t('audit.export')}</button>
        <button className="btn text-danger" onClick={doPurge}>{t('audit.purge')}</button>
        <span className={`ms-2 text-sm ${verify?.ok ? 'text-ok' : 'text-danger'}`} role="status">{verify?.text}</span>
      </Toolbar>
      <p className="border-b border-border px-2 py-1 text-xs text-muted">{t('audit.limitation')}</p>
      <ErrorBox error={error} />
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_380px]">
        <div className="min-h-0 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel">
              <tr>{['#', t('audit.time'), t('audit.category'), t('audit.outcome'), t('audit.environment'), t('audit.object'), t('audit.rows'), t('audit.durationMs')].map((h) => <th key={h} className="border-b border-border px-2 py-1 text-start">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.seq} tabIndex={0} onClick={() => setSel(r)} onKeyDown={(e) => e.key === 'Enter' && setSel(r)} className={`cursor-default border-b border-border/50 hover:bg-raised ${sel?.seq === r.seq ? 'bg-accent/15' : ''}`}>
                  <td className="px-2 text-muted">{r.seq}</td>
                  <td className="px-2 font-mono text-xs" title={r.ts}>{fmtDateTime(r.ts)}</td>
                  <td className="px-2">{t(`audit.categories.${r.category}`, { defaultValue: r.category })}</td>
                  <td className={`px-2 ${r.outcome === 'success' ? 'text-ok' : 'text-danger'}`}>{t(`audit.${r.outcome}`, { defaultValue: r.outcome })}</td>
                  <td className="px-2">{r.environment ? t(`env.${r.environment}`, { defaultValue: r.environment }) : ''}</td>
                  <td className="px-2">{r.object}</td>
                  <td className="px-2 text-end">{fmtNumber(r.rows_affected)}</td>
                  <td className="px-2 text-end">{fmtNumber(r.duration_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="min-h-0 overflow-auto border-s border-border p-2">
          <h3 className="mb-1 font-semibold">{t('audit.details')}</h3>
          {sel ? <pre dir="ltr" className="whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(sel, null, 2)}</pre> : <p className="text-muted">{t('audit.selectEntry')}</p>}
        </div>
      </div>
    </div>
  );
}
