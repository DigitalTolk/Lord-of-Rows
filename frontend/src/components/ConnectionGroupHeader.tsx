import type { MouseEvent } from 'react';
import type { ConnectionGroup } from '../lib/types';
import { Icon } from './icons';

/**
 * Visual header of a collapsible group in the launcher's connection list.
 * Semantics live on the enclosing `role="group"` element in ConnectionList (focusable,
 * `aria-expanded`, labelled "name, N connections"): a button inside a listbox is invalid ARIA.
 */
export function ConnectionGroupHeader({
  group,
  count,
  expanded,
  dropTarget,
  onToggle,
  onContextMenu,
}: {
  group: ConnectionGroup;
  count: number;
  expanded: boolean;
  dropTarget: boolean;
  onToggle: () => void;
  onContextMenu: (e: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      aria-hidden
      onClick={onToggle}
      onContextMenu={onContextMenu}
      title={group.name}
      className={`group-head mx-2 mt-1 flex cursor-default select-none items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-hover ${dropTarget ? 'bg-accent/10 ring-2 ring-inset ring-accent' : ''}`}
    >
      <Icon name="chevronRight" size={13} className={`shrink-0 text-muted transition-transform ${expanded ? 'rotate-90' : 'rtl:rotate-180'}`} />
      <Icon name="folder" size={16} className={`shrink-0 ${group.color ? '' : 'text-muted'}`} style={group.color ? { color: group.color } : undefined} />
      <span className="min-w-0 truncate text-[0.9rem] font-semibold">{group.name}</span>
      <span className="ms-auto shrink-0 rounded-full bg-panel px-1.5 text-[0.75rem] tabular-nums text-muted">{count}</span>
    </div>
  );
}
