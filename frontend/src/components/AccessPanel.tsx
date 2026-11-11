import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import { ageLabel, ageSeconds, draftFrom, durationLabel, isEnded, requestPhase, sortRequests, timeLeft } from '../lib/access';
import { canApprove, currentProvider, useAccess } from '../lib/accessStore';
import type { AccessLevel, AccessProviderKind, AccessRequest, AccessRequestStatus, AccessRequestView } from '../lib/types';
import { errMsg, useApp } from '../store';
import { ask } from './ask';
import { Icon } from './icons';
import { RequestAccessSheet } from './RequestAccessSheet';
import { Dialog, EnvBadge, ErrorBox, Spinner } from './ui';

const nowSec = () => Math.floor(Date.now() / 1000);

/** Re-renders every `ms` (countdowns). */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(nowSec);
  useEffect(() => {
    const id = setInterval(() => setNow(nowSec()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Launcher "Access" pane: sign in to an access provider, request time-limited database
 * access, follow the request, and connect once it is approved and provisioned.
 * Approvers also get an inbox when the provider supports it.
 */
export function AccessPanel() {
  const { t } = useTranslation();
  const providers = useAccess((s) => s.providers);
  const provider = useAccess(currentProvider);
  const status = useAccess((s) => s.status);
  const sheet = useAccess((s) => s.sheet);

  useEffect(() => {
    useAccess.setState((s) => ({ visible: s.visible + 1 }));
    void useAccess.getState().loadProviders().then(() => useAccess.getState().refreshStatus());
    return () => useAccess.setState((s) => ({ visible: Math.max(0, s.visible - 1) }));
  }, []);

  if (providers === null) return <Centered><Spinner label={t('common.loading')} /></Centered>;
  if (!provider) {
    return (
      <div className="flex flex-1 flex-col justify-center gap-4 overflow-auto px-8 py-6">
        <Intro />
        <ProviderForm />
      </div>
    );
  }
  if (!status) return <Centered><Spinner label={t('common.loading')} /></Centered>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!status.signed_in ? <SignedOut /> : <SignedIn />}
      {sheet && status.signed_in && <RequestAccessSheet draft={sheet.draft} onClose={() => useAccess.setState({ sheet: null })} />}
    </div>
  );
}

const Centered = ({ children }: { children: React.ReactNode }) => <div className="flex flex-1 items-center justify-center">{children}</div>;

function Intro() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent">
        <Icon name="key" size={24} />
      </span>
      <h2 className="text-lg font-semibold">{t('access.title')}</h2>
      <p className="max-w-[420px] text-sm text-muted">{t('access.intro')}</p>
    </div>
  );
}

/** Add a provider, or (with `edit`) change the selected one's name / URL. */
export function ProviderForm({ edit, onDone }: { edit?: boolean; onDone?: () => void }) {
  const { t } = useTranslation();
  const provider = useAccess(currentProvider);
  const [kinds, setKinds] = useState<AccessProviderKind[]>([]);
  const [kind, setKind] = useState(provider?.kind ?? '');
  const [name, setName] = useState(edit ? (provider?.name ?? '') : '');
  const [url, setUrl] = useState(edit ? (provider?.base_url ?? '') : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ids = { kind: useId(), name: useId(), url: useId() };

  useEffect(() => {
    api.accessProviderKinds().then(
      (k) => {
        setKinds(k);
        setKind((cur) => cur || k[0]?.kind || '');
        if (!edit) setName((cur) => cur || k[0]?.default_name || '');
      },
      (e) => setError(errMsg(e)),
    );
  }, [edit]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (edit) await useAccess.getState().updateProvider(name, url);
      else await useAccess.getState().addProvider(kind, name, url);
      useApp.getState().toast('ok', t('access.providerSaved'));
      onDone?.();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="mx-auto flex w-full max-w-[460px] flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!edit && kinds.length > 1 && (
        <div>
          <label className="label" htmlFor={ids.kind}>{t('access.providerKind')}</label>
          <select id={ids.kind} className="input w-full" value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </select>
        </div>
      )}
      <div>
        <label className="label" htmlFor={ids.name}>{t('access.providerName')}</label>
        <input id={ids.name} className="input w-full" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor={ids.url}>{t('access.providerUrl')}</label>
        <input id={ids.url} className="input w-full" type="url" inputMode="url" spellCheck={false} placeholder="https://access.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        <p className="mt-0.5 text-xs text-muted">{edit ? t('access.urlChangeHint') : t('access.urlHint')}</p>
      </div>
      <ErrorBox error={error} />
      <div className="flex justify-end gap-2">
        {onDone && <button type="button" className="btn" onClick={onDone}>{t('common.cancel')}</button>}
        <button type="submit" className="btn btn-primary" disabled={saving || !url.trim() || !name.trim() || !kind}>{edit ? t('common.save') : t('access.addProvider')}</button>
      </div>
    </form>
  );
}

