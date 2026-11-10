import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ColumnMeta, Value } from '../lib/types';
import { editableText, parseInput } from '../lib/value';
import { Dialog, ErrorBox } from './ui';

type Mode = 'text' | 'json-tree' | 'hex' | 'image';

/** Large-value editor: long text, JSON (raw + tree), binary (hex / image preview), XML, dates. */
export function CellEditor({ column, value, readOnly, onSave, onClose }: { column: ColumnMeta; value: Value; readOnly?: boolean; onSave: (v: Value) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(editableText(value));
  const [isNull, setIsNull] = useState(value.t === 'null');
  const isJson = value.t === 'json' || /json/i.test(column.type_name);
  const isBytes = value.t === 'bytes';
  const imgSrc = useMemo(() => {
    if (value.t !== 'bytes' || value.v.truncated) return null;
    const h = value.v.hex;
    const mime = h.startsWith('89504e47') ? 'image/png' : h.startsWith('ffd8ff') ? 'image/jpeg' : h.startsWith('47494638') ? 'image/gif' : h.startsWith('52494646') ? 'image/webp' : null;
    if (!mime) return null;
    const bytes = new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }, [value]);
  const [mode, setMode] = useState<Mode>(imgSrc ? 'image' : isJson ? 'json-tree' : isBytes ? 'hex' : 'text');
  let jsonErr: string | null = null;
  let parsed: unknown = undefined;
  if (isJson && !isNull) {
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      jsonErr = String(e);
    }
  }
  const save = () => onSave(isNull ? { t: 'null' } : parseInput(text, column, value));
  return (
    <Dialog
      title={`${column.name} (${column.type_name})`}
      onClose={onClose}
      wide
      footer={
        <>
          {!readOnly && (
            <label className="mr-auto flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isNull} onChange={(e) => setIsNull(e.target.checked)} /> NULL
            </label>
          )}
          <button className="btn" onClick={() => navigator.clipboard.writeText(text)}>{t('common.copy')}</button>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          {!readOnly && <button className="btn btn-primary" onClick={save} disabled={!!jsonErr && !isNull}>{t('common.apply')}</button>}
        </>
      }
    >
      <div className="mb-2 flex gap-1" role="tablist">
        {(['text', ...(isJson ? ['json-tree'] : []), ...(isBytes ? ['hex'] : []), ...(imgSrc ? ['image'] : [])] as Mode[]).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`btn ${mode === m ? 'btn-primary' : ''}`} onClick={() => setMode(m)}>{m}</button>
        ))}
        {isJson && !readOnly && (
          <button className="btn ml-auto" onClick={() => parsed !== undefined && setText(JSON.stringify(parsed, null, 2))}>{t('query.format')}</button>
        )}
      </div>
      {mode === 'text' && (
        <textarea className="input h-[50vh] font-mono" value={isNull ? '' : text} disabled={isNull} readOnly={readOnly} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      )}
      {mode === 'json-tree' && <div className="h-[50vh] overflow-auto rounded border border-border p-2 font-mono text-sm">{parsed !== undefined ? <JsonNode k={null} v={parsed} /> : <ErrorBox error={jsonErr} />}</div>}
      {mode === 'hex' && value.t === 'bytes' && <HexView hex={value.v.hex} truncated={value.v.truncated} len={value.v.len} />}
      {mode === 'image' && imgSrc && <img src={imgSrc} alt={`${column.name} preview`} className="max-h-[50vh] max-w-full object-contain" />}
      {isJson && mode === 'text' && <ErrorBox error={jsonErr && !isNull ? jsonErr : null} />}
    </Dialog>
  );
}

function JsonNode({ k, v, depth = 0 }: { k: string | null; v: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = v !== null && typeof v === 'object';
  const label = k !== null ? <span className="text-accent">{k}: </span> : null;
  if (!isObj) return <div style={{ paddingLeft: depth * 12 }}>{label}<span className={typeof v === 'string' ? 'text-ok' : 'text-warn'}>{JSON.stringify(v)}</span></div>;
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as object);
  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <button className="text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {label}
        <span className="text-muted">{Array.isArray(v) ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {open && entries.slice(0, 1000).map(([ck, cv]) => <JsonNode key={ck} k={ck} v={cv} depth={depth + 1} />)}
    </div>
  );
}

function HexView({ hex, truncated, len }: { hex: string; truncated: boolean; len: number }) {
  const lines = [];
  for (let i = 0; i < Math.min(hex.length, 16 * 2 * 512); i += 32) {
    const chunk = hex.slice(i, i + 32);
    const bytes = chunk.match(/../g) ?? [];
    const ascii = bytes.map((b) => { const c = parseInt(b, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; }).join('');
    lines.push(`${(i / 2).toString(16).padStart(8, '0')}  ${bytes.join(' ').padEnd(47)}  ${ascii}`);
  }
  return (
    <div>
      <pre className="h-[50vh] overflow-auto rounded border border-border p-2 font-mono text-xs">{lines.join('\n')}</pre>
      <p className="mt-1 text-xs text-muted">{len} bytes{truncated ? ' (preview truncated)' : ''}</p>
    </div>
  );
}
