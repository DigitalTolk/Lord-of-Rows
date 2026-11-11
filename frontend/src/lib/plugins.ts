// Installed-plugin cache shared by Settings, the query editor and result grids.
// The backend enforces every permission; this only decides which menu items to show.
import { create } from 'zustand';
import i18n from '../i18n';
import { api } from './ipc';
import type { PluginCapability, PluginInfo, PluginSigner } from './types';

/** Human description of a capability, in the active UI language. */
export const capabilityText = (c: PluginCapability) => i18n.t(`plugins.cap.${c}`, { defaultValue: c });

export const signerText = (s: PluginSigner) => (s.kind === 'verified' ? i18n.t('plugins.verified', { fingerprint: s.fingerprint }) : i18n.t('plugins.unsigned'));

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
