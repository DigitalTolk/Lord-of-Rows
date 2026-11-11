import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirmDecision } from '../components/confirm';
import { ErrorBox, Field, Spinner, Toolbar } from '../components/ui';
import { api } from '../lib/ipc';
import type { ColumnMapping, ImportOptions, ImportPreview, InferredType, PickedFile } from '../lib/types';
import { displayValue } from '../lib/value';
import { fmtNumber } from '../lib/format';
import { errMsg, useApp, type Tab } from '../store';

const TYPES: InferredType[] = ['integer', 'decimal', 'boolean', 'date', 'timestamp', 'json', 'text'];

export function ImportView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const { sessions, toast, loadObjects } = useApp();
  const s = tab.sessionId ? sessions[tab.sessionId] : undefined;
  const [file, setFile] = useState<PickedFile | null>(null);
  const [opts, setOpts] = useState<ImportOptions>({ format: 'csv', delimiter: null, has_header: true, quote: '"', null_tokens: ['NULL', '\\N'], encoding: 'utf-8', batch_size: 500 });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<(ColumnMapping | null)[]>([]);
  const [target, setTarget] = useState(tab.target?.table ?? '');
  const [create, setCreate] = useState(!tab.target);
  const [atomic, setAtomic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);

  const pick = async () => {
    const f = await api.pickFile(false, undefined, ['csv', 'tsv', 'txt', 'json', 'jsonl', 'ndjson']);
    if (!f) return;
    setFile(f);
    const ext = f.name.split('.').pop()?.toLowerCase();
    const format = ext === 'json' ? 'json' : ext === 'jsonl' || ext === 'ndjson' ? 'json_lines' : ext === 'tsv' ? 'tsv' : 'csv';
    const o = { ...opts, format } as ImportOptions;
    setOpts(o);
    if (!target) setTarget(f.name.replace(/\.[^.]+$/, '').replace(/[^\w]/g, '_'));
    await loadPreview(f, o);
  };

  const loadPreview = async (f = file, o = opts) => {
    if (!f) return;
    setError(null);
    try {
      const p = await api.importPreview(f.grant, o);
      setPreview(p);
      setMapping(p.columns.map((c, i) => ({ source_index: i, target: c, kind: p.inferred[i] })));
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const run = async (token?: string) => {
    if (!s || !file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.importRun({
        session_id: s.session_id, grant: file.grant, options: opts, target: { schema: s.activeSchema, table: target },
        mapping: mapping.filter((m): m is ColumnMapping => !!m), create_table: create, atomic, confirm_token: token ?? null,
      });
      if (r.confirm) {
        const c = await confirmDecision(r.confirm, { production: s.config.environment === 'production' });
        if (c) await run(c.token);
        return;
      }
      const done = t('io.done', { count: r.rows_imported, formatted: fmtNumber(r.rows_imported) });
      setReport(`${done}${r.batches_failed.length ? ` — ${t('io.batchesFailed', { count: r.batches_failed.length })}\n${r.batches_failed.map(([b, m]) => `#${b}: ${m}`).join('\n')}` : ''}`);
      toast('ok', done);
      void loadObjects(s.session_id, s.activeSchema);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (!s) return <div className="p-4 text-muted">{t('status.disconnected')}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <span className="font-semibold">{t('io.importTitle')}</span>
        <button className="btn" onClick={pick}>{t('io.chooseFile')}</button>
        {file && <span className="truncate text-sm text-muted">{file.display_path}</span>}
      </Toolbar>
      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr]">
        <div className="overflow-auto border-e border-border p-2">
          <Field label={t('io.format')}>
            <select className="input" value={opts.format} onChange={(e) => { const o = { ...opts, format: e.target.value as ImportOptions['format'] }; setOpts(o); void loadPreview(file, o); }}>
              <option value="csv">CSV</option><option value="tsv">TSV</option><option value="json">{t('io.formatJson')}</option><option value="json_lines">{t('io.formatJsonLines')}</option>
            </select>
          </Field>
          {(opts.format === 'csv' || opts.format === 'tsv') && (
            <>
              <Field label={t('io.delimiter')}><input className="input font-mono" maxLength={1} value={opts.delimiter ?? ''} placeholder={opts.format === 'tsv' ? '\\t' : ','} onChange={(e) => setOpts({ ...opts, delimiter: e.target.value || null })} /></Field>
              <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={opts.has_header} onChange={(e) => setOpts({ ...opts, has_header: e.target.checked })} />{t('io.header')}</label>
            </>
          )}
          <Field label={t('io.encoding')}><select className="input" value={opts.encoding} onChange={(e) => setOpts({ ...opts, encoding: e.target.value })}><option value="utf-8">UTF-8</option><option value="latin1">Latin-1</option></select></Field>
          <Field label={t('io.nullTokens')}><input className="input font-mono" value={opts.null_tokens.join(',')} onChange={(e) => setOpts({ ...opts, null_tokens: e.target.value.split(',') })} /></Field>
          <button className="btn mb-3" onClick={() => loadPreview()} disabled={!file}>{t('io.refreshPreview')}</button>
          <Field label={t('io.targetTable')}><input className="input" value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
          <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} />{t('io.createTable')}</label>
          <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={atomic} onChange={(e) => setAtomic(e.target.checked)} />{t('io.atomic')}</label>
          <button className="btn btn-primary w-full justify-center" onClick={() => run()} disabled={!preview || !target || busy}>{busy ? <Spinner label={t('io.importing')} /> : t('common.import')}</button>
          <ErrorBox error={error} />
          {report && <pre role="status" className="mt-2 whitespace-pre-wrap rounded border border-ok/40 bg-ok/10 p-2 text-sm">{report}</pre>}
        </div>
        <div className="min-h-0 overflow-auto p-2">
          {preview && (
            <>
              <h3 className="mb-1 font-semibold">{t('io.mapping')}</h3>
              <table className="mb-4 text-sm">
                <thead><tr><th className="px-2 text-start">{t('io.source')}</th><th className="px-2 text-start">{t('io.targetColumn')}</th><th className="px-2 text-start">{t('io.type')}</th></tr></thead>
                <tbody>
                  {preview.columns.map((c, i) => (
                    <tr key={i}>
                      <td className="px-2 font-mono">{c}</td>
                      <td className="px-2">
                        <input className="input" aria-label={t('io.targetFor', { column: c })} value={mapping[i]?.target ?? ''} placeholder={t('io.skip')} onChange={(e) => setMapping(mapping.map((m, j) => (j === i ? (e.target.value ? { source_index: i, target: e.target.value, kind: m?.kind ?? preview.inferred[i] } : null) : m)))} />
                      </td>
                      <td className="px-2">
                        <select className="input" aria-label={t('io.typeFor', { column: c })} value={mapping[i]?.kind ?? preview.inferred[i]} disabled={!mapping[i]} onChange={(e) => setMapping(mapping.map((m, j) => (j === i && m ? { ...m, kind: e.target.value as InferredType } : m)))}>
                          {TYPES.map((x) => <option key={x}>{x}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 className="mb-1 font-semibold">{t('io.previewRows', { count: preview.rows.length, formatted: fmtNumber(preview.rows.length) })}</h3>
              <table className="text-xs">
                <thead><tr>{preview.columns.map((c) => <th key={c} className="border-b border-border px-2 text-start">{c}</th>)}</tr></thead>
                <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={`border-b border-border/50 px-2 font-mono ${v.t === 'null' ? 'cell-null' : ''}`}>{displayValue(v)}</td>)}</tr>)}</tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
