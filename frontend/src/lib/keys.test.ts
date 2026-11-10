import { describe, expect, it } from 'vitest';
import { displayCombo, eventCombo, matches } from './keys';
import { generateSql, quoteIdent } from './sqlgen';

const ev = (key: string, mods: Partial<KeyboardEvent> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe('shortcuts', () => {
  it('maps Mod to Cmd on macOS and Ctrl elsewhere', () => {
    expect(eventCombo(ev('k', { metaKey: true }), true)).toBe('Mod+K');
    expect(eventCombo(ev('k', { ctrlKey: true }), false)).toBe('Mod+K');
    expect(eventCombo(ev('k', { ctrlKey: true }), true)).toBe('Ctrl+K');
    expect(matches('Mod+Shift+T', 'Mod+Shift+T')).toBe(true);
    expect(matches(eventCombo(ev('Tab', { ctrlKey: true }), false), 'Ctrl+Tab', false)).toBe(true);
    expect(matches(eventCombo(ev('Tab', { ctrlKey: true }), true), 'Ctrl+Tab', true)).toBe(true);
  });
  it('displays platform symbols', () => {
    expect(displayCombo('Mod+Shift+K', true)).toBe('⌘+⇧+K');
    expect(displayCombo('Mod+Shift+K', false)).toBe('Ctrl+Shift+K');
  });
});

describe('sql generation', () => {
  it('quotes identifiers per dialect', () => {
    expect(quoteIdent('postgres', 'a"b')).toBe('"a""b"');
    expect(quoteIdent('my_sql', 'a`b')).toBe('`a``b`');
    expect(quoteIdent('sql_server', 'a]b')).toBe('[a]]b]');
  });
  it('generates templates using the primary key', () => {
    const d = {
      object: { kind: 'table' as const, schema: 'public', name: 'users' },
      columns: [
        { name: 'id', data_type: 'int', nullable: false, is_primary_key: true, is_identity: true, ordinal: 1 },
        { name: 'email', data_type: 'text', nullable: true, is_primary_key: false, is_identity: false, ordinal: 2 },
      ],
      primary_key: ['id'], indexes: [], foreign_keys: [], constraints: [],
    };
    expect(generateSql('delete', 'postgres', d)).toBe('DELETE FROM "public"."users"\nWHERE "id" = ?;');
    expect(generateSql('update', 'my_sql', d)).toContain('SET\n  `email` = ?');
  });
});
