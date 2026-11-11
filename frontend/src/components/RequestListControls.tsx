import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { displayCombo, eventCombo } from '../lib/keys';
import type { Segment } from '../lib/access';
import type { EnvironmentKind } from '../lib/types';
import { Chip } from './ConnectionList';
import { Icon } from './icons';

/** Segments as a tablist (arrow keys / Home / End move and select), each with a count. */
export function SegmentTabs<S extends string = Segment>({ value, counts, onChange, segments }: { value: S; counts: Partial<Record<S, number | string>>; onChange: (s: S) => void; segments: S[] }) {
  const { t } = useTranslation();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = segments.indexOf(value);
    const rtl = document.documentElement.dir === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
    const next = step !== undefined ? segments[(i + step + segments.length) % segments.length] : e.key === 'Home' ? segments[0] : e.key === 'End' ? segments[segments.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="seg" role="tablist" aria-label={t('access.segments')} onKeyDown={onKeyDown}>
      {segments.map((s) => (
        <button key={s} ref={(el) => { refs.current[s] = el; }} role="tab" aria-selected={value === s} tabIndex={value === s ? 0 : -1} data-segment={s} onClick={() => onChange(s)}>
          {t(`access.seg.${s}`)}
          {counts[s] !== undefined && <span className={`ms-1.5 inline-flex min-w-[18px] justify-center rounded-full px-1 text-[0.7rem] font-semibold leading-[18px] ${value === s ? 'bg-accent/15 text-accent' : 'bg-hover text-muted'}`}>{counts[s]}</span>}
        </button>
      ))}
    </div>
  );
}

/** ⌘F / Ctrl+F focuses `ref` while mounted (the Access view has no other find). */
export function useFindShortcut(ref: RefObject<HTMLInputElement>) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (eventCombo(e) !== 'Mod+F' || !ref.current) return;
      e.preventDefault();
      e.stopPropagation();
      ref.current.focus();
      ref.current.select();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ref]);
}

/** Search field + environment chips (only environments present) + "Clear filters". */
export function FilterRow({
  query,
  onQuery,
  envs,
  onToggleEnv,
  available,
  onClear,
  filtered,
  searchRef,
  children,
}: {
  query: string;
  onQuery: (q: string) => void;
  envs: ReadonlySet<EnvironmentKind>;
  onToggleEnv: (e: EnvironmentKind) => void;
  available: EnvironmentKind[];
  onClear: () => void;
  filtered: boolean;
  searchRef: RefObject<HTMLInputElement>;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  useFindShortcut(searchRef);
  return (
    <div className="flex flex-col gap-1.5 pb-2">
      <div className="flex items-center gap-2">
        {children}
        <div className="relative ms-auto w-[min(220px,45%)]">
          <Icon name="search" size={13} className="absolute start-2 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={searchRef}
            type="search"
            className="input h-7 w-full ps-7 text-[0.84rem]"
            placeholder={t('access.searchRequests')}
            aria-label={t('access.searchRequests')}
            title={`${t('access.searchRequests')} (${displayCombo('Mod+F')})`}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                onQuery('');
              }
            }}
          />
        </div>
      </div>
      {(available.length > 1 || filtered) && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('access.envFilter')}>
          {available.map((env) => (
            <Chip key={env} env={env} pressed={envs.has(env)} onClick={() => onToggleEnv(env)}>
              {t(`connList.envShort.${env}`, { defaultValue: t(`env.${env}`) })}
            </Chip>
          ))}
          {filtered && (
            <button type="button" className="ms-1 text-[0.8rem] text-accent underline-offset-2 hover:underline" onClick={onClear}>
              {t('access.clearFilters')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
