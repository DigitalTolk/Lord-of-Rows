import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './icons';

export interface MenuItem {
  key: string;
  label: string;
  danger?: boolean;
  /** Shows a check mark (current choice in a submenu). */
  checked?: boolean;
  /** Colour swatch before the label; `null` shows an empty swatch. */
  swatch?: string | null;
  disabled?: boolean;
  separatorBefore?: boolean;
  submenu?: MenuItem[];
  onSelect?: () => void;
}

const MENU_W = 200;

/** Popup menu at a point with one level of submenus, keyboard operable (arrows, Enter, Esc). */
export function ContextMenu({ x, y, items, label, onClose }: { x: number; y: number; items: MenuItem[]; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const prev = document.activeElement as HTMLElement | null;
    document.addEventListener('mousedown', down);
    ref.current?.querySelector<HTMLElement>('[role=menuitem]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('mousedown', down);
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [onClose]);
  const left = Math.max(4, Math.min(x, window.innerWidth - MENU_W - 8));
  const top = Math.max(4, Math.min(y, window.innerHeight - (items.length * 28 + 16)));
  return (
    <div ref={ref} className="fixed z-50" style={{ left, top }}>
      <MenuPanel items={items} label={label} onClose={onClose} openLeft={left + MENU_W * 2 + 8 > window.innerWidth} />
    </div>
  );
}

function MenuPanel({ items, label, onClose, onBack, openLeft }: { items: MenuItem[]; label: string; onClose: () => void; onBack?: () => void; openLeft: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const focusables = () => [...(panel.current?.querySelectorAll<HTMLElement>(':scope > div > [role=menuitem]:not([disabled])') ?? [])];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = focusables();
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (i === -1) return; // focus is inside a nested submenu, which handles it
      e.preventDefault();
      e.stopPropagation();
      els[(i + (e.key === 'ArrowDown' ? 1 : els.length - 1)) % els.length]?.focus();
    } else if (e.key === 'Escape' || (e.key === (document.documentElement.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft') && onBack)) {
      if (i === -1) return;
      e.preventDefault();
      e.stopPropagation();
      if (onBack) onBack();
      else onClose();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div ref={panel} role="menu" aria-label={label} onKeyDown={onKey} className="w-[200px] rounded-lg border border-border bg-raised p-1 shadow-xl" style={{ width: MENU_W }}>
      {items.map((it) => (
        <div key={it.key} className="relative">
          {it.separatorBefore && <div role="separator" className="my-1 border-t border-border" />}
          <button
            role="menuitem"
            disabled={it.disabled}
            aria-haspopup={it.submenu ? 'menu' : undefined}
            aria-expanded={it.submenu ? open === it.key : undefined}
            className={`menu-item flex items-center gap-2 disabled:opacity-45 ${it.danger ? 'text-danger' : ''}`}
            onMouseEnter={() => setOpen(it.submenu ? it.key : null)}
            onClick={() => {
              if (it.submenu) setOpen(open === it.key ? null : it.key);
              else {
                onClose();
                it.onSelect?.();
              }
            }}
            onKeyDown={(e) => {
              if (it.submenu && (e.key === (document.documentElement.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight') || e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                e.stopPropagation();
                const wrap = e.currentTarget.parentElement;
                setOpen(it.key);
                requestAnimationFrame(() => {
                  wrap?.querySelector<HTMLElement>('[role=menu] [role=menuitem]:not([disabled])')?.focus();
                });
              }
            }}
          >
            {it.swatch !== undefined && (
              <span className="h-3 w-3 shrink-0 rounded-full border border-border" style={it.swatch ? { background: it.swatch, borderColor: it.swatch } : undefined} aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.checked && <span aria-hidden>✓</span>}
            {it.submenu && <Icon name="chevronRight" size={13} className="rtl:rotate-180" />}
          </button>
          {it.submenu && open === it.key && (
            <div className={`absolute top-[-4px] z-10 ${openLeft ? 'end-full me-1' : 'start-full ms-1'}`}>
              <MenuPanel
                items={it.submenu}
                label={it.label}
                onClose={onClose}
                openLeft={openLeft}
                onBack={() => {
                  setOpen(null);
                  focusables().find((el) => el.getAttribute('aria-haspopup') && el.parentElement?.contains(document.activeElement))?.focus();
                }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
