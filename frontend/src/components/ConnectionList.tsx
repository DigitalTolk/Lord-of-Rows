import { fmtNumber } from '../lib/format';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import { buildSections, connectionSubtitle, connectionSubtitleTitle, ENV_FILTERS, isFiltering, navItems, navKey, type NavItem } from '../lib/connectionList';
import type { ConnectionGroup, EnvironmentKind, StoredConnection } from '../lib/types';
import { errMsg, useApp } from '../store';
import { ask } from './ask';
import { ConnectionGroupHeader } from './ConnectionGroupHeader';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { EngineBadge } from './EngineBadge';
import { Icon } from './icons';
import { EnvBadge, Spinner } from './ui';
import { ManagedChip } from './ManagedChip';
import { managedState } from '../lib/access';

/** Actions the launcher (Welcome) performs on a connection. */
export type ConnAction = 'connect' | 'edit' | 'duplicate' | 'favorite' | 'delete' | 'requestAgain';

const DND_TYPE = 'application/x-dbs-connection';
/** Our own group palette (works on light and dark backgrounds). */
const GROUP_COLORS: [string, string][] = [
  ['blue', '#3b82f6'], ['green', '#22a55e'], ['purple', '#8b5cf6'], ['orange', '#f97316'],
  ['red', '#ef4444'], ['yellow', '#d4a017'], ['teal', '#14b8a6'], ['grey', '#8a8a96'],
];

type MenuTarget = { kind: 'conn'; c: StoredConnection } | { kind: 'group'; g: ConnectionGroup };
type Menu = { x: number; y: number } & MenuTarget;

/**
 * The launcher's connection list: search, environment filter chips, collapsible
 * groups (rename / colour / delete / reorder), drag-and-drop or "Move to group",
 * and listbox keyboard navigation.
 */
