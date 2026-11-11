import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { api } from '../lib/ipc';
import { buildItems, filterItems, moveIndex, type PickerItem, type PickerSection } from '../lib/openDatabase';
import { family } from '../lib/sqlgen';
import { errMsg, useApp, type OpenSession } from '../store';
import { ask } from './ask';
import { confirmDecision } from './confirm';
import { useOpenedSchemas } from './ConnectionRail';
import { Icon } from './icons';
import { Dialog, Spinner } from './ui';

/** Whether the "Open database" picker is showing (for the active session). */
export const useDbPicker = create<{ open: boolean }>(() => ({ open: false }));
export const openDatabasePicker = (open = true) => useDbPicker.setState({ open });

/** Mounts the picker for the active session while it is open (a fresh mount, so the list is reloaded every time). */
export function OpenDatabaseHost() {
  const open = useDbPicker((x) => x.open);
  const s = useApp((st) => (st.activeSession ? st.sessions[st.activeSession] : undefined));
  if (!open || !s) return null;
  return <OpenDatabaseDialog key={s.session_id} s={s} onClose={() => openDatabasePicker(false)} />;
}

/**
 * "Open database": search box, every database/schema of the connection
 * (system ones grouped at the bottom), Postgres also lists the server's other databases
 * (opened as a new session). ↑/↓ move, Enter / double-click open, Esc cancels.
 */
