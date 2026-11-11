import { create } from 'zustand';
import { api } from './lib/ipc';
import { withHostKeyTrust } from './lib/hostkey';
import type { AppInfo, ObjectRef, SessionOpened, StoredConnection, TableTarget } from './lib/types';

export type TabKind = 'query' | 'table' | 'structure' | 'diff' | 'audit' | 'monitor' | 'er' | 'settings' | 'import' | 'backup' | 'history' | 'dashboard';

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  sessionId?: string;
  target?: TableTarget;
  sql?: string;
  pinned?: boolean;
}

export interface OpenSession extends SessionOpened {
  schemas: string[];
  objects: Record<string, ObjectRef[]>;
  activeSchema: string | null;
  latency?: number;
  healthy: boolean;
}

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
  toasts: { id: number; kind: 'info' | 'error' | 'ok'; text: string }[];

  init(): Promise<void>;
  reloadConnections(): Promise<void>;
  setSetting(key: string, value: unknown): Promise<void>;
  openSession(connectionId: string, password?: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
  loadObjects(sessionId: string, schema: string | null): Promise<void>;
  setActiveSchema(sessionId: string, schema: string): void;
  openTab(t: Omit<Tab, 'id'> & { id?: string }): string;
  closeTab(id: string): void;
  reopenClosedTab(): void;
  updateTab(id: string, patch: Partial<Tab>): void;
  moveTab(id: string, toIndex: number): void;
  toast(kind: 'info' | 'error' | 'ok', text: string): void;
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
    // Restore saved workspace tabs (query text only; sessions must be reopened explicitly).
    const ws = settings['workspace.tabs'];
    if (Array.isArray(ws)) {
      const tabs = (ws as Tab[]).filter((t) => t.kind === 'query').map((t) => ({ ...t, sessionId: undefined }));
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

  async openSession(connectionId, password) {
    const s = await withHostKeyTrust((trust) => api.openSession(connectionId, password ?? null, trust));
    let schemas: string[] = [];
    try {
      schemas = s.capabilities.schemas ? await api.listSchemas(s.session_id) : [];
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
      sessions: { ...prev.sessions, [s.session_id]: { ...s, schemas, objects: {}, activeSchema: preferred, healthy: true } },
      tabs,
      activeSession: s.session_id,
      activeTab: firstOwn?.id,
      lastTab: prev.activeSession && prev.activeTab ? { ...prev.lastTab, [prev.activeSession]: prev.activeTab } : prev.lastTab,
      launcher: false,
    });
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
    if (!s.objects[schema]) void get().loadObjects(sessionId, schema);
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

  toast(kind, text) {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 8000 : 4000);
  },
}));

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
