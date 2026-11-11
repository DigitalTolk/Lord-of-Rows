import { afterAll, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { fmtBytes, fmtDate, fmtNumber } from './format';

describe('locale-aware formatting follows the UI language', () => {
  afterAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('numbers', async () => {
    await i18n.changeLanguage('en');
    expect(fmtNumber(1234567.5)).toBe('1,234,567.5');
    await i18n.changeLanguage('de');
    expect(fmtNumber(1234567.5)).toBe('1.234.567,5');
    await i18n.changeLanguage('es');
    expect(fmtNumber(1234567)).toBe('1.234.567');
    expect(fmtNumber(null)).toBe('');
  });

  it('bytes and dates', async () => {
    await i18n.changeLanguage('de');
    expect(fmtBytes(1536)).toBe('1,5 KB');
    expect(fmtDate('2026-03-05T12:00:00Z')).toMatch(/05\.03\.2026|5\. März 2026/);
    await i18n.changeLanguage('en');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtDate('2026-03-05T12:00:00Z')).toMatch(/Mar 5, 2026/);
    expect(fmtDate('not a date')).toBe('not a date');
  });
});
