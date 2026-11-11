import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ask } from '../components/ask';
import { api } from '../lib/ipc';
import { capabilityText, signerText, usePlugins } from '../lib/plugins';
import type { PluginCapability, PluginInfo } from '../lib/types';
import { errMsg, useApp } from '../store';

export function PluginsSettings() {
  const { t } = useTranslation();
  const toast = useApp((s) => s.toast);
  const { plugins, load, put } = usePlugins();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void load();
  }, [load]);

  const guard = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const install = () =>
    guard(async () => {
      const f = await api.pickFile(false, undefined, ['dbsplugin']);
      if (!f) return;
      const p = await api.pluginInspect(f.grant);
      const m = p.manifest;
      const lines = [
        m.author ? t('plugins.nameVersionBy', { name: m.name, version: m.version, author: m.author }) : `${m.name} ${m.version}`,
        m.description,
        '',
        signerText(p.signer),
        p.installed_version ? t('plugins.replaces', { version: p.installed_version }) : '',
        '',
        t('plugins.requested'),
        ...m.capabilities.map((c) => `• ${c}: ${capabilityText(c)}`),
        '',
        t('plugins.sandboxLine'),
      ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
      if (p.incompatible) throw new Error(p.incompatible);
      if (!(await ask.confirm(t('plugins.installTitle', { id: m.id }), lines.join('\n')))) return;
      const untrusted = p.signer.kind === 'unsigned' || p.signer_changed;
      if (untrusted) {
        const why = p.signer_changed
          ? t('plugins.signerChanged')
          : t('plugins.unsignedWarning');
        if (!(await ask.confirm(t('plugins.unverifiedTitle'), why, true))) return;
      }
      const info = await api.pluginInstall(f.grant, p.wasm_sha256, untrusted);
      put(info);
      toast('ok', t('plugins.installed', { name: m.name }));
    });

  const setGrant = (p: PluginInfo, c: PluginCapability, on: boolean) =>
    guard(async () => {
      const grants = on ? [...p.grants, c] : p.grants.filter((x) => x !== c);
      put(await api.pluginSetGrants(p.id, grants));
    });
  const setEnabled = (p: PluginInfo, on: boolean) => guard(async () => put(await api.pluginSetEnabled(p.id, on)));
  const remove = (p: PluginInfo) =>
    guard(async () => {
      if (!(await ask.confirm(t('plugins.removeTitle', { name: p.manifest.name }), t('plugins.removeBody'), true))) return;
      await api.pluginRemove(p.id);
      await load();
    });
  const setSetting = (p: PluginInfo, key: string, value: unknown) =>
    guard(async () => put(await api.pluginSetSettings(p.id, { ...p.settings, [key]: value })));

  return (
    <>
      <p className="mb-2 text-sm">
        {t('plugins.intro')}
      </p>
      <button className="btn btn-primary mb-3" disabled={busy} onClick={install}>{t('plugins.install')}</button>
      {plugins.length === 0 && <p className="text-sm text-muted">{t('plugins.none')}</p>}
      {plugins.map((p) => (
        <section key={p.id} className="mb-3 rounded border border-border p-3" aria-label={p.manifest.name}>
          <div className="flex items-baseline gap-2">
            <span className="font-semibold">{p.manifest.name}</span>
            <span className="text-sm text-muted">{p.version}</span>
            <span className={`text-xs ${p.signer.kind === 'verified' ? 'text-ok' : 'text-warn'}`}>{signerText(p.signer)}</span>
            <label className="ms-auto flex items-center gap-1 text-sm">
              <input type="checkbox" checked={p.enabled} disabled={busy || (!p.enabled && (p.grants.length === 0 || !!p.incompatible))} onChange={(e) => setEnabled(p, e.target.checked)} />
              {t('plugins.enabled')}
            </label>
            <button className="btn btn-ghost text-danger" disabled={busy} onClick={() => remove(p)}>{t('plugins.remove')}</button>
          </div>
          <div className="text-xs text-muted">{p.id}{p.manifest.author ? ` · ${p.manifest.author}` : ''}</div>
          {p.manifest.description && <p className="mt-1 text-sm">{p.manifest.description}</p>}
          {p.incompatible && <p role="alert" className="mt-1 text-sm text-warn">{p.incompatible}</p>}
          {p.last_error && <p role="alert" className="mt-1 text-sm text-danger">{t('plugins.disabledAfter', { error: p.last_error })}</p>}
          <fieldset className="mt-2">
            <legend className="text-sm font-semibold">{t('plugins.permissions')}</legend>
            {p.manifest.capabilities.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={p.grants.includes(c)} disabled={busy} onChange={(e) => setGrant(p, c, e.target.checked)} />
                <span className="font-mono text-xs">{c}</span> — {capabilityText(c)}
              </label>
            ))}
          </fieldset>
          {(p.manifest.settings ?? []).length > 0 && (
            <fieldset className="mt-2">
              <legend className="text-sm font-semibold">{t('plugins.settings')}</legend>
              {(p.manifest.settings ?? []).map((s) => {
                const v = p.settings[s.key] ?? s.default;
                return s.type === 'bool' ? (
                  <label key={s.key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!v} onChange={(e) => setSetting(p, s.key, e.target.checked)} />{s.label}</label>
                ) : (
                  <label key={s.key} className="mb-1 flex items-center gap-2 text-sm">
                    <span className="w-40">{s.label}</span>
                    <input className="input" type={s.type === 'number' ? 'number' : 'text'} defaultValue={String(v ?? '')}
                      onBlur={(e) => setSetting(p, s.key, s.type === 'number' ? Number(e.target.value) : e.target.value)} />
                  </label>
                );
              })}
            </fieldset>
          )}
        </section>
      ))}
    </>
  );
}
