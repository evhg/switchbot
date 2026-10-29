'use client';
// Fixed glass header for the Today story (docs/DESIGN.md §7 StoryHeader): the night being told, the active chapter
// in its accent, seven progress segments (scaleX per chapter, tap to jump) and prev / pick / next night.
// Segment fills are written from the shared scroll frame (no React state per frame); chapter geometry is measured
// only on mount / resize / body resize.
import { useEffect, useRef } from 'react';
import { useData } from '@/lib/data/context.tsx';
import { ictDate } from '@/lib/format.ts';
import { Icon } from '../icons.tsx';
import { scrollToChapter, subscribeScroll, useActiveChapter, useChapterList } from '../motion.tsx';
import s from './story.module.css';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const headDate = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
};

export function StoryHeader() {
  const { dataset, latest, date, setDate } = useData();
  const chapters = useChapterList();
  const active = useActiveChapter();
  const segs = useRef<(HTMLSpanElement | null)[]>([]);
  const ds = dataset ?? latest;

  // Segment fill = how far the 45 % line of the viewport is through each chapter.
  useEffect(() => {
    const geo: { top: number; h: number }[] = [];
    const last: number[] = [];
    let y0 = 0;
    let vh0 = 0;
    const measure = () => {
      chapters.forEach((c, i) => {
        const el = document.getElementById(c.id);
        if (!el) return;
        const r = el.getBoundingClientRect();
        geo[i] = { top: r.top + window.scrollY, h: Math.max(1, el.offsetHeight) };
      });
      paint(y0, vh0);
    };
    const paint = (y: number, vh: number) => {
      y0 = y;
      vh0 = vh;
      geo.forEach((g, i) => {
        const f = Math.max(0, Math.min(1, (y + vh * 0.45 - g.top) / g.h));
        const q = Math.round(f * 500) / 500;
        if (last[i] === q) return;
        last[i] = q;
        const el = segs.current[i];
        if (el) el.style.transform = `scaleX(${q})`;
      });
    };
    let raf = 0;
    const queue = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const ro = new ResizeObserver(queue);
    ro.observe(document.body);
    window.addEventListener('resize', queue, { passive: true });
    const off = subscribeScroll(paint);
    queue();
    return () => {
      off();
      ro.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', queue);
    };
  }, [chapters]);

  if (!ds || !date) return null;
  const dates = ds.nights.map((n) => n.date);
  const i = dates.indexOf(date);
  const isLatest = i === dates.length - 1;
  const partial = !dataset;
  const ai = chapters.findIndex((c) => c.id === active);
  const ac = ai >= 0 ? chapters[ai]! : null;
  const showChapter = ac && ai > 0;
  const when = date === ictDate(Date.now()) ? 'This morning' : isLatest ? 'Last night' : dates.length - 1 - i === 1 ? 'Night before' : `${dates.length - 1 - i} nights ago`;

  return (
    <header className={s.header} style={ac ? { ['--ch-accent' as string]: ac.accent } : undefined}>
      <div className={s.headRow}>
        <div className={s.headLeft}>
          <label className={`${s.headDate} press`} aria-label="Pick a night">
            <span className="t-label">{headDate(date)}</span>
            <input
              type="date"
              value={date}
              min={dates[0]}
              max={dates.at(-1)}
              disabled={partial}
              onChange={(e) => dates.includes(e.target.value) && setDate(e.target.value)}
            />
          </label>
          <span className={s.headSwap} aria-live="polite">
            <span className={`t-label ${s.headWhen} ${showChapter ? s.out : ''}`}>{when}</span>
            <span className={`t-label ${s.headCh} ${showChapter ? '' : s.out}`} aria-hidden={!showChapter}>
              {ac && (
                <>
                  <b>{String(ac.n ?? ai + 1).padStart(2, '0')}</b> {ac.title}
                </>
              )}
            </span>
          </span>
        </div>
        <div className={s.headNav}>
          {!isLatest && (
            <button type="button" className={`${s.latest} t-label press`} onClick={() => setDate(dates.at(-1)!)}>
              Latest
            </button>
          )}
          <button className={`${s.headBtn} press`} type="button" aria-label="Previous night" disabled={partial || i <= 0} onClick={() => setDate(dates[i - 1]!)}>
            <Icon name="chevron-left" size={16} strokeWidth={2} />
          </button>
          <button className={`${s.headBtn} press`} type="button" aria-label="Next night" disabled={isLatest} onClick={() => setDate(dates[i + 1]!)}>
            <Icon name="chevron-right" size={16} strokeWidth={2} />
          </button>
        </div>
      </div>
      <nav className={s.segs} aria-label="Chapters">
        {chapters.map((c, k) => (
          <button
            key={c.id}
            type="button"
            className={s.seg}
            style={{ ['--seg-ac' as string]: c.accent }}
            aria-label={`${String(c.n ?? k + 1).padStart(2, '0')} ${c.title ?? c.id}`}
            aria-current={c.id === active ? 'step' : undefined}
            onClick={() => scrollToChapter(c.id)}
          >
            <span ref={(el) => void (segs.current[k] = el)} />
          </button>
        ))}
      </nav>
    </header>
  );
}
