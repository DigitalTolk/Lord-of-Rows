import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { ColumnMeta, Value } from '../lib/types';
import { displayValue } from '../lib/value';

export type ChartKind = 'bar' | 'line' | 'area' | 'pie' | 'scatter' | 'kpi';

// Colour-blind-safe categorical palette (Okabe–Ito). The last slot (black in
// the original set) is a theme token so it stays visible on dark surfaces.
export const PALETTE = ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9', '#F0E442', 'rgb(var(--chart-8))'];

// Recharts defaults are light-only; drive axis/grid/tooltip from theme tokens
// (CSS variables resolve live, so no re-render is needed on theme switch).
const v = (token: string, a = 1) => `rgb(var(--${token}) / ${a})`;
const AXIS = { stroke: v('border'), tick: { fill: v('muted'), fontSize: 11 }, tickLine: { stroke: v('border') } } as const;
const GRID = { stroke: v('border'), strokeDasharray: '3 3' } as const;
const TOOLTIP = {
  contentStyle: { background: v('raised'), border: `1px solid ${v('border')}`, borderRadius: 6, color: v('fg'), boxShadow: '0 4px 16px rgb(var(--shadow) / 0.2)' },
  labelStyle: { color: v('fg'), fontWeight: 600 },
  itemStyle: { color: v('fg') },
  cursor: { fill: v('hover', 0.6), stroke: v('border') },
} as const;
const LEGEND = { wrapperStyle: { color: v('muted') } } as const;

function num(v: Value): number | null {
  switch (v.t) {
    case 'int':
    case 'float':
      return v.v;
    case 'big_int':
    case 'decimal':
      return Number(v.v); // charting only; precision loss is acceptable for plotting
    default:
      return null;
  }
}

export interface ChartSpec {
  kind: ChartKind;
  x: string;
  y: string[];
}

export function ChartView({ columns, rows, spec }: { columns: ColumnMeta[]; rows: Value[][]; spec: ChartSpec }) {
  const data = useMemo(() => {
    const xi = columns.findIndex((c) => c.name === spec.x);
    const yi = spec.y.map((y) => columns.findIndex((c) => c.name === y));
    return rows.slice(0, 5000).map((r) => {
      const o: Record<string, string | number | null> = { [spec.x]: xi >= 0 ? displayValue(r[xi]) : '' };
      spec.y.forEach((y, k) => (o[y] = yi[k] >= 0 ? num(r[yi[k]]) : null));
      return o;
    });
  }, [columns, rows, spec]);
  if (spec.kind === 'kpi') {
    const v = data[0]?.[spec.y[0]];
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <div className="text-4xl font-bold tabular-nums">{v ?? '—'}</div>
        <div className="text-muted">{spec.y[0]}</div>
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      {spec.kind === 'pie' ? (
        <PieChart>
          <Tooltip {...TOOLTIP} />
          <Legend {...LEGEND} />
          <Pie data={data} dataKey={spec.y[0]} nameKey={spec.x} outerRadius="80%" stroke={v('bg')}>
            {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
          </Pie>
        </PieChart>
      ) : spec.kind === 'scatter' ? (
        <ScatterChart>
          <CartesianGrid {...GRID} />
          <XAxis {...AXIS} dataKey={spec.x} name={spec.x} />
          <YAxis {...AXIS} dataKey={spec.y[0]} name={spec.y[0]} />
          <Tooltip {...TOOLTIP} />
          <Scatter data={data} fill={PALETTE[0]} />
        </ScatterChart>
      ) : spec.kind === 'line' ? (
        <LineChart data={data}>
          <CartesianGrid {...GRID} />
          <XAxis {...AXIS} dataKey={spec.x} />
          <YAxis {...AXIS} />
          <Tooltip {...TOOLTIP} />
          <Legend {...LEGEND} />
          {spec.y.map((y, i) => <Line key={y} dataKey={y} stroke={PALETTE[i % PALETTE.length]} dot={false} isAnimationActive={false} />)}
        </LineChart>
      ) : spec.kind === 'area' ? (
        <AreaChart data={data}>
          <CartesianGrid {...GRID} />
          <XAxis {...AXIS} dataKey={spec.x} />
          <YAxis {...AXIS} />
          <Tooltip {...TOOLTIP} />
          <Legend {...LEGEND} />
          {spec.y.map((y, i) => <Area key={y} dataKey={y} stroke={PALETTE[i % PALETTE.length]} fill={PALETTE[i % PALETTE.length]} fillOpacity={0.3} isAnimationActive={false} />)}
        </AreaChart>
      ) : (
        <BarChart data={data}>
          <CartesianGrid {...GRID} />
          <XAxis {...AXIS} dataKey={spec.x} />
          <YAxis {...AXIS} />
          <Tooltip {...TOOLTIP} />
          <Legend {...LEGEND} />
          {spec.y.map((y, i) => <Bar key={y} dataKey={y} fill={PALETTE[i % PALETTE.length]} isAnimationActive={false} />)}
        </BarChart>
      )}
    </ResponsiveContainer>
  );
}

export default function Chart({ columns, rows }: { columns: ColumnMeta[]; rows: Value[][] }) {
  const { t } = useTranslation();
  const numeric = columns.filter((_, i) => rows.slice(0, 50).some((r) => num(r[i]) !== null));
  const [spec, setSpec] = useState<ChartSpec>({ kind: 'bar', x: columns[0]?.name ?? '', y: numeric.slice(0, 1).map((c) => c.name) });
  return (
    <div className="flex min-h-0 flex-1 flex-col p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <select className="input w-auto" aria-label={t('chart.type')} value={spec.kind} onChange={(e) => setSpec({ ...spec, kind: e.target.value as ChartKind })}>
          {(['bar', 'line', 'area', 'pie', 'scatter', 'kpi'] as ChartKind[]).map((k) => <option key={k} value={k}>{t(`chart.kinds.${k}`)}</option>)}
        </select>
        <label className="flex items-center gap-1">{t('chart.xAxis')} <select className="input w-auto" value={spec.x} onChange={(e) => setSpec({ ...spec, x: e.target.value })}>{columns.map((c) => <option key={c.name}>{c.name}</option>)}</select></label>
        <span>{t('chart.yAxis')}</span>
        {numeric.map((c) => (
          <label key={c.name} className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={spec.y.includes(c.name)} onChange={(e) => setSpec({ ...spec, y: e.target.checked ? [...spec.y, c.name] : spec.y.filter((y) => y !== c.name) })} />
            {c.name}
          </label>
        ))}
      </div>
      <div className="min-h-0 flex-1">{spec.y.length ? <ChartView columns={columns} rows={rows} spec={spec} /> : <p className="text-muted">{t('chart.selectNumeric')}</p>}</div>
    </div>
  );
}
