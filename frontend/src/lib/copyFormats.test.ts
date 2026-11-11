import { describe, expect, it } from 'vitest';
import { columnValuesText, CopyFormatError, formatRows, jsonValue, parseClipboard, plainText, quoteIdentifier, sqlLiteral } from './copyFormats';
import { hydrateRows } from './hydrate';
import type { ColumnMeta, Value } from './types';

const col = (name: string, type_name = 'text'): ColumnMeta => ({ name, type_name });
const txt = (v: string): Value => ({ t: 'text', v });
const NULL: Value = { t: 'null' };

describe('sqlLiteral', () => {
  it('escapes quotes per dialect and never lets text break out of the literal', () => {
    expect(sqlLiteral(txt("O'Brien"), 'pg')).toBe("'O''Brien'");
    expect(sqlLiteral(txt("x'); DROP TABLE t; --"), 'pg')).toBe("'x''); DROP TABLE t; --'");
    // MySQL also treats backslash as an escape character.
    expect(sqlLiteral(txt('a\\b\''), 'mysql')).toBe("'a\\\\b'''");
    expect(sqlLiteral(txt('a\\b'), 'pg')).toBe("'a\\b'");
    expect(sqlLiteral(txt('a\\b'), 'sqlite')).toBe("'a\\b'");
    expect(sqlLiteral(txt('ü'), 'mssql')).toBe("N'ü'");
  });

  it('keeps newlines, tabs and unicode verbatim inside the literal', () => {
    expect(sqlLiteral(txt('l1\nl2\tx 🎉 中文'), 'pg')).toBe("'l1\nl2\tx 🎉 中文'");
  });

  it('distinguishes NULL from the empty string', () => {
    expect(sqlLiteral(NULL, 'pg')).toBe('NULL');
    expect(sqlLiteral(txt(''), 'pg')).toBe("''");
    expect(sqlLiteral(txt('NULL'), 'pg')).toBe("'NULL'");
  });

  it('writes numbers exactly, including integers beyond 2^53', () => {
    expect(sqlLiteral({ t: 'big_int', v: '9007199254740993' }, 'pg')).toBe('9007199254740993');
    expect(sqlLiteral({ t: 'big_int', v: '-123456789012345678901234567890' }, 'mysql')).toBe('-123456789012345678901234567890');
    expect(sqlLiteral({ t: 'decimal', v: '0.10000000000000000001' }, 'pg')).toBe('0.10000000000000000001');
    expect(sqlLiteral({ t: 'decimal', v: 'NaN' }, 'pg')).toBe("'NaN'");
    expect(sqlLiteral({ t: 'int', v: 42 }, 'pg')).toBe('42');
    expect(sqlLiteral({ t: 'float', v: 1.5 }, 'pg')).toBe('1.5');
    expect(sqlLiteral({ t: 'float', v: Infinity }, 'pg')).toBe("'Infinity'");
  });

  it('booleans, bytes and JSON per dialect', () => {
    expect(sqlLiteral({ t: 'bool', v: true }, 'pg')).toBe('TRUE');
    expect(sqlLiteral({ t: 'bool', v: false }, 'mysql')).toBe('0');
    const b: Value = { t: 'bytes', v: { hex: 'deadbeef', len: 4, truncated: false } };
    expect(sqlLiteral(b, 'pg')).toBe("'\\xdeadbeef'::bytea");
    expect(sqlLiteral(b, 'mysql')).toBe("X'deadbeef'");
    expect(sqlLiteral(b, 'sqlite')).toBe("X'deadbeef'");
    expect(sqlLiteral(b, 'mssql')).toBe('0xdeadbeef');
    expect(sqlLiteral({ t: 'json', v: { a: "it's" } }, 'pg')).toBe(`'{"a":"it''s"}'`);
    expect(sqlLiteral({ t: 'timestamp', v: { iso: '2024-01-02T03:04:05Z', tz: true } }, 'pg')).toBe("'2024-01-02T03:04:05Z'");
  });

  it('refuses partially loaded binary values', () => {
    expect(() => sqlLiteral({ t: 'bytes', v: { hex: 'ab', len: 9999, truncated: true } }, 'pg')).toThrow(CopyFormatError);
  });

  it('postgres arrays become array literals with element quoting', () => {
    const arr: Value = { t: 'array', v: [{ t: 'int', v: 1 }, txt('a b'), txt('q"x'), NULL, txt('')] };
    expect(sqlLiteral(arr, 'pg')).toBe(`'{1,"a b","q\\"x",NULL,""}'`);
  });
});

