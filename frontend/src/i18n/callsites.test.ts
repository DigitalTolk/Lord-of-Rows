// Call-site check: every literal t('key', { … }) call passes the placeholders its English
// string needs, and plural keys (key_one/key_other) are called with `count`.
// Catches renames like `{{n}}` -> `{{formatted}}` that leave old call sites behind.
import { describe, expect, it } from 'vitest';
import { resources } from './index';

type Tree = { [k: string]: string | Tree };
function flatten(t: Tree, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === 'string') out[prefix + k] = v;
    else flatten(v, `${prefix}${k}.`, out);
  }
  return out;
}
const EN = flatten(resources.en.translation as Tree);
// Every locale's strings: a call site must supply the placeholders any language uses.
const ALL = Object.values(resources).map((r) => flatten(r.translation as Tree));
const placeholders = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);

/** Returns the English variants for a key (the key itself, or its plural forms). */
function variants(key: string): { plural: boolean; texts: string[] } | null {
  if (key in EN) return { plural: false, texts: ALL.map((L) => L[key]).filter(Boolean) };
  const isForm = (k: string) => k.startsWith(key + '_') && /_(zero|one|two|few|many|other)$/.test(k);
  if (!Object.keys(EN).some(isForm)) return null;
  return { plural: true, texts: ALL.flatMap((L) => Object.keys(L).filter(isForm).map((k) => L[k])) };
}

/** Splits the top level of an object-literal body into property names (handles nested (), [], {}, strings). */
function propNames(body: string): { names: string[]; spread: boolean } {
  const names: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  const flush = () => {
    const p = cur.trim();
    cur = '';
    if (!p) return;
    if (p.startsWith('...')) {
      names.push('...');
      return;
    }
    const m = /^['"]?([\w$]+)['"]?\s*(:|$)/.exec(p);
    if (m) names.push(m[1]);
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === '\\') {
        cur += c + body[++i];
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return { names, spread: names.includes('...') };
}

/** Finds `t('key'` / `i18n.t('key'` calls and the balanced object literal that follows, if any. */
function calls(src: string): { key: string; body: string | null; at: number }[] {
  const out: { key: string; body: string | null; at: number }[] = [];
  const re = /\bt\(\s*'([a-zA-Z][\w.]*)'\s*(,\s*\{)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (!m[2]) {
      out.push({ key: m[1], body: null, at: m.index });
      continue;
    }
    let depth = 1;
    let i = re.lastIndex;
    let quote: string | null = null;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    out.push({ key: m[1], body: src.slice(re.lastIndex, i - 1), at: m.index });
  }
  return out;
}

describe('t() call sites match en.json', () => {
  const files = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

  it('parses calls', () => {
    const all = Object.values(files).flatMap((s) => calls(s));
    expect(all.length).toBeGreaterThan(300);
  });

  it('pass every placeholder; plural keys get count', () => {
    const bad: string[] = [];
    for (const [file, src] of Object.entries(files)) {
      for (const c of calls(src)) {
        const v = variants(c.key);
        const line = src.slice(0, c.at).split('\n').length;
        const where = `${file.replace('../', '')}:${line} ${c.key}`;
        if (!v) {
          // Not a literal key of en.json (e.g. a prefix used with defaultValue); locales.test covers usage.
          continue;
        }
        const { names, spread } = c.body === null ? { names: [], spread: false } : propNames(c.body);
        if (spread || names.includes('defaultValue')) continue;
        if (v.plural && !names.includes('count')) bad.push(`${where}: plural key called without count`);
        const needed = new Set(v.texts.flatMap(placeholders));
        for (const p of needed) if (p !== 'count' && !names.includes(p)) bad.push(`${where}: missing {{${p}}} (passes ${names.join(', ') || 'nothing'})`);
        if (v.plural || needed.size) {
          // `formatted` may be passed alongside `count` for locales that show grouped digits.
        for (const n of names) if (!needed.has(n) && n !== 'count' && n !== 'formatted' && n !== 'ns' && n !== 'lng') bad.push(`${where}: passes unused "${n}"`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
