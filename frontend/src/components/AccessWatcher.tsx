import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import { durationLabel, expiringSoon, isInFlight, managedState, pollDelay, requestPhase } from '../lib/access';
import { canApprove, expiredListeners, readyListeners, useAccess } from '../lib/accessStore';
import { useApp } from '../store';

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Background access-provider work (renders nothing):
 * - polls my requests (every 5 s while the Access view is open or a request is pending /
 *   provisioning, every 60 s otherwise; backs off on errors) and approvals for approvers;
 * - tells the user when a request becomes ready;
 * - once a minute ends managed connections whose access time is over (no network) and
 *   warns 15 minutes before a managed connection's access ends.
 */
export function AccessWatcher() {
  const { t } = useTranslation();
  const warned = useRef(new Set<string>());
  const signedIn = useAccess((s) => !!s.status?.signed_in);
  const providerId = useAccess((s) => s.providerId);

  // Know whether we are signed in without opening the Access view.
  useEffect(() => {
    void useAccess.getState().loadProviders();
  }, []);

  useEffect(() => {
    const onReady = (rs: { resource_name: string }[]) => {
      for (const r of rs) useApp.getState().toast('ok', t('access.readyToast', { resource: r.resource_name }));
    };
    const onExpired = () => void useApp.getState().reloadConnections();
    readyListeners.add(onReady);
    expiredListeners.add(onExpired);
    return () => {
      readyListeners.delete(onReady);
      expiredListeners.delete(onExpired);
    };
  }, [t]);

  // Request polling while signed in.
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    let errors = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const st = useAccess.getState();
      try {
        const reqs = await st.refreshRequests();
        if (canApprove(st) && (st.visible > 0 || !st.approvals)) await st.refreshApprovals();
        errors = 0;
        if (!reqs) return; // signed out meanwhile
      } catch {
        errors += 1;
        if (!useAccess.getState().status?.signed_in) return;
      }
      if (!live) return;
      const now = nowSec();
      const s = useAccess.getState();
      const inFlight = (s.requests ?? []).some((r) => isInFlight(requestPhase(r, now)));
      timer = setTimeout(() => void tick(), pollDelay({ visible: s.visible > 0, inFlight, errors }));
    };
    timer = setTimeout(() => void tick(), 1000);
    // Opening the Access view polls sooner.
    const unsub = useAccess.subscribe((s, prev) => {
      if (s.visible > prev.visible) {
        clearTimeout(timer);
        timer = setTimeout(() => void tick(), 300);
      }
    });
    return () => {
      live = false;
      clearTimeout(timer);
      unsub();
    };
  }, [signedIn, providerId]);

  // Open connections whose access just ended: stop them gracefully (tabs are kept).
  useEffect(() => {
    const check = () => {
      const now = Math.floor(Date.now() / 1000);
      for (const s of Object.values(useApp.getState().sessions)) {
        if (!s.ended && managedState(s.config, now)?.expired) {
          void useApp.getState().endSession(s.session_id);
          useApp.getState().toast('info', t('access.endedToast', { name: s.config.name }));
        }
      }
    };
    const id = setInterval(check, 15_000);
    return () => clearInterval(id);
  }, [t]);

  // Local expiry: sweep + 15-minute warnings (works signed out and offline).
  useEffect(() => {
    const check = async () => {
      try {
        const ids = await api.accessSweep();
        if (ids.length) {
          await useApp.getState().reloadConnections();
          const names = useApp.getState().connections.filter((c) => ids.includes(c.config.id)).map((c) => c.config.name);
          for (const name of names) useApp.getState().toast('info', t('access.endedToast', { name }));
        }
      } catch {
        /* the next round retries */
      }
      const now = nowSec();
      for (const c of expiringSoon(useApp.getState().connections, now, warned.current)) {
        warned.current.add(c.id);
        const left = managedState(c, now)?.left;
        if (left) useApp.getState().toast('info', t('access.expiringToast', { name: c.name, time: t(durationLabel(left).key, durationLabel(left).vars) }));
      }
    };
    void check();
    const id = setInterval(() => void check(), 60_000);
    return () => clearInterval(id);
  }, [t]);

  return null;
}
