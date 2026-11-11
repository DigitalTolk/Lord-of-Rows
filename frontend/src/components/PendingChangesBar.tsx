import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { displayCombo } from '../lib/keys';
import { selectTab, useTableWs } from '../lib/tableWorkspace';
import { errMsg, useApp } from '../store';
import { Icon } from './icons';
import { SqlPopover } from './SqlPopover';

/**
 * Top-toolbar controls for the active table tab's staged edits:
 * Discard · Preview (popover with the exact SQL) · Commit (⌘S).
 * Commit goes through the table view's normal path, so the safety policy's
 * confirmation dialog still appears for production / risky changes.
 */
export function PendingChangesBar() {
  const { t } = useTranslation();
  const activeTab = useApp((s) => s.tabs.find((x) => x.id === s.activeTab && (!x.sessionId || x.sessionId === s.activeSession)));
  const tabId = activeTab?.kind === 'table' ? activeTab.id : undefined;
  const ws = useTableWs(selectTab(tabId));
  const [preview, setPreview] = useState<{ sql: string; loading: boolean; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const close = useCallback(() => setPreview(null), []);
  if (!tabId) return null;
  const n = ws.pending;
  const disabled = n === 0 || !ws.actions || busy;

  const openPreview = async () => {
    if (preview) return setPreview(null);
    if (!ws.actions) return;
    setPreview({ sql: '', loading: true });
    try {
      const st = await ws.actions.statements();
      setPreview({ sql: st.map((s) => s + ';').join('\n'), loading: false });
    } catch (e) {
      setPreview({ sql: '', loading: false, error: errMsg(e) });
    }
  };
  const commit = async () => {
    if (!ws.actions) return;
    setPreview(null);
    setBusy(true);
    try {
      await ws.actions.commit();
    } finally {
      setBusy(false);
    }
  };
  const discard = () => {
    setPreview(null);
    ws.actions?.discard();
  };

  return (
    <div className="flex items-center gap-0.5" role="group" aria-label={t('tableWs.pendingTitle')}>
      <button className="icon-btn" disabled={disabled} aria-label={t('tableWs.pendingDiscard')} title={t('tableWs.pendingDiscard')} onClick={discard}>
        <Icon name="xCircle" />
      </button>
      <div className="relative">
        <button className={`icon-btn ${preview ? 'bg-hover text-fg' : ''}`} disabled={disabled} aria-label={t('tableWs.pendingPreview')} title={t('tableWs.pendingPreview')} aria-expanded={!!preview} onClick={() => void openPreview()}>
          <Icon name="eye" />
        </button>
        {preview && (
          <SqlPopover
            title={t('tableWs.pendingTitle')}
            sql={preview.sql}
            loading={preview.loading}
            error={preview.error}
            align="left"
            onClose={close}
            actions={
              <>
                <button className="btn h-7 mr-auto" disabled={!preview.sql} onClick={() => { ws.actions?.openInQueryTab(preview.sql); setPreview(null); }}>{t('tableWs.openInWindow')}</button>
                <button className="btn h-7" onClick={discard}>{t('common.discard')}</button>
                <button className="btn btn-primary h-7" disabled={!preview.sql || busy} onClick={() => void commit()}>{t('common.commit')}</button>
              </>
            }
          />
        )}
      </div>
      <button
        className={`btn h-7 gap-1.5 ${n > 0 ? 'btn-primary' : ''}`}
        disabled={disabled}
        aria-label={t('tableWs.pendingCommit')}
        title={`${t('tableWs.pendingCommit')} (${displayCombo('Mod+S')})`}
        onClick={() => void commit()}
      >
        {t('common.commit')}
        {n > 0 && <span className="min-w-[18px] rounded-full bg-on-solid/25 px-1 text-center text-[0.75rem] leading-[18px] tabular-nums" aria-label={t('tableWs.pendingCount', { n })}>{n}</span>}
      </button>
    </div>
  );
}
