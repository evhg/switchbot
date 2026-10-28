'use client';
import { useData } from '@/lib/data/context.tsx';
import { dayLabel, ictDate } from '@/lib/format.ts';

const Chevron = ({ dir }: { dir: 'l' | 'r' }) => (
  <svg viewBox="0 0 24 24" aria-hidden>
    <path d={dir === 'l' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Header with the viewed night and prev / next / pick-a-date controls (shared across tabs). */
export function DateNav({ title }: { title?: string }) {
  const { dataset, date, setDate, sourceKind } = useData();
  if (!dataset || !date) return null;
  const dates = dataset.nights.map((n) => n.date);
  const i = dates.indexOf(date);
  const latest = i === dates.length - 1;
  const isToday = date === ictDate(Date.now());
  return (
    <header className="page-head">
      <div style={{ minWidth: 0 }}>
        <h1>{title ?? (isToday ? 'This morning' : latest ? 'Last night' : dayLabel(date))}</h1>
        <div className="page-sub">
          {title || isToday || latest ? `${dayLabel(date)} · ` : ''}
          {sourceKind === 'sim' ? <span className="badge">SIMULATED</span> : <span className="badge">LIVE</span>}
        </div>
      </div>
      <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
        <button className="icon-btn" type="button" aria-label="Previous night" disabled={i <= 0} onClick={() => setDate(dates[i - 1]!)}>
          <Chevron dir="l" />
        </button>
        <label className="icon-btn" style={{ position: 'relative', overflow: 'hidden' }} aria-label="Pick a night">
          <svg viewBox="0 0 24 24" aria-hidden>
            <rect x={4} y={5} width={16} height={15} rx={2} fill="none" stroke="currentColor" strokeWidth={1.8} />
            <path d="M4 10h16M9 3v4M15 3v4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
          </svg>
          <input
            type="date"
            value={date}
            min={dates[0]}
            max={dates.at(-1)}
            onChange={(e) => dates.includes(e.target.value) && setDate(e.target.value)}
            style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer' }}
          />
        </label>
        <button className="icon-btn" type="button" aria-label="Next night" disabled={latest} onClick={() => setDate(dates[i + 1]!)}>
          <Chevron dir="r" />
        </button>
      </div>
    </header>
  );
}
