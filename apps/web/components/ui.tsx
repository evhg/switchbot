'use client';
/**
 * Shared UI primitives (docs/DESIGN.md §7). Styles: styles/components.css. Motion: components/motion.tsx.
 *
 *   <Card title sub meta kicker href reveal={true} delay className id style>…</Card>
 *       Surface card. `kicker` = mono label above the title; `href` turns the title into a link with ↗;
 *       `reveal` (default true) rises in once on scroll; `flat` drops the chrome (edge-to-edge hero charts).
 *   <SectionHeader n={3} kicker="The night" lines={['Two people.', 'One sealed room.']} size="h1" />
 *       Mono kicker with leading rule + headline whose lines reveal through a mask. Line 2 takes --ch-accent
 *       (tone="muted" → --text-2).
 *   <MetricTile label value unit dp delta={{ text, tone }} spark={[{ts, v}]} sparkColor variant="tile"|"row" countUp />
 *   <DeltaChip tone="good"|"bad"|"neutral" dir="up"|"down"|"flat">+4 ms</DeltaChip>
 *   <Segmented value options onChange label size="md"|"lg" />     sliding-thumb segmented control (API unchanged)
 *   <JumpBar items={[{ id: 'air', label: 'Air' }]} />              sticky glass jump bar; tracks the section in view.
 *       Give each section `id` + `data-jump` (scroll-margin is set by CSS).
 *   <Button variant="primary"|"ghost"|"quiet" size="md"|"sm" href? icon? shine? …buttonProps>Arm tonight</Button>
 *   <Toggle checked onChange label />                               46×28 switch over a native checkbox
 *   <Sheet open onClose title kicker>…</Sheet>                      bottom sheet (portal, scrim, drag-down to close)
 *   <Skeleton w h r="md"|"pill"|"round"|"text" /> · <SkeletonText lines /> · <SkeletonRing size />
 *   <Loading text variant="page"|"story" />                         full-page skeleton (was a spinner)
 *   <Placeholder height text />                                     block skeleton (was "Analysing…")
 *   <Legend items /> · <Key color shape /> · <TableView columns rows caption /> · <StatusDot status />
 *   useWidth<T>() → [ref, width]                                     ResizeObserver-measured width
 */
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type PointerEvent as RPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons.tsx';
import { Reveal, currentAccent, useCountUp, useInViewCallback } from './motion.tsx';
import { Sparkline } from './charts/Sparkline.tsx';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// ───────────────────────────────────────── Card ─────────────────────────────────────────

export function Card({
  title,
  sub,
  meta,
  kicker,
  href,
  children,
  id,
  className = '',
  style,
  reveal = true,
  delay,
  flat = false,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  kicker?: ReactNode;
  href?: string;
  children: ReactNode;
  id?: string;
  className?: string;
  style?: CSSProperties;
  reveal?: boolean;
  delay?: number;
  flat?: boolean;
}) {
  const head = (title || meta || kicker) && (
    <div className="card-head">
      <div style={{ minWidth: 0 }}>
        {kicker && <div className="card-kicker t-label">{kicker}</div>}
        {title && (
          <h2 className="card-title">
            {href ? (
              <Link href={href}>
                {title}
                <Icon name="arrow-up-right" size={16} />
              </Link>
            ) : (
              title
            )}
          </h2>
        )}
        {sub && <div className="card-sub">{sub}</div>}
      </div>
      {meta && <div className="card-meta">{meta}</div>}
    </div>
  );
  const cls = `card ${flat ? 'flat' : ''} ${className}`.trim();
  if (!reveal)
    return (
      <section className={cls} id={id} style={style}>
        {head}
        {children}
      </section>
    );
  return (
    <Reveal as="section" className={cls} id={id} style={style} delay={delay}>
      {head}
      {children}
    </Reveal>
  );
}

// ───────────────────────────────────────── SectionHeader ─────────────────────────────────────────

