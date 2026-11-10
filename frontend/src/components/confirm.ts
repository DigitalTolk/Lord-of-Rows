import { create } from 'zustand';
import type { Decision } from '../lib/types';
import type { PendingConfirm } from './SafetyDialog';

interface S {
  pending?: PendingConfirm;
}
export const useConfirm = create<S>(() => ({}));

/** Ask the user to confirm a backend decision. Resolves to the token (and typed phrase) or null. */
export function confirmDecision(decision: Decision, opts: { production: boolean; sqlPreview?: string }): Promise<{ token: string; typed?: string } | null> {
  if (decision.decision === 'allow') return Promise.resolve({ token: '' });
  return new Promise((resolve) => {
    useConfirm.setState({
      pending: {
        decision,
        production: opts.production,
        sqlPreview: opts.sqlPreview,
        resolve: (r) => {
          useConfirm.setState({ pending: undefined });
          resolve(decision.decision === 'block' ? null : r);
        },
      },
    });
  });
}
