import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/ipc';
import { draftProblem, groupResources, type RequestDraft } from '../lib/access';
import { currentProvider, useAccess } from '../lib/accessStore';
import type { AccessRequestView, AccessResource, AccessTargets } from '../lib/types';
import { useApp } from '../store';
import { ENGINE_LABELS } from './ConnectionDialog';
import { EngineBadge } from './EngineBadge';
import { Icon } from './icons';
import { Dialog, EnvBadge, ErrorBox, Spinner } from './ui';

const EMPTY: RequestDraft = { resourceId: '', access: 'read_only', databases: [], reason: '' };

/**
 * "Request access" side sheet: pick a database (grouped by environment), the access level,
 * the databases and a reason. The new request shows up at the top of My requests.
 */
export function RequestAccessSheet({ draft, onClose }: { draft?: RequestDraft; onClose: () => void }) {
  const { t } = useTranslation();
  const user = useAccess((s) => s.status?.user);
  const provider = useAccess(currentProvider);
  const providerId = provider?.id ?? '';
  const caps = provider?.capabilities;
  const [services, setServices] = useState<AccessResource[] | null>(null);
  const [form, setForm] = useState<RequestDraft>(draft ?? EMPTY);
  const [picking, setPicking] = useState(!draft?.resourceId);
  const [query, setQuery] = useState('');
  const [targets, setTargets] = useState<AccessTargets | null>(null);
  const [dbFilter, setDbFilter] = useState('');
  const [newDb, setNewDb] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const ids = { search: useId(), reason: useId(), access: useId(), dbs: useId(), newDb: useId() };
  const noManager = user?.request_blocked === 'no_approver';

  useEffect(() => {
    let live = true;
    api.accessListResources(providerId).then(
      (s) => {
        if (live) setServices(s);
      },
      (e) => {
        if (!live) return;
        setServices([]);
        setError(useAccess.getState().fail(e));
      },
    );
    return () => {
      live = false;
    };
  }, [providerId]);

  const service = services?.find((s) => s.id === form.resourceId) ?? null;

  useEffect(() => {
    if (!form.resourceId) return;
    let live = true;
    setTargets(null);
    api.accessResourceTargets(providerId, form.resourceId).then(
      (r) => {
        if (live) setTargets(r);
      },
      (e) => {
        if (live) setTargets({ targets: [], error: useAccess.getState().fail(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [providerId, form.resourceId]);

  // A pre-filled service that is no longer offered: fall back to the picker.
  useEffect(() => {
    if (services && form.resourceId && !service) setPicking(true);
  }, [services, form.resourceId, service]);

  const groups = useMemo(() => groupResources(services ?? [], query), [services, query]);
  const problem = draftProblem(form, newDb);
  const pick = (s: AccessResource) => {
    setForm((f) => ({ ...f, resourceId: s.id, access: s.access_levels.includes(f.access) ? f.access : (s.access_levels[0] ?? 'read_only'), databases: f.resourceId === s.id ? f.databases : [] }));
    setNewDb(null);
    setPicking(false);
  };
  const toggleDb = (d: string) => setForm((f) => ({ ...f, databases: f.databases.includes(d) ? f.databases.filter((x) => x !== d) : [...f.databases, d] }));

  const submit = async () => {
    setTouched(true);
    if (problem || noManager || !service) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.accessCreateRequest(providerId, {
        resource_id: form.resourceId,
        access: form.access,
        reason: form.reason.trim(),
        databases: newDb !== null ? [newDb.trim()] : form.databases,
        create_database: newDb !== null,
      });
      // Show it right away (filled in by the next refresh).
      const optimistic: AccessRequestView = {
        ...created,
        resource_name: created.resource_name || service.name,
        environment_name: created.environment_name || service.environment_name,
        environment: created.environment_name ? created.environment : service.environment,
        connection_id: null,
        connection_expired: false,
      };
      useAccess.setState((s) => ({ requests: [optimistic, ...(s.requests ?? []).filter((r) => r.id !== created.id)], accessTab: 'mine' }));
      useApp.getState().toast('ok', t('access.requestSent', { resource: service.name }));
      onClose();
      void useAccess.getState().refreshRequests().catch(() => undefined);
    } catch (e) {
      setError(useAccess.getState().fail(e));
    } finally {
      setBusy(false);
    }
  };

  const shownDbs = (targets?.targets ?? []).filter((d) => d.toLowerCase().includes(dbFilter.trim().toLowerCase()));
  const show = (p: typeof problem) => touched && problem === p;

  return (
    <Dialog
      sheet
      title={t('access.requestAccess')}
      icon={<Icon name="key" size={16} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={busy || noManager || services === null} onClick={() => void submit()}>
            {busy && <Spinner />} {t('access.submit')}
          </button>
        </>
      }
    >
      {noManager && <p role="alert" className="mb-3 rounded border border-warn/50 bg-warn/10 p-2 text-sm text-warn">{t('access.noManager')}</p>}
      <ErrorBox error={error} />

      <section className="mb-4" aria-labelledby={`${ids.search}-h`}>
        <h3 id={`${ids.search}-h`} className="label">{t('access.resource')}</h3>
        {service && !picking ? (
          <div className="flex items-center gap-2 rounded-lg border border-border p-2">
            <EngineBadge engine={service.engine} size={28} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium">{service.name}</span>
                <EnvBadge env={service.environment} />
              </div>
              <div className="truncate text-xs text-muted">{[service.environment_name, ENGINE_LABELS[service.engine], service.host].filter(Boolean).join(' · ')}</div>
            </div>
            <button className="btn h-7" onClick={() => setPicking(true)}>{t('access.change')}</button>
          </div>
        ) : services === null ? (
          <Spinner label={t('common.loading')} />
        ) : (
          <>
            <div className="relative mb-1.5">
              <Icon name="search" size={14} className="absolute start-2 top-1/2 -translate-y-1/2 text-muted" />
              <input id={ids.search} className="input w-full ps-7" placeholder={t('access.searchResources')} aria-label={t('access.searchResources')} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="max-h-[38vh] overflow-auto rounded-lg border border-border" role="radiogroup" aria-label={t('access.resource')}>
              {groups.length === 0 && <p className="p-3 text-center text-sm text-muted">{services.length === 0 ? t('access.noResources') : t('access.noResourceMatches')}</p>}
              {groups.map((g) => (
                <div key={g.environment} role="group" aria-label={g.environment}>
                  <div className="sticky top-0 flex items-center gap-1.5 bg-panel px-2 py-1 text-xs font-semibold text-muted">
                    <EnvBadge env={g.kind} /> <span>{g.environment}</span>
                  </div>
                  {g.resources.map((s) => (
                    <label key={s.id} className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-hover ${form.resourceId === s.id ? 'bg-accent/10' : ''}`}>
                      <input type="radio" name={`${ids.search}-svc`} className="shrink-0" checked={form.resourceId === s.id} onChange={() => pick(s)} />
                      <EngineBadge engine={s.engine} size={22} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{s.name}</span>
                        <span className="block truncate text-xs text-muted">{[ENGINE_LABELS[s.engine], s.host].filter(Boolean).join(' · ')}</span>
                      </span>
                      {form.resourceId === s.id && <Icon name="chevronRight" size={14} className="text-accent" />}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
        {show('resource') && <p className="mt-1 text-xs text-danger">{t('access.needResource')}</p>}
      </section>

      {service && !picking && (
        <>
          <fieldset className="mb-4">
            <legend className="label">{t('access.access')}</legend>
            <div className="grid grid-cols-2 gap-2">
              {service.access_levels.map((a) => (
                <label key={a} className={`flex cursor-pointer flex-col rounded-lg border p-2 text-sm ${form.access === a ? 'border-accent bg-accent/10' : 'border-border hover:bg-hover'}`}>
                  <span className="flex items-center gap-2 font-medium">
                    <input type="radio" name={ids.access} checked={form.access === a} onChange={() => setForm((f) => ({ ...f, access: a }))} />
                    {a === 'read_only' ? t('access.readOnly') : t('access.readWrite')}
                  </span>
                  <span className="ms-5 text-xs text-muted">{a === 'read_only' ? t('access.readOnlyHint') : t('access.readWriteHint')}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="mb-4">
            <legend className="label">{t('access.databases')}</legend>
            {newDb === null &&
              (targets === null ? (
                <Spinner label={t('access.loadingDatabases')} />
              ) : targets.error ? (
                <p className="text-sm text-muted">{t('access.databasesUnavailable', { error: targets.error ?? '' })}</p>
              ) : targets.targets.length === 0 ? (
                <p className="text-sm text-muted">{t('access.noDatabases')}</p>
              ) : (
                <>
                  {targets.targets.length > 8 && (
                    <input className="input mb-1.5 w-full" placeholder={t('access.filterDatabases')} aria-label={t('access.filterDatabases')} value={dbFilter} onChange={(e) => setDbFilter(e.target.value)} />
                  )}
                  <div className="max-h-44 overflow-auto rounded-lg border border-border p-1" id={ids.dbs}>
                    {shownDbs.map((d) => (
                      <label key={d} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-hover">
                        <input type="checkbox" checked={form.databases.includes(d)} onChange={() => toggleDb(d)} />
                        <span className="truncate font-mono text-[0.82rem]">{d}</span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{t('access.selectedCount', { count: form.databases.length })}</p>
                </>
              ))}
            {caps?.create_database && (
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={newDb !== null} onChange={(e) => setNewDb(e.target.checked ? '' : null)} />
                {t('access.createDatabase')}
              </label>
            )}
            {newDb !== null && (
              <div className="mt-1">
                <input id={ids.newDb} className="input w-full font-mono" aria-label={t('access.newDatabaseName')} placeholder={t('access.newDatabaseName')} value={newDb} onChange={(e) => setNewDb(e.target.value)} />
                <p className="mt-0.5 text-xs text-muted">{t('access.newDatabaseHint')}</p>
              </div>
            )}
            {show('databases') && <p className="mt-1 text-xs text-danger">{t('access.needDatabases')}</p>}
            {show('newDatabase') && <p className="mt-1 text-xs text-danger">{t('access.newDatabaseHint')}</p>}
          </fieldset>

          <div className="mb-3">
            <label className="label" htmlFor={ids.reason}>{t('access.reason')}</label>
            <textarea id={ids.reason} className="input h-24 w-full" required maxLength={2000} placeholder={t('access.reasonPlaceholder')} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
            {show('reason') && <p className="mt-1 text-xs text-danger">{t('access.needReason')}</p>}
          </div>

          <p className="flex items-start gap-1.5 text-xs text-muted">
            <Icon name="history" size={13} className="mt-px shrink-0" />
            {t('access.lifetime')}
          </p>
        </>
      )}
    </Dialog>
  );
}
