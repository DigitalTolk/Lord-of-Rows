import { describe, expect, it } from 'vitest';
import { STATS } from './MonitorView';

describe('monitor stats queries are safe for production', () => {
  it('MySQL metadata scans are on-demand, time-limited and scoped to the current database by default', () => {
    const heavy = STATS.mysql.filter((q) => q.heavy);
    expect(heavy.map((q) => q.title).sort()).toEqual(['dbSize', 'largestTables']);
    for (const q of heavy) expect(q.sql(false)).toContain('MAX_EXECUTION_TIME(5000)');
    const largest = STATS.mysql.find((q) => q.title === 'largestTables')!;
    expect(largest.sql(false)).toContain('table_schema = DATABASE()');
    expect(largest.sql(true)).not.toContain('DATABASE()');
    expect(largest.sql(true)).toContain("NOT IN ('mysql','sys','performance_schema','information_schema')");
  });

  it('light panels never scan information_schema.tables', () => {
    for (const fam of ['mysql', 'pg'] as const) {
      for (const q of STATS[fam].filter((x) => !x.heavy)) expect(q.sql(false).toLowerCase()).not.toContain('information_schema.tables');
    }
  });
});
