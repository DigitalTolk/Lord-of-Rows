import Editor from '@monaco-editor/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useEditorTheme } from '../lib/monaco';

/**
 * Popover anchored under its (relatively positioned) parent showing read-only
 * SQL in a small Monaco editor. Closes on Escape or a click outside.
 */
export function SqlPopover({ title, sql, loading, error, onClose, actions, align = 'center', label }: {
  title: string;
  sql: string;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  actions?: ReactNode;
  align?: 'left' | 'center' | 'right';
  label?: string;
}) {
  const theme = useEditorTheme();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer so the click that opened the popover doesn't close it.
    const h = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(h);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const pos = align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2';
  const lines = Math.min(16, Math.max(3, sql.split('\n').length + 1));
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label ?? title}
      className={`absolute top-full z-50 mt-1.5 w-[min(640px,80vw)] rounded-lg border border-border bg-raised p-2 shadow-xl ${pos}`}
    >
      <div className="mb-1.5 flex items-center gap-2 px-0.5 text-[0.88rem] font-semibold">{title}</div>
      {error ? (
        <div className="rounded border border-danger/40 bg-danger/10 p-2 text-sm text-danger">{error}</div>
      ) : (
        <div className="overflow-hidden rounded border border-border" style={{ height: lines * 19 + 8 }} data-testid="sql-popover-editor">
          {loading ? (
            <div className="p-2 text-sm text-muted">…</div>
          ) : (
            <Editor
              language="sql"
              value={sql}
              theme={theme}
              options={{
                readOnly: true,
                domReadOnly: true,
                minimap: { enabled: false },
                lineNumbers: 'on',
                lineNumbersMinChars: 3,
                folding: false,
                wordWrap: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                fontSize: 12,
                renderLineHighlight: 'none',
                fixedOverflowWidgets: true,
              }}
            />
          )}
        </div>
      )}
      {/* Plain-text copy for assistive tech and tests (Monaco virtualises its DOM). */}
      <pre className="sr-only">{sql}</pre>
      {actions && <div className="mt-2 flex items-center justify-end gap-1.5">{actions}</div>}
    </div>
  );
}
