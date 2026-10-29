'use client';
/**
 * Motion kit (docs/DESIGN.md §9). Everything here animates transform / opacity only, never sets React state
 * per frame, and degrades to final states under prefers-reduced-motion and to short fades in night mode.
 *
 * ── Preferences ──────────────────────────────────────────────────────────────────────────────────────────
 *   useMotionPrefs() → { reduced, night, level: 'full' | 'calm' | 'none' }
 *   useReducedMotion() → boolean
 *   motionLevel(), remap(p, a, b), lerp(a, b, t), easeOut(t)            (re-exported from lib/motion/prefs)
 *
 * ── Viewport ─────────────────────────────────────────────────────────────────────────────────────────────
 *   useInView(ref, { once = true, threshold = 0.15, rootMargin = '0px 0px -8% 0px' }) → boolean
 *   <Reveal as="div" delay={ms} y={28} stagger className style>…</Reveal>     one-shot rise + fade
 *       stagger: direct children get --i = index (80 ms apart). Use `mask` for headline line masks (.sh-line).
 *   <LazyMount minHeight={220}>…</LazyMount>   mounts children when near the viewport (Recharts then animates in)
 *
 * ── Numbers ──────────────────────────────────────────────────────────────────────────────────────────────
 *   <CountUp value={76} dp={0} format={(v) => …} duration={1300} from={0} className="t-hero" textClassName="grad-num" />
 *       Renders the final value for a11y / no-JS, reserves its width (no layout shift), counts on reveal.
 *       When `value` changes later it tweens from the shown value. Night and reduced motion: no count (§8.2).
 *   useCountUp(ref, value, opts) – same, imperative, for your own element.
 *
 * ── Scroll progress ──────────────────────────────────────────────────────────────────────────────────────
 *   useScrollProgress(ref, { mode: 'pin' | 'pass', onProgress(p), dwell, reducedValue = 1, cssVar = true })
 *       Registers with the singleton engine (lib/motion/scroll-engine.ts). Writes `--p` on the element and calls
 *       onProgress(p) once per frame while it moves. Mutate DOM refs inside onProgress; never setState there.
 *   <Chapter id="night" n={3} title="The night" accent="night" pinned={5.6} onProgress={…}>…</Chapter>
 *       A story chapter. `pinned` = height in screens (5.6 → 560svh) with a sticky 100svh stage inside.
 *       v2: no accent change (--ch-accent is an alias of --signal), no glow / outlined number; registers for active-chapter
 *       tracking. Children can read progress with useChapterProgress((p) => …).
 *   useChapterProgress(cb, [from, to]?) – subscribe to the enclosing chapter's p (remapped to [from, to]).
 *   useChapter() → { id, n, title } of the enclosing chapter (or null).
 *   useActiveChapter() → id | null (re-renders only when the active chapter changes)
 *   useChapterList() → [{ id, n, title, accent }] in document order (for StoryHeader)
 *   subscribeChapterProgress(id, fn) / scrollToChapter(id) – for StoryHeader segments.
 *
 * ── Drawing ──────────────────────────────────────────────────────────────────────────────────────────────
 *   <DrawPath d="M…" stroke="var(--temp)" />                draws in on reveal (1.4 s)
 *   <DrawPath d="M…" scrub={[0, .8]} />                     dashoffset tied to chapter progress 0→.8
 *       (pathLength=1 is set for you; don't combine with strokeDasharray patterns.)
 *   <ScrubWipe range={[0, 1]}>{(copy) => <svg>…</svg>}</ScrubWipe>
 *       Compositor-only reveal: a ghost copy at var(--ghost) under a bright copy revealed left→right by two
 *       counter-translating wrappers. Child may be a node or (copy: 'ghost' | 'bright') => node (use it to keep ids unique).
 *   <Cursor range={[0, 1]} className="accent">{dots / labels}</Cursor>  vertical line moved with translateX
 *   <Parallax speed={0.3}>…</Parallax>  decorative only, CSS scroll-driven (@supports), static otherwise.
 *
 * ── Ambient ──────────────────────────────────────────────────────────────────────────────────────────────
 *   <Sky/> and setSky(): RETIRED in v2 (flat background). Both are no-ops kept for compatibility.
 *
 * ── Transitions ──────────────────────────────────────────────────────────────────────────────────────────
 *   withViewTransition(update, { kind: 'nav' | 'theme', x, y })   View Transitions API when present + full motion.
 *   useNavigate() → (href) => void   tab navigation inside a view transition (fallback: router.push + .page fade).
 */
