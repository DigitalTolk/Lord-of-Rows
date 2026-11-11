import { ask } from '../components/ask';
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
        'Trust this SSH host?',
        `${e.err.message}\n\nOnly continue if this fingerprint matches the one your server administrator gave you:\n\n${e.err.hint}`,
      );
      if (!ok) throw new IpcError({ kind: 'ssh', message: 'SSH host key not trusted; connection cancelled.' });
      return run(e.err.hint);
    }
    throw e;
  }
}
