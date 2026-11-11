import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { api } from '../lib/ipc';
import { allState, defaultSelection, importable, rowTarget, toggleAll } from '../lib/importConnections';
import type { ConnImportDetected, ConnImportOptions, ConnImportPreview, ConnImportRequest, ConnImportResult, ConnImportRow } from '../lib/types';
import { errMsg, useApp } from '../store';
import { ENGINE_LABELS } from './ConnectionDialog';
import { Icon } from './icons';
import { Dialog, EnvBadge, ErrorBox, Spinner } from './ui';

/** Whether the "Import connections" dialog is showing. */
export const useImportDialog = create<{ open: boolean }>(() => ({ open: false }));
export const openImportDialog = (open = true) => useImportDialog.setState({ open });

/** Mounts the dialog while it is open (a fresh mount re-detects sources every time). */
export function ImportConnectionsHost() {
  const open = useImportDialog((x) => x.open);
  if (!open) return null;
  return <ImportConnectionsDialog onClose={() => openImportDialog(false)} />;
}

type Step = 'source' | 'preview' | 'result';

/**
 * Import connections from other database tools: pick a source (detected on this machine,
 * a file, or pasted URLs), review the rows, then import. Secrets never reach the webview.
 */
export function ImportConnectionsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('source');
  const [detected, setDetected] = useState<ConnImportDetected[] | null>(null);
  const [pasting, setPasting] = useState(false);
  const [urls, setUrls] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ConnImportPreview | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [opts, setOpts] = useState<ConnImportOptions>({ keep_groups: true, keep_environment: true, import_passwords: false });
  const [result, setResult] = useState<ConnImportResult | null>(null);
  const urlsId = useId();

  useEffect(() => {
    let live = true;
    api
      .importConnectionsDetect()
      .then((d) => {
        if (live) setDetected(d);
      })
      .catch(() => {
        if (live) setDetected([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const load = async (req: ConnImportRequest) => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.importConnectionsPreview(req);
      setPreview(p);
      setSel(defaultSelection(p.rows));
      // Nothing is read from another app's keychain until first connect, so bringing passwords along is the default.
      setOpts((o) => ({ ...o, import_passwords: true }));
      setStep('preview');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async () => {
    setError(null);
    try {
      const f = await api.pickFile(false, undefined, ['plist', 'json', 'xml', 'txt', 'tableplusconnection']);
      if (f) await load({ kind: 'file', grant: f.grant });
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const runImport = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.importConnectionsApply(preview.preview_id, [...sel], opts);
      setResult(r);
      setStep('result');
      await useApp.getState().reloadConnections();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const footer =
    step === 'preview' ? (
      <>
        <button className="btn me-auto" onClick={() => { setStep('source'); setError(null); }} disabled={busy}>{t('importConn.back')}</button>
        <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={busy || sel.size === 0} onClick={() => void runImport()}>
          {t('importConn.importCount', { count: sel.size })}
        </button>
      </>
    ) : step === 'result' ? (
      <button className="btn btn-primary" data-autofocus onClick={onClose}>{t('importConn.done')}</button>
    ) : (
      <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
    );

  return (
    <Dialog title={t('importConn.title')} onClose={onClose} footer={footer} wide icon={<Icon name="download" size={16} />}>
      <ErrorBox error={error} />
      {step === 'source' && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t('importConn.intro')}</p>
          <section aria-labelledby={`${urlsId}-found`}>
            <h3 id={`${urlsId}-found`} className="label">{t('importConn.foundHeading')}</h3>
            {detected === null ? (
              <Spinner label={t('importConn.detecting')} />
            ) : detected.length === 0 ? (
              <p className="text-sm text-muted">{t('importConn.noneFound')}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {detected.map((d) => (
                  <li key={d.source}>
                    <button className="btn h-9 w-full justify-start" disabled={busy || (!!d.error && d.count === 0)} onClick={() => void load({ kind: 'detected', source: d.source })}>
                      <Icon name="db" size={15} />
                      <span>{t('importConn.found', { source: d.label, count: d.count })}</span>
                      {d.error && <span className="ms-auto truncate text-xs text-danger">{d.error}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <div className="flex flex-wrap gap-2">
            <button className="btn" disabled={busy} onClick={() => void chooseFile()}><Icon name="folder" size={15} /> {t('importConn.chooseFile')}</button>
            <button className="btn" disabled={busy} aria-expanded={pasting} onClick={() => setPasting((p) => !p)}><Icon name="list" size={15} /> {t('importConn.pasteUrls')}</button>
          </div>
          <p className="text-xs text-muted">{t('importConn.fileHint')}</p>
          {pasting && (
            <div>
              <label className="label" htmlFor={urlsId}>{t('importConn.urlsLabel')}</label>
              <textarea
                id={urlsId}
                className="input h-32 w-full font-mono text-[0.82rem]"
                spellCheck={false}
                placeholder={'postgres://user@db.example.com:5432/app\nmysql://user@localhost/dev'}
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
              />
              <p className="mt-0.5 text-xs text-muted">{t('importConn.urlsHint')}</p>
              <button className="btn btn-primary mt-2" disabled={busy || !urls.trim()} onClick={() => void load({ kind: 'urls', text: urls })}>{t('importConn.previewUrls')}</button>
            </div>
          )}
          {busy && <Spinner label={t('importConn.reading')} />}
        </div>
      )}
      {step === 'preview' && preview && <PreviewStep preview={preview} sel={sel} setSel={setSel} opts={opts} setOpts={setOpts} />}
      {step === 'result' && result && <ResultStep result={result} />}
    </Dialog>
  );
}

function PreviewStep({ preview, sel, setSel, opts, setOpts }: { preview: ConnImportPreview; sel: Set<string>; setSel: (s: Set<string>) => void; opts: ConnImportOptions; setOpts: (o: ConnImportOptions) => void }) {
  const { t } = useTranslation();
  const rows = preview.rows;
  const all = allState(rows, sel);
  const counts = useMemo(() => ({ total: rows.length, ready: rows.filter((r) => r.status === 'ready').length, exists: rows.filter((r) => r.status === 'exists').length, skipped: rows.filter((r) => !importable(r)).length }), [rows]);
  const hasPasswords = rows.some((r) => r.password !== 'none');
  const toggle = (k: string) => {
    const n = new Set(sel);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setSel(n);
  };
  const check = (key: keyof ConnImportOptions, label: string, hint?: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5" checked={opts[key]} onChange={(e) => setOpts({ ...opts, [key]: e.target.checked })} />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm" role="status">
        {t('importConn.summary', { source: preview.label, count: counts.total })} · {t('importConn.readyCount', { count: counts.ready })}
        {counts.exists > 0 && <> · {t('importConn.existsCount', { count: counts.exists })}</>}
        {counts.skipped > 0 && <> · {t('importConn.skippedCount', { count: counts.skipped })}</>}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{t('importConn.empty')}</p>
      ) : (
        <div className="max-h-[46vh] overflow-auto rounded border border-border">
          <table className="w-full text-[0.84rem]">
            <caption className="sr-only">{t('importConn.tableCaption', { source: preview.label })}</caption>
            <thead className="sticky top-0 bg-panel text-start text-xs text-muted">
              <tr>
                <th scope="col" className="w-8 px-2 py-1.5">
                  <input
                    type="checkbox"
                    aria-label={t('importConn.selectAll')}
                    checked={all === 'all'}
                    ref={(el) => {
                      if (el) el.indeterminate = all === 'some';
                    }}
                    onChange={() => setSel(toggleAll(rows, sel))}
                  />
                </th>
                <th scope="col" className="px-2 py-1.5 text-start font-medium">{t('importConn.colName')}</th>
                <th scope="col" className="px-2 py-1.5 text-start font-medium">{t('importConn.colEngine')}</th>
                <th scope="col" className="px-2 py-1.5 text-start font-medium">{t('importConn.colTarget')}</th>
                <th scope="col" className="px-2 py-1.5 text-start font-medium">{t('importConn.colEnv')}</th>
                <th scope="col" className="px-2 py-1.5 text-start font-medium">{t('importConn.colGroup')}</th>
                <th scope="col" className="px-2 py-1.5 text-start font-medium">{t('importConn.colSsh')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.key} r={r} checked={sel.has(r.key)} onToggle={() => toggle(r.key)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <fieldset className="flex flex-col gap-1.5">
        <legend className="label">{t('importConn.options')}</legend>
        {check('keep_groups', t('importConn.keepGroups'))}
        {check('keep_environment', t('importConn.keepEnv'), t('importConn.keepEnvHint'))}
        {preview.passwords_supported && hasPasswords &&
          check(
            'import_passwords',
            preview.source === 'table_plus' ? t('importConn.passwordsKeychain') : t('importConn.passwordsIncluded'),
            preview.source === 'table_plus' ? t('importConn.passwordsKeychainHint') : undefined,
          )}
        {!preview.passwords_supported && <p className="text-xs text-muted">{t('importConn.noPasswords', { source: preview.label })}</p>}
      </fieldset>
    </div>
  );
}

function Row({ r, checked, onToggle }: { r: ConnImportRow; checked: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const can = importable(r);
  const engine = r.engine ? ENGINE_LABELS[r.engine] : r.source_engine;
  const skip =
    r.status === 'unsupported'
      ? t('importConn.willSkipEngine', { engine: engine || r.source_engine || '?' })
      : r.status === 'invalid'
        ? t('importConn.willSkipInvalid', { reason: r.reason ?? '' })
        : null;
  return (
    <tr className={`border-t border-border align-top ${can ? '' : 'text-muted'}`} data-status={r.status}>
      <td className="px-2 py-1.5">
        <input type="checkbox" aria-label={t('importConn.selectRow', { name: r.name })} checked={can && checked} disabled={!can} onChange={onToggle} />
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1.5 font-medium">
          {r.color && <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />}
          <span className="break-all">{r.name}</span>
        </div>
        {r.status === 'exists' && <div className="text-xs text-warn">{t('importConn.alreadyExists')}</div>}
        {skip && <div className="text-xs text-danger">{skip}</div>}
        {r.notes.map((n) => (
          <div key={n} className="text-xs text-muted">{n}</div>
        ))}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">{engine}</td>
      <td className="px-2 py-1.5 break-all">{rowTarget(r)}</td>
      <td className="px-2 py-1.5">{r.environment && <EnvBadge env={r.environment} />}</td>
      <td className="px-2 py-1.5">{r.group ?? ''}</td>
      <td className="px-2 py-1.5">{r.ssh ? t('common.yes') : t('common.no')}</td>
    </tr>
  );
}

function ResultStep({ result }: { result: ConnImportResult }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 text-sm" role="status">
      <p className="font-medium">{t('importConn.imported', { count: result.imported.length })}</p>
      {result.groups_created > 0 && <p>{t('importConn.groupsCreated', { count: result.groups_created })}</p>}
      {result.passwords_imported > 0 && <p>{t('importConn.passwordsImported', { count: result.passwords_imported })}</p>}
      {result.passwords_deferred > 0 && <p>{t('importConn.passwordsDeferred', { count: result.passwords_deferred })}</p>}
      {result.failed.length > 0 && (
        <section>
          <h3 className="label">{t('importConn.failed', { count: result.failed.length })}</h3>
          <ul className="list-disc ps-5">
            {result.failed.map((f) => (
              <li key={f.key}><span className="font-medium">{f.name}</span>: {f.error}</li>
            ))}
          </ul>
        </section>
      )}
      {result.password_errors.length > 0 && (
        <section>
          <h3 className="label">{t('importConn.passwordErrors', { count: result.password_errors.length })}</h3>
          <ul className="list-disc ps-5">
            {result.password_errors.map((f, i) => (
              <li key={`${f.key}-${i}`}><span className="font-medium">{f.name}</span>: {f.error}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
