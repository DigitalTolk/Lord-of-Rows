import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import type { ObjectKind, ObjectRef } from '../lib/types';
import { generateSql, qualify } from '../lib/sqlgen';
import { errMsg, useApp } from '../store';
import { Icon, type IconName } from './icons';

const KIND_ICON: Partial<Record<ObjectKind, IconName>> = {
  table: 'table', view: 'view', materialized_view: 'view', function: 'func', procedure: 'func', trigger: 'bolt', sequence: 'list', enum: 'list',
  extension: 'copy', index: 'key', event: 'history', key: 'key', collection: 'table',
};
const KIND_COLOR: Partial<Record<ObjectKind, string>> = { table: 'text-accent', view: 'text-purple', materialized_view: 'text-purple', function: 'text-warn', procedure: 'text-warn', trigger: 'text-danger', key: 'text-ok' };
const KIND_ORDER: ObjectKind[] = ['table', 'view', 'materialized_view', 'function', 'procedure', 'trigger', 'sequence', 'enum', 'index', 'event', 'extension', 'key', 'collection'];
const KIND_LABEL: Partial<Record<ObjectKind, string>> = { table: 'Tables', view: 'Views', materialized_view: 'Materialized views', function: 'Functions', procedure: 'Procedures', trigger: 'Triggers', sequence: 'Sequences', enum: 'Enums', index: 'Indexes', event: 'Events', extension: 'Extensions', key: 'Keys', collection: 'Collections' };

export function Sidebar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { sessions, setActiveSchema, loadObjects, openTab, toast, tabs, activeTab } = useApp();
  const s = sessions[sessionId];
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [ctx, setCtx] = useState<{ o: ObjectRef; x: number; y: number } | null>(null);
  const objs = useMemo(() => s.objects[s.activeSchema ?? ''] ?? [], [s.objects, s.activeSchema]);
  const activeTarget = tabs.find((x) => x.id === activeTab)?.target;
  const byKind = useMemo(() => {
    const ql = q.toLowerCase();
    const m = new Map<ObjectKind, ObjectRef[]>();
    for (const o of objs) if (!ql || o.name.toLowerCase().includes(ql)) m.set(o.kind, [...(m.get(o.kind) ?? []), o]);
    return KIND_ORDER.filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as const);
  }, [objs, q]);

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

  return (
    <aside className="flex h-full min-h-0 flex-col bg-panel" aria-label="Database objects">
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
          <Icon name="search" size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input h-7 pl-7" placeholder={t('tree.filter')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('tree.filter')} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2" role="tree" aria-label="Objects">
        {byKind.length === 0 && <p className="px-3 py-6 text-center text-muted">{t('tree.empty')}</p>}
        {byKind.map(([kind, list]) => (
          <div key={kind} role="group">
            <button className="section-title flex w-full items-center gap-1 hover:text-fg" aria-expanded={!collapsed[kind]} onClick={() => setCollapsed((c) => ({ ...c, [kind]: !c[kind] }))}>
              <Icon name={collapsed[kind] ? 'chevronRight' : 'chevronDown'} size={11} />
              {KIND_LABEL[kind] ?? kind}
              <span className="ml-auto font-normal normal-case tracking-normal">{list.length}</span>
            </button>
            {!collapsed[kind] && list.slice(0, 5000).map((o) => {
              const active = activeTarget?.table === o.name && activeTarget?.schema === o.schema;
              return (
                <div
                  key={kind + o.name}
                  role="treeitem"
                  aria-selected={active}
                  tabIndex={0}
                  className={`mx-1.5 flex h-[24px] cursor-default items-center gap-2 rounded-md px-2 ${active ? 'row-selected' : 'hover:bg-hover'}`}
                  onClick={() => open(o)}
                  onKeyDown={(e) => e.key === 'Enter' && open(o)}
                  onContextMenu={(e) => { e.preventDefault(); setCtx({ o, x: e.clientX, y: e.clientY }); }}
                  title={o.name}
                >
                  <Icon name={KIND_ICON[o.kind] ?? 'list'} size={14} className={active ? '' : KIND_COLOR[o.kind] ?? 'text-muted'} />
                  <span className="truncate">{o.name}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {ctx && (
        <div role="menu" className="fixed z-50 w-52 rounded-lg border border-border bg-raised p-1 shadow-xl" style={{ left: ctx.x, top: ctx.y }} onMouseLeave={() => setCtx(null)}>
          {(['table', 'view', 'materialized_view'].includes(ctx.o.kind)
            ? [['data', t('tree.openData')], ['structure', t('tree.openStructure')], ['-'], ['select', t('tree.genSelect')], ['insert', t('tree.genInsert')], ['update', t('tree.genUpdate')], ['delete', t('tree.genDelete')], ['ddl', t('tree.showDdl')], ['-'], ['name', t('tree.copyName')], ['qualified', t('tree.copyQualified')], ['-'], ...(ctx.o.kind === 'table' ? [['truncate', t('tree.truncate')]] : []), ['drop', t('tree.drop')]]
            : [['data', t('tree.showDdl')], ['name', t('tree.copyName')], ['qualified', t('tree.copyQualified')]]
          ).map(([k, label], i) =>
            k === '-' ? <div key={i} className="my-1 border-t border-border" /> : (
              <button key={k} role="menuitem" className={`menu-item ${k === 'drop' || k === 'truncate' ? 'text-danger' : ''}`} onClick={() => action(k, ctx.o)}>{label}</button>
            ),
          )}
        </div>
      )}
    </aside>
  );
}
