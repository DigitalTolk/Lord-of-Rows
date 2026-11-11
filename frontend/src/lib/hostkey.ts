import { ask } from '../components/ask';
import i18n from '../i18n';
import { IpcError } from './ipc';

/**
 * Run an operation that may open an SSH tunnel. If the SSH server's host key is
 * unknown, show its fingerprint and retry with explicit trust only if the user
 * confirms. Changed host keys are never offered for trust (the error is shown).
 */
export async function withHostKeyTrust<T>(run: (trust?: string) => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof IpcError && e.err.code === 'HOST_KEY_UNKNOWN' && e.err.hint) {
      const ok = await ask.confirm(
        i18n.t('ssh.trustTitle'),
        i18n.t('ssh.trustBody', { message: e.err.message, fingerprint: e.err.hint }),
      );
      if (!ok) throw new IpcError({ kind: 'ssh', message: i18n.t('ssh.notTrusted') });
      return run(e.err.hint);
    }
    throw e;
  }
}
