import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import type { StoredConnection } from '../lib/types';
import { errMsg, useApp } from '../store';
import { ask } from './ask';
import { ConnectionList, type ConnAction } from './ConnectionList';
import logo from '../assets/logo.svg';
import { Icon } from './icons';
import { ThemeToggle } from './ThemeToggle';
import { openImportDialog } from './ImportConnectionsDialog';
import { AccessPanel } from './AccessPanel';
import { draftFrom, managedState, readyCount } from '../lib/access';
import { useAccess } from '../lib/accessStore';

/** Launcher shown when no connection is open: connection list + quick actions. */
export function Welcome() {
  const { t } = useTranslation();
  const { connections, info, openSession, toast, reloadConnections, openTab } = useApp();
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const tab = useAccess((s) => s.launcherTab);
  const ready = useAccess((s) => readyCount(s.requests, Math.floor(Date.now() / 1000)));

  /** An expired managed connection can't be opened: offer a new request instead. */
  const requestAgain = (c: StoredConnection) => {
    const m = c.config.managed_by;
    if (m && m.provider_id !== useAccess.getState().providerId && useAccess.getState().providers?.some((p) => p.id === m.provider_id)) void useAccess.getState().selectProvider(m.provider_id);
    const r = m && useAccess.getState().requests?.find((x) => x.id === m.request_id);
    useAccess.getState().openAccess(r ? draftFrom(r) : undefined);
  };

  const connect = async (id: string) => {
    const c = connections.find((x) => x.config.id === id);
    if (c && managedState(c.config, Math.floor(Date.now() / 1000))?.expired) {
      toast('info', t('access.expiredConnect', { name: c.config.name }));
      return requestAgain(c);
    }
    setBusy(id);
    try {
      await openSession(id);
    } catch (e) {
      const msg = errMsg(e);
      if (/password|authentication/i.test(msg)) {
        const pw = await ask.password(t('conn.password'), msg);
        if (pw) {
          try {
            await openSession(id, pw);
          } catch (e2) {
            toast('error', errMsg(e2));
          }
        }
      } else toast('error', msg);
    } finally {
      setBusy(null);
    }
  };

  const action = async (k: ConnAction, c: StoredConnection) => {
    const cfg = c.config;
    if (k === 'connect') return connect(cfg.id);
    if (k === 'requestAgain') return requestAgain(c);
    if (k === 'edit') return useApp.setState({ connectionDialog: { id: cfg.id } });
    if (k === 'duplicate') return useApp.setState({ connectionDialog: { duplicateOf: cfg.id } });
    if (k === 'favorite') {
      await api.saveConnection({ ...cfg, favorite: !cfg.favorite }, null);
      return reloadConnections();
    }
    if (k === 'delete') {
      if (!(await ask.confirm(t('common.delete'), t('conn.deleteConfirm', { name: cfg.name }), true))) return;
      await api.deleteConnection(cfg.id);
      return reloadConnections();
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-panel p-6">
      <main className="flex h-[min(600px,92%)] w-[min(880px,100%)] overflow-hidden rounded-xl border border-border bg-bg shadow-[0_10px_40px_rgb(var(--shadow)/0.12)]">
        {/* Brand / actions */}
        <div className="flex w-[300px] shrink-0 flex-col items-center border-e border-border bg-panel px-6 py-8 text-center">
          <img src={logo} alt="" width={88} height={88} className="mb-3 h-[88px] w-[88px] drop-shadow-lg" draggable={false} />
          <h1 className="text-xl font-semibold">{t('app.name')}</h1>
          <p className="mb-6 text-[0.85rem] text-muted">{t('welcome.version', { version: info?.version ?? '' })}</p>
          <div className="flex w-full flex-col gap-2">
            <button className="btn btn-primary h-8 w-full" onClick={() => useApp.setState({ connectionDialog: {} })}>
              <Icon name="plus" size={15} /> {t('welcome.create')}
            </button>
            <button className="btn h-8 w-full" onClick={async () => {
              const u = await ask.text(t('conn.importUrl'), 'postgresql://user:password@host:5432/database');
              if (!u) return;
              try {
                const p = await api.parseConnectionUrl(u);
                const saved = await api.saveConnection({ ...p.config, id: '00000000-0000-0000-0000-000000000000' }, p.password ?? null);
                await reloadConnections();
                await connect(saved.id);
              } catch (e) { toast('error', errMsg(e)); }
            }}>
              <Icon name="download" size={15} /> {t('welcome.fromUrl')}
            </button>
            <button className="btn h-8 w-full" onClick={() => openImportDialog()}>
              <Icon name="upload" size={15} /> {t('welcome.importConnections')}
            </button>
            <button className="btn h-8 w-full" onClick={() => { openTab({ kind: 'settings', title: t('settings.title') }); useApp.setState({ launcher: false }); }}>
              <Icon name="gear" size={15} /> {t('settings.title')}
            </button>
          </div>
          <p className="mt-auto text-[0.78rem] text-muted">{t('welcome.footer', { backend: info?.secret_backend ?? t('welcome.keychain') })}</p>
        </div>

        {/* Connection list | access requests */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center border-b border-border px-3 pt-2.5 pb-2">
            <div className="seg" role="tablist" aria-label={t('welcome.panes')}>
              <button role="tab" aria-selected={tab === 'connections'} onClick={() => useAccess.setState({ launcherTab: 'connections' })}>
                <Icon name="db" size={13} className="me-1 inline" /> {t('conn.title')}
              </button>
              <button role="tab" aria-selected={tab === 'access'} onClick={() => useAccess.setState({ launcherTab: 'access' })}>
                <Icon name="key" size={13} className="me-1 inline" /> {t('access.tab')}
                {ready > 0 && <span className="ms-1.5 inline-flex min-w-[18px] justify-center rounded-full bg-ok px-1 text-[0.7rem] font-semibold leading-[18px] text-on-solid" aria-label={t('access.readyCount', { count: ready })}>{ready}</span>}
              </button>
            </div>
          </div>
          {tab === 'access' ? (
            <AccessPanel />
          ) : (
            <ConnectionList sel={sel} onSelect={setSel} busy={busy} onConnect={(id) => void connect(id)} onAction={(k, c) => void action(k, c)} />
          )}
          <div className="flex items-center gap-1 border-t border-border bg-panel px-2 py-1.5">
            {tab === 'connections' && (
              <>
                <button className="icon-btn" aria-label={t('conn.new')} title={t('conn.new')} onClick={() => useApp.setState({ connectionDialog: {} })}><Icon name="plus" /></button>
                <button className="icon-btn" aria-label={t('common.edit')} title={t('common.edit')} disabled={!sel} onClick={() => sel && useApp.setState({ connectionDialog: { id: sel } })}><Icon name="edit" /></button>
                <button className="icon-btn" aria-label={t('common.delete')} title={t('common.delete')} disabled={!sel} onClick={() => { const c = connections.find((x) => x.config.id === sel); if (c) void action('delete', c); }}><Icon name="trash" /></button>
              </>
            )}
            <span className="ms-auto text-[0.82rem] text-muted">{tab === 'connections' ? t('welcome.hint') : t('access.footer')}</span>
            <ThemeToggle />
          </div>
        </div>
      </main>
    </div>
  );
}
