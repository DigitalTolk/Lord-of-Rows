import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirmDecision } from '../components/confirm';
import { ErrorBox, Spinner, Toolbar } from '../components/ui';
import { api } from '../lib/ipc';
import type { ColumnDef, Migration, TableDescription } from '../lib/types';
import { errMsg, useApp, type Tab } from '../store';

interface EditCol extends ColumnDef {
  origName?: string;
}

/** Table structure viewer + designer. Changes are previewed as SQL (generated in Rust) and run through the safety policy. */
export function StructureView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const { sessions, toast, loadObjects } = useApp();
  const s = tab.sessionId ? sessions[tab.sessionId] : undefined;
  const isNew = !tab.target?.table;
  const [desc, setDesc] = useState<TableDescription | null>(null);
  const [name, setName] = useState(tab.target?.table ?? 'new_table');
  const [cols, setCols] = useState<EditCol[]>([]);
  const [migration, setMigration] = useState<Migration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'columns' | 'indexes' | 'fks' | 'constraints' | 'ddl'>('columns');

  const load = async () => {
    if (!s) return;
    setError(null);
    setMigration(null);
    if (isNew) {
      setCols([{ name: 'id', data_type: s.config.engine === 'sqlite' ? 'INTEGER' : 'bigint', nullable: false, is_primary_key: true, is_identity: true, ordinal: 1, default: null, comment: null }]);
      return;
    }
    try {
      const d = await api.describeTable(s.session_id, tab.target!);
      setDesc(d);
      setName(d.object.name);
      setCols(d.columns.map((c) => ({ ...c, origName: c.name })));
    } catch (e) {
      setError(errMsg(e));
    }
  };
  useEffect(() => {
    void load();
  }, [s?.session_id, tab.target?.table]); // eslint-disable-line react-hooks/exhaustive-deps

  const edited = (): TableDescription => ({
    object: { kind: 'table', schema: tab.target?.schema ?? s?.activeSchema ?? null, name },
    columns: cols.map((c, i) => ({ name: c.name, data_type: c.data_type, nullable: c.nullable, default: c.default || null, is_primary_key: c.is_primary_key, is_identity: c.is_identity, comment: c.comment || null, ordinal: i + 1 })),
    primary_key: cols.filter((c) => c.is_primary_key).map((c) => c.name),
    indexes: desc?.indexes ?? [],
    foreign_keys: desc?.foreign_keys ?? [],
    constraints: desc?.constraints ?? [],
    ddl: null,
    estimated_rows: null,
    comment: desc?.comment ?? null,
  });

  const preview = async () => {
    if (!s) return;
    setError(null);
    try {
      const renames = cols.filter((c) => c.origName && c.origName !== c.name).map((c) => [c.origName!, c.name] as [string, string]);
      setMigration(await api.designerPreview(s.session_id, isNew ? null : tab.target!, edited(), renames));
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const apply = async () => {
    if (!s || !migration) return;
    const sql = migration.steps.flatMap((st) => st.sql).map((x) => x + ';').join('\n');
    try {
      const ev = await api.evaluateSql(s.session_id, sql);
      let token: string | null = null;
      let typed: string | undefined;
      if (ev.decision.decision !== 'allow') {
        const c = await confirmDecision(ev.decision, { production: s.config.environment === 'production', sqlPreview: sql });
        if (!c) return;
        token = c.token;
        typed = c.typed;
      }
      await api.runMigration(s.session_id, sql, token, typed);
      toast('ok', 'Structure updated');
      void loadObjects(s.session_id, s.activeSchema);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const upd = (i: number, patch: Partial<EditCol>) => setCols(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const editable = !!s?.capabilities.ddl_editing && !s.config.read_only;
  if (!s) return <div className="p-4 text-muted">{t('status.disconnected')}</div>;
  if (!desc && !isNew && !error) return <div className="p-4"><Spinner /></div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <label className="flex items-center gap-1">{t('structure.tableName')}<input className="input w-56" value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} /></label>
        <div className="ml-2 flex gap-0.5" role="tablist">
          {(['columns', 'indexes', 'fks', 'constraints', 'ddl'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={`btn ${view === v ? 'btn-primary' : ''}`} onClick={() => setView(v)}>
              {v === 'fks' ? t('structure.foreignKeys') : t(`structure.${v}`)}
            </button>
          ))}
        </div>
        {editable && (
          <>
            <button className="btn ml-auto" onClick={() => setCols([...cols, { name: `column_${cols.length + 1}`, data_type: 'text', nullable: true, is_primary_key: false, is_identity: false, ordinal: cols.length + 1 }])}>+ {t('structure.addColumn')}</button>
            <button className="btn" onClick={preview}>{t('structure.previewChanges')}</button>
            <button className="btn btn-primary" onClick={apply} disabled={!migration || migration.steps.length === 0}>{t('structure.apply')}</button>
          </>
        )}
      </Toolbar>
      <ErrorBox error={error} />
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_minmax(320px,40%)]">
        <div className="min-h-0 overflow-auto">
          {view === 'columns' && (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-panel">
                <tr>{['#', t('conn.name'), t('structure.type'), t('structure.nullable'), t('structure.default'), t('structure.pk'), 'Identity', t('structure.comment'), ''].map((h) => <th key={h} className="border-b border-border px-2 py-1 text-left">{h}</th>)}</tr>
              </thead>
              <tbody>
                {cols.map((c, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="px-2 text-muted">{i + 1}</td>
                    <td><input className="input" aria-label="Column name" value={c.name} disabled={!editable} onChange={(e) => upd(i, { name: e.target.value })} /></td>
                    <td><input className="input font-mono" aria-label="Type" value={c.data_type} disabled={!editable} onChange={(e) => upd(i, { data_type: e.target.value })} /></td>
                    <td className="text-center"><input type="checkbox" aria-label="Nullable" checked={c.nullable} disabled={!editable} onChange={(e) => upd(i, { nullable: e.target.checked })} /></td>
                    <td><input className="input font-mono" aria-label="Default" value={c.default ?? ''} disabled={!editable} onChange={(e) => upd(i, { default: e.target.value || null })} /></td>
                    <td className="text-center"><input type="checkbox" aria-label="Primary key" checked={c.is_primary_key} disabled={!editable || !isNew} onChange={(e) => upd(i, { is_primary_key: e.target.checked })} /></td>
                    <td className="text-center"><input type="checkbox" aria-label="Identity" checked={c.is_identity} disabled={!editable || !isNew} onChange={(e) => upd(i, { is_identity: e.target.checked })} /></td>
                    <td><input className="input" aria-label="Comment" value={c.comment ?? ''} disabled={!editable} onChange={(e) => upd(i, { comment: e.target.value || null })} /></td>
                    <td>{editable && <button className="btn btn-ghost text-danger" aria-label={`Remove ${c.name}`} onClick={() => setCols(cols.filter((_, j) => j !== i))}>✕</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {view === 'indexes' && <SimpleTable heads={['Name', 'Columns', 'Unique', 'Definition']} rows={(desc?.indexes ?? []).map((x) => [x.name, x.columns.join(', '), x.unique ? '✓' : '', x.definition ?? ''])} />}
          {view === 'fks' && <SimpleTable heads={['Name', 'Columns', 'References', 'On update', 'On delete']} rows={(desc?.foreign_keys ?? []).map((f) => [f.name, f.columns.join(', '), `${f.ref_schema ? f.ref_schema + '.' : ''}${f.ref_table}(${f.ref_columns.join(', ')})`, f.on_update ?? '', f.on_delete ?? ''])} />}
          {view === 'constraints' && <SimpleTable heads={['Name', 'Kind', 'Definition']} rows={(desc?.constraints ?? []).map((c) => [c.name, c.kind, c.definition ?? ''])} />}
          {view === 'ddl' && <pre className="p-2 font-mono text-xs">{desc?.ddl ?? ''}</pre>}
        </div>
        <div className="min-h-0 overflow-auto border-l border-border p-2">
          <h3 className="mb-1 font-semibold">{t('structure.previewChanges')}</h3>
          {!migration ? (
            <p className="text-sm text-muted">Edit columns, then preview the generated SQL.</p>
          ) : migration.steps.length === 0 ? (
            <p className="text-sm text-muted">No changes.</p>
          ) : (
            <>
              <p className={`mb-2 text-sm ${migration.steps.every((x) => x.reverse_sql) ? 'text-ok' : 'text-warn'}`}>
                {migration.steps.every((x) => x.reverse_sql) ? t('structure.reversible') : t('structure.irreversible')}
              </p>
              {migration.steps.map((st, i) => (
                <div key={i} className={`mb-2 rounded border p-2 ${st.destructive ? 'border-danger' : 'border-border'}`}>
                  {(st.destructive || st.may_lock || st.may_rewrite) && (
                    <div className="mb-1 flex gap-1 text-[0.7rem] uppercase">
                      {st.destructive && <span className="rounded bg-danger-solid px-1 text-on-solid">destructive</span>}
                      {st.may_lock && <span className="rounded bg-warn/30 px-1">may lock</span>}
                      {st.may_rewrite && <span className="rounded bg-warn/30 px-1">may rewrite table</span>}
                    </div>
                  )}
                  <pre className="whitespace-pre-wrap font-mono text-xs">{st.sql.join(';\n')};</pre>
                  {st.warnings.map((w, j) => <p key={j} className="mt-1 text-xs text-warn">⚠ {w}</p>)}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function SimpleTable({ heads, rows }: { heads: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-panel"><tr>{heads.map((h) => <th key={h} className="border-b border-border px-2 py-1 text-left">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-border/50">{r.map((c, j) => <td key={j} className="px-2 py-1 align-top font-mono text-xs">{c}</td>)}</tr>)}</tbody>
    </table>
  );
}
