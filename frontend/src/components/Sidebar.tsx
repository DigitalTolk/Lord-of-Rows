import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import type { ObjectKind, ObjectRef } from '../lib/types';
import { generateSql, qualify } from '../lib/sqlgen';
import { errMsg, useApp } from '../store';
import { Icon, type IconName } from './icons';
import { isContextMenuKey, menuAnchor, MenuPopup } from './ui';

const KIND_ICON: Partial<Record<ObjectKind, IconName>> = {
  table: 'table', view: 'view', materialized_view: 'view', function: 'func', procedure: 'func', trigger: 'bolt', sequence: 'list', enum: 'list',
  extension: 'copy', index: 'key', event: 'history', key: 'key', collection: 'table',
};
const KIND_COLOR: Partial<Record<ObjectKind, string>> = { table: 'text-accent', view: 'text-purple', materialized_view: 'text-purple', function: 'text-warn', procedure: 'text-warn', trigger: 'text-danger', key: 'text-ok' };
const KIND_ORDER: ObjectKind[] = ['table', 'view', 'materialized_view', 'function', 'procedure', 'trigger', 'sequence', 'enum', 'index', 'event', 'extension', 'key', 'collection'];
const MAX_ITEMS = 5000;

/** One visible row of the tree, in display order (used for arrow-key navigation). */
type Node = { key: string; kind: ObjectKind; o?: ObjectRef };

