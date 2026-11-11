// Keyboard-navigable context menu with submenus (WAI-ARIA menu pattern).
// Rendered in a portal with fixed positioning, kept inside the viewport, and
// closed on outside click, scroll, resize, window blur, Escape or Tab.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isMac } from '../lib/keys';
import { ariaShortcut, shortcutLabel } from '../lib/gridOps';

export interface MenuItem {
  id: string;
  label: string;
  /** Binding such as "Mod+Shift+C" (displayed per platform). */
  shortcut?: string;
  disabled?: boolean;
  /** Secondary text (e.g. why an item is disabled). */
  hint?: string;
  danger?: boolean;
  onSelect?: () => void;
  items?: MenuEntry[];
}
export type MenuEntry = MenuItem | { separator: true; id?: string };

const isItem = (e: MenuEntry): e is MenuItem => !('separator' in e);

interface Props {
  x: number;
  y: number;
  items: MenuEntry[];
  label: string;
  onClose: () => void;
  /** Open this submenu (by item id) immediately, with focus in it. */
  openSubmenu?: string;
}

/** Context menu root. Closing returns focus to whatever had it before. */
export function ContextMenu({ x, y, items, label, onClose, openSubmenu }: Props) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const inside = (t: EventTarget | null) => (t instanceof Element ? !!t.closest('[data-ctx-menu]') : t instanceof Node ? !!t.parentElement?.closest('[data-ctx-menu]') : false);
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) closeRef.current();
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) closeRef.current();
    };
    const close = () => {
      closeRef.current();
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);
  const [at] = useState({ x, y });
  return createPortal(<MenuPanel items={items} label={label} at={at} onClose={onClose} openSubmenu={openSubmenu} autoFocus />, document.body);
}

interface PanelProps {
  items: MenuEntry[];
  label: string;
  /** Root: the click point. Submenu: the parent item's rect. */
  at: { x: number; y: number } | DOMRect;
  onClose: () => void;
  /** Submenu only: close just this level (ArrowLeft / Escape). */
  onBack?: () => void;
  openSubmenu?: string;
  /** Take focus on open (root menu, keyboard-opened submenus). */
  autoFocus?: boolean;
  /** Start with the first enabled item active (keyboard-opened submenus). */
  activateFirst?: boolean;
}

