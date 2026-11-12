// Access-provider client state shared by the Access view, the request sheet and the
// background watcher. The UI works with one provider at a time (`providerId`).
import { create } from 'zustand';
import i18n from '../i18n';
import { api } from './ipc';
import { draftFrom, isSignedOutError, newlyReady } from './access';
import type { RequestDraft } from './access';
import type { AccessProviderInfo, AccessRequest, AccessRequestView, AccessStatus, ManagedBy } from './types';
import { useApp } from '../store';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nowSec = () => Math.floor(Date.now() / 1000);
const PICK_KEY = 'lotr.accessProvider';

interface AccessStore {
  providers: AccessProviderInfo[] | null;
  providerId: string | null;
  status: AccessStatus | null;
  /** A sign-in is waiting for the browser. */
  signingIn: boolean;
  requests: AccessRequestView[] | null;
  approvals: AccessRequest[] | null;
  /** Last list/refresh failure (e.g. provider unreachable). */
  error: string | null;
  /** Shown on the signed-out screen (session ended, sign-in failed). */
  notice: string | null;
  /** Launcher pane and Access sub-tab. */
  launcherTab: 'connections' | 'access';
  accessTab: 'mine' | 'approvals';
  /** Request-access sheet (with an optional pre-filled draft). */
  sheet: { draft?: RequestDraft } | null;
  /** How many Access views are on screen (fast polling while > 0). */
  visible: number;
  /** Requests that just became ready (highlighted once). */
  justReady: string[];
  /** The provider answered that it has no decision history (older server): hide Decided. */
  decidedUnavailable: boolean;
  /** Request detail drawer: my request, or one I approve / decided. */
  detail: { request: AccessRequest; mode: 'mine' | 'approval'; actionable?: boolean } | null;
  /** Reject dialog for an approval. */
  rejecting: AccessRequest | null;
  /** Approval being sent (buttons disabled). */
  acting: string | null;
  /** A deep-linked request to show once signed in. */
  linkRequest: string | null;

  loadProviders(): Promise<void>;
  selectProvider(id: string): Promise<void>;
  addProvider(kind: string, name: string, baseUrl: string): Promise<void>;
  updateProvider(name: string, baseUrl: string): Promise<void>;
  removeProvider(): Promise<void>;
  refreshStatus(): Promise<void>;
  refreshRequests(): Promise<AccessRequestView[] | null>;
  refreshApprovals(): Promise<void>;
  signIn(): Promise<void>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Handles a failed call: signed out → back to the sign-in screen. Returns the message. */
  fail(e: unknown): string;
  openAccess(draft?: RequestDraft): void;
}

/** Called when requests just became ready (the watcher notifies the user). */
export const readyListeners = new Set<(r: AccessRequestView[]) => void>();
/** Called with approvals that arrived since the last refresh. */
export const approvalListeners = new Set<(r: AccessRequest[]) => void>();
/** Called after managed connections were marked expired. */
export const expiredListeners = new Set<(ids: string[]) => void>();

const reset = { status: null, requests: null, approvals: null, error: null, notice: null, decidedUnavailable: false, detail: null };

