import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from './ui';
import type { Decision, Finding } from '../lib/types';

export interface PendingConfirm {
  decision: Extract<Decision, { decision: 'confirm' }> | Extract<Decision, { decision: 'block' }>;
  sqlPreview?: string;
  production: boolean;
  resolve: (r: { token: string; typed?: string } | null) => void;
}

const riskColor: Record<string, string> = {
  destructive: 'text-danger',
  admin: 'text-danger',
  unknown: 'text-warn',
  schema: 'text-warn',
  write: 'text-warn',
};

function FindingList({ findings }: { findings: Finding[] }) {
  return (
    <ul className="mb-3 space-y-1">
      {findings.map((f, i) => (
        <li key={i} className="rounded border border-border bg-panel p-2 text-sm">
          <span className={`mr-2 font-semibold uppercase ${riskColor[f.risk] ?? ''}`}>{f.risk}</span>
          #{f.statement + 1}: {f.reason}
        </li>
      ))}
    </ul>
  );
}

/** Confirmation UI for backend safety decisions. The token was issued by Rust and is bound to the exact SQL. */
export function SafetyDialog({ pending }: { pending: PendingConfirm }) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const d = pending.decision;
  const close = () => pending.resolve(null);
  if (d.decision === 'block') {
    return (
      <Dialog title={t('safety.blocked')} onClose={close} footer={<button className="btn" onClick={close}>{t('common.close')}</button>}>
        <FindingList findings={d.findings} />
      </Dialog>
    );
  }
  const needsTyped = !!d.typed_phrase;
  const ok = !needsTyped || typed.trim() === d.typed_phrase;
  return (
    <Dialog
      title={t('safety.title')}
      onClose={close}
      wide={!!pending.sqlPreview}
      footer={
        <>
          <button className="btn" onClick={close}>{t('common.cancel')}</button>
          <button className={`btn ${pending.production ? 'btn-danger' : 'btn-primary'}`} disabled={!ok} onClick={() => pending.resolve({ token: d.token, typed: needsTyped ? typed.trim() : undefined })}>
            {t('safety.proceed')}
          </button>
        </>
      }
    >
      {pending.production && <div className="mb-3 rounded bg-danger-solid px-3 py-2 font-bold text-on-solid">{t('safety.productionBanner')}</div>}
      <FindingList findings={d.findings} />
      {pending.sqlPreview && <pre className="mb-3 max-h-64 overflow-auto rounded border border-border bg-panel p-2 font-mono text-xs">{pending.sqlPreview}</pre>}
      <p className="mb-3 text-xs text-muted">{t('safety.explainer')}</p>
      {needsTyped && (
        <label className="block">
          <span className="label">{t('safety.typeToConfirm', { phrase: d.typed_phrase })}</span>
          <input className="input font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      )}
    </Dialog>
  );
}
