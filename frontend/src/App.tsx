import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AskHost } from './components/ask';
import { useConfirm } from './components/confirm';
import { ConnectionDialog } from './components/ConnectionDialog';
import { SafetyDialog } from './components/SafetyDialog';
import { CommandPalette, panelDomId, StatusBar, TabBar, tabDomId, TopBar } from './components/Shell';
import { Welcome } from './components/Welcome';
import { OpenDatabaseHost, useDbPicker } from './components/OpenDatabaseDialog';
import { ImportConnectionsHost } from './components/ImportConnectionsDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ConnectionRail } from './components/ConnectionRail';
import { Icon } from './components/icons';
import { Sidebar } from './components/Sidebar';
import { api } from './lib/ipc';
import { applyLanguage, LANGUAGE_SETTING, parseLanguagePref } from './i18n';
import { applyThemeClasses, cachedThemePref, cacheThemePref, onOsThemeChange, osTheme, parseThemePref, resolveTheme, THEME_SETTING } from './lib/theme';
import { DEFAULT_KEYS, displayCombo, eventCombo, matches, type KeyAction } from './lib/keys';
import { currentWindowLabel, persistsWorkspace, setWindowTitle, windowTitle } from './lib/windows';
import { errMsg, useApp, workspaceSnapshot, type Tab } from './store';
import { AuditView } from './views/AuditView';
import { BackupView } from './views/BackupView';
import { DashboardView } from './views/DashboardView';
import { DiffView } from './views/DiffView';
import { ERView } from './views/ERView';
import { HistoryView } from './views/HistoryView';
import { ImportView } from './views/ImportView';
import { MonitorView } from './views/MonitorView';
import { QuerySplitView } from './views/QuerySplitView';
import { SettingsView } from './views/SettingsView';
import { StructureView } from './views/StructureView';
import { TableView } from './views/TableView';
import { RedisKeysView } from './views/RedisKeysView';

/** Key-value sessions browse keys (SCAN-paged key grid); every other engine gets the table view. */
function TableOrKeys({ tab }: { tab: Tab }) {
  const keyValue = useApp((s) => (tab.sessionId ? s.sessions[tab.sessionId]?.config.engine === 'redis' : false));
  return keyValue ? <RedisKeysView tab={tab} /> : <TableView tab={tab} />;
}

function View({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case 'query': return <QuerySplitView tab={tab} />;
    case 'table': return <TableOrKeys tab={tab} />;
    case 'structure': return <StructureView tab={tab} />;
    case 'diff': return <DiffView />;
    case 'audit': return <AuditView />;
    case 'monitor': return <MonitorView tab={tab} />;
    case 'er': return <ERView tab={tab} />;
    case 'settings': return <SettingsView />;
    case 'import': return <ImportView tab={tab} />;
    case 'backup': return <BackupView tab={tab} />;
    case 'history': return <HistoryView tab={tab} />;
    case 'dashboard': return <DashboardView tab={tab} />;
  }
}

function useTheme() {
  const pref = parseThemePref(useApp((s) => s.settings[THEME_SETTING]) ?? cachedThemePref());
  const reduceMotion = useApp((s) => !!s.settings['a11y.reduceMotion']);
  const scale = useApp((s) => s.settings['appearance.scale']);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('reduce-motion', reduceMotion);
    root.style.setProperty('--ui-scale', String(scale ?? 1));
  }, [reduceMotion, scale]);
  useEffect(() => {
    // System mode follows OS colour-scheme / contrast changes live (incl. Monaco via useEditorTheme).
    cacheThemePref(pref);
    const apply = () => applyThemeClasses(document.documentElement, resolveTheme(pref, osTheme()));
    apply();
    return onOsThemeChange(apply);
  }, [pref]);
}

/** Applies the persisted UI language (and <html lang/dir>) once settings have loaded. */
function useLanguage() {
  const raw = useApp((s) => s.settings[LANGUAGE_SETTING]);
  const loaded = useApp((s) => !!s.info);
  useEffect(() => {
    if (loaded) applyLanguage(parseLanguagePref(raw));
  }, [raw, loaded]);
}

/** Periodic health check with bounded auto-reconnect is surfaced in the status bar. */
function useHealth() {
  useEffect(() => {
    const h = setInterval(async () => {
      const { sessions } = useApp.getState();
      for (const s of Object.values(sessions)) {
        try {
          const ms = await api.pingSession(s.session_id);
          useApp.setState((st) => ({ sessions: { ...st.sessions, [s.session_id]: { ...st.sessions[s.session_id], latency: ms, healthy: true } } }));
        } catch {
          useApp.setState((st) => (st.sessions[s.session_id] ? { sessions: { ...st.sessions, [s.session_id]: { ...st.sessions[s.session_id], healthy: false } } } : {}));
        }
      }
    }, 30_000);
    return () => clearInterval(h);
  }, []);
}

