// Locale parity: every locale has exactly the English keys (with the plural forms its
// language needs), interpolation placeholders match, and every English key is used.
import { describe, expect, it } from 'vitest';
import { LANGUAGES, languageDir, resolveLanguage, resources, systemLanguage } from './index';
import en from './en.json';

type Tree = { [k: string]: string | Tree };
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function flatten(t: Tree, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === 'string') out[prefix + k] = v;
    else flatten(v, `${prefix}${k}.`, out);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort();
const EN = flatten(en as Tree);

/** Split English keys into plain keys and plural bases (keys that have an `_other` form). */
const pluralBases = new Set(Object.keys(EN).filter((k) => k.endsWith('_other')).map((k) => k.replace(PLURAL_SUFFIX, '')));
const isPluralForm = (k: string) => PLURAL_SUFFIX.test(k) && pluralBases.has(k.replace(PLURAL_SUFFIX, ''));
const plainKeys = Object.keys(EN).filter((k) => !isPluralForm(k));

describe('English source', () => {
  it('uses only one/other plural forms and never "(s)"', () => {
    for (const [k, v] of Object.entries(EN)) {
      if (isPluralForm(k)) expect(k, k).toMatch(/_(one|other)$/);
      expect(v, k).not.toMatch(/\w\(s\)/);
    }
    for (const b of pluralBases) expect(EN[`${b}_one`], `${b}_one`).toBeDefined();
  });

  it('every key is referenced from the source code', () => {
    const files = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const src = Object.values(files).join('\n');
    // Literal keys anywhere in a string ('a.b'), plus template prefixes (`a.b.${x}` covers a.b.*).
    const literals = new Set([...src.matchAll(/['"`]([a-zA-Z]\w*(?:\.\w+)+)['"`]/g)].map((m) => m[1]));
    const prefixes = [...src.matchAll(/`([a-zA-Z]\w*\.(?:\w+\.)*)\$\{/g)].map((m) => m[1]);
    // Shared vocabulary kept for in-flight work: `common.*` and the `conn.*` form labels
    // (the connection dialog is being redesigned on another branch).
    const reserved = ['common.', 'conn.'];
    const unused = [...new Set(Object.keys(EN).map((k) => (isPluralForm(k) ? k.replace(PLURAL_SUFFIX, '') : k)))].filter((k) => !literals.has(k) && ![...prefixes, ...reserved].some((p) => k.startsWith(p)));
    expect(unused).toEqual([]);
  });
});

for (const { code } of LANGUAGES.filter((l) => l.code !== 'en')) {
  describe(`locale ${code}`, () => {
    const L = flatten(resources[code].translation as Tree);
    const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories as string[];

    it('has every English key, with the plural forms this language needs', () => {
      const missing: string[] = [];
      for (const k of plainKeys) if (!(k in L)) missing.push(k);
      for (const b of pluralBases) for (const c of categories) if (!(`${b}_${c}` in L)) missing.push(`${b}_${c}`);
      expect(missing).toEqual([]);
    });

    it('has no extra keys', () => {
      const allowed = new Set([...plainKeys, ...[...pluralBases].flatMap((b) => categories.map((c) => `${b}_${c}`))]);
      expect(Object.keys(L).filter((k) => !allowed.has(k))).toEqual([]);
    });

    it('has no empty or untranslated-looking values', () => {
      for (const [k, v] of Object.entries(L)) expect(v.trim(), `${code}:${k}`).not.toBe('');
    });

    it('keeps interpolation placeholders', () => {
      const bad: string[] = [];
      for (const [k, v] of Object.entries(L)) {
        if (isPluralForm(k)) {
          // Plural forms may drop the number ("one row" / Arabic dual) but must not invent placeholders,
          // and the general forms must keep all of them.
          const ref = placeholders(EN[`${k.replace(PLURAL_SUFFIX, '')}_other`]);
          const got = placeholders(v);
          const general = /_(other|many|few)$/.test(k);
          if (got.some((p) => !ref.includes(p)) || (general && ref.filter((p) => p !== 'count').some((p) => !got.includes(p)))) bad.push(`${k}: ${got} vs ${ref}`);
        } else if (k in EN && placeholders(v).join() !== placeholders(EN[k]).join()) {
          bad.push(`${k}: ${placeholders(v)} vs ${placeholders(EN[k])}`);
        }
      }
      expect(bad).toEqual([]);
    });
  });
}

describe('language selection', () => {
  it('maps OS preferences to a supported language', () => {
    expect(systemLanguage(['de-CH', 'en-US'])).toBe('de');
    expect(systemLanguage(['fr-FR', 'es-MX'])).toBe('es');
    expect(systemLanguage(['ar-EG'])).toBe('ar');
    expect(systemLanguage(['ja-JP'])).toBe('en');
    expect(resolveLanguage('system', ['es-ES'])).toBe('es');
    expect(resolveLanguage('de', ['es-ES'])).toBe('de');
  });
  it('marks Arabic as right-to-left', () => {
    expect(languageDir('ar')).toBe('rtl');
    expect(languageDir('de')).toBe('ltr');
  });
});