export function Sidebar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { sessions, setActiveSchema, loadObjects, openTab, toast, tabs, activeTab } = useApp();
  const s = sessions[sessionId];
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [ctx, setCtx] = useState<{ o: ObjectRef; x: number; y: number } | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const objs = useMemo(() => s.objects[s.activeSchema ?? ''] ?? [], [s.objects, s.activeSchema]);
  const activeTarget = tabs.find((x) => x.id === activeTab)?.target;
  const byKind = useMemo(() => {
    const ql = q.toLowerCase();
    const m = new Map<ObjectKind, ObjectRef[]>();
    for (const o of objs) if (!ql || o.name.toLowerCase().includes(ql)) m.set(o.kind, [...(m.get(o.kind) ?? []), o]);
    return KIND_ORDER.filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as const);
  }, [objs, q]);
  const kindLabel = (k: ObjectKind) => t(`tree.kind.${k}`, { defaultValue: k });

  const visible = useMemo(() => {
    const out: Node[] = [];
    for (const [kind, list] of byKind) {
      out.push({ key: `k:${kind}`, kind });
      if (!collapsed[kind]) for (const o of list.slice(0, MAX_ITEMS)) out.push({ key: `o:${kind}:${o.name}`, kind, o });
    }
    return out;
  }, [byKind, collapsed]);
  // Roving tabindex: exactly one tree node is in the Tab order.
  const current = visible.some((n) => n.key === focusKey) ? focusKey : visible[0]?.key;

  const open = (o: ObjectRef) => {
    if (['table', 'view', 'materialized_view', 'key', 'collection'].includes(o.kind)) {
      openTab({ kind: 'table', title: o.name, sessionId, target: { schema: o.schema, table: o.name } });
    } else {
      void api.objectDdl(sessionId, o).then((ddl) => openTab({ kind: 'query', title: o.name, sessionId, sql: ddl }), (e) => toast('error', errMsg(e)));
    }
  };

  const action = async (what: string, o: ObjectRef) => {
    setCtx(null);
    const d = s.config.engine;
    try {
      switch (what) {
        case 'data': return open(o);
        case 'structure': return openTab({ kind: 'structure', title: o.name, sessionId, target: { schema: o.schema, table: o.name } });
        case 'name': return navigator.clipboard.writeText(o.name);
        case 'qualified': return navigator.clipboard.writeText(qualify(d, o.schema, o.name));
        case 'ddl': return openTab({ kind: 'query', title: `${o.name}.sql`, sessionId, sql: await api.objectDdl(sessionId, o) });
        case 'select': case 'insert': case 'update': case 'delete': {
          const desc = await api.describeTable(sessionId, { schema: o.schema, table: o.name });
          return openTab({ kind: 'query', title: `${what} ${o.name}`, sessionId, sql: generateSql(what, d, desc) });
        }
        case 'drop': case 'truncate': {
          const kw = o.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : o.kind.toUpperCase();
          const sql = what === 'drop' ? `DROP ${kw} ${qualify(d, o.schema, o.name)};` : `TRUNCATE TABLE ${qualify(d, o.schema, o.name)};`;
          // Opened in an editor for review; running it goes through the safety policy.
          return openTab({ kind: 'query', title: `${what} ${o.name}`, sessionId, sql });
        }
      }
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const focusNode = (key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    treeRef.current?.querySelector<HTMLElement>(`[data-key="${key.replace(/["\\]/g, '\\$&')}"]`)?.focus();
  };
  const toggle = (kind: ObjectKind, value?: boolean) => setCollapsed((c) => ({ ...c, [kind]: value ?? !c[kind] }));

  // WAI-ARIA tree pattern: Up/Down move, Right expands / enters, Left collapses / goes to parent (mirrored in RTL).
  const onTreeKey = (e: React.KeyboardEvent) => {
    const i = visible.findIndex((n) => n.key === current);
    const n = visible[i];
    if (!n) return;
    const rtl = document.documentElement.dir === 'rtl';
    const inward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const outward = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === 'ArrowDown') focusNode(visible[i + 1]?.key);
    else if (e.key === 'ArrowUp') focusNode(visible[i - 1]?.key);
    else if (e.key === 'Home') focusNode(visible[0]?.key);
    else if (e.key === 'End') focusNode(visible[visible.length - 1]?.key);
    else if (e.key === inward) {
      if (!n.o && collapsed[n.kind]) toggle(n.kind, false);
      else if (!n.o) focusNode(visible[i + 1]?.o ? visible[i + 1].key : undefined);
    } else if (e.key === outward) {
      if (n.o) focusNode(`k:${n.kind}`);
      else if (!collapsed[n.kind]) toggle(n.kind, true);
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (n.o) open(n.o);
      else toggle(n.kind);
    } else if (isContextMenuKey(e) && n.o) {
      setCtx({ o: n.o, ...menuAnchor(e.target as Element) });
    } else return;
    e.preventDefault();
  };

  return (
    <aside className="flex h-full min-h-0 flex-col bg-panel" aria-label={t('tree.label')}>
      <div className="space-y-1.5 p-2">
        {s.schemas.length > 0 && (
          <div className="flex gap-1">
            <select className="input h-7 flex-1 font-medium" aria-label={t('tree.schemas')} value={s.activeSchema ?? ''} onChange={(e) => setActiveSchema(sessionId, e.target.value)}>
              {s.schemas.map((x) => <option key={x}>{x}</option>)}
            </select>
            <button className="icon-btn" aria-label={t('common.refresh')} title={t('common.refresh')} onClick={() => loadObjects(sessionId, s.activeSchema)}><Icon name="refresh" size={15} /></button>
          </div>
        )}
        <div className="relative">
          <Icon name="search" size={13} className="absolute start-2 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input h-7 ps-7" type="search" placeholder={t('tree.filter')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('tree.filter')} />
        </div>
      </div>
      {byKind.length === 0 && <p className="px-3 py-6 text-center text-muted">{t('tree.empty')}</p>}
      {byKind.length > 0 && (
        <div ref={treeRef} className="min-h-0 flex-1 overflow-auto pb-2" role="tree" aria-label={t('tree.objects')} onKeyDown={onTreeKey}>
          {byKind.map(([kind, list]) => {
            const gk = `k:${kind}`;
            return (
              <div
                key={kind}
                role="treeitem"
                aria-level={1}
                aria-expanded={!collapsed[kind]}
                aria-label={t('tree.group', { label: kindLabel(kind), count: list.length })}
                data-key={gk}
                tabIndex={current === gk ? 0 : -1}
                onFocus={(e) => e.target === e.currentTarget && setFocusKey(gk)}
                className="outline-none [&:focus-visible>.tree-head]:outline [&:focus-visible>.tree-head]:outline-2 [&:focus-visible>.tree-head]:-outline-offset-2 [&:focus-visible>.tree-head]:outline-accent"
              >
                <div className="tree-head section-title flex w-full cursor-default items-center gap-1 rounded hover:text-fg" onClick={() => { setFocusKey(gk); toggle(kind); }}>
                  <Icon name={collapsed[kind] ? (document.documentElement.dir === 'rtl' ? 'chevronLeft' : 'chevronRight') : 'chevronDown'} size={11} />
                  {kindLabel(kind)}
                  <span className="ms-auto font-normal normal-case tracking-normal">{list.length}</span>
                </div>
                {!collapsed[kind] && (
                  <div role="group">
                    {list.slice(0, MAX_ITEMS).map((o) => {
                      const active = activeTarget?.table === o.name && activeTarget?.schema === o.schema;
                      const key = `o:${kind}:${o.name}`;
                      return (
                        <div
                          key={key}
                          role="treeitem"
                          aria-level={2}
                          aria-selected={active}
                          data-key={key}
                          tabIndex={current === key ? 0 : -1}
                          className={`mx-1.5 flex h-[24px] cursor-default items-center gap-2 rounded-md px-2 ${active ? 'row-selected' : 'hover:bg-hover'}`}
                          onFocus={(e) => { e.stopPropagation(); setFocusKey(key); }}
                          onClick={() => { setFocusKey(key); open(o); }}
                          onContextMenu={(e) => { e.preventDefault(); setFocusKey(key); setCtx({ o, x: e.clientX, y: e.clientY }); }}
                          title={o.name}
                        >
                          <Icon name={KIND_ICON[o.kind] ?? 'list'} size={14} className={active ? '' : KIND_COLOR[o.kind] ?? 'text-muted'} />
                          <span className="truncate" dir="auto">{o.name}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {ctx && (
        <MenuPopup x={ctx.x} y={ctx.y} className="w-52" label={ctx.o.name} onClose={() => setCtx(null)}>
          {(['table', 'view', 'materialized_view'].includes(ctx.o.kind)
            ? [['data', t('tree.openData')], ['structure', t('tree.openStructure')], ['-'], ['select', t('tree.genSelect')], ['insert', t('tree.genInsert')], ['update', t('tree.genUpdate')], ['delete', t('tree.genDelete')], ['ddl', t('tree.showDdl')], ['-'], ['name', t('tree.copyName')], ['qualified', t('tree.copyQualified')], ['-'], ...(ctx.o.kind === 'table' ? [['truncate', t('tree.truncate')]] : []), ['drop', t('tree.drop')]]
            : [['data', t('tree.showDdl')], ['name', t('tree.copyName')], ['qualified', t('tree.copyQualified')]]
          ).map(([k, label], i) =>
            k === '-' ? <div key={i} role="separator" className="my-1 border-t border-border" /> : (
              <button key={k} role="menuitem" className={`menu-item ${k === 'drop' || k === 'truncate' ? 'text-danger' : ''}`} onClick={() => action(k, ctx.o)}>{label}</button>
            ),
          )}
        </MenuPopup>
      )}
    </aside>
  );
}
