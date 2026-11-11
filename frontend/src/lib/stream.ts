// Streaming query results (backend: `run_sql_stream`, see dbs_core::stream).
// Messages arrive in order over a Tauri Channel; rows use the compact wire form
// and are hydrated per batch. Each row batch is acknowledged so the backend can
// apply flow control (it stops reading from the database when we fall behind).
import type { ColumnMeta, DbError, StatementResult } from './types';
import { hydrateRows } from './hydrate';

export type StreamMsg =
  | { type: 'result_start'; statement_index: number; result_index: number; sql_excerpt: string; columns: ColumnMeta[] }
  | { type: 'rows'; result_index: number; seq: number; rows: unknown[][] }
  | {
      type: 'statement_done';
      statement_index: number;
      result_index: number | null;
      sql_excerpt: string;
      rows_affected: number | null;
      duration_ms: number;
      notices: string[];
      row_count: number;
      truncated: boolean;
    }
  | { type: 'error'; error: DbError }
  | { type: 'done'; duration_ms: number; cancelled: boolean };

/** Accumulates stream messages into `StatementResult`s with cheap snapshots for React. */
export class StreamAccumulator {
  private list: StatementResult[] = [];
  private byResult = new Map<number, number>();
  private dirty = new Set<number>();
  private snap: StatementResult[] = [];
  private structural = true;
  /** Rows received so far (all result sets). */
  rowCount = 0;
  error: DbError | null = null;
  done: { duration_ms: number; cancelled: boolean } | null = null;

  /** Apply one message. Returns the batch `seq` to acknowledge, if any. */
  apply(m: StreamMsg): number | null {
    switch (m.type) {
      case 'result_start': {
        this.byResult.set(m.result_index, this.list.length);
        this.list.push({
          statement_index: m.statement_index,
          sql_excerpt: m.sql_excerpt,
          result: { columns: m.columns, rows: [], truncated: false },
          rows_affected: null,
          duration_ms: 0,
          notices: [],
          streaming: true,
        });
        this.structural = true;
        return null;
      }
      case 'rows': {
        const pos = this.byResult.get(m.result_index);
        const rs = pos === undefined ? null : this.list[pos].result;
        if (pos !== undefined && rs) {
          const hydrated = hydrateRows(rs.columns, m.rows);
          for (let i = 0; i < hydrated.length; i++) rs.rows.push(hydrated[i]);
          this.rowCount += hydrated.length;
          this.dirty.add(pos);
        }
        return m.seq;
      }
      case 'statement_done': {
        const pos = m.result_index === null ? undefined : this.byResult.get(m.result_index);
        if (pos === undefined) {
          this.list.push({ statement_index: m.statement_index, sql_excerpt: m.sql_excerpt, result: null, rows_affected: m.rows_affected, duration_ms: m.duration_ms, notices: m.notices });
          this.structural = true;
        } else {
          const e = this.list[pos];
          e.rows_affected = m.rows_affected;
          e.duration_ms = m.duration_ms;
          e.notices = m.notices;
          e.streaming = false;
          if (e.result) e.result.truncated = m.truncated;
          this.dirty.add(pos);
        }
        return null;
      }
      case 'error':
        this.error = m.error;
        this.finishStreaming();
        return null;
      case 'done':
        this.done = { duration_ms: m.duration_ms, cancelled: m.cancelled };
        this.finishStreaming();
        return null;
    }
  }

  private finishStreaming() {
    this.list.forEach((e, i) => {
      if (e.streaming) {
        e.streaming = false;
        this.dirty.add(i);
      }
    });
  }

  /**
   * Immutable view for rendering. Unchanged result sets keep their identity
   * (so grids don't reset); changed ones get fresh objects and row arrays.
   * Column arrays are never copied: the grid resets its layout when they change.
   */
  snapshot(): StatementResult[] {
    if (!this.structural && this.dirty.size === 0) return this.snap;
    const next = this.list.map((e, i) => {
      const prev = this.snap[i];
      if (prev && !this.dirty.has(i)) return prev;
      return { ...e, notices: [...e.notices], result: e.result ? { ...e.result, rows: e.result.rows.slice() } : e.result };
    });
    this.dirty.clear();
    this.structural = false;
    this.snap = next;
    return next;
  }
}

export interface StreamOutcome {
  results: StatementResult[];
  rowCount: number;
  error: DbError | null;
  duration_ms: number;
  cancelled: boolean;
}

export interface StreamDeps {
  /** Start the run; `onMessage` receives every channel message. Rejects for gate errors (nothing ran). */
  start: (onMessage: (m: StreamMsg) => void) => Promise<unknown>;
  /** Acknowledge a processed row batch. */
  ack: (seq: number) => void;
  /** Throttled progress callback (snapshot + total rows so far). */
  onUpdate?: (results: StatementResult[], rowCount: number) => void;
  throttleMs?: number;
  /** How long to wait for the final `done` message after the invoke settled. */
  doneGraceMs?: number;
}

/** Drive one streaming run to completion. */
export function runStream(deps: StreamDeps): Promise<StreamOutcome> {
  const acc = new StreamAccumulator();
  const throttle = deps.throttleMs ?? 100;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEmit = 0;
  const emit = () => {
    timer = null;
    lastEmit = Date.now();
    deps.onUpdate?.(acc.snapshot(), acc.rowCount);
  };
  const schedule = () => {
    if (timer || !deps.onUpdate) return;
    const wait = Math.max(0, throttle - (Date.now() - lastEmit));
    timer = setTimeout(emit, wait);
  };
  return new Promise<StreamOutcome>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolve({ results: acc.snapshot(), rowCount: acc.rowCount, error: acc.error, duration_ms: acc.done?.duration_ms ?? 0, cancelled: acc.done?.cancelled ?? false });
    };
    const onMessage = (m: StreamMsg) => {
      if (settled) return;
      const seq = acc.apply(m);
      if (seq !== null) deps.ack(seq);
      if (m.type === 'done') finish();
      else schedule();
    };
    deps.start(onMessage).then(
      () => {
        // The invoke can resolve before the last channel messages are delivered.
        if (!settled) setTimeout(finish, deps.doneGraceMs ?? 2000);
      },
      (e: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(e);
      },
    );
  });
}
