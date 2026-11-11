import { create } from 'zustand';
import i18n from './i18n';
import { api } from './lib/ipc';
import { withHostKeyTrust } from './lib/hostkey';
import { autoCheckForUpdates } from './lib/updates';
import { closeCurrentWindow, currentWindowLabel, persistsWorkspace } from './lib/windows';
import type { AppInfo, KeyspaceInfo, ObjectRef, SessionOpened, StoredConnection, TableTarget } from './lib/types';

export type TabKind = 'query' | 'table' | 'structure' | 'diff' | 'audit' | 'monitor' | 'er' | 'settings' | 'import' | 'backup' | 'history' | 'dashboard';

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  sessionId?: string;
  target?: TableTarget;
  sql?: string;
  pinned?: boolean;
  /** Query tabs: second editor pane, laid out to the right of or below the first. */
  split?: SplitDir;
  /** Text of the second editor pane (kept when the split is closed, so re-splitting restores it). */
  sql2?: string;
}

export type SplitDir = 'right' | 'down';

/** Query tabs as saved for session restore (text and split layout only, never results or sessions). */
export function workspaceSnapshot(tabs: Tab[]): Tab[] {
  return tabs
    .filter((x) => x.kind === 'query')
    .map(({ id, kind, title, sql, pinned, split, sql2 }) => ({ id, kind, title, sql: (sql ?? '').slice(0, 200_000), pinned, split, sql2: sql2 == null ? undefined : sql2.slice(0, 200_000) }));
}

/** Tabs to restore from a saved snapshot: query tabs only, detached from any session. */
export function restoreWorkspace(saved: unknown): Tab[] {
  if (!Array.isArray(saved)) return [];
  return (saved as Tab[])
    .filter((t) => t && t.kind === 'query' && typeof t.id === 'string')
    .map((t) => ({ ...t, sessionId: undefined, split: t.split === 'right' || t.split === 'down' ? t.split : undefined }));
}

export interface OpenSession extends SessionOpened {
  schemas: string[];
  objects: Record<string, ObjectRef[]>;
  activeSchema: string | null;
  /** Key-value sessions: logical databases with key counts (the schemas, with sizes). */
  keyspaces?: KeyspaceInfo[];
  latency?: number;
  healthy: boolean;
  /** The connection's time-limited access ended: it was closed, its tabs are kept until dismissed. */
  ended?: boolean;
}

/** Fired before a session is closed because its access ended (query views cancel their runs). */
export const SESSION_ENDING_EVENT = 'lotr:session-ending';

interface State {
  info?: AppInfo;
  settings: Record<string, unknown>;
  connections: StoredConnection[];
  sessions: Record<string, OpenSession>;
  activeSession?: string;
  tabs: Tab[];
  closedTabs: Tab[];
  activeTab?: string;
  paletteOpen: boolean;
  launcher: boolean;
  lastTab: Record<string, string>;
  switchSession(id: string): void;
  connectionDialog?: { id?: string; duplicateOf?: string } | null;
  toasts: { id: number; kind: 'info' | 'error' | 'ok'; text: string; action?: ToastAction }[];

