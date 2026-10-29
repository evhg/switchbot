'use client';
// 06 · What drove it — normal scroll (docs/DESIGN.md §10.06). Net points as a mega figure, then one diverging list
// that merges room and body drivers (sorted by |points|): bars grow from the centre axis with an 80 ms stagger.
// Then "In a sentence": the rule report's insights. The full waterfalls stay one tap away in a sheet.
import type { ScoreDriver } from '@sleep-lab/core';
import { fmt, signed } from '@/lib/format.ts';
import { Icon } from '../icons.tsx';
import { Chapter, CountUp, Reveal, scrollToChapter } from '../motion.tsx';
import { Placeholder, SectionHeader } from '../ui.tsx';
import s from './story.module.css';

export interface DriverRow extends ScoreDriver {
  /** 'Room' or the person's name. */
  source: string;
  text: string;
}

export function Drivers({
  rows,
  sleepAir,
  meanRecovery,
  insights,
  loading,
  onWaterfall,
}: {
  rows: DriverRow[];
  sleepAir: number;
  meanRecovery: number | null;
  insights: string[];
  loading: boolean;
  onWaterfall: () => void;
}) {
  // The mega figure is the room's net, so it adds up with the footer (typical 70 → Sleep Air). Body drivers are
  // relative to each person's own baseline and get their own sub-total.
  const roomRows = rows.filter((d) => d.source === 'Room');
  const net = roomRows.reduce((a, d) => a + d.points, 0);
  const bodyNet = rows.filter((d) => d.source !== 'Room').reduce((a, d) => a + d.points, 0);
  const hasBody = rows.length > roomRows.length;
  const maxP = Math.max(1, ...rows.map((d) => Math.abs(d.points)));
  const accent = net >= 0 ? 'drivers' : 'var(--ac-drivers-neg)';
  return (
    <Chapter id="drivers" n={6} title="What drove it" accent={accent} className="bleed">
      <Reveal className="sh-kicker t-label" y={10}>
        <span>06</span>
        <span>What drove it</span>
      </Reveal>
      {loading ? (
        <div style={{ marginTop: 24 }}>
          <Placeholder height={360} text="Weighing the drivers…" />
        </div>
      ) : (
        <>
          <Reveal className={s.net}>
            <CountUp value={net} format={(v) => signed(Math.round(v))} className="t-mega accent" />
            <span className="t-label t2">
              room points
              <br />
              typical 70 → <b className={s.netTo}>{fmt(sleepAir)}</b>
            </span>
          </Reveal>
          {hasBody && (
            <Reveal className={`t-micro t2 ${s.netSub}`}>
              Bodies <b className="mono">{signed(bodyNet)}</b> vs their own baselines
              {meanRecovery !== null && (
                <>
                  {' '}
                  · mean recovery <b className="mono">{fmt(meanRecovery)}</b>
                </>
              )}
            </Reveal>
          )}
          {rows.length ? (
            <Reveal className={s.drv} y={12}>
              {rows.map((d, i) => (
                <div key={i} className={`${s.dr} ${d.points >= 0 ? s.pos : s.neg}`} style={{ ['--w' as string]: Math.abs(d.points) / maxP, ['--i' as string]: i }}>
                  <div className={s.drLab}>
                    <b className="mono">{signed(d.points)}</b>
                    <span className={s.drWho}>{d.source}</span>
                    <span>{d.text}</span>
                  </div>
                  <div className={s.track}>
                    <i />
                  </div>
                </div>
              ))}
            </Reveal>
          ) : (
            <p className="t-small muted" style={{ marginTop: 18 }}>
              No drivers for this night (needs room coverage and 7+ nights of history).
            </p>
          )}
          <Reveal className={s.drFoot}>
            <span className="t-micro t2">
              Points vs a typical night · room and bodies scored separately
            </span>
            <button type="button" className="btn quiet" onClick={onWaterfall}>
              As waterfalls <Icon name="arrow-up-right" size={13} />
            </button>
          </Reveal>
        </>
      )}

      <div className={s.sentence}>
        <SectionHeader kicker="In a sentence" lines={['What the night', 'was telling you.']} size="h2" />
        {loading ? (
          <div style={{ marginTop: 16 }}>
            <Placeholder height={140} />
          </div>
        ) : (
          <Reveal stagger as="ul" className={s.insights}>
            {insights.map((t, i) => (
              <li key={i} className="t-body">
                {t}
              </li>
            ))}
          </Reveal>
        )}
        <div className={s.sentenceFoot}>
          <span className="t-micro muted">Rule-based report · Claude summary arrives with the nightly job</span>
          <button type="button" className="btn quiet" onClick={() => scrollToChapter('night')}>
            See it in the night <Icon name="chevron-up" size={13} />
          </button>
        </div>
      </div>
    </Chapter>
  );
}
