// Installed-plugin cache shared by Settings, the query editor and result grids.
// The backend enforces every permission; this only decides which menu items to show.
import { create } from 'zustand';
import { api } from './ipc';
import type { PluginCapability, PluginInfo, PluginSigner } from './types';

export const CAPABILITY_TEXT: Record<PluginCapability, string> = {
  format_sql: 'Transform SQL text you ask it to format',
  export_format: 'Provide a custom export file format',
  read_query_results: 'Read result rows you explicitly export through it',
  read_schema: 'Read table and column names you pass to it',
};

export const signerText = (s: PluginSigner) => (s.kind === 'verified' ? `Verified publisher key ${s.fingerprint}` : 'Unsigned');

const usable = (p: PluginInfo, caps: PluginCapability[]) => p.enabled && !p.incompatible && caps.every((c) => p.grants.includes(c));
export const formatters = (ps: PluginInfo[]) => ps.filter((p) => usable(p, ['format_sql']));
export const exporters = (ps: PluginInfo[]) => ps.filter((p) => usable(p, ['export_format', 'read_query_results']) && p.manifest.export);

export const usePlugins = create<{ plugins: PluginInfo[]; loaded: boolean; load: () => Promise<void>; put: (p: PluginInfo) => void }>((set, get) => ({
  plugins: [],
  loaded: false,
  load: async () => {
    try {
      set({ plugins: await api.pluginList(), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  put: (p) => set({ plugins: get().plugins.some((x) => x.id === p.id) ? get().plugins.map((x) => (x.id === p.id ? p : x)) : [...get().plugins, p] }),
}));
