import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtNumber } from '../lib/format';
import type { StagedState } from '../lib/changes';
import { fieldStates, isJsonField, isMultiline, stageDefault, stageField, typeLabel, type FieldState } from '../lib/rowDetail';
import type { ColumnDef, ColumnMeta, Value } from '../lib/types';
import { editableText, parseInput } from '../lib/value';
import { Icon } from './icons';

export interface RowDetailPanelProps {
  columns: ColumnMeta[];
  rows: Value[][];
  staged: StagedState;
  /** Selected row indices (inserted rows follow loaded rows). */
  selection: number[];
  /** Column definitions (defaults, nullability); optional. */
  defs?: ColumnDef[];
  /** Editing allowed for loaded rows (requires a key); inserted rows are always editable when `editable`. */
  editable: boolean;
  canEditExisting: boolean;
  onStage: (next: StagedState) => void;
  onClose: () => void;
}

/** Right-hand panel showing the selected row as a vertical form. Edits stage like grid edits. */
export function RowDetailPanel(p: RowDetailPanelProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const fields = useMemo(() => fieldStates(p.columns, p.rows, p.staged, p.selection), [p.columns, p.rows, p.staged, p.selection]);
  const ql = q.trim().toLowerCase();
  const shown = fields.filter((f) => !ql || f.column.name.toLowerCase().includes(ql) || typeLabel(f.column.type_name).includes(ql));
  const sel = p.selection.filter((r) => r < p.rows.length + p.staged.inserted.length);
  const onlyInserted = sel.length > 0 && sel.every((r) => r >= p.rows.length);
  const allDeleted = sel.length > 0 && sel.every((r) => p.staged.deleted.includes(r));
  const canEdit = p.editable && sel.length > 0 && !allDeleted && (p.canEditExisting || onlyInserted);

  const stage = (f: FieldState, v: Value) => p.onStage(stageField(p.staged, p.rows, sel, f.column, f.index, v));

  return (
    <aside aria-label={t('tableWs.detailTitle')} className="flex h-full min-h-0 w-full flex-col border-s border-border bg-panel">
      <div className="flex items-center gap-1 border-b border-border p-1.5">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" size={13} className="absolute start-2 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input h-7 w-full ps-7" placeholder={t('tableWs.searchField')} aria-label={t('tableWs.searchField')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="icon-btn shrink-0" aria-label={t('common.close')} title={t('common.close')} onClick={p.onClose}><Icon name="x" size={13} /></button>
      </div>
      {sel.length > 1 && <div className="border-b border-border px-2 py-1 text-[0.8rem] text-muted">{t('tableWs.rowsSelectedShort', { count: sel.length, formatted: fmtNumber(sel.length) })}</div>}
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {sel.length === 0 ? (
          <p className="px-2 py-6 text-center text-muted">{t('tableWs.noSelection')}</p>
        ) : shown.length === 0 ? (
          <p className="px-2 py-6 text-center text-muted">{t('tableWs.noFields')}</p>
        ) : (
          shown.map((f) => (
            <Field
              key={f.column.name}
              f={f}
              def={p.defs?.find((d) => d.name === f.column.name)}
              readOnly={!canEdit}
              insertedOnly={onlyInserted}
              onSet={(v) => stage(f, v)}
              onDefault={() => p.onStage(stageDefault(p.staged, p.rows, sel, f.column.name))}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function Field({ f, def, readOnly, insertedOnly, onSet, onDefault }: { f: FieldState; def?: ColumnDef; readOnly: boolean; insertedOnly: boolean; onSet: (v: Value) => void; onDefault: () => void }) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const id = `fld-${f.column.name}`;
  const label = typeLabel(def?.data_type ?? f.column.type_name);
  return (
    <div className={`mb-1.5 rounded-md px-1.5 py-1 ${f.edited ? 'bg-warn/15' : ''}`} data-field={f.column.name}>
      <div className="mb-0.5 flex items-center gap-1.5 text-[0.82rem]">
        <label htmlFor={id} className="truncate font-semibold">{f.column.name}</label>
        <span className="shrink-0 rounded bg-hover px-1 font-mono text-[0.72rem] text-muted" title={def?.data_type ?? f.column.type_name}>{label}</span>
        <div className="relative ml-auto">
          <button className="icon-btn h-5 w-5" aria-label={`${t('tableWs.fieldMenu')}: ${f.column.name}`} aria-haspopup="menu" aria-expanded={menu} disabled={readOnly} onClick={() => setMenu(!menu)}>
            <Icon name="chevronDown" size={12} />
          </button>
          {menu && (
            <div role="menu" className="absolute end-0 top-full z-40 mt-0.5 w-52 rounded-lg border border-border bg-raised p-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
              <button role="menuitem" className="menu-item" disabled={(def?.nullable ?? f.column.nullable ?? true) === false} onClick={() => { setMenu(false); onSet({ t: 'null' }); }}>{t('tableWs.setNull')}</button>
              <button role="menuitem" className="menu-item" onClick={() => { setMenu(false); onSet({ t: 'text', v: '' }); }}>{t('tableWs.setEmpty')}</button>
              <button role="menuitem" className="menu-item disabled:opacity-40" disabled={!insertedOnly} title={def?.default ?? undefined} onClick={() => { setMenu(false); onDefault(); }}>{t('tableWs.setDefault')}</button>
            </div>
          )}
        </div>
      </div>
      <FieldEditor id={id} f={f} readOnly={readOnly} onSet={onSet} />
    </div>
  );
}

function FieldEditor({ id, f, readOnly, onSet }: { id: string; f: FieldState; readOnly: boolean; onSet: (v: Value) => void }) {
  const { t } = useTranslation();
  const v = f.value;
  const isNull = v?.t === 'null';
  const initial = v && !isNull ? editableText(v) : '';
  // Keyed by the external value so a grid edit / undo refreshes the draft.
  const key = f.multiple ? '\u0000multi' : JSON.stringify(v);
  const commit = (text: string) => {
    if (f.multiple && text === '') return;
    if (isNull && text === '') return;
    if (!f.multiple && text === initial) return;
    onSet(parseInput(text, f.column, v ?? undefined));
  };
  if (isJsonField(f.column, v) && !f.multiple && !isNull) return <JsonEditor key={key} id={id} text={initial} readOnly={readOnly} onCommit={commit} />;
  const placeholder = f.multiple ? t('tableWs.multiple') : isNull ? 'NULL' : '';
  const cls = `input w-full font-mono text-[0.85rem] ${isNull || f.multiple ? 'placeholder:italic' : ''}`;
  if (isMultiline(f.column, initial)) {
    return <Draft key={key} initial={initial} render={(val, setVal) => (
      <textarea id={id} className={`${cls} min-h-[3.2rem] resize-y py-1`} rows={Math.min(8, Math.max(2, val.split('\n').length))} readOnly={readOnly} placeholder={placeholder} value={val}
        onChange={(e) => setVal(e.target.value)} onBlur={() => commit(val)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit(val);
        }} />
    )} />;
  }
  return <Draft key={key} initial={initial} render={(val, setVal) => (
    <input id={id} className={`${cls} h-7`} readOnly={readOnly} placeholder={placeholder} value={val} onChange={(e) => setVal(e.target.value)} onBlur={() => commit(val)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(val);
        if (e.key === 'Escape') setVal(initial);
      }} />
  )} />;
}

function Draft({ initial, render }: { initial: string; render: (v: string, set: (s: string) => void) => ReactNode }) {
  const [v, setV] = useState(initial);
  return <>{render(v, setV)}</>;
}

/** Pretty-printed JSON with lightweight syntax highlighting; click Edit for a textarea. */
function JsonEditor({ id, text, readOnly, onCommit }: { id: string; text: string; readOnly: boolean; onCommit: (t: string) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  if (editing) {
    return (
      <div>
        <textarea id={id} className="input min-h-[6rem] w-full resize-y py-1 font-mono text-[0.82rem]" rows={Math.min(16, draft.split('\n').length + 1)} value={draft} autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setDraft(text); setEditing(false); }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { onCommit(draft); setEditing(false); }
          }} />
        <div className="mt-0.5 flex justify-end">
          <button className="btn h-6" onClick={() => { onCommit(draft); setEditing(false); }}>{t('tableWs.done')}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="group relative">
      <pre id={id} tabIndex={0} className="max-h-72 overflow-auto rounded-md border border-border bg-bg p-1.5 font-mono text-[0.8rem] leading-[1.35]">{highlightJson(text)}</pre>
      {!readOnly && <button className="btn absolute end-1 top-1 h-6 opacity-0 focus:opacity-100 group-hover:opacity-100" onClick={() => setEditing(true)}>{t('tableWs.editJson')}</button>}
    </div>
  );
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Tokenise pretty-printed JSON into coloured spans (theme tokens, so both themes work). */
export function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const cls = m[1] ? (m[2] ? 'text-accent' : 'text-ok') : m[3] ? 'text-purple' : 'text-warn';
    out.push(<span key={i++} className={cls}>{m[1] ?? m[0]}</span>);
    if (m[2]) out.push(m[2]);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
