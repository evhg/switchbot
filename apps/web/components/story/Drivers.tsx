'use client';
// Scene 6 · What drove it (docs/DESIGN.md §7.2, §9.1). The room's net points against a typical night as the
// reading, one sentence naming what carried the night and what cost the most, then every driver as a signed row
// with a bar centred on zero (positive in ink, negative in signal). The waterfalls and the rule report's sentences
// stay one tap away.
import type { ScoreDriver } from '@sleep-lab/core';
import { fmt, signed } from '@/lib/format.ts';
import { Reveal } from '../motion.tsx';
import { Button, Disclosure, Placeholder } from '../ui.tsx';
import { Scene, SceneCols, SceneText } from './parts.tsx';
import { TYPICAL } from './Verdict.tsx';
import s from './story.module.css';

export interface DriverRow extends ScoreDriver {
  /** 'Room' or the person's name. */
  source: string;
  text: string;
}

/** A short noun for a driver, for the finding sentence. */
function noun(d: DriverRow): string {
  const t = d.text.toLowerCase();
  const who = d.source === 'Room' ? '' : d.source === 'You' ? 'Your ' : `${d.source}’s `;
  if (/humid|rh\b/.test(t)) return 'Humidity';
  if (/co₂|co2|fresh air|ventilat/.test(t)) return 'The air';
  if (/curve|target|on plan/.test(t)) return 'The curve';
  if (/steady|stabil|swing/.test(t)) return 'A steady room';
  if (/warm|hot|cold|cool|temperature|°/.test(t)) return 'Temperature';
  if (/hrv|variab/.test(t)) return `${who}HRV`.replace(/^HRV/, 'HRV');
  if (/heart|bpm|hr\b/.test(t)) return `${who}heart rate`.replace(/^heart/, 'Heart');
  if (/breath/.test(t)) return `${who}breathing`.replace(/^breath/, 'Breath');
  if (/deep/.test(t)) return `${who}deep sleep`.replace(/^deep/, 'Deep');
  return d.source === 'Room' ? 'The room' : d.source;
}

export function driversTitle(rows: DriverRow[]): string {
  if (!rows.length) return 'Nothing stood out.';
  const pos = [...rows].filter((d) => d.points > 0).sort((a, b) => b.points - a.points)[0];
  const neg = [...rows].filter((d) => d.points < 0).sort((a, b) => a.points - b.points)[0];
  const cap = (x: string) => x[0]!.toUpperCase() + x.slice(1);
  if (pos && neg) return `${cap(noun(pos))} carried the night. ${cap(noun(neg))} cost the most.`;
  if (pos) return `${cap(noun(pos))} carried the night.`;
  return `${cap(noun(neg!))} cost the most.`;
}

export function Drivers({
  rows,
  sleepAir,
  meanRecovery,
  insights,
  loading,
  onWaterfall,
  report = null,
  note = null,
}: {
  /** A caveat under the drivers (e.g. a manual night is scored against a plan the aircon never ran). */
  note?: string | null;
  /** The backend's morning report, when it has written one: its headline leads the sentences. */
  report?: { headline: string; when: string } | null;
  rows: DriverRow[];
  sleepAir: number;
  meanRecovery: number | null;
  insights: string[];
  loading: boolean;
  onWaterfall: () => void;
}) {
  // The reading is the room's net, so it adds up with "typical 70 → room score". Body drivers are relative to each
  // person's own baseline and get their own sub-total in the sentence.
  const roomRows = rows.filter((d) => d.source === 'Room');
  const net = roomRows.reduce((a, d) => a + d.points, 0);
  const bodyNet = rows.filter((d) => d.source !== 'Room').reduce((a, d) => a + d.points, 0);
  const hasBody = rows.length > roomRows.length;
  const maxP = Math.max(1, ...rows.map((d) => Math.abs(d.points)));
  const sorted = [...rows].sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const lede = loading
    ? 'Weighing the drivers…'
    : `The room scored ${fmt(sleepAir)} against a typical ${TYPICAL}.${
        hasBody ? ` Your bodies came in ${fmt(Math.abs(bodyNet))} point${Math.abs(bodyNet) === 1 ? '' : 's'} ${bodyNet >= 0 ? 'above' : 'below'} their own baselines${meanRecovery !== null ? `, with mean recovery ${fmt(meanRecovery)}` : ''}.` : ''
      }`;
  return (
    <Scene id="drivers" title="What drove it">
      <SceneCols
        text={
          <SceneText
            label="What drove it"
            reading={
              loading ? (
                '…'
              ) : (
                <>
                  {signed(Math.round(net))}
                  <span className="unit">points</span>
                </>
              )
            }
            title={loading ? 'Reading the night…' : driversTitle(roomRows.length ? roomRows : rows)}
            lede={lede}
          />
        }
      >
        {loading ? (
          <Placeholder height={420} text="Weighing the drivers…" />
        ) : rows.length ? (
          <Reveal>
            {[
              { key: 'room', title: 'The room', sub: `${signed(Math.round(net))} against a typical ${TYPICAL} → ${fmt(sleepAir)}`, items: sorted.filter((d) => d.source === 'Room') },
              { key: 'body', title: 'Your bodies', sub: `${signed(Math.round(bodyNet))} against each person’s own baseline`, items: sorted.filter((d) => d.source !== 'Room') },
            ]
              .filter((g) => g.items.length)
              .map((g) => (
                <section key={g.key} className={s.drGroup} aria-label={g.title}>
                  <h3 className={s.drGroupH}>
                    {g.title}
                    <span className="sec num">{g.sub}</span>
                  </h3>
                  <ul className={s.drivers}>
                    {g.items.map((d, i) => {
                      const w = (Math.abs(d.points) / maxP) * 50;
                      const neg = d.points < 0;
                      return (
                        <li key={i}>
                          <span className={`num ${s.pts} ${neg ? s.neg : ''}`}>{signed(d.points)}</span>
                          <span className={s.drText}>
                            {d.text}
                            {d.source !== 'Room' && <small>{d.source}</small>}
                          </span>
                          <span className={s.drBar} aria-hidden>
                            <i className={neg ? s.neg : ''} style={neg ? { right: '50%', width: `${w}%` } : { left: '50%', width: `${w}%` }} />
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            <div className={s.drFoot}>
              <p className="cap">
                Room points add up to the room score; body points add up against each person’s own last 30 nights.{note ? ` ${note}` : ''}
              </p>
              <Button variant="text" onClick={onWaterfall}>
                As waterfalls
              </Button>
            </div>
          </Reveal>
        ) : (
          <p className="sec">No drivers for this night. They need room coverage and 7 or more nights of history.</p>
        )}
        {!loading && report && (
          <Reveal delay={100}>
            <div className={s.morning}>
              <p className="label">Morning report · {report.when}</p>
              <p className="head">{report.headline}</p>
            </div>
          </Reveal>
        )}
        {!loading && insights.length > 0 && (
          <Reveal delay={100}>
            <Disclosure title="The night in sentences" count={`${insights.length}`} className={s.report}>
              <ul className={s.insights}>
                {insights.map((t, i) => (
                  <li key={i} className="body">
                    {t}
                  </li>
                ))}
              </ul>
              <p className="cap">Rule-based report. The written summary arrives with the nightly job.</p>
            </Disclosure>
          </Reveal>
        )}
      </SceneCols>
    </Scene>
  );
}
