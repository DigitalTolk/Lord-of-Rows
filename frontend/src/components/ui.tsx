import { cloneElement, isValidElement, useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnvironmentKind } from '../lib/types';

export function Dialog({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusable = () => Array.from(el?.querySelectorAll<HTMLElement>('button,input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? []).filter((x) => !x.hasAttribute('disabled'));
    (focusable()[0] ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab') {
        const f = focusable();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    el?.addEventListener('keydown', onKey);
    return () => {
      el?.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`flex max-h-[90vh] flex-col rounded-lg border border-border bg-raised shadow-xl ${wide ? 'w-[min(1100px,95vw)]' : 'w-[min(640px,95vw)]'}`}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          <button className="btn btn-ghost" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-4 py-2">{footer}</div>}
      </div>
    </div>
  );
}

const envColors: Record<EnvironmentKind, string> = {
  local: 'bg-ok/15 text-ok border-ok/40',
  development: 'bg-accent/15 text-accent border-accent/40',
  testing: 'bg-accent/15 text-accent border-accent/40',
  staging: 'bg-warn/15 text-warn border-warn/40',
  production: 'bg-danger text-white border-danger font-bold',
  custom: 'bg-panel text-muted border-border',
};

export function EnvBadge({ env }: { env: EnvironmentKind }) {
  const { t } = useTranslation();
  return <span className={`rounded border px-1.5 text-[0.7rem] uppercase tracking-wide ${envColors[env]}`}>{t(`env.${env}`)}</span>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  return (
    <div className="mb-2">
      <label className="label" htmlFor={id}>{label}</label>
      <div id={id + '-wrap'} className="[&>*]:w-full">{withId(children, id)}</div>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

// Attach the generated id to the first child control so <label htmlFor> works.
function withId(children: ReactNode, id: string): ReactNode {
  if (isValidElement(children)) {
    const el = children as ReactElement<{ id?: string }>;
    return cloneElement(el, { id: el.props.id ?? id });
  }
  return children;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-muted">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-transparent" aria-hidden />
      {label && <span>{label}</span>}
    </span>
  );
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div role="alert" className="my-2 whitespace-pre-wrap rounded border border-danger/50 bg-danger/10 p-2 text-sm text-danger">
      {error}
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div role="toolbar" className="flex flex-wrap items-center gap-1 border-b border-border bg-panel px-2 py-1">{children}</div>;
}
