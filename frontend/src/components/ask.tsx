import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { Dialog } from './ui';

interface Req {
  title: string;
  message?: string;
  input?: 'text' | 'password';
  danger?: boolean;
  resolve: (v: string | boolean | null) => void;
}
const useAsk = create<{ req?: Req }>(() => ({}));

function open(r: Omit<Req, 'resolve'>): Promise<string | boolean | null> {
  return new Promise((resolve) => useAsk.setState({ req: { ...r, resolve: (v) => { useAsk.setState({ req: undefined }); resolve(v); } } }));
}

export const ask = {
  confirm: (title: string, message?: string, danger = false) => open({ title, message, danger }).then((v) => v === true),
  text: (title: string, message?: string) => open({ title, message, input: 'text' }) as Promise<string | null>,
  password: (title: string, message?: string) => open({ title, message, input: 'password' }) as Promise<string | null>,
};

export function AskHost() {
  const { t } = useTranslation();
  const req = useAsk((s) => s.req);
  const [val, setVal] = useState('');
  if (!req) return null;
  const done = (v: string | boolean | null) => {
    setVal('');
    req.resolve(v);
  };
  const submit = () => done(req.input ? val : true);
  return (
    <Dialog
      title={req.title}
      onClose={() => done(null)}
      footer={
        <>
          <button className="btn" onClick={() => done(null)}>{t('common.cancel')}</button>
          <button className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`} onClick={submit}>{t('common.ok')}</button>
        </>
      }
    >
      {req.message && <p className="mb-2 whitespace-pre-wrap">{req.message}</p>}
      {req.input && (
        <input
          className="input"
          type={req.input}
          value={val}
          data-autofocus
          aria-label={req.title}
          autoComplete={req.input === 'password' ? 'current-password' : 'off'}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      )}
    </Dialog>
  );
}
