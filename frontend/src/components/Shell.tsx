import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp, type Tab, type TabKind } from '../store';
import { EnvBadge, isContextMenuKey, menuAnchor, MenuPopup } from './ui';
import { Icon, type IconName } from './icons';
import { EngineBadge } from './EngineBadge';
import { displayCombo, DEFAULT_KEYS } from '../lib/keys';
import { api } from '../lib/ipc';
import { fmtNumber } from '../lib/format';
import { ask } from './ask';
import { ThemeToggle } from './ThemeToggle';
import { PendingChangesBar } from './PendingChangesBar';
import { StatusPill } from './StatusPill';
import { useTableWs } from '../lib/tableWorkspace';
import { openDatabasePicker } from './OpenDatabaseDialog';

const KIND_ICON: Record<TabKind, IconName> = { query: 'sql', table: 'table', structure: 'structure', diff: 'copy', audit: 'shield', monitor: 'pulse', er: 'diagram', settings: 'gear', import: 'download', backup: 'db', history: 'history', dashboard: 'chart' };

/** DOM ids shared by the tab bar and the tab panels in App (aria-controls / aria-labelledby). */
export const tabDomId = (id: string) => `tab-${id}`;
export const panelDomId = (id: string) => `tabpanel-${id}`;

const isRtl = () => typeof document !== 'undefined' && document.documentElement.dir === 'rtl';

