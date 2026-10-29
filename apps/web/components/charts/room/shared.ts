import { hm, hourTicks } from '@/lib/format.ts';
import { AXIS } from '../common.tsx';

/** Time x-axis (ICT clock ticks every `step` hours) for Recharts. */
export const timeAxis = (from: number, to: number, step = 2) => ({
  dataKey: 'ts',
  type: 'number' as const,
  domain: [from, to] as [number, number],
  ticks: hourTicks(from, to, step),
  tickFormatter: (v: number) => hm(v),
  ...AXIS,
});