import { usePathname, useRouter } from 'next/navigation';
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ElementType,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SVGProps,
} from 'react';
import { useTheme } from '@/lib/theme.tsx';
import { REDUCED_QUERY, easeOut, motionLevel, prefersReduced, remap, type MotionLevel } from '@/lib/motion/prefs.ts';
import { getActiveChapter, register, subscribeChapter, subscribeScroll, trackTop, update, type TrackMode } from '@/lib/motion/scroll-engine.ts';

export { easeOut, lerp, motionLevel, remap } from '@/lib/motion/prefs.ts';
export type { MotionLevel } from '@/lib/motion/prefs.ts';
export { remeasure, subscribeScroll } from '@/lib/motion/scroll-engine.ts';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// ───────────────────────────────────────── preferences ─────────────────────────────────────────

function subscribeReduced(cb: () => void) {
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, prefersReduced, () => false);
}

export function useMotionPrefs(): { reduced: boolean; night: boolean; level: MotionLevel } {
  const reduced = useReducedMotion();
  const { resolved } = useTheme();
  const night = resolved === 'night';
  return { reduced, night, level: reduced ? 'none' : night ? 'calm' : 'full' };
}

// ───────────────────────────────────────── in-view (shared observers) ─────────────────────────────────────────

type IOKey = string;
const observers = new Map<IOKey, { io: IntersectionObserver; cbs: Map<Element, (v: boolean) => void> }>();

function observe(el: Element, cb: (v: boolean) => void, threshold: number, rootMargin: string): () => void {
  const key = `${threshold}|${rootMargin}`;
  let o = observers.get(key);
  if (!o) {
    const cbs = new Map<Element, (v: boolean) => void>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) cbs.get(e.target)?.(e.isIntersecting);
      },
      { threshold, rootMargin },
    );
    o = { io, cbs };
    observers.set(key, o);
  }
  o.cbs.set(el, cb);
  o.io.observe(el);
  const oo = o;
  return () => {
    oo.cbs.delete(el);
    oo.io.unobserve(el);
  };
}

export interface InViewOptions {
  once?: boolean;
  threshold?: number;
  rootMargin?: string;
}

/** Calls `cb(inView)` as the element enters / leaves the viewport (once: only the first entry). */
export function useInViewCallback(ref: RefObject<Element | null>, cb: (inView: boolean) => void, { once = true, threshold = 0.15, rootMargin = '0px 0px -8% 0px' }: InViewOptions = {}) {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let done = false;
    const off = observe(
      el,
      (v) => {
        if (done) return;
        cbRef.current(v);
        if (v && once) {
          done = true;
          off();
        }
      },
      threshold,
      rootMargin,
    );
    return off;
  }, [ref, once, threshold, rootMargin]);
}

export function useInView(ref: RefObject<Element | null>, opts: InViewOptions = {}): boolean {
  const [v, setV] = useState(false);
  useInViewCallback(ref, setV, opts);
  return v;
}

// ───────────────────────────────────────── Reveal ─────────────────────────────────────────

export function Reveal({
  as,
  children,
  delay = 0,
  y,
  stagger = false,
  mask = false,
  className = '',
  style,
  id,
  threshold,
  rootMargin,
  ...rest
}: {
  as?: ElementType;
  children: ReactNode;
  /** ms before the reveal starts. */
  delay?: number;
  /** Rise distance in px (default --rise = 18). */
  y?: number;
  /** Give direct children --i so they rise 80 ms apart. */
  stagger?: boolean;
  /** Headline line-mask mode (children use .sh-line > span). */
  mask?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  threshold?: number;
  rootMargin?: string;
  [k: `data-${string}`]: string | undefined;
}) {
  const Tag = (as ?? 'div') as ElementType;
  const ref = useRef<HTMLElement>(null);
  useInViewCallback(
    ref,
    (v) => {
      if (v) ref.current?.classList.add('in');
    },
    { threshold, rootMargin },
  );
  // Stagger: each direct child becomes a .rv with --i = index; the group's .in reveals them (motion.css).
  const kids = stagger
    ? Children.map(children, (c, i) => {
        if (!isValidElement(c)) return c;
        const el = c as ReactElement<{ className?: string; style?: CSSProperties }>;
        return cloneElement(el, { className: `${el.props.className ?? ''} rv`.trim(), style: { ...(el.props.style ?? {}), ['--i' as string]: i } });
      })
    : children;
  const cls = stagger ? 'rv-group' : mask ? 'rv-mask' : 'rv';
  const st: CSSProperties = { ...style };
  if (delay) (st as Record<string, string>)['--rv-delay'] = `${delay}ms`;
  if (y !== undefined) (st as Record<string, string>)['--rv-y'] = `${y}px`;
  return (
    <Tag ref={ref} id={id} className={`${cls} ${className}`.trim()} style={st} {...rest}>
      {kids}
    </Tag>
  );
}