export function SectionHeader({
  n,
  kicker,
  lines,
  size = 'h1',
  tone = 'accent',
  className = '',
  style,
}: {
  n?: number;
  kicker?: ReactNode;
  /** Headline lines; line 2 is drawn in the chapter accent (or --text-2 with tone="muted"). */
  lines: ReactNode[];
  size?: 'h1' | 'h2';
  tone?: 'accent' | 'muted';
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Reveal as="header" mask className={`sh ${tone === 'muted' ? 'mono-2' : ''} ${className}`.trim()} style={style}>
      {(kicker || n !== undefined) && (
        <div className="sh-kicker t-label">
          {n !== undefined && <span>{String(n).padStart(2, '0')}</span>}
          {kicker && <span>{kicker}</span>}
        </div>
      )}
      <h2 className={`sh-title t-${size}`}>
        {lines.map((l, i) => (
          <span className="sh-line" key={i}>
            <span style={{ ['--i' as string]: i }}>{l}</span>
          </span>
        ))}
      </h2>
    </Reveal>
  );
}

// ───────────────────────────────────────── DeltaChip / MetricTile ─────────────────────────────────────────

export type Tone = 'good' | 'bad' | 'neutral';

export function DeltaChip({ tone = 'neutral', dir, children, title }: { tone?: Tone; dir?: 'up' | 'down' | 'flat'; children: ReactNode; title?: string }) {
  return (
    <span className={`delta ${tone}`} title={title}>
      {dir && dir !== 'flat' && <i aria-hidden>{dir === 'up' ? '▲' : '▼'}</i>}
      {children}
    </span>
  );
}

