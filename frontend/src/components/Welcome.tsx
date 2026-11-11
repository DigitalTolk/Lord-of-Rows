import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import type { StoredConnection } from '../lib/types';
import { errMsg, useApp } from '../store';
import { ask } from './ask';
import { ENGINE_LABELS } from './ConnectionDialog';
import { EngineBadge } from './EngineBadge';
import logo from '../assets/logo.svg';
import { Icon } from './icons';
import { EnvBadge, isContextMenuKey, menuAnchor, MenuPopup, Spinner } from './ui';
import { ThemeToggle } from './ThemeToggle';

const optionId = (id: string) => `conn-opt-${id}`;

/** Launcher shown when no connection is open: connection list + quick actions. */
export function Welcome() {
  const { t } = useTranslation();
  const { connections, info, openSession, toast, reloadConnections, openTab } = useApp();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ c: StoredConnection; x: number; y: number } | null>(null);

  const groups = useMemo(() => {
    const s = q.toLowerCase();
    const list = connections.filter((c) => !s || [c.config.name, c.config.host, c.config.database, c.config.group, ...c.config.tags].some((x) => x?.toLowerCase().includes(s)));
    const m = new Map<string, { fav: boolean; list: StoredConnection[] }>();
    for (const c of list) {
      const fav = !!c.config.favorite;
      const g = fav ? `★ ${t('conn.favorites')}` : c.config.group || t('conn.title');
      const e = m.get(g) ?? { fav, list: [] };
      e.list.push(c);
      m.set(g, e);
    }
    return [...m.entries()].sort(([a, x], [b, y]) => (x.fav ? -1 : y.fav ? 1 : a.localeCompare(b)));
  }, [connections, q, t]);
  const flat = useMemo(() => groups.flatMap(([, g]) => g.list), [groups]);
  const focusId = sel && flat.some((c) => c.config.id === sel) ? sel : flat[0]?.config.id;

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

  const action = async (k: string, c: StoredConnection) => {
    setMenu(null);
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

  const select = (id: string) => {
    setSel(id);
    document.getElementById(optionId(id))?.focus();
  };
  const onListKey = (e: React.KeyboardEvent, c: StoredConnection) => {
    const i = flat.indexOf(c);
    if (e.key === 'ArrowDown' && i < flat.length - 1) select(flat[i + 1].config.id);
    else if (e.key === 'ArrowUp' && i > 0) select(flat[i - 1].config.id);
    else if (e.key === 'Home' && flat.length) select(flat[0].config.id);
    else if (e.key === 'End' && flat.length) select(flat[flat.length - 1].config.id);
    else if (e.key === 'Enter') void connect(c.config.id);
    else if (isContextMenuKey(e)) setMenu({ c, ...menuAnchor(e.currentTarget) });
    else return;
    e.preventDefault();
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
          <div className="flex items-center gap-2 border-b border-border p-3">
            <div className="relative flex-1">
              <Icon name="search" size={14} className="absolute start-2 top-1/2 -translate-y-1/2 text-muted" />
              <input className="input ps-7" type="search" placeholder={t('conn.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('conn.searchPlaceholder')} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {connections.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
                <Icon name="db" size={36} strokeWidth={1.2} />
                <p>{t('conn.empty')}</p>
              </div>
            )}
            {connections.length > 0 && (
              <div role="listbox" aria-label={t('conn.title')}>
                {groups.map(([g, { list }]) => (
                  <div key={g} role="group" aria-label={g}>
                    <div className="section-title" aria-hidden>{g}</div>
                    {list.map((c) => {
                      const cfg = c.config;
                      const active = sel === cfg.id;
                      return (
                        <div
                          key={cfg.id}
                          id={optionId(cfg.id)}
                          role="option"
                          aria-selected={active}
                          tabIndex={cfg.id === focusId ? 0 : -1}
                          onClick={() => setSel(cfg.id)}
                          onFocus={() => setSel(cfg.id)}
                          onDoubleClick={() => connect(cfg.id)}
                          onKeyDown={(e) => onListKey(e, c)}
                          onContextMenu={(e) => { e.preventDefault(); setSel(cfg.id); setMenu({ c, x: e.clientX, y: e.clientY }); }}
                          className={`group mx-2 flex cursor-default items-center gap-3 rounded-lg px-2 py-1.5 ${active ? 'row-selected' : 'hover:bg-hover'}`}
                        >
                          <div className="relative">
                            <EngineBadge engine={cfg.engine} size={34} />
                            {cfg.color && <span className="absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg" style={{ background: cfg.color }} />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium">{cfg.name}</span>
                              {cfg.read_only && <><Icon name="lock" size={12} /><span className="sr-only">{t('welcome.readOnly')}</span></>}
                            </div>
                            <div className={`truncate text-[0.85rem] ${active ? 'text-on-solid' : 'text-muted'}`} dir="auto">
                              {ENGINE_LABELS[cfg.engine]} · {cfg.engine === 'sqlite' ? cfg.database : `${cfg.username ? cfg.username + '@' : ''}${cfg.host ?? ''}${cfg.database ? ' / ' + cfg.database : ''}`}
                            </div>
                          </div>
                          <EnvBadge env={cfg.environment} />
                          {busy === cfg.id ? <Spinner label={t('welcome.connecting')} /> : (
                            // Mouse shortcut only; keyboard users press Enter on the option (no focusable controls inside role=option).
                            <span aria-hidden title={t('common.connect')} className={`icon-btn opacity-0 group-hover:opacity-100 ${active ? 'text-on-solid hover:bg-on-solid/20 hover:text-on-solid' : ''}`} onClick={(e) => { e.stopPropagation(); void connect(cfg.id); }}>
                              <Icon name="power" size={15} />
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 border-t border-border bg-panel px-2 py-1.5">
            <button className="icon-btn" aria-label={t('conn.new')} title={t('conn.new')} onClick={() => useApp.setState({ connectionDialog: {} })}><Icon name="plus" /></button>
            <button className="icon-btn" aria-label={t('common.edit')} title={t('common.edit')} disabled={!sel} onClick={() => sel && useApp.setState({ connectionDialog: { id: sel } })}><Icon name="edit" /></button>
            <button className="icon-btn" aria-label={t('common.delete')} title={t('common.delete')} disabled={!sel} onClick={() => { const c = connections.find((x) => x.config.id === sel); if (c) void action('delete', c); }}><Icon name="trash" /></button>
            <span className="ms-auto text-[0.82rem] text-muted">{t('welcome.hint')}</span>
            <ThemeToggle />
          </div>
        </div>
      </main>
      {menu && (
        <MenuPopup x={menu.x} y={menu.y} label={menu.c.config.name} onClose={() => setMenu(null)}>
          {[['connect', t('common.connect')], ['edit', t('common.edit')], ['duplicate', t('common.duplicate')], ['favorite', menu.c.config.favorite ? t('welcome.removeFavorite') : t('welcome.addFavorite')], ['delete', t('common.delete')]].map(([k, l]) => (
            <button key={k} role="menuitem" className={`menu-item ${k === 'delete' ? 'text-danger' : ''}`} onClick={() => action(k, menu.c)}>{l}</button>
          ))}
        </MenuPopup>
      )}
    </div>
  );
}