export default function App() {
  const { t } = useTranslation();
  const st = useApp();
  const pending = useConfirm((s) => s.pending);
  const [sidebar, setSidebar] = useState(true);
  const [sidebarW, setSidebarW] = useState(280);
  const [error, setError] = useState<string | null>(null);
  useTheme();
  useLanguage();
  useHealth();

  useEffect(() => {
    st.init().catch((e) => setError(errMsg(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist query tabs (text + split layout) for session restore. Only the main
  // window persists, so extra windows never overwrite its saved workspace.
  useEffect(() => {
    if (!persistsWorkspace(currentWindowLabel())) return;
    const h = setTimeout(() => {
      void api.setSetting('workspace.tabs', workspaceSnapshot(st.tabs)).catch(() => undefined);
    }, 1000);
    return () => clearTimeout(h);
  }, [st.tabs]);

  // Window title: "Lord of the Rows — <connection>".
  const titleConnection = st.activeSession ? st.sessions[st.activeSession]?.config.name : undefined;
  useEffect(() => {
    void setWindowTitle(windowTitle(t('app.name'), titleConnection));
  }, [titleConnection, t]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = eventCombo(e);
      const binding = (a: KeyAction) => (st.settings[`keys.${a}`] as string) ?? DEFAULT_KEYS[a];
      const is = (a: KeyAction) => matches(combo, binding(a));
      const s = st.activeSession ? st.sessions[st.activeSession] : undefined;
      const tabs = st.tabs.filter((x) => !x.sessionId || x.sessionId === st.activeSession);
      const digit = /^Mod\+([1-9])$/.exec(combo);
      if (digit) {
        const ids = Object.keys(st.sessions);
        const id = ids[Number(digit[1]) - 1];
        if (id) {
          st.switchSession(id);
          e.preventDefault();
          return;
        }
      }
      const cur = tabs.findIndex((x) => x.id === st.activeTab);
      let handled = true;
      if (is('palette') || is('quickOpen')) useApp.setState({ paletteOpen: !st.paletteOpen });
      else if (is('openDatabase') && s) useDbPicker.setState({ open: !useDbPicker.getState().open });
      else if (is('newQuery')) st.openTab({ kind: 'query', title: t('shell.queryTab'), sessionId: s?.session_id, sql: '' });
      else if (is('closeTab') && st.activeTab) st.closeTab(st.activeTab);
      else if (is('reopenTab')) st.reopenClosedTab();
      else if (is('nextTab') && tabs.length) useApp.setState({ activeTab: tabs[(cur + 1) % tabs.length].id });
      else if (is('prevTab') && tabs.length) useApp.setState({ activeTab: tabs[(cur - 1 + tabs.length) % tabs.length].id });
      else if (is('settings')) st.openTab({ kind: 'settings', title: t('settings.title') });
      else if (is('toggleSidebar')) setSidebar((x) => !x);
      else if (is('newConnection')) useApp.setState({ connectionDialog: {} });
      else if (is('newWindow')) void st.openWindow();
      else if (is('closeWindow')) void st.closeWindow();
      else if (is('splitEditor') && (tabs[cur] ?? tabs[0])?.kind === 'query') st.toggleSplit((tabs[cur] ?? tabs[0]).id);
      else if (is('focusMode')) void st.setSetting('workspace.focus', !st.settings['workspace.focus']);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [st, t]);

  const active = st.tabs.find((x) => x.id === st.activeTab && (!x.sessionId || x.sessionId === st.activeSession)) ?? st.tabs.find((x) => !x.sessionId || x.sessionId === st.activeSession);
  const activeSession = active?.sessionId ? st.sessions[active.sessionId] : st.activeSession ? st.sessions[st.activeSession] : undefined;
  const focus = !!st.settings['workspace.focus'];

  const clampW = (w: number) => Math.min(600, Math.max(180, w));
  const rtl = () => document.documentElement.dir === 'rtl';
  const resize = (e: React.MouseEvent) => {
    const startX = e.clientX;
    const startW = sidebarW;
    // In RTL the sidebar sits on the right, so dragging left widens it.
    const sign = rtl() ? -1 : 1;
    const move = (m: MouseEvent) => setSidebarW(clampW(startW + sign * (m.clientX - startX)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const resizeKey = (e: React.KeyboardEvent) => {
    const grow = rtl() ? 'ArrowLeft' : 'ArrowRight';
    const shrink = rtl() ? 'ArrowRight' : 'ArrowLeft';
    const step = e.shiftKey ? 40 : 10;
    if (e.key === grow) setSidebarW((w) => clampW(w + step));
    else if (e.key === shrink) setSidebarW((w) => clampW(w - step));
    else return;
    e.preventDefault();
  };

  const hasSessions = Object.keys(st.sessions).length > 0;
  // Settings and the audit log need no connection: when one of them is active, show the workspace.
  const activeKind = st.tabs.find((x) => x.id === st.activeTab)?.kind;
  const standaloneTab = activeKind === 'settings' || activeKind === 'audit';
  const showLauncher = st.launcher || (!hasSessions && !standaloneTab);
  const sidebarSession = st.activeSession && st.sessions[st.activeSession] ? st.activeSession : undefined;

  return (
    <div className="flex h-full flex-col">
      {activeSession?.config.environment === 'production' && !showLauncher && (
        <div role="alert" className="shrink-0 bg-danger-solid px-3 py-[2px] text-center text-[0.78rem] font-semibold tracking-wide text-on-solid">{t('safety.productionBanner')} — {activeSession.config.name}</div>
      )}
      {error && <div role="alert" className="bg-danger-solid p-2 text-on-solid">{error}</div>}
      {showLauncher ? (
        <div className="relative min-h-0 flex-1">
          <Welcome />
          {(hasSessions || standaloneTab) && (
            <button className="btn absolute end-4 top-4" onClick={() => useApp.setState({ launcher: false })}>{t('shell.backToWorkspace')}</button>
          )}
        </div>
      ) : (
        <>
          {!focus && <TopBar onToggleSidebar={() => setSidebar((x) => !x)} />}
          <div className="flex min-h-0 flex-1">
            {!focus && hasSessions && <ConnectionRail />}
            {sidebar && !focus && sidebarSession && (
              <>
                <div style={{ width: sidebarW }} className="min-h-0 shrink-0 border-e border-border"><Sidebar sessionId={sidebarSession} /></div>
                <div
                  role="separator"
                  tabIndex={0}
                  aria-orientation="vertical"
                  aria-label={t('shell.resizeSidebar')}
                  aria-valuemin={180}
                  aria-valuemax={600}
                  aria-valuenow={sidebarW}
                  className="-ms-[3px] w-[5px] shrink-0 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60"
                  onMouseDown={resize}
                  onKeyDown={resizeKey}
                />
              </>
            )}
            <main className="flex min-w-0 flex-1 flex-col">
              {!focus && <TabBar />}
              <div className="min-h-0 flex-1">
                {/* Keep views mounted so editor state survives tab switches. */}
                {st.tabs.map((tab) => (
                  <div key={tab.id} id={panelDomId(tab.id)} role="tabpanel" aria-labelledby={tabDomId(tab.id)} hidden={tab.id !== active?.id} className="h-full">
                    <ErrorBoundary label={tab.title}>
                      <View tab={tab} />
                    </ErrorBoundary>
                  </div>
                ))}
                {!active && (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
                    <Icon name="table" size={40} strokeWidth={1.2} />
                    <p>{t('shell.emptyHint')}</p>
                    <div className="mt-1 flex gap-2">
                      <button className="btn" onClick={() => st.openTab({ kind: 'query', title: t('shell.queryTab'), sessionId: st.activeSession, sql: '' })}><Icon name="sql" size={14} /> {t('query.newTab')} <span className="kbd" aria-hidden>{displayCombo(DEFAULT_KEYS.newQuery)}</span></button>
                      <button className="btn" onClick={() => useApp.setState({ paletteOpen: true })}><Icon name="search" size={14} /> {t('shell.openAnything')} <span className="kbd" aria-hidden>{displayCombo(DEFAULT_KEYS.palette)}</span></button>
                    </div>
                  </div>
                )}
              </div>
            </main>
          </div>
        </>
      )}
      <StatusBar />
      {st.connectionDialog && <ConnectionDialog key={JSON.stringify(st.connectionDialog)} />}
      {st.paletteOpen && <CommandPalette />}
      <OpenDatabaseHost />
      <ImportConnectionsHost />
      {pending && <SafetyDialog pending={pending} />}
      <AskHost />
      {/* Live region stays mounted so screen readers announce toasts added later. */}
      <div role="log" aria-live="polite" aria-relevant="additions" aria-label={t('shell.notifications')} className="pointer-events-none fixed bottom-8 end-4 z-50 flex flex-col gap-1">
        {st.toasts.map((x) => (
          <div key={x.id} role={x.kind === 'error' ? 'alert' : 'status'} dir="auto" className={`pointer-events-auto max-w-md whitespace-pre-wrap rounded-lg border px-3 py-2 shadow-lg ${x.kind === 'error' ? 'border-danger-solid bg-danger-solid text-on-solid' : 'border-border bg-raised text-fg'}`}>{x.kind === 'ok' && <span className="me-1.5 text-ok" aria-hidden>●</span>}{x.text}</div>
        ))}
      </div>
    </div>
  );
}