  init(): Promise<void>;
  reloadConnections(): Promise<void>;
  setSetting(key: string, value: unknown): Promise<void>;
  /** `database` (Postgres family): open the saved connection on another database of the same server. */
  openSession(connectionId: string, password?: string, database?: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
  /** Access ended: cancel running queries, close the connection, keep the tabs (shown as ended). */
  endSession(sessionId: string): Promise<void>;
  /** Removes an ended session; its query tabs stay (unbound, text kept), other tabs close. */
  dismissSession(sessionId: string): void;
  loadObjects(sessionId: string, schema: string | null): Promise<void>;
  setActiveSchema(sessionId: string, schema: string): void;
  /** Key-value sessions: reload the databases and their key counts (`INFO keyspace`). */
  loadKeyspaces(sessionId: string): Promise<void>;
  openTab(t: Omit<Tab, 'id'> & { id?: string }): string;
  closeTab(id: string): void;
  reopenClosedTab(): void;
  updateTab(id: string, patch: Partial<Tab>): void;
  moveTab(id: string, toIndex: number): void;
  /** Toggle a query tab's split. With `dir`, switch to that layout (or close the split if it is already in it). */
  toggleSplit(id: string, dir?: SplitDir): void;
  openWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  /** `action` adds a button (e.g. "Review"); such toasts stay longer. */
  toast(kind: 'info' | 'error' | 'ok', text: string, action?: ToastAction): void;
}

/** A button on a toast. */
export interface ToastAction {
  label: string;
  run: () => void;
}

let toastId = 0;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

export const useApp = create<State>((set, get) => ({
  settings: {},
  connections: [],
  sessions: {},
  tabs: [],
  closedTabs: [],
  paletteOpen: false,
  launcher: false,
  lastTab: {},
  toasts: [],

  async init() {
    const [info, settings, connections] = await Promise.all([api.appInfo(), api.getSettings(), api.listConnections()]);
    set({ info, settings, connections });
    // Opt-in only (`updates.autoCheck`); runs in the background and never blocks startup.
    void autoCheckForUpdates(settings, api.checkUpdate, (v) => get().toast('info', i18n.t('updates.autoFound', { version: v })));
    // Restore saved workspace tabs (query text + split layout; sessions must be reopened explicitly).
    // Only the main window restores; extra windows start with an empty workspace.
    if (persistsWorkspace(currentWindowLabel())) {
      const tabs = restoreWorkspace(settings['workspace.tabs']);
      if (tabs.length) set({ tabs, activeTab: tabs[0].id });
    }
  },

  async reloadConnections() {
    set({ connections: await api.listConnections() });
  },

  async setSetting(key, value) {
    await api.setSetting(key, value);
    set({ settings: { ...get().settings, [key]: value } });
  },

  async openSession(connectionId, password, database) {
    const s = await withHostKeyTrust((trust) => api.openSession(connectionId, password ?? null, trust, database ?? null));
    const keyValue = s.config.engine === 'redis';
    let schemas: string[] = [];
    let keyspaces: KeyspaceInfo[] | undefined;
    try {
      if (keyValue) {
        keyspaces = await api.kvKeyspaces(s.session_id);
        schemas = keyspaces.map((k) => k.name);
      } else schemas = s.capabilities.schemas ? await api.listSchemas(s.session_id) : [];
    } catch {
      schemas = [];
    }
    const preferred =
      s.server.current_database && schemas.includes(s.server.current_database) ? s.server.current_database
      : schemas.includes('public') ? 'public'
      : schemas.includes('main') ? 'main'
      : schemas[0] ?? null;
    const prev = get();
    // Restored (unbound) query tabs attach to the first connection opened.
    const tabs = prev.tabs.map((t) => (t.kind === 'query' && !t.sessionId ? { ...t, sessionId: s.session_id } : t));
    const firstOwn = tabs.find((t) => t.sessionId === s.session_id);
    set({
      sessions: { ...prev.sessions, [s.session_id]: { ...s, schemas, keyspaces, objects: {}, activeSchema: preferred, healthy: true } },
      tabs,
      activeSession: s.session_id,
      activeTab: firstOwn?.id,
      lastTab: prev.activeSession && prev.activeTab ? { ...prev.lastTab, [prev.activeSession]: prev.activeTab } : prev.lastTab,
      launcher: false,
    });
    if (keyValue) {
      // Keys are browsed lazily (namespace tree, SCAN-paged grid); the configured database stays the default.
      void get().reloadConnections();
      return s.session_id;
    }
    await get().loadObjects(s.session_id, preferred);
    // If the default schema has no tables, switch to the first user schema that does.
    const hasTables = (sch: string | null) => (get().sessions[s.session_id]?.objects[sch ?? ''] ?? []).some((o) => o.kind === 'table' || o.kind === 'view');
    if (preferred && hasTables(preferred)) await api.useSchema(s.session_id, preferred).catch(() => undefined);
    if (!hasTables(preferred)) {
      const system = new Set(['information_schema', 'pg_catalog', 'mysql', 'performance_schema', 'sys', 'crdb_internal', 'pg_extension']);
      for (const sch of schemas.filter((x) => x !== preferred && !system.has(x)).slice(0, 20)) {
        await get().loadObjects(s.session_id, sch);
        if (hasTables(sch)) {
          get().setActiveSchema(s.session_id, sch);
          break;
        }
      }
    }
    void get().reloadConnections();
    return s.session_id;
  },

  switchSession(id) {
    const st = get();
    const cur = st.activeTab;
    const lastTab = { ...st.lastTab };
    if (st.activeSession && cur) lastTab[st.activeSession] = cur;
    const target = lastTab[id] && st.tabs.some((t) => t.id === lastTab[id]) ? lastTab[id] : st.tabs.find((t) => t.sessionId === id)?.id;
    set({ activeSession: id, activeTab: target, lastTab, launcher: false });
  },

  async closeSession(sessionId) {
    await api.closeSession(sessionId).catch(() => undefined);
    const sessions = { ...get().sessions };
    delete sessions[sessionId];
    const tabs = get().tabs.filter((t) => t.sessionId !== sessionId);
    const next = Object.keys(sessions)[0];
    set({ sessions, tabs, activeSession: next, activeTab: tabs.find((t) => t.sessionId === next)?.id });
  },

  async endSession(sessionId) {
    const s = get().sessions[sessionId];
    if (!s || s.ended) return;
    window.dispatchEvent(new CustomEvent(SESSION_ENDING_EVENT, { detail: { sessionId } }));
    await new Promise((r) => setTimeout(r, 50)); // let the views send their cancels first
    await api.closeSession(sessionId).catch(() => undefined);
    const cur = get().sessions[sessionId];
    if (cur) set({ sessions: { ...get().sessions, [sessionId]: { ...cur, ended: true, healthy: false } } });
  },

  dismissSession(sessionId) {
    const sessions = { ...get().sessions };
    delete sessions[sessionId];
    const tabs = get().tabs.filter((t) => t.sessionId !== sessionId || t.kind === 'query').map((t) => (t.sessionId === sessionId ? { ...t, sessionId: undefined } : t));
    const next = Object.keys(sessions)[0];
    set({ sessions, tabs, activeSession: next, activeTab: tabs.find((t) => t.sessionId === next)?.id ?? tabs.find((t) => !t.sessionId)?.id });
  },

  async loadObjects(sessionId, schema) {
    const objs = await api.listObjects(sessionId, schema);
    const s = get().sessions[sessionId];
    if (!s) return;
    set({ sessions: { ...get().sessions, [sessionId]: { ...s, objects: { ...s.objects, [schema ?? '']: objs } } } });
  },

  setActiveSchema(sessionId, schema) {
    const s = get().sessions[sessionId];
    if (!s) return;
    // The selected schema is also the default for unqualified names in SQL tabs.
    api.useSchema(sessionId, schema).catch((e) => get().toast('error', errMsg(e)));
    set({ sessions: { ...get().sessions, [sessionId]: { ...s, activeSchema: schema } } });
    if (s.keyspaces) return; // key-value: the tree loads lazily
    if (!s.objects[schema]) void get().loadObjects(sessionId, schema);
  },

  async loadKeyspaces(sessionId) {
    const keyspaces = await api.kvKeyspaces(sessionId);
    const s = get().sessions[sessionId];
    if (!s) return;
    const schemas = keyspaces.map((k) => k.name);
    if (s.activeSchema && !schemas.includes(s.activeSchema)) schemas.push(s.activeSchema);
    set({ sessions: { ...get().sessions, [sessionId]: { ...s, keyspaces, schemas } } });
  },

  openTab(t) {
    // Reuse an existing tab for the same table/view.
    const existing = get().tabs.find(
      (x) => t.kind !== 'query' && x.kind === t.kind && x.sessionId === t.sessionId && x.target?.table === t.target?.table && x.target?.schema === t.target?.schema,
    );
    if (existing) {
      set({ activeTab: existing.id });
      return existing.id;
    }
    const id = t.id ?? uid();
    set({ tabs: [...get().tabs, { ...t, id }], activeTab: id });
    return id;
  },

  closeTab(id) {
    const tabs = get().tabs;
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0 || tabs[i].pinned) return;
    const next = tabs.filter((t) => t.id !== id);
    set({
      tabs: next,
      closedTabs: [tabs[i], ...get().closedTabs].slice(0, 20),
      activeTab: get().activeTab === id ? next[Math.min(i, next.length - 1)]?.id : get().activeTab,
    });
  },

  reopenClosedTab() {
    const [t, ...rest] = get().closedTabs;
    if (!t) return;
    set({ closedTabs: rest, tabs: [...get().tabs, t], activeTab: t.id });
  },

  updateTab(id, patch) {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  },

  moveTab(id, toIndex) {
    const tabs = [...get().tabs];
    const from = tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const [t] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, t);
    set({ tabs });
  },

  toggleSplit(id, dir) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'query') return;
    const split: SplitDir | undefined = dir ? (tab.split === dir ? undefined : dir) : tab.split ? undefined : 'right';
    get().updateTab(id, { split, sql2: split ? (tab.sql2 ?? '') : tab.sql2 });
  },

  async openWindow() {
    try {
      await api.openWindow();
    } catch (e) {
      get().toast('error', errMsg(e));
    }
  },

  async closeWindow() {
    try {
      await closeCurrentWindow();
    } catch (e) {
      get().toast('error', errMsg(e));
    }
  },

  toast(kind, text, action) {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, text, action }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), action ? 15000 : kind === 'error' ? 8000 : 4000);
  },
}));

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
