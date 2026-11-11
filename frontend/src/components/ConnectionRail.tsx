import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { fmtNumber } from '../lib/format';
import { displayCombo } from '../lib/keys';
import { useApp, type OpenSession } from '../store';
import { EngineBadge } from './EngineBadge';
import { Icon } from './icons';
import { isContextMenuKey, menuAnchor, MenuPopup } from './ui';

const ENV_DOT: Record<string, string> = { production: 'bg-danger', staging: 'bg-warn', testing: 'bg-purple', development: 'bg-accent', local: 'bg-ok', custom: 'bg-muted' };
const ENV_COLOR: Record<string, string> = { production: 'rgb(var(--danger))', staging: 'rgb(var(--warn))', testing: 'rgb(var(--purple))', development: 'rgb(var(--accent))', local: 'rgb(var(--ok))', custom: 'rgb(var(--muted))' };

/**
 * Left rail. Top: open connections (badge + name; click to switch, each keeps its
 * own tabs). Below: the active connection's opened databases/schemas.
 */
export function ConnectionRail() {
  const { t } = useTranslation();
  const { sessions, activeSession, switchSession, closeSession, tabs } = useApp();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const list = Object.values(sessions);
  const activeS = activeSession ? sessions[activeSession] : undefined;

  // Up/Down move between rail buttons (each is also a normal Tab stop); Shift+F10 opens the menu.
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || btn.getAttribute('role') === 'option') return;
    if (isContextMenuKey(e) && btn.dataset.session) {
      e.preventDefault();
      setMenu({ id: btn.dataset.session, ...menuAnchor(btn) });
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button'));
    const i = all.indexOf(btn as HTMLButtonElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
    e.preventDefault();
  };

  return (
    <nav aria-label={t('rail.label')} className="flex w-[76px] shrink-0 flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden border-e border-border bg-panel py-2" onKeyDown={onKeyDown}>
      {list.map((s, i) => {
        const active = s.session_id === activeSession;
        const count = tabs.filter((x) => x.sessionId === s.session_id).length;
        const shortcut = i < 9 ? displayCombo(`Mod+${i + 1}`) : '';
        return (
          <button
            key={s.session_id}
            data-session={s.session_id}
            onClick={() => switchSession(s.session_id)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ id: s.session_id, x: e.clientX, y: e.clientY }); }}
            title={`${s.config.name}\n${s.server.version.split(' on ')[0]}${shortcut ? `\n${shortcut}` : ''}`}
            aria-label={`${s.config.name}${active ? t('rail.active') : ''}`}
            aria-current={active}
            className={`group relative flex w-[66px] shrink-0 flex-col items-center gap-0.5 rounded-xl px-0.5 py-1 transition-colors ${active ? 'bg-raised shadow-sm ring-1 ring-border' : 'hover:bg-hover'}`}
          >
            {active && <span className="absolute -start-[5px] top-2 h-6 w-[3px] rounded-e bg-accent" aria-hidden />}
            <span className="relative" aria-hidden>
              <EngineBadge engine={s.config.engine} size={28} />
              <span className={`absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-panel ${s.healthy ? ENV_DOT[s.config.environment] : 'bg-muted/50'}`} />
              {count > 0 && <span className="absolute -end-2 -top-1.5 min-w-[16px] rounded-full bg-fg px-1 text-[0.62rem] leading-4 text-bg">{count}</span>}
            </span>
            <span className="line-clamp-2 w-full break-all text-center text-[0.62rem] leading-tight text-muted" aria-hidden>{s.config.name}</span>
          </button>
        );
      })}
      <button className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-dashed border-border text-muted hover:border-accent hover:text-accent" title={t('shell.openAnotherConnection')} aria-label={t('shell.openAnotherConnection')} onClick={() => useApp.setState({ launcher: true })}>
        <Icon name="plus" />
      </button>
      {activeS && <SchemaRail s={activeS} />}
      {menu && (
        <MenuPopup x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={sessions[menu.id]?.config.name}>
          <button role="menuitem" className="menu-item" onClick={() => { switchSession(menu.id); useApp.getState().openTab({ kind: 'query', title: t('shell.queryTab'), sessionId: menu.id, sql: '' }); setMenu(null); }}>{t('query.newTab')}</button>
          <button role="menuitem" className="menu-item text-danger" onClick={() => { void closeSession(menu.id); setMenu(null); }}>{t('common.disconnect')}</button>
        </MenuPopup>
      )}
    </nav>
  );
}

