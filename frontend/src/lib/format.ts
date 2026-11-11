// Locale-aware formatting for numbers, byte sizes and dates, following the active UI language.
import i18n from '../i18n';

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function locale(): string {
  return i18n.language || 'en';
}

function nf(opts: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `n|${locale()}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.NumberFormat | undefined;
  if (!f) cache.set(key, (f = new Intl.NumberFormat(locale(), opts)));
  return f;
}

function df(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `d|${locale()}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!f) cache.set(key, (f = new Intl.DateTimeFormat(locale(), opts)));
  return f;
}

/** 1234567 -> "1,234,567" (en) / "1.234.567" (de). */
export function fmtNumber(n: number | bigint | null | undefined, opts?: Intl.NumberFormatOptions): string {
  if (n == null) return '';
  return nf(opts).format(n);
}

/** Byte size with a binary unit, number part localised: "1.5 MB" / "1,5 MB". */
export function fmtBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${fmtNumber(v, { maximumFractionDigits: i === 0 ? 0 : v < 10 ? 2 : 1 })} ${units[i]}`;
}

/** Duration in milliseconds, e.g. "1,234 ms". */
export function fmtMs(ms: number): string {
  return `${fmtNumber(Math.round(ms))} ms`;
}

const toDate = (d: Date | string | number) => (d instanceof Date ? d : new Date(d));

export function fmtDate(d: Date | string | number): string {
  const x = toDate(d);
  return isNaN(x.getTime()) ? String(d) : df({ dateStyle: 'medium' }).format(x);
}

export function fmtDateTime(d: Date | string | number): string {
  const x = toDate(d);
  return isNaN(x.getTime()) ? String(d) : df({ dateStyle: 'medium', timeStyle: 'medium' }).format(x);
}

export function fmtTime(d: Date | string | number): string {
  const x = toDate(d);
  return isNaN(x.getTime()) ? String(d) : df({ timeStyle: 'medium' }).format(x);
}
