import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import type { ObjectKind, ObjectRef, StoredConnection } from '../lib/types';
import { errMsg, useApp } from '../store';
import { ENGINE_LABELS } from './ConnectionDialog';
import { EnvBadge } from './ui';
import { ask } from './ask';
import { generateSql, qualify } from '../lib/sqlgen';

const KIND_ICON: Partial<Record<ObjectKind, string>> = {
  table: '▦', view: '◫', materialized_view: '◨', function: 'ƒ', procedure: 'ℙ', trigger: '⚡', sequence: '#', enum: '≡',
  extension: '⧉', index: '⌗', event: '⏱', key: '🔑', collection: '▤',
};

const KIND_ORDER: ObjectKind[] = ['table', 'view', 'materialized_view', 'function', 'procedure', 'trigger', 'sequence', 'enum', 'index', 'event', 'extension', 'key', 'collection'];

function ConnectionList() {
  const { t } = useTranslation();
  const { connections, openSession, toast, reloadConnections } = useApp();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const s = q.toLowerCase();
    return connections.filter((c) => !s || [c.config.name, c.config.host, c.config.database, c.config.group, ...c.config.tags].some((x) => x?.toLowerCase().includes(s)));
  }, [connections, q]);
  const groups = useMemo(() => {
    const m = new Map<string, StoredConnection[]>();
    const favs = filtered.filter((c) => c.config.favorite);
    if (favs.length) m.set(t('conn.favorites'), favs);
    for (const c of filtered) {
      const g = c.config.group || t('conn.all');
      m.set(g, [...(m.get(g) ?? []), c]);
    }
    return [...m.entries()];
  }, [filtered, t]);

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
            return;
          } catch (e2) {
            toast('error', errMsg(e2));
          }
        }
      } else toast('error', msg);
    } finally {
      setBusy(null);
    }
  };

  const onDrop = async (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = connections.map((c) => c.config.id).filter((i) => i !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    await api.reorderConnections(ids);
    await reloadConnections();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 p-2">
        <input className="input" placeholder={t('conn.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('common.search')} />
        <button className="btn btn-primary" title={t('conn.new')} aria-label={t('conn.new')} onClick={() => useApp.setState({ connectionDialog: {} })}>+</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1" role="tree" aria-label={t('conn.title')}>
        {connections.length === 0 && <p className="p-3 text-muted">{t('conn.empty')}</p>}
        {groups.map(([g, list]) => (
          <div key={g} role="group" aria-label={g}>
            <div className="px-2 pt-2 text-[0.7rem] font-semibold uppercase tracking-wide text-muted">{g}</div>
            {list.map((c) => (
              <ConnectionRow key={g + c.config.id} c={c} busy={busy === c.config.id} onConnect={() => connect(c.config.id)} draggable onDragStart={() => setDragId(c.config.id)} onDrop={() => onDrop(c.config.id)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectionRow({ c, busy, onConnect, ...drag }: { c: StoredConnection; busy: boolean; onConnect: () => void; draggable: boolean; onDragStart: () => void; onDrop: () => void }) {
  const { t } = useTranslation();
  const { reloadConnections, toast } = useApp();
  const [menu, setMenu] = useState(false);
  const cfg = c.config;
  const del = async () => {
    if (!(await ask.confirm(t('common.delete'), t('conn.deleteConfirm', { name: cfg.name }), true))) return;
    try {
      await api.deleteConnection(cfg.id);
      await reloadConnections();
    } catch (e) {
      toast('error', errMsg(e));
    }
  };
  const toggleFav = async () => {
    await api.saveConnection({ ...cfg, favorite: !cfg.favorite }, null);
    await reloadConnections();
  };
  const copyUrl = async () => {
    const scheme = cfg.engine === 'postgres' ? 'postgresql' : cfg.engine === 'sqlite' ? 'sqlite' : cfg.engine.replace('_', '');
    const url = cfg.engine === 'sqlite' ? `sqlite://${cfg.database ?? ''}` : `${scheme}://${cfg.username ? cfg.username + '@' : ''}${cfg.host ?? ''}${cfg.port ? ':' + cfg.port : ''}/${cfg.database ?? ''}`;
    await navigator.clipboard.writeText(url);
    toast('info', 'Copied (password omitted)');
  };
  return (
    <div
      role="treeitem"
      aria-selected={false}
      tabIndex={0}
      onDoubleClick={onConnect}
      onKeyDown={(e) => e.key === 'Enter' && onConnect()}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
      draggable={drag.draggable}
      onDragStart={drag.onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={drag.onDrop}
      className="group relative flex cursor-default items-center gap-2 rounded px-2 py-1 hover:bg-raised"
      style={{ borderLeft: `3px solid ${cfg.color ?? 'transparent'}` }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 truncate">
          {cfg.favorite && <span aria-label={t('conn.favorite')}>★</span>}
          <span className="truncate font-medium">{cfg.name}</span>
        </div>
        <div className="truncate text-xs text-muted">{ENGINE_LABELS[cfg.engine]} · {cfg.host ?? cfg.database}</div>
      </div>
      <EnvBadge env={cfg.environment} />
      <button className="btn btn-ghost px-1 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={t('common.connect')} onClick={onConnect} disabled={busy}>{busy ? '…' : '▶'}</button>
      <button className="btn btn-ghost px-1 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label="More" aria-haspopup="menu" onClick={() => setMenu((m) => !m)}>⋯</button>
      {menu && (
        <div role="menu" className="absolute right-0 top-full z-20 w-48 rounded border border-border bg-raised py-1 shadow-lg" onMouseLeave={() => setMenu(false)}>
          {[
            [t('common.connect'), onConnect],
            [t('common.edit'), () => useApp.setState({ connectionDialog: { id: cfg.id } })],
            [t('common.duplicate'), () => useApp.setState({ connectionDialog: { duplicateOf: cfg.id } })],
            [cfg.favorite ? '☆ Unfavorite' : '★ ' + t('conn.favorite'), toggleFav],
            [t('conn.copyUrl'), copyUrl],
            [t('common.delete'), del],
          ].map(([label, fn]) => (
            <button key={label as string} role="menuitem" className="block w-full px-3 py-1 text-left hover:bg-panel" onClick={() => { setMenu(false); (fn as () => void)(); }}>
              {label as string}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ObjectTree({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { sessions, setActiveSchema, loadObjects, openTab, toast } = useApp();
  const s = sessions[sessionId];
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [ctx, setCtx] = useState<{ o: ObjectRef; x: number; y: number } | null>(null);
  const objs = useMemo(() => s.objects[s.activeSchema ?? ''] ?? [], [s.objects, s.activeSchema]);
  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return ql ? objs.filter((o) => o.name.toLowerCase().includes(ql)) : objs;
  }, [objs, q]);
  const byKind = useMemo(() => {
    const m = new Map<ObjectKind, ObjectRef[]>();
    for (const o of filtered) m.set(o.kind, [...(m.get(o.kind) ?? []), o]);
    return KIND_ORDER.filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as const);
  }, [filtered]);

  const open = (o: ObjectRef) => {
    if (['table', 'view', 'materialized_view', 'key', 'collection'].includes(o.kind)) {
      openTab({ kind: 'table', title: o.name, sessionId, target: { schema: o.schema, table: o.name } });
    } else {
      void api.objectDdl(sessionId, o).then(
        (ddl) => openTab({ kind: 'query', title: o.name, sessionId, sql: ddl }),
        (e) => toast('error', errMsg(e)),
      );
    }
  };

  const action = async (what: string, o: ObjectRef) => {
    setCtx(null);
    const d = s.config.engine;
    try {
      switch (what) {
        case 'data':
          return open(o);
        case 'structure':
          return openTab({ kind: 'structure', title: `${o.name} (structure)`, sessionId, target: { schema: o.schema, table: o.name } });
        case 'name':
          return navigator.clipboard.writeText(o.name);
        case 'qualified':
          return navigator.clipboard.writeText(qualify(d, o.schema, o.name));
        case 'ddl':
          return openTab({ kind: 'query', title: `${o.name}.sql`, sessionId, sql: await api.objectDdl(sessionId, o) });
        case 'select':
        case 'insert':
        case 'update':
        case 'delete': {
          const desc = await api.describeTable(sessionId, { schema: o.schema, table: o.name });
          return openTab({ kind: 'query', title: `${what} ${o.name}`, sessionId, sql: generateSql(what, d, desc) });
        }
        case 'drop':
        case 'truncate': {
          const kw = o.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : o.kind.toUpperCase();
          const sql = what === 'drop' ? `DROP ${kw} ${qualify(d, o.schema, o.name)};` : `TRUNCATE TABLE ${qualify(d, o.schema, o.name)};`;
          // Opened in an editor, not executed: the user runs it through the safety policy.
          return openTab({ kind: 'query', title: `${what} ${o.name}`, sessionId, sql });
        }
      }
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {s.schemas.length > 0 && (
        <div className="flex gap-1 px-2 pt-2">
          <select className="input" aria-label={t('tree.schemas')} value={s.activeSchema ?? ''} onChange={(e) => setActiveSchema(sessionId, e.target.value)}>
            {s.schemas.map((x) => <option key={x}>{x}</option>)}
          </select>
          <button className="btn" aria-label={t('common.refresh')} title={t('common.refresh')} onClick={() => loadObjects(sessionId, s.activeSchema)}>⟳</button>
        </div>
      )}
      <div className="p-2">
        <input className="input" placeholder={t('tree.filter')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('tree.filter')} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2" role="tree" aria-label="Objects">
        {byKind.length === 0 && <p className="p-3 text-muted">{t('tree.empty')}</p>}
        {byKind.map(([kind, list]) => (
          <div key={kind} role="group">
            <button className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-xs font-semibold uppercase text-muted" aria-expanded={!collapsed[kind]} onClick={() => setCollapsed((c) => ({ ...c, [kind]: !c[kind] }))}>
              <span>{collapsed[kind] ? '▸' : '▾'}</span>{kind.replace('_', ' ')}s <span className="ml-auto font-normal">{list.length}</span>
            </button>
            {!collapsed[kind] &&
              list.slice(0, 5000).map((o) => (
                <div
                  key={kind + o.name}
                  role="treeitem"
                  aria-selected={false}
                  tabIndex={0}
                  className="flex cursor-default items-center gap-1.5 truncate rounded px-3 py-0.5 hover:bg-raised"
                  onDoubleClick={() => open(o)}
                  onKeyDown={(e) => e.key === 'Enter' && open(o)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtx({ o, x: e.clientX, y: e.clientY });
                  }}
                  title={o.name}
                >
                  <span aria-hidden className="w-4 text-center text-muted">{KIND_ICON[o.kind] ?? '•'}</span>
                  <span className="truncate">{o.name}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
      {ctx && (
        <div role="menu" className="fixed z-50 w-52 rounded border border-border bg-raised py-1 shadow-lg" style={{ left: ctx.x, top: ctx.y }} onMouseLeave={() => setCtx(null)}>
          {(['table', 'view', 'materialized_view'].includes(ctx.o.kind)
            ? [['data', t('tree.openData')], ['structure', t('tree.openStructure')], ['select', t('tree.genSelect')], ['insert', t('tree.genInsert')], ['update', t('tree.genUpdate')], ['delete', t('tree.genDelete')], ['ddl', t('tree.showDdl')], ['name', t('tree.copyName')], ['qualified', t('tree.copyQualified')], ...(ctx.o.kind === 'table' ? [['truncate', t('tree.truncate')]] : []), ['drop', t('tree.drop')]]
            : [['data', t('tree.showDdl')], ['name', t('tree.copyName')], ['qualified', t('tree.copyQualified')]]
          ).map(([k, label]) => (
            <button key={k} role="menuitem" className={`block w-full px-3 py-1 text-left hover:bg-panel ${k === 'drop' || k === 'truncate' ? 'text-danger' : ''}`} onClick={() => action(k, ctx.o)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const { sessions, activeSession, closeSession, openTab } = useApp();
  const s = activeSession ? sessions[activeSession] : undefined;
  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border bg-panel" aria-label="Sidebar">
      {Object.keys(sessions).length > 0 && (
        <div className="flex items-center gap-1 border-b border-border p-2">
          <select className="input" aria-label="Active connection" value={activeSession ?? ''} onChange={(e) => useApp.setState({ activeSession: e.target.value || undefined })}>
            <option value="">{t('conn.title')}</option>
            {Object.values(sessions).map((x) => (
              <option key={x.session_id} value={x.session_id}>{x.config.name}</option>
            ))}
          </select>
          {s && (
            <>
              <button className="btn" title={t('query.newTab')} aria-label={t('query.newTab')} onClick={() => openTab({ kind: 'query', title: 'Query', sessionId: s.session_id, sql: '' })}>SQL</button>
              <button className="btn" title={t('common.disconnect')} aria-label={t('common.disconnect')} onClick={() => closeSession(s.session_id)}>⏏</button>
            </>
          )}
        </div>
      )}
      {s ? <ObjectTree sessionId={s.session_id} /> : <ConnectionList />}
    </aside>
  );
}