export function TopBar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { t } = useTranslation();
  const { sessions, activeSession, openTab, closeSession, loadObjects } = useApp();
  const s = activeSession ? sessions[activeSession] : undefined;
  const activeTable = useApp((st) => st.tabs.find((x) => x.id === st.activeTab && x.kind === 'table' && x.sessionId === st.activeSession)?.target?.table);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const tool = (kind: TabKind, title: string) => () => openTab({ kind, title, sessionId: s?.session_id });
  return (
    <header className="relative flex h-[42px] shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
      <button className="icon-btn" aria-label={t('shell.toggleSidebar')} title={t('shell.toggleSidebar')} onClick={onToggleSidebar}><Icon name="sidebar" /></button>
      <button className="icon-btn" aria-label={t('conn.title')} title={t('conn.title')} onClick={() => useApp.setState({ launcher: true })}><Icon name="power" /></button>
      <button className="icon-btn" aria-label={t('windows.new')} title={`${t('windows.new')} (${displayCombo(DEFAULT_KEYS.newWindow)})`} onClick={() => void useApp.getState().openWindow()}><Icon name="window" /></button>
      <span className="mx-1 h-5 border-s border-border" aria-hidden />
      <button className="icon-btn" title={`${t('query.newTab')} (${displayCombo(DEFAULT_KEYS.newQuery)})`} aria-label={t('query.newTab')} disabled={!s} onClick={() => openTab({ kind: 'query', title: t('shell.queryTab'), sessionId: s?.session_id, sql: '' })}><Icon name="sql" /></button>
      <button className="icon-btn" title={`${t('openDb.title')} (${displayCombo(DEFAULT_KEYS.openDatabase)})`} aria-label={t('openDb.title')} aria-haspopup="dialog" disabled={!s} onClick={() => openDatabasePicker()}><Icon name="db" /></button>
      <button className="icon-btn" title={t('common.refresh')} aria-label={t('common.refresh')} disabled={!s} onClick={() => s && loadObjects(s.session_id, s.activeSchema)}><Icon name="refresh" /></button>
      <button className="icon-btn" title={t('io.importTitle')} aria-label={t('io.importTitle')} disabled={!s} onClick={tool('import', t('io.importTitle'))}><Icon name="download" /></button>
      <button className="icon-btn" title={t('backup.title')} aria-label={t('backup.title')} disabled={!s} onClick={tool('backup', t('backup.title'))}><Icon name="upload" /></button>
      <span className="mx-1 h-5 border-s border-border" aria-hidden />
      <PendingChangesBar />

      {/* Connection pill */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        {s ? (
          <StatusPill s={s} table={activeTable} expanded={!!menu} onClick={(e) => setMenu(menu ? null : menuAnchor(e.currentTarget))} />
        ) : (
          <span className="text-muted">{t('status.disconnected')}</span>
        )}
      </div>
      {menu && s && (
        <MenuPopup x={menu.x} y={menu.y} className="w-64" label={t('conn.title')} onClose={() => setMenu(null)}>
          {Object.values(sessions).map((x) => (
            <button key={x.session_id} role="menuitem" className={`menu-item flex items-center gap-2 ${x.session_id === s.session_id ? 'font-semibold' : ''}`} onClick={() => { useApp.getState().switchSession(x.session_id); setMenu(null); }}>
              <EngineBadge engine={x.config.engine} size={18} /> <span className="truncate">{x.config.name}</span>
            </button>
          ))}
          <div role="separator" className="my-1 border-t border-border" />
          <button role="menuitem" className="menu-item" onClick={() => { useApp.setState({ launcher: true }); setMenu(null); }}>{t('shell.openAnother')}</button>
          <button role="menuitem" className="menu-item" onClick={() => { void useApp.getState().openWindow(); setMenu(null); }}>{t('windows.new')}</button>
          <button role="menuitem" className="menu-item text-danger" onClick={() => { void closeSession(s.session_id); setMenu(null); }}>{t('shell.disconnectName', { name: s.config.name })}</button>
        </MenuPopup>
      )}

      <div className="ms-auto flex items-center gap-1">
        <button className="flex h-7 w-52 items-center gap-2 rounded-md border border-border bg-raised px-2 text-muted hover:bg-hover" onClick={() => useApp.setState({ paletteOpen: true })}>
          <Icon name="search" size={13} /> <span className="flex-1 text-start">{t('shell.search')}</span> <span className="kbd" aria-hidden>{displayCombo(DEFAULT_KEYS.palette)}</span>
        </button>
        <button className="icon-btn" title={t('er.title')} aria-label={t('er.title')} disabled={!s} onClick={tool('er', t('er.title'))}><Icon name="diagram" /></button>
        <button className="icon-btn" title={t('monitor.title')} aria-label={t('monitor.title')} disabled={!s} onClick={tool('monitor', t('monitor.title'))}><Icon name="pulse" /></button>
        <button className="icon-btn" title={t('shell.dashboards')} aria-label={t('shell.dashboards')} disabled={!s} onClick={tool('dashboard', t('shell.dashboards'))}><Icon name="chart" /></button>
        <button className="icon-btn" title={t('query.history')} aria-label={t('query.history')} onClick={tool('history', t('query.history'))}><Icon name="history" /></button>
        <button className="icon-btn" title={t('audit.title')} aria-label={t('audit.title')} onClick={() => openTab({ kind: 'audit', title: t('audit.title') })}><Icon name="shield" /></button>
        <ThemeToggle />
        <button className="icon-btn" title={t('settings.title')} aria-label={t('settings.title')} onClick={() => openTab({ kind: 'settings', title: t('settings.title') })}><Icon name="gear" /></button>
      </div>
    </header>
  );
}

