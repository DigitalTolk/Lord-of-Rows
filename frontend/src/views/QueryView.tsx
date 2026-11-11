import Editor, { type OnMount } from '@monaco-editor/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format as formatSql } from 'sql-formatter';
import { confirmDecision } from '../components/confirm';
import { Results } from '../components/Results';
import { ask } from '../components/ask';
import { ErrorBox, Spinner } from '../components/ui';
import { Icon } from '../components/icons';
import { api, IpcError } from '../lib/ipc';
import { monaco, registerSqlCompletion, setCompletionSource, useEditorTheme } from '../lib/monaco';
import { family } from '../lib/sqlgen';
import type { StatementResult } from '../lib/types';
import { errMsg, useApp, type Tab } from '../store';

const formatterLang = (e: string) => (family(e as never) === 'pg' ? 'postgresql' : family(e as never) === 'mysql' ? 'mysql' : family(e as never) === 'sqlite' ? 'sqlite' : family(e as never) === 'mssql' ? 'transactsql' : 'sql');

export function QueryView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const { sessions, updateTab, settings, toast } = useApp();
  const s = tab.sessionId ? sessions[tab.sessionId] : undefined;
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<StatementResult[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState(0.5);
  const isRedis = s?.config.engine === 'redis';
  const editorTheme = useEditorTheme();

  // Feed schema metadata into autocomplete.
  useEffect(() => {
    if (!s) return;
    const objs = s.objects[s.activeSchema ?? ''] ?? [];
    setCompletionSource({ tables: objs.filter((o) => ['table', 'view', 'materialized_view'].includes(o.kind)).map((o) => ({ name: o.name, schema: o.schema, kind: o.kind })), columns: {} });
    const tables = objs.filter((o) => o.kind === 'table').slice(0, 200);
    let cancelled = false;
    // Lazily describe tables for column completion (bounded).
    void (async () => {
      const columns: Record<string, string[]> = {};
      for (const o of tables) {
        if (cancelled) return;
        try {
          const d = await api.describeTable(s.session_id, { schema: o.schema, table: o.name });
          columns[o.name] = d.columns.map((c) => c.name);
        } catch {
          /* ignore */
        }
      }
      if (!cancelled) setCompletionSource({ tables: objs.filter((o) => ['table', 'view', 'materialized_view'].includes(o.kind)).map((o) => ({ name: o.name, schema: o.schema, kind: o.kind })), columns });
    })();
    return () => {
      cancelled = true;
    };
  }, [s?.session_id, s?.activeSchema, s?.objects]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(
    async (which: 'all' | 'current' | 'selection') => {
      const ed = editorRef.current;
      if (!ed || !s) return;
      const model = ed.getModel()!;
      const full = model.getValue();
      let sql = full;
      const selection = ed.getSelection();
      if (which === 'selection' && selection && !selection.isEmpty()) sql = model.getValueInRange(selection);
      else if (which === 'current' || (which === 'selection' && selection?.isEmpty())) {
        if (!isRedis) {
          const offset = model.getOffsetAt(ed.getPosition()!);
          const spans = await api.splitSql(s.config.engine, full);
          const hit = spans.find(([a, b]) => offset >= a && offset <= b) ?? [...spans].reverse().find(([, b]) => b <= offset);
          if (hit) sql = full.slice(hit[0], hit[1]);
        } else {
          sql = model.getLineContent(ed.getPosition()!.lineNumber);
        }
      }
      if (!sql.trim()) return;
      ed.trigger('run', 'hideSuggestWidget', null);
      setError(null);
      setMessages([]);
      const queryId = crypto.randomUUID();
      setRunning(queryId);
      try {
        // Backend evaluates the safety policy; confirm if required, then run with the token.
        const ev = await api.evaluateSql(s.session_id, sql);
        let token: string | null = null;
        let typed: string | undefined;
        if (ev.decision.decision !== 'allow') {
          const c = await confirmDecision(ev.decision, { production: s.config.environment === 'production' });
          if (!c) return;
          token = c.token;
          typed = c.typed;
        }
        const r = await api.runSql({ session_id: s.session_id, sql, query_id: queryId, confirm_token: token, typed_confirmation: typed ?? null });
        setResults(r.results);
        setMessages([`Completed in ${r.duration_ms} ms`]);
        // Refresh the object tree after DDL.
        if (ev.statements.some((x) => ['CREATE', 'ALTER', 'DROP', 'RENAME'].includes(x.verb))) void useApp.getState().loadObjects(s.session_id, s.activeSchema);
      } catch (e) {
        const msg = e instanceof IpcError ? `${e.err.message}${e.err.code ? ` [${e.err.code}]` : ''}${e.err.hint ? `\nHint: ${e.err.hint}` : ''}` : errMsg(e);
        setError(msg);
        // Highlight "at character N" positions.
        const m = /at character (\d+)/.exec(msg);
        if (m) {
          const pos = model.getPositionAt(full.indexOf(sql) + Number(m[1]) - 1);
          monaco.editor.setModelMarkers(model, 'db', [{ startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column + 5, message: msg, severity: monaco.MarkerSeverity.Error }]);
        }
      } finally {
        setRunning(null);
      }
    },
    [s, isRedis],
  );

  const cancel = () => {
    if (running) api.cancelQuery(running).catch(() => undefined);
  };
  const fmt = () => {
    const ed = editorRef.current;
    if (!ed || !s) return;
    try {
      ed.executeEdits('format', [{ range: ed.getModel()!.getFullModelRange(), text: formatSql(ed.getValue(), { language: formatterLang(s.config.engine) as never, tabWidth: Number(settings['editor.tabSize'] ?? 2), keywordCase: (settings['editor.keywordCase'] as 'upper') ?? 'upper' }) }]);
    } catch (e) {
      toast('error', errMsg(e));
    }
  };
  const minify = () => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.executeEdits('minify', [{ range: ed.getModel()!.getFullModelRange(), text: ed.getValue().replace(/--[^\n]*\n/g, ' ').replace(/\s+/g, ' ').trim() }]);
  };
  const explain = async (analyze: boolean) => {
    const ed = editorRef.current;
    if (!ed || !s) return;
    const sel = ed.getSelection();
    const sql = sel && !sel.isEmpty() ? ed.getModel()!.getValueInRange(sel) : ed.getValue();
    try {
      let rs;
      try {
        rs = await api.explainSql(s.session_id, sql.trim().replace(/;$/, ''), analyze);
      } catch (e) {
        if (e instanceof IpcError && e.kind === 'confirmation_required' && analyze) {
          const ev = await api.evaluateSql(s.session_id, `EXPLAIN ANALYZE ${sql.trim().replace(/;$/, '')}`);
          const c = await confirmDecision(ev.decision, { production: s.config.environment === 'production' });
          if (!c) return;
          rs = await api.explainSql(s.session_id, sql.trim().replace(/;$/, ''), true, c.token, c.typed);
        } else throw e;
      }
      setResults([{ statement_index: 0, sql_excerpt: analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN', result: rs, duration_ms: 0, notices: [] }]);
    } catch (e) {
      setError(errMsg(e));
    }
  };
  const saveSnippet = async () => {
    const name = await ask.text(t('query.saveSnippet'), t('query.snippetName'));
    if (!name) return;
    await api.saveSnippet({ id: '', name, sql: editorRef.current?.getValue() ?? '', folder: null, favorite: false, connection_id: s?.config.id ?? null, updated: '' });
    toast('ok', 'Snippet saved');
  };

  const onMount: OnMount = (ed) => {
    editorRef.current = ed;
    registerSqlCompletion();
    const K = monaco.KeyMod;
    const C = monaco.KeyCode;
    ed.addCommand(K.CtrlCmd | C.Enter, () => void run('selection'));
    ed.addCommand(K.CtrlCmd | K.Shift | C.Enter, () => void run('all'));
    ed.addCommand(K.CtrlCmd | K.Alt | C.KeyF, fmt);
    ed.addCommand(K.CtrlCmd | C.Period, () => void cancel());
    ed.onDidChangeModelContent(() => {
      monaco.editor.setModelMarkers(ed.getModel()!, 'db', []);
      updateTab(tab.id, { sql: ed.getValue() });
    });
    ed.focus();
  };

  const startDrag = (e: React.MouseEvent) => {
    const parent = (e.currentTarget as HTMLElement).parentElement!;
    const rect = parent.getBoundingClientRect();
    const move = (m: MouseEvent) => setSplit(Math.min(0.85, Math.max(0.15, (m.clientY - rect.top) / rect.height)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="toolbar" className="flex h-[36px] shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
        <button className="btn btn-primary h-6 px-2" onClick={() => run('selection')} disabled={!s || !!running} title="Run selection or current statement (⌘/Ctrl+Enter)"><Icon name="play" size={12} fill="currentColor" /> {t('query.run')}</button>
        <button className="btn h-6 px-2" onClick={() => run('all')} disabled={!s || !!running} title="⌘/Ctrl+Shift+Enter">{t('query.runAll')}</button>
        <button className="icon-btn h-6 w-6" onClick={cancel} disabled={!running} title={`${t('query.cancel')} (⌘/Ctrl+.)`} aria-label={t('query.cancel')}><Icon name="stop" size={13} /></button>
        {running && <Spinner label={t('query.running')} />}
        {!isRedis && (
          <>
            <span className="mx-1 h-4 border-l border-border" />
            <button className="btn btn-ghost h-6 px-2" onClick={fmt} title="⌘/Ctrl+Alt+F">{t('query.format')}</button>
            {s?.capabilities.explain && <button className="btn btn-ghost h-6 px-2" onClick={() => explain(false)}>{t('query.explain')}</button>}
            {s?.capabilities.explain_analyze && <button className="btn btn-ghost h-6 px-2" onClick={() => explain(true)}>{t('query.explainAnalyze')}</button>}
            <button className="btn btn-ghost h-6 px-2" onClick={minify}>{t('query.minify')}</button>
          </>
        )}
        <button className="btn btn-ghost ml-auto h-6 px-2" onClick={saveSnippet}><Icon name="star" size={13} /> {t('query.saveSnippet')}</button>
        {s ? <span className="text-[0.82rem] text-muted">{s.config.name}{s.activeSchema ? ` · ${s.activeSchema}` : ''}</span> : <span className="text-warn">{t('status.disconnected')}</span>}
      </div>
      {!s && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-[0.92rem]">
          <span>This query tab isn’t connected to a database.</span>
          {Object.values(sessions).length > 0 ? (
            <select className="input h-6 w-auto py-0" aria-label="Choose connection" value="" onChange={(e) => e.target.value && updateTab(tab.id, { sessionId: e.target.value })}>
              <option value="">Choose connection…</option>
              {Object.values(sessions).map((x) => <option key={x.session_id} value={x.session_id}>{x.config.name}</option>)}
            </select>
          ) : (
            <button className="btn btn-primary h-6" onClick={() => useApp.setState({ launcher: true })}>Open a connection</button>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <div style={{ flexBasis: `${split * 100}%` }} className="min-h-0 shrink-0">
          <Editor
            defaultLanguage={isRedis ? 'redis' : 'sql'}
            defaultValue={tab.sql ?? ''}
            theme={editorTheme}
            onMount={onMount}
            options={{
              fontSize: Number(settings['editor.fontSize'] ?? 13),
              tabSize: Number(settings['editor.tabSize'] ?? 2),
              wordWrap: settings['editor.wordWrap'] ? 'on' : 'off',
              minimap: { enabled: !!settings['editor.minimap'] },
              renderWhitespace: settings['editor.whitespace'] ? 'all' : 'none',
              lineNumbers: 'on',
              folding: true,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              accessibilitySupport: 'auto',
              fixedOverflowWidgets: true,
            }}
          />
        </div>
        <div role="separator" aria-orientation="horizontal" aria-label="Resize editor" tabIndex={0} className="h-1.5 shrink-0 cursor-row-resize bg-border hover:bg-accent"
          onMouseDown={startDrag}
          onKeyDown={(e) => { if (e.key === 'ArrowUp') setSplit((x) => Math.max(0.15, x - 0.05)); if (e.key === 'ArrowDown') setSplit((x) => Math.min(0.85, x + 0.05)); }} />
        <div className="min-h-0 flex-1">
          {error ? <div className="p-2"><ErrorBox error={error} /></div> : <Results results={results} messages={messages} />}
        </div>
      </div>
    </div>
  );
}
