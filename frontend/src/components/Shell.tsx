import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp, type Tab, type TabKind } from '../store';
import { EnvBadge } from './ui';
import { displayCombo, DEFAULT_KEYS } from '../lib/keys';
import { api } from '../lib/ipc';
import { ask } from './ask';

const KIND_ICON: Record<TabKind, string> = { query: '⌨', table: '▦', structure: '⚙', diff: '⇄', audit: '🛡', monitor: '📈', er: '⧉', settings: '⚙', import: '⤓', backup: '💾', history: '🕘', dashboard: '📊' };

export function TabBar() {
  const { tabs, activeTab, closeTab, updateTab, moveTab, sessions } = useApp();
  const drag = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  return (
    <div role="tablist" aria-label="Open tabs" className="flex h-8 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-panel px-1">
      {tabs.map((t, i) => {
        const s = t.sessionId ? sessions[t.sessionId] : undefined;
        const prod = s?.config.environment === 'production';
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeTab}
            tabIndex={t.id === activeTab ? 0 : -1}
            draggable
            onDragStart={() => (drag.current = t.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drag.current && moveTab(drag.current, i)}
            onClick={() => useApp.setState({ activeTab: t.id })}
            onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ id: t.id, x: e.clientX, y: e.clientY }); }}
            className={`group flex h-7 max-w-56 cursor-default items-center gap-1 rounded-t border border-b-0 px-2 ${t.id === activeTab ? 'border-border bg-bg' : 'border-transparent hover:bg-raised'} ${prod ? 'border-t-2 border-t-danger' : ''}`}
            style={s?.config.color ? { borderTopColor: s.config.color, borderTopWidth: 2 } : undefined}
          >
            <span aria-hidden>{t.pinned ? '📌' : KIND_ICON[t.kind]}</span>
            <span className="truncate">{t.title}</span>
            {!t.pinned && <button className="ml-1 rounded px-0.5 opacity-50 hover:bg-panel hover:opacity-100" aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>✕</button>}
          </div>
        );
      })}
      {menu && (
        <div role="menu" className="fixed z-50 w-44 rounded border border-border bg-raised py-1 shadow-lg" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
          {[
            ['Pin / unpin', () => { const t = tabs.find((x) => x.id === menu.id); if (t) updateTab(t.id, { pinned: !t.pinned }); }],
            ['Duplicate', () => { const t = tabs.find((x) => x.id === menu.id); if (t) useApp.getState().openTab({ ...t, id: undefined, title: t.title + ' copy', pinned: false } as Omit<Tab, 'id'>); }],
            ['Close others', () => tabs.filter((x) => x.id !== menu.id).forEach((x) => closeTab(x.id))],
            ['Close', () => closeTab(menu.id)],
          ].map(([l, f]) => (
            <button key={l as string} role="menuitem" className="block w-full px-3 py-1 text-left hover:bg-panel" onClick={() => { setMenu(null); (f as () => void)(); }}>{l as string}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function StatusBar() {
  const { t } = useTranslation();
  const { sessions, activeSession, info } = useApp();
  const s = activeSession ? sessions[activeSession] : undefined;
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-2 text-xs text-muted" role="contentinfo">
      {s ? (
        <>
          <span className={s.healthy ? 'text-ok' : 'text-danger'} aria-live="polite">● {s.healthy ? t('status.connected') : 'Connection lost'}</span>
          <span>{s.config.name}</span>
          <EnvBadge env={s.config.environment} />
          {s.config.read_only && <span className="text-warn">{t('safety.readOnlyBanner')}</span>}
          <span className="truncate">{s.server.version.split(',')[0]}</span>
          {s.latency != null && <span>{t('status.latency', { ms: s.latency })}</span>}
          <span>policy: {s.policy.name}</span>
        </>
      ) : (
        <span>{t('status.disconnected')}</span>
      )}
      <span className="ml-auto">{displayCombo(DEFAULT_KEYS.palette)} commands</span>
      <span>v{info?.version}</span>
    </footer>
  );
}

interface Cmd { id: string; label: string; hint?: string; run: () => void }

function fuzzy(q: string, s: string): number {
  q = q.toLowerCase();
  s = s.toLowerCase();
  if (!q) return 1;
  if (s.includes(q)) return 100 - s.indexOf(q);
  let i = 0;
  let score = 0;
  for (const c of s) {
    if (c === q[i]) {
      i++;
      score++;
    }
    if (i === q.length) return score;
  }
  return 0;
}

export function CommandPalette() {
  const { t } = useTranslation();
  const st = useApp();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const s = st.activeSession ? st.sessions[st.activeSession] : undefined;
  useEffect(() => input.current?.focus(), []);
  const close = () => useApp.setState({ paletteOpen: false });
  const tool = (kind: TabKind, title: string) => () => st.openTab({ kind, title, sessionId: s?.session_id });

  const cmds: Cmd[] = useMemo(() => {
    const list: Cmd[] = [
      { id: 'new-query', label: 'New SQL query', hint: displayCombo(DEFAULT_KEYS.newQuery), run: () => st.openTab({ kind: 'query', title: 'Query', sessionId: s?.session_id, sql: '' }) },
      { id: 'new-conn', label: t('conn.new'), run: () => useApp.setState({ connectionDialog: {} }) },
      { id: 'settings', label: t('settings.title'), hint: displayCombo(DEFAULT_KEYS.settings), run: tool('settings', t('settings.title')) },
      { id: 'audit', label: t('audit.title'), run: tool('audit', t('audit.title')) },
      { id: 'diff', label: t('diff.title'), run: tool('diff', t('diff.title')) },
      { id: 'reopen', label: 'Reopen closed tab', hint: displayCombo(DEFAULT_KEYS.reopenTab), run: st.reopenClosedTab },
      { id: 'export-conns', label: t('conn.exportDefs'), run: async () => { await navigator.clipboard.writeText(await api.exportConnections()); st.toast('info', 'Connection definitions copied (no secrets)'); } },
      { id: 'import-conns', label: t('conn.importDefs'), run: async () => { const j = await ask.text(t('conn.importDefs'), 'Paste exported JSON'); if (j) { const n = await api.importConnections(j); await st.reloadConnections(); st.toast('ok', `Imported ${n}`); } } },
      { id: 'theme', label: 'Toggle dark/light theme', run: () => st.setSetting('appearance.theme', document.documentElement.classList.contains('dark') ? 'light' : 'dark') },
      { id: 'focus', label: 'Toggle focus mode', hint: displayCombo(DEFAULT_KEYS.focusMode), run: () => st.setSetting('workspace.focus', !st.settings['workspace.focus']) },
      { id: 'fullscreen', label: 'Toggle fullscreen', run: async () => { const { getCurrentWindow } = await import('@tauri-apps/api/window'); const w = getCurrentWindow(); await w.setFullscreen(!(await w.isFullscreen())); } },
    ];
    if (s) {
      list.push(
        { id: 'er', label: `${t('er.title')} — ${s.config.name}`, run: tool('er', `ER ${s.activeSchema ?? ''}`) },
        { id: 'monitor', label: `${t('monitor.title')} — ${s.config.name}`, run: tool('monitor', t('monitor.title')) },
        { id: 'import', label: `${t('io.importTitle')} — ${s.config.name}`, run: tool('import', t('io.importTitle')) },
        { id: 'backup', label: `${t('backup.title')} — ${s.config.name}`, run: tool('backup', t('backup.title')) },
        { id: 'history', label: `${t('query.history')} / ${t('query.snippets')}`, run: tool('history', t('query.history')) },
        { id: 'dash', label: 'Dashboards', run: tool('dashboard', 'Dashboards') },
        { id: 'new-table', label: t('structure.newTable'), run: () => st.openTab({ kind: 'structure', title: t('structure.newTable'), sessionId: s.session_id, target: { schema: s.activeSchema, table: '' } }) },
        { id: 'disconnect', label: `${t('common.disconnect')} ${s.config.name}`, run: () => st.closeSession(s.session_id) },
      );
      for (const [schema, objs] of Object.entries(s.objects)) {
        for (const o of objs.slice(0, 5000)) {
          if (!['table', 'view', 'materialized_view'].includes(o.kind)) continue;
          list.push({ id: `obj:${schema}.${o.name}`, label: `${o.kind === 'table' ? '▦' : '◫'} ${schema ? schema + '.' : ''}${o.name}`, run: () => st.openTab({ kind: 'table', title: o.name, sessionId: s.session_id, target: { schema: o.schema, table: o.name } }) });
        }
      }
    }
    for (const c of st.connections) list.push({ id: `conn:${c.config.id}`, label: `⏻ ${c.config.name}`, hint: c.config.environment, run: () => st.openSession(c.config.id).catch((e) => st.toast('error', String(e.message ?? e))) });
    for (const tb of st.tabs) list.push({ id: `tab:${tb.id}`, label: `⇥ ${tb.title}`, run: () => useApp.setState({ activeTab: tb.id }) });
    return list;
  }, [st, s, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => cmds.map((c) => ({ c, score: fuzzy(q, c.label) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 50), [cmds, q]);
  const run = (c: Cmd) => {
    close();
    c.run();
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/30 pt-24" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="h-fit w-[min(640px,90vw)] overflow-hidden rounded-lg border border-border bg-raised shadow-2xl">
        <input
          ref={input}
          className="w-full border-b border-border bg-transparent px-3 py-2 text-base outline-none"
          placeholder={t('palette.placeholder')}
          value={q}
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={results[idx] ? `pc-${idx}` : undefined}
          onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
            if (e.key === 'Enter' && results[idx]) run(results[idx].c);
          }}
        />
        <ul id="palette-list" role="listbox" className="max-h-96 overflow-auto py-1">
          {results.length === 0 && <li className="px-3 py-2 text-muted">{t('palette.noMatches')}</li>}
          {results.map(({ c }, i) => (
            <li key={c.id} id={`pc-${i}`} role="option" aria-selected={i === idx} className={`flex cursor-default px-3 py-1 ${i === idx ? 'bg-accent/20' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => run(c)}>
              <span className="truncate">{c.label}</span>
              {c.hint && <span className="ml-auto pl-2 text-xs text-muted">{c.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
