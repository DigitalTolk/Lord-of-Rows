import type { Engine } from '../lib/types';

// Original two-letter badges (not vendor logos) with a distinct colour per engine.
export const ENGINE_STYLE: Record<Engine, { abbr: string; color: string }> = {
  postgres: { abbr: 'Pg', color: '#336791' },
  my_sql: { abbr: 'My', color: '#00758f' },
  maria_db: { abbr: 'Ma', color: '#a0522d' },
  sqlite: { abbr: 'Sl', color: '#0f80cc' },
  sql_server: { abbr: 'Ms', color: '#cc2927' },
  oracle: { abbr: 'Or', color: '#c74634' },
  cockroach_db: { abbr: 'Cr', color: '#6933ff' },
  redshift: { abbr: 'Rs', color: '#8c4fff' },
  single_store: { abbr: 'S2', color: '#aa00ff' },
  greenplum: { abbr: 'Gp', color: '#3a9a5b' },
  vertica: { abbr: 'Ve', color: '#0b5394' },
  duck_db: { abbr: 'Dk', color: '#c9a400' },
  lib_sql: { abbr: 'Ls', color: '#2aa198' },
  turso: { abbr: 'Tu', color: '#1fb5a8' },
  yugabyte_db: { abbr: 'Yb', color: '#ff6e42' },
  percona: { abbr: 'Pc', color: '#d64a1e' },
  mongo_db: { abbr: 'Mg', color: '#13aa52' },
  redis: { abbr: 'Rd', color: '#d82c20' },
  cassandra: { abbr: 'Ca', color: '#1287b1' },
  dynamo_db: { abbr: 'Dy', color: '#4053d6' },
  elasticsearch: { abbr: 'Es', color: '#00a9a5' },
  click_house: { abbr: 'Ch', color: '#e0b400' },
  big_query: { abbr: 'Bq', color: '#4285f4' },
  snowflake: { abbr: 'Sf', color: '#29b5e8' },
  cloudflare_d1: { abbr: 'D1', color: '#f38020' },
};

export function EngineBadge({ engine, size = 32, dim }: { engine: Engine; size?: number; dim?: boolean }) {
  const s = ENGINE_STYLE[engine];
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 select-none items-center justify-center rounded-[22%] font-semibold text-white shadow-sm"
      style={{ width: size, height: size, background: s.color, fontSize: size * 0.38, opacity: dim ? 0.45 : 1, letterSpacing: '-0.02em' }}
    >
      {s.abbr}
    </span>
  );
}
