// Multiple app windows. Each window is its own webview with its own store, so
// tabs and sessions are window-scoped by construction; the backend records the
// owning window of every session and disconnects them when the window closes.
import { getCurrentWindow } from '@tauri-apps/api/window';

export const MAIN_WINDOW = 'main';

/** Label of the window this webview belongs to ("main" outside Tauri, e.g. in tests). */
export function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return MAIN_WINDOW;
  }
}

/**
 * Session restore is per app launch and only for the main window: secondary
 * windows start empty and never overwrite the main window's saved tabs.
 */
/** Closes this window the same way the title-bar button does; the backend then disconnects its sessions. */
export async function closeCurrentWindow(): Promise<void> {
  await getCurrentWindow().close();
}

export const persistsWorkspace = (label: string) => label === MAIN_WINDOW;

export function windowTitle(app: string, connection?: string | null): string {
  return connection ? `${app} — ${connection}` : app;
}

/** Sets the native window title (and document.title, which WebDriver can read). */
export async function setWindowTitle(title: string): Promise<void> {
  document.title = title;
  try {
    await getCurrentWindow().setTitle(title);
  } catch {
    /* not running inside Tauri */
  }
}