export function ConnectionList({
  sel,
  onSelect,
  busy,
  onConnect,
  onAction,
}: {
  sel: string | null;
  onSelect: (id: string) => void;
  busy: string | null;
  onConnect: (id: string) => void;
  onAction: (k: ConnAction, c: StoredConnection) => void;
}) {
  const { t } = useTranslation();
  const { connections, reloadConnections, toast } = useApp();
  const [q, setQ] = useState('');
  const [envs, setEnvs] = useState<Set<EnvironmentKind>>(() => new Set());
  const [groups, setGroups] = useState<ConnectionGroup[]>([]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadGroups = useCallback(async () => {
    try {
      setGroups(await api.listConnectionGroups());
    } catch (e) {
      toast('error', errMsg(e));
    }
  }, [toast]);

  // Saving a connection with a new group name creates the group in the backend, so refresh on every change.
  useEffect(() => {
    void loadGroups();
  }, [connections, loadGroups]);

  const opts = useMemo(() => ({ q, envs, envLabel: (e: EnvironmentKind) => t(`env.${e}`) }), [q, envs, t]);
  const filtering = isFiltering(opts);
  const sections = useMemo(() => buildSections(connections, groups, opts), [connections, groups, opts]);
  const expanded = useCallback((g: ConnectionGroup) => filtering || !g.collapsed, [filtering]);
  const nav = useMemo(() => navItems(sections, expanded), [sections, expanded]);
  const byId = useMemo(() => new Map(connections.map((c) => [c.config.id, c])), [connections]);
  const groupByName = (name: string) => sections.find((s) => s.group?.name === name)?.group ?? groups.find((g) => g.name === name);

  const activeKey = (focusKey && nav.some((n) => navKey(n) === focusKey) ? focusKey : null) ?? (sel && nav.some((n) => n.kind === 'conn' && n.id === sel) ? `c:${sel}` : null) ?? (nav[0] ? navKey(nav[0]) : null);

  const focusNav = (n: NavItem | undefined) => {
    if (!n) return;
    const k = navKey(n);
    setFocusKey(k);
    if (n.kind === 'conn') onSelect(n.id);
    const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])].find((x) => x.dataset.nav === k);
    el?.focus();
    el?.scrollIntoView?.({ block: 'nearest' });
  };

  // ---- group operations ----
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast('error', errMsg(e));
    }
    await reloadConnections();
    await loadGroups();
  };

  const toggle = (g: ConnectionGroup) => {
    if (filtering) return; // groups are force-expanded while searching
    const next = { ...g, collapsed: !g.collapsed };
    setGroups((gs) => (gs.some((x) => x.name === g.name) ? gs.map((x) => (x.name === g.name ? next : x)) : [...gs, next]));
    api.saveConnectionGroup(next).catch((e) => toast('error', errMsg(e)));
  };

  const askNewGroup = async (): Promise<string | null> => {
    const name = (await ask.text(t('connList.newGroup'), t('connList.groupName')))?.trim();
    if (!name) return null;
    if (groups.some((g) => g.name === name)) {
      toast('error', t('connList.groupExists', { name }));
      return null;
    }
    return name;
  };

  const newGroup = async () => {
    const name = await askNewGroup();
    if (name) await run(() => api.saveConnectionGroup({ name, color: null, collapsed: false, sort: 0 }));
  };

  const moveTo = (id: string, group: string | null) => {
    const c = byId.get(id);
    if (!c || (c.config.group?.trim() || null) === group) return;
    void run(() => api.setConnectionGroup(id, group));
  };

  const renameGroup = async (g: ConnectionGroup) => {
    const to = (await ask.text(t('connList.renameTitle'), t('connList.renamePrompt', { name: g.name })))?.trim();
    if (to && to !== g.name) await run(() => api.renameConnectionGroup(g.name, to));
  };

  const deleteGroup = async (g: ConnectionGroup) => {
    const count = connections.filter((c) => c.config.group?.trim() === g.name).length;
    if (!(await ask.confirm(t('connList.deleteGroupTitle'), t('connList.deleteGroupConfirm', { name: g.name, count }), true))) return;
    await run(() => api.deleteConnectionGroup(g.name));
  };

  const moveGroup = (g: ConnectionGroup, delta: number) => {
    const names = sections.filter((s) => s.group).map((s) => s.group!.name);
    const i = names.indexOf(g.name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= names.length) return;
    [names[i], names[j]] = [names[j], names[i]];
    void run(() => api.reorderConnectionGroups(names));
  };

  // ---- menus ----
  const groupNames = sections.filter((s) => s.group).map((s) => s.group!.name);
  const menuItems = (m: Menu): MenuItem[] => {
    if (m.kind === 'group') {
      const g = m.g;
      const i = groupNames.indexOf(g.name);
      return [
        { key: 'rename', label: t('connList.rename'), onSelect: () => void renameGroup(g) },
        {
          key: 'color',
          label: t('connList.color'),
          submenu: [
            { key: 'none', label: t('connList.colorDefault'), swatch: null, checked: !g.color, onSelect: () => void run(() => api.saveConnectionGroup({ ...g, color: null })) },
            ...GROUP_COLORS.map(([k, hex]): MenuItem => ({
              key: k,
              label: t(`connList.colors.${k}`),
              swatch: hex,
              checked: g.color?.toLowerCase() === hex,
              onSelect: () => void run(() => api.saveConnectionGroup({ ...g, color: hex })),
            })),
          ],
        },
        { key: 'up', label: t('connList.moveUp'), disabled: i <= 0, onSelect: () => moveGroup(g, -1) },
        { key: 'down', label: t('connList.moveDown'), disabled: i < 0 || i >= groupNames.length - 1, onSelect: () => moveGroup(g, 1) },
        { key: 'delete', label: t('connList.deleteGroup'), danger: true, separatorBefore: true, onSelect: () => void deleteGroup(g) },
      ];
    }
    const c = m.c;
    const cur = c.config.group?.trim() || null;
    const allGroups = [...new Set([...groups.map((g) => g.name), ...groupNames])];
    const expired = managedState(c.config, Math.floor(Date.now() / 1000))?.expired;
    return [
      expired
        ? { key: 'requestAgain', label: t('access.requestAgain'), onSelect: () => onAction('requestAgain', c) }
        : { key: 'connect', label: t('common.connect'), onSelect: () => onAction('connect', c) },
      { key: 'edit', label: t('common.edit'), onSelect: () => onAction('edit', c) },
      { key: 'duplicate', label: t('common.duplicate'), onSelect: () => onAction('duplicate', c) },
      { key: 'favorite', label: c.config.favorite ? t('connList.removeFavorite') : t('connList.addFavorite'), onSelect: () => onAction('favorite', c) },
      {
        key: 'move',
        label: t('connList.moveTo'),
        submenu: [
          ...allGroups.map((name): MenuItem => ({ key: `g:${name}`, label: name, checked: cur === name, onSelect: () => moveTo(c.config.id, name) })),
          { key: 'none', label: t('connList.noGroup'), checked: !cur, separatorBefore: allGroups.length > 0, onSelect: () => moveTo(c.config.id, null) },
          {
            key: 'new',
            label: t('connList.newGroupEllipsis'),
            onSelect: () => {
              void askNewGroup().then((name) => name && moveTo(c.config.id, name));
            },
          },
        ],
      },
      { key: 'delete', label: t('common.delete'), danger: true, separatorBefore: true, onSelect: () => onAction('delete', c) },
    ];
  };

  /** Opens at the pointer, or under `anchor` when invoked from the keyboard. */
  const openMenuAt = (e: MouseEvent | KeyboardEvent, m: MenuTarget, anchor?: HTMLElement) => {
    e.preventDefault();
    let x: number, y: number;
    if ('clientX' in e && (e.clientX || e.clientY)) {
      x = e.clientX;
      y = e.clientY;
    } else {
      const r = (anchor ?? (e.currentTarget as HTMLElement)).getBoundingClientRect();
      x = r.left + 24;
      y = r.bottom;
    }
    setMenu({ ...m, x, y } as Menu);
  };
  const closeMenu = useCallback(() => setMenu(null), []);

  // ---- drag and drop ----
  const dragProps = (target: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DND_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(target ?? '');
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropTarget(null);
    },
    onDrop: (e: DragEvent) => {
      const id = e.dataTransfer.getData(DND_TYPE);
      e.preventDefault();
      setDropTarget(null);
      setDragging(false);
      if (id) moveTo(id, target);
    },
  });

  // ---- keyboard ----
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
    if (!el || menu) return;
    const i = nav.findIndex((n) => navKey(n) === el.dataset.nav);
    const n = nav[i];
    if (!n) return;
    const g = n.kind === 'group' ? groupByName(n.name) : undefined;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    // Left/Right mirror in RTL (collapse = towards the inline start).
    const rtl = document.documentElement.dir === 'rtl';
    const key = rtl && e.key === 'ArrowLeft' ? 'ArrowRight' : rtl && e.key === 'ArrowRight' ? 'ArrowLeft' : e.key;
    switch (key) {
      case 'ArrowDown':
        handled();
        return focusNav(nav[Math.min(i + 1, nav.length - 1)]);
      case 'ArrowUp':
        handled();
        return focusNav(nav[Math.max(i - 1, 0)]);
      case 'Home':
        handled();
        return focusNav(nav[0]);
      case 'End':
        handled();
        return focusNav(nav[nav.length - 1]);
      case 'ArrowLeft':
        handled();
        if (g && expanded(g)) return toggle(g);
        if (n.kind === 'conn' && n.group) return focusNav(nav.find((x) => x.kind === 'group' && x.name === n.group));
        return;
      case 'ArrowRight':
        handled();
        if (g && !expanded(g)) return toggle(g);
        if (g) return focusNav(nav[i + 1]?.kind === 'conn' ? nav[i + 1] : undefined);
        return;
      case 'Enter':
      case ' ':
        handled();
        if (g) return toggle(g);
        if (n.kind === 'conn' && e.key === 'Enter') return onConnect(n.id);
        return;
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) return;
        if (g) return openMenuAt(e, { kind: 'group', g }, el);
        if (n.kind === 'conn' && byId.get(n.id)) return openMenuAt(e, { kind: 'conn', c: byId.get(n.id)! }, el);
    }
  };

  const toggleEnv = (env: EnvironmentKind) =>
    setEnvs((s) => {
      const next = new Set(s);
      if (next.has(env)) next.delete(env);
      else next.add(env);
      return next;
    });

  const row = (c: StoredConnection, group: string | null) => {
    const cfg = c.config;
    const active = sel === cfg.id;
    const key = `c:${cfg.id}`;
    const prod = cfg.environment === 'production';
    const sub = connectionSubtitle(cfg);
    const expired = !!managedState(cfg, Math.floor(Date.now() / 1000))?.expired;
    return (
      <div
        key={cfg.id}
        role="option"
        aria-selected={active}
        tabIndex={activeKey === key ? 0 : -1}
        data-nav={key}
        data-env={cfg.environment}
        data-expired={expired || undefined}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_TYPE, cfg.id);
          e.dataTransfer.effectAllowed = 'move';
          setDragging(true);
        }}
        onDragEnd={() => {
          setDragging(false);
          setDropTarget(null);
        }}
        onFocus={() => setFocusKey(key)}
        onClick={() => {
          setFocusKey(key);
          onSelect(cfg.id);
        }}
        onDoubleClick={() => onConnect(cfg.id)}
        onContextMenu={(e) => {
          setFocusKey(key);
          onSelect(cfg.id);
          openMenuAt(e, { kind: 'conn', c });
        }}
        className={`group mx-2 flex cursor-default items-center gap-3 rounded-lg border-s-[3px] py-1.5 pe-2 ps-1.5 ${group ? 'ms-5' : ''} ${
          prod ? 'border-danger-solid' : 'border-transparent'
        } ${active ? 'row-selected' : prod ? 'bg-danger/5 hover:bg-danger/10' : 'hover:bg-hover'}`}
      >
        <div className="relative shrink-0">
          <EngineBadge engine={cfg.engine} size={34} dim={expired} />
          {cfg.color && <span className="absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg" style={{ background: cfg.color }} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={`truncate font-medium ${expired && !active ? 'text-muted' : ''}`} title={cfg.name}>{cfg.name}</span>
            <span className={`shrink-0 ${active && cfg.environment !== 'production' ? 'rounded-full bg-bg' : ''}`}>
              <EnvBadge env={cfg.environment} />
            </span>
            {cfg.favorite && <Icon name="star" size={12} className={`shrink-0 ${active ? '' : 'text-warn'}`} aria-label={t('connList.favorite')} role="img" aria-hidden={false} />}
            {cfg.read_only && <Icon name="lock" size={12} className="shrink-0" aria-label={t('connList.readOnly')} role="img" aria-hidden={false} />}
            {cfg.managed_by && <ManagedChip cfg={cfg} onSolid={active} />}
          </div>
          <div className={`truncate text-[0.85rem] ${active ? 'text-on-solid' : 'text-muted'}`} title={connectionSubtitleTitle(cfg) || undefined}>
            {sub || ' '}
          </div>
        </div>
        {busy === cfg.id ? (
          <Spinner />
        ) : (
          // Mouse shortcut only: axe rejects any button (even tabIndex -1) inside role=option;
          // keyboard and screen-reader users press Enter on the option.
          <span
            aria-hidden
            className={`icon-btn opacity-0 group-hover:opacity-100 ${active ? 'text-on-solid hover:bg-on-solid/20 hover:text-on-solid' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onConnect(cfg.id);
            }}
          >
            <Icon name="power" size={15} />
          </span>
        )}
      </div>
    );
  };

  const hasGroups = sections.some((s) => s.group);
  const hasUngrouped = sections.some((s) => !s.group);

  return (
    <>
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <Icon name="search" size={14} className="absolute start-2 top-1/2 -translate-y-1/2 text-muted" />
            <input className="input ps-7" placeholder={t('conn.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('common.search')} />
          </div>
          <button className="icon-btn" aria-label={t('connList.newConnection')} title={t('connList.newConnection')} onClick={() => useApp.setState({ connectionDialog: {} })}>
            <Icon name="plus" />
          </button>
          <button className="icon-btn" aria-label={t('connList.newGroup')} title={t('connList.newGroup')} onClick={() => void newGroup()}>
            <Icon name="folderPlus" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('connList.envFilter')}>
          <Chip pressed={envs.size === 0} onClick={() => setEnvs(new Set())}>
            {t('connList.envAll')}
          </Chip>
          {ENV_FILTERS.map((env) => (
            <Chip key={env} env={env} pressed={envs.has(env)} onClick={() => toggleEnv(env)}>
              {t(`connList.envShort.${env}`)}
            </Chip>
          ))}
        </div>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1" role="listbox" aria-label={t('conn.title')} onKeyDown={onKeyDown}>
        {connections.length === 0 && groups.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
            <Icon name="db" size={36} strokeWidth={1.2} />
            <p>{t('conn.empty')}</p>
          </div>
        )}
        {(connections.length > 0 || groups.length > 0) && sections.length === 0 && <p className="px-4 py-6 text-center text-muted">{t('connList.noMatches')}</p>}
        {sections.map((s) => {
          if (!s.group) {
            return (
              <div key="__ungrouped" role="group" aria-label={hasGroups ? t('connList.ungrouped') : t('conn.title')} {...dragProps(null)}
                className={`pb-1 ${dropTarget === '' ? 'rounded-md bg-accent/10 ring-2 ring-inset ring-accent' : ''}`}>
                <div className="section-title" aria-hidden>{hasGroups ? t('connList.ungrouped') : t('conn.title')}</div>
                {s.items.map((c) => row(c, null))}
              </div>
            );
          }
          const g = s.group;
          const open = expanded(g);
          const gk = `g:${g.name}`;
          const hid = `conn-group-${encodeURIComponent(g.name)}`;
          const label = `${g.name}, ${t('connList.groupCount', { count: s.items.length, formatted: fmtNumber(s.items.length) })}`;
          // The group itself is the focusable, expandable node (group allows aria-expanded inside a listbox).
          return (
            <div
              key={gk}
              role="group"
              aria-labelledby={hid}
              aria-label={label}
              aria-expanded={open}
              tabIndex={activeKey === gk ? 0 : -1}
              data-nav={gk}
              onFocus={(e) => {
                if (e.target === e.currentTarget) setFocusKey(gk);
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) toggle(g);
              }}
              onContextMenu={(e) => {
                if (e.target === e.currentTarget) openMenuAt(e, { kind: 'group', g });
              }}
              className="outline-none [&:focus-visible>.group-head]:outline [&:focus-visible>.group-head]:outline-2 [&:focus-visible>.group-head]:-outline-offset-2 [&:focus-visible>.group-head]:outline-accent"
              {...dragProps(g.name)}
            >
              <span id={hid} hidden>
                {label}
              </span>
              <ConnectionGroupHeader
                group={g}
                count={s.items.length}
                expanded={open}
                dropTarget={dropTarget === g.name}
                onToggle={() => {
                  setFocusKey(gk);
                  toggle(g);
                }}
                onContextMenu={(e) => openMenuAt(e, { kind: 'group', g })}
              />
              {open && s.items.map((c) => row(c, g.name))}
            </div>
          );
        })}
        {dragging && hasGroups && !hasUngrouped && (
          <div {...dragProps(null)} className={`mx-2 mt-2 rounded-md border border-dashed border-border px-3 py-3 text-center text-[0.85rem] text-muted ${dropTarget === '' ? 'bg-accent/10 ring-2 ring-accent' : ''}`}>
            {t('connList.dropUngrouped')}
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={menu.kind === 'group' ? t('connList.groupMenu') : t('connList.connMenu')} items={menuItems(menu)} onClose={closeMenu} />}
    </>
  );
}

/** Environment filter chip (also used by the Access view). */
const chipOn: Record<EnvironmentKind | 'all', string> = {
  all: 'bg-accent-solid text-on-solid border-accent-solid',
  local: 'bg-ok/15 text-ok border-ok/60',
  development: 'bg-accent/15 text-accent border-accent/60',
  testing: 'bg-purple/15 text-purple border-purple/60',
  staging: 'bg-warn/15 text-warn border-warn/60',
  production: 'bg-danger-solid text-on-solid border-danger-solid',
  custom: 'bg-panel text-fg border-border',
};

export function Chip({ env, pressed, onClick, children }: { env?: EnvironmentKind; pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex h-6 items-center rounded-full border px-2.5 text-[0.8rem] font-medium transition-colors ${
        pressed ? chipOn[env ?? 'all'] : 'border-border bg-transparent text-muted hover:bg-hover hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}
