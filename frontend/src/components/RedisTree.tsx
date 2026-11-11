import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import { fmtNumber } from '../lib/format';
import { escapeGlob, flattenTree, mergeBatch, nodeId, parentPrefix, parentRowId, prefixPattern, separatorOf, TREE_BATCH, type NodeState, type TreeRow } from '../lib/redisKeys';
import { errMsg, useApp } from '../store';
import { Icon } from './icons';
import { isContextMenuKey, menuAnchor, MenuPopup } from './ui';

/**
 * Sidebar tree of a key-value session: databases (`db0 · 48,213 keys`), then
 * namespaces grouped by the connection's separator, then keys. Nothing is listed
 * up front: expanding a node scans one bounded batch (`MATCH prefix*`), and
 * "Load more…" continues the scan. Clicking a database or namespace opens the key
 * grid for it; clicking a key opens the grid on that key.
 * Keyboard: WAI-ARIA tree (Up/Down, Home/End, Right expands, Left collapses or moves
 * to the parent, Enter opens; mirrored in RTL).
 */
export function RedisTree({ sessionId, q }: { sessionId: string; q: string }) {
  const { t } = useTranslation();
  const s = useApp((st) => st.sessions[sessionId]);
  const { openTab, setActiveSchema, loadKeyspaces, toast } = useApp.getState();
  const sep = separatorOf(s.config);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [nodes, setNodes] = useState<Record<string, NodeState | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ row: TreeRow; x: number; y: number } | null>(null);
  const inflight = useRef(new Set<string>());
  const treeRef = useRef<HTMLDivElement>(null);
  const activeTarget = useApp((st) => st.tabs.find((x) => x.id === st.activeTab && x.sessionId === sessionId)?.target);

  const fetchBatch = useCallback(
    async (db: string, prefix: string, more: boolean) => {
      const id = nodeId(db, prefix);
      if (inflight.current.has(id)) return;
      inflight.current.add(id);
      try {
        const cursor = more ? (nodes[id]?.cursor ?? 0) : 0;
        const b = await api.kvNamespace(sessionId, db, prefix, sep, cursor, TREE_BATCH);
        setNodes((n) => ({ ...n, [id]: mergeBatch(more ? n[id] : undefined, b) }));
        setErrors((x) => {
          const rest = { ...x };
          delete rest[id];
          return rest;
        });
      } catch (e) {
        setErrors((x) => ({ ...x, [id]: errMsg(e) }));
      } finally {
        inflight.current.delete(id);
      }
    },
    [sessionId, sep, nodes],
  );

  // Expanded nodes without data (just expanded, or after a refresh) load their first batch.
  useEffect(() => {
    for (const id of expanded) {
      if (nodes[id] || errors[id]) continue;
      const [db, prefix] = id.split('\u0000');
      void fetchBatch(db, prefix ?? '', false);
    }
  }, [expanded, nodes, errors, fetchBatch]);

  const dbs = useMemo(() => s.keyspaces ?? s.schemas.map((name, index) => ({ name, index, keys: 0, expires: 0, current: name === s.activeSchema })), [s.keyspaces, s.schemas, s.activeSchema]);
  const rows = useMemo(() => flattenTree(dbs, expanded, nodes, q), [dbs, expanded, nodes, q]);
  const current = rows.some((r) => r.id === focusKey) ? focusKey : rows[0]?.id;

  const setOpen = (id: string, open: boolean) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const openGrid = (db: string, pattern: string, title: string) => {
    if (db !== s.activeSchema) setActiveSchema(sessionId, db);
    openTab({ kind: 'table', title, sessionId, target: { schema: db, table: pattern } });
  };

  const activate = (r: TreeRow) => {
    switch (r.kind) {
      case 'db':
        setOpen(nodeId(r.db, ''), true);
        return openGrid(r.db, '*', r.db);
      case 'ns':
        setOpen(nodeId(r.db, r.prefix), true);
        return openGrid(r.db, prefixPattern(r.prefix), `${r.db} · ${r.prefix}*`);
      case 'key':
        return openGrid(r.db, escapeGlob(r.key), r.key);
      case 'more':
        return void fetchBatch(r.db, r.prefix, true);
    }
  };

  const refresh = async () => {
    setNodes({});
    setErrors({});
    try {
      await loadKeyspaces(sessionId);
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const focusNode = (key: string | undefined | null) => {
    if (!key) return;
    setFocusKey(key);
    const enc = encodeURIComponent(key);
    Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? []).find((el) => el.dataset.key === enc)?.focus();
  };

  const expandable = (r: TreeRow) => r.kind === 'db' || r.kind === 'ns';
  const idOf = (r: TreeRow) => (r.kind === 'db' ? nodeId(r.db, '') : r.kind === 'ns' ? nodeId(r.db, r.prefix) : '');

  const onKey = (e: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.id === current);
    const r = rows[i];
    if (!r) return;
    const rtl = document.documentElement.dir === 'rtl';
    const inward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const outward = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === 'ArrowDown') focusNode(rows[i + 1]?.id);
    else if (e.key === 'ArrowUp') focusNode(rows[i - 1]?.id);
    else if (e.key === 'Home') focusNode(rows[0]?.id);
    else if (e.key === 'End') focusNode(rows[rows.length - 1]?.id);
    else if (e.key === inward) {
      if (expandable(r) && !expanded.has(idOf(r))) setOpen(idOf(r), true);
      else if (expandable(r) && rows[i + 1]?.level === r.level + 1) focusNode(rows[i + 1].id);
    } else if (e.key === outward) {
      if (expandable(r) && expanded.has(idOf(r))) setOpen(idOf(r), false);
      else focusNode(parentRowId(r, sep));
    } else if (e.key === 'Enter' || e.key === ' ') activate(r);
    else if (isContextMenuKey(e) && (r.kind === 'key' || r.kind === 'ns' || r.kind === 'db')) setCtx({ row: r, ...menuAnchor(e.target as Element) });
    else return;
    e.preventDefault();
  };

  const chevron = (open: boolean) => (open ? 'chevronDown' : document.documentElement.dir === 'rtl' ? 'chevronLeft' : 'chevronRight');
  const keysText = (n: number) => t('redis.keyCount', { count: n, formatted: fmtNumber(n) });

  const nameOf = (r: TreeRow) => (r.kind === 'db' ? r.db : r.kind === 'ns' ? r.prefix : r.kind === 'key' ? r.key : '');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-2 pb-1">
        <span className="section-title flex-1">{t('redis.databases')}</span>
        <button className="icon-btn" aria-label={t('common.refresh')} title={t('common.refresh')} onClick={() => void refresh()}><Icon name="refresh" size={15} /></button>
      </div>
      <div ref={treeRef} className="min-h-0 flex-1 overflow-auto pb-2" role="tree" aria-label={t('redis.treeLabel')} onKeyDown={onKey}>
        {rows.map((r) => {
          const pad = { paddingInlineStart: `${(r.level - 1) * 12 + 8}px` };
          const common = {
            role: 'treeitem' as const,
            'aria-level': r.level,
            'data-key': encodeURIComponent(r.id),
            tabIndex: current === r.id ? 0 : -1,
            onFocus: () => setFocusKey(r.id),
          };
          const rowCls = 'mx-1.5 flex h-[24px] cursor-default items-center gap-1.5 rounded-md pe-2 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
          if (r.kind === 'loading') {
            return <div key={r.id} {...common} aria-disabled aria-busy className={`${rowCls} text-muted`} style={pad}>{errors[nodeId(r.db, r.prefix)] ?? t('redis.loading')}</div>;
          }
          if (r.kind === 'more') {
            const err = errors[nodeId(r.db, r.prefix)];
            return (
              <div key={r.id} {...common} className={`${rowCls} text-accent hover:bg-hover`} style={pad} onClick={() => { setFocusKey(r.id); activate(r); }}>
                <Icon name="plus" size={12} />
                <span className="truncate">{err ?? t('redis.loadMore')}</span>
              </div>
            );
          }
          const open = expandable(r) && expanded.has(idOf(r));
          const active =
            r.kind === 'db' ? activeTarget?.schema === r.db && activeTarget?.table === '*'
            : r.kind === 'ns' ? activeTarget?.schema === r.db && activeTarget?.table === prefixPattern(r.prefix)
            : activeTarget?.schema === r.db && activeTarget?.table === escapeGlob(r.key);
          const label = r.kind === 'db' ? r.db : r.label;
          const count = r.kind === 'db' ? r.info.keys : r.kind === 'ns' ? r.count : null;
          const aria = r.kind === 'db' ? `${r.db}, ${keysText(r.info.keys)}` : r.kind === 'ns' ? t('redis.namespaceLabel', { name: r.prefix, count: r.count, formatted: fmtNumber(r.count) }) : r.key;
          return (
            <div
              key={r.id}
              {...common}
              aria-expanded={expandable(r) ? open : undefined}
              aria-selected={active}
              aria-label={aria}
              title={r.kind === 'db' ? `${r.db} · ${keysText(r.info.keys)}` : nameOf(r)}
              className={`${rowCls} ${active ? 'row-selected' : 'hover:bg-hover'}`}
              style={pad}
              onClick={() => { setFocusKey(r.id); activate(r); }}
              onContextMenu={(e) => { e.preventDefault(); setFocusKey(r.id); setCtx({ row: r, x: e.clientX, y: e.clientY }); }}
            >
              {expandable(r) ? (
                <span
                  aria-hidden
                  className="-ms-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-hover"
                  onClick={(e) => { e.stopPropagation(); setFocusKey(r.id); setOpen(idOf(r), !open); }}
                >
                  <Icon name={chevron(open)} size={11} />
                </span>
              ) : <span className="w-4 shrink-0" aria-hidden />}
              <Icon name={r.kind === 'db' ? 'db' : r.kind === 'ns' ? 'list' : 'key'} size={14} className={active ? '' : r.kind === 'key' ? 'text-ok' : r.kind === 'db' ? 'text-accent' : 'text-muted'} />
              <span className={`min-w-0 truncate ${r.kind === 'db' && r.info.current ? 'font-semibold' : ''}`} dir="auto">{label}</span>
              {count != null && (
                <span className="ms-auto shrink-0 text-[0.78rem] tabular-nums text-muted">
                  {r.kind === 'db' ? `· ${keysText(count)}` : r.kind === 'ns' && !(nodes[nodeId(r.db, parentPrefix(r.prefix, sep))]?.done ?? true) ? `~${fmtNumber(count)}` : fmtNumber(count)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {ctx && (
        <MenuPopup x={ctx.x} y={ctx.y} className="w-52" label={nameOf(ctx.row)} onClose={() => setCtx(null)}>
          <button role="menuitem" className="menu-item" onClick={() => { activate(ctx.row); setCtx(null); }}>{t('redis.openKeys')}</button>
          <button role="menuitem" className="menu-item" onClick={() => { void navigator.clipboard?.writeText(ctx.row.kind === 'ns' ? `${ctx.row.prefix}*` : nameOf(ctx.row)); setCtx(null); }}>{t('tree.copyName')}</button>
        </MenuPopup>
      )}
    </div>
  );
}