/** Databases/schemas the user opened or switched to, per session, in first-opened order. */
export const useOpenedSchemas = create<{ bySession: Record<string, string[]>; add(id: string, schema: string): void; remove(id: string, schema: string): void }>((set, get) => ({
  bySession: {},
  add(id, schema) {
    const cur = get().bySession[id] ?? [];
    if (!cur.includes(schema)) set({ bySession: { ...get().bySession, [id]: [...cur, schema] } });
  },
  remove(id, schema) {
    set({ bySession: { ...get().bySession, [id]: (get().bySession[id] ?? []).filter((x) => x !== schema) } });
  },
}));

/**
 * The active connection's opened databases/schemas: cylinder icon with the name
 * underneath (wrapping to two lines). The current one is tinted with the
 * connection/environment colour; click switches the active schema and the tree.
 * New ones are added by switching schema (sidebar picker); right-click (or Shift+F10) removes one.
 * Keyboard: a listbox with one Tab stop; Up/Down move, Enter/Space switch.
 */
function SchemaRail({ s }: { s: OpenSession }) {
  const { t } = useTranslation();
  const setActiveSchema = useApp((st) => st.setActiveSchema);
  const opened = useOpenedSchemas((st) => st.bySession[s.session_id]);
  const [menu, setMenu] = useState<{ schema: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (s.activeSchema) useOpenedSchemas.getState().add(s.session_id, s.activeSchema);
  }, [s.session_id, s.activeSchema]);
  const list = (opened ?? []).filter((x) => s.schemas.includes(x) || x === s.activeSchema);
  if (!list.length) return null;
  const tint = s.config.color && /^#[0-9a-f]{6}$/i.test(s.config.color) ? s.config.color : ENV_COLOR[s.config.environment] ?? 'rgb(var(--accent))';
  const current = list.includes(s.activeSchema ?? '') ? s.activeSchema : list[0];
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const opts = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
    const i = opts.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      opts[Math.max(0, Math.min(opts.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (isContextMenuKey(e) && i >= 0 && list[i] !== s.activeSchema) {
      e.preventDefault();
      setMenu({ schema: list[i], ...menuAnchor(opts[i]) });
    }
  };
  return (
    <div role="listbox" aria-label={t('tableWs.schemasRail')} className="mt-1 flex w-full flex-col items-center gap-1 border-t border-border pt-2" onKeyDown={onKeyDown}>
      {list.map((x) => {
        const active = x === s.activeSchema;
        // Key-value databases also show their key count (from INFO keyspace).
        const keys = s.keyspaces?.find((k) => k.name === x)?.keys;
        const keysText = keys == null ? '' : t('redis.keyCount', { count: keys, formatted: fmtNumber(keys) });
        return (
          <button
            key={x}
            role="option"
            aria-selected={active}
            tabIndex={x === current ? 0 : -1}
            title={keysText ? `${x} · ${keysText}` : x}
            aria-label={keysText ? `${x}, ${keysText}` : undefined}
            onClick={() => setActiveSchema(s.session_id, x)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!active) setMenu({ schema: x, x: e.clientX, y: e.clientY });
            }}
            className={`relative flex w-[66px] shrink-0 flex-col items-center gap-0.5 rounded-lg px-0.5 py-1 ${active ? 'bg-raised text-fg shadow-sm ring-1 ring-border' : 'text-muted hover:bg-hover hover:text-fg'}`}
          >
            <Icon name="db" size={22} style={active ? { color: tint } : undefined} />
            <span className="line-clamp-2 w-full break-all text-center text-[0.65rem] leading-tight" dir="auto">{x}</span>
            {keys != null && <span className="w-full truncate text-center text-[0.58rem] leading-tight tabular-nums text-muted" aria-hidden>{fmtNumber(keys, { notation: 'compact' })}</span>}
          </button>
        );
      })}
      {menu && (
        <MenuPopup x={menu.x} y={menu.y} className="w-44" label={menu.schema} onClose={() => setMenu(null)}>
          <button role="menuitem" className="menu-item" onClick={() => { useOpenedSchemas.getState().remove(s.session_id, menu.schema); setMenu(null); }}>{t('common.close')}</button>
        </MenuPopup>
      )}
    </div>
  );
}