// ───────────────────────────────────────── LazyMount ─────────────────────────────────────────

/** Mounts children only once they come near the viewport; reserves `minHeight` so nothing shifts. */
export function LazyMount({ children, minHeight, rootMargin = '200px 0px', className, style }: { children: ReactNode; minHeight: number; rootMargin?: string; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { rootMargin, threshold: 0 });
  return (
    <div ref={ref} className={className} style={{ minHeight, ...style }}>
      {v ? children : null}
    </div>
  );
}

// ───────────────────────────────────────── CountUp ─────────────────────────────────────────

const defaultFormat = (dp: number) => (v: number) =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '–';

export interface CountUpOptions {
  dp?: number;
  format?: (v: number) => string;
  duration?: number;
  from?: number;
  /** 'view' (default) starts when the element is revealed; 'mount' starts immediately. */
  start?: 'view' | 'mount';
  delay?: number;
  /** Count up only the first time this key is shown in a session (e.g. a night's hero numbers); later mounts show the final value. */
  onceKey?: string;
}

const countedKeys = new Set<string>();

/** Imperative count-up: writes textContent of `ref` (no React renders per frame). */
export function useCountUp(ref: RefObject<Element | null>, value: number, { dp = 0, format, duration = 1200, from = 0, start = 'view', delay = 0, onceKey }: CountUpOptions = {}) {
  const fmtRef = useRef(format ?? defaultFormat(dp));
  fmtRef.current = format ?? defaultFormat(dp);
  const shown = useRef<number | null>(null);
  const started = useRef(false);
  const raf = useRef(0);

  const run = useCallback(
    (to: number) => {
      const el = ref.current;
      if (!el) return;
      cancelAnimationFrame(raf.current);
      const level = motionLevel();
      const f = fmtRef.current;
      const a = shown.current ?? from;
      if (level !== 'full' || !Number.isFinite(to) || !Number.isFinite(a) || a === to) {
        el.textContent = f(to);
        shown.current = to;
        return;
      }
      const dur = duration;
      const t0 = performance.now() + delay;
      const tick = (now: number) => {
        const t = Math.min(1, Math.max(0, (now - t0) / dur));
        const v = a + (to - a) * easeOut(t);
        el.textContent = f(t >= 1 ? to : v);
        shown.current = v;
        if (t < 1) raf.current = requestAnimationFrame(tick);
        else shown.current = to;
      };
      raf.current = requestAnimationFrame(tick);
    },
    [ref, from, duration, delay],
  );

  // Before paint: show the start value (so the final number never flashes before counting).
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || shown.current !== null) return;
    if (motionLevel() !== 'full' || !Number.isFinite(value) || (onceKey && countedKeys.has(onceKey))) {
      shown.current = value;
      started.current = true;
      return;
    }
    if (onceKey) countedKeys.add(onceKey);
    el.textContent = fmtRef.current(from);
    shown.current = from;
    if (start === 'mount') {
      started.current = true;
      run(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInViewCallback(
    ref,
    (v) => {
      if (!v || started.current) return;
      started.current = true;
      run(value);
    },
    { threshold: 0.2, rootMargin: '0px' },
  );

  useEffect(() => {
    if (started.current) run(value);
  }, [value, run]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);
}

export function CountUp({ value, className = '', textClassName, style, ...opts }: { value: number; className?: string; /** Class for the visible digits only (e.g. 'grad-num' — gradient text must sit on the text span). */ textClassName?: string; style?: CSSProperties } & CountUpOptions) {
  const ref = useRef<HTMLSpanElement>(null);
  useCountUp(ref, value, opts);
  const final = (opts.format ?? defaultFormat(opts.dp ?? 0))(value);
  // Grid-stacks an invisible copy of the final string so the width never changes while counting.
  return (
    <span className={`num ${className}`} style={{ display: 'inline-grid', ...style }} aria-label={final} role="text">
      <span aria-hidden style={{ gridArea: '1/1', visibility: 'hidden' }}>
        {final}
      </span>
      <span ref={ref} aria-hidden className={textClassName} style={{ gridArea: '1/1', textAlign: 'inherit' }}>
        {final}
      </span>
    </span>
  );
}

// ───────────────────────────────────────── scroll progress ─────────────────────────────────────────

export interface ScrollProgressOptions {
  mode?: TrackMode;
  onProgress?: (p: number) => void;
  dwell?: number;
  /** Progress handed to onProgress under reduced motion (the final state). Default 1. */
  reducedValue?: number;
  cssVar?: boolean;
  chapterId?: string;
  enabled?: boolean;
}

export function useScrollProgress(ref: RefObject<HTMLElement | null>, { mode = 'pass', onProgress, dwell, reducedValue = 1, cssVar = false, chapterId, enabled = true }: ScrollProgressOptions = {}) {
  const cb = useRef(onProgress);
  cb.current = onProgress;
  const reduced = useReducedMotion();
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    if (reduced) {
      if (cssVar) el.style.setProperty('--p', String(reducedValue));
      cb.current?.(reducedValue);
      // Still registered (without callbacks) so chapter tracking keeps working.
      return chapterId ? register(el, { mode, dwell, cssVar: false, chapterId }) : undefined;
    }
    return register(el, { mode, dwell, cssVar, chapterId, onProgress: (p) => cb.current?.(p) });
  }, [ref, mode, dwell, reducedValue, cssVar, chapterId, enabled, reduced]);
}