describe('identifiers', () => {
  it('quotes per engine family and doubles embedded quote characters', () => {
    expect(quoteIdentifier('we"ird', 'pg')).toBe('"we""ird"');
    expect(quoteIdentifier('we`ird', 'mysql')).toBe('`we``ird`');
    expect(quoteIdentifier('we]ird', 'mssql')).toBe('[we]]ird]');
  });
});

describe('formatRows', () => {
  const cols = [col('id', 'int4'), col('name'), col('note')];
  const rows: Value[][] = [
    [{ t: 'int', v: 1 }, txt('Ada'), NULL],
    [{ t: 'int', v: 2 }, txt('He said "hi", then left'), txt('')],
    [{ t: 'int', v: 3 }, txt('tab\there'), txt('line1\nline2')],
  ];

  it('TSV: no header by default, NULL text, spreadsheet quoting for tabs / newlines / quotes', () => {
    expect(formatRows('tsv', { columns: cols, rows })).toBe(
      ['1\tAda\tNULL', '2\t"He said ""hi"", then left"\t', '3\t"tab\there"\t"line1\nline2"'].join('\n'),
    );
    expect(formatRows('tsv', { columns: cols, rows: rows.slice(0, 1), header: true })).toBe('id\tname\tnote\n1\tAda\tNULL');
  });

  it('CSV (RFC 4180): CRLF, quotes doubled, NULL empty, empty string ""', () => {
    expect(formatRows('csv', { columns: cols, rows, header: true })).toBe(
      ['id,name,note', '1,Ada,', '2,"He said ""hi"", then left",""', '3,tab\there,"line1\nline2"'].join('\r\n'),
    );
  });

  it('JSON: typed values, exact big integers, NULL vs empty string, duplicate column names', () => {
    const out = formatRows('json', {
      columns: [col('id', 'int8'), col('id', 'int8'), col('price', 'numeric'), col('ok', 'bool'), col('doc', 'jsonb'), col('s')],
      rows: [[{ t: 'big_int', v: '12345678901234567890' }, { t: 'int', v: 7 }, { t: 'decimal', v: '1.10' }, { t: 'bool', v: true }, { t: 'json', v: { k: [1, null] } }, txt('')], [NULL, NULL, NULL, NULL, NULL, NULL]],
    });
    expect(out).toBe(
      '[\n  {"id": 12345678901234567890, "id_2": 7, "price": 1.10, "ok": true, "doc": {"k":[1,null]}, "s": ""},\n  {"id": null, "id_2": null, "price": null, "ok": null, "doc": null, "s": null}\n]',
    );
    expect(formatRows('json', { columns: cols, rows: [] })).toBe('[]');
  });

  it('JSON escapes control characters and unicode correctly', () => {
    expect(jsonValue(txt('a"b\\c\n\t🎉'))).toBe('"a\\"b\\\\c\\n\\t🎉"');
    expect(JSON.parse(jsonValue(txt('a"b\\c\n\t🎉')))).toBe('a"b\\c\n\t🎉');
  });

  it('Markdown: header + separator, pipes escaped, newlines as <br>', () => {
    expect(formatRows('markdown', { columns: [col('a'), col('b')], rows: [[txt('x|y'), txt('1\n2')], [NULL, txt('')]] })).toBe(
      '| a | b |\n| --- | --- |\n| x\\|y | 1<br>2 |\n| NULL |  |',
    );
  });

  it('SQL INSERT with dialect quoting and qualified table', () => {
    expect(formatRows('sql_insert', { columns: cols, rows: rows.slice(0, 2), engine: 'postgres', table: { schema: 'shop', table: 'customers' } })).toBe(
      [
        `INSERT INTO "shop"."customers" ("id", "name", "note") VALUES (1, 'Ada', NULL);`,
        `INSERT INTO "shop"."customers" ("id", "name", "note") VALUES (2, 'He said "hi", then left', '');`,
      ].join('\n'),
    );
    expect(formatRows('sql_insert', { columns: [col('a')], rows: [[txt("it's\\")]], engine: 'my_sql', table: { table: 't' } })).toBe("INSERT INTO `t` (`a`) VALUES ('it''s\\\\');");
  });

  it('SQL INSERT for query results uses the common source table, else a placeholder', () => {
    expect(formatRows('sql_insert', { columns: [{ name: 'a', type_name: 'text', table: 'users' }], rows: [[txt('x')]] })).toBe(`INSERT INTO "users" ("a") VALUES ('x');`);
    expect(formatRows('sql_insert', { columns: [col('a')], rows: [[txt('x')]] })).toBe(`INSERT INTO "table_name" ("a") VALUES ('x');`);
  });

  it('SQL UPDATE by primary key (key excluded from SET, original key values in WHERE)', () => {
    const out = formatRows('sql_update', {
      columns: cols,
      rows: rows.slice(0, 2),
      engine: 'sqlite',
      table: { table: 'people' },
      keys: { columns: ['id'], rows: [[{ t: 'int', v: 1 }], [{ t: 'big_int', v: '9007199254740993' }]] },
    });
    expect(out).toBe(
      [`UPDATE "people" SET "name" = 'Ada', "note" = NULL WHERE "id" = 1;`, `UPDATE "people" SET "name" = 'He said "hi", then left', "note" = '' WHERE "id" = 9007199254740993;`].join('\n'),
    );
  });

  it('SQL UPDATE refuses without a key or with only key columns', () => {
    expect(() => formatRows('sql_update', { columns: cols, rows })).toThrow(CopyFormatError);
    expect(() => formatRows('sql_update', { columns: [col('id')], rows: [[{ t: 'int', v: 1 }]], keys: { columns: ['id'], rows: [[{ t: 'int', v: 1 }]] } })).toThrow(/nothing to update/);
  });

  it('precision survives hydration: wire strings for int8 stay exact through every format', () => {
    const c = [col('id', 'int8')];
    const [[v]] = hydrateRows(c, [['18446744073709551615']]);
    expect(formatRows('tsv', { columns: c, rows: [[v]] })).toBe('18446744073709551615');
    expect(formatRows('csv', { columns: c, rows: [[v]] })).toBe('18446744073709551615');
    expect(formatRows('json', { columns: c, rows: [[v]] })).toContain('18446744073709551615');
    expect(formatRows('sql_insert', { columns: c, rows: [[v]], table: { table: 't' } })).toContain('VALUES (18446744073709551615)');
  });
});

