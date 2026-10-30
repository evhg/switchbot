'use client';
// Scene 1 · Last night (docs/DESIGN.md §9.1). The one reading of the screen: the room score at hero size, its
// 0–100 scale with "typical 70", the two-tone verdict, then You and Erik. Desktop adds the "at a glance" row and
// the whole night as a hypnogram strip that opens "The night" below.
import type { ReactNode } from 'react';
import { dur, fmt, hm } from '@/lib/format.ts';
import { scale } from '../charts/common.tsx';
import { Chapter, CountUp, Reveal } from '../motion.tsx';
import { Readout, Readouts, Skeleton, useWidth } from '../ui.tsx';
import { HypnoBlocks, personScope } from './parts.tsx';
import type { StoryModel } from './model.ts';
import s from './story.module.css';

export interface HeroPerson {
  id: string;
  name: string;
  color: string;
  sleep: number;
  recovery: number | null;
  /** Minutes asleep. */
  asleep?: number;
  away?: boolean;
  /** HRV (RMSSD, ms) last night and that person's typical (mean of the 30 nights before). */
  hrv?: number;
  hrvTypical?: number | null;
  /** Lowest heart rate, bpm. */
  low?: number;
}

/** A typical night scores 70 (the waterfall's start, §7.2 score scale). */
export const TYPICAL = 70;

/** Splits a verdict at its first full stop or colon: the first part in --text, the rest in --text-2. */
export function twoTone(text: string): [string, string] {
  const i = text.search(/[.!?:](\s|$)/);
  if (i < 0) return [text, ''];
  const head = text.slice(0, i + 1).trim();
  const rest = text.slice(i + 1).trim();
  return [head, rest ? rest[0]!.toUpperCase() + rest.slice(1) + (/[.!?]$/.test(rest) ? '' : '.') : ''];
}

/** 0–100 ticks, the filled part in ink, "typical 70" and the score as a 2 px signal tick. */
function ScoreScale({ score }: { score: number }) {
  const v = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
  const ticks = Array.from({ length: 21 }, (_, i) => i * 5);
  return (
    <div className={s.scale} role="img" aria-label={`${fmt(score)} out of 100, typical ${TYPICAL}`}>
      <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden>
        {ticks.map((t) => (
          <line key={t} x1={t} x2={t} y1={t % 10 ? 12 : 7} y2={18} stroke="var(--hairline-2)" vectorEffect="non-scaling-stroke" />
        ))}
        <line x1={0} x2={v} y1={18} y2={18} stroke="var(--text)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <line x1={TYPICAL} x2={TYPICAL} y1={3} y2={22} stroke="var(--muted)" vectorEffect="non-scaling-stroke" />
        <line x1={v} x2={v} y1={0} y2={22} stroke="var(--signal)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className={`cap ${s.scaleAx}`}>
        <span>0</span>
        <span style={{ left: `${TYPICAL}%` }}>typical {TYPICAL}</span>
        <span>100</span>
      </div>
    </div>
  );
}