// ───────────────────────────────────────── chapters ─────────────────────────────────────────

export type ChapterAccent = 'verdict' | 'lights' | 'night' | 'air' | 'bodies' | 'drivers' | 'tonight';
const ACCENTS: Record<ChapterAccent, string> = {
  verdict: 'var(--ac-verdict)',
  lights: 'var(--ac-lights)',
  night: 'var(--ac-night)',
  air: 'var(--ac-air)',
  bodies: 'var(--ac-bodies)',
  drivers: 'var(--ac-drivers)',
  tonight: 'var(--ac-tonight)',
};
export const accentVar = (a: ChapterAccent | string) => (a in ACCENTS ? ACCENTS[a as ChapterAccent] : a);

interface ChapterMeta {
  id: string;
  n?: number;
  title?: string;
  accent: string;
  el: HTMLElement;
}
const chapterMap = new Map<string, ChapterMeta>();
let chapterList: readonly Omit<ChapterMeta, 'el'>[] = [];
const listSubs = new Set<() => void>();
const progressSubs = new Map<string, Set<(p: number) => void>>();
const lastProgress = new Map<string, number>();

function rebuildList() {
  const metas = [...chapterMap.values()].sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  chapterList = metas.map(({ id, n, title, accent }) => ({ id, n, title, accent }));
  for (const f of listSubs) f();
}

/** Real (unremapped, not reduced) scroll progress of a chapter — for header segments. */
export function subscribeChapterProgress(id: string, fn: (p: number) => void): () => void {
  let s = progressSubs.get(id);
  if (!s) progressSubs.set(id, (s = new Set()));
  s.add(fn);
  const last = lastProgress.get(id);
  if (last !== undefined) fn(last);
  return () => {
    s!.delete(fn);
  };
}

/** Scrolls to a chapter's start (smooth unless reduced motion). */
export function scrollToChapter(id: string) {
  const m = chapterMap.get(id);
  if (!m) return;
  const top = trackTop(m.el) ?? m.el.getBoundingClientRect().top + window.scrollY;
  window.scrollTo({ top, behavior: prefersReduced() ? 'auto' : 'smooth' });
}

export function useChapterList() {
  return useSyncExternalStore(
    (cb) => {
      listSubs.add(cb);
      return () => listSubs.delete(cb);
    },
    () => chapterList,
    () => chapterList,
  );
}

let pageAccent: string | null = null;
/** Accent of the chapter being read (set by <StoryAccent/>), for chrome outside the story (tab bar, sheets). */
export const currentAccent = () => pageAccent;