function CountNum({ value, dp }: { value: number; dp: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useCountUp(ref, value, { dp });
  return <span ref={ref}>{Number.isFinite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '–'}</span>;
}

export function MetricTile({
  label,
  value,
  unit,
  dp = 0,
  countUp = true,
  sub,
  delta,
  spark,
  sparkColor = 'var(--text-2)',
  variant = 'tile',
  big = false,
  icon,
  className = '',
  style,
}: {
  label: ReactNode;
  /** A number (formatted with dp, counts up) or any node. */
  value: number | ReactNode;
  unit?: ReactNode;
  dp?: number;
  countUp?: boolean;
  sub?: ReactNode;
  delta?: { text: ReactNode; tone?: Tone; dir?: 'up' | 'down' | 'flat' };
  spark?: { ts: number; v: number }[];
  sparkColor?: string;
  variant?: 'tile' | 'row';
  /** .t-big value (64 px) instead of the tile size. */
  big?: boolean;
  icon?: IconName;
  className?: string;
  style?: CSSProperties;
}) {
  const v =
    typeof value === 'number' ? (
      countUp ? (
        <CountNum value={value} dp={dp} />
      ) : Number.isFinite(value) ? (
        value.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
      ) : (
        '–'
      )
    ) : (
      value
    );
  const num = (
    <span className={big ? 't-big' : variant === 'row' ? 't-stat' : 'tile-value'} style={variant === 'tile' && !big ? { marginTop: 0 } : undefined}>
      {v}
      {unit && <span className={variant === 'row' || big ? 't-unit' : 'tile-unit'}>{unit}</span>}
    </span>
  );
  if (variant === 'row')
    return (
      <div className={`mt-row ${className}`.trim()} style={style}>
        <div className="mt-label t-label">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {icon && <Icon name={icon} size={14} />}
            {label}
          </span>
          {sub && <span className="small muted" style={{ textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--font)' }}>{sub}</span>}
        </div>
        <div className="mt-value">{num}</div>
        <div className="mt-side">
          {spark && spark.length > 1 && (
            <div style={{ width: 46 }}>
              <Sparkline values={spark} color={sparkColor} height={26} />
            </div>
          )}
          {delta && (
            <DeltaChip tone={delta.tone} dir={delta.dir}>
              {delta.text}
            </DeltaChip>
          )}
        </div>
      </div>
    );
  return (
    <div className={`tile ${className}`.trim()} style={style}>
      <div className="tile-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon && <Icon name={icon} size={14} />}
        {label}
      </div>
      <div style={{ marginTop: 8 }}>{num}</div>
      {(delta || sub) && (
        <div className="tile-delta" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {delta && (
            <DeltaChip tone={delta.tone} dir={delta.dir}>
              {delta.text}
            </DeltaChip>
          )}
          {sub}
        </div>
      )}
      {spark && spark.length > 1 && (
        <div className="tile-spark">
          <Sparkline values={spark} color={sparkColor} height={26} />
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────── Segmented ─────────────────────────────────────────

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  className = '',
}: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label?: string;
  size?: 'md' | 'lg';
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const place = useCallback(() => {
    const r = root.current;
    const t = thumb.current;
    if (!r || !t) return;
    const btn = r.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    if (!btn) {
      t.style.opacity = '0';
      return;
    }
    t.style.opacity = '1';
    t.style.width = `${btn.offsetWidth}px`;
    t.style.transform = `translate3d(${btn.offsetLeft}px,0,0)`;
  }, []);
  useIsoLayoutEffect(() => {
    const t = thumb.current;
    // First placement without animation.
    if (t && !t.dataset.ready) {
      t.style.transition = 'none';
      place();
      void t.offsetWidth;
      t.style.transition = '';
      t.dataset.ready = '1';
    } else place();
  }, [value, options.length, place]);
  useEffect(() => {
    const r = root.current;
    if (!r) return;
    const ro = new ResizeObserver(place);
    ro.observe(r);
    document.fonts?.ready.then(place).catch(() => {});
    return () => ro.disconnect();
  }, [place]);
  return (
    <div ref={root} className={`seg has-thumb ${size === 'lg' ? 'lg' : ''} ${className}`.trim()} role="group" aria-label={label}>
      <span ref={thumb} className="seg-thumb" aria-hidden />
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────────────────────── JumpBar ─────────────────────────────────────────

/** Sticky glass jump bar for dense tabs. Sections need `id` and `data-jump`. */
export function JumpBar({ items, label = 'Sections' }: { items: readonly { id: string; label: ReactNode }[]; label?: string }) {
  const [active, setActive] = useState(items[0]?.id ?? '');
  const lock = useRef(0);
  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        if (Date.now() < lock.current) return;
        if (atEnd()) return setActive(items.at(-1)!.id);
        const first = items.find((i) => seen.get(i.id));
        if (first) setActive(first.id);
      },
      { rootMargin: '-120px 0px -55% 0px' },
    );
    els.forEach((e) => io.observe(e));
    // A short last section never reaches the observer's band: at the bottom of the page it wins.
    const atEnd = () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
    let wasEnd = false;
    const onScroll = () => {
      const end = atEnd();
      if (end === wasEnd || Date.now() < lock.current) return;
      wasEnd = end;
      if (end) setActive(items.at(-1)!.id);
      else {
        const first = items.find((i) => seen.get(i.id));
        if (first) setActive(first.id);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, [items]);
  return (
    <nav className="jumpbar" aria-label={label}>
      <Segmented
        value={active}
        options={items.map((i) => ({ value: i.id, label: i.label }))}
        onChange={(id) => {
          setActive(id);
          lock.current = Date.now() + 900;
          const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          document.getElementById(id)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        }}
        label={label}
      />
    </nav>
  );
}

// ───────────────────────────────────────── Button / Toggle ─────────────────────────────────────────

export function Button({
  variant = 'ghost',
  size = 'md',
  href,
  icon,
  shine,
  children,
  className = '',
  ...rest
}: {
  variant?: 'primary' | 'ghost' | 'quiet';
  size?: 'md' | 'sm';
  href?: string;
  icon?: IconName;
  /** Diagonal shine once on reveal (primary only by default; off in night mode). */
  shine?: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLElement>(null);
  const withShine = shine ?? variant === 'primary';
  useInViewCallback(ref, (v) => v && withShine && ref.current?.classList.add('in'), { threshold: 0.6 });
  const cls = `btn ${variant} ${size === 'sm' ? 'sm' : ''} ${className}`.trim();
  const inner = (
    <>
      {withShine && <span className="shine" aria-hidden />}
      {children}
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
    </>
  );
  if (href)
    return (
      <Link ref={ref as RefObject<HTMLAnchorElement>} href={href} className={cls}>
        {inner}
      </Link>
    );
  return (
    <button ref={ref as RefObject<HTMLButtonElement>} type="button" className={cls} {...rest}>
      {inner}
    </button>
  );
}

export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; id?: string }) {
  return (
    <label className="toggle" style={disabled ? { opacity: 0.45 } : undefined}>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden>
        <span className="toggle-knob" />
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

// ───────────────────────────────────────── Sheet ─────────────────────────────────────────

export function Sheet({ open, onClose, title, kicker, children }: { open: boolean; onClose: () => void; title?: ReactNode; kicker?: ReactNode; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y0: number; dy: number } | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = window.setTimeout(() => setMounted(false), reduce ? 0 : 430);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    sheet.current?.focus({ preventScroll: true });
    return () => {
      document.documentElement.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!mounted || typeof document === 'undefined') return null;
  const onDown = (e: RPointerEvent) => {
    drag.current = { y0: e.clientY, dy: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (sheet.current) sheet.current.style.transition = 'none';
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag.current || !sheet.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y0);
    sheet.current.style.transform = `translate3d(0,${drag.current.dy}px,0)`;
  };
  const onUp = () => {
    if (!drag.current || !sheet.current) return;
    const { dy } = drag.current;
    drag.current = null;
    sheet.current.style.transition = '';
    sheet.current.style.transform = '';
    if (dy > 90) onClose();
  };
  return createPortal(
    <div className={`sheet-root ${shown ? 'open' : ''}`} style={currentAccent() ? { ['--ch-accent' as string]: currentAccent()! } : undefined} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet" ref={sheet} tabIndex={-1}>
        <div className="sheet-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className="sheet-grab" aria-hidden />
            {kicker && <div className="t-label accent" style={{ marginBottom: 6 }}>{kicker}</div>}
            {title && <h2 className="sheet-title">{title}</h2>}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} onPointerDown={(e) => e.stopPropagation()} style={{ marginTop: 10 }}>
            <Icon name="close" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ───────────────────────────────────────── Skeletons ─────────────────────────────────────────

export function Skeleton({ w = '100%', h = 16, r = 'md', className = '', style }: { w?: number | string; h?: number | string; r?: 'md' | 'pill' | 'round' | 'text' | 'lg'; className?: string; style?: CSSProperties }) {
  const cls = r === 'md' ? '' : r === 'lg' ? '' : r;
  return <div className={`sk ${cls} ${className}`.trim()} style={{ width: w, height: h, borderRadius: r === 'lg' ? 'var(--r-lg)' : undefined, ...style }} aria-hidden />;
}

export function SkeletonText({ lines = 3, size = 14, last = 0.6 }: { lines?: number; size?: number; last?: number }) {
  return (
    <div style={{ display: 'grid', gap: size * 0.55 }} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} r="text" h={size} w={i === lines - 1 && lines > 1 ? `${last * 100}%` : '100%'} />
      ))}
    </div>
  );
}

export function SkeletonRing({ size = 96 }: { size?: number }) {
  return <div className="sk round" style={{ width: size, height: size }} aria-hidden />;
}

/** Full-screen loading state shaped like the final layout. `story` = Today hero, `page` = dense tabs. */
export function Loading({ text = 'Loading…', variant = 'page' }: { text?: string; variant?: 'page' | 'story' }) {
  if (variant === 'story')
    return (
      <div className="loading" role="status" aria-live="polite" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 84px)', maxWidth: 560, margin: '0 auto' }}>
        <Skeleton w={180} h={11} r="text" />
        <Skeleton w="62%" h={170} r="lg" style={{ marginTop: 16 }} />
        <Skeleton w={160} h={11} r="text" />
        <div style={{ marginTop: 16 }}>
          <SkeletonText lines={2} size={20} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 20 }}>
          {[0, 1].map((i) => (
            <div key={i} className="card" style={{ display: 'grid', justifyItems: 'center', gap: 10 }}>
              <SkeletonRing size={96} />
              <Skeleton w={70} h={11} r="text" />
            </div>
          ))}
        </div>
        <div className="sk-status t-label" style={{ marginTop: 8 }}>{text}</div>
      </div>
    );
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="page-head" style={{ alignItems: 'flex-end' }}>
        <div style={{ display: 'grid', gap: 10, flex: 1 }}>
          <Skeleton w={90} h={10} r="text" />
          <Skeleton w="55%" h={38} r="text" />
          <Skeleton w={140} h={10} r="text" />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Skeleton w={36} h={36} r="round" />
          <Skeleton w={36} h={36} r="round" />
          <Skeleton w={36} h={36} r="round" />
        </div>
      </div>
      <div className="tiles">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="tile" style={{ display: 'grid', gap: 10 }}>
            <Skeleton w="50%" h={10} r="text" />
            <Skeleton w="70%" h={28} r="text" />
          </div>
        ))}
      </div>
      {[220, 180].map((h, i) => (
        <div key={i} className="card" style={{ display: 'grid', gap: 12 }}>
          <Skeleton w="40%" h={18} r="text" />
          <Skeleton h={h} />
        </div>
      ))}
      <div className="sk-status t-label">{text}</div>
    </div>
  );
}

