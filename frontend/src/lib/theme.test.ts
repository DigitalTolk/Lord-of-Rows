import { describe, expect, it } from 'vitest';
import css from '../index.css?raw';
import { monacoThemeFor, nextThemePref, parseThemePref, readableTextOn, resolveTheme } from './theme';

describe('theme preference', () => {
  it('parses unknown values as system', () => {
    expect(parseThemePref(undefined)).toBe('system');
    expect(parseThemePref('nope')).toBe('system');
    expect(parseThemePref('dark')).toBe('dark');
    expect(parseThemePref('hc')).toBe('hc');
  });

  it('cycles System -> Light -> Dark -> System, high contrast re-enters at System', () => {
    expect(nextThemePref('system')).toBe('light');
    expect(nextThemePref('light')).toBe('dark');
    expect(nextThemePref('dark')).toBe('system');
    expect(nextThemePref('hc')).toBe('system');
  });

  it('resolves system from OS media queries; explicit choices ignore the OS', () => {
    const os = (dark: boolean, moreContrast = false) => ({ dark, moreContrast });
    expect(resolveTheme('system', os(false))).toBe('light');
    expect(resolveTheme('system', os(true))).toBe('dark');
    expect(resolveTheme('system', os(true, true))).toBe('hc');
    expect(resolveTheme('light', os(true, true))).toBe('light');
    expect(resolveTheme('dark', os(false))).toBe('dark');
    expect(resolveTheme('hc', os(false))).toBe('hc');
  });

  it('picks readable badge text for light and dark fills', () => {
    expect(readableTextOn('#e0b400')).toBe('#000');
    expect(readableTextOn('#29b5e8')).toBe('#000');
    expect(readableTextOn('#336791')).toBe('#fff');
    expect(readableTextOn('#cc2927')).toBe('#fff');
    expect(readableTextOn('nonsense')).toBe('#fff');
  });

  it('maps resolved themes to Monaco themes', () => {
    expect(monacoThemeFor('light')).toBe('dbs-light');
    expect(monacoThemeFor('dark')).toBe('dbs-dark');
    expect(monacoThemeFor('hc')).toBe('hc-black');
  });
});

// WCAG contrast checks straight from the CSS tokens, so palette tweaks can't silently regress.
function block(selector: string): Record<string, number[]> {
  const re = new RegExp(`${selector.replace(/[.:]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const body = re.exec(css)?.[1] ?? '';
  const out: Record<string, number[]> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) out[m[1]] = [+m[2], +m[3], +m[4]];
  return out;
}
const lum = (c: number[]) => {
  const [r, g, b] = c.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('palette contrast (WCAG AA)', () => {
  const light = block(':root');
  const themes = { light, dark: { ...light, ...block(':root.dark') }, hc: { ...light, ...block(':root.hc') } };
  for (const [name, p] of Object.entries(themes)) {
    it(`${name}: text tokens are readable on every surface`, () => {
      for (const surface of ['bg', 'panel', 'raised']) {
        for (const text of ['fg', 'muted', 'accent', 'danger', 'warn', 'ok', 'purple']) {
          expect(contrast(p[text], p[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(p.fg, p.hover), `fg on hover`).toBeGreaterThanOrEqual(7);
      }
    });
    it(`${name}: on-solid text is readable on solid fills`, () => {
      expect(contrast(p['on-solid'], p['accent-solid'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p['on-solid'], p['danger-solid'])).toBeGreaterThanOrEqual(4.5);
    });
  }
  it('surfaces are distinguishable in light and dark', () => {
    for (const p of [themes.light, themes.dark]) {
      expect(contrast(p.bg, p.hover)).toBeGreaterThan(1.1);
      expect(contrast(p.bg, p.border)).toBeGreaterThan(1.2);
    }
    expect(contrast(themes.dark.panel, themes.dark.raised)).toBeGreaterThan(1.08);
  });
});