/**
 * Leaf that keeps the tab bar / open sheets in the active chapter's accent. Renders nothing, so a chapter change
 * re-renders only this, and the property is written on those few elements, not on <html> (which would restyle
 * the whole document).
 */
export function StoryAccent() {
  const active = useActiveChapter();
  const list = useChapterList();
  useEffect(() => {
    const ac = list.find((c) => c.id === active)?.accent ?? null;
    pageAccent = ac;
    for (const el of document.querySelectorAll<HTMLElement>('.tabbar, .sheet-root')) {
      if (ac) el.style.setProperty('--ch-accent', ac);
      else el.style.removeProperty('--ch-accent');
    }
  }, [active, list]);
  useEffect(
    () => () => {
      pageAccent = null;
      for (const el of document.querySelectorAll<HTMLElement>('.tabbar, .sheet-root')) el.style.removeProperty('--ch-accent');
    },
    [],
  );
  return null;
}

export function useActiveChapter(): string | null {
  return useSyncExternalStore(subscribeChapter, getActiveChapter, () => null);
}

interface ChapterCtx {
  id: string;
  n?: number;
  title?: string;
  subscribe: (fn: (p: number) => void) => () => void;
}
const ChapterContext = createContext<ChapterCtx | null>(null);
export const useChapter = () => {
  const c = useContext(ChapterContext);
  return c ? { id: c.id, n: c.n, title: c.title } : null;
};

/**
 * Subscribe to the enclosing <Chapter>'s progress, remapped to [from, to]. The callback runs once per frame
 * while the chapter moves (and once immediately). Under reduced motion it receives the chapter's reducedProgress.
 */
export function useChapterProgress(cb: (p: number) => void, range: readonly [number, number] = [0, 1]) {
  const ctx = useContext(ChapterContext);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const [a, b] = range;
  useIsoLayoutEffect(() => {
    if (!ctx) return;
    return ctx.subscribe((p) => cbRef.current(remap(p, a, b)));
  }, [ctx, a, b]);
}

export function Chapter({
  id,
  n,
  title,
  accent = 'verdict',
  pinned,
  dwell,
  glow = false,
  outline = false,
  lazy = false,
  reducedProgress = 1,
  onProgress,
  className = '',
  innerClassName = '',
  style,
  children,
}: {
  id: string;
  /** Chapter number (shown as the outlined numeral, used by the header). */
  n?: number;
  title?: string;
  /** Chapter accent key or any CSS colour. Sets --ch-accent and --accent for everything inside. */
  accent?: ChapterAccent | string;
  /** Height in screens (e.g. 2.5 → 250svh) with a sticky 100svh stage. Omit for a normal-flow chapter. */
  pinned?: number;
  /** Hold zone at both ends of a pinned scrub (default 0.04). */
  dwell?: number;
  glow?: boolean;
  outline?: boolean;
  /** content-visibility: auto (non-pinned chapters far down the page). */
  lazy?: boolean;
  /** Progress given to content listeners under reduced motion (the final state). 0 for the hero. */
  reducedProgress?: number;
  onProgress?: (p: number) => void;
  className?: string;
  innerClassName?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const listeners = useRef(new Set<(p: number) => void>());
  const pRef = useRef(0);
  const reduced = useReducedMotion();
  const onP = useRef(onProgress);
  onP.current = onProgress;
  const accentCss = accentVar(accent);

  const ctx = useMemo<ChapterCtx>(
    () => ({
      id,
      n,
      title,
      subscribe(fn) {
        listeners.current.add(fn);
        fn(pRef.current);
        return () => listeners.current.delete(fn);
      },
    }),
    [id, n, title],
  );

  // Registry for the story header.
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    chapterMap.set(id, { id, n, title, accent: accentCss, el });
    rebuildList();
    return () => {
      chapterMap.delete(id);
      rebuildList();
    };
  }, [id, n, title, accentCss]);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const emitContent = (p: number) => {
      pRef.current = p;
      onP.current?.(p);
      for (const f of listeners.current) f(p);
    };
    if (reduced) {
      emitContent(reducedProgress);
    }
    const off = register(el, {
      mode: pinned && !reduced ? 'pin' : 'pass',
      dwell: pinned ? dwell : 0,
      chapterId: id,
      // Never write --p on the <section>: every descendant inherits it, so each frame would restyle the chapter.
      cssVar: false,
      onProgress: (p) => {
        lastProgress.set(id, p);
        const subs = progressSubs.get(id);
        if (subs) for (const f of subs) f(p);
        if (!reduced) emitContent(p);
      },
    });
    return off;
  }, [id, pinned, dwell, reduced, reducedProgress]);

  // Mark the chapter active while near the viewport (enables will-change on .will children).
  useInViewCallback(ref, (v) => ref.current?.classList.toggle('active', v), { once: false, threshold: 0, rootMargin: '25% 0px' });

  const st: CSSProperties = { ...style, ['--ch-accent' as string]: accentCss, ['--accent' as string]: accentCss };
  if (pinned) st.height = `${Math.round(pinned * 100)}svh`;
  return (
    <ChapterContext.Provider value={ctx}>
      <section ref={ref} id={id} data-chapter={id} data-pinned={pinned ? '' : undefined} className={`chapter ${lazy && !pinned ? 'lazy' : ''} ${className}`.trim()} style={st} aria-label={title}>
        <div className="pin">
          {glow && <div className="chapter-glow" aria-hidden />}
          {outline && n !== undefined && (
            <div className="chapter-num parallax" style={{ ['--speed' as string]: 0.3 }} aria-hidden>
              {String(n).padStart(2, '0')}
            </div>
          )}
          <div className={`chapter-inner ${innerClassName}`.trim()}>{children}</div>
        </div>
      </section>
    </ChapterContext.Provider>
  );
}

