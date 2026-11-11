// Keyboard shortcuts. "Mod" = ⌘ on macOS, Ctrl elsewhere.
export const DEFAULT_KEYS = {
  palette: 'Mod+K',
  quickOpen: 'Mod+P',
  newQuery: 'Mod+T',
  closeTab: 'Mod+W',
  reopenTab: 'Mod+Shift+T',
  nextTab: 'Ctrl+Tab',
  prevTab: 'Ctrl+Shift+Tab',
  settings: 'Mod+,',
  toggleSidebar: 'Mod+B',
  newConnection: 'Mod+N',
  newWindow: 'Mod+Shift+N',
  closeWindow: 'Mod+Shift+W',
  splitEditor: 'Mod+\\',
  focusMode: 'Mod+Shift+F',
} as const;
export type KeyAction = keyof typeof DEFAULT_KEYS;

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Normalise a KeyboardEvent to "Mod+Shift+K" form (Mod = platform primary modifier). */
export function eventCombo(e: KeyboardEvent, mac = isMac): string {
  const parts: string[] = [];
  const primary = mac ? e.metaKey : e.ctrlKey;
  if (primary) parts.push('Mod');
  if (mac && e.ctrlKey) parts.push('Ctrl');
  if (!mac && e.metaKey) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k.length === 1) k = k.toUpperCase();
  if (k === ' ') k = 'Space';
  if (!['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) parts.push(k);
  return parts.join('+');
}

export function matches(combo: string, binding: string, mac = isMac): boolean {
  // "Ctrl+Tab" binding on mac means literal Ctrl; "Mod" maps to platform key.
  const norm = (s: string) => s.split('+').map((p) => (p === 'Ctrl' && !mac ? 'Mod' : p)).sort().join('+');
  return norm(combo) === norm(binding);
}

export function displayCombo(binding: string, mac = isMac): string {
  return binding.replace('Mod', mac ? '⌘' : 'Ctrl').replace('Shift', mac ? '⇧' : 'Shift').replace('Alt', mac ? '⌥' : 'Alt');
}
