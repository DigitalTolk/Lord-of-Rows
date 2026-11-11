// Row detail panel behaviour: in 'auto' mode, selecting a row
// opens the panel of that table tab; closing it explicitly switches the global
// preference to 'closed' (row clicks no longer open it); opening it explicitly
// (toolbar button / ⌘⇧D) switches back to 'auto'. Persisted as a backend setting.
import { useApp } from '../store';
import { useTableWs } from './tableWorkspace';

export const DETAIL_PREF_KEY = 'grid.detailPanel';
export const DETAIL_WIDTH_KEY = 'grid.detailPanelWidth';
export const DETAIL_SHORTCUT = 'Mod+Shift+D';
export type DetailPref = 'auto' | 'closed';

export const DETAIL_MIN_W = 220;
export const DETAIL_MAX_W = 720;
export const DETAIL_DEFAULT_W = 320;

export const detailPref = (settings: Record<string, unknown>): DetailPref => (settings[DETAIL_PREF_KEY] === 'closed' ? 'closed' : 'auto');

/** Saved panel width, clamped; the default for missing or invalid values. */
export function detailWidth(settings: Record<string, unknown>): number {
  const n = Number(settings[DETAIL_WIDTH_KEY]);
  return Number.isFinite(n) && n > 0 ? clampDetailWidth(n) : DETAIL_DEFAULT_W;
}
export const clampDetailWidth = (w: number) => Math.round(Math.min(DETAIL_MAX_W, Math.max(DETAIL_MIN_W, w)));

/** Store a setting without blocking the UI: memory first (so the next click sees it), then the backend. */
function persist(key: string, value: unknown) {
  const app = useApp.getState();
  if (app.settings[key] === value) return;
  useApp.setState({ settings: { ...app.settings, [key]: value } });
  try {
    void app.setSetting(key, value).catch(() => undefined);
  } catch {
    /* settings backend unavailable: keep the in-memory value */
  }
}

/**
 * Explicit open/close (panel ×, toolbar or bottom-bar button, ⌘⇧D). Without `open`, toggles.
 * Closing sets the preference to 'closed'; opening sets it back to 'auto'.
 */
export function setDetailPanel(tabId: string, open?: boolean) {
  const ws = useTableWs.getState();
  const next = open ?? !(ws.tabs[tabId]?.detailOpen ?? false);
  ws.toggleDetail(tabId, next);
  persist(DETAIL_PREF_KEY, next ? 'auto' : 'closed');
}

/** Row selection changed: in 'auto' mode, a non-empty selection opens the panel. */
export function onRowsSelected(tabId: string, rows: readonly number[]) {
  if (!rows.length || detailPref(useApp.getState().settings) !== 'auto') return;
  const ws = useTableWs.getState();
  if (!ws.tabs[tabId]?.detailOpen) ws.toggleDetail(tabId, true);
}

/** Remember the panel width (after a resize). */
export function saveDetailWidth(w: number) {
  persist(DETAIL_WIDTH_KEY, clampDetailWidth(w));
}
