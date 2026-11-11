import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ask } from '../components/ask';
import { Field, Toolbar } from '../components/ui';
import { api } from '../lib/ipc';
import type { AiProvider, AiStatus } from '../lib/types';
import { DEFAULT_KEYS, type KeyAction } from '../lib/keys';
import type { UpdateChannel, UpdateCheck, UpdateProgress } from '../lib/types';
import { channelOf, endpointKey, formatBytes, PROGRESS_EVENT, progressPercent } from '../lib/updates';
import { fmtNumber } from '../lib/format';
import { LANGUAGE_SETTING, LANGUAGES, parseLanguagePref, systemLanguage } from '../i18n';
import { PluginsSettings } from './PluginsSettings';
import { AccessSettingsSection } from '../components/AccessSettings';
import { errMsg, useApp } from '../store';

const SECTIONS = ['general', 'appearance', 'editor', 'grid', 'query', 'security', 'privacy', 'ai', 'access', 'keys', 'plugins', 'a11y', 'updates'] as const;

const DEFAULT_MODEL: Record<AiProvider, string> = { anthropic: 'claude-opus-5-5', openai_compatible: 'llama3.1' };
const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

function AiSettingsSection() {
  const { t } = useTranslation();
  const { settings, setSetting, toast } = useApp();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState('');
  const [testing, setTesting] = useState(false);
  const provider = (settings['ai.provider'] as AiProvider | undefined) ?? 'anthropic';
  const [model, setModel] = useState(String(settings['ai.model'] ?? ''));
  const [baseUrl, setBaseUrl] = useState(String(settings['ai.baseUrl'] ?? ''));
  const refresh = () => api.aiStatus().then(setStatus).catch((e) => toast('error', errMsg(e)));
  useEffect(() => {
    void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = async (k: string, v: unknown) => {
    try {
      await setSetting(k, v);
      await refresh();
    } catch (e) {
      toast('error', errMsg(e));
    }
  };
  const enabled = settings['ai.enabled'] === true;

  const saveKey = async (value: string) => {
    try {
      await api.aiSetApiKey(provider, value);
      setKey('');
      toast('ok', value ? t('ai.keySaved') : t('ai.keyRemoved'));
      await refresh();
    } catch (e) {
      toast('error', errMsg(e));
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      const a = await api.aiTest();
      toast('ok', t('ai.testOk', { model: a.model, ms: a.duration_ms }));
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <div className="mb-3 rounded border border-warn/40 bg-warn/10 p-2 text-sm">
        <p className="mb-1 font-semibold">{t('ai.privacyTitle')}</p>
        <ul className="list-disc ps-5">
          {(['privacy1', 'privacy2', 'privacy3', 'privacy4', 'privacy5'] as const).map((k) => <li key={k}>{t(`ai.${k}`)}</li>)}
        </ul>
      </div>
      <label className="mb-3 flex items-center gap-2 font-semibold">
        <input type="checkbox" checked={enabled} onChange={(e) => void set('ai.enabled', e.target.checked)} />{t('ai.enable')}
      </label>
      <Field label={t('ai.provider')}>
        <select className="input" value={provider} onChange={(e) => { setModel(''); void set('ai.provider', e.target.value).then(() => set('ai.model', '')); }}>
          <option value="anthropic">{t('ai.providerAnthropic')}</option>
          <option value="openai_compatible">{t('ai.providerOpenai')}</option>
        </select>
      </Field>
      <Field label={t('ai.model')} hint={t('ai.modelHint', { model: DEFAULT_MODEL[provider] })}>
        <input className="input font-mono" placeholder={DEFAULT_MODEL[provider]} value={model} onChange={(e) => setModel(e.target.value)} onBlur={() => model !== String(settings['ai.model'] ?? '') && void set('ai.model', model.trim())} />
      </Field>
      {provider === 'openai_compatible' && (
        <Field label={t('ai.baseUrl')} hint={t('ai.baseUrlHint')}>
          <input className="input font-mono" placeholder={DEFAULT_BASE_URL} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} onBlur={() => baseUrl !== String(settings['ai.baseUrl'] ?? '') && void set('ai.baseUrl', baseUrl.trim())} />
        </Field>
      )}
      <Field label={t('ai.apiKey')} hint={status?.has_api_key ? t('ai.keyStored') : provider === 'anthropic' ? t('ai.keyRequired') : t('ai.keyOptional')}>
        <input className="input font-mono" type="password" autoComplete="off" value={key} placeholder={status?.has_api_key ? '••••••••' : ''} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <div className="mb-3 flex gap-2">
        <button className="btn" disabled={!key.trim()} onClick={() => void saveKey(key.trim())}>{t('ai.saveKey')}</button>
        {status?.has_api_key && <button className="btn text-danger" onClick={() => void saveKey('')}>{t('ai.removeKey')}</button>}
        <button className="btn ms-auto" disabled={!enabled || testing} onClick={() => void test()} title={t('ai.testHint')}>{t('ai.test')}</button>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={settings['ai.redactLiterals'] !== false} onChange={(e) => void set('ai.redactLiterals', e.target.checked)} />{t('ai.redactLiterals')}
      </label>
      <p className="ms-6 text-xs text-muted">{t('ai.redactLiteralsHint')}</p>
    </>
  );
}

export function SettingsView() {
  const { t } = useTranslation();
  const { settings, setSetting, toast, info } = useApp();
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('appearance');
  const get = <T,>(k: string, d: T): T => (settings[k] as T) ?? d;
  const set = (k: string, v: unknown) => setSetting(k, v).catch((e) => toast('error', errMsg(e)));

  const exportSettings = async () => {
    await navigator.clipboard.writeText(JSON.stringify({ format: 'dbstudio.settings.v1', settings }, null, 2));
    toast('info', t('settings.exportedToast'));
  };
  const importSettings = async () => {
    const text = await ask.text(t('settings.importSettings'), t('settings.pasteJson'));
    if (!text) return;
    try {
      const j = JSON.parse(text);
      if (j.format !== 'dbstudio.settings.v1') throw new Error(t('settings.badFile'));
      for (const [k, v] of Object.entries(j.settings as Record<string, unknown>)) await setSetting(k, v);
      toast('ok', t('settings.importedToast'));
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar><span className="font-semibold">{t('settings.title')}</span></Toolbar>
      <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr]">
        <nav className="border-e border-border p-2" aria-label={t('settings.title')}>
          {SECTIONS.map((x) => (
            <button key={x} className={`block w-full rounded px-2 py-1 text-start ${section === x ? 'bg-accent/15 font-semibold' : 'hover:bg-panel'}`} aria-current={section === x} onClick={() => setSection(x)}>{t(`settings.${x}`)}</button>
          ))}
        </nav>
        <section className="max-w-xl overflow-auto p-4" aria-label={t(`settings.${section}`)}>
          {section === 'general' && (
            <>
              <p className="mb-2 text-sm">{t('settings.about', { version: info?.version ?? '', platform: `${info?.os ?? ''}/${info?.arch ?? ''}`, backend: info?.secret_backend ?? '' })}</p>
              <Field label={t('settings.language')} hint={t('settings.languageHint')}>
                <select className="input" value={parseLanguagePref(settings[LANGUAGE_SETTING])} onChange={(e) => set(LANGUAGE_SETTING, e.target.value)}>
                  <option value="system">{t('settings.languageSystem', { name: LANGUAGES.find((l) => l.code === systemLanguage())?.native })}</option>
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.native}</option>)}
                </select>
              </Field>
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
                  {[0.85, 1, 1.15, 1.3, 1.5].map((x) => <option key={x} value={x}>{fmtNumber(x, { style: 'percent' })}</option>)}
                </select>
              </Field>
            </>
          )}
          {section === 'editor' && (
            <>
              <Field label={t('settings.fontSize')}><input className="input" type="number" min={9} max={32} value={get('editor.fontSize', 13)} onChange={(e) => set('editor.fontSize', Number(e.target.value))} /></Field>
              <Field label={t('settings.tabSize')}><input className="input" type="number" min={1} max={8} value={get('editor.tabSize', 2)} onChange={(e) => set('editor.tabSize', Number(e.target.value))} /></Field>
              {(['wordWrap', 'minimap', 'whitespace'] as const).map((k) => (
                <label key={k} className="mb-2 flex items-center gap-2"><input type="checkbox" checked={get(`editor.${k}`, false)} onChange={(e) => set(`editor.${k}`, e.target.checked)} />{t(`settings.${k}`)}</label>
              ))}
              <Field label={t('settings.keywordCase')}><select className="input" value={get('editor.keywordCase', 'upper')} onChange={(e) => set('editor.keywordCase', e.target.value)}><option value="upper">{t('settings.caseUpper')}</option><option value="lower">{t('settings.caseLower')}</option><option value="preserve">{t('settings.casePreserve')}</option></select></Field>
            </>
          )}
          {section === 'grid' && (
            <Field label={t('grid.pageSize')}><select className="input" value={get('grid.pageSize', 500)} onChange={(e) => set('grid.pageSize', Number(e.target.value))}>{[100, 500, 1000, 5000, 10000].map((n) => <option key={n}>{n}</option>)}</select></Field>
          )}
          {section === 'query' && (
            <Field label={t('settings.maxRows')} hint={t('settings.maxRowsHint')}>
              <input className="input" type="number" min={1} max={1000000} value={get('query.maxRows', 10000)} onChange={(e) => set('query.maxRows', Number(e.target.value))} />
            </Field>
          )}
          {section === 'security' && (
            <>
              <p className="mb-2 text-sm">{t('settings.securityNote')}</p>
              <Field label={t('settings.stagingConfirm')}>
                <select className="input" value={(get('safety.policy.staging', { confirm_at: 'schema' }) as { confirm_at: string }).confirm_at} onChange={(e) => set('safety.policy.staging', { name: 'staging', read_only: false, confirm_at: e.target.value, block_at: null, typed_confirmation_for_destructive: false })}>
                  {['write', 'schema', 'unknown', 'admin', 'destructive'].map((r) => <option key={r} value={r}>{t(`safety.risk.${r}`)}</option>)}
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
              <button className="btn" onClick={async () => { if (await ask.confirm(t('settings.clearHistory'))) { await api.clearHistory(null); toast('ok', t('settings.historyCleared')); } }}>{t('settings.clearHistory')}</button>
            </>
          )}
          {section === 'keys' && (
            <table className="w-full text-sm">
              <tbody>
                {(Object.keys(DEFAULT_KEYS) as KeyAction[]).map((a) => (
                  <tr key={a} className="border-b border-border">
                    <td className="py-1">{t(`keys.${a}`)}</td>
                    <td><input className="input font-mono" dir="ltr" aria-label={t('settings.shortcutFor', { action: t(`keys.${a}`) })} value={get(`keys.${a}`, DEFAULT_KEYS[a])} onChange={(e) => set(`keys.${a}`, e.target.value)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {section === 'ai' && <AiSettingsSection />}
          {section === 'access' && <AccessSettingsSection />}
          {section === 'plugins' && <PluginsSettings />}
          {section === 'a11y' && (
            <label className="flex items-center gap-2"><input type="checkbox" checked={get('a11y.reduceMotion', false)} onChange={(e) => set('a11y.reduceMotion', e.target.checked)} />{t('settings.reducedMotion')}</label>
          )}
          {section === 'updates' && <UpdatesSection />}
        </section>
      </div>
    </div>
  );
}

function EndpointField({ channel }: { channel: UpdateChannel }) {
  const { t } = useTranslation();
  const { settings, setSetting, toast } = useApp();
  const saved = (settings[endpointKey(channel)] as string | undefined) ?? '';
  const [draft, setDraft] = useState(saved);
  const save = () => {
    if (draft.trim() === saved) return;
    // The backend validates (https only) and audits the change.
    setSetting(endpointKey(channel), draft.trim()).catch((e) => toast('error', errMsg(e)));
  };
  return (
    <Field label={t(channel === 'stable' ? 'updates.endpointStable' : 'updates.endpointBeta')} hint={t('updates.endpointHint')}>
      <input className="input font-mono" type="url" placeholder="https://…/latest.json" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save} />
    </Field>
  );
}

function UpdatesSection() {
  const { t } = useTranslation();
  const { settings, setSetting, toast } = useApp();
  const channel = channelOf(settings);
  const [busy, setBusy] = useState<'checking' | 'installing' | null>(null);
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    let unlisten: (() => void) | undefined;
    void listen<UpdateProgress>(PROGRESS_EVENT, (e) => setProgress(e.payload)).then((f) => {
      if (dead) f();
      else unlisten = f;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);

  const set = (k: string, v: unknown) => setSetting(k, v).catch((e) => toast('error', errMsg(e)));
  const check = async () => {
    setBusy('checking');
    setError(null);
    setResult(null);
    try {
      setResult(await api.checkUpdate());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const install = async (version: string) => {
    setBusy('installing');
    setError(null);
    setProgress(null);
    try {
      const r = await api.installUpdate(version);
      setInstalled(r.version);
    } catch (e) {
      // Failed or rejected (e.g. bad signature): nothing was installed, the app keeps running.
      setError(t('updates.failed', { error: errMsg(e) }));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };
  const pct = progressPercent(progress);

  return (
    <>
      <p className="mb-3 text-sm">{t('updates.signed')}</p>
      <Field label={t('updates.channel')}>
        <select className="input" value={channel} disabled={busy !== null} onChange={(e) => { setResult(null); set('updates.channel', e.target.value); }}>
          <option value="stable">{t('updates.stable')}</option>
          <option value="beta">{t('updates.beta')}</option>
        </select>
      </Field>
      <label className="mb-1 flex items-center gap-2">
        <input type="checkbox" checked={settings['updates.autoCheck'] === true} onChange={(e) => set('updates.autoCheck', e.target.checked)} />
        {t('updates.autoCheck')}
      </label>
      <p className="mb-3 text-xs text-muted">{t('updates.autoCheckHint')}</p>
      <EndpointField key={`stable:${String(settings['updates.endpoint.stable'] ?? '')}`} channel="stable" />
      <EndpointField key={`beta:${String(settings['updates.endpoint.beta'] ?? '')}`} channel="beta" />
      <button className="btn" disabled={busy !== null || installed !== null} onClick={check}>{busy === 'checking' ? t('updates.checking') : t('updates.checkNow')}</button>

      <div className="mt-3 text-sm" aria-live="polite">
        {error && <p role="alert" className="rounded border border-danger/40 bg-danger/10 p-2 text-danger">{error}</p>}
        {result?.status === 'not_configured' && <p>{t('updates.notConfigured', { channel: t(`updates.${result.channel}`) })}</p>}
        {result?.status === 'up_to_date' && <p>{t('updates.upToDate', { version: result.current_version })}</p>}
        {result?.status === 'available' && !installed && (
          <div className="rounded border border-border p-2">
            <p className="font-semibold">{t('updates.available', { version: result.version, current: result.current_version })}</p>
            {result.date && <p className="text-xs text-muted">{new Date(result.date).toLocaleDateString()}</p>}
            {result.notes && (
              <>
                <p className="label mt-2">{t('updates.notes')}</p>
                {/* Notes come from the update server: rendered as plain text, never HTML. */}
                <pre dir="auto" className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-panel p-2 font-sans text-xs">{result.notes}</pre>
              </>
            )}
            {busy === 'installing' ? (
              <div className="mt-2">
                <p className="text-xs">
                  {progress?.phase === 'verifying' ? t('updates.verifying') : progress?.phase === 'installing' ? t('updates.installing') : t('updates.downloading')}
                  {progress?.phase === 'downloading' && ` ${formatBytes(progress.downloaded)}${progress.total ? ` / ${formatBytes(progress.total)}` : ''}`}
                </p>
                <div className="mt-1 h-2 w-full overflow-hidden rounded bg-panel" role="progressbar" aria-label={t('updates.downloading')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
                  <div className={`h-full bg-accent ${pct === null ? 'w-1/3 animate-pulse' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} />
                </div>
              </div>
            ) : (
              <button className="btn btn-primary mt-2" disabled={busy !== null} onClick={() => install(result.version)}>{t('updates.install')}</button>
            )}
          </div>
        )}
        {installed && (
          <div className="rounded border border-ok/40 bg-ok/10 p-2">
            <p className="mb-2">{t('updates.restartPrompt', { version: installed })}</p>
            <div className="flex gap-2">
              <button className="btn btn-primary" onClick={() => api.restartAfterUpdate().catch((e) => toast('error', errMsg(e)))}>{t('updates.restartNow')}</button>
              <button className="btn" onClick={() => setResult(null)}>{t('updates.later')}</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
