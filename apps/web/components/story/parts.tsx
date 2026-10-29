'use client';
// Shared pieces of the Today story (docs/DESIGN.md §8.3, §9.1): the scene frame (text column + visual column),
// the chart heading (the title is the finding), hypnogram marks and a measured box for SVG charts.
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { SleepStage } from '@sleep-lab/core';
import { Chapter, Reveal } from '../motion.tsx';
import s from './story.module.css';

/** Row order of a hypnogram: Awake on top, Deep at the bottom (§7.2). */
export const STAGE_ROW: Record<SleepStage, number> = { awake: 0, rem: 1, light: 2, deep: 3 };
export const STAGE_NAME: Record<SleepStage, string> = { awake: 'Awake', rem: 'REM', light: 'Light', deep: 'Deep' };
/** Person scope class: re-derives --person and the stage tokens (index 0 = You / ink, 1 = Erik / steel blue). */
export const personScope = (i: number) => (i === 1 ? 'p-erik' : 'p-you');

/** A non-pinned story scene: a hairline above, section spacing, the chapter registry for the top bar. */
export function Scene({ id, title, children, className = '' }: { id: string; title: string; children: ReactNode; className?: string }) {
  return (
    <Chapter id={id} title={title} className={`${s.scene} ${className}`} innerClassName={s.inner}>
      {children}
    </Chapter>
  );
}

/** Desktop: sticky text column (5/12) beside the visual (7/12). Below 1440 they stack. */
export function SceneCols({ text, children }: { text: ReactNode; children: ReactNode }) {
  return (
    <div className={s.cols}>
      <div className={s.text}>{text}</div>
      <div className={s.vis}>{children}</div>
    </div>
  );
}

/** Scene label → optional reading → title → lede, revealed in order. */
export function SceneText({ label, reading, readingCap, title, lede, children }: { label: string; reading?: ReactNode; readingCap?: ReactNode; title: ReactNode; lede?: ReactNode; children?: ReactNode }) {
  return (
    <>
      <Reveal as="p" className={`label ${s.sceneLabel}`}>
        {label}
      </Reveal>
      {reading !== undefined && (
        <Reveal className={s.sceneReading} delay={60}>
          <div className="reading num">{reading}</div>
          {readingCap && <p className="sec">{readingCap}</p>}
        </Reveal>
      )}
      <Reveal as="h2" className={`title ${s.sceneTitle}`} delay={80}>
        {title}
      </Reveal>
      {lede && (
        <Reveal as="p" className={`body ${s.lede}`} delay={140}>
          {lede}
        </Reveal>
      )}
      {children}
    </>
  );
}

/** Chart heading: the finding (.head) and one optional caption. */
export function VisHead({ title, cap, actions }: { title: ReactNode; cap?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={s.visHead}>
      <div style={{ minWidth: 0 }}>
        <h3 className="head">{title}</h3>
        {cap && <p className="cap">{cap}</p>}
      </div>
      {actions}
    </div>
  );
}

/** Measures an element's content box (rounded, only re-renders on a real change). */
export function useBox<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = (w: number, h: number) => setBox((b) => (Math.abs(b.w - w) < 1 && Math.abs(b.h - h) < 1 ? b : { w: Math.round(w), h: Math.round(h) }));
    set(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver((e) => {
      const r = e[0]?.contentRect;
      if (r) set(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box];
}

/**
 * One person's hypnogram as filled blocks (no outlines): four rows, Awake on top, Deep at the bottom, coloured by
 * the person's stage tokens. Wrap it in a <g className={personScope(i)}>.
 */
export function HypnoBlocks({
  stages,
  x,
  from,
  to,
  y,
  row,
  gap,
  rx = 1.5,
}: {
  stages: readonly { start: number; end: number; stage: SleepStage }[];
  x: (t: number) => number;
  from: number;
  to: number;
  y: number;
  row: number;
  gap: number;
  rx?: number;
}) {
  return (
    <>
      {stages.map((seg, k) => {
        if (seg.end <= from || seg.start >= to) return null;
        const x0 = x(Math.max(seg.start, from));
        const x1 = x(Math.min(seg.end, to));
        if (x1 - x0 < 0.2) return null;
        const r = STAGE_ROW[seg.stage];
        return <rect key={k} x={x0} y={y + r * (row + gap)} width={Math.max(1, x1 - x0 - 0.5)} height={row} rx={Math.min(rx, row / 3)} fill={`var(--stage-${seg.stage})`} />;
      })}
    </>
  );
}

export const cssVars = (o: Record<string, string | number>) => o as CSSProperties;
