import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './ar.json';
import de from './de.json';
import en from './en.json';
import es from './es.json';

/**
 * Supported UI languages. To add one: drop `<code>.json` next to en.json with the same keys
 * (src/i18n/locales.test.ts checks parity, plural forms and placeholders), import it here and
 * add an entry below. `native` is shown in the picker in the language itself.
 */
export const LANGUAGES = [
  { code: 'en', native: 'English', dir: 'ltr' },
  { code: 'de', native: 'Deutsch', dir: 'ltr' },
  { code: 'es', native: 'Español', dir: 'ltr' },
  { code: 'ar', native: 'العربية', dir: 'rtl' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];
export type LanguagePref = LanguageCode | 'system';

export const LANGUAGE_SETTING = 'general.language';
const CACHE_KEY = 'lotr.language';

export const resources = { en: { translation: en }, de: { translation: de }, es: { translation: es }, ar: { translation: ar } } as const;

const isCode = (v: unknown): v is LanguageCode => LANGUAGES.some((l) => l.code === v);

export function parseLanguagePref(v: unknown): LanguagePref {
  return isCode(v) ? v : 'system';
}

/** First supported language in the OS/webview preference list (`de-CH` -> `de`), else English. */
export function systemLanguage(prefs: readonly string[] = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []): LanguageCode {
  for (const p of prefs) {
    const base = (p ?? '').toLowerCase().split(/[-_]/)[0];
    if (isCode(base)) return base;
  }
  return 'en';
}

export function resolveLanguage(pref: LanguagePref, prefs?: readonly string[]): LanguageCode {
  return pref === 'system' ? systemLanguage(prefs) : pref;
}

export function languageDir(code: string): 'ltr' | 'rtl' {
  return LANGUAGES.find((l) => l.code === code)?.dir ?? 'ltr';
}

function cachedPref(): LanguagePref {
  try {
    return parseLanguagePref(localStorage.getItem(CACHE_KEY));
  } catch {
    return 'system';
  }
}

/** Switches the UI language and mirrors it on <html lang/dir> (Monaco and the data grid pin themselves to LTR). */
export function applyLanguage(pref: LanguagePref) {
  try {
    localStorage.setItem(CACHE_KEY, pref);
  } catch {
    /* storage unavailable: the backend setting still persists the choice */
  }
  const code = resolveLanguage(pref);
  if (i18n.language !== code) void i18n.changeLanguage(code);
  syncDocument(code);
}

function syncDocument(code: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = code;
  document.documentElement.dir = languageDir(code);
}

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLanguage(cachedPref()),
  fallbackLng: 'en',
  supportedLngs: LANGUAGES.map((l) => l.code),
  interpolation: { escapeValue: false }, // React escapes output already
});
syncDocument(i18n.language);
i18n.on('languageChanged', syncDocument);

export default i18n;
