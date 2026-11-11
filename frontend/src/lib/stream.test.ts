import { describe, expect, it, vi } from 'vitest';
import { runStream, StreamAccumulator, type StreamMsg } from './stream';

const cols = [
  { name: 'id', type_name: 'int8' },
  { name: 'big', type_name: 'int8' },
];

const start = (statement_index: number, result_index: number): StreamMsg => ({ type: 'result_start', statement_index, result_index, sql_excerpt: `q${statement_index}`, columns: cols });
const rows = (result_index: number, seq: number, from: number, n: number): StreamMsg => ({
  type: 'rows',
  result_index,
  seq,
  rows: Array.from({ length: n }, (_, i) => [from + i, '9223372036854775807']),
});
const done = (statement_index: number, result_index: number | null, extra: Partial<Extract<StreamMsg, { type: 'statement_done' }>> = {}): StreamMsg => ({
  type: 'statement_done',
  statement_index,
  result_index,
  sql_excerpt: `q${statement_index}`,
  rows_affected: null,
  duration_ms: 5,
  notices: [],
  row_count: 0,
  truncated: false,
  ...extra,
});

describe('StreamAccumulator', () => {
  it('appends hydrated batches in order and returns seqs to ack', () => {
    const acc = new StreamAccumulator();
    expect(acc.apply(start(0, 0))).toBeNull();
    expect(acc.apply(rows(0, 0, 1, 500))).toBe(0);
    expect(acc.apply(rows(0, 1, 501, 4000))).toBe(1);
    const snap = acc.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].streaming).toBe(true);
    expect(snap[0].result!.rows).toHaveLength(4500);
    expect(snap[0].result!.rows[4499][0]).toEqual({ t: 'int', v: 4500 });
    // Precision: big integers stay exact strings.
    expect(snap[0].result!.rows[0][1]).toEqual({ t: 'big_int', v: '9223372036854775807' });
    expect(acc.rowCount).toBe(4500);
  });

  it('keeps identity of unchanged results and columns, copies changed rows', () => {
    const acc = new StreamAccumulator();
    acc.apply(start(0, 0));
    acc.apply(rows(0, 0, 1, 3));
    acc.apply(done(0, 0, { row_count: 3 }));
    acc.apply(start(1, 1));
    const a = acc.snapshot();
    expect(acc.snapshot()).toBe(a); // nothing changed
    acc.apply(rows(1, 1, 1, 2));
    const b = acc.snapshot();
    expect(b).not.toBe(a);
    expect(b[0]).toBe(a[0]); // finished result set untouched
    expect(b[1]).not.toBe(a[1]);
    expect(b[1].result!.columns).toBe(a[1].result!.columns); // grid layout must not reset
    expect(a[1].result!.rows).toHaveLength(0); // earlier snapshot not mutated
    expect(b[1].result!.rows).toHaveLength(2);
  });

  it('handles statements without rows, truncation, multiple result sets per statement', () => {
    const acc = new StreamAccumulator();
    acc.apply(done(0, null, { rows_affected: 3 }));
    acc.apply(start(1, 0));
    acc.apply(rows(0, 0, 1, 10));
    acc.apply(done(1, 0, { row_count: 10, truncated: true, notices: ['NOTICE: hi'] }));
    acc.apply(start(1, 1));
    acc.apply(done(1, 1));
    const s = acc.snapshot();
    expect(s.map((r) => r.statement_index)).toEqual([0, 1, 1]);
    expect(s[0].rows_affected).toBe(3);
    expect(s[0].result).toBeNull();
    expect(s[1].result!.truncated).toBe(true);
    expect(s[1].notices).toEqual(['NOTICE: hi']);
    expect(s[1].streaming).toBe(false);
    expect(s[2].result!.rows).toEqual([]);
  });

  it('error and done stop streaming flags', () => {
    const acc = new StreamAccumulator();
    acc.apply(start(0, 0));
    acc.apply(rows(0, 0, 1, 2));
    acc.apply({ type: 'error', error: { kind: 'cancelled', message: 'query cancelled' } });
    acc.apply({ type: 'done', duration_ms: 12, cancelled: true });
    const s = acc.snapshot();
    expect(s[0].streaming).toBe(false);
    expect(s[0].result!.rows).toHaveLength(2);
    expect(acc.error?.kind).toBe('cancelled');
    expect(acc.done).toEqual({ duration_ms: 12, cancelled: true });
  });
});

describe('runStream', () => {
  it('acks every batch, throttles updates and resolves on done', async () => {
    vi.useFakeTimers();
    const acks: number[] = [];
    const updates: number[] = [];
    let send!: (m: StreamMsg) => void;
    const p = runStream({
      start: (on) => {
        send = on;
        return new Promise(() => undefined); // invoke still pending
      },
      ack: (s) => acks.push(s),
      onUpdate: (_r, n) => updates.push(n),
      throttleMs: 100,
    });
    send(start(0, 0));
    send(rows(0, 0, 1, 500));
    send(rows(0, 1, 501, 500));
    expect(updates).toEqual([]); // coalesced
    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toEqual([1000]);
    send(rows(0, 2, 1001, 500));
    await vi.advanceTimersByTimeAsync(50);
    expect(updates).toEqual([1000]); // throttled
    await vi.advanceTimersByTimeAsync(60);
    expect(updates).toEqual([1000, 1500]);
    send(done(0, 0, { row_count: 1500 }));
    send({ type: 'done', duration_ms: 42, cancelled: false });
    const out = await p;
    vi.useRealTimers();
    expect(acks).toEqual([0, 1, 2]);
    expect(out.rowCount).toBe(1500);
    expect(out.duration_ms).toBe(42);
    expect(out.error).toBeNull();
    expect(out.results[0].result!.rows).toHaveLength(1500);
  });

  it('rejects when the gate refuses the run', async () => {
    const err = { kind: 'confirmation_required', message: 'confirm' };
    await expect(runStream({ start: () => Promise.reject(err), ack: () => undefined })).rejects.toBe(err);
  });

  it('resolves after a grace period if done never arrives', async () => {
    vi.useFakeTimers();
    const p = runStream({
      start: (on) => {
        on(start(0, 0));
        on(rows(0, 0, 1, 1));
        return Promise.resolve({ duration_ms: 1, ok: true });
      },
      ack: () => undefined,
      doneGraceMs: 500,
    });
    await vi.advanceTimersByTimeAsync(600);
    const out = await p;
    vi.useRealTimers();
    expect(out.results[0].result!.rows).toHaveLength(1);
  });

  it('reports execution errors with partial results', async () => {
    const out = await runStream({
      start: (on) => {
        on(start(0, 0));
        on(rows(0, 0, 1, 2));
        on(done(0, 0, { row_count: 2 }));
        on({ type: 'error', error: { kind: 'syntax', message: 'statement 2 failed: boom' } });
        on({ type: 'done', duration_ms: 3, cancelled: false });
        return Promise.resolve({ duration_ms: 3, ok: false });
      },
      ack: () => undefined,
    });
    expect(out.error?.message).toContain('statement 2');
    expect(out.results).toHaveLength(1);
  });
});
