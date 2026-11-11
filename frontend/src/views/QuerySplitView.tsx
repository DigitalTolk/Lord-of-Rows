import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Tab } from '../store';
import { QueryView } from './QueryView';

/**
 * A query tab, optionally split into two editor panes (to the right or below).
 * Each pane is a full QueryView: its own text, its own run/cancel and its own
 * results. The first pane keeps the same element position whether or not the
 * tab is split, so splitting never remounts it (its editor and results survive).
 */
export function QuerySplitView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const [ratio, setRatio] = useState(0.5);
  const right = tab.split === 'right';

  const startDrag = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    const move = (m: MouseEvent) => {
      const r = right ? (m.clientX - rect.left) / rect.width : (m.clientY - rect.top) / rect.height;
      setRatio(Math.min(0.85, Math.max(0.15, r)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className={`flex h-full min-h-0 min-w-0 ${right ? 'flex-row' : 'flex-col'}`} data-split={tab.split ?? 'none'}>
      <section aria-label={t('split.pane', { n: 1 })} style={tab.split ? { flexBasis: `${ratio * 100}%` } : undefined} className={`min-h-0 min-w-0 ${tab.split ? 'shrink-0' : 'flex-1'}`}>
        <QueryView key="pane-0" tab={tab} pane={0} />
      </section>
      {tab.split && (
        <>
          <div
            role="separator"
            aria-orientation={right ? 'vertical' : 'horizontal'}
            aria-label={t('split.resize')}
            tabIndex={0}
            className={`shrink-0 bg-border hover:bg-accent ${right ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'}`}
            onMouseDown={startDrag}
            onKeyDown={(e) => {
              const less = right ? 'ArrowLeft' : 'ArrowUp';
              const more = right ? 'ArrowRight' : 'ArrowDown';
              if (e.key === less) setRatio((x) => Math.max(0.15, x - 0.05));
              if (e.key === more) setRatio((x) => Math.min(0.85, x + 0.05));
            }}
          />
          <section aria-label={t('split.pane', { n: 2 })} className="min-h-0 min-w-0 flex-1">
            <QueryView key="pane-1" tab={tab} pane={1} />
          </section>
        </>
      )}
    </div>
  );
}