// ───────────────────────────────────────── drawing ─────────────────────────────────────────

export function DrawPath({
  scrub,
  delay,
  className = '',
  style,
  ...props
}: Omit<SVGProps<SVGPathElement>, 'ref'> & {
  /** Tie drawing to the enclosing chapter's progress over [from, to] (true = [0, 1]). Otherwise draws on reveal. */
  scrub?: boolean | readonly [number, number];
  /** Reveal delay in ms. */
  delay?: number;
}) {
  const ref = useRef<SVGPathElement>(null);
  const range: readonly [number, number] = scrub === true ? [0, 1] : scrub ? scrub : [0, 1];
  const ctx = useContext(ChapterContext);
  const scrubbing = !!scrub && !!ctx;
  useChapterProgress((p) => {
    if (scrubbing && ref.current) ref.current.style.strokeDashoffset = String(1 - p);
  }, range);
  useInViewCallback(
    ref,
    (v) => {
      if (v && !scrubbing) ref.current?.classList.add('in');
    },
    { threshold: 0, rootMargin: '0px 0px -10% 0px' },
  );
  const st: CSSProperties = { ...style };
  if (delay) (st as Record<string, string>)['--rv-delay'] = `${delay}ms`;
  return <path ref={ref} pathLength={1} className={`draw ${scrubbing ? 'scrub' : ''} ${className}`.trim()} style={st} {...props} />;
}

