// Theme preference -> resolved theme, plus a tiny live subscription to the
// classes App applies on <html>. Pure helpers are unit-tested in theme.test.ts.
import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark' | 'hc';
export type ResolvedTheme = 'light' | 'dark' | 'hc';

export const THEME_SETTING = 'appearance.theme';

export function parseThemePref(v: unknown): ThemePref {
  return v === 'light' || v === 'dark' || v === 'hc' ? v : 'system';
}

/** What the UI actually renders for a preference, given the OS media queries. */
export function resolveTheme(pref: ThemePref, os: { dark: boolean; moreContrast: boolean }): ResolvedTheme {
  if (pref === 'system') return os.moreContrast ? 'hc' : os.dark ? 'dark' : 'light';
  return pref;
}

/** Quick toggle order: System -> Light -> Dark -> System. High contrast (Settings only) re-enters at System. */
export function nextThemePref(pref: ThemePref): ThemePref {
  return pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system';
}

export function monacoThemeFor(t: ResolvedTheme): 'dbs-light' | 'dbs-dark' | 'hc-black' {
  return t === 'hc' ? 'hc-black' : t === 'dark' ? 'dbs-dark' : 'dbs-light';
}

/** Black or white, whichever reads better on a hex background (WCAG relative luminance). */
export function readableTextOn(hex: string): '#000' | '#fff' {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '#fff';
  const [r, g, b] = m.slice(1).map((x) => {
    const v = parseInt(x, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Contrast with white = 1.05/(l+.05); with black = (l+.05)/.05. Equal at l ~= 0.179.
  return l > 0.179 ? '#000' : '#fff';
}

const DARK_MQ = '(prefers-color-scheme: dark)';
const CONTRAST_MQ = '(prefers-contrast: more)';

const mq = (q: string) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null);

export function osTheme() {
  return { dark: !!mq(DARK_MQ)?.matches, moreContrast: !!mq(CONTRAST_MQ)?.matches };
}

/** Calls `cb` whenever the OS colour-scheme or contrast preference changes. */
export function onOsThemeChange(cb: () => void): () => void {
  const qs = [mq(DARK_MQ), mq(CONTRAST_MQ)].filter((x): x is MediaQueryList => !!x);
  qs.forEach((q) => q.addEventListener('change', cb));
  return () => qs.forEach((q) => q.removeEventListener('change', cb));
}

/** Applies the resolved theme to <html> (classes + native control colour-scheme). */
export function applyThemeClasses(root: HTMLElement, t: ResolvedTheme) {
  root.classList.toggle('dark', t === 'dark');
  root.classList.toggle('hc', t === 'hc');
  root.style.colorScheme = t === 'light' ? 'light' : 'dark';
}

// Last preference, cached locally so the first paint (before settings load over
// IPC) already uses the right theme instead of flashing light.
const CACHE_KEY = 'dbs.theme';
export function cachedThemePref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(CACHE_KEY));
  } catch {
    return 'system';
  }
}
export function cacheThemePref(p: ThemePref) {
  try {
    localStorage.setItem(CACHE_KEY, p);
  } catch {
    /* storage unavailable: only affects first paint */
  }
}
/** Apply the cached theme before React renders. */
export function bootTheme() {
  applyThemeClasses(document.documentElement, resolveTheme(cachedThemePref(), osTheme()));
}

function readResolved(): ResolvedTheme {
  const c = document.documentElement.classList;
  return c.contains('hc') ? 'hc' : c.contains('dark') ? 'dark' : 'light';
}

function subscribe(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => obs.disconnect();
}

/** The theme currently applied to the document; re-renders when it changes. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, readResolved, () => 'light');
}