export const useAccess = create<AccessStore>((set, get) => ({
  providers: null,
  providerId: null,
  ...reset,
  signingIn: false,
  launcherTab: 'connections',
  accessTab: 'mine',
  sheet: null,
  visible: 0,
  justReady: [],
  detail: null,
  rejecting: null,
  acting: null,
  linkRequest: null,

  async loadProviders() {
    try {
      const providers = await api.accessProviders();
      let pick = get().providerId;
      if (!pick || !providers.some((p) => p.id === pick)) {
        let saved: string | null = null;
        try {
          saved = localStorage.getItem(PICK_KEY);
        } catch {
          /* storage unavailable */
        }
        pick = providers.find((p) => p.id === saved)?.id ?? providers[0]?.id ?? null;
        set({ ...reset });
      }
      set({ providers, providerId: pick });
      if (pick && !get().status) await get().refreshStatus();
    } catch (e) {
      set({ providers: [], error: errText(e) });
    }
  },

  async selectProvider(id) {
    try {
      localStorage.setItem(PICK_KEY, id);
    } catch {
      /* storage unavailable */
    }
    set({ providerId: id, ...reset, accessTab: 'mine' });
    await get().refreshStatus();
  },

  async addProvider(kind, name, baseUrl) {
    const p = await api.accessAddProvider(kind, name, baseUrl);
    await get().loadProviders();
    await get().selectProvider(p.id);
  },

  async updateProvider(name, baseUrl) {
    const id = get().providerId;
    if (!id) return;
    await api.accessUpdateProvider(id, name, baseUrl);
    set({ ...reset });
    await get().loadProviders();
    await get().refreshStatus();
  },

  async removeProvider() {
    const id = get().providerId;
    if (!id) return;
    await api.accessRemoveProvider(id);
    set({ providerId: null, ...reset });
    await get().loadProviders();
  },

  async refreshStatus() {
    const id = get().providerId;
    if (!id) return;
    try {
      const status = await api.accessStatus(id);
      if (get().providerId !== id) return;
      const ended = !status.signed_in && status.error?.code === 'access_signed_out';
      set({ status, error: status.signed_in ? (status.error?.message ?? null) : null, ...(ended ? { notice: i18n.t('access.sessionEnded'), requests: null, approvals: null } : {}) });
    } catch (e) {
      set({ error: errText(e) });
    }
  },

  async refreshRequests() {
    const id = get().providerId;
    if (!id || !get().status?.signed_in) return null;
    try {
      const prev = get().requests;
      const list = await api.accessListRequests(id);
      if (get().providerId !== id) return null;
      set({ requests: list.requests, error: null });
      const ready = newlyReady(prev, list.requests, nowSec());
      if (ready.length) {
        readyListeners.forEach((f) => f(ready));
        const ids = ready.map((r) => r.id);
        set({ justReady: [...get().justReady, ...ids] });
        setTimeout(() => set({ justReady: get().justReady.filter((x) => !ids.includes(x)) }), 4000);
      }
      if (list.expired_connections.length) expiredListeners.forEach((f) => f(list.expired_connections));
      return list.requests;
    } catch (e) {
      get().fail(e);
      throw e;
    }
  },

  async refreshApprovals() {
    const id = get().providerId;
    if (!id || !canApprove(get())) return;
    try {
      const prev = get().approvals;
      const approvals = await api.accessListApprovals(id);
      if (get().providerId !== id) return;
      set({ approvals, error: null });
      if (prev) {
        const known = new Set(prev.map((r) => r.id));
        const fresh = approvals.filter((r) => !known.has(r.id));
        if (fresh.length) approvalListeners.forEach((f) => f(fresh));
      }
    } catch (e) {
      get().fail(e);
      throw e;
    }
  },

  async signIn() {
    const id = get().providerId;
    if (!id) return;
    set({ signingIn: true, notice: null, error: null });
    try {
      await api.accessSignIn(id);
      await get().refreshStatus();
      await Promise.allSettled([get().refreshRequests(), get().refreshApprovals()]);
      const linked = get().linkRequest;
      if (linked) {
        set({ linkRequest: null });
        await showLinkedRequest(id, linked);
      }
      void get().loadProviders();
    } catch (e) {
      const cancelled = !!e && typeof e === 'object' && 'kind' in e && (e as { kind: string }).kind === 'cancelled';
      if (!cancelled) set({ notice: errText(e) });
    } finally {
      set({ signingIn: false });
    }
  },

  async cancelSignIn() {
    const id = get().providerId;
    if (id) await api.accessCancelSignIn(id).catch(() => undefined);
  },

  async signOut() {
    const id = get().providerId;
    if (!id) return;
    await api.accessSignOut(id).catch(() => undefined);
    set({ ...reset, accessTab: 'mine' });
    await get().refreshStatus();
  },

  fail(e) {
    const msg = errText(e);
    if (isSignedOutError(e)) {
      const s = get().status;
      set({ status: s ? { ...s, signed_in: false, user: null } : s, requests: null, approvals: null, notice: i18n.t('access.sessionEnded'), error: null });
    } else set({ error: msg });
    return msg;
  },

  openAccess(draft) {
    set({ launcherTab: 'access', accessTab: 'mine', sheet: draft ? { draft } : get().sheet });
  },
}));

