import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../store';
import { EngineBadge } from './EngineBadge';
import { Icon } from './icons';

const ENV_DOT: Record<string, string> = { production: '#d72d2d', staging: '#c47800', testing: '#7c4dff', development: '#0a70f5', local: '#1e9650', custom: '#787880' };

/** Vertical strip of open connections (one per database session). Click to switch; each keeps its own tabs. */
export function ConnectionRail() {
  const { t } = useTranslation();
  const { sessions, activeSession, switchSession, closeSession, tabs } = useApp();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const list = Object.values(sessions);
  return (
    <nav aria-label="Open connections" className="flex w-[52px] shrink-0 flex-col items-center gap-1.5 border-r border-border bg-panel py-2">
      {list.map((s, i) => {
        const active = s.session_id === activeSession;
        const count = tabs.filter((x) => x.sessionId === s.session_id).length;
        return (
          <button
            key={s.session_id}
            onClick={() => switchSession(s.session_id)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ id: s.session_id, x: e.clientX, y: e.clientY }); }}
            title={`${s.config.name}\n${s.server.version.split(' on ')[0]}${i < 9 ? `\nCtrl+${i + 1}` : ''}`}
            aria-label={`${s.config.name}${active ? ' (active)' : ''}`}
            aria-current={active}
            className={`group relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${active ? 'bg-raised shadow-sm ring-1 ring-border' : 'hover:bg-hover'}`}
          >
            {active && <span className="absolute -left-[7px] h-6 w-[3px] rounded-r bg-accent" />}
            <EngineBadge engine={s.config.engine} size={30} />
            <span className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 rounded-full border-2 border-panel" style={{ background: s.healthy ? ENV_DOT[s.config.environment] : '#888' }} />
            {count > 0 && <span className="absolute -right-1 -top-1 min-w-[16px] rounded-full bg-muted px-1 text-[0.62rem] leading-4 text-white">{count}</span>}
          </button>
        );
      })}
      <button className="flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-border text-muted hover:border-accent hover:text-accent" title="Open another connection" aria-label="Open another connection" onClick={() => useApp.setState({ launcher: true })}>
        <Icon name="plus" />
      </button>
      {menu && (
        <div role="menu" className="fixed z-50 w-48 rounded-lg border border-border bg-raised p-1 shadow-xl" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
          <button role="menuitem" className="block w-full rounded-md px-2.5 py-1 text-left hover:bg-accent hover:text-white" onClick={() => { switchSession(menu.id); useApp.getState().openTab({ kind: 'query', title: 'Query', sessionId: menu.id, sql: '' }); setMenu(null); }}>{t('query.newTab')}</button>
          <button role="menuitem" className="block w-full rounded-md px-2.5 py-1 text-left text-danger hover:bg-accent hover:text-white" onClick={() => { void closeSession(menu.id); setMenu(null); }}>{t('common.disconnect')}</button>
        </div>
      )}
    </nav>
  );
}
