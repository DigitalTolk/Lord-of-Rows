import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import { fmtBytes, fmtNumber } from '../lib/format';
import { cellText, editsFor, prettyJson, VALUE_PAGE } from '../lib/redisKeys';
import type { KeyRow, KvEdit, Value, ValuePage } from '../lib/types';
import { errMsg } from '../store';
import { ask } from './ask';
import { Icon } from './icons';
import { highlightJson } from './RowDetailPanel';
import { Spinner } from './ui';

export interface RedisValuePanelProps {
  sessionId: string;
  db: string;
  /** Selected key (null: nothing or several rows selected). */
  row: KeyRow | null;
  selectedCount: number;
  editable: boolean;
  edits: KvEdit[];
  onStage: (e: KvEdit) => void;
  onUnstage: (e: KvEdit) => void;
  onClose: () => void;
  /** Bumped after a refresh/commit to reload the value. */
  reloadSeq: number;
}

/**
 * Right-hand panel of the key grid: the selected key's value by type
 * (string/JSON text, hash fields, list items, set members, sorted-set members with
 * scores, stream entries), loaded page by page ("Load more"). Edits are staged
 * (shown as commands in the Preview popover) and committed through the safety policy.
 */
export function RedisValuePanel(p: RedisValuePanelProps) {
  const { t } = useTranslation();
  const [pages, setPages] = useState<ValuePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const key = p.row?.key ?? null;

  const load = useCallback(
    async (more: ValuePage | null) => {
      if (key == null) return;
      setLoading(true);
      try {
        const page = await api.kvReadValue(p.sessionId, p.db, key, { cursor: more?.next ?? '', count: VALUE_PAGE });
        setPages(more ? { ...page, rows: [...more.rows, ...page.rows], text: page.text != null ? (more.text ?? '') + page.text : page.text } : page);
        setError(null);
      } catch (e) {
        setPages(null);
        setError(errMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [p.sessionId, p.db, key],
  );

  useEffect(() => {
    setPages(null);
    setEditing(null);
    void load(null);
  }, [load, p.reloadSeq]);

  if (!key || !p.row) {
    return (
      <aside aria-label={t('redis.valueTitle')} className="flex h-full min-h-0 w-full flex-col border-s border-border bg-panel">
        <Header title={t('redis.valueTitle')} onClose={p.onClose} />
        <p className="px-2 py-6 text-center text-muted">{p.selectedCount > 1 ? t('tableWs.rowsSelectedShort', { count: p.selectedCount, formatted: fmtNumber(p.selectedCount) }) : t('redis.noKeySelected')}</p>
      </aside>
    );
  }

  const v = pages;
  const kind = v?.kind ?? p.row.kind;
  const staged = editsFor(p.edits, key);
  const deleted = staged.some((e) => e.op === 'delete');
  const canEdit = p.editable && !deleted;
  const ttl = v?.ttl ?? p.row.ttl;
  const size = v?.size ?? p.row.size;
  const length = v?.length ?? p.row.length;

  const rename = async () => {
    const to = (await ask.text(t('redis.renamePrompt'), key))?.trim();
    if (to && to !== key) p.onStage({ op: 'rename', key, to });
  };
  const setTtl = async () => {
    const raw = (await ask.text(t('redis.ttlPrompt'), t('redis.ttlCurrent', { ttl: ttl < 0 ? t('redis.noExpiry') : `${ttl}s` })))?.trim();
    if (!raw) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n === 0 || n < -1) return setError(t('redis.ttlInvalid'));
    p.onStage({ op: 'expire', key, seconds: n });
  };
  const addField = async () => {
    const field = await ask.text(t('redis.fieldPrompt'));
    if (field == null || field === '') return;
    const value = await ask.text(t('redis.valuePrompt'), field);
    if (value != null) p.onStage({ op: 'hash_set', key, field, value });
  };
  const addMember = async () => {
    const value = await ask.text(kind === 'list' ? t('redis.valuePrompt') : t('redis.memberPrompt'));
    if (value == null || value === '') return;
    if (kind === 'list') return p.onStage({ op: 'list_push', key, value });
    if (kind === 'set') return p.onStage({ op: 'set_add', key, member: value });
    const score = Number((await ask.text(t('redis.scorePrompt'), value))?.trim());
    if (!Number.isFinite(score)) return setError(t('redis.scoreInvalid'));
    p.onStage({ op: 'zset_add', key, member: value, score });
  };
  const editCell = async (row: Value[]) => {
    const a = cellText(row[0]);
    const b = cellText(row[1]);
    if (kind === 'hash') {
      const value = await ask.text(t('redis.valuePrompt'), a);
      if (value != null && value !== b) p.onStage({ op: 'hash_set', key, field: a, value });
    } else if (kind === 'list') {
      const value = await ask.text(t('redis.valuePrompt'), `#${a}`);
      if (value != null && value !== b) p.onStage({ op: 'list_set', key, index: Number(a), value });
    } else if (kind === 'zset') {
      const score = Number((await ask.text(t('redis.scorePrompt'), a))?.trim());
      if (Number.isFinite(score)) p.onStage({ op: 'zset_add', key, member: a, score });
    }
  };
  const removeCell = (row: Value[]) => {
    const a = cellText(row[0]);
    if (kind === 'hash') p.onStage({ op: 'hash_delete', key, field: a });
    else if (kind === 'list') p.onStage({ op: 'list_remove', key, value: cellText(row[1]) });
    else if (kind === 'set') p.onStage({ op: 'set_remove', key, member: a });
    else if (kind === 'zset') p.onStage({ op: 'zset_remove', key, member: a });
  };
  const collection = ['hash', 'list', 'set', 'zset'].includes(kind);
  const text = v?.text ?? null;
  const json = text != null && !v?.next ? prettyJson(text) : null;

  return (
    <aside aria-label={t('redis.valueTitle')} className="flex h-full min-h-0 w-full flex-col border-s border-border bg-panel">
      <Header title={key} onClose={p.onClose} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-b border-border px-2 py-1.5 text-[0.82rem]">
        <dt className="text-muted">{t('redis.type')}</dt>
        <dd className="font-mono">{kind}</dd>
        <dt className="text-muted">{t('redis.ttl')}</dt>
        <dd className="font-mono">{ttl < 0 ? t('redis.noExpiry') : `${fmtNumber(ttl)} s`}</dd>
        {size != null && (
          <>
            <dt className="text-muted">{t('redis.size')}</dt>
            <dd className="font-mono">{fmtBytes(size)}</dd>
          </>
        )}
        {length != null && (
          <>
            <dt className="text-muted">{t('redis.length')}</dt>
            <dd className="font-mono">{fmtNumber(length)}</dd>
          </>
        )}
      </dl>
      {p.editable && (
        <div className="flex flex-wrap gap-1 border-b border-border px-2 py-1.5" role="toolbar" aria-label={t('redis.keyActions')}>
          <button className="btn h-6" disabled={!canEdit} onClick={() => void rename()}>{t('redis.rename')}</button>
          <button className="btn h-6" disabled={!canEdit} onClick={() => void setTtl()}>{t('redis.setTtl')}</button>
          {kind === 'hash' && <button className="btn h-6" disabled={!canEdit} onClick={() => void addField()}>{t('redis.addField')}</button>}
          {(kind === 'list' || kind === 'set' || kind === 'zset') && <button className="btn h-6" disabled={!canEdit} onClick={() => void addMember()}>{kind === 'list' ? t('redis.addItem') : t('redis.addMember')}</button>}
          <button className="btn h-6 text-danger" onClick={() => (deleted ? staged.filter((e) => e.op === 'delete').forEach(p.onUnstage) : p.onStage({ op: 'delete', key }))}>
            {deleted ? t('redis.undoDelete') : t('redis.deleteKey')}
          </button>
        </div>
      )}
      {!p.editable && <div className="border-b border-border px-2 py-1 text-[0.8rem] text-muted">{t('redis.readOnly')}</div>}
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {error && <div role="alert" className="mb-1 rounded bg-danger/10 px-2 py-1 text-[0.85rem] text-danger">{error}</div>}
        {!v && loading && <Spinner label={t('common.loading')} />}
        {v && text != null && (
          editing != null ? (
            <div>
              <textarea
                className="input min-h-[8rem] w-full resize-y py-1 font-mono text-[0.82rem]"
                aria-label={t('redis.valueEditor')}
                rows={Math.min(20, editing.split('\n').length + 1)}
                value={editing}
                autoFocus
                onChange={(e) => setEditing(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
              <div className="mt-1 flex justify-end gap-1">
                <button className="btn h-6" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
                <button className="btn btn-primary h-6" onClick={() => { p.onStage({ op: 'set_string', key, value: editing }); setEditing(null); }}>{t('redis.stage')}</button>
              </div>
            </div>
          ) : (
            <div className="group relative">
              <pre tabIndex={0} aria-label={t('redis.valueTitle')} className="selectable max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-bg p-1.5 font-mono text-[0.8rem] leading-[1.35]">
                {json ? highlightJson(json) : text}
              </pre>
              {canEdit && kind === 'string' && !v.next && (
                <button className="btn absolute end-1 top-1 h-6 opacity-0 focus:opacity-100 group-hover:opacity-100" onClick={() => setEditing(text)}>{t('redis.edit')}</button>
              )}
            </div>
          )
        )}
        {v && text == null && v.columns.length > 0 && (
          <table className="w-full border-collapse text-[0.82rem]" aria-label={t('redis.valueTitle')}>
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-border text-start">
                {v.columns.map((c) => <th key={c} className="px-1 py-0.5 text-start font-semibold">{c}</th>)}
                {canEdit && collection && <th className="w-12"><span className="sr-only">{t('redis.rowActions')}</span></th>}
              </tr>
            </thead>
            <tbody>
              {v.rows.map((r, i) => {
                const label = cellText(r[0]);
                return (
                  <tr key={i} className="border-b border-border/50 align-top hover:bg-hover">
                    {r.map((c, j) => (
                      <td key={j} className="max-w-[16rem] break-all px-1 py-0.5 font-mono" dir="auto">
                        {c.t === 'json' ? JSON.stringify(c.v) : cellText(c)}
                      </td>
                    ))}
                    {canEdit && collection && (
                      <td className="whitespace-nowrap px-0.5">
                        {kind !== 'set' && <button className="icon-btn h-5 w-5" aria-label={`${t('redis.edit')}: ${label}`} title={t('redis.edit')} onClick={() => void editCell(r)}><Icon name="edit" size={12} /></button>}
                        <button className="icon-btn h-5 w-5 text-danger" aria-label={`${t('redis.remove')}: ${label}`} title={t('redis.remove')} onClick={() => removeCell(r)}><Icon name="minus" size={12} /></button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {v?.next && (
          <button className="btn mt-1.5 h-7 w-full" disabled={loading} onClick={() => void load(v)}>
            {loading ? t('redis.loading') : t('redis.loadMoreShown', { count: v.text != null ? v.text.length : v.rows.length, formatted: fmtNumber(v.text != null ? v.text.length : v.rows.length) })}
          </button>
        )}
        {staged.length > 0 && (
          <div className="mt-2 rounded-md bg-warn/15 px-2 py-1 text-[0.8rem]">
            <div className="mb-0.5 font-semibold">{t('redis.stagedForKey', { count: staged.length, formatted: fmtNumber(staged.length) })}</div>
            <ul className="space-y-0.5">
              {staged.map((e, i) => (
                <li key={i} className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate font-mono">{e.op}{'field' in e ? ` ${e.field}` : 'member' in e ? ` ${e.member}` : 'to' in e ? ` → ${e.to}` : 'seconds' in e ? ` ${e.seconds}` : ''}</span>
                  <button className="icon-btn h-5 w-5" aria-label={t('redis.unstage')} title={t('redis.unstage')} onClick={() => p.onUnstage(e)}><Icon name="x" size={11} /></button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1 border-b border-border p-1.5">
      <span className="selectable min-w-0 flex-1 truncate font-mono text-[0.85rem] font-semibold" dir="auto" title={title}>{title}</span>
      <button className="icon-btn shrink-0" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}><Icon name="x" size={13} /></button>
    </div>
  );
}
