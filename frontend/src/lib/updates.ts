// Pure helpers for the updater UI. Downloading, signature verification and
// installation all happen in Rust (src-tauri/src/updater.rs).
import type { UpdateChannel, UpdateCheck, UpdateProgress } from './types';

export const PROGRESS_EVENT = 'update://progress';

export const channelOf = (settings: Record<string, unknown>): UpdateChannel => (settings['updates.channel'] === 'beta' ? 'beta' : 'stable');

export const endpointKey = (channel: UpdateChannel) => `updates.endpoint.${channel}`;

/** Percentage 0–100, or null when the total size is unknown (indeterminate bar). */
export function progressPercent(p: UpdateProgress | null): number | null {
  if (!p) return null;
  if (p.phase !== 'downloading') return 100;
  if (!p.total) return null;
  return Math.min(100, Math.floor((p.downloaded / p.total) * 100));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Startup check. Opt-in only (`updates.autoCheck`, default off): the app is
 * offline-first and must make no unsolicited network requests. Failures are
 * swallowed so a broken update server never disturbs startup.
 */
export async function autoCheckForUpdates(
  settings: Record<string, unknown>,
  check: () => Promise<UpdateCheck>,
  notify: (version: string) => void,
): Promise<UpdateCheck | null> {
  if (settings['updates.autoCheck'] !== true) return null;
  try {
    const r = await check();
    if (r.status === 'available') notify(r.version);
    return r;
  } catch {
    return null;
  }
}
