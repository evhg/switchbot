'use client';
import { useData } from '@/lib/data/context.tsx';
import { dayLabel, ictDate } from '@/lib/format.ts';
import { Icon } from './icons.tsx';
import { Reveal } from './motion.tsx';

/**
 * Large page header shared across tabs: mono kicker, big title, the viewed night in mono with a SIMULATED / LIVE
 * pill, and prev / pick / next as 36 px glass circles. Works from the newest-night preview before the full dataset.
 *
 *   <DateNav />                       title = "Last night" / "This morning" / the date
 *   <DateNav title="Room" kicker="Bedroom air" />
 */
export function DateNav({ title, kicker }: { title?: string; kicker?: string }) {
  const { dataset, latest, date, setDate, sourceKind } = useData();
  const ds = dataset ?? latest;
  if (!ds || !date) return null;
  const dates = ds.nights.map((n) => n.date);
  const i = dates.indexOf(date);
  const latestNight = i === dates.length - 1;
  const isToday = date === ictDate(Date.now());
  const partial = !dataset;
  return (
    <Reveal as="header" className="page-head" y={12}>
      <div style={{ minWidth: 0 }}>
        {kicker && <div className="page-kicker t-label">{kicker}</div>}
        <h1>{title ?? (isToday ? 'This morning' : latestNight ? 'Last night' : dayLabel(date))}</h1>
        <div className="page-sub t-label">
          {(title || isToday || latestNight) && <span>{dayLabel(date)}</span>}
          {sourceKind === 'sim' ? <span className="badge">Simulated</span> : <span className="badge live">Live</span>}
        </div>
      </div>
      <div className="nav">
        <button className="icon-btn" type="button" aria-label="Previous night" disabled={partial || i <= 0} onClick={() => setDate(dates[i - 1]!)}>
          <Icon name="chevron-left" size={18} strokeWidth={2} />
        </button>
        <label className="icon-btn press" style={{ position: 'relative', overflow: 'hidden', opacity: partial ? 0.35 : 1 }} aria-label="Pick a night">
          <Icon name="calendar" size={18} />
          <input
            type="date"
            value={date}
            min={dates[0]}
            max={dates.at(-1)}
            disabled={partial}
            onChange={(e) => dates.includes(e.target.value) && setDate(e.target.value)}
            style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer' }}
          />
        </label>
        <button className="icon-btn" type="button" aria-label="Next night" disabled={latestNight} onClick={() => setDate(dates[i + 1]!)}>
          <Icon name="chevron-right" size={18} strokeWidth={2} />
        </button>
      </div>
    </Reveal>
  );
}
