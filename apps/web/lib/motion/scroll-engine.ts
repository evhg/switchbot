// Scroll engine (docs/DESIGN.md §9.2): one passive scroll listener + one rAF per frame for the whole app.
// No React. Layout is measured only on register / resize / font load / body resize; frame() reads only
// scrollY and innerHeight. Progress is written as `--p` on the element and passed to callbacks; writes
// happen only when p moved by > 0.0005. Tracks off screen are snapped to 0 or 1 once (fast flicks never
// leave half states). Chapter tracks (with an id) feed the active-chapter store.

export type TrackMode = 'pin' | 'pass';

export interface TrackOptions {
  /** 'pin': p = 0 when the element's top reaches the viewport top, 1 when its bottom reaches the viewport bottom
   *  (use for sticky chapters taller than the screen). 'pass': p = 0 when its top enters at the bottom, 1 when its
   *  bottom leaves at the top. */
  mode: TrackMode;
  onProgress?: (p: number) => void;
  /** Hold zone at both ends (fraction of the range), remapped as p' = clamp((p − d) / (1 − 2d)). Default 0.04 for pin, 0 for pass. */
  dwell?: number;
  /** Write `--p` on the element (default true). Turn off when only the callback is used. */
  cssVar?: boolean;
  /** Chapter id: makes this track take part in active-chapter tracking. */
  chapterId?: string;
}

interface Track {
  el: HTMLElement;
  opts: TrackOptions;
  top: number;
  h: number;
  p: number;
  visible: boolean;
}

const tracks = new Set<Track>();
const byEl = new Map<Element, Track>();
const scrollSubs = new Set<(y: number, vh: number) => void>();
const chapterSubs = new Set<() => void>();
let activeChapter: string | null = null;
let vh = 0;
let lastY = -1;
let raf = 0;
let started = false;
let measureQueued = false;
let io: IntersectionObserver | null = null;
let ro: ResizeObserver | null = null;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function measure(t: Track) {
  const r = t.el.getBoundingClientRect();
  t.top = r.top + window.scrollY;
  t.h = t.el.offsetHeight;
}

function measureAll() {
  measureQueued = false;
  vh = window.innerHeight;
  for (const t of tracks) measure(t);
  lastY = -1; // force a full frame
  schedule();
}

/** Re-measure on the next frame (coalesced). Call after content above a track changes height. */
export function remeasure() {
  if (measureQueued || typeof window === 'undefined') return;
  measureQueued = true;
  requestAnimationFrame(measureAll);
}

function progressOf(t: Track, y: number): number {
  let p: number;
  if (t.opts.mode === 'pin') {
    const range = t.h - vh;
    p = range <= 0 ? (y >= t.top ? 1 : 0) : (y - t.top) / range;
  } else {
    p = (y + vh - t.top) / (t.h + vh);
  }
  p = clamp01(p);
  const d = t.opts.dwell ?? (t.opts.mode === 'pin' ? 0.04 : 0);
  return d > 0 ? clamp01((p - d) / (1 - 2 * d)) : p;
}

function write(t: Track, p: number) {
  t.p = p;
  if (t.opts.cssVar !== false) t.el.style.setProperty('--p', p.toFixed(4));
  t.opts.onProgress?.(p);
}

function frame() {
  raf = 0;
  const y = window.scrollY;
  const force = lastY < 0;
  lastY = y;
  for (const t of tracks) {
    const p = progressOf(t, y);
    // Visible tracks update on any meaningful change; hidden ones only to settle exactly at 0 or 1.
    if (t.visible || force) {
      if (Math.abs(p - t.p) > 0.0005 || ((p === 0 || p === 1) && t.p !== p)) write(t, p);
    } else if (t.p !== p && (p === 0 || p === 1)) {
      write(t, p);
    }
  }
  // Active chapter: the last chapter whose top is above 40 % of the viewport.
  let active: string | null = null;
  let best = -Infinity;
  for (const t of tracks) {
    const id = t.opts.chapterId;
    if (!id) continue;
    if (t.top <= y + vh * 0.4 && t.top > best) {
      best = t.top;
      active = id;
    }
  }
  if (active !== activeChapter) {
    activeChapter = active;
    for (const f of chapterSubs) f();
  }
  for (const f of scrollSubs) f(y, vh);
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  vh = window.innerHeight;
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', remeasure, { passive: true });
  window.addEventListener('orientationchange', remeasure, { passive: true });
  document.fonts?.ready.then(remeasure).catch(() => {});
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const t = byEl.get(e.target);
        if (t) t.visible = e.isIntersecting;
      }
      schedule();
    },
    { rootMargin: '50% 0px' },
  );
  ro = new ResizeObserver(remeasure);
  ro.observe(document.body);
}

/** Register an element for scroll progress. Returns an unregister function. */
export function register(el: HTMLElement, opts: TrackOptions): () => void {
  start();
  const t: Track = { el, opts, top: 0, h: 0, p: -1, visible: true };
  measure(t);
  tracks.add(t);
  byEl.set(el, t);
  io?.observe(el);
  lastY = -1;
  schedule();
  return () => {
    tracks.delete(t);
    byEl.delete(el);
    io?.unobserve(el);
    if (opts.chapterId && activeChapter === opts.chapterId) {
      activeChapter = null;
      for (const f of chapterSubs) f();
    }
  };
}

/** Change a registered element's callback / options without re-measuring. */
export function update(el: HTMLElement, opts: Partial<TrackOptions>) {
  const t = byEl.get(el);
  if (t) t.opts = { ...t.opts, ...opts };
}

/** Called once per frame in which the page scrolled (after tracks). Use for chrome (header fade, sky parallax). */
export function subscribeScroll(fn: (y: number, vh: number) => void): () => void {
  start();
  scrollSubs.add(fn);
  fn(window.scrollY, window.innerHeight || vh);
  return () => {
    scrollSubs.delete(fn);
  };
}

export const getActiveChapter = () => activeChapter;
export function subscribeChapter(fn: () => void): () => void {
  chapterSubs.add(fn);
  return () => {
    chapterSubs.delete(fn);
  };
}

/** Document Y of a registered element's top (measured, no layout read). */
export function trackTop(el: HTMLElement): number | null {
  return byEl.get(el)?.top ?? null;
}
