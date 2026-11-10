import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ask } from '../components/ask';
import { Field, Toolbar } from '../components/ui';
import { api } from '../lib/ipc';
import { DEFAULT_KEYS, type KeyAction } from '../lib/keys';
import { errMsg, useApp } from '../store';

const SECTIONS = ['general', 'appearance', 'editor', 'grid', 'query', 'security', 'privacy', 'keys', 'a11y'] as const;

export function SettingsView() {
  const { t } = useTranslation();
  const { settings, setSetting, toast, info } = useApp();
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('appearance');
  const get = <T,>(k: string, d: T): T => (settings[k] as T) ?? d;
  const set = (k: string, v: unknown) => setSetting(k, v).catch((e) => toast('error', errMsg(e)));

  const exportSettings = async () => {
    await navigator.clipboard.writeText(JSON.stringify({ format: 'dbstudio.settings.v1', settings }, null, 2));
    toast('info', 'Settings copied to clipboard (contains no secrets)');
  };
  const importSettings = async () => {
    const text = await ask.text(t('settings.importSettings'), 'Paste settings JSON');
    if (!text) return;
    try {
      const j = JSON.parse(text);
      if (j.format !== 'dbstudio.settings.v1') throw new Error('Unrecognised settings file');
      for (const [k, v] of Object.entries(j.settings as Record<string, unknown>)) await setSetting(k, v);
      toast('ok', 'Settings imported');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar><span className="font-semibold">{t('settings.title')}</span></Toolbar>
      <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr]">
        <nav className="border-r border-border p-2" aria-label={t('settings.title')}>
          {SECTIONS.map((x) => (
            <button key={x} className={`block w-full rounded px-2 py-1 text-left ${section === x ? 'bg-accent/15 font-semibold' : 'hover:bg-panel'}`} aria-current={section === x} onClick={() => setSection(x)}>{t(`settings.${x}`)}</button>
          ))}
        </nav>
        <div className="max-w-xl overflow-auto p-4">
          {section === 'general' && (
            <>
              <p className="mb-2 text-sm">Version {info?.version} · {info?.os}/{info?.arch} · Credentials: {info?.secret_backend}</p>
              <Field label={t('settings.language')}><select className="input" value="en" disabled><option value="en">English</option></select></Field>
              <div className="flex gap-2">
                <button className="btn" onClick={exportSettings}>{t('settings.exportSettings')}</button>
                <button className="btn" onClick={importSettings}>{t('settings.importSettings')}</button>
                <button className="btn text-danger" onClick={async () => { if (await ask.confirm(t('settings.reset'), undefined, true)) { await api.resetSettings(); useApp.setState({ settings: {} }); } }}>{t('settings.reset')}</button>
              </div>
            </>
          )}
          {section === 'appearance' && (
            <>
              <Field label={t('settings.theme')}>
                <select className="input" value={get('appearance.theme', 'system')} onChange={(e) => set('appearance.theme', e.target.value)}>
                  <option value="system">{t('settings.themeSystem')}</option><option value="light">{t('settings.themeLight')}</option><option value="dark">{t('settings.themeDark')}</option><option value="hc">{t('settings.themeHc')}</option>
                </select>
              </Field>
              <Field label={t('settings.uiScale')}>
                <select className="input" value={String(get('appearance.scale', 1))} onChange={(e) => set('appearance.scale', Number(e.target.value))}>
                  {[0.85, 1, 1.15, 1.3, 1.5].map((x) => <option key={x} value={x}>{Math.round(x * 100)}%</option>)}
                </select>
              </Field>
            </>
          )}
          {section === 'editor' && (
            <>
              <Field label={t('settings.fontSize')}><input className="input" type="number" min={9} max={32} value={get('editor.fontSize', 13)} onChange={(e) => set('editor.fontSize', Number(e.target.value))} /></Field>
              <Field label={t('settings.tabSize')}><input className="input" type="number" min={1} max={8} value={get('editor.tabSize', 2)} onChange={(e) => set('editor.tabSize', Number(e.target.value))} /></Field>
              {(['wordWrap', 'minimap', 'whitespace'] as const).map((k) => (
                <label key={k} className="mb-2 flex items-center gap-2"><input type="checkbox" checked={get(`editor.${k}`, false)} onChange={(e) => set(`editor.${k}`, e.target.checked)} />{k === 'whitespace' ? 'Show whitespace' : t(`settings.${k}`)}</label>
              ))}
              <Field label="Keyword case (formatter)"><select className="input" value={get('editor.keywordCase', 'upper')} onChange={(e) => set('editor.keywordCase', e.target.value)}><option value="upper">UPPER</option><option value="lower">lower</option><option value="preserve">preserve</option></select></Field>
            </>
          )}
          {section === 'grid' && (
            <Field label={t('grid.pageSize')}><select className="input" value={get('grid.pageSize', 500)} onChange={(e) => set('grid.pageSize', Number(e.target.value))}>{[100, 500, 1000, 5000, 10000].map((n) => <option key={n}>{n}</option>)}</select></Field>
          )}
          {section === 'query' && (
            <Field label={t('settings.maxRows')} hint="Rows kept in memory per result set. Larger results are truncated (and marked).">
              <input className="input" type="number" min={1} max={1000000} value={get('query.maxRows', 10000)} onChange={(e) => set('query.maxRows', Number(e.target.value))} />
            </Field>
          )}
          {section === 'security' && (
            <>
              <p className="mb-2 text-sm">Safety policies are enforced by the backend. Production connections always require confirmation for writes and typed confirmation for destructive statements; this cannot be weakened here.</p>
              <Field label="Staging: confirm statements at or above">
                <select className="input" value={(get('safety.policy.staging', { confirm_at: 'schema' }) as { confirm_at: string }).confirm_at} onChange={(e) => set('safety.policy.staging', { name: 'staging', read_only: false, confirm_at: e.target.value, block_at: null, typed_confirmation_for_destructive: false })}>
                  {['write', 'schema', 'unknown', 'admin', 'destructive'].map((r) => <option key={r}>{r}</option>)}
                </select>
              </Field>
              <Field label={t('settings.auditText')}>
                <select className="input" value={get('audit.queryText', 'omit')} onChange={(e) => set('audit.queryText', e.target.value)}>
                  <option value="omit">{t('settings.auditOmit')}</option><option value="hash">{t('settings.auditHash')}</option><option value="redacted">{t('settings.auditRedacted')}</option>
                </select>
              </Field>
            </>
          )}
          {section === 'privacy' && (
            <>
              <p className="mb-3 rounded border border-ok/40 bg-ok/10 p-2 text-sm">{t('settings.telemetry')}</p>
              <Field label={t('settings.historyText')}>
                <select className="input" value={get('privacy.historyText', 'non_production')} onChange={(e) => set('privacy.historyText', e.target.value)}>
                  <option value="never">{t('settings.historyNever')}</option><option value="non_production">{t('settings.historyNonProd')}</option><option value="always">{t('settings.historyAlways')}</option>
                </select>
              </Field>
              <button className="btn" onClick={async () => { if (await ask.confirm(t('settings.clearHistory'))) { await api.clearHistory(null); toast('ok', 'History cleared'); } }}>{t('settings.clearHistory')}</button>
            </>
          )}
          {section === 'keys' && (
            <table className="w-full text-sm">
              <tbody>
                {(Object.keys(DEFAULT_KEYS) as KeyAction[]).map((a) => (
                  <tr key={a} className="border-b border-border">
                    <td className="py-1">{a}</td>
                    <td><input className="input font-mono" aria-label={`Shortcut for ${a}`} value={get(`keys.${a}`, DEFAULT_KEYS[a])} onChange={(e) => set(`keys.${a}`, e.target.value)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {section === 'a11y' && (
            <label className="flex items-center gap-2"><input type="checkbox" checked={get('a11y.reduceMotion', false)} onChange={(e) => set('a11y.reduceMotion', e.target.checked)} />{t('settings.reducedMotion')}</label>
          )}
        </div>
      </div>
    </div>
  );
}