export function ScrubWipe({
  children,
  range = [0, 1],
  ghost = true,
  className = '',
  style,
  onProgress,
}: {
  children: ReactNode | ((copy: 'ghost' | 'bright') => ReactNode);
  range?: readonly [number, number];
  ghost?: boolean;
  className?: string;
  style?: CSSProperties;
  onProgress?: (p: number) => void;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useChapterProgress((p) => {
    if (outer.current) outer.current.style.transform = `translate3d(${((p - 1) * 100).toFixed(3)}%,0,0)`;
    if (inner.current) inner.current.style.transform = `translate3d(${((1 - p) * 100).toFixed(3)}%,0,0)`;
    onProgress?.(p);
  }, range);
  const render = (c: 'ghost' | 'bright') => (typeof children === 'function' ? children(c) : children);
  return (
    <div className={`wipe ${className}`.trim()} style={style}>
      <div className="wipe-ghost" aria-hidden style={{ visibility: ghost ? undefined : 'hidden' }}>
        {render('ghost')}
      </div>
      <div ref={outer} className="wipe-outer">
        <div ref={inner} className="wipe-inner">
          {render('bright')}
        </div>
      </div>
    </div>
  );
}

/** A vertical playhead moved with translateX(p · width) over its positioned parent. */
export function Cursor({ range = [0, 1], className = '', children, onProgress }: { range?: readonly [number, number]; className?: string; children?: ReactNode; onProgress?: (p: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useRef(0);
  const last = useRef(0);
  useIsoLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver((e) => {
      width.current = e[0]?.contentRect.width ?? parent.clientWidth;
      if (ref.current) ref.current.style.transform = `translate3d(${(last.current * width.current).toFixed(1)}px,0,0)`;
    });
    width.current = parent.clientWidth;
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
  useChapterProgress((p) => {
    last.current = p;
    if (ref.current) ref.current.style.transform = `translate3d(${(p * width.current).toFixed(1)}px,0,0)`;
    onProgress?.(p);
  }, range);
  return (
    <div ref={ref} className={`cursor ${className}`.trim()} aria-hidden>
      {children}
    </div>
  );
}

export function Parallax({ speed = 0.3, children, className = '', style }: { speed?: number; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`parallax ${className}`.trim()} style={{ ...style, ['--speed' as string]: speed }} aria-hidden>
      {children}
    </div>
  );
}

// ───────────────────────────────────────── sky ─────────────────────────────────────────

export interface SkyMix {
  dusk?: number;
  mid?: number;
  dawn?: number;
  /** Black (--bg) overlay on top of the sky, 0..1. */
  dim?: number;
}
const skyEls: { dusk?: HTMLElement | null; mid?: HTMLElement | null; dawn?: HTMLElement | null; dim?: HTMLElement | null } = {};
const skyState: Required<SkyMix> = { dusk: 0, mid: 0, dawn: 0, dim: 0 };

/** Sets sky layer opacities (only the keys given). Cheap: writes opacity only when it changed. */
export function setSky(mix: SkyMix) {
  for (const k of ['dusk', 'mid', 'dawn', 'dim'] as const) {
    const v = mix[k];
    if (v === undefined) continue;
    const c = Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
    if (c === skyState[k]) continue;
    skyState[k] = c;
    const el = skyEls[k];
    if (el) el.style.opacity = String(c);
  }
}

/** RETIRED in v2 (§8.3: flat --bg, no sky or stars). Kept so v1 screens compile; renders nothing. */
export function Sky(_props: { initial?: SkyMix }) {
  return null;
}

// ───────────────────────────────────────── view transitions ─────────────────────────────────────────

type VTDoc = Document & { startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<void> } };

/**
 * Runs `update` inside document.startViewTransition when supported and motion is 'full'; otherwise runs it
 * directly. kind 'theme' does a circular reveal from (x, y) (client px). Going into night mode is always instant.
 */
export function withViewTransition(update: () => void | Promise<void>, { kind = 'nav', x, y }: { kind?: 'nav' | 'theme'; x?: number; y?: number } = {}) {
  const doc = document as VTDoc;
  if (!doc.startViewTransition || motionLevel() !== 'full') {
    void update();
    return;
  }
  const root = document.documentElement;
  root.dataset.vt = kind;
  if (x !== undefined) root.style.setProperty('--vt-x', `${x}px`);
  if (y !== undefined) root.style.setProperty('--vt-y', `${y}px`);
  try {
    const vt = doc.startViewTransition(update);
    vt.finished.finally(() => {
      delete root.dataset.vt;
    });
  } catch {
    delete root.dataset.vt;
    void update();
  }
}

let pendingNav: (() => void) | null = null;

/** Router push wrapped in a view transition (resolved by useNavTransitionDone in the Shell). */
export function useNavigate() {
  const router = useRouter();
  return useCallback(
    (href: string) => {
      withViewTransition(
        () =>
          new Promise<void>((resolve) => {
            pendingNav?.();
            pendingNav = resolve;
            router.push(href);
            // Safety net only: the Shell's layout effect resolves this as soon as the new route commits.
            window.setTimeout(() => {
              if (pendingNav === resolve) pendingNav = null;
              resolve();
            }, 320);
          }),
      );
      // Without view transitions the promise above isn't created; withViewTransition calls update directly.
    },
    [router],
  );
}

/** Mount once (Shell): resolves the pending navigation transition when the new route has rendered. */
export function useNavTransitionDone() {
  const path = usePathname();
  useIsoLayoutEffect(() => {
    if (!pendingNav) return;
    const done = pendingNav;
    pendingNav = null;
    // Resolve directly: rendering is suppressed while the update callback is pending, so a rAF here would never
    // run and the transition would sit frozen until the safety timeout.
    done();
  }, [path]);
}
