import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorBox, Spinner, Toolbar } from '../components/ui';
import { api } from '../lib/ipc';
import type { TableDescription } from '../lib/types';
import { fmtNumber } from '../lib/format';
import { errMsg, useApp, type Tab } from '../store';

const W = 220;
const ROW = 18;
const HEAD = 24;
type Pos = Record<string, { x: number; y: number }>;

function height(t: TableDescription) {
  return HEAD + Math.min(t.columns.length, 30) * ROW + (t.columns.length > 30 ? ROW : 0) + 6;
}

/** Grid layout ordered so related tables sit near each other (BFS over FK graph). */
export function autoLayout(tables: TableDescription[]): Pos {
  const adj = new Map<string, Set<string>>();
  tables.forEach((t) => adj.set(t.object.name, new Set()));
  tables.forEach((t) => t.foreign_keys.forEach((f) => { adj.get(t.object.name)?.add(f.ref_table); adj.get(f.ref_table)?.add(t.object.name); }));
  const order: string[] = [];
  const seen = new Set<string>();
  const byDegree = [...adj.keys()].sort((a, b) => (adj.get(b)!.size - adj.get(a)!.size) || a.localeCompare(b));
  for (const start of byDegree) {
    if (seen.has(start)) continue;
    const q = [start];
    seen.add(start);
    while (q.length) {
      const n = q.shift()!;
      order.push(n);
      [...(adj.get(n) ?? [])].sort().forEach((m) => { if (!seen.has(m) && adj.has(m)) { seen.add(m); q.push(m); } });
    }
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(order.length * 1.6)));
  const byName = new Map(tables.map((t) => [t.object.name, t]));
  const pos: Pos = {};
  const colY = new Array(cols).fill(40);
  order.forEach((n, i) => {
    const c = i % cols;
    pos[n] = { x: 40 + c * (W + 80), y: colY[c] };
    colY[c] += height(byName.get(n)!) + 50;
  });
  return pos;
}

