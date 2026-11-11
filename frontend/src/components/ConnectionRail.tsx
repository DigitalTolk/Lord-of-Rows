import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { displayCombo } from '../lib/keys';
import { useApp } from '../store';
import { EngineBadge } from './EngineBadge';
import { Icon } from './icons';
import { isContextMenuKey, menuAnchor, MenuPopup } from './ui';

const ENV_DOT: Record<string, string> = { production: 'bg-danger', staging: 'bg-warn', testing: 'bg-purple', development: 'bg-accent', local: 'bg-ok', custom: 'bg-muted' };

/** Vertical strip of open connections (one per database session). Click to switch; each keeps its own tabs. */
export function ConnectionRail() {
  const { t } = useTranslation();
  const { sessions, activeSession, switchSession, closeSession, tabs } = useApp();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const list = Object.values(sessions);

  // Up/Down move between rail buttons (each is also a normal Tab stop); Shift+F10 opens the menu.
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
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
    <nav aria-label={t('rail.label')} className="flex w-[52px] shrink-0 flex-col items-center gap-1.5 border-e border-border bg-panel py-2" onKeyDown={onKeyDown}>
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
            aria-label={`${t('rail.item', { name: s.config.name, env: t(`env.${s.config.environment}`) })}, ${t('rail.tabs', { count })}${s.healthy ? '' : `, ${t('status.lost')}`}`}
            aria-current={active ? 'true' : undefined}
            className={`group relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${active ? 'bg-raised shadow-sm ring-1 ring-border' : 'hover:bg-hover'}`}
          >
            {active && <span className="absolute -start-[7px] h-6 w-[3px] rounded-e bg-accent" aria-hidden />}
            <EngineBadge engine={s.config.engine} size={30} />
            <span aria-hidden className={`absolute bottom-0.5 end-0.5 h-2.5 w-2.5 rounded-full border-2 border-panel ${s.healthy ? ENV_DOT[s.config.environment] : 'bg-muted/50'}`} />
            {count > 0 && <span aria-hidden className="absolute -end-1 -top-1 min-w-[16px] rounded-full bg-fg px-1 text-[0.62rem] leading-4 text-bg">{count}</span>}
          </button>
        );
      })}
      <button className="flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-border text-muted hover:border-accent hover:text-accent" title={t('shell.openAnother')} aria-label={t('shell.openAnother')} onClick={() => useApp.setState({ launcher: true })}>
        <Icon name="plus" />
      </button>
      {menu && (
        <MenuPopup x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={sessions[menu.id]?.config.name}>
          <button role="menuitem" className="menu-item" onClick={() => { switchSession(menu.id); useApp.getState().openTab({ kind: 'query', title: t('shell.queryTab'), sessionId: menu.id, sql: '' }); setMenu(null); }}>{t('query.newTab')}</button>
          <button role="menuitem" className="menu-item text-danger" onClick={() => { void closeSession(menu.id); setMenu(null); }}>{t('common.disconnect')}</button>
        </MenuPopup>
      )}
    </nav>
  );
}
