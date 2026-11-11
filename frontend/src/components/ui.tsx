import { cloneElement, isValidElement, useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnvironmentKind } from '../lib/types';

export function Dialog({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Runs once per mount: set initial focus, trap Tab, restore focus on unmount.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusable = () => Array.from(el?.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? []).filter((x) => !x.hasAttribute('disabled'));
    const pick = () => (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('input:not([type=checkbox]):not([disabled]),textarea,select') ?? focusable()[0] ?? el)?.focus();
    pick();
    // WebKit can move focus back to the clicked opener after this effect; re-apply once painted.
    const raf = requestAnimationFrame(() => setTimeout(pick, 0));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
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
      cancelAnimationFrame(raf);
      el?.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/40">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`flex max-h-[90vh] flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-[0_20px_60px_rgb(var(--shadow)/0.25)] outline-none ${wide ? 'w-[min(980px,95vw)]' : 'w-[min(660px,95vw)]'}`}
      >
        <div className="flex h-11 shrink-0 items-center justify-between px-4">
          <h2 id={titleId} className="text-[1.05rem] font-semibold">{title}</h2>
          <button className="icon-btn" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}><span aria-hidden>✕</span></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-border bg-panel px-4 py-2.5">{footer}</div>}
      </div>
    </div>
  );
}

const envColors: Record<EnvironmentKind, string> = {
  local: 'bg-ok/15 text-ok border-ok/40',
  development: 'bg-accent/15 text-accent border-accent/40',
  testing: 'bg-purple/15 text-purple border-purple/40',
  staging: 'bg-warn/15 text-warn border-warn/40',
  production: 'bg-danger-solid text-on-solid border-danger-solid font-bold',
  custom: 'bg-panel text-muted border-border',
};

export function EnvBadge({ env }: { env: EnvironmentKind }) {
  const { t } = useTranslation();
  return <span className={`inline-flex h-[18px] items-center rounded-full border px-1.5 text-[0.68rem] font-semibold uppercase tracking-wide ${envColors[env]}`}>{t(`env.${env}`)}</span>;
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
  const { t } = useTranslation();
  return (
    <span role="status" className="inline-flex items-center gap-2 text-muted">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-transparent" aria-hidden />
      {label ? <span>{label}</span> : <span className="sr-only">{t('common.loading')}</span>}
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
  return <div role="toolbar" className="flex min-h-[38px] flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1">{children}</div>;
}

/**
 * Popup menu (context menus, dropdowns). Moves focus to the first item, supports
 * Arrow/Home/End/Escape/Tab, closes on outside click and returns focus to the opener.
 * Children should be `role="menuitem"` buttons (and separators).
 */
export function MenuPopup({ x, y, onClose, className = 'w-48', label, children }: { x?: number; y?: number; onClose: () => void; className?: string; label?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const onDown = (e: MouseEvent) => {
      if (el && !el.contains(e.target as Node)) closeRef.current();
    };
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      // Return focus to the opener unless the chosen action moved it somewhere meaningful.
      const a = document.activeElement;
      if (prev && prev.isConnected && (!a || a === document.body || !a.isConnected)) prev.focus();
    };
  }, []);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  const style = x != null && y != null && typeof window !== 'undefined' ? { left: Math.max(0, Math.min(x, window.innerWidth - 220)), top: Math.max(0, Math.min(y, window.innerHeight - 40)) } : undefined;
  return (
    <div ref={ref} role="menu" aria-label={label} className={`fixed z-50 rounded-lg border border-border bg-raised p-1 shadow-xl ${className}`} style={style} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

/** Position for a keyboard-opened context menu (Shift+F10 / ContextMenu key): just below the element. */
export function menuAnchor(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + 8, y: r.bottom };
}

/** True for the keys that open a context menu from the keyboard. */
export const isContextMenuKey = (e: { key: string; shiftKey: boolean }) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
