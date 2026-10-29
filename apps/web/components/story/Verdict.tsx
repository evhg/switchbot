'use client';
// 01 · The verdict — pinned 150svh hero (docs/DESIGN.md §10). The score number, verdict and person cards drift up
// and fade as you scroll (transform / opacity on refs, no React renders per frame); the sky dims.
import { useRef } from 'react';
import { fmt } from '@/lib/format.ts';
import { ScoreRing } from '../charts/ScoreRing.tsx';
import { Chapter, CountUp, Reveal, setSky, useMotionPrefs } from '../motion.tsx';
import { Skeleton } from '../ui.tsx';
import type { ReactNode } from 'react';
import s from './story.module.css';

export interface HeroPerson {
  id: string;
  name: string;
  color: string;
  sleep: number;
  recovery: number | null;
  away?: boolean;
}

/** Splits a verdict at its first full stop or colon: the first part in --text, the rest in --text-2. */
export function twoTone(text: string): [string, string] {
  const i = text.search(/[.!?:](\s|$)/);
  if (i < 0) return [text, ''];
  const head = text.slice(0, i + 1).trim();
  const rest = text.slice(i + 1).trim();
  return [head, rest ? rest[0]!.toUpperCase() + rest.slice(1) + (/[.!?]$/.test(rest) ? '' : '.') : ''];
}

export function Verdict({ score, verdict, people, onFocus, kicker = 'The story of last night', revealKey }: { score: number; verdict: string | null; people: HeroPerson[]; onFocus: (f: string) => void; kicker?: string; /** Count-ups play once per key per session (the night's date). */ revealKey?: string }) {
  const num = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const cards = useRef<HTMLDivElement>(null);
  const cue = useRef<HTMLDivElement>(null);
  const kick = useRef<HTMLDivElement>(null);
  const { level } = useMotionPrefs();
  const [a, b] = verdict ? twoTone(verdict) : ['', ''];
  return (
    <Chapter
      id="verdict"
      n={1}
      title="The verdict"
      accent="verdict"
      pinned={1.5}
      outline={false}
      reducedProgress={0}
      className="bleed first"
      onProgress={(p) => {
        if (cue.current) cue.current.style.opacity = String(Math.max(0, 1 - p * 4));
        if (level !== 'full') return;
        if (num.current) {
          num.current.style.transform = `translate3d(0,${(-90 * p).toFixed(1)}px,0) scale(${(1 - 0.16 * p).toFixed(4)})`;
          num.current.style.opacity = (1 - 0.55 * p).toFixed(3);
        }
        if (text.current) {
          text.current.style.transform = `translate3d(0,${(-60 * p).toFixed(1)}px,0)`;
          text.current.style.opacity = (1 - 0.6 * p).toFixed(3);
        }
        if (kick.current) kick.current.style.opacity = String(Math.max(0, 1 - p * 2.5));
        if (cards.current) {
          cards.current.style.transform = `translate3d(0,${(-40 * p).toFixed(1)}px,0)`;
          cards.current.style.opacity = (1 - 0.5 * p).toFixed(3);
        }
        setSky({ dusk: 1, mid: 0, dawn: 0, dim: 0.55 * p });
      }}
    >
      <div ref={kick}>
        <Reveal className="sh-kicker t-label" y={10}>
          <span>01</span>
          <span>{kicker}</span>
        </Reveal>
      </div>
      <div ref={num} className={`will ${s.heroNum}`}>
        <button type="button" className="tap" onClick={() => onFocus('room')} aria-label={`Sleep Air ${fmt(score)}: see what drove it`}>
          <CountUp value={score} className="t-hero" textClassName="grad-num" style={{ paddingRight: '0.08em' }} onceKey={revealKey && Number.isFinite(score) ? `hero:${revealKey}:${score}` : undefined} />
        </button>
        <div className="t-label t2" style={{ marginTop: 14 }}>
          Sleep Air · room score / 100
        </div>
      </div>
      <div ref={text} className="will" style={{ marginTop: 22, minHeight: 70 }}>
        {verdict ? (
          <Reveal as="p" className={s.verdict} delay={250}>
            {a} {b && <span className="tone-2">{b}</span>}
          </Reveal>
        ) : (
          <div style={{ display: 'grid', gap: 10 }} role="status" aria-label="Reading the night">
            <Skeleton h={22} w="92%" r="text" />
            <Skeleton h={22} w="64%" r="text" />
          </div>
        )}
      </div>
      <div ref={cards} className="will" style={{ marginTop: 22 }}>
        <Reveal stagger className={s.duo} style={{ gridTemplateColumns: `repeat(${Math.max(1, people.length)}, minmax(0, 1fr))` }} delay={200}>
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`${s.who} tap`}
              style={{ ['--pc' as string]: p.color }}
              onClick={() => !p.away && onFocus(p.id)}
              disabled={p.away}
              aria-label={p.away ? `${p.name}: away` : `${p.name}: sleep ${fmt(p.sleep)}${p.recovery !== null ? `, recovery ${fmt(p.recovery)}` : ''}. Open drivers`}
            >
              <div style={{ width: 52, flex: 'none' }}>
                {p.away ? (
                  <div className="sk-ring" style={{ width: 52, height: 52, borderWidth: 5 }} />
                ) : (
                  <ScoreRing value={p.sleep} inner={p.recovery ?? undefined} color={p.color} label={`${p.name} sleep`} size={52} showValue={false} glow={false} />
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className={s.whoName}>
                  <i style={{ background: p.color }} />
                  {p.name}
                </div>
                {p.away ? (
                  <div className={s.whoAway}>Away</div>
                ) : (
                  <CountUp value={p.sleep} className={s.whoScore} onceKey={revealKey && Number.isFinite(p.sleep) ? `who:${revealKey}:${p.id}:${p.sleep}` : undefined} />
                )}
                <div className="t-micro t2" style={{ marginTop: 5 }}>
                  {p.away ? 'no data' : p.recovery !== null ? `Recovery ${fmt(p.recovery)}` : 'Recovery …'}
                </div>
              </div>
            </button>
          ))}
        </Reveal>
      </div>
      <div ref={cue} className={`${s.cue} t-label`} style={{ marginTop: 'auto', paddingTop: 20 }}>
        <i aria-hidden />
        <span>Scroll through the night</span>
      </div>
    </Chapter>
  );
}