export function TabBar() {
  const { t } = useTranslation();
  const { tabs: allTabs, activeTab, closeTab, updateTab, moveTab, sessions, activeSession, openTab } = useApp();
  const tabs = allTabs.filter((x) => !x.sessionId || x.sessionId === activeSession);
  const drag = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const wsTabs = useTableWs((w) => w.tabs);
  // Roving tabindex: the active tab (or the first one) is the single Tab stop of the strip.
  const focusable = tabs.some((x) => x.id === activeTab) ? activeTab : tabs[0]?.id;

  const activate = (id: string) => {
    useApp.setState({ activeTab: id });
    requestAnimationFrame(() => document.getElementById(tabDomId(id))?.focus());
  };
  const onKeyDown = (e: React.KeyboardEvent, tab: Tab, i: number) => {
    const fwd = isRtl() ? 'ArrowLeft' : 'ArrowRight';
    const back = isRtl() ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === fwd) activate(tabs[(i + 1) % tabs.length].id);
    else if (e.key === back) activate(tabs[(i - 1 + tabs.length) % tabs.length].id);
    else if (e.key === 'Home') activate(tabs[0].id);
    else if (e.key === 'End') activate(tabs[tabs.length - 1].id);
    else if (e.key === 'Delete' && !tab.pinned) {
      const next = tabs[i + 1] ?? tabs[i - 1];
      closeTab(tab.id);
      if (next) activate(next.id);
    } else if (isContextMenuKey(e)) setMenu({ id: tab.id, ...menuAnchor(e.currentTarget) });
    else return;
    e.preventDefault();
  };

  return (
    <div className="flex h-[30px] shrink-0 items-stretch border-b border-border bg-panel">
      <div role="tablist" aria-label={t('shell.openTabs')} className="flex min-w-0 items-stretch overflow-x-auto">
        {tabs.map((tab, i) => {
          const s = tab.sessionId ? sessions[tab.sessionId] : undefined;
          const prod = s?.config.environment === 'production';
          const selected = tab.id === activeTab;
          const pending = tab.kind === 'table' ? wsTabs[tab.id]?.pending ?? 0 : 0;
          const pendingText = pending ? t('tree.pendingChanges', { count: pending }) : undefined;
          return (
            <div
              key={tab.id}
              id={tabDomId(tab.id)}
              role="tab"
              aria-selected={selected}
              aria-controls={panelDomId(tab.id)}
              aria-description={pendingText}
              tabIndex={tab.id === focusable ? 0 : -1}
              draggable
              onDragStart={() => (drag.current = tab.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drag.current && moveTab(drag.current, allTabs.findIndex((x) => x.id === tabs[i].id))}
              onClick={() => useApp.setState({ activeTab: tab.id })}
              onKeyDown={(e) => onKeyDown(e, tab, i)}
              onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ id: tab.id, x: e.clientX, y: e.clientY }); }}
              className={`group relative flex min-w-[120px] max-w-[220px] cursor-default items-center gap-1.5 border-e border-border px-3 text-[0.92rem] ${selected ? 'bg-bg text-fg' : 'text-muted hover:bg-hover hover:text-fg'}`}
            >
              {selected && <span className="absolute inset-x-0 top-0 h-[2px]" style={{ background: prod ? 'rgb(var(--danger))' : s?.config.color ?? 'rgb(var(--accent))' }} />}
              <Icon name={KIND_ICON[tab.kind]} size={13} className="shrink-0" />
              <span className="flex-1 truncate" dir="auto">{tab.title}</span>
              {pending > 0 && <span data-testid="tab-pending" className="h-2 w-2 shrink-0 rounded-full bg-warn" title={pendingText} aria-hidden />}
              {tab.pinned ? <span role="img" aria-label={t('shell.pinned')} className="text-[0.7rem]">●</span> : (
                // Mouse affordance only: any focusable control inside role=tab fails axe nested-interactive
                // (even with tabIndex -1). Keyboard users close with Delete on the tab or the tab menu.
                <span aria-hidden title={t('shell.closeTab', { title: tab.title })} className="flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-hover group-hover:opacity-100 group-focus-visible:opacity-100" onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}><Icon name="x" size={11} /></span>
              )}
            </div>
          );
        })}
      </div>
      <button className="flex w-9 shrink-0 items-center justify-center text-muted hover:bg-hover hover:text-fg" title={`${t('shell.newSqlQuery')} (${displayCombo(DEFAULT_KEYS.newQuery)})`} aria-label={t('shell.newSqlQuery')} disabled={!activeSession} onClick={() => openTab({ kind: 'query', title: t('shell.queryTab'), sessionId: activeSession, sql: '' })}>
        <Icon name="plus" size={15} />
      </button>
      {menu && (
        <MenuPopup x={menu.x} y={menu.y} className="w-44" onClose={() => setMenu(null)}>
          {([
            [t('shell.pinToggle'), () => { const x = tabs.find((y) => y.id === menu.id); if (x) updateTab(x.id, { pinned: !x.pinned }); }],
            [t('common.duplicate'), () => { const x = tabs.find((y) => y.id === menu.id); if (x) useApp.getState().openTab({ ...x, id: undefined, title: t('shell.copyOf', { title: x.title }), pinned: false } as Omit<Tab, 'id'>); }],
            [t('shell.closeOthers'), () => tabs.filter((x) => x.id !== menu.id).forEach((x) => closeTab(x.id))],
            [t('common.close'), () => closeTab(menu.id)],
          ] as const).map(([l, f]) => (
            <button key={l} role="menuitem" className="menu-item" onClick={() => { setMenu(null); f(); }}>{l}</button>
          ))}
        </MenuPopup>
      )}
    </div>
  );
}

