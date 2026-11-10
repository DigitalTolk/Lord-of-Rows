import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import type { ColumnMeta, ExportFormat, StatementResult, Value } from '../lib/types';
import { displayValue } from '../lib/value';
import { errMsg, useApp } from '../store';
import { DataGrid } from './DataGrid';

import Chart from './Chart';

type Mode = 'grid' | 'json' | 'text' | 'record' | 'chart';

export async function copyAs(columns: ColumnMeta[], rows: Value[][], format: ExportFormat, table?: string) {
  const text = await api.copyRows(columns, rows, { format, header: true, formula_guard: format === 'csv' || format === 'tsv', table: table ? { table } : null });
  await navigator.clipboard.writeText(text);
}

export function Results({ results, messages }: { results: StatementResult[]; messages: string[] }) {
  const { t } = useTranslation();
  const toast = useApp((s) => s.toast);
  const withRows = results.filter((r) => r.result);
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState<Mode>('grid');
  const [search, setSearch] = useState('');
  const [recordRow, setRecordRow] = useState(0);
  const current = withRows[Math.min(idx, withRows.length - 1)];
  const rs = current?.result;

  const filteredRows = useMemo(() => {
    if (!rs || !search) return rs?.rows ?? [];
    const q = search.toLowerCase();
    return rs.rows.filter((r) => r.some((v) => displayValue(v).toLowerCase().includes(q)));
  }, [rs, search]);

  const copy = async (rowsIdx: number[], cols: string[], format: ExportFormat = 'tsv') => {
    if (!rs) return;
    const ci = cols.length ? cols.map((c) => rs.columns.findIndex((x) => x.name === c)) : rs.columns.map((_, i) => i);
    const rows = (rowsIdx.length ? rowsIdx.map((r) => filteredRows[r]) : filteredRows).map((r) => ci.map((i) => r[i]));
    try {
      await copyAs(ci.map((i) => rs.columns[i]), rows, format);
      toast('info', `Copied ${rows.length} row(s)`);
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const [tab, setTab] = useState<'results' | 'messages'>('results');
  const allMessages = [
    ...results.map((r) => `#${r.statement_index + 1} ${r.sql_excerpt.slice(0, 80)} — ${r.rows_affected != null ? t('query.rowsAffected', { n: r.rows_affected }) : r.result ? t('query.rowsReturned', { n: r.result.rows.length }) : 'OK'} (${t('query.duration', { ms: r.duration_ms })})`),
    ...results.flatMap((r) => r.notices),
    ...messages,
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[32px] shrink-0 items-center gap-1 border-b border-border bg-panel px-2" role="tablist">
        <button role="tab" aria-selected={tab === 'results'} className={`btn btn-ghost ${tab === 'results' ? 'font-semibold' : ''}`} onClick={() => setTab('results')}>Results</button>
        <button role="tab" aria-selected={tab === 'messages'} className={`btn btn-ghost ${tab === 'messages' ? 'font-semibold' : ''}`} onClick={() => setTab('messages')}>{t('query.messages')} ({allMessages.length})</button>
        {tab === 'results' && withRows.length > 1 && (
          <select className="input ml-2 w-auto" aria-label="Result set" value={idx} onChange={(e) => setIdx(Number(e.target.value))}>
            {withRows.map((r, i) => <option key={i} value={i}>{t('query.statement', { n: r.statement_index + 1 })}: {r.sql_excerpt.slice(0, 40)}</option>)}
          </select>
        )}
        {tab === 'results' && rs && (
          <>
            <div className="seg ml-2" role="radiogroup" aria-label="View">
              {(['grid', 'json', 'text', 'record', 'chart'] as Mode[]).map((m) => (
                <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>{t(`query.${m}`)}</button>
              ))}
            </div>
            <input className="input ml-2 h-6 w-48" placeholder={t('grid.searchResults')} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t('grid.searchResults')} />
            <select className="input h-6 w-auto py-0" aria-label={t('grid.copyAs')} value="" onChange={(e) => e.target.value && copy([], [], e.target.value as ExportFormat)}>
              <option value="">{t('grid.copyAs')}…</option>
              <option value="csv">CSV</option><option value="tsv">TSV</option><option value="json">JSON</option><option value="sql_insert">SQL INSERT</option><option value="markdown">Markdown</option>
            </select>
            <span className="ml-auto text-xs text-muted">
              {t('query.rowsReturned', { n: filteredRows.length })} · {t('query.duration', { ms: current.duration_ms })}
              {rs.truncated && <span className="ml-2 text-warn">{t('query.truncated', { n: rs.rows.length })}</span>}
            </span>
          </>
        )}
      </div>
      {tab === 'messages' ? (
        <pre className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs" aria-live="polite">{allMessages.join('\n')}</pre>
      ) : !rs ? (
        <div className="p-4 text-muted">{results.length ? allMessages.slice(0, 5).join('\n') : t('query.noResults')}</div>
      ) : mode === 'grid' ? (
        <DataGrid columns={rs.columns} rows={filteredRows} onCopy={(r, c) => copy(r, c)} onSelectRows={(r) => r.length && setRecordRow(r[0])} ariaLabel="Query results" />
      ) : mode === 'json' ? (
        <pre className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs">
          {JSON.stringify(filteredRows.slice(0, 5000).map((r) => Object.fromEntries(rs.columns.map((c, i) => [c.name, r[i].t === 'null' ? null : displayValue(r[i])]))), null, 2)}
        </pre>
      ) : mode === 'text' ? (
        <pre className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs">{textTable(rs.columns, filteredRows.slice(0, 5000))}</pre>
      ) : mode === 'record' ? (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div className="mb-2 flex items-center gap-2">
            <button className="btn" disabled={recordRow <= 0} onClick={() => setRecordRow((r) => r - 1)}>◀</button>
            <span>{recordRow + 1} / {filteredRows.length}</span>
            <button className="btn" disabled={recordRow >= filteredRows.length - 1} onClick={() => setRecordRow((r) => r + 1)}>▶</button>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {rs.columns.map((c, i) => (
                <tr key={i} className="border-b border-border">
                  <th scope="row" className="w-1/4 px-2 py-1 text-left align-top text-muted">{c.name}</th>
                  <td className="whitespace-pre-wrap break-all px-2 py-1 font-mono">{filteredRows[recordRow] ? displayValue(filteredRows[recordRow][i]) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Chart columns={rs.columns} rows={filteredRows} />
      )}
    </div>
  );
}

function textTable(cols: ColumnMeta[], rows: Value[][]): string {
  const cells = rows.map((r) => r.map((v) => displayValue(v).replace(/\n/g, '\\n')));
  const w = cols.map((c, i) => Math.min(60, Math.max(c.name.length, ...cells.map((r) => r[i].length))));
  const line = (vals: string[]) => vals.map((v, i) => v.slice(0, 60).padEnd(w[i])).join(' | ');
  return [line(cols.map((c) => c.name)), w.map((n) => '-'.repeat(n)).join('-+-'), ...cells.map(line)].join('\n');
}