export function ERView({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const { sessions, openTab, toast } = useApp();
  const s = tab.sessionId ? sessions[tab.sessionId] : undefined;
  const [tables, setTables] = useState<TableDescription[]>([]);
  const [pos, setPos] = useState<Pos>({});
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [filter, setFilter] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: 'pan' | 'node'; name?: string; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const layoutId = `${s?.config.id}:${s?.activeSchema}`;

  useEffect(() => {
    if (!s) return;
    setBusy(true);
    void (async () => {
      try {
        const snap = await api.schemaSnapshot(s.session_id, s.activeSchema);
        setTables(snap);
        const saved = (await api.listDocuments<Pos>('er_layout')).find((d) => d.id === layoutId);
        setPos({ ...autoLayout(snap), ...(saved?.body ?? {}) });
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [s?.session_id, s?.activeSchema]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    let v = tables;
    if (filter) v = v.filter((x) => x.object.name.toLowerCase().includes(filter.toLowerCase()));
    if (focus) {
      const rel = new Set([focus]);
      tables.forEach((x) => x.foreign_keys.forEach((f) => { if (x.object.name === focus) rel.add(f.ref_table); if (f.ref_table === focus) rel.add(x.object.name); }));
      v = v.filter((x) => rel.has(x.object.name));
    }
    return v;
  }, [tables, filter, focus]);
  const names = new Set(visible.map((x) => x.object.name));

  const onDown = (e: React.MouseEvent, name?: string) => {
    e.stopPropagation();
    const p = name ? pos[name] : { x: view.x, y: view.y };
    drag.current = { kind: name ? 'node' : 'pan', name, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y };
  };
  const onMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.kind === 'pan') setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    else setPos((p) => ({ ...p, [d.name!]: { x: d.ox + dx / view.k, y: d.oy + dy / view.k } }));
  };
  const onWheel = (e: React.WheelEvent) => {
    const k = Math.min(3, Math.max(0.1, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
    setView((v) => ({ ...v, k }));
  };

  const exportSvg = async (png: boolean) => {
    if (!svg.current) return;
    const clone = svg.current.cloneNode(true) as SVGSVGElement;
    const bb = svg.current.getBBox();
    clone.setAttribute('viewBox', `${bb.x - 20} ${bb.y - 20} ${bb.width + 40} ${bb.height + 40}`);
    clone.setAttribute('width', String(bb.width + 40));
    clone.setAttribute('height', String(bb.height + 40));
    (clone.querySelector('g') as SVGGElement).setAttribute('transform', '');
    // Standalone SVG/PNG can't see the app's CSS variables: inline the current theme's values.
    const css = getComputedStyle(document.documentElement);
    const bg = `rgb(${css.getPropertyValue('--bg').trim()})`;
    clone.style.background = bg;
    const text = new XMLSerializer().serializeToString(clone).replace(/var\(--([\w-]+)\)/g, (m, n: string) => css.getPropertyValue(`--${n}`).trim() || m);
    if (!png) {
      await navigator.clipboard.writeText(text);
      toast('info', t('er.svgCopied'));
      return;
    }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = (bb.width + 40) * 2;
      c.height = (bb.height + 40) * 2;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0);
      c.toBlob(async (b) => {
        if (b) await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]);
        toast('info', t('er.pngCopied'));
      });
    };
    img.src = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  };

  const save = async () => {
    await api.saveDocument('er_layout', layoutId, `${s?.config.name} ${s?.activeSchema ?? ''}`, pos);
    toast('ok', t('er.layoutSaved'));
  };

  if (!s) return <div className="p-4 text-muted">{t('status.disconnected')}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <span className="font-semibold">{t('er.title')} — {s.activeSchema}</span>
        <input className="input w-48" placeholder={t('common.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('common.filter')} />
        {focus && <button className="btn" onClick={() => setFocus(null)}>{t('er.showAll', { table: focus })}</button>}
        <button className="btn" onClick={() => setPos(autoLayout(tables))}>{t('er.autoLayout')}</button>
        <button className="btn" onClick={() => setView({ x: 0, y: 0, k: Math.min(1, 1200 / Math.max(1, Math.sqrt(tables.length) * (W + 80))) })}>{t('er.fit')}</button>
        <button className="btn" onClick={save}>{t('er.saveLayout')}</button>
        <button className="btn" onClick={() => exportSvg(false)}>{t('er.exportSvg')}</button>
        <button className="btn" onClick={() => exportSvg(true)}>{t('er.exportPng')}</button>
        {busy && <Spinner label={t('er.loading')} />}
        <span className="ms-auto text-xs text-muted">{t('er.tableCount', { count: visible.length, formatted: fmtNumber(visible.length) })} · {t('er.navHint')}</span>
      </Toolbar>
      <ErrorBox error={error} />
      <svg ref={svg} style={{ direction: 'ltr' }} role="img" aria-label={t('er.diagramLabel')} className="min-h-0 flex-1 cursor-grab select-none bg-bg" onMouseDown={(e) => onDown(e)} onMouseMove={onMove} onMouseUp={() => (drag.current = null)} onMouseLeave={() => (drag.current = null)} onWheel={onWheel}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="rgb(var(--muted))" /></marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {visible.flatMap((tb) =>
            tb.foreign_keys.filter((f) => names.has(f.ref_table) && pos[f.ref_table]).map((f) => {
              const a = pos[tb.object.name];
              const b = pos[f.ref_table];
              if (!a || !b) return null;
              const ai = Math.max(0, tb.columns.findIndex((c) => c.name === f.columns[0]));
              const target = tables.find((x) => x.object.name === f.ref_table)!;
              const bi = Math.max(0, target.columns.findIndex((c) => c.name === f.ref_columns[0]));
              const ay = a.y + HEAD + Math.min(ai, 29) * ROW + ROW / 2;
              const by = b.y + HEAD + Math.min(bi, 29) * ROW + ROW / 2;
              const right = b.x > a.x + W / 2;
              const ax = right ? a.x + W : a.x;
              const bx = right ? b.x : b.x + W;
              const mx = (ax + bx) / 2;
              return <path key={tb.object.name + f.name} d={`M${ax},${ay} C${mx},${ay} ${mx},${by} ${bx},${by}`} fill="none" stroke="rgb(var(--muted))" strokeWidth={1.2} markerEnd="url(#arrow)"><title>{`${tb.object.name}.${f.columns.join(',')} → ${f.ref_table}.${f.ref_columns.join(',')}`}</title></path>;
            }),
          )}
          {visible.map((tb) => {
            const p = pos[tb.object.name];
            if (!p) return null;
            const h = height(tb);
            return (
              <g key={tb.object.name} transform={`translate(${p.x},${p.y})`} onMouseDown={(e) => onDown(e, tb.object.name)} onDoubleClick={() => openTab({ kind: 'table', title: tb.object.name, sessionId: s.session_id, target: { schema: tb.object.schema, table: tb.object.name } })} className="cursor-move">
                <rect width={W} height={h} rx={4} fill="rgb(var(--raised))" stroke={focus === tb.object.name ? 'rgb(var(--accent))' : 'rgb(var(--border))'} strokeWidth={focus === tb.object.name ? 2 : 1} />
                <rect width={W} height={HEAD} rx={4} fill="rgb(var(--accent))" opacity={0.15} />
                <text x={8} y={16} fontWeight={600} fontSize={12} fill="rgb(var(--fg))" onClick={(e) => { e.stopPropagation(); setFocus(tb.object.name); }}>{tb.object.name}</text>
                {tb.columns.slice(0, 30).map((c, i) => (
                  <g key={c.name} transform={`translate(0,${HEAD + i * ROW})`}>
                    <text x={8} y={13} fontSize={11} fill="rgb(var(--fg))" fontFamily="monospace">{c.is_primary_key ? '🔑 ' : tb.foreign_keys.some((f) => f.columns.includes(c.name)) ? '↗ ' : '   '}{c.name}</text>
                    <text x={W - 8} y={13} fontSize={10} textAnchor="end" fill="rgb(var(--muted))" fontFamily="monospace">{c.data_type.slice(0, 16)}{c.nullable ? '' : ' *'}</text>
                  </g>
                ))}
                {tb.columns.length > 30 && <text x={8} y={HEAD + 30 * ROW + 13} fontSize={11} fill="rgb(var(--muted))">{t('er.moreColumns', { count: tb.columns.length - 30 })}</text>}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
