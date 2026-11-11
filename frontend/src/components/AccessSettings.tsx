import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currentProvider, useAccess } from '../lib/accessStore';
import { useApp } from '../store';
import { ProviderForm } from './AccessPanel';

/** Settings → Access: the configured access providers and the session of the selected one. */
export function AccessSettingsSection() {
  const { t } = useTranslation();
  const providers = useAccess((s) => s.providers);
  const provider = useAccess(currentProvider);
  const status = useAccess((s) => s.status);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    void useAccess.getState().loadProviders();
  }, []);
  const openAccess = () => {
    useAccess.getState().openAccess();
    useApp.setState({ launcher: true });
  };
  return (
    <div className="flex max-w-[560px] flex-col gap-3">
      <p className="text-sm text-muted">{t('access.settingsIntro')}</p>
      {(providers ?? []).length > 0 && (
        <ul className="flex flex-col gap-1" aria-label={t('access.providers')}>
          {(providers ?? []).map((p) => (
            <li key={p.id} className={`flex items-center gap-2 rounded border px-2 py-1.5 text-sm ${p.id === provider?.id ? 'border-accent' : 'border-border'}`}>
              <span className="font-medium">{p.name}</span>
              <span className="truncate text-xs text-muted">{p.base_url}</span>
              {p.id === provider?.id ? (
                <span className="ms-auto text-xs text-muted">{status?.signed_in ? t('access.signedInAs', { email: status.user?.email ?? '' }) : t('access.notSignedIn')}</span>
              ) : (
                <button className="btn ms-auto h-6" onClick={() => void useAccess.getState().selectProvider(p.id)}>{t('access.use')}</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {provider && !adding && (
        <>
          <h3 className="label">{t('access.editProvider')}</h3>
          <ProviderForm key={provider.id} edit />
          <div className="flex gap-2">
            {status?.signed_in ? (
              <button className="btn h-7" onClick={() => void useAccess.getState().signOut()}>{t('access.signOut')}</button>
            ) : (
              <button className="btn h-7" onClick={openAccess}>{t('access.openAccess')}</button>
            )}
            <button className="btn h-7" onClick={() => setAdding(true)}>{t('access.addAnother')}</button>
          </div>
        </>
      )}
      {(!provider || adding) && <ProviderForm onDone={provider ? () => setAdding(false) : undefined} />}
    </div>
  );
}
