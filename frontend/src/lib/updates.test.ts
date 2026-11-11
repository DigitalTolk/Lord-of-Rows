import { describe, expect, it, vi } from 'vitest';
import { autoCheckForUpdates, channelOf, endpointKey, formatBytes, progressPercent } from './updates';
import type { UpdateCheck } from './types';

const available: UpdateCheck = { status: 'available', channel: 'stable', current_version: '0.1.0', version: '0.2.0', notes: 'n' };

describe('updates', () => {
  it('does not touch the network unless auto-check is enabled', async () => {
    const check = vi.fn(async () => available);
    const notify = vi.fn();
    expect(await autoCheckForUpdates({}, check, notify)).toBeNull();
    expect(await autoCheckForUpdates({ 'updates.autoCheck': 'true' }, check, notify)).toBeNull();
    expect(check).not.toHaveBeenCalled();
    expect(await autoCheckForUpdates({ 'updates.autoCheck': true }, check, notify)).toEqual(available);
    expect(notify).toHaveBeenCalledWith('0.2.0');
  });

  it('swallows startup check failures and only notifies for available updates', async () => {
    const notify = vi.fn();
    expect(await autoCheckForUpdates({ 'updates.autoCheck': true }, () => Promise.reject(new Error('offline')), notify)).toBeNull();
    await autoCheckForUpdates({ 'updates.autoCheck': true }, async () => ({ status: 'up_to_date', channel: 'stable', current_version: '0.1.0' }), notify);
    expect(notify).not.toHaveBeenCalled();
  });

  it('computes progress and resolves channel settings', () => {
    expect(progressPercent(null)).toBeNull();
    expect(progressPercent({ phase: 'downloading', downloaded: 50, total: null })).toBeNull();
    expect(progressPercent({ phase: 'downloading', downloaded: 50, total: 200 })).toBe(25);
    expect(progressPercent({ phase: 'downloading', downloaded: 300, total: 200 })).toBe(100);
    expect(progressPercent({ phase: 'verifying' })).toBe(100);
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(channelOf({})).toBe('stable');
    expect(channelOf({ 'updates.channel': 'beta' })).toBe('beta');
    expect(channelOf({ 'updates.channel': 'nightly' })).toBe('stable');
    expect(endpointKey('beta')).toBe('updates.endpoint.beta');
  });
});