/**
 * First-paint skeleton with the Verdict's exact geometry (same chapter frame, hero line box, verdict block and
 * card row), so nothing jumps when the real hero replaces it.
 */
export function VerdictSkeleton({ status, people = 2 }: { status: ReactNode; people?: number }) {
  return (
    <section className="chapter bleed first" data-pinned="" style={{ height: '100svh' }} role="status" aria-live="polite">
      <div className="pin">
        <div className="chapter-inner">
          <div className="sh-kicker t-label">
            <span>01</span>
            <span>The story of last night</span>
          </div>
          <div className={s.heroNum}>
            <div className="t-hero" aria-hidden>
              <Skeleton w="1.2em" h=".7em" r="lg" style={{ marginTop: '.06em' }} />
            </div>
            <div className="t-label t2" style={{ marginTop: 14 }}>
              Sleep Air · room score / 100
            </div>
          </div>
          <div style={{ marginTop: 22, minHeight: 70, display: 'grid', gap: 10, alignContent: 'start' }}>
            <Skeleton h={22} w="92%" r="text" />
            <Skeleton h={22} w="64%" r="text" />
          </div>
          <div className={s.duo} style={{ marginTop: 22, gridTemplateColumns: `repeat(${people}, minmax(0, 1fr))` }}>
            {Array.from({ length: people }, (_, i) => (
              <div key={i} className={s.who}>
                <div className="sk-ring" style={{ width: 52, height: 52, borderWidth: 5, flex: 'none' }} />
                <div style={{ display: 'grid', gap: 8, flex: 1 }}>
                  <Skeleton w="60%" h={12} r="text" />
                  <Skeleton w="45%" h={26} r="text" />
                </div>
              </div>
            ))}
          </div>
          <div className="sk-status t-label" style={{ marginTop: 'auto', paddingTop: 20 }}>
            {status}
          </div>
        </div>
      </div>
    </section>
  );
}
