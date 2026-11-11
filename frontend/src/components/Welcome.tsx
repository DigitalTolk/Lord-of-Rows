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

/** Launcher shown when no connection is open: connection list + quick actions. */
export function Welcome() {
  const { t } = useTranslation();
  const { connections, info, openSession, toast, reloadConnections, openTab } = useApp();
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const connect = async (id: string) => {
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
      <main className="flex h-[min(560px,90%)] w-[min(860px,100%)] overflow-hidden rounded-xl border border-border bg-bg shadow-[0_10px_40px_rgb(var(--shadow)/0.12)]">
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
            <button className="btn h-8 w-full" onClick={() => openTab({ kind: 'settings', title: t('settings.title') })}>
              <Icon name="gear" size={15} /> {t('settings.title')}
            </button>
          </div>
          <p className="mt-auto text-[0.78rem] text-muted">{t('welcome.footer', { backend: info?.secret_backend ?? t('welcome.keychain') })}</p>
        </div>

        {/* Connection list */}
        <div className="flex min-w-0 flex-1 flex-col">
          <ConnectionList sel={sel} onSelect={setSel} busy={busy} onConnect={(id) => void connect(id)} onAction={(k, c) => void action(k, c)} />
          <div className="flex items-center gap-1 border-t border-border bg-panel px-2 py-1.5">
            <button className="icon-btn" aria-label={t('conn.new')} title={t('conn.new')} onClick={() => useApp.setState({ connectionDialog: {} })}><Icon name="plus" /></button>
            <button className="icon-btn" aria-label={t('common.edit')} title={t('common.edit')} disabled={!sel} onClick={() => sel && useApp.setState({ connectionDialog: { id: sel } })}><Icon name="edit" /></button>
            <button className="icon-btn" aria-label={t('common.delete')} title={t('common.delete')} disabled={!sel} onClick={() => { const c = connections.find((x) => x.config.id === sel); if (c) void action('delete', c); }}><Icon name="trash" /></button>
            <span className="ms-auto text-[0.82rem] text-muted">{t('welcome.hint')}</span>
            <ThemeToggle />
          </div>
        </div>
      </main>
    </div>
  );
}
