// Optional AI assistant side panel. Nothing is sent until the user previews the
// exact prompt (built and redacted in Rust) and presses Send. Suggested SQL can
// only be inserted into the editor; it is never run from here.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import type { AiAnswer, AiPreview, AiTask, TableTarget } from '../lib/types';
import { errMsg, type OpenSession } from '../store';
import { fmtNumber } from '../lib/format';
import { ErrorBox, Spinner } from './ui';
import { Icon } from './icons';

export const AI_TASKS: AiTask[] = ['explain_sql', 'generate_sql', 'optimize_sql', 'suggest_indexes', 'explain_error', 'explain_plan', 'summarize_schema'];
const SQL_TASKS: AiTask[] = ['explain_sql', 'optimize_sql', 'suggest_indexes'];

export interface AiSources {
  /** Editor selection, or the whole editor when nothing is selected. */
  sql: () => string;
  error: string | null;
  plan: string | null;
}

export function AiPanel({ session, sources, onInsert, onClose }: { session?: OpenSession; sources: AiSources; onInsert: (sql: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [task, setTask] = useState<AiTask>('explain_sql');
  const [input, setInput] = useState(() => sources.sql());
  const [includeSql, setIncludeSql] = useState(false);
  const [includeDialect, setIncludeDialect] = useState(false);
  const [tables, setTables] = useState<string[]>([]);
  const [tableFilter, setTableFilter] = useState('');
  const [preview, setPreview] = useState<AiPreview | null>(null);
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [busy, setBusy] = useState<'preview' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const available = useMemo(
    () => (session?.objects[session.activeSchema ?? ''] ?? []).filter((o) => o.kind === 'table' || o.kind === 'view' || o.kind === 'materialized_view'),
    [session],
  );
  const key = (o: { schema?: string | null; name: string }) => `${o.schema ?? ''}.${o.name}`;
  // Any change to what would be sent invalidates the preview.
  const changed = <A,>(f: (a: A) => void) => (a: A) => {
    f(a);
    setPreview(null);
  };

  const prefill = (tk: AiTask) => {
    if (SQL_TASKS.includes(tk)) return sources.sql();
    if (tk === 'explain_error') return sources.error ?? '';
    if (tk === 'explain_plan') return sources.plan ?? '';
    return '';
  };
  const pickTask = (tk: AiTask) => {
    setTask(tk);
    setInput(prefill(tk));
    setIncludeSql(false);
    setPreview(null);
    setAnswer(null);
    setError(null);
  };

  const doPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      const targets: TableTarget[] = available.filter((o) => tables.includes(key(o))).map((o) => ({ schema: o.schema ?? null, table: o.name }));
      setPreview(
        await api.aiPreview({
          task,
          input,
          sql: includeSql ? sources.sql() : null,
          session_id: session?.session_id ?? null,
          include_dialect: includeDialect,
          tables: targets,
        }),
      );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const doSend = async () => {
    if (!preview) return;
    setBusy('send');
    setError(null);
    try {
      setAnswer(await api.aiSend(preview));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const inputLabel = task === 'generate_sql' ? t('ai.inputRequest') : task === 'explain_error' ? t('ai.inputError') : task === 'explain_plan' ? t('ai.inputPlan') : task === 'summarize_schema' ? t('ai.inputNote') : t('ai.inputSql');
  const shown = available.filter((o) => !tableFilter || o.name.toLowerCase().includes(tableFilter.toLowerCase()));

  return (
    <aside aria-label={t('ai.title')} className="flex h-full min-h-0 w-[380px] shrink-0 flex-col border-s border-border bg-panel text-[0.92rem]">
      <div className="flex h-[32px] shrink-0 items-center gap-2 border-b border-border px-2">
        <span className="font-semibold">{t('ai.title')}</span>
        <button className="icon-btn ms-auto h-6 w-6" onClick={onClose} aria-label={t('common.close')}><Icon name="x" size={13} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <label className="label" htmlFor="ai-task">{t('ai.task')}</label>
        <select id="ai-task" className="input mb-2 w-full" value={task} onChange={(e) => pickTask(e.target.value as AiTask)}>
          {AI_TASKS.map((x) => <option key={x} value={x}>{t(`ai.tasks.${x}`)}</option>)}
        </select>

        <label className="label" htmlFor="ai-input">{inputLabel}</label>
        <textarea id="ai-input" className="input mb-1 h-28 w-full font-mono text-xs" value={input} onChange={(e) => changed(setInput)(e.target.value)} />
        {SQL_TASKS.includes(task) && <button className="btn btn-ghost mb-2 h-6 px-2" onClick={() => changed(setInput)(sources.sql())}>{t('ai.useEditor')}</button>}

        <fieldset className="mb-2 rounded border border-border p-2">
          <legend className="px-1 text-xs text-muted">{t('ai.context')}</legend>
          <p className="mb-1 text-xs text-muted">{t('ai.contextHint')}</p>
          {(task === 'explain_error' || task === 'explain_plan') && (
            <label className="flex items-center gap-2"><input type="checkbox" checked={includeSql} onChange={(e) => changed(setIncludeSql)(e.target.checked)} />{t('ai.includeSql')}</label>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={includeDialect} disabled={!session} onChange={(e) => changed(setIncludeDialect)(e.target.checked)} />{t('ai.includeDialect')}
          </label>
          <div className="mt-1 text-xs font-semibold">{t('ai.includeTables')}</div>
          {!session ? (
            <p className="text-xs text-muted">{t('ai.noSession')}</p>
          ) : (
            <>
              {available.length > 8 && <input className="input my-1 h-6 w-full" placeholder={t('tree.filter')} aria-label={t('tree.filter')} value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} />}
              <div className="max-h-32 overflow-auto">
                {shown.map((o) => (
                  <label key={key(o)} className="flex items-center gap-2 font-mono text-xs">
                    <input type="checkbox" checked={tables.includes(key(o))} onChange={(e) => changed(setTables)(e.target.checked ? [...tables, key(o)] : tables.filter((x) => x !== key(o)))} />
                    {o.name}
                  </label>
                ))}
                {available.length === 0 && <p className="text-xs text-muted">{t('ai.noTables')}</p>}
              </div>
            </>
          )}
        </fieldset>

        <button className="btn btn-primary mb-2 h-7 w-full" onClick={doPreview} disabled={!!busy}>{busy === 'preview' ? <Spinner /> : t('ai.preview')}</button>
        <ErrorBox error={error} />

        {preview && (
          <section aria-label={t('ai.previewTitle')} className="mb-2 rounded border border-warn/50 bg-warn/5 p-2">
            <div className="mb-1 text-xs font-semibold">{t('ai.previewTitle')}</div>
            <p className="mb-1 text-xs text-muted">{t('ai.previewInfo', { bytes: fmtNumber(preview.bytes), model: preview.model, endpoint: preview.base_url })}</p>
            <pre data-testid="ai-preview" dir="auto" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-1 font-mono text-[0.75rem]">{preview.text}</pre>
            <div className="mt-2 flex gap-2">
              <button className="btn btn-primary h-7 flex-1" onClick={doSend} disabled={!!busy}>{busy === 'send' ? <Spinner label={t('ai.sending')} /> : t('ai.send')}</button>
              <button className="btn h-7" onClick={() => setPreview(null)} disabled={!!busy}>{t('common.cancel')}</button>
            </div>
          </section>
        )}

        {answer && (
          <section aria-label={t('ai.answer')} className="rounded border border-border p-2">
            <div className="mb-1 flex items-center text-xs text-muted">
              <span>{t('ai.answerFrom', { model: answer.model, ms: answer.duration_ms })}</span>
            </div>
            {/* Plain text only: model output is never rendered as HTML. */}
            <pre data-testid="ai-answer" dir="auto" className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans text-[0.85rem]">{answer.text}</pre>
            {answer.truncated && <p className="mt-1 text-xs text-warn">{t('ai.truncated')}</p>}
            {answer.sql && (
              <>
                <button className="btn mt-2 h-7 w-full" onClick={() => onInsert(answer.sql!)}>{t('ai.insert')}</button>
                <p className="mt-1 text-xs text-muted">{t('ai.insertHint')}</p>
              </>
            )}
            <p className="mt-2 text-xs text-muted">{t('ai.disclaimer')}</p>
          </section>
        )}
      </div>
    </aside>
  );
}
