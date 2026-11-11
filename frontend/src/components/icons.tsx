// Minimal original stroke icon set (24px grid, currentColor).
import type { SVGProps } from 'react';

const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  play: 'M7 5l12 7-12 7z',
  stop: 'M7 7h10v10H7z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  table: 'M4 5h16v14H4zM4 10h16M10 10v9',
  view: 'M4 5h16v14H4zM4 9h16M8 13h8M8 16h5',
  func: 'M14 4c-2 0-3 1-3.5 3L8 18c-.5 2-1.5 2-3 2M7 10h8',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  sidebar: 'M4 5h16v14H4zM9 5v14',
  db: 'M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  x: 'M6 6l12 12M18 6L6 18',
  key: 'M14 10a4 4 0 1 0-3.5 4l1.5 1.5h2v2h2v2h3v-3l-5.1-5.1',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  diagram: 'M3 4h7v5H3zM14 15h7v5h-7zM6.5 9v4.5h11V15',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  lock: 'M6 11h12v9H6zM8 11V7a4 4 0 0 1 8 0v4',
  structure: 'M4 5h16M4 10h16M4 15h10M4 20h7',
  sql: 'M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  moon: 'M20 14.2A8 8 0 1 1 9.8 4a6.4 6.4 0 0 0 10.2 10.2z',
  monitor: 'M3 5h18v11H3zM8.5 20h7M12 16v4',
  contrast: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v18',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      <path d={P[name]} />
    </svg>
  );
}
