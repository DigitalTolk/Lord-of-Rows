import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Toolbar } from '../components/ui';
import { api } from '../lib/ipc';
import type { HistoryEntry, Snippet } from '../lib/types';
import { useApp, type Tab } from '../store';

export function HistoryView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const { sessions, openTab } = useApp();
  const s = tab.sessionId ? sessions[tab.sessionId] : undefined;
  const [hist, setHist] = useState<HistoryEntry[]>([]);
  const [snips, setSnips] = useState<Snippet[]>([]);
  const [q, setQ] = useState('');
  const load = async () => {
    setSnips(await api.listSnippets());
    if (s) setHist(await api.listHistory(s.config.id, 1000));
  };
  useEffect(() => {
    void load();
  }, [s?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = (sql: string, title: string) => openTab({ kind: 'query', title, sessionId: s?.session_id, sql });
  const ql = q.toLowerCase();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <span className="font-semibold">{t('history.title')}</span>
        <input className="input w-64" placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('common.search')} />
      </Toolbar>
      <div className="grid min-h-0 flex-1 grid-cols-2">
        <section className="min-h-0 overflow-auto border-e border-border p-2" aria-label={t('query.snippets')}>
          <h3 className="mb-1 font-semibold">{t('query.snippets')}</h3>
          {snips.filter((x) => !ql || x.name.toLowerCase().includes(ql) || x.sql.toLowerCase().includes(ql)).map((x) => (
            <div key={x.id} className="mb-1 rounded border border-border p-2">
              <div className="flex items-center gap-2">
                <button className="font-medium hover:underline" onClick={() => open(x.sql, x.name)}>{x.favorite ? '★ ' : ''}{x.name}</button>
                <button className="btn btn-ghost ms-auto px-1" aria-label={t('history.toggleFavorite')} aria-pressed={!!x.favorite} onClick={async () => { await api.saveSnippet({ ...x, favorite: !x.favorite }); void load(); }}>☆</button>
                <button className="btn btn-ghost px-1 text-danger" aria-label={t('history.deleteSnippet', { name: x.name })} onClick={async () => { await api.deleteSnippet(x.id); void load(); }}>✕</button>
              </div>
              <pre dir="ltr" className="mt-1 max-h-20 overflow-hidden font-mono text-xs text-muted">{x.sql}</pre>
            </div>
          ))}
        </section>
        <section className="min-h-0 overflow-auto p-2" aria-label={t('query.history')}>
          <h3 className="mb-1 font-semibold">{t('query.history')} {s ? `— ${s.config.name}` : ''}</h3>
          {!s && <p className="text-muted">{t('status.disconnected')}</p>}
          {hist.filter((h) => !ql || (h.sql ?? '').toLowerCase().includes(ql)).map((h) => (
            <button key={h.id} className="mb-1 block w-full rounded border border-border p-2 text-start hover:bg-panel" onClick={() => h.sql && open(h.sql, t('query.history'))} disabled={!h.sql}>
              <div className="flex gap-2 text-xs text-muted">
                <span>{h.ts}</span><span>{h.duration_ms} ms</span><span className={h.ok ? 'text-ok' : 'text-danger'}>{h.ok ? t('history.ok') : t('history.error')}</span>
              </div>
              {h.sql ? <pre dir="ltr" className="max-h-16 overflow-hidden font-mono text-xs">{h.sql}</pre> : <p className="text-xs italic text-muted">{t('history.notStored')}</p>}
            </button>
          ))}
        </section>
      </div>
    </div>
  );
}
