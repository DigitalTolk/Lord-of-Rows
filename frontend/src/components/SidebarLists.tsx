import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import type { HistoryEntry, Snippet } from '../lib/types';
import { errMsg, useApp } from '../store';
import { Icon } from './icons';

export type SidebarSection = 'items' | 'queries' | 'history';

/** Items | Queries | History switcher at the top of the sidebar. */
export function SidebarTabs({ value, onChange }: { value: SidebarSection; onChange: (v: SidebarSection) => void }) {
  const { t } = useTranslation();
  const items: [SidebarSection, string][] = [['items', t('tableWs.sidebarItems')], ['queries', t('tableWs.sidebarQueries')], ['history', t('tableWs.sidebarHistory')]];
  return (
    <div className="seg flex w-full" role="tablist" aria-label={t('tableWs.sidebarSections')}>
      {items.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className="flex-1" onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

const firstLine = (sql: string) => sql.trim().split('\n')[0].slice(0, 120);

/** Saved queries (snippets) for this connection plus global ones; click opens a query tab. */
export function SavedQueriesList({ sessionId, q }: { sessionId: string; q: string }) {
  const { t } = useTranslation();
  const { sessions, openTab, toast } = useApp();
  const s = sessions[sessionId];
  const [list, setList] = useState<Snippet[] | null>(null);
  useEffect(() => {
    let live = true;
    api.listSnippets().then((x) => { if (live) setList(x); }, (e) => toast('error', errMsg(e)));
    return () => {
      live = false;
    };
  }, [sessionId, toast]);
  const ql = q.toLowerCase();
  const shown = (list ?? [])
    .filter((x) => !x.connection_id || x.connection_id === s?.config.id)
    .filter((x) => !ql || x.name.toLowerCase().includes(ql) || x.sql.toLowerCase().includes(ql))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  if (list && !shown.length) return <p className="px-3 py-6 text-center text-muted">{t('tableWs.noQueries')}</p>;
  return (
    <ul className="pb-2" role="list" aria-label={t('tableWs.sidebarQueries')}>
      {shown.map((x) => (
        <li key={x.id}>
          <button className="mx-1.5 flex w-[calc(100%-12px)] items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-hover" title={x.sql.slice(0, 500)} onClick={() => openTab({ kind: 'query', title: x.name, sessionId, sql: x.sql })}>
            <Icon name={x.favorite ? 'star' : 'sql'} size={13} className={x.favorite ? 'shrink-0 text-warn' : 'shrink-0 text-muted'} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{x.name}</span>
              <span className="block truncate font-mono text-[0.75rem] text-muted">{firstLine(x.sql)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Query history of this connection (newest first); click opens it in a query tab. */
export function HistoryList({ sessionId, q }: { sessionId: string; q: string }) {
  const { t } = useTranslation();
  const { sessions, openTab, toast } = useApp();
  const s = sessions[sessionId];
  const connectionId = s?.config.id;
  const [list, setList] = useState<HistoryEntry[] | null>(null);
  useEffect(() => {
    if (!connectionId) return;
    let live = true;
    api.listHistory(connectionId, 300).then((x) => { if (live) setList(x); }, (e) => toast('error', errMsg(e)));
    return () => {
      live = false;
    };
  }, [connectionId, toast]);
  const ql = q.toLowerCase();
  const shown = (list ?? []).filter((h) => !ql || (h.sql ?? '').toLowerCase().includes(ql));
  if (list && !shown.length) return <p className="px-3 py-6 text-center text-muted">{t('tableWs.noHistory')}</p>;
  return (
    <ul className="pb-2" role="list" aria-label={t('tableWs.sidebarHistory')}>
      {shown.map((h) => (
        <li key={h.id}>
          <button className="mx-1.5 flex w-[calc(100%-12px)] items-start gap-2 rounded-md px-2 py-1 text-start hover:bg-hover disabled:opacity-50" disabled={!h.sql} title={h.sql?.slice(0, 500) ?? ''} onClick={() => h.sql && openTab({ kind: 'query', title: 'History', sessionId, sql: h.sql })}>
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${h.ok ? 'bg-ok' : 'bg-danger'}`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[0.8rem]">{h.sql ? firstLine(h.sql) : '—'}</span>
              <span className="block truncate text-[0.72rem] text-muted">{h.ts}{h.duration_ms != null ? ` · ${h.duration_ms} ms` : ''}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
