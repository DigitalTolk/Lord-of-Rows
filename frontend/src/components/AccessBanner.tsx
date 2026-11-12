import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { durationLabel, managedState } from '../lib/access';
import { requestAgainFor } from '../lib/accessStore';
import { useApp } from '../store';
import { Icon } from './icons';

const nowSec = () => Math.floor(Date.now() / 1000);

/** Which warning applies: 15 minutes before the end, then again at 5 minutes. */
export function warningLevel(secsLeft: number): 15 | 5 | null {
  if (secsLeft <= 5 * 60) return 5;
  if (secsLeft <= 15 * 60) return 15;
  return null;
}

/**
 * Workspace banner for the active connection when its time-limited access is about to
 * end ("ends in 5 m — Request again"). Shown at 15 and again at 5 minutes; dismissible.
 */
export function AccessExpiryBanner() {
  const { t } = useTranslation();
  const s = useApp((x) => (x.activeSession ? x.sessions[x.activeSession] : undefined));
  const [now, setNow] = useState(nowSec);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const id = setInterval(() => setNow(nowSec()), 15_000);
    return () => clearInterval(id);
  }, []);
  const m = s?.config.managed_by;
  const st = s && !s.ended ? managedState(s.config, now) : null;
  const level = st?.left ? warningLevel(st.left.secs) : null;
  if (!s || !m || !st?.left || !level) return null;
  const key = `${s.session_id}:${level}`;
  if (dismissed.has(key)) return null;
  const d = durationLabel(st.left);
  return (
    <div role="status" className={`flex shrink-0 items-center gap-2 border-b px-3 py-1 text-[0.82rem] ${level === 5 ? 'border-danger/40 bg-danger/10 text-danger' : 'border-warn/40 bg-warn/10 text-warn'}`} data-access-warning={level}>
      <Icon name="key" size={14} />
      <span className="min-w-0 flex-1 truncate">{t('access.endsSoon', { name: s.config.name, time: t(d.key, d.vars) })}</span>
      <button className="btn h-6" onClick={() => void requestAgainFor(m)}>{t('access.requestAgain')}</button>
      <button className="icon-btn h-6 w-6" aria-label={t('common.close')} onClick={() => setDismissed((x) => new Set(x).add(key))}><Icon name="x" size={13} /></button>
    </div>
  );
}

/** Covers the active connection's tabs once its access ended (the text in the tabs is kept). */
export function AccessEndedOverlay() {
  const { t } = useTranslation();
  const s = useApp((x) => (x.activeSession ? x.sessions[x.activeSession] : undefined));
  if (!s?.ended) return null;
  const m = s.config.managed_by;
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg/85 backdrop-blur-[1px]" role="alertdialog" aria-modal="false" aria-labelledby="access-ended-title" aria-describedby="access-ended-body">
      <div className="flex max-w-[420px] flex-col items-center gap-2 rounded-xl border border-border bg-bg p-6 text-center shadow-lg">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-warn/15 text-warn"><Icon name="key" size={20} /></span>
        <h2 id="access-ended-title" className="text-base font-semibold">{t('access.endedTitle')}</h2>
        <p id="access-ended-body" className="text-sm text-muted">{t('access.endedBody', { name: s.config.name })}</p>
        <div className="mt-2 flex gap-2">
          <button className="btn" onClick={() => useApp.getState().dismissSession(s.session_id)}>{t('access.closeConnection')}</button>
          {m && <button className="btn btn-primary" data-autofocus onClick={() => void requestAgainFor(m)}>{t('access.requestAgain')}</button>}
        </div>
      </div>
    </div>
  );
}
