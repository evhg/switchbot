/**
 * Inline SVG icon set (docs/DESIGN.md §6): 24×24 viewBox, 1.7 stroke, round caps/joins, currentColor.
 *
 *   <Icon name="thermometer" />                 20 px, inherits colour
 *   <Icon name="moon" size={22} filled />        `filled` adds a 15 % fill (active tab)
 *   <Icon name="co2" title="CO₂" />              titled icons get role="img" + <title>; others are aria-hidden
 *
 * Names: see ICON_NAMES / IconName.
 */
import type { CSSProperties, ReactNode } from 'react';

const P = (d: string) => <path d={d} />;

const PATHS = {
  // tabs
  moon: P('M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z'),
  house: (
    <>
      {P('M4 11.5 12 5l8 6.5V20H4z')}
      {P('M9 15.5c1.5-1.2 4.5-1.2 6 0')}
    </>
  ),
  pulse: P('M3 12h4l2-5 3 10 2.5-7 1.5 2H21'),
  flask: (
    <>
      {P('M9 3h6M10 3v6L4.5 19a1.3 1.3 0 0 0 1.1 2h12.8a1.3 1.3 0 0 0 1.1-2L14 9V3')}
      {P('M7.5 14h9')}
    </>
  ),
  gear: (
    <>
      <circle cx={12} cy={12} r={3} />
      {P('M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5')}
    </>
  ),
  // navigation
  'chevron-left': P('M15 5l-7 7 7 7'),
  'chevron-right': P('M9 5l7 7-7 7'),
  'chevron-down': P('M5 9l7 7 7-7'),
  'chevron-up': P('M5 15l7-7 7 7'),
  'arrow-up-right': P('M7 17 17 7M8 7h9v9'),
  'arrow-right': P('M4 12h16M14 6l6 6-6 6'),
  close: P('M6 6l12 12M18 6 6 18'),
  calendar: (
    <>
      <rect x={4} y={5} width={16} height={15} rx={2.5} />
      {P('M4 10h16M9 3v4M15 3v4')}
    </>
  ),
  // data
  thermometer: (
    <>
      {P('M14 14.5V5a2 2 0 1 0-4 0v9.5a4 4 0 1 0 4 0Z')}
      {P('M12 17.5V9')}
    </>
  ),
  droplet: P('M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5Z'),
  co2: (
    <>
      {P('M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.5 4.5 0 0 0 7 18Z')}
      {P('M10.6 12.2a1.6 1.6 0 1 0 0 2.6M14.4 11.8a1.4 1.7 0 1 0 0 3.4 1.4 1.7 0 0 0 0-3.4ZM16.9 15.6h1.3l-1.3 1.4h1.3')}
    </>
  ),
  wind: P('M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3M3 12h7'),
  snowflake: P('M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5'),
  fan: (
    <>
      <circle cx={12} cy={12} r={1.6} />
      {P('M12 10.4C11 6.5 12.5 4 15 4c2 0 2.5 2.5.5 4.5L13.4 11M13.6 12c3.9-1 6.4.5 6.4 3 0 2-2.5 2.5-4.5.5L13 13.4M12 13.6c1 3.9-.5 6.4-3 6.4-2 0-2.5-2.5-.5-4.5l2.1-2.1M10.4 12C6.5 13 4 11.5 4 9c0-2 2.5-2.5 4.5-.5l2.1 2.1')}
    </>
  ),
  door: (
    <>
      {P('M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21M4 21h16')}
      <circle cx={14.5} cy={12.5} r={0.9} fill="currentColor" stroke="none" />
    </>
  ),
  shower: P('M4 20V7a3 3 0 0 1 6 0M7 9.5h6a3 3 0 0 0-6 0M8 13v1M10.5 13l.5 1M13 12.5l1 1M9 16.5v1M12 16l.6 1M15 15l1 1'),
  bed: P('M3 18V6M3 14h18v4M21 14v-2.5A2.5 2.5 0 0 0 18.5 9H11v5M7 11.5a1.5 1.5 0 1 0 0-.01'),
  heart: P('M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10Z'),
  lungs: P('M12 4v8M12 12c-1.5 0-2.5-1-3-2.5C7.5 9 4 11 4 16c0 2.2 1.3 3.5 3 3.5 2 0 3-1.2 3-3V12M12 12c1.5 0 2.5-1 3-2.5 1.5-.5 5 1.5 5 6.5 0 2.2-1.3 3.5-3 3.5-2 0-3-1.2-3-3V12'),
  o2: (
    <>
      <circle cx={9} cy={12} r={4.5} />
      {P('M15.5 15.2c.3-.6.9-1 1.6-1 1 0 1.7.7 1.7 1.6 0 1.4-2.2 2.2-3.3 3.7h3.4')}
    </>
  ),
  footprints: P('M7.5 13.5c-1.4 0-2.5-1.6-2.5-4.2S6 4 7.8 4s2.4 2.5 2.2 5.2c-.2 2.6-1.1 4.3-2.5 4.3ZM6 16.5l3.5-.5.3 2a1.8 1.8 0 0 1-3.5.5ZM16.5 10.5c1.4 0 2.5-1.6 2.5-4.2S18 1 16.2 1 13.8 3.5 14 6.2c.2 2.6 1.1 4.3 2.5 4.3ZM18 13.5l-3.5-.5-.3 2a1.8 1.8 0 0 0 3.5.5Z'),
  zzz: P('M4 9h5l-5 6h5M13 5h4l-4 5h4M16 14h4l-4 5h4'),
  sunrise: P('M3 18h18M6.5 18a5.5 5.5 0 0 1 11 0M12 3v6M9 6l3-3 3 3M4.2 12.2l1.4 1M19.8 12.2l-1.4 1M5 21h14'),
  sunset: P('M3 18h18M6.5 18a5.5 5.5 0 0 1 11 0M12 3v6M9 6l3 3 3-3M4.2 12.2l1.4 1M19.8 12.2l-1.4 1M5 21h14'),
  clock: (
    <>
      <circle cx={12} cy={12} r={8.5} />
      {P('M12 7.5V12l3 2')}
    </>
  ),
  // status
  check: P('M5 12.5 10 17.5 19 7'),
  bell: P('M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15ZM10 20.5a2.2 2.2 0 0 0 4 0'),
  alert: (
    <>
      {P('M12 4 2.8 19.5h18.4Z')}
      {P('M12 10v4.5M12 17.2v.1')}
    </>
  ),
  info: (
    <>
      <circle cx={12} cy={12} r={8.5} />
      {P('M12 11v5.5M12 7.8v.1')}
    </>
  ),
  sparkle: P('M12 3.5c.6 4.3 2.2 5.9 6.5 6.5-4.3.6-5.9 2.2-6.5 6.5-.6-4.3-2.2-5.9-6.5-6.5 4.3-.6 5.9-2.2 6.5-6.5ZM18.5 15.5c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5Z'),
  play: P('M8 5.5v13l10.5-6.5Z'),
  edit: P('M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16ZM13.5 6.5l4 4'),
  refresh: P('M20 11a8 8 0 0 0-14.3-4.3L4 9M4 4v5h5M4 13a8 8 0 0 0 14.3 4.3L20 15M20 20v-5h-5'),
  plus: P('M12 5v14M5 12h14'),
  minus: P('M5 12h14'),
  table: P('M4 5h16v14H4ZM4 10h16M4 14.5h16M10 10v9'),
  dot: <circle cx={12} cy={12} r={3} fill="currentColor" stroke="none" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({
  name,
  size = 20,
  strokeWidth = 1.7,
  filled = false,
  title,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  /** Adds a 15 % currentColor fill (e.g. the active tab's moon). */
  filled?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      fillOpacity={filled ? 0.15 : undefined}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flex: 'none', ...style }}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}
