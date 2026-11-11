import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import { ageLabel, ageSeconds, draftFrom, durationLabel, requestPhase, timeLeft, timeline, type TimelineStep } from '../lib/access';
import { useAccess } from '../lib/accessStore';
import type { AccessConnectCheck, AccessRequest, AccessRequestView } from '../lib/types';
import { useApp } from '../store';
import { ENGINE_LABELS } from './ConnectionDialog';
import { Icon } from './icons';
import { Dialog, EnvBadge, Spinner } from './ui';
import { TicketChip } from './TicketChip';

const nowSec = () => Math.floor(Date.now() / 1000);

const DOT: Record<TimelineStep['state'], string> = {
  done: 'bg-ok border-ok',
  current: 'bg-accent border-accent animate-pulse',
  upcoming: 'bg-bg border-border',
  failed: 'bg-danger border-danger',
};

/**
 * Detail drawer for a request: timeline (requested → decided by whom and why → provisioned
 * → saved → expires), the provisioning log, reveals left and the connection details with
 * copy buttons (never the password). Approvers get requester, reason and scope.
 */
export function RequestDrawer({ request, mode, onClose, actions, onConnect }: { request: AccessRequest; mode: 'mine' | 'approval'; onClose: () => void; actions?: React.ReactNode; onConnect?: (r: AccessRequest) => void }) {
  const { t } = useTranslation();
  const pid = useAccess((s) => s.providerId);
  const [r, setR] = useState<AccessRequestView | AccessRequest>(request);
  const [check, setCheck] = useState<AccessConnectCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const now = nowSec();
  const phase = requestPhase(r, now);

  useEffect(() => {
    if (!pid) return;
    let live = true;
    api.accessGetRequest(pid, request.id).then(
      (full) => {
        if (live) setR(full);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [pid, request.id]);

  useEffect(() => {
    if (!pid || mode !== 'mine' || phase !== 'ready') return;
    let live = true;
    api.accessConnectCheck(pid, request.id).then(
      (c) => {
        if (live) setCheck(c);
      },
      (e) => {
        if (live) setCheckError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [pid, mode, phase, request.id]);

  const left = phase === 'ready' ? timeLeft(r.expires_at, now) : null;
  const when = (at: TimelineStep['at']) => {
    if (at == null) return null;
    if (typeof at === 'number') return new Date(at * 1000).toLocaleString();
    const a = ageLabel(ageSeconds(at, now * 1000));
    return t(a.key, a.vars);
  };
  const copy = (label: string, v: string) => {
    void navigator.clipboard?.writeText(v);
    useApp.getState().toast('info', t('access.copied', { what: label }));
  };
  const details = check?.details;

  return (
    <Dialog sheet title={r.resource_name || r.resource_id} icon={<Icon name="key" size={16} />} onClose={onClose} footer={actions ?? (
      <>
        <button className="btn" onClick={onClose}>{t('common.close')}</button>
        {mode === 'mine' && (
          <button className="btn" onClick={() => { useAccess.setState({ detail: null, sheet: { draft: draftFrom(r) } }); }}>{t('access.requestAgain')}</button>
        )}
        {mode === 'mine' && phase === 'ready' && onConnect && (
          <button className="btn btn-primary" onClick={() => { onClose(); onConnect(r); }}><Icon name="power" size={14} /> {'connection_id' in r && r.connection_id && !r.connection_expired ? t('access.open') : t('access.connect')}</button>
        )}
      </>
    )}>
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-sm">
        {r.environment_name && <EnvBadge env={r.environment} />}
        <span className="rounded-full border border-border px-1.5 text-[0.7rem] font-semibold">{r.access === 'read_write' ? t('access.readWrite') : t('access.readOnly')}</span>
        <TicketChip ticket={r.ticket} />
        <span className="text-muted">{t(`access.phase.${phase}`)}</span>
        {left && <span className="text-xs text-muted">· {t('access.expiresIn', { time: t(durationLabel(left).key, durationLabel(left).vars) })}</span>}
      </div>

      {mode === 'approval' && (
        <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">{t('access.requester')}</dt>
          <dd>{r.requester.name || r.requester.email}{r.requester.name && r.requester.email && <span className="text-muted"> · {r.requester.email}</span>}</dd>
          <dt className="text-muted">{t('access.databases')}</dt>
          <dd className="font-mono text-[0.82rem]">{r.create_database ? t('access.newDatabase', { name: r.databases.join(', ') }) : r.databases.join(', ') || '—'}</dd>
          <dt className="text-muted">{t('access.reason')}</dt>
          <dd className="break-words">{r.reason || '—'}</dd>
          {r.lifetime_hours != null && (
            <>
              <dt className="text-muted">{t('access.lifetimeLabel')}</dt>
              <dd>{t('access.lifetimeHours', { count: r.lifetime_hours })}</dd>
            </>
          )}
        </dl>
      )}

      <section aria-labelledby="req-timeline" className="mb-4">
        <h3 id="req-timeline" className="label">{t('access.timeline')}</h3>
        <ol className="relative ms-1.5 border-s border-border ps-4">
          {timeline(r, now).map((s) => (
            <li key={s.key} className="relative pb-3 last:pb-0" data-step={s.key} data-state={s.state}>
              <span aria-hidden className={`absolute -start-[1.32rem] top-1 h-2.5 w-2.5 rounded-full border-2 ${DOT[s.state]}`} />
              <div className="text-sm">
                <span className={s.state === 'failed' ? 'text-danger' : s.state === 'upcoming' ? 'text-muted' : ''}>{t(`access.step.${s.key}`)}</span>
                {s.by && <span className="text-muted"> · {t('access.byName', { name: s.by })}</span>}
                {when(s.at) && <span className="text-xs text-muted"> · {when(s.at)}</span>}
              </div>
              {s.note && <p className="break-words text-xs text-muted"><q>{s.note}</q></p>}
            </li>
          ))}
        </ol>
      </section>

      {r.log.length > 0 && (
        <section aria-labelledby="req-log" className="mb-4">
          <h3 id="req-log" className="label">{t('access.provisioningLog')}</h3>
          <div className="max-h-40 overflow-auto rounded border border-border bg-panel p-2 font-mono text-[0.75rem]" role="log">
            {r.log.map((e, i) => (
              <div key={i} className={e.level === 'error' ? 'text-danger' : ''}><span className="text-muted">{e.ts.slice(11, 19)}</span> {e.msg}</div>
            ))}
          </div>
        </section>
      )}

      {mode === 'mine' && phase === 'ready' && (
        <section aria-labelledby="req-conn">
          <h3 id="req-conn" className="label">{t('access.connectionDetails')}</h3>
          {!check && !checkError && <Spinner label={t('common.loading')} />}
          {checkError && <p className="text-xs text-muted">{checkError}</p>}
          {check && (
            <>
              <p className="mb-2 text-xs text-muted" data-reveals>
                {check.reusable ? t('access.passwordSaved') : check.reveals_remaining == null ? t('access.revealsUnlimited') : t('access.revealsLeft', { count: check.reveals_remaining })}
              </p>
              {details && (
                <dl className="grid grid-cols-[max-content_1fr_auto] items-center gap-x-3 gap-y-1 text-sm">
                  {([
                    ['engine', t('access.detailEngine'), ENGINE_LABELS[details.engine]],
                    ['host', t('access.detailHost'), details.host],
                    ['port', t('access.detailPort'), details.port != null ? String(details.port) : ''],
                    ['user', t('access.detailUser'), details.username],
                    ['database', t('access.detailDatabase'), details.database ?? ''],
                  ] as const)
                    .filter(([, , v]) => v)
                    .map(([k, label, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted">{label}</dt>
                        <dd className="truncate font-mono text-[0.82rem]" title={v}>{v}</dd>
                        {k === 'engine' ? <span /> : (
                          <button className="icon-btn h-6 w-6" aria-label={t('access.copyField', { what: label })} title={t('access.copyField', { what: label })} onClick={() => copy(label, v)}><Icon name="copy" size={13} /></button>
                        )}
                      </div>
                    ))}
                </dl>
              )}
            </>
          )}
        </section>
      )}
    </Dialog>
  );
}