export function StatusBar() {
  const { t } = useTranslation();
  const { sessions, activeSession, info } = useApp();
  const s = activeSession ? sessions[activeSession] : undefined;
  return (
    <footer className="flex h-[22px] shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[0.8rem] text-muted">
      {s ? (
        <>
          <span className={s.healthy ? 'text-ok' : 'text-danger'} role="status"><span aria-hidden>● </span>{s.healthy ? t('status.connected') : t('status.lost')}</span>
          <span>{s.config.name}</span>
          <EnvBadge env={s.config.environment} />
          {s.config.read_only && <span className="text-warn">{t('safety.readOnlyBanner')}</span>}
          <span className="truncate" dir="auto">{s.server.version.split(',')[0]}</span>
          {s.latency != null && <span>{t('status.latency', { ms: s.latency })}</span>}
          <span>{t('status.policy', { name: s.policy.name })}</span>
        </>
      ) : (
        <span>{t('status.disconnected')}</span>
      )}
      <span className="ms-auto">{t('status.commands', { key: displayCombo(DEFAULT_KEYS.palette) })}</span>
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
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => {
      // Return focus to where it was unless the command moved it (e.g. into a new tab).
      const a = document.activeElement;
      if (prev?.isConnected && (!a || a === document.body || !a.isConnected)) prev.focus();
    };
  }, []);
  const close = () => useApp.setState({ paletteOpen: false });
  const tool = (kind: TabKind, title: string) => () => st.openTab({ kind, title, sessionId: s?.session_id });

  const cmds: Cmd[] = useMemo(() => {
    const list: Cmd[] = [
      { id: 'new-query', label: t('shell.newSqlQuery'), hint: displayCombo(DEFAULT_KEYS.newQuery), run: () => st.openTab({ kind: 'query', title: t('shell.queryTab'), sessionId: s?.session_id, sql: '' }) },
      { id: 'new-conn', label: t('conn.new'), hint: displayCombo(DEFAULT_KEYS.newConnection), run: () => useApp.setState({ connectionDialog: {} }) },
      { id: 'new-window', label: t('windows.new'), hint: displayCombo(DEFAULT_KEYS.newWindow), run: () => void st.openWindow() },
      { id: 'close-window', label: t('windows.close'), hint: displayCombo(DEFAULT_KEYS.closeWindow), run: () => void st.closeWindow() },
      { id: 'settings', label: t('settings.title'), hint: displayCombo(DEFAULT_KEYS.settings), run: tool('settings', t('settings.title')) },
      { id: 'audit', label: t('audit.title'), run: tool('audit', t('audit.title')) },
      { id: 'diff', label: t('diff.title'), run: tool('diff', t('diff.title')) },
      { id: 'reopen', label: t('palette.reopenTab'), hint: displayCombo(DEFAULT_KEYS.reopenTab), run: st.reopenClosedTab },
      { id: 'export-conns', label: t('conn.exportDefs'), run: async () => { await navigator.clipboard.writeText(await api.exportConnections()); st.toast('info', t('palette.exportedDefs')); } },
      { id: 'import-conns', label: t('conn.importDefs'), run: async () => { const j = await ask.text(t('conn.importDefs'), t('palette.pasteJson')); if (j) { const n = await api.importConnections(j); await st.reloadConnections(); st.toast('ok', t('palette.importedDefs', { count: n, formatted: fmtNumber(n) })); } } },
      { id: 'theme', label: t('palette.toggleTheme'), run: () => st.setSetting('appearance.theme', document.documentElement.classList.contains('dark') ? 'light' : 'dark') },
      { id: 'focus', label: t('palette.toggleFocus'), hint: displayCombo(DEFAULT_KEYS.focusMode), run: () => st.setSetting('workspace.focus', !st.settings['workspace.focus']) },
      { id: 'fullscreen', label: t('palette.toggleFullscreen'), run: async () => { const { getCurrentWindow } = await import('@tauri-apps/api/window'); const w = getCurrentWindow(); await w.setFullscreen(!(await w.isFullscreen())); } },
    ];
    if (s) {
      list.push(
        { id: 'open-db', label: t('openDb.paletteLabel'), hint: displayCombo(DEFAULT_KEYS.openDatabase), run: () => openDatabasePicker() },
        { id: 'er', label: `${t('er.title')} — ${s.config.name}`, run: tool('er', `ER ${s.activeSchema ?? ''}`) },
        { id: 'monitor', label: `${t('monitor.title')} — ${s.config.name}`, run: tool('monitor', t('monitor.title')) },
        { id: 'import', label: `${t('io.importTitle')} — ${s.config.name}`, run: tool('import', t('io.importTitle')) },
        { id: 'backup', label: `${t('backup.title')} — ${s.config.name}`, run: tool('backup', t('backup.title')) },
        { id: 'history', label: `${t('query.history')} / ${t('query.snippets')}`, run: tool('history', t('query.history')) },
        { id: 'dash', label: t('shell.dashboards'), run: tool('dashboard', t('shell.dashboards')) },
        { id: 'new-table', label: t('structure.newTable'), run: () => st.openTab({ kind: 'structure', title: t('structure.newTable'), sessionId: s.session_id, target: { schema: s.activeSchema, table: '' } }) },
        { id: 'disconnect', label: t('shell.disconnectName', { name: s.config.name }), run: () => st.closeSession(s.session_id) },
      );
      for (const [schema, objs] of Object.entries(s.objects)) {
        for (const o of objs.slice(0, 5000)) {
          if (!['table', 'view', 'materialized_view'].includes(o.kind)) continue;
          list.push({ id: `obj:${schema}.${o.name}`, label: `${o.kind === 'table' ? '▦' : '◫'} ${schema ? schema + '.' : ''}${o.name}`, run: () => st.openTab({ kind: 'table', title: o.name, sessionId: s.session_id, target: { schema: o.schema, table: o.name } }) });
        }
      }
    }
    const activeQuery = st.tabs.find((x) => x.id === st.activeTab && x.kind === 'query');
    if (activeQuery) {
      list.push(
        { id: 'split-right', label: activeQuery.split === 'right' ? t('split.close') : t('split.right'), hint: displayCombo(DEFAULT_KEYS.splitEditor), run: () => st.toggleSplit(activeQuery.id, 'right') },
        { id: 'split-down', label: activeQuery.split === 'down' ? t('split.close') : t('split.down'), run: () => st.toggleSplit(activeQuery.id, 'down') },
      );
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
    <div className="fixed inset-0 z-50 flex justify-center bg-overlay/40 pt-24" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-modal="true" aria-label={t('palette.title')} className="h-fit w-[min(620px,90vw)] overflow-hidden rounded-xl border border-border bg-raised shadow-[0_20px_60px_rgb(var(--shadow)/0.3)]">
        <input
          ref={input}
          className="h-11 w-full border-b border-border bg-transparent px-4 text-[1.05rem] text-fg outline-none placeholder:text-muted"
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.title')}
          value={q}
          role="combobox"
          aria-expanded
          aria-autocomplete="list"
          aria-controls="palette-list"
          aria-activedescendant={results[idx] ? `pc-${idx}` : undefined}
          onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'Tab') e.preventDefault(); // the input is the only stop: keep focus inside the modal
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
            if (e.key === 'Enter' && results[idx]) run(results[idx].c);
          }}
        />
        <ul id="palette-list" role="listbox" aria-label={t('palette.results')} className="max-h-96 overflow-auto py-1">
          {results.length === 0 && <li role="option" aria-selected={false} aria-disabled className="px-3 py-2 text-muted">{t('palette.noMatches')}</li>}
          {results.map(({ c }, i) => (
            <li key={c.id} id={`pc-${i}`} role="option" aria-selected={i === idx} className={`mx-1 flex cursor-default rounded-md px-3 py-1.5 ${i === idx ? 'row-selected' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => run(c)}>
              <span className="truncate" dir="auto">{c.label}</span>
              {c.hint && <span className={`ms-auto ps-2 text-xs ${i === idx ? 'text-on-solid' : 'text-muted'}`}>{c.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