/** The whole night, both hypnograms on one time axis (the hero's bridge into "The night"). */
function NightStripMini({ model }: { model: StoryModel }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const n = model.people.length;
  const row = w >= 1200 ? 8 : w >= 900 ? 6 : 4;
  const gap = w >= 900 ? 3 : 2;
  const hyp = row * 4 + gap * 3;
  const between = w >= 900 ? 24 : 12;
  const H = n * hyp + Math.max(0, n - 1) * between;
  const gut = w >= 900 ? 72 : 52;
  const x = scale(model.lo, model.end, gut, Math.max(gut + 1, w));
  return (
    <div ref={ref} className={s.strip} style={{ height: H }}>
      {w > 0 && (
        <svg width={w} height={H} aria-hidden>
          {model.people.map((p, i) => (
            <g key={p.id} className={personScope(i)}>
              <text x={0} y={i * (hyp + between) + hyp / 2 + 5} className={s.stripName}>
                {p.name}
              </text>
              <HypnoBlocks stages={p.night.sleep.stages} x={x} from={model.lo} to={model.end} y={i * (hyp + between)} row={row} gap={gap} rx={1} />
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

export function Verdict({
  label,
  score,
  verdict,
  people,
  glance,
  model,
  onFocus,
  revealKey,
  roomOnly = false,
  note = null,
  side = null,
}: {
  /** No watch data: the room score is the hero reading and `side` (the Google Health card) takes the room's place. */
  roomOnly?: boolean;
  /** One calm sentence about missing or left-out data, under the verdict. */
  note?: string | null;
  side?: ReactNode;
  label: string;
  score: number;
  verdict: string | null;
  people: HeroPerson[];
  glance: { label: string; value: ReactNode }[];
  model: StoryModel;
  onFocus: (f: string) => void;
  /** Count-up plays once per key per session (the night's date). */
  revealKey?: string;
}) {
  const [a, b] = verdict ? twoTone(verdict) : ['', ''];
  return (
    <Chapter id="verdict" title="Last night" className={s.hero} innerClassName={s.heroInner}>
      <div className={s.heroGrid}>
        <div className={s.heroMain}>
          <Reveal as="p" className={`label ${s.heroLabel}`} y={10}>
            {label}
          </Reveal>
          {roomOnly ? (
            <Reveal delay={60}>
              <button type="button" className={s.roomHero} onClick={() => onFocus('room')} aria-label={`Room score ${fmt(score)} out of 100, typical ${TYPICAL}. See what drove it`}>
                <span className={s.who}>Room score</span>
                <span className={s.personScore}>{Number.isFinite(score) ? <CountUp value={score} onceKey={revealKey ? `hero:${revealKey}:room:${score}` : undefined} /> : '–'}</span>
                <ScoreScale score={score} />
              </button>
            </Reveal>
          ) : (
          /* The people lead: one sleep score each at display size, with recovery and HRV underneath. */
          <Reveal className={s.duo} delay={60}>
            {people.map((p, i) => {
              const dHrv = p.hrv !== undefined && p.hrvTypical != null && Number.isFinite(p.hrv) ? Math.round(p.hrv - p.hrvTypical) : null;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`${s.person} ${personScope(i)}`}
                  onClick={() => !p.away && onFocus(p.id)}
                  disabled={p.away}
                  aria-label={p.away ? `${p.name}: away` : `${p.name}: sleep score ${fmt(p.sleep)}${p.recovery !== null ? `, recovery ${fmt(p.recovery)}` : ''}. See what drove it`}
                >
                  <span className={s.who}>
                    <i aria-hidden />
                    {p.name}
                  </span>
                  <span className={s.personScore}>
                    {p.away || !Number.isFinite(p.sleep) ? '–' : <CountUp value={p.sleep} onceKey={revealKey ? `hero:${revealKey}:${p.id}:${p.sleep}` : undefined} />}
                  </span>
                  <span className={s.personMeta}>
                    {p.away ? (
                      'Away last night'
                    ) : (
                      <>
                        <span>Sleep score</span>
                        <span>
                          Recovery <b className="num">{p.recovery !== null ? fmt(p.recovery) : '…'}</b>
                        </span>
                        {p.hrv !== undefined && Number.isFinite(p.hrv) && (
                          <span>
                            HRV <b className="num">{fmt(p.hrv)} ms</b>
                            {dHrv !== null && dHrv !== 0 && <span className="num"> {dHrv > 0 ? '↑' : '↓'} {Math.abs(dHrv)}</span>}
                          </span>
                        )}
                        {p.asleep !== undefined && Number.isFinite(p.asleep) && (
                          <span>
                            Asleep <b className="num">{dur(p.asleep)}</b>
                          </span>
                        )}
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </Reveal>
          )}
          {verdict ? (
            <Reveal as="p" className={s.verdict} delay={140}>
              {a} {b && <span>{b}</span>}
            </Reveal>
          ) : (
            <div className={s.verdictSk} role="status" aria-label="Reading the night">
              <Skeleton h={28} w="92%" r="text" />
              <Skeleton h={28} w="64%" r="text" />
            </div>
          )}
          {note && (
            <Reveal as="p" className={`sec ${s.quality}`} delay={180}>
              {note}
            </Reveal>
          )}
        </div>
        {/* The room is secondary: its own score, against a typical night. Room-only nights put the next step here. */}
        {roomOnly ? (
          <Reveal className={s.sideCard} delay={200}>
            {side}
          </Reveal>
        ) : (
        <Reveal className={s.roomSide} delay={200}>
          <button type="button" className={s.roomBtn} onClick={() => onFocus('room')} aria-label={`Room score ${fmt(score)} out of 100, typical ${TYPICAL}. See what drove it`}>
            <span className={s.roomHead}>
              <span className="label">Room score</span>
              <span className={s.roomVal}>
                <b className="num">{fmt(score)}</b>
                <span className="sec"> / 100</span>
              </span>
            </span>
            <ScoreScale score={score} />
          </button>
        </Reveal>
        )}
      </div>
      <Reveal className={s.glance} delay={260}>
        <Readouts n={glance.length}>
          {glance.map((g) => (
            <Readout key={g.label} label={g.label} value={g.value} />
          ))}
        </Readouts>
      </Reveal>
      <Reveal className={s.stripWrap} delay={300}>
        {!roomOnly && <NightStripMini model={model} />}
        <div className={s.cue}>
          <span className="cap num">{hm(model.lo)}</span>
          <span className={s.cueText}>
            Scroll through the night
            <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14M6 13l6 6 6-6" />
            </svg>
          </span>
          <span className="cap num">{hm(model.end)}</span>
        </div>
      </Reveal>
    </Chapter>
  );
}

/** First-paint skeleton with the hero's geometry, so nothing jumps when the data arrives. */
export function VerdictSkeleton({ status, people = 2 }: { status: ReactNode; people?: number }) {
  return (
    <section className={`chapter ${s.hero}`} role="status" aria-live="polite">
      <div className="pin">
        <div className={`chapter-inner ${s.heroInner}`}>
          <div className={s.heroGrid}>
            <div className={s.heroMain}>
              <p className={`label ${s.heroLabel}`}>Last night</p>
              <div className={s.duo} aria-hidden>
                {Array.from({ length: people }, (_, i) => (
                  <div key={i} className={s.person} style={{ pointerEvents: 'none' }}>
                    <Skeleton w={90} h={18} r="text" />
                    <Skeleton w="1.2em" h=".74em" r="lg" className={s.personScore} />
                    <Skeleton w={150} h={16} r="text" />
                  </div>
                ))}
              </div>
              <div className={s.verdictSk}>
                <Skeleton h={28} w="92%" r="text" />
                <Skeleton h={28} w="64%" r="text" />
              </div>
            </div>
            <div className={s.roomSide}>
              <Skeleton w={220} h={18} r="text" />
              <Skeleton h={24} w="100%" r="text" style={{ marginTop: 16 }} />
            </div>
          </div>
          <p className={`cap ${s.skStatus}`}>{status}</p>
        </div>
      </div>
    </section>
  );
}