/** Block skeleton with the final content's height (no layout shift). */
export function Placeholder({ height = 160, text }: { height?: number; text?: string }) {
  return (
    <div role="status" aria-label={text ?? 'Loading'} style={{ height, display: 'grid', gap: 8, gridTemplateRows: text ? '1fr auto' : '1fr' }}>
      <Skeleton h="100%" />
      {text && <div className="small muted">{text}</div>}
    </div>
  );
}

// ───────────────────────────────────────── Legend / Key / Table / Status ─────────────────────────────────────────

export type KeyShape = 'line' | 'dash' | 'dot' | 'rect';
export function Legend({ items }: { items: { label: ReactNode; color: string; shape?: KeyShape }[] }) {
  return (
    <div className="legend">
      {items.map((it, i) => (
        <span key={i}>
          <Key color={it.color} shape={it.shape ?? 'line'} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export function Key({ color, shape = 'line' }: { color: string; shape?: KeyShape }) {
  if (shape === 'dot') return <i className="key-dot" style={{ background: color }} />;
  if (shape === 'rect') return <i className="key-rect" style={{ background: color }} />;
  return <i className={shape === 'dash' ? 'key-dash' : 'key-line'} style={{ color }} />;
}

/** Measures its own width so custom SVG charts can draw at device pixels. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Accessible table fallback behind a toggle (every chart value stays reachable without hovering). */
export function TableView({ columns, rows, caption }: { columns: string[]; rows: (string | number)[][]; caption?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="table-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Hide table' : 'Show table'}
      </button>
      {open && (
        <div className="scroll-x" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table className="data-table">
            {caption && <caption className="hidden">{caption}</caption>}
            <thead>
              <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function StatusDot({ status }: { status: 'good' | 'warn' | 'serious' | 'critical' }) {
  return <i className="status-dot" style={{ background: `var(--${status})` }} aria-hidden />;
}
