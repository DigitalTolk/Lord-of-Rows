// Load Monaco from the local bundle (no CDN; CSP forbids remote scripts) and
// register a schema-aware SQL completion provider.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { useLayoutEffect } from 'react';
import { monacoThemeFor, useResolvedTheme } from './theme';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
// Exposed for E2E tests (sets editor text); grants nothing the renderer doesn't already have.
(globalThis as unknown as { __monaco: typeof monaco }).__monaco = monaco;

export interface CompletionSource {
  tables: { name: string; schema?: string | null; kind: string }[];
  columns: Record<string, string[]>;
}

let source: CompletionSource = { tables: [], columns: {} };
export const setCompletionSource = (s: CompletionSource) => (source = s);

const KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'WITH', 'UNION ALL', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'RETURNING', 'EXPLAIN', 'BEGIN', 'COMMIT', 'ROLLBACK'];
const FUNCTIONS = ['count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'lower', 'upper', 'length', 'substring', 'trim', 'now', 'current_date', 'current_timestamp', 'date_trunc', 'extract', 'cast', 'round', 'abs', 'concat', 'json_extract', 'jsonb_build_object', 'array_agg', 'string_agg', 'row_number', 'rank', 'lag', 'lead'];

let registered = false;
export function registerSqlCompletion() {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model: monaco.editor.ITextModel, position: monaco.Position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const before = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, word.startColumn));
      const dot = before.match(/([A-Za-z_][\w$]*)\.$/);
      const K = monaco.languages.CompletionItemKind;
      if (dot) {
        // table.column or alias.column: resolve alias via "FROM table alias" in the text.
        const text = model.getValue();
        const alias = dot[1];
        const m = new RegExp(`([A-Za-z_][\\w$.]*)\\s+(?:AS\\s+)?${alias}\\b`, 'i').exec(text);
        const table = (m?.[1] ?? alias).split('.').pop()!;
        const cols = source.columns[table] ?? source.columns[alias] ?? [];
        if (cols.length) return { suggestions: cols.map((c) => ({ label: c, kind: K.Field, insertText: c, range })) };
        const schemaTables = source.tables.filter((t) => t.schema === alias);
        return { suggestions: schemaTables.map((t) => ({ label: t.name, kind: K.Class, insertText: t.name, range })) };
      }
      const suggestions: monaco.languages.CompletionItem[] = [
        ...source.tables.map((t) => ({ label: t.name, kind: t.kind === 'view' ? K.Interface : K.Class, detail: `${t.kind}${t.schema ? ' · ' + t.schema : ''}`, insertText: t.name, range })),
        ...Object.entries(source.columns).flatMap(([t, cs]) => cs.map((c) => ({ label: c, kind: K.Field, detail: t, insertText: c, range, sortText: 'z' + c }))),
        ...KEYWORDS.map((k) => ({ label: k, kind: K.Keyword, insertText: k, range, sortText: 'y' + k })),
        ...FUNCTIONS.map((f) => ({ label: f, kind: K.Function, insertText: `${f}($0)`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range, sortText: 'x' + f })),
        { label: 'sel', kind: K.Snippet, insertText: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition}\nLIMIT ${4:100};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, documentation: 'SELECT template', range },
        { label: 'ins', kind: K.Snippet, insertText: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range },
        { label: 'upd', kind: K.Snippet, insertText: 'UPDATE ${1:table}\nSET ${2:col} = ${3:value}\nWHERE ${4:condition};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range },
      ];
      return { suggestions };
    },
  });
}

// Editor themes derived from the app's CSS tokens so the editor shares the
// surrounding surface colour. Re-defined on every theme switch (tokens differ
// per theme) and applied globally, so every open editor follows live.
function token(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  const [r, g, b] = v.split(/\s+/).map(Number);
  if ([r, g, b].some((x) => !Number.isFinite(x))) return '';
  return '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
}

export function defineAppThemes() {
  const t = (n: string, alpha = '') => (token(n) ? token(n) + alpha : undefined);
  const colors = Object.fromEntries(
    Object.entries({
      'editor.background': t('bg'),
      'editor.foreground': t('fg'),
      'editorGutter.background': t('bg'),
      'editorLineNumber.foreground': t('muted', '99'),
      'editorLineNumber.activeForeground': t('fg'),
      'editor.lineHighlightBackground': t('hover', '80'),
      'editor.lineHighlightBorder': t('hover', '00'),
      'editor.selectionBackground': t('select', '4d'),
      'editor.inactiveSelectionBackground': t('select', '26'),
      'editorCursor.foreground': t('accent'),
      'editorWidget.background': t('raised'),
      'editorWidget.border': t('border'),
      'editorSuggestWidget.background': t('raised'),
      'editorSuggestWidget.border': t('border'),
      'editorSuggestWidget.selectedBackground': t('select', '33'),
      'editorHoverWidget.background': t('raised'),
      'editorHoverWidget.border': t('border'),
      'input.background': t('raised'),
      'input.border': t('border'),
      'focusBorder': t('accent', '99'),
      'scrollbarSlider.background': t('muted', '40'),
      'scrollbarSlider.hoverBackground': t('muted', '66'),
      'scrollbarSlider.activeBackground': t('muted', '80'),
    }).filter(([, v]) => !!v),
  ) as Record<string, string>;
  const dark = document.documentElement.classList.contains('dark');
  // Only the theme matching the current tokens gets the token colours; the
  // other keeps Monaco's defaults until it becomes active and is re-defined.
  monaco.editor.defineTheme('dbs-light', { base: 'vs', inherit: true, rules: [], colors: dark ? {} : colors });
  monaco.editor.defineTheme('dbs-dark', { base: 'vs-dark', inherit: true, rules: [], colors: dark ? colors : {} });
}

/** Re-derive the custom themes from the current tokens and switch all editors. */
export function applyEditorTheme(name: string) {
  defineAppThemes();
  monaco.editor.setTheme(name);
}

/**
 * Monaco theme name for the app's current theme. Follows live changes (setting
 * or OS) and re-applies globally before child editors update, so all open
 * editors switch together.
 */
export function useEditorTheme(): string {
  const resolved = useResolvedTheme();
  const name = monacoThemeFor(resolved);
  useLayoutEffect(() => {
    applyEditorTheme(name);
  }, [name]);
  return name;
}

export { monaco };