/** Picker shown when more than one provider is configured. */
function ProviderPicker() {
  const { t } = useTranslation();
  const providers = useAccess((s) => s.providers) ?? [];
  const id = useAccess((s) => s.providerId);
  if (providers.length < 2) return null;
  return (
    <select className="input h-7 max-w-[160px] py-0 text-[0.82rem]" aria-label={t('access.provider')} value={id ?? ''} onChange={(e) => void useAccess.getState().selectProvider(e.target.value)}>
      {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

function SignedOut() {
  const { t } = useTranslation();
  const signingIn = useAccess((s) => s.signingIn);
  const notice = useAccess((s) => s.notice);
  const provider = useAccess(currentProvider);
  const [editing, setEditing] = useState(false);
  const remove = async () => {
    if (!provider || !(await ask.confirm(t('access.removeProvider'), t('access.removeConfirm', { provider: provider.name }), true))) return;
    await useAccess.getState().removeProvider().catch((e) => useApp.getState().toast('error', errMsg(e)));
  };
  return (
    <div className="flex flex-1 flex-col justify-center gap-4 overflow-auto px-8 py-6">
      <Intro />
      {notice && <p role="alert" className="mx-auto max-w-[420px] rounded border border-warn/50 bg-warn/10 px-3 py-2 text-center text-sm text-warn">{notice}</p>}
      <div className="flex flex-col items-center gap-2">
        <ProviderPicker />
        {signingIn ? (
          <div className="flex flex-col items-center gap-2" role="status">
            <Spinner label={t('access.waitingBrowser')} />
            <p className="max-w-[380px] text-center text-xs text-muted">{t('access.waitingBrowserHint')}</p>
            <button className="btn" onClick={() => void useAccess.getState().cancelSignIn()}>{t('common.cancel')}</button>
          </div>
        ) : (
          <button className="btn btn-primary h-9 px-4" data-autofocus onClick={() => void useAccess.getState().signIn()}>
            <Icon name="key" size={15} /> {t('access.signIn', { provider: provider?.name ?? '' })}
          </button>
        )}
        <p className="text-xs text-muted">
          {t('access.signInVia', { host: hostOf(provider?.base_url ?? '') })}{' '}
          <button className="text-accent underline-offset-2 hover:underline" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>{t('access.editProvider')}</button>
          {' · '}
          <button className="text-accent underline-offset-2 hover:underline" onClick={() => void remove()}>{t('access.removeProvider')}</button>
        </p>
      </div>
      {editing && <ProviderForm edit onDone={() => setEditing(false)} />}
    </div>
  );
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

function SignedIn() {
  const { t } = useTranslation();
  const status = useAccess((s) => s.status);
  const tab = useAccess((s) => s.accessTab);
  const approvals = useAccess((s) => s.approvals);
  const error = useAccess((s) => s.error);
  const approver = useAccess(canApprove);
  const provider = useAccess(currentProvider);
  const user = status?.user;
  const pending = approvals?.length ?? 0;
  const active = approver ? tab : 'mine';

  useEffect(() => {
    void useAccess.getState().refreshRequests().catch(() => undefined);
    if (approver) void useAccess.getState().refreshApprovals().catch(() => undefined);
  }, [approver, provider?.id]);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[0.8rem] font-semibold uppercase text-accent">
          {(user?.name || user?.email || '?').slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-medium">{user?.email || user?.name || t('access.signedIn')}</div>
          <div className="truncate text-xs text-muted">{provider?.name}</div>
        </div>
        <ProviderPicker />
        <button className="btn h-7" onClick={() => void useAccess.getState().signOut()}>{t('access.signOut')}</button>
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-[0.82rem] text-warn">
          <Icon name="warning" size={14} />
          <span className="min-w-0 flex-1">{error}</span>
          <button className="btn h-6" onClick={() => void Promise.allSettled([useAccess.getState().refreshStatus(), useAccess.getState().refreshRequests(), useAccess.getState().refreshApprovals()])}>{t('access.retry')}</button>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 pb-1 pt-2">
        {approver ? (
          <div className="seg" role="tablist" aria-label={t('access.title')}>
            <button role="tab" aria-selected={active === 'mine'} onClick={() => useAccess.setState({ accessTab: 'mine' })}>{t('access.myRequests')}</button>
            <button role="tab" aria-selected={active === 'approvals'} onClick={() => useAccess.setState({ accessTab: 'approvals' })}>
              {t('access.approvals')}
              {pending > 0 && <span className="ms-1.5 inline-flex min-w-[18px] justify-center rounded-full bg-accent-solid px-1 text-[0.7rem] font-semibold leading-[18px] text-on-solid" aria-label={t('access.pendingCount', { count: pending })}>{pending}</span>}
            </button>
          </div>
        ) : (
          <h2 className="text-sm font-semibold">{t('access.myRequests')}</h2>
        )}
        <button className="btn btn-primary ms-auto h-7" onClick={() => useAccess.setState({ sheet: {} })}>
          <Icon name="plus" size={14} /> {t('access.requestAccess')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 pt-1">{active === 'mine' ? <MyRequests /> : <Approvals />}</div>
    </>
  );
}

function MyRequests() {
  const { t } = useTranslation();
  const requests = useAccess((s) => s.requests);
  const now = useNow();
  if (requests === null) return <div className="py-6 text-center"><Spinner label={t('common.loading')} /></div>;
  if (requests.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <Icon name="key" size={32} strokeWidth={1.2} className="text-muted" />
        <p className="font-medium">{t('access.emptyTitle')}</p>
        <p className="max-w-[360px] text-sm text-muted">{t('access.emptyBody')}</p>
        <button className="btn btn-primary mt-1" onClick={() => useAccess.setState({ sheet: {} })}>{t('access.requestAccess')}</button>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2" aria-label={t('access.myRequests')}>
      {sortRequests(requests, now).map((r) => <RequestCard key={r.id} r={r} now={now} />)}
    </ul>
  );
}

const PHASE_DOT: Record<AccessRequestStatus, string> = {
  pending: 'bg-warn',
  provisioning: 'bg-accent',
  ready: 'bg-ok',
  failed: 'bg-danger',
  rejected: 'bg-danger',
  expired: 'bg-muted',
  revoked: 'bg-muted',
  cancelled: 'bg-muted',
};

function AccessChip({ level }: { level?: AccessLevel | null }) {
  const { t } = useTranslation();
  if (!level) return null;
  const rw = level === 'read_write';
  return (
    <span className={`inline-flex h-[18px] items-center rounded-full border px-1.5 text-[0.68rem] font-semibold ${rw ? 'border-warn/50 text-warn' : 'border-border text-muted'}`}>
      {rw ? t('access.readWrite') : t('access.readOnly')}
    </span>
  );
}

function RequestCard({ r, now }: { r: AccessRequestView; now: number }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const cancellable = useAccess((s) => !!currentProvider(s)?.capabilities.cancel);
  const phase = requestPhase(r, now);
  const ended = isEnded(phase);
  const dbs = r.databases.join(', ');
  const left = phase === 'ready' ? timeLeft(r.expires_at, now) : null;
  const age = ageLabel(ageSeconds(r.created_at, now * 1000));
  const approver = r.approver?.name || r.approver?.email;
  const logId = useId();

  const connect = async () => {
    setBusy(true);
    try {
      await connectRequest(r, t);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    const pid = useAccess.getState().providerId;
    if (!pid || !(await ask.confirm(t('access.cancelTitle'), t('access.cancelConfirm', { resource: r.resource_name }), true))) return;
    setBusy(true);
    try {
      await api.accessCancelRequest(pid, r.id);
      await useAccess.getState().refreshRequests();
      void useApp.getState().reloadConnections();
    } catch (e) {
      useApp.getState().toast('error', useAccess.getState().fail(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`rounded-lg border border-border px-3 py-2 ${ended ? 'bg-panel/60 text-muted' : 'bg-bg'}`} data-phase={phase} aria-label={r.resource_name}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-medium">{r.resource_name || r.resource_id}</span>
        {r.environment_name && <EnvBadge env={r.environment} />}
        <AccessChip level={r.access} />
        <span className="ms-auto shrink-0 text-xs text-muted">{t(age.key, age.vars)}</span>
      </div>
      {dbs && <div className="truncate text-[0.82rem] text-muted" title={dbs}>{r.create_database ? t('access.newDatabase', { name: dbs }) : dbs}</div>}
      <div className="mt-1.5 flex min-h-[28px] flex-wrap items-center gap-2 text-[0.84rem]">
        <span className="inline-flex items-center gap-1.5">
          {phase === 'provisioning' ? <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden /> : <span aria-hidden className={`h-2 w-2 rounded-full ${PHASE_DOT[phase]}`} />}
          <span className={phase === 'failed' || phase === 'rejected' ? 'text-danger' : phase === 'ready' ? 'font-medium text-ok' : ''}>
            {phase === 'pending' ? (approver ? t('access.waitingFor', { name: approver }) : t('access.waitingApproval')) : t(`access.phase.${phase}`)}
          </span>
        </span>
        {left && <span className="text-xs text-muted">{t('access.expiresIn', { time: t(durationLabel(left).key, durationLabel(left).vars) })}</span>}
        <span className="ms-auto flex items-center gap-1.5">
          {phase === 'pending' && cancellable && <button className="btn h-7" disabled={busy} onClick={() => void cancel()}>{t('access.cancelRequest')}</button>}
          {phase === 'provisioning' && (
            <button className="btn h-7" aria-expanded={showLog} aria-controls={logId} onClick={() => setShowLog((v) => !v)}>
              {showLog ? t('access.hideLog') : t('access.showLog')}
            </button>
          )}
          {phase === 'ready' && (
            <button className="btn btn-primary h-7" disabled={busy} onClick={() => void connect()}>
              {busy ? <Spinner /> : <Icon name="power" size={14} />} {r.connection_id && !r.connection_expired ? t('access.open') : t('access.connect')}
            </button>
          )}
          {ended && <button className="btn h-7" onClick={() => useAccess.setState({ sheet: { draft: draftFrom(r) } })}>{t('access.requestAgain')}</button>}
        </span>
      </div>
      {phase === 'failed' && r.status_detail && <p className="mt-1 break-words text-xs text-danger">{r.status_detail}</p>}
      {phase === 'rejected' && (
        <p className="mt-1 break-words text-xs">
          {approver ? t('access.rejectedBy', { name: approver }) : t('access.phase.rejected')}
          {r.status_detail && <>: <q>{r.status_detail}</q></>}
        </p>
      )}
      {showLog && phase === 'provisioning' && <ProvisioningLog id={logId} requestId={r.id} />}
    </li>
  );
}

/** Live progress log of a request (polled while shown). */
function ProvisioningLog({ id, requestId }: { id: string; requestId: string }) {
  const { t } = useTranslation();
  const [log, setLog] = useState<AccessRequest['log'] | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const pid = useAccess.getState().providerId;
      try {
        if (pid) {
          const r = await api.accessGetRequest(pid, requestId);
          if (!live) return;
          setLog(r.log);
          if (requestPhase(r, nowSec()) !== 'provisioning') void useAccess.getState().refreshRequests().catch(() => undefined);
        }
      } catch {
        /* keep the last log; the list shows connectivity problems */
      }
      if (live) timer = setTimeout(() => void tick(), 3000);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [requestId]);
  return (
    <div id={id} className="mt-2 max-h-40 overflow-auto rounded border border-border bg-panel p-2 font-mono text-[0.75rem]" role="log" aria-label={t('access.provisioningLog')} aria-live="polite">
      {log === null ? (
        <Spinner />
      ) : log.length === 0 ? (
        <span className="text-muted">{t('access.logEmpty')}</span>
      ) : (
        log.map((e, i) => (
          <div key={i} className={e.level === 'error' ? 'text-danger' : ''}>
            <span className="text-muted">{e.ts.slice(11, 19)}</span> {e.msg}
          </div>
        ))
      )}
    </div>
  );
}

/** Connect to a ready request: reuse its saved connection, or fetch the password once and save it. */
export async function connectRequest(r: Pick<AccessRequest, 'id'>, t: (k: string, o?: Record<string, unknown>) => string) {
  const app = useApp.getState();
  const pid = useAccess.getState().providerId;
  if (!pid) return;
  try {
    const check = await api.accessConnectCheck(pid, r.id);
    if (!check.reusable && check.reveals_remaining != null) {
      if (check.reveals_remaining === 0) {
        app.toast('error', t('access.noReveals'));
        return;
      }
      if (check.reveals_remaining <= 2 && !(await ask.confirm(t('access.revealTitle'), t('access.revealConfirm', { count: check.reveals_remaining })))) return;
    }
    const o = await api.accessConnect(pid, r.id);
    await app.reloadConnections();
    if (!o.reused) app.toast('ok', o.reveals_remaining != null ? t('access.savedReveals', { count: o.reveals_remaining }) : t('access.saved'));
    if (o.password_in_memory) app.toast('info', t('access.passwordInMemory'));
    void useAccess.getState().refreshRequests().catch(() => undefined);
    try {
      await app.openSession(o.connection_id);
    } catch (e) {
      app.toast('error', errMsg(e));
    }
  } catch (e) {
    app.toast('error', useAccess.getState().fail(e));
  }
}

function Approvals() {
  const { t } = useTranslation();
  const approvals = useAccess((s) => s.approvals);
  const me = useAccess((s) => s.status?.user?.id);
  const now = useNow();
  const [rejecting, setRejecting] = useState<AccessRequest | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const who = (r: AccessRequest) => r.requester.name || r.requester.email || r.requester.id;

  const approve = async (r: AccessRequest) => {
    const pid = useAccess.getState().providerId;
    if (!pid || !(await ask.confirm(t('access.approveTitle'), t('access.approveConfirm', { name: who(r), resource: r.resource_name })))) return;
    setActing(r.id);
    try {
      await api.accessApprove(pid, r.id);
      useApp.getState().toast('ok', t('access.approved'));
      await useAccess.getState().refreshApprovals();
    } catch (e) {
      useApp.getState().toast('error', useAccess.getState().fail(e));
    } finally {
      setActing(null);
    }
  };

  if (approvals === null) return <div className="py-6 text-center"><Spinner label={t('common.loading')} /></div>;
  if (approvals.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted">
        <Icon name="shield" size={32} strokeWidth={1.2} />
        <p>{t('access.noApprovals')}</p>
      </div>
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-2" aria-label={t('access.approvals')}>
        {approvals.map((r) => {
          const own = !!me && r.requester.id === me;
          const age = ageLabel(ageSeconds(r.created_at, now * 1000));
          const dbs = r.databases.join(', ');
          return (
            <li key={r.id} className="rounded-lg border border-border px-3 py-2" aria-label={`${who(r)} · ${r.resource_name}`}>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium">{who(r)}</span>
                {r.requester.name && r.requester.email && <span className="truncate text-xs text-muted">{r.requester.email}</span>}
                <span className="ms-auto shrink-0 text-xs text-muted">{t(age.key, age.vars)}</span>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[0.84rem]">
                <span className="truncate">{r.resource_name}</span>
                {r.environment_name && <EnvBadge env={r.environment} />}
                <AccessChip level={r.access} />
              </div>
              {dbs && <div className="truncate text-[0.82rem] text-muted" title={dbs}>{r.create_database ? t('access.newDatabase', { name: dbs }) : dbs}</div>}
              {r.reason && <p className="mt-1 break-words text-[0.84rem]"><q>{r.reason}</q></p>}
              <div className="mt-1.5 flex items-center justify-end gap-1.5">
                {own && <span className="me-auto text-xs text-muted">{t('access.ownRequest')}</span>}
                <button className="btn h-7" disabled={own || acting !== null} onClick={() => setRejecting(r)}>{t('access.reject')}</button>
                <button className="btn btn-primary h-7" disabled={own || acting !== null} onClick={() => void approve(r)}>{acting === r.id ? <Spinner /> : null}{t('access.approve')}</button>
              </div>
            </li>
          );
        })}
      </ul>
      {rejecting && <RejectDialog r={rejecting} who={who(rejecting)} onClose={() => setRejecting(null)} />}
    </>
  );
}

function RejectDialog({ r, who, onClose }: { r: AccessRequest; who: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const submit = async () => {
    const pid = useAccess.getState().providerId;
    if (!pid) return;
    setBusy(true);
    setError(null);
    try {
      await api.accessReject(pid, r.id, reason.trim());
      useApp.getState().toast('ok', t('access.rejected'));
      onClose();
      await useAccess.getState().refreshApprovals();
    } catch (e) {
      setError(useAccess.getState().fail(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('access.rejectTitle')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-danger" disabled={busy || !reason.trim()} onClick={() => void submit()}>{t('access.reject')}</button>
        </>
      }
    >
      <p className="mb-2 text-sm">{t('access.rejectIntro', { name: who, resource: r.resource_name })}</p>
      <label className="label" htmlFor={id}>{t('access.rejectReason')}</label>
      <textarea id={id} className="input h-24 w-full" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      <ErrorBox error={error} />
    </Dialog>
  );
}
