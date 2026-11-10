import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AskHost } from './components/ask';
import { useConfirm } from './components/confirm';
import { ConnectionDialog } from './components/ConnectionDialog';
import { SafetyDialog } from './components/SafetyDialog';
import { CommandPalette, StatusBar, TabBar } from './components/Shell';
import { Sidebar } from './components/Sidebar';
import { api } from './lib/ipc';
import { DEFAULT_KEYS, eventCombo, matches, type KeyAction } from './lib/keys';
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
      const tabs = st.tabs;
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

  const active = st.tabs.find((x) => x.id === st.activeTab);
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

  return (
    <div className="flex h-full flex-col">
      {activeSession?.config.environment === 'production' && (
        <div role="alert" className="shrink-0 bg-danger px-3 py-0.5 text-center text-xs font-bold tracking-wide text-white">⚠ {t('safety.productionBanner')} — {activeSession.config.name}</div>
      )}
      {activeSession?.config.read_only && <div className="shrink-0 bg-warn/20 px-3 py-0.5 text-center text-xs">{t('safety.readOnlyBanner')}</div>}
      {error && <div role="alert" className="bg-danger p-2 text-white">{error}</div>}
      <div className="flex min-h-0 flex-1">
        {sidebar && !focus && (
          <>
            <div style={{ width: sidebarW }} className="min-h-0 shrink-0"><Sidebar /></div>
            <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" className="w-1 cursor-col-resize hover:bg-accent" onMouseDown={resize} />
          </>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          {!focus && <TabBar />}
          <div className="min-h-0 flex-1">
            {/* Keep views mounted so editor state survives tab switches. */}
            {st.tabs.map((tab) => (
              <div key={tab.id} role="tabpanel" hidden={tab.id !== st.activeTab} className="h-full">
                <View tab={tab} />
              </div>
            ))}
            {!active && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
                <h1 className="text-2xl font-semibold text-fg">{t('app.name')}</h1>
                <p>Open a connection from the sidebar, or press <span className="kbd">{DEFAULT_KEYS.palette.replace('Mod', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')}</span> for commands.</p>
                <div className="flex gap-2">
                  <button className="btn btn-primary" onClick={() => useApp.setState({ connectionDialog: {} })}>{t('conn.new')}</button>
                  <button className="btn" onClick={() => st.openTab({ kind: 'settings', title: t('settings.title') })}>{t('settings.title')}</button>
                  <button className="btn" onClick={() => st.openTab({ kind: 'audit', title: t('audit.title') })}>{t('audit.title')}</button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
      <StatusBar />
      {st.connectionDialog && <ConnectionDialog key={JSON.stringify(st.connectionDialog)} />}
      {st.paletteOpen && <CommandPalette />}
      {pending && <SafetyDialog pending={pending} />}
      <AskHost />
      <div aria-live="polite" className="pointer-events-none fixed bottom-8 right-3 z-50 flex flex-col gap-1">
        {st.toasts.map((x) => (
          <div key={x.id} role={x.kind === 'error' ? 'alert' : 'status'} className={`pointer-events-auto max-w-md whitespace-pre-wrap rounded border px-3 py-2 shadow ${x.kind === 'error' ? 'border-danger bg-danger text-white' : x.kind === 'ok' ? 'border-ok bg-raised' : 'border-border bg-raised'}`}>{x.text}</div>
        ))}
      </div>
    </div>
  );
}
