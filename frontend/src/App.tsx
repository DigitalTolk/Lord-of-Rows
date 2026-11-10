import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AskHost } from './components/ask';
import { useConfirm } from './components/confirm';
import { ConnectionDialog } from './components/ConnectionDialog';
import { SafetyDialog } from './components/SafetyDialog';
import { CommandPalette, StatusBar, TabBar, TopBar } from './components/Shell';
import { Welcome } from './components/Welcome';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ConnectionRail } from './components/ConnectionRail';
import { Icon } from './components/icons';
import { Sidebar } from './components/Sidebar';
import { api } from './lib/ipc';
import { DEFAULT_KEYS, displayCombo, eventCombo, matches, type KeyAction } from './lib/keys';
import { errMsg, useApp, type Tab } from './store';
import { AuditView } from './views/AuditView';
import { BackupView } from './views/BackupView';
import { DashboardView } from './views/DashboardView';
import { DiffView } from './views/DiffView';
import { ERView } from './views/ERView';
import { HistoryView } from './views/HistoryView';
import { ImportView } from './views/ImportView';
import { MonitorView } from './views/MonitorView';
import { QueryView } from './views/QueryView';
import { SettingsView } from './views/SettingsView';
import { StructureView } from './views/StructureView';
import { TableView } from './views/TableView';

function View({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case 'query': return <QueryView tab={tab} />;
    case 'table': return <TableView tab={tab} />;
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
  const settings = useApp((s) => s.settings);
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const pref = (settings['appearance.theme'] as string) ?? 'system';
      const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      const hc = pref === 'hc' || (pref === 'system' && window.matchMedia('(prefers-contrast: more)').matches);
      root.classList.toggle('dark', dark && !hc);
      root.classList.toggle('hc', hc);
      root.classList.toggle('reduce-motion', !!settings['a11y.reduceMotion']);
      root.style.setProperty('--ui-scale', String(settings['appearance.scale'] ?? 1));
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);
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
  useHealth();

  useEffect(() => {
    st.init().catch((e) => setError(errMsg(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist query tabs (text only) for session restore.
  useEffect(() => {
    const h = setTimeout(() => {
      const tabs = st.tabs.filter((x) => x.kind === 'query').map(({ id, kind, title, sql, pinned }) => ({ id, kind, title, sql: (sql ?? '').slice(0, 200_000), pinned }));
      void api.setSetting('workspace.tabs', tabs).catch(() => undefined);
    }, 1000);
    return () => clearTimeout(h);
  }, [st.tabs]);

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
      else if (is('newQuery')) st.openTab({ kind: 'query', title: 'Query', sessionId: s?.session_id, sql: '' });
      else if (is('closeTab') && st.activeTab) st.closeTab(st.activeTab);
      else if (is('reopenTab')) st.reopenClosedTab();
      else if (is('nextTab') && tabs.length) useApp.setState({ activeTab: tabs[(cur + 1) % tabs.length].id });
      else if (is('prevTab') && tabs.length) useApp.setState({ activeTab: tabs[(cur - 1 + tabs.length) % tabs.length].id });
      else if (is('settings')) st.openTab({ kind: 'settings', title: t('settings.title') });
      else if (is('toggleSidebar')) setSidebar((x) => !x);
      else if (is('newConnection')) useApp.setState({ connectionDialog: {} });
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

  const resize = (e: React.MouseEvent) => {
    const startX = e.clientX;
    const startW = sidebarW;
    const move = (m: MouseEvent) => setSidebarW(Math.min(600, Math.max(180, startW + m.clientX - startX)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const hasSessions = Object.keys(st.sessions).length > 0;
  const showLauncher = st.launcher || !hasSessions;
  const sidebarSession = st.activeSession && st.sessions[st.activeSession] ? st.activeSession : undefined;

  return (
    <div className="flex h-full flex-col">
      {activeSession?.config.environment === 'production' && !showLauncher && (
        <div role="alert" className="shrink-0 bg-danger px-3 py-[2px] text-center text-[0.78rem] font-semibold tracking-wide text-white">{t('safety.productionBanner')} — {activeSession.config.name}</div>
      )}
      {error && <div role="alert" className="bg-danger p-2 text-white">{error}</div>}
      {showLauncher ? (
        <div className="relative min-h-0 flex-1">
          <Welcome />
          {hasSessions && (
            <button className="btn absolute right-4 top-4" onClick={() => useApp.setState({ launcher: false })}>Back to workspace</button>
          )}
        </div>
      ) : (
        <>
          {!focus && <TopBar onToggleSidebar={() => setSidebar((x) => !x)} />}
          <div className="flex min-h-0 flex-1">
            {!focus && hasSessions && <ConnectionRail />}
            {sidebar && !focus && sidebarSession && (
              <>
                <div style={{ width: sidebarW }} className="min-h-0 shrink-0 border-r border-border"><Sidebar sessionId={sidebarSession} /></div>
                <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" className="-ml-[3px] w-[5px] shrink-0 cursor-col-resize hover:bg-accent/40" onMouseDown={resize} />
              </>
            )}
            <main className="flex min-w-0 flex-1 flex-col">
              {!focus && <TabBar />}
              <div className="min-h-0 flex-1">
                {/* Keep views mounted so editor state survives tab switches. */}
                {st.tabs.map((tab) => (
                  <div key={tab.id} role="tabpanel" hidden={tab.id !== active?.id} className="h-full">
                    <ErrorBoundary label={tab.title}>
                      <View tab={tab} />
                    </ErrorBoundary>
                  </div>
                ))}
                {!active && (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
                    <Icon name="table" size={40} strokeWidth={1.2} />
                    <p>Select a table in the sidebar, or open a new SQL query.</p>
                    <div className="mt-1 flex gap-2">
                      <button className="btn" onClick={() => st.openTab({ kind: 'query', title: 'Query', sessionId: st.activeSession, sql: '' })}><Icon name="sql" size={14} /> New query <span className="kbd">{displayCombo(DEFAULT_KEYS.newQuery)}</span></button>
                      <button className="btn" onClick={() => useApp.setState({ paletteOpen: true })}><Icon name="search" size={14} /> Open anything <span className="kbd">{displayCombo(DEFAULT_KEYS.palette)}</span></button>
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
      {pending && <SafetyDialog pending={pending} />}
      <AskHost />
      <div aria-live="polite" className="pointer-events-none fixed bottom-8 right-4 z-50 flex flex-col gap-1">
        {st.toasts.map((x) => (
          <div key={x.id} role={x.kind === 'error' ? 'alert' : 'status'} className={`pointer-events-auto max-w-md whitespace-pre-wrap rounded-lg border px-3 py-2 shadow-lg ${x.kind === 'error' ? 'border-danger bg-danger text-white' : 'border-border bg-raised'}`}>{x.kind === 'ok' && <span className="mr-1.5 text-ok">●</span>}{x.text}</div>
        ))}
      </div>
    </div>
  );
}
