import { describe, expect, it } from 'vitest';
import { exporters, formatters, signerText } from './plugins';
import type { PluginInfo } from './types';

const plugin = (over: Partial<PluginInfo>): PluginInfo => ({
  id: 'com.example.p',
  version: '1.0.0',
  manifest: { id: 'com.example.p', name: 'P', version: '1.0.0', api_version: 1, min_app_version: '0.1.0', description: '', author: '', capabilities: ['format_sql'] },
  signer: { kind: 'unsigned' },
  wasm_sha256: '',
  enabled: true,
  grants: ['format_sql'],
  settings: {},
  installed: '',
  updated: '',
  ...over,
});

describe('plugin menus', () => {
  it('offers formatting only for enabled, granted, compatible plugins', () => {
    expect(formatters([plugin({})])).toHaveLength(1);
    expect(formatters([plugin({ enabled: false })])).toHaveLength(0);
    expect(formatters([plugin({ grants: [] })])).toHaveLength(0);
    expect(formatters([plugin({ incompatible: 'requires 9.0.0' })])).toHaveLength(0);
  });

  it('exporters need both export grants and an export section', () => {
    const m = { ...plugin({}).manifest, capabilities: ['export_format', 'read_query_results'] as PluginInfo['grants'], export: { label: 'X', extension: 'x' } };
    expect(exporters([plugin({ manifest: m, grants: ['export_format'] })])).toHaveLength(0);
    expect(exporters([plugin({ manifest: m, grants: ['export_format', 'read_query_results'] })])).toHaveLength(1);
  });

  it('describes signers', () => {
    expect(signerText({ kind: 'unsigned' })).toBe('Unsigned');
    expect(signerText({ kind: 'verified', public_key: 'ab', fingerprint: '1234:abcd' })).toBe('Verified publisher key 1234:abcd');
  });
});