function MenuPanel({ items, label, at, onClose, onBack, openSubmenu, autoFocus, activateFirst }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = items.map((e, i) => (isItem(e) && !e.disabled ? i : -1)).filter((i) => i >= 0);
  const initialSub = openSubmenu ? items.findIndex((e) => isItem(e) && e.id === openSubmenu && !e.disabled && !!e.items) : -1;
  const [active, setActive] = useState<number>(initialSub >= 0 ? initialSub : activateFirst ? (enabled[0] ?? -1) : -1);
  const [takeFocus, setTakeFocus] = useState(!!autoFocus);
  const [sub, setSub] = useState<{ index: number; focus: boolean } | null>(initialSub >= 0 ? { index: initialSub, focus: true } : null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Place inside the viewport: flip submenus to the left, shift up when needed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if ('width' in at) {
      left = at.right - 2;
      if (left + w > vw - 4) left = Math.max(4, at.left - w + 2);
      top = at.top - 5;
    } else {
      left = at.x;
      top = at.y;
      if (left + w > vw - 4) left = Math.max(4, vw - w - 4);
    }
    if (top + h > vh - 4) top = Math.max(4, vh - h - 4);
    setPos({ left, top });
  }, [at]);

  // Focus the active item (or the panel itself) whenever it changes.
  useEffect(() => {
    if (!takeFocus || sub?.focus) return;
    if (active >= 0) itemRefs.current[active]?.focus();
    else ref.current?.focus();
  }, [active, sub, takeFocus]);

  const move = (dir: 1 | -1) => {
    if (!enabled.length) return;
    const pos = enabled.indexOf(active);
    const next = pos < 0 ? (dir === 1 ? enabled[0] : enabled[enabled.length - 1]) : enabled[(pos + dir + enabled.length) % enabled.length];
    setSub(null);
    setActive(next);
  };

  const activate = (i: number, viaKeyboard: boolean) => {
    const e = items[i];
    if (!isItem(e) || e.disabled) return;
    if (e.items) {
      setActive(i);
      setSub({ index: i, focus: viaKeyboard });
      return;
    }
    onClose();
    e.onSelect?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keys inside an open submenu are handled (and stopped) there.
    if (e.target !== ref.current && !itemRefs.current.includes(e.target as HTMLButtonElement)) return;
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        if (enabled.length) setActive(enabled[0]);
        break;
      case 'End':
        e.preventDefault();
        if (enabled.length) setActive(enabled[enabled.length - 1]);
        break;
      case 'ArrowRight': {
        e.preventDefault();
        const it = items[active];
        if (active >= 0 && isItem(it) && it.items) activate(active, true);
        break;
      }
      case 'ArrowLeft':
        e.preventDefault();
        onBack?.();
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (active >= 0) activate(active, true);
        break;
      case 'Escape':
        e.preventDefault();
        if (onBack) onBack();
        else onClose();
        break;
      case 'Tab':
        e.preventDefault();
        onClose();
        break;
      default: {
        // Type-ahead: jump to the next item starting with the typed letter.
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const ch = e.key.toLowerCase();
          const start = enabled.indexOf(active);
          const order = [...enabled.slice(start + 1), ...enabled.slice(0, start + 1)];
          const hit = order.find((i) => (items[i] as MenuItem).label.toLowerCase().startsWith(ch));
          if (hit !== undefined) setActive(hit);
        }
      }
    }
  };

  itemRefs.current = [];
  const subItem = sub ? items[sub.index] : undefined;
  return (
    <div
      ref={ref}
      data-ctx-menu
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[60] max-h-[calc(100vh-8px)] min-w-[13rem] max-w-[24rem] overflow-y-auto rounded-lg border border-border bg-raised p-1 font-sans text-[0.92rem] text-fg shadow-[0_10px_30px_rgb(var(--shadow)/0.22)] outline-none"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      {items.map((e, i) => {
        if (!isItem(e)) return <div key={e.id ?? `sep${i}`} role="separator" className="mx-1 my-1 border-t border-border" />;
        const isActive = i === active;
        const open = sub?.index === i;
        return (
          <button
            key={e.id}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-menu-id={e.id}
            aria-disabled={e.disabled || undefined}
            aria-haspopup={e.items ? 'menu' : undefined}
            aria-expanded={e.items ? open : undefined}
            aria-keyshortcuts={e.shortcut ? ariaShortcut(e.shortcut, isMac) : undefined}
            title={e.hint}
            onMouseEnter={() => {
              setTakeFocus(true);
              if (e.disabled) {
                setActive(-1);
                setSub(null);
                return;
              }
              setActive(i);
              setSub(e.items ? { index: i, focus: false } : null);
            }}
            onClick={() => activate(i, false)}
            className={`flex w-full select-none items-center gap-3 rounded-md px-2.5 py-[3px] text-left outline-none ${
              e.disabled ? 'cursor-default text-muted/60' : isActive || open ? 'bg-accent-solid text-on-solid' : e.danger ? 'text-danger' : ''
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{e.label}</span>
            {e.hint && !e.items && e.disabled && <span className="shrink-0 text-[0.8em] opacity-80">{e.hint}</span>}
            {e.shortcut && <span className={`shrink-0 font-mono text-[0.82em] ${isActive && !e.disabled ? 'opacity-90' : 'text-muted'}`}>{shortcutLabel(e.shortcut, isMac)}</span>}
            {e.items && <span aria-hidden className="shrink-0 text-[0.8em]">▸</span>}
          </button>
        );
      })}
      {sub && subItem && isItem(subItem) && subItem.items && (
        <SubPanel
          parent={() => itemRefs.current[sub.index]}
          items={subItem.items}
          label={subItem.label}
          focus={sub.focus}
          onClose={onClose}
          onBack={() => {
            setSub(null);
            setActive(sub.index);
            itemRefs.current[sub.index]?.focus();
          }}
        />
      )}
    </div>
  );
}

function SubPanel({ parent, items, label, focus, onClose, onBack }: { parent: () => HTMLButtonElement | null; items: MenuEntry[]; label: string; focus: boolean; onClose: () => void; onBack: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const el = parent();
    if (el) setRect(el.getBoundingClientRect());
  }, [parent]);
  if (!rect) return null;
  // Mouse-opened submenus don't steal focus until the pointer moves into them.
  return <MenuPanel items={items} label={label} at={rect} onClose={onClose} onBack={onBack} autoFocus={focus} activateFirst={focus} />;
}