describe('plain text and column values', () => {
  it('bytes are full hex, truncated ones are marked', () => {
    expect(plainText({ t: 'bytes', v: { hex: '00ff', len: 2, truncated: false } })).toBe('\\x00ff');
    expect(plainText({ t: 'bytes', v: { hex: '00ff', len: 900, truncated: true } })).toBe('\\x00ff…');
  });
  it('column values are newline separated', () => {
    expect(columnValuesText([txt('a'), NULL, txt(''), { t: 'int', v: 3 }])).toBe('a\nNULL\n\n3');
  });
});

describe('parseClipboard', () => {
  it('single value without tabs or newlines', () => {
    expect(parseClipboard('hello, world')).toEqual([['hello, world']]);
    expect(parseClipboard('')).toEqual([['']]);
    expect(parseClipboard('"quoted"')).toEqual([['"quoted"']]);
  });
  it('spreadsheet TSV block with CRLF and trailing newline', () => {
    expect(parseClipboard('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });
  it('quoted fields with tabs, newlines and doubled quotes', () => {
    expect(parseClipboard('"x\ty"\t"l1\nl2"\n"say ""hi"""\tz')).toEqual([['x\ty', 'l1\nl2'], ['say "hi"', 'z']]);
  });
  it('empty fields and malformed quotes are kept literally', () => {
    expect(parseClipboard('a\t\tc')).toEqual([['a', '', 'c']]);
    expect(parseClipboard('"open\tb')).toEqual([['"open', 'b']]);
  });
  it('multi-line text without tabs is one column', () => {
    expect(parseClipboard('1\n2\n3')).toEqual([['1'], ['2'], ['3']]);
  });
  it('round-trips what TSV copy produces', () => {
    const cols = [col('a'), col('b')];
    const rows: Value[][] = [[txt('x\ty'), txt('q"r')], [txt('m\nn'), txt('🎉')]];
    const text = formatRows('tsv', { columns: cols, rows });
    expect(parseClipboard(text)).toEqual([['x\ty', 'q"r'], ['m\nn', '🎉']]);
  });
});
