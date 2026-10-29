'use client';
import { useData } from '@/lib/data/context.tsx';
import { ictDate } from '@/lib/format.ts';
import { PageHeader } from './ui.tsx';

/**
 * @deprecated v1 page header with kicker, date badge and ‹ › buttons. v2 (docs/DESIGN.md §6 Page header): the night
 * picker and the data-source status live in the Sidebar (desktop) and the phone TopBar, so this is now just a
 * <PageHeader>. Prefer <PageHeader title lede /> from ui.tsx in new code.
 *
 *   <DateNav />                               title = "Last night" / "This morning"
 *   <DateNav title="Room" kicker="Bedroom air" />   kicker becomes the one-sentence lede
 */
export function DateNav({ title, kicker, lede }: { title?: string; kicker?: string; lede?: string }) {
  const { dataset, latest, date } = useData();
  const ds = dataset ?? latest;
  if (!ds || !date) return null;
  const latestNight = date === ds.nights.at(-1)?.date;
  const isToday = date === ictDate(Date.now());
  return <PageHeader title={title ?? (isToday ? 'This morning' : latestNight ? 'Last night' : 'That night')} lede={lede ?? kicker} />;
}