/** The selected provider. */
export const currentProvider = (s: Pick<AccessStore, 'providers' | 'providerId'>) => s.providers?.find((p) => p.id === s.providerId) ?? null;

/** Approvals are shown when the provider supports them and the user may approve. */
export const canApprove = (s: Pick<AccessStore, 'providers' | 'providerId' | 'status'>) => !!currentProvider(s)?.capabilities.approvals && !!s.status?.user?.can_approve;

/**
 * "Request again" for a managed connection: switch to its provider, open the launcher's
 * Access tab and the request sheet pre-filled from the original request (when known).
 */
export async function requestAgainFor(m: ManagedBy) {
  const st = () => useAccess.getState();
  if (st().providers === null) await st().loadProviders();
  if (m.provider_id !== st().providerId && st().providers?.some((p) => p.id === m.provider_id)) await st().selectProvider(m.provider_id);
  let r = st().requests?.find((x) => x.id === m.request_id);
  if (!r && st().status?.signed_in) {
    try {
      r = (await st().refreshRequests())?.find((x) => x.id === m.request_id);
    } catch {
      /* open an empty form */
    }
  }
  useAccess.setState({ launcherTab: 'access', accessTab: 'mine', sheet: { draft: r ? draftFrom(r) : undefined } });
  useApp.setState({ launcher: true });
}

/** Opens the launcher's Access tab (optionally a sub-tab or the request sheet). */
export function openAccessView(opts: { tab?: 'mine' | 'approvals'; sheet?: boolean } = {}) {
  useAccess.setState((s) => ({ launcherTab: 'access', accessTab: opts.tab ?? 'mine', sheet: opts.sheet ? (s.sheet ?? {}) : s.sheet }));
  useApp.setState({ launcher: true });
}

/** Command palette entries for access requests. */
export function accessCommands(t: (k: string) => string): { id: string; label: string; run: () => void }[] {
  const cmds = [
    { id: 'access-request', label: t('access.cmdRequest'), run: () => openAccessView({ sheet: true }) },
    { id: 'access-show', label: t('access.cmdShow'), run: () => openAccessView() },
  ];
  if (canApprove(useAccess.getState())) cmds.push({ id: 'access-approvals', label: t('access.cmdApprovals'), run: () => openAccessView({ tab: 'approvals' }) });
  return cmds;
}

/** A managed connection could not be opened (access ended / credentials rejected): offer a new request. */
export function offerRequestAgain(m: ManagedBy, name: string, message: string, t: (k: string, o?: Record<string, unknown>) => string) {
  useApp.getState().toast('error', `${t('access.connectFailedManaged', { name })}\n${message}`, { label: t('access.requestAgainCta'), run: () => void requestAgainFor(m) });
}

async function showLinkedRequest(providerId: string, requestId: string) {
  try {
    const r = await api.accessGetRequest(providerId, requestId);
    useAccess.setState({ detail: { request: r, mode: 'mine' } });
  } catch (e) {
    useApp.getState().toast('error', useAccess.getState().fail(e));
  }
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/**
 * Handles a pending `lordoftherows://access?provider=…&request=…` link: opens the Access tab
 * on that provider (an unknown provider is added only after `confirm`), and shows the request
 * once signed in. Never connects by itself.
 */
export async function handleDeepLink(confirm: (host: string) => Promise<boolean>) {
  let link;
  try {
    link = await api.accessTakeDeepLink();
  } catch {
    return; // nothing pending, or not running in the app
  }
  if (!link || typeof link.provider_url !== 'string' || !link.provider_url) return;
  const st = () => useAccess.getState();
  if (st().providers === null) await st().loadProviders();
  let pid = link.provider_id ?? st().providers?.find((p) => p.base_url === link.provider_url)?.id ?? null;
  if (!pid) {
    const host = hostOf(link.provider_url);
    if (!(await confirm(host))) return;
    await st().addProvider(link.kind, host, link.provider_url);
    pid = st().providerId;
  } else if (pid !== st().providerId) await st().selectProvider(pid);
  else if (!st().status) await st().refreshStatus();
  if (!pid) return;
  openAccessView();
  if (link.request_id) {
    if (st().status?.signed_in) await showLinkedRequest(pid, link.request_id);
    else useAccess.setState({ linkRequest: link.request_id });
  }
}
