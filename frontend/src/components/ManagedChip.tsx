import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { durationLabel, managedState, shortDurationLabel } from '../lib/access';
import type { ConnectionConfig } from '../lib/types';
import { Icon } from './icons';

/**
 * Key badge for a connection made from an access request: time left ("2 h 5 m"),
 * amber in the last 15 minutes, or "Expired — request again".
 */
/**
 * `compact`: key icon only. `tiny`: key + the largest unit of the time left ("29d"), for narrow places like the connection rail.
 */
export function ManagedChip({ cfg, onSolid, compact, tiny }: { cfg: ConnectionConfig; onSolid?: boolean; compact?: boolean; tiny?: boolean }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);
  const s = managedState(cfg, now);
  if (!s) return null;
  const time = s.left ? t(durationLabel(s.left).key, durationLabel(s.left).vars) : null;
  const shown = s.expired ? t('access.expiredShort') : s.left ? (tiny ? t(shortDurationLabel(s.left).key, shortDurationLabel(s.left).vars) : time) : t('access.managedShort');
  const label = s.expired ? t('access.expiredChip') : time ? t('access.managedLeft', { time }) : t('access.managed');
  const soon = !!s.left && s.left.secs <= 15 * 60;
  const tone = onSolid ? 'border-on-solid/40 text-on-solid' : s.expired ? 'border-border text-muted' : soon ? 'border-warn/60 text-warn' : 'border-accent/40 text-accent';
  return (
    <span className={`inline-flex h-[18px] max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 text-[0.68rem] font-medium tabular-nums ${tone}`} title={label} role="img" aria-label={label} data-managed={s.expired ? 'expired' : 'active'}>
      <Icon name="key" size={11} aria-hidden />
      {!compact && <span aria-hidden className="truncate">{shown}</span>}
    </span>
  );
}
