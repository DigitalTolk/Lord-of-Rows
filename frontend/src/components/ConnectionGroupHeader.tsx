import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionGroup } from '../lib/types';
import { Icon } from './icons';

/**
 * Collapsible group header in the launcher's connection list. Keyboard handling
 * (arrows, Enter/Space, ←/→ to collapse/expand) lives in ConnectionList.
 */
export function ConnectionGroupHeader({
  id,
  group,
  count,
  expanded,
  tabIndex,
  dropTarget,
  onToggle,
  onFocus,
  onContextMenu,
}: {
  id: string;
  group: ConnectionGroup;
  count: number;
  expanded: boolean;
  tabIndex: number;
  dropTarget: boolean;
  onToggle: () => void;
  onFocus: () => void;
  onContextMenu: (e: MouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      id={id}
      role="button"
      aria-expanded={expanded}
      aria-label={`${group.name}, ${t('connList.groupCount', { count })}`}
      tabIndex={tabIndex}
      data-nav={`g:${group.name}`}
      onClick={onToggle}
      onFocus={onFocus}
      onContextMenu={onContextMenu}
      title={group.name}
      className={`mx-2 mt-1 flex cursor-default select-none items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-hover ${dropTarget ? 'bg-accent/10 ring-2 ring-inset ring-accent' : ''}`}
    >
      <Icon name="chevronRight" size={13} className={`shrink-0 text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
      <Icon name="folder" size={16} className={`shrink-0 ${group.color ? '' : 'text-muted'}`} style={group.color ? { color: group.color } : undefined} />
      <span className="min-w-0 truncate text-[0.9rem] font-semibold">{group.name}</span>
      <span className="ml-auto shrink-0 rounded-full bg-panel px-1.5 text-[0.75rem] tabular-nums text-muted" aria-hidden>
        {count}
      </span>
    </div>
  );
}