export function OpenDatabaseDialog({ s, onClose }: { s: OpenSession; onClose: () => void }) {
  const { t } = useTranslation();
  const fam = family(s.config.engine);
  const canCreate = fam === 'pg' || fam === 'mysql';
  const currentDb = s.server.current_database ?? s.config.database ?? null;
  const [schemas, setSchemas] = useState<string[]>(s.schemas);
  const [databases, setDatabases] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  // Keep the caret in the search box: the list load re-renders the dialog and WebKit can
  // leave focus on the toolbar button that opened it.
  useEffect(() => {
    if (loading) return;
    const el = searchRef.current;
    if (el && document.activeElement !== el && !el.closest('[role=dialog]')?.contains(document.activeElement)) el.focus();
  }, [loading]);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState<number | null>(null);
  const [want, setWant] = useState<string | null>(s.activeSchema);
  const baseId = useId();
  const optId = (i: number) => `${baseId}-opt-${i}`;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = s.capabilities.schemas ? await api.listSchemas(s.session_id) : [];
      setSchemas(list);
      useApp.setState((st) => {
        const cur = st.sessions[s.session_id];
        return cur ? { sessions: { ...st.sessions, [s.session_id]: { ...cur, schemas: list } } } : {};
      });
    } catch (e) {
      useApp.getState().toast('error', errMsg(e));
    }
    if (fam === 'pg') setDatabases(await api.listDatabases(s.session_id).catch(() => []));
    setLoading(false);
  }, [s.session_id, s.capabilities.schemas, fam]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const items = useMemo(() => buildItems(schemas, s.activeSchema, databases, currentDb), [schemas, s.activeSchema, databases, currentDb]);
  const shown = useMemo(() => filterItems(items, q), [items, q]);
  // Until the user moves, the highlighted row is the wanted one (current / just created), else the first.
  const wantIdx = shown.findIndex((x) => x.name === want && x.section !== 'other');
  const active = shown.length ? Math.min(idx ?? (wantIdx >= 0 ? wantIdx : 0), shown.length - 1) : -1;
  const sel = active >= 0 ? shown[active] : undefined;

  useEffect(() => {
    if (active >= 0) document.getElementById(optId(active))?.scrollIntoView?.({ block: 'nearest' });
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (it: PickerItem | undefined) => {
    if (!it) return;
    const st = useApp.getState();
    onClose();
    if (it.section === 'other') {
      try {
        await st.openSession(s.config.id, undefined, it.name);
      } catch (e) {
        const msg = errMsg(e);
        const pw = /password|authentication/i.test(msg) ? await ask.password(t('conn.password'), msg) : null;
        if (pw) await st.openSession(s.config.id, pw, it.name).catch((e2) => st.toast('error', errMsg(e2)));
        else st.toast('error', msg);
      }
      return;
    }
    const loaded = !!st.sessions[s.session_id]?.objects[it.name];
    st.setActiveSchema(s.session_id, it.name);
    useOpenedSchemas.getState().add(s.session_id, it.name);
    // setActiveSchema only loads an unseen schema; refresh the tree for one that was cached.
    if (loaded) void st.loadObjects(s.session_id, it.name).catch(() => undefined);
  };

  const create = async () => {
    const name = (await ask.text(t(fam === 'pg' ? 'openDb.newSchema' : 'openDb.newDatabase'), t('openDb.newHint')))?.trim();
    if (!name) return;
    try {
      const sql = await api.createDatabaseSql(s.session_id, name);
      const ev = await api.evaluateSql(s.session_id, sql);
      let token: string | null = null;
      let typed: string | undefined;
      if (ev.decision.decision !== 'allow') {
        const c = await confirmDecision(ev.decision, { production: s.config.environment === 'production', sqlPreview: sql });
        if (!c) return;
        token = c.token;
        typed = c.typed;
      }
      await api.runMigration(s.session_id, sql, token, typed);
      useApp.getState().toast('ok', t('openDb.created', { name }));
      setQ('');
      setIdx(null);
      setWant(name);
      await refresh();
    } catch (e) {
      useApp.getState().toast('error', errMsg(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const next = moveIndex(active, e.key, shown.length);
    if (next != null) {
      e.preventDefault();
      setIdx(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void open(sel);
    }
  };

  const sectionLabel: Record<PickerSection, string> = {
    user: fam === 'pg' && currentDb ? t('openDb.schemasIn', { db: currentDb }) : t('openDb.databases'),
    system: t('openDb.system'),
    other: t('openDb.otherDatabases'),
  };
  const groups = (['user', 'system', 'other'] as const).map((sec) => ({ sec, rows: shown.map((it, i) => ({ it, i })).filter((x) => x.it.section === sec) })).filter((g) => g.rows.length);

  return (
    <Dialog
      title={t('openDb.title')}
      onClose={onClose}
      icon={<Icon name="db" />}
      footer={
        <>
          {canCreate && <button className="btn me-auto" onClick={() => void create()}>{t('openDb.new')}</button>}
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!sel} onClick={() => void open(sel)}>{t('openDb.open')}</button>
        </>
      }
    >
      <div className="relative mb-2">
        <Icon name="search" size={13} className="absolute start-2 top-1/2 -translate-y-1/2 text-muted" />
        <input
          ref={searchRef}
          className="input h-8 ps-7"
          data-autofocus
          placeholder={t('openDb.search')}
          aria-label={t('openDb.search')}
          role="combobox"
          aria-expanded
          aria-autocomplete="list"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={active >= 0 ? optId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          value={q}
          onChange={(e) => { setQ(e.target.value); setIdx(null); }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div id={`${baseId}-list`} role="listbox" aria-label={t('openDb.results')} className="h-72 overflow-auto rounded-md border border-border bg-panel py-1">
        {loading && !items.length ? (
          <div role="presentation" className="flex justify-center py-6"><Spinner /></div>
        ) : !shown.length ? (
          <div role="option" aria-selected={false} aria-disabled className="px-3 py-6 text-center text-muted">{items.length ? t('openDb.noMatches') : t('openDb.none')}</div>
        ) : (
          groups.map(({ sec, rows }) => (
            <div key={sec} role="group" aria-label={sectionLabel[sec]} data-section={sec} className={sec === 'user' ? '' : 'mt-1 border-t border-border pt-1'}>
              <div aria-hidden className="section-title px-3 pb-0.5 pt-1">{sectionLabel[sec]}</div>
              {rows.map(({ it, i }) => (
                <div
                  key={`${sec}:${it.name}`}
                  id={optId(i)}
                  role="option"
                  aria-selected={i === active}
                  data-name={it.name}
                  title={it.name}
                  className={`mx-1 flex h-7 cursor-default items-center gap-2 rounded-md px-2 ${i === active ? 'row-selected' : 'hover:bg-hover'} ${sec === 'system' && i !== active ? 'text-muted' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setIdx(i)}
                  onDoubleClick={() => void open(it)}
                >
                  <Icon name="db" size={15} className={`shrink-0 ${sec === 'system' ? 'opacity-60' : ''}`} />
                  <span className={`truncate ${it.current ? 'font-semibold' : ''}`} dir="auto">{it.name}</span>
                  {it.current && <span className="ms-auto shrink-0 rounded border border-current px-1 text-[0.7rem] opacity-80">{t('openDb.current')}</span>}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}
