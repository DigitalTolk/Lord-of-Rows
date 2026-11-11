import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import { ageLabel, ageSeconds, draftFrom, errCode, durationLabel, envsPresent, HISTORY_PAGE, isEnded, isFiltered, matchesFilter, requestPhase, savedSegment, saveSegment, segmentCounts, segmentRequests, timeLeft, type ListFilter, type Segment } from '../lib/access';
import { canApprove, currentProvider, offerRequestAgain, useAccess } from '../lib/accessStore';
import type { AccessLevel, AccessProviderKind, AccessRequest, AccessRequestStatus, AccessRequestView, EnvironmentKind } from '../lib/types';
import { errMsg, useApp } from '../store';
import { ask } from './ask';
import { Icon } from './icons';
import { RequestAccessSheet } from './RequestAccessSheet';
import { RequestDrawer } from './RequestDrawer';
import { TicketChip } from './TicketChip';
import { FilterRow, SegmentTabs } from './RequestListControls';
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
      {status.signed_in && <AccessDialogs />}
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

const ADD = '__add';

/** Provider switcher (always shown, with the current provider's name) plus "Add provider…". */
function ProviderPicker({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  const providers = useAccess((s) => s.providers) ?? [];
  const id = useAccess((s) => s.providerId);
  return (
    <span className="inline-flex items-center gap-1">
      <select
        className="input h-7 max-w-[170px] py-0 text-[0.82rem]"
        aria-label={t('access.provider')}
        value={id ?? ''}
        onChange={(e) => {
          if (e.target.value === ADD) onAdd();
          else void useAccess.getState().selectProvider(e.target.value);
        }}
      >
        {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        <option value={ADD}>{t('access.addProviderOption')}</option>
      </select>
      <button type="button" className="icon-btn" aria-label={t('access.addAnother')} title={t('access.addAnother')} onClick={onAdd}>
        <Icon name="plus" size={14} />
      </button>
    </span>
  );
}

/** Inline "Add provider" form under the header. */
function AddProviderPanel({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="border-b border-border bg-panel px-3 py-3" aria-label={t('access.addAnother')}>
      <h3 className="label mx-auto max-w-[460px]">{t('access.addAnother')}</h3>
      <ProviderForm onDone={onDone} />
    </section>
  );
}

function SignedOut() {
  const { t } = useTranslation();
  const signingIn = useAccess((s) => s.signingIn);
  const notice = useAccess((s) => s.notice);
  const provider = useAccess(currentProvider);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const remove = async () => {
    if (!provider || !(await ask.confirm(t('access.removeProvider'), t('access.removeConfirm', { provider: provider.name }), true))) return;
    await useAccess.getState().removeProvider().catch((e) => useApp.getState().toast('error', errMsg(e)));
  };
  return (
    <div className="flex flex-1 flex-col justify-center gap-4 overflow-auto px-8 py-6">
      <Intro />
      {notice && <p role="alert" className="mx-auto max-w-[420px] rounded border border-warn/50 bg-warn/10 px-3 py-2 text-center text-sm text-warn">{notice}</p>}
      <div className="flex flex-col items-center gap-2">
        <ProviderPicker onAdd={() => { setAdding(true); setEditing(false); }} />
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
          {provider?.managed ? (
            <span data-managed-provider>{t('access.managedByOrg')}</span>
          ) : (
            <>
              <button className="text-accent underline-offset-2 hover:underline" aria-expanded={editing} onClick={() => { setEditing((v) => !v); setAdding(false); }}>{t('access.editProvider')}</button>
              {' · '}
              <button className="text-accent underline-offset-2 hover:underline" onClick={() => void remove()}>{t('access.removeProvider')}</button>
            </>
          )}
          {' · '}
          <button className="text-accent underline-offset-2 hover:underline" aria-expanded={adding} onClick={() => { setAdding((v) => !v); setEditing(false); }}>{t('access.addAnother')}</button>
        </p>
      </div>
      {editing && <ProviderForm key={`edit-${provider?.id}`} edit onDone={() => setEditing(false)} />}
      {adding && <ProviderForm key="add" onDone={() => setAdding(false)} />}
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
  const [adding, setAdding] = useState(false);
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
        </div>
        <ProviderPicker onAdd={() => setAdding(true)} />
        <button className="btn h-7" onClick={() => void useAccess.getState().signOut()}>{t('access.signOut')}</button>
      </div>
      {adding && <AddProviderPanel onDone={() => setAdding(false)} />}
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

/** Search text + environment chips shared by both lists. */
function useListFilter() {
  const [query, setQuery] = useState('');
  const [envs, setEnvs] = useState<Set<EnvironmentKind>>(() => new Set());
  const f: ListFilter = { query, envs };
  const toggleEnv = (e: EnvironmentKind) =>
    setEnvs((cur) => {
      const n = new Set(cur);
      if (n.has(e)) n.delete(e);
      else n.add(e);
      return n;
    });
  const clear = () => {
    setQuery('');
    setEnvs(new Set());
  };
  return { f, setQuery, toggleEnv, clear };
}

const SEGMENTS: Segment[] = ['active', 'pending', 'history'];

function MyRequests() {
  const { t } = useTranslation();
  const requests = useAccess((s) => s.requests);
  const providerId = useAccess((s) => s.providerId);
  const justReady = useAccess((s) => s.justReady);
  const now = useNow();
  const [segment, setSegment] = useState<Segment>(() => savedSegment(providerId));
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const { f, setQuery, toggleEnv, clear } = useListFilter();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setSegment(savedSegment(providerId));
  }, [providerId]);
  const choose = (s: Segment) => {
    setSegment(s);
    setLimit(HISTORY_PAGE);
    saveSegment(providerId, s);
  };

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
  const counts = segmentCounts(requests, now);
  const shown = segmentRequests(requests, segment, f, now);
  const page = segment === 'history' ? shown.slice(0, limit) : shown;
  const filtered = isFiltered(f);
  return (
    <>
      <FilterRow query={f.query} onQuery={setQuery} envs={f.envs} onToggleEnv={toggleEnv} available={envsPresent(requests)} onClear={clear} filtered={filtered} searchRef={searchRef}>
        <SegmentTabs value={segment} counts={counts} onChange={choose} segments={SEGMENTS} />
      </FilterRow>
      {shown.length === 0 ? (
        filtered ? (
          <NoMatches onClear={clear} />
        ) : (
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center text-muted" data-empty={segment}>
            <p>{t(`access.empty.${segment}`)}</p>
            {segment === 'active' && <button className="btn btn-primary mt-1" onClick={() => useAccess.setState({ sheet: {} })}>{t('access.requestAccess')}</button>}
          </div>
        )
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t(`access.seg.${segment}`)} data-segment-list={segment}>
          {page.map((r) => <RequestCard key={r.id} r={r} now={now} highlight={justReady.includes(r.id)} />)}
        </ul>
      )}
      {page.length < shown.length && (
        <div className="pt-2 text-center">
          <button className="btn h-7" onClick={() => setLimit((l) => l + HISTORY_PAGE)}>{t('access.showMore', { count: shown.length - page.length })}</button>
        </div>
      )}
    </>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center text-muted" data-empty="filtered">
      <p>{t('access.noMatches')}</p>
      <button className="btn h-7" onClick={onClear}>{t('access.clearFilters')}</button>
    </div>
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

function RequestCard({ r, now, highlight }: { r: AccessRequestView; now: number; highlight?: boolean }) {
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
    <li
      className={`rounded-lg border px-3 py-2 transition-shadow duration-700 ${ended ? 'border-border bg-panel/60 text-muted' : 'border-border bg-bg'} ${highlight ? 'border-ok/60 shadow-[0_0_0_3px_rgb(var(--ok)/0.25)]' : ''}`}
      data-phase={phase}
      data-highlight={highlight || undefined}
      aria-label={r.resource_name}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <button className="truncate font-medium hover:underline" title={t('access.showDetails')} onClick={() => useAccess.setState({ detail: { request: r, mode: 'mine' } })}>{r.resource_name || r.resource_id}</button>
        {r.environment_name && <EnvBadge env={r.environment} />}
        <AccessChip level={r.access} />
        <TicketChip ticket={r.ticket} />
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
          {phase === 'ready' && left && left.secs < 30 * 60 && (
            <button className="btn h-7" title={t('access.renewHint')} onClick={() => useAccess.setState({ sheet: { draft: draftFrom(r) } })}>{t('access.requestAgain')}</button>
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
      const cfg = useApp.getState().connections.find((c) => c.config.id === o.connection_id)?.config;
      if (cfg?.managed_by && /password|authentication|access_expired/i.test(`${errMsg(e)} ${errCode(e) ?? ''}`)) offerRequestAgain(cfg.managed_by, cfg.name, errMsg(e), t);
      else app.toast('error', errMsg(e));
    }
  } catch (e) {
    app.toast('error', useAccess.getState().fail(e));
  }
}

type ApprovalSegment = 'waiting' | 'decided';

function Approvals() {
  const caps = useAccess((s) => currentProvider(s)?.capabilities);
  const unavailable = useAccess((s) => s.decidedUnavailable);
  const waiting = useAccess((s) => s.approvals?.length ?? 0);
  const [seg, setSeg] = useState<ApprovalSegment>('waiting');
  const showDecided = !!caps?.decided_history && !unavailable;
  const tabs = showDecided ? <SegmentTabs<ApprovalSegment> value={seg} segments={['waiting', 'decided']} counts={{ waiting }} onChange={setSeg} /> : null;
  return showDecided && seg === 'decided' ? <DecidedApprovals tabs={tabs} /> : <WaitingApprovals tabs={tabs} />;
}

function WaitingApprovals({ tabs }: { tabs: React.ReactNode }) {
  const { t } = useTranslation();
  const approvals = useAccess((s) => s.approvals);
  const me = useAccess((s) => s.status?.user?.id);
  const now = useNow();
  const acting = useAccess((s) => s.acting);
  const { f, setQuery, toggleEnv, clear } = useListFilter();
  const searchRef = useRef<HTMLInputElement>(null);
  const who = requesterName;
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (approvals === null) return <div className="py-6 text-center"><Spinner label={t('common.loading')} /></div>;
  if (approvals.length === 0) {
    return (
      <>
        {tabs && <div className="pb-2">{tabs}</div>}
        <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted">
          <Icon name="shield" size={32} strokeWidth={1.2} />
          <p>{t('access.noApprovals')}</p>
        </div>
      </>
    );
  }
  const shown = approvals.filter((r) => matchesFilter(r, f));
  const chosen = approvals.filter((r) => selected.has(r.id) && r.requester.id !== me);
  const approveSelected = async () => {
    if (await approveMany(chosen, t)) setSelected(new Set());
  };
  return (
    <>
      <FilterRow query={f.query} onQuery={setQuery} envs={f.envs} onToggleEnv={toggleEnv} available={envsPresent(approvals)} onClear={clear} filtered={isFiltered(f)} searchRef={searchRef}>
        {tabs ?? <span className="text-xs text-muted">{t('access.waitingCount', { count: approvals.length })}</span>}
      </FilterRow>
      {chosen.length > 0 && (
        <div className="sticky top-0 z-10 mb-2 flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm" role="region" aria-label={t('access.selection')}>
          <span>{t('access.selectedCount', { count: chosen.length })}</span>
          <button className="btn h-7 ms-auto" onClick={() => setSelected(new Set())}>{t('access.clearSelection')}</button>
          <button className="btn btn-primary h-7" disabled={acting !== null} onClick={() => void approveSelected()}>{t('access.approveSelected', { count: chosen.length })}</button>
        </div>
      )}
      {shown.length === 0 && <NoMatches onClear={clear} />}
      <ul className="flex flex-col gap-2" aria-label={t('access.approvals')}>
        {shown.map((r) => {
          const own = !!me && r.requester.id === me;
          const age = ageLabel(ageSeconds(r.created_at, now * 1000));
          const dbs = r.databases.join(', ');
          return (
            <li key={r.id} className="rounded-lg border border-border px-3 py-2" aria-label={`${who(r)} · ${r.resource_name}`}>
              <div className="flex min-w-0 items-center gap-1.5">
                <input type="checkbox" className="shrink-0" aria-label={t('access.selectRequest', { name: who(r) })} disabled={own} checked={!own && selected.has(r.id)} onChange={() => toggle(r.id)} />
                <button className="truncate font-medium hover:underline" title={t('access.showDetails')} onClick={() => useAccess.setState({ detail: { request: r, mode: 'approval', actionable: !own } })}>{who(r)}</button>
                {r.requester.name && r.requester.email && <span className="truncate text-xs text-muted">{r.requester.email}</span>}
                <span className="ms-auto shrink-0 text-xs text-muted">{t(age.key, age.vars)}</span>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[0.84rem]">
                <span className="truncate">{r.resource_name}</span>
                {r.environment_name && <EnvBadge env={r.environment} />}
                <AccessChip level={r.access} />
                <TicketChip ticket={r.ticket} />
              </div>
              {dbs && <div className="truncate text-[0.82rem] text-muted" title={dbs}>{r.create_database ? t('access.newDatabase', { name: dbs }) : dbs}</div>}
              {r.reason && <p className="mt-1 break-words text-[0.84rem]"><q>{r.reason}</q></p>}
              <div className="mt-1.5 flex items-center justify-end gap-1.5">
                {own && <span className="me-auto text-xs text-muted">{t('access.ownRequest')}</span>}
                <button className="btn h-7" disabled={own || acting !== null} onClick={() => useAccess.setState({ rejecting: r })}>{t('access.reject')}</button>
                <button className="btn btn-primary h-7" disabled={own || acting !== null} onClick={() => void approveRequest(r, t)}>{acting === r.id ? <Spinner /> : null}{t('access.approve')}</button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Requests I approved or rejected (newest decision first), paged from the provider. */
function DecidedApprovals({ tabs }: { tabs: React.ReactNode }) {
  const { t } = useTranslation();
  const pid = useAccess((s) => s.providerId);
  const now = useNow();
  const [items, setItems] = useState<AccessRequest[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { f, setQuery, toggleEnv, clear } = useListFilter();
  const searchRef = useRef<HTMLInputElement>(null);
  const load = async (cursor: string | null) => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    try {
      const page = await api.accessListDecided(pid, cursor, 50);
      setItems((cur) => (cursor ? [...(cur ?? []), ...page.items] : page.items));
      setNext(page.next ?? null);
    } catch (e) {
      if (errCode(e) === 'access_unsupported') useAccess.setState({ decidedUnavailable: true });
      else setError(useAccess.getState().fail(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(null);
  }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = items ?? [];
  const shown = list.filter((r) => matchesFilter(r, f));
  return (
    <>
      <FilterRow query={f.query} onQuery={setQuery} envs={f.envs} onToggleEnv={toggleEnv} available={envsPresent(list)} onClear={clear} filtered={isFiltered(f)} searchRef={searchRef}>
        {tabs}
      </FilterRow>
      <ErrorBox error={error} />
      {items === null ? (
        <div className="py-6 text-center"><Spinner label={t('common.loading')} /></div>
      ) : list.length === 0 ? (
        <p className="px-6 py-8 text-center text-muted">{t('access.noDecided')}</p>
      ) : shown.length === 0 ? (
        <NoMatches onClear={clear} />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('access.seg.decided')}>
          {shown.map((r) => <DecidedCard key={r.id} r={r} now={now} />)}
        </ul>
      )}
      {next && (
        <div className="pt-2 text-center">
          <button className="btn h-7" disabled={loading} onClick={() => void load(next)}>{loading ? <Spinner /> : null}{t('access.loadMore')}</button>
        </div>
      )}
    </>
  );
}

function DecidedCard({ r, now }: { r: AccessRequest; now: number }) {
  const { t } = useTranslation();
  const rejected = r.status === 'rejected';
  const later = !rejected && ['expired', 'revoked', 'cancelled', 'failed'].includes(requestPhase(r, now)) ? requestPhase(r, now) : null;
  const who = r.requester.name || r.requester.email || r.requester.id;
  const decided = r.decided_at ? ageLabel(ageSeconds(r.decided_at, now * 1000)) : null;
  const dbs = r.databases.join(', ');
  return (
    <li className="rounded-lg border border-border px-3 py-2" aria-label={`${who} · ${r.resource_name}`} data-outcome={rejected ? 'rejected' : 'approved'}>
      <div className="flex min-w-0 items-center gap-1.5">
        <button className="truncate font-medium hover:underline" title={t('access.showDetails')} onClick={() => useAccess.setState({ detail: { request: r, mode: 'approval' } })}>{who}</button>
        <span className={`inline-flex h-[18px] items-center rounded-full border px-1.5 text-[0.68rem] font-semibold ${rejected ? 'border-danger/50 text-danger' : 'border-ok/50 text-ok'}`}>
          {rejected ? t('access.outcomeRejected') : t('access.outcomeApproved')}
        </span>
        {later && <span className="text-xs text-muted">{t('access.nowState', { state: t(`access.phase.${later}`) })}</span>}
        {decided && <span className="ms-auto shrink-0 text-xs text-muted">{t('access.decidedAgo', { time: t(decided.key, decided.vars) })}</span>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[0.84rem]">
        <span className="truncate">{r.resource_name}</span>
        {r.environment_name && <EnvBadge env={r.environment} />}
        <AccessChip level={r.access} />
        <TicketChip ticket={r.ticket} />
      </div>
      {dbs && <div className="truncate text-[0.82rem] text-muted" title={dbs}>{dbs}</div>}
      {rejected && r.status_detail && <p className="mt-1 break-words text-xs"><q>{r.status_detail}</q></p>}
    </li>
  );
}

const requesterName = (r: AccessRequest) => r.requester.name || r.requester.email || r.requester.id;

/** Approve after a confirmation (from a card or the drawer). */
async function approveRequest(r: AccessRequest, t: (k: string, o?: Record<string, unknown>) => string): Promise<boolean> {
  const pid = useAccess.getState().providerId;
  if (!pid || !(await ask.confirm(t('access.approveTitle'), t('access.approveConfirm', { name: requesterName(r), resource: r.resource_name })))) return false;
  useAccess.setState({ acting: r.id });
  try {
    await api.accessApprove(pid, r.id);
    useApp.getState().toast('ok', t('access.approved'));
    await useAccess.getState().refreshApprovals();
    return true;
  } catch (e) {
    useApp.getState().toast('error', useAccess.getState().fail(e));
    return false;
  } finally {
    useAccess.setState({ acting: null });
  }
}

/** Approves several requests after one confirmation that lists them. Own requests are never included. */
async function approveMany(rs: AccessRequest[], t: (k: string, o?: Record<string, unknown>) => string): Promise<boolean> {
  const pid = useAccess.getState().providerId;
  if (!pid || rs.length === 0) return false;
  const lines = rs.map((r) => `• ${requesterName(r)} — ${r.resource_name}${r.databases.length ? ` (${r.databases.join(', ')})` : ''}`).join('\n');
  if (!(await ask.confirm(t('access.approveManyTitle', { count: rs.length }), lines))) return false;
  useAccess.setState({ acting: 'many' });
  const failed: string[] = [];
  for (const r of rs) {
    try {
      await api.accessApprove(pid, r.id);
    } catch (e) {
      failed.push(`${requesterName(r)}: ${useAccess.getState().fail(e)}`);
    }
  }
  useAccess.setState({ acting: null });
  const ok = rs.length - failed.length;
  if (ok) useApp.getState().toast('ok', t('access.approvedMany', { count: ok }));
  if (failed.length) useApp.getState().toast('error', failed.join('\n'));
  await useAccess.getState().refreshApprovals().catch(() => undefined);
  return failed.length === 0;
}

/** Detail drawer and reject dialog (store-driven, so other places can open them). */
function AccessDialogs() {
  const { t } = useTranslation();
  const detail = useAccess((s) => s.detail);
  const rejecting = useAccess((s) => s.rejecting);
  const acting = useAccess((s) => s.acting);
  const close = () => useAccess.setState({ detail: null });
  return (
    <>
      {detail && (
        <RequestDrawer
          key={detail.request.id}
          request={detail.request}
          mode={detail.mode}
          onClose={close}
          onConnect={(r) => void connectRequest(r, t)}
          actions={
            detail.mode === 'approval' && detail.actionable ? (
              <>
                <button className="btn me-auto" onClick={close}>{t('common.close')}</button>
                <button className="btn" disabled={acting !== null} onClick={() => useAccess.setState({ detail: null, rejecting: detail.request })}>{t('access.reject')}</button>
                <button className="btn btn-primary" disabled={acting !== null} onClick={() => void approveRequest(detail.request, t).then((ok) => ok && close())}>{t('access.approve')}</button>
              </>
            ) : detail.mode === 'approval' ? (
              <button className="btn" onClick={close}>{t('common.close')}</button>
            ) : undefined
          }
        />
      )}
      {rejecting && <RejectDialog r={rejecting} who={requesterName(rejecting)} onClose={() => useAccess.setState({ rejecting: null })} />}
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
