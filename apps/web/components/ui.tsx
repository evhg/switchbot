'use client';
/**
 * Shared UI primitives, v2 "Instrument" (docs/DESIGN.md §6). Styles: styles/components.css (+ type roles in
 * styles/base.css). Motion: components/motion.tsx. Navigation model + top bar context: components/nav.tsx.
 *
 * TYPE: use the role classes, never ad-hoc sizes: .display (.display.hero) · .reading · .title · .head · .body · .sec
 *   · .cap · .label (THE one label style) · .unit · .num · .code (Diagnostics only). Ink: .ink · .ink-2 · .ink-3 · .sig.
 * LAYOUT (in .shell): .grid12 > .c-5/.c-7/… · .split (5/12 + 7/12 ≥1440) · .cols (style --n) · .measure (672)
 *   · .measure-plan (832) · .measure-text · .vstack/.hstack (style --gap) · .bleed · .hair · .section · .hero
 *
 * ── Page structure ──────────────────────────────────────────────────────────────────────────────────────────
 *   <PageHeader title="Room" lede="One sentence." actions={<Segmented …/>} />   h1.title + .lede (no kicker/badge)
 *   <Section id="air" title="CO₂ crossed 1,000 at 02:44" cap="ppm, 5-min means" nav="Air" actions={…}>…</Section>
 *       title = the finding (.head). `nav` lists it in the ≥1760 "On this page" rail. `reveal` (default true).
 *   <OnThisPage />                          fixed right rail ≥1760; collects [data-onpage] sections on the page
 *   <MoreAnalysis items={[{ label, value?, onClick | href }]} />   "More analysis" list group (opens sheet / page)
 *
 * ── Surfaces & lists ────────────────────────────────────────────────────────────────────────────────────────
 *   <Card title action={{ label: 'Edit', href }} className>…</Card>   ONE interactive object; cards never nest
 *   <FeaturedCard title="Tonight's plan" action={{ label: 'Edit', href }}>…</FeaturedCard>   max one per screen
 *   <Group label="Household" footer="…">  <Row title sub value href|onClick chevron trailing={<Switch/>} />  </Group>
 *       inset grouped list; rows 56 / 52 px; separators inset to the text; no icon tiles.
 *
 * ── Controls ────────────────────────────────────────────────────────────────────────────────────────────────
 *   <Button variant="primary"|"secondary"|"text" size="md"|"sm" href? icon? block?>   48 px pill; ONE primary/screen
 *       (v1 'ghost' → secondary, 'quiet' → text). Night: primary is outlined.
 *   <Segmented value options onChange label size block />   role=radiogroup, ←/→ keys, sliding thumb
 *   <Chip selected onClick>Door ajar</Chip>   <Chips>…</Chips>   44 px; selected = ink fill + signal dot
 *   <Switch checked onChange label disabled id />   52×32, role=switch (Toggle = alias)
 *   <Field label hint htmlFor>…<Input …/></Field>   <Input {...inputProps} />   48 px, bordered, label above
 *   <PersonField letter person="a"|"b" label="Person 1" value onChange placeholder maxLength />
 *   <IconButton icon label onClick disabled outline />   44 px round
 *
 * ── Instrument parts ────────────────────────────────────────────────────────────────────────────────────────
 *   <Dial label="Starts" value="23:57" meaning="after lights out" onDec onInc decLabel="Earlier" incLabel="Later" />
 *   <InstrumentKeys label="Phases" items={[{ id, name, meta, glides }]} value onChange />   arrows move
 *   <Readouts n={4}><Readout label="Lights out" value="23:12" unit? alert? large? /></Readouts>
 *   <Stat value="4h 02m" unit? meaning="above 1,000 ppm, 02:44 – 06:46" size="reading"|"display" />
 *   <Delta dir="down" typical="53">4 bpm</Delta>   neutral "↓ 4 bpm · typical 53" (alert = signal, drivers only)
 *   <EventList items={[{ time: '21:47', title: 'Aircon on', detail? }]} />
 *   <Status tone="ok"|"on"|"alert">Connected</Status>   6 px dot + .sec text, no pill
 *   <Disclosure title="Last night's aircon log" count="7 commands" defaultOpen>…</Disclosure>
 *   <AdviceCard title="Crack the door 2 cm." reason primary={{ label, href|onClick }} secondary={{ label, onClick }} />
 *   <ThemeThumbs value onChange />   Auto / Light / Dark / Night miniature windows, no numbers
 *   <Sheet open onClose title wide>…</Sheet>   phone bottom sheet (grabber, swipe, Esc, scrim) / desktop right panel
 *
 * ── Loading & data helpers ──────────────────────────────────────────────────────────────────────────────────
 *   <Skeleton w h r="md"|"pill"|"round"|"text"|"lg" /> · <SkeletonText lines size /> · <SkeletonRing size />
 *   <Loading text variant="page"|"story" /> · <Placeholder height text />   final geometry, no shimmer at night
 *   <Key color shape="line"|"dash"|"dot"|"rect" /> · <TableView columns rows caption /> · useWidth<T>() → [ref, w]
 *
 * ── DEPRECATED v1 (still exported so un-migrated screens build; restyled calm; do not use in new code) ───────
 *   SectionHeader (→ PageHeader / Section) · MetricTile (→ Readout / Stat) · DeltaChip (→ Delta) · Legend (→ label
 *   series on the chart) · JumpBar (→ renders <OnThisPage> from its items) · Toggle (→ Switch) · StatusDot (→ Status)
 */
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent as RKeyboardEvent,
  type PointerEvent as RPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { ThemeMode } from '@/lib/theme.tsx';
import { Icon, type IconName } from './icons.tsx';
import { Reveal, useCountUp } from './motion.tsx';
import { Sparkline } from './charts/Sparkline.tsx';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type Action = { label: ReactNode; href?: string; onClick?: () => void };

function ActionLink({ action, className = 'card-action' }: { action: Action; className?: string }) {
  const inner = (
    <>
      {action.label}
      <Icon name="chevron-right" size={18} />
    </>
  );
  if (action.href)
    return (
      <Link href={action.href} className={className}>
        {inner}
      </Link>
    );
  return (
    <button type="button" className={className} onClick={action.onClick} style={{ background: 'none', border: 0 }}>
      {inner}
    </button>
  );
}

// ───────────────────────────────────────── Page structure ─────────────────────────────────────────

export function PageHeader({ title, lede, actions, className = '' }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <Reveal as="header" className={cx('page-header', className)} y={12}>
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </Reveal>
  );
}

export function Section({
  id,
  title,
  cap,
  nav,
  actions,
  reveal = true,
  className = '',
  style,
  children,
}: {
  id?: string;
  /** The finding, as one sentence-case sentence (.head). */
  title?: ReactNode;
  /** Optional method / units line under the title (.cap). */
  cap?: ReactNode;
  /** Label in the "On this page" rail (needs `id`). */
  nav?: string;
  actions?: ReactNode;
  reveal?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const head = (title || actions) && (
    <div className="section-head">
      <div style={{ minWidth: 0 }}>
        {title && <h2>{title}</h2>}
        {cap && <p className="cap">{cap}</p>}
      </div>
      {actions}
    </div>
  );
  const props = { id, className: cx('section', className), style, 'data-onpage': nav && id ? nav : undefined } as const;
  if (!reveal)
    return (
      <section {...props}>
        {head}
        {children}
      </section>
    );
  return (
    <Reveal as="section" {...props}>
      {head}
      {children}
    </Reveal>
  );
}

/** "On this page" rail (≥1760 only). Items default to every [data-onpage] / [data-jump] element on the page. */
export function OnThisPage({ items: given, label = 'On this page' }: { items?: readonly { id: string; label: ReactNode }[]; label?: string }) {
  const [found, setFound] = useState<{ id: string; label: ReactNode }[]>([]);
  const items = given ?? found;
  const [active, setActive] = useState('');
  useEffect(() => {
    if (given) return;
    const els = [...document.querySelectorAll<HTMLElement>('.page [data-onpage]')];
    setFound(els.filter((e) => e.id).map((e) => ({ id: e.id, label: e.dataset.onpage || e.id })));
  }, [given]);
  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    // Geometry on every scroll frame (not IntersectionObserver enter events, which go stale when scrolling back up):
    // the current section is the last one whose top is above 35% of the viewport; above the first, the first.
    let raf = 0;
    const pick = () => {
      raf = 0;
      if (window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8) return setActive(items.at(-1)!.id);
      const line = window.innerHeight * 0.35;
      let cur = els[0]!.id;
      for (const e of els) if (e.getBoundingClientRect().top <= line) cur = e.id;
      setActive(cur);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(pick);
    };
    pick();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [items]);
  if (!items.length) return null;
  return (
    <nav className="onpage" aria-label={label}>
      <ol>
        {items.map((i) => (
          <li key={i.id}>
            <a
              href={`#${i.id}`}
              aria-current={active === i.id ? 'true' : undefined}
              onClick={(e) => {
                e.preventDefault();
                setActive(i.id);
                document.getElementById(i.id)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
              }}
            >
              {i.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** "More analysis": the long tail of a screen as one list group (rows open a sheet on phone, a panel/page on desktop). */
export function MoreAnalysis({ items, label = 'More analysis', id = 'more' }: { items: readonly { label: ReactNode; value?: ReactNode; href?: string; onClick?: () => void }[]; label?: string; id?: string }) {
  return (
    <Section id={id} nav={label} reveal={false}>
      <Group label={label}>
        {items.map((it, i) => (
          <Row key={i} title={it.label} value={it.value} href={it.href} onClick={it.onClick} chevron />
        ))}
      </Group>
    </Section>
  );
}

// ───────────────────────────────────────── Surfaces & lists ─────────────────────────────────────────

/**
 * A card wraps ONE self-contained interactive object (§6). v1 props still accepted: `kicker` renders as a .label
 * above the title, `sub` as .sec, `meta` on the right, `href` turns the title into a link, `flat` drops the chrome.
 */
export function Card({
  title,
  sub,
  meta,
  kicker,
  href,
  action,
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
  /** @deprecated v1 eyebrow; shown as a plain .label. */
  kicker?: ReactNode;
  href?: string;
  action?: Action;
  children: ReactNode;
  id?: string;
  className?: string;
  style?: CSSProperties;
  reveal?: boolean;
  delay?: number;
  flat?: boolean;
}) {
  const head = (title || meta || kicker || action) && (
    <div className="card-head">
      <div style={{ minWidth: 0 }}>
        {kicker && <div className="label" style={{ marginBottom: 4 }}>{kicker}</div>}
        {title && (
          <h2 className="card-title">
            {href ? (
              <Link href={href}>
                {title}
                <Icon name="chevron-right" size={18} />
              </Link>
            ) : (
              title
            )}
          </h2>
        )}
        {sub && <div className="card-sub">{sub}</div>}
      </div>
      {meta && <div className="card-meta">{meta}</div>}
      {action && <ActionLink action={action} />}
    </div>
  );
  const cls = cx('card', flat && 'flat', className);
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

export function FeaturedCard({ title, action, children, className = '' }: { title: ReactNode; action?: Action; children: ReactNode; className?: string }) {
  return (
    <Card title={title} action={action} className={cx('featured', className)}>
      {children}
    </Card>
  );
}

export function Group({ label, footer, children, className = '', id }: { label?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  const lid = useId();
  return (
    <div className={cx('group', className)} id={id}>
      {label && (
        <h3 className="label group-label" id={lid}>
          {label}
        </h3>
      )}
      <ul className="list-group" aria-labelledby={label ? lid : undefined}>
        {children}
      </ul>
      {footer && <p className="group-foot">{footer}</p>}
    </div>
  );
}

/** A list-group row. Interactive when `href` or `onClick`; `trailing` holds a control (Switch, Segmented …). */
export function Row({
  title,
  sub,
  value,
  href,
  onClick,
  chevron,
  trailing,
  current,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  value?: ReactNode;
  href?: string;
  onClick?: () => void;
  chevron?: boolean;
  trailing?: ReactNode;
  /** Marks the row as the open page (desktop master list). */
  current?: boolean;
  children?: ReactNode;
}) {
  const inner = (
    <>
      <span className="list-row-t">
        <b>{title}</b>
        {sub && <span>{sub}</span>}
        {children}
      </span>
      {value !== undefined && value !== null && <span className="list-row-v">{value}</span>}
      {trailing}
      {(chevron ?? !!(href || onClick)) && <Icon name="chevron-right" size={18} className="list-row-c" />}
    </>
  );
  return (
    <li>
      {href ? (
        <Link href={href} className="list-row" aria-current={current ? 'page' : undefined}>
          {inner}
        </Link>
      ) : onClick ? (
        <button type="button" className="list-row" onClick={onClick}>
          {inner}
        </button>
      ) : (
        <div className="list-row">{inner}</div>
      )}
    </li>
  );
}

// ───────────────────────────────────────── Buttons ─────────────────────────────────────────

export function Button({
  variant = 'secondary',
  size = 'md',
  href,
  icon,
  block,
  shine: _shine,
  children,
  className = '',
  ...rest
}: {
  /** 'ghost' and 'quiet' are v1 names for 'secondary' and 'text'. */
  variant?: 'primary' | 'secondary' | 'text' | 'ghost' | 'quiet';
  size?: 'md' | 'sm';
  href?: string;
  icon?: IconName;
  block?: boolean;
  /** @deprecated v1 shine sweep; ignored. */
  shine?: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const v = variant === 'ghost' ? 'secondary' : variant === 'quiet' ? 'text' : variant;
  const cls = cx('btn', v, size === 'sm' && 'sm', block && 'block', className);
  const inner = (
    <>
      {children}
      {icon && <Icon name={icon} size={18} />}
    </>
  );
  if (href)
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    );
  return (
    <button type="button" className={cls} {...rest}>
      {inner}
    </button>
  );
}

export function IconButton({ icon, label, onClick, disabled, outline, size = 20 }: { icon: IconName; label: string; onClick?: () => void; disabled?: boolean; outline?: boolean; size?: number }) {
  return (
    <button type="button" className={cx('icon-btn', outline && 'outline')} aria-label={label} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={size} />
    </button>
  );
}

// ───────────────────────────────────────── Segmented ─────────────────────────────────────────

/** Arrow-key handler for a radiogroup of buttons. */
function radioKeys<T>(values: readonly T[], value: T, onChange: (v: T) => void) {
  return (e: RKeyboardEvent<HTMLElement>) => {
    const i = values.indexOf(value);
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % values.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + values.length) % values.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = values.length - 1;
    if (j < 0) return;
    e.preventDefault();
    onChange(values[j]!);
    const btns = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]');
    btns[j]?.focus();
  };
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  block = false,
  className = '',
}: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label?: string;
  size?: 'md' | 'lg';
  block?: boolean;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const place = useCallback(() => {
    const r = root.current;
    const t = thumb.current;
    if (!r || !t) return;
    const btn = r.querySelector<HTMLButtonElement>('button[aria-checked="true"]');
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
    <div
      ref={root}
      className={cx('seg has-thumb', size === 'lg' && 'lg', block && 'block', className)}
      role="radiogroup"
      aria-label={label}
      onKeyDown={radioKeys(
        options.map((o) => o.value),
        value,
        onChange,
      )}
    >
      <span ref={thumb} className="seg-thumb" aria-hidden />
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────── Chip / Switch / Field ─────────────────────────────────────────

export function Chip({ selected, onClick, children, disabled }: { selected?: boolean; onClick?: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className="chip" aria-pressed={selected} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
export function Chips({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; id?: string }) {
  return (
    <label className="switch" style={disabled ? { opacity: 0.45 } : undefined}>
      <input id={id} type="checkbox" role="switch" aria-checked={checked} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden>
        <span className="toggle-knob" />
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}
/** @deprecated v1 name of Switch. */
export const Toggle = Switch;

export function Field({ label, hint, htmlFor, children, className = '' }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('field', className)}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx('input', className)} {...props} />;
}

export function PersonField({
  letter,
  person = 'a',
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  id,
}: {
  letter: string;
  person?: 'a' | 'b';
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  id?: string;
}) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className={cx('person-field', person === 'b' ? 'p-erik' : 'p-you')}>
      <span className="avatar" aria-hidden>
        {letter.slice(0, 1).toUpperCase()}
      </span>
      <div className="person-field-t">
        <label className="label" htmlFor={fid}>
          {label}
        </label>
        <input id={fid} className="input" value={value} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}

// ───────────────────────────────────────── Instrument parts ─────────────────────────────────────────

export function Dial({
  label,
  value,
  meaning,
  onDec,
  onInc,
  decLabel = 'Less',
  incLabel = 'More',
  decDisabled,
  incDisabled,
  className = '',
}: {
  label: ReactNode;
  value: ReactNode;
  meaning?: ReactNode;
  onDec: () => void;
  onInc: () => void;
  decLabel?: string;
  incLabel?: string;
  decDisabled?: boolean;
  incDisabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cx('card dial', className)}>
      <div className="label">{label}</div>
      <div className="dial-row">
        <button type="button" className="dial-btn" aria-label={decLabel} onClick={onDec} disabled={decDisabled}>
          <Icon name="minus" size={20} />
        </button>
        <div className="dial-v reading" aria-live="polite">
          {value}
        </div>
        <button type="button" className="dial-btn" aria-label={incLabel} onClick={onInc} disabled={incDisabled}>
          <Icon name="plus" size={20} />
        </button>
      </div>
      {meaning && <div className="dial-m cap">{meaning}</div>}
    </div>
  );
}

export function InstrumentKeys<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly { id: T; name: ReactNode; meta?: ReactNode; glides?: boolean }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div
      className="keys"
      role="radiogroup"
      aria-label={label}
      onKeyDown={radioKeys(
        items.map((i) => i.id),
        value,
        onChange,
      )}
    >
      {items.map((it) => {
        const on = it.id === value;
        return (
          <button key={it.id} type="button" className="key" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} onClick={() => onChange(it.id)}>
            <b>
              {it.name}
              {it.glides && <span aria-label=", glides"> ↗</span>}
            </b>
            {it.meta && <span className="num">{it.meta}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Readouts({ n = 4, children, className = '' }: { n?: number; children: ReactNode; className?: string }) {
  return (
    <div className={cx('readouts', className)} style={{ ['--n' as string]: n }}>
      {children}
    </div>
  );
}

export function Readout({ label, value, unit, alert, large, sub }: { label: ReactNode; value: ReactNode; unit?: ReactNode; alert?: boolean; large?: boolean; sub?: ReactNode }) {
  return (
    <div className={cx('readout', alert && 'alert')}>
      <span className="cap">{label}</span>
      <span className={cx('readout-v', large && 'lg')}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </span>
      {sub && <span className="cap">{sub}</span>}
    </div>
  );
}

export function Stat({ value, unit, meaning, size = 'reading', className = '' }: { value: ReactNode; unit?: ReactNode; meaning?: ReactNode; size?: 'reading' | 'display'; className?: string }) {
  return (
    <div className={cx('stat', className)}>
      <div className={size}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {meaning && <p className="sec">{meaning}</p>}
    </div>
  );
}

/** Neutral delta against a person's own baseline: "↓ 4 bpm · typical 53". `alert` only for score drivers. */
export function Delta({ dir, typical, alert, children }: { dir?: 'up' | 'down' | 'flat'; typical?: ReactNode; alert?: boolean; children: ReactNode }) {
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : dir === 'flat' ? '→' : '';
  return (
    <span className={cx('delta-text', alert && 'alert')}>
      {arrow && <span aria-hidden>{arrow} </span>}
      {children}
      {typical !== undefined && <span className="ink-3"> · typical {typical}</span>}
    </span>
  );
}

export function EventList({ items, className = '' }: { items: readonly { time: ReactNode; title: ReactNode; detail?: ReactNode }[]; className?: string }) {
  return (
    <ol className={cx('events', className)}>
      {items.map((it, i) => (
        <li className="event" key={i}>
          <span className="event-time">{it.time}</span>
          <span className="event-t">
            <b>{it.title}</b>
            {it.detail && <span>{it.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Status({ tone = 'ok', children }: { tone?: 'ok' | 'on' | 'alert' | 'off' | 'sim'; children: ReactNode }) {
  return <span className={cx('status', tone !== 'ok' && tone)}>{children}</span>;
}

export function Disclosure({ title, count, defaultOpen = false, children, className = '' }: { title: ReactNode; count?: ReactNode; defaultOpen?: boolean; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cx('disclosure', open && 'open', className)}>
      <button type="button" className="disclosure-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <b>{title}</b>
        {count && <span>{count}</span>}
        <Icon name="chevron-down" size={18} />
      </button>
      <div className="disclosure-body" id={id} role="region" inert={!open}>
        <div>{children}</div>
      </div>
    </div>
  );
}

export function AdviceCard({ title, reason, primary, secondary, className = '' }: { title: ReactNode; reason?: ReactNode; primary?: Action; secondary?: Action; className?: string }) {
  return (
    <div className={cx('card advice', className)}>
      <h3>{title}</h3>
      {reason && <p className="sec measure-text">{reason}</p>}
      {(primary || secondary) && (
        <div className="advice-actions">
          {primary && (
            <Button variant="primary" href={primary.href} onClick={primary.onClick}>
              {primary.label}
            </Button>
          )}
          {secondary && (
            <Button variant="text" href={secondary.href} onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const THEMES: readonly { value: ThemeMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'night', label: 'Night' },
];
/** Four miniature windows with abstract bars, no numbers (fixes v1's 76-vs-75 preview). */
export function ThemeThumbs({ value, onChange, label = 'Appearance' }: { value: ThemeMode; onChange: (m: ThemeMode) => void; label?: string }) {
  return (
    <div
      className="themes"
      role="radiogroup"
      aria-label={label}
      onKeyDown={radioKeys(
        THEMES.map((t) => t.value),
        value,
        onChange,
      )}
    >
      {THEMES.map((t) => {
        const on = t.value === value;
        return (
          <button key={t.value} type="button" className="theme-opt" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} onClick={() => onChange(t.value)}>
            <span className={`theme-win ${t.value}`} aria-hidden>
              <i />
              <i />
              <i />
              <i />
            </span>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────── Sheet ─────────────────────────────────────────

export function Sheet({
  open,
  onClose,
  title,
  kicker,
  wide,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** @deprecated v1 eyebrow; shown as a plain .label. */
  kicker?: ReactNode;
  /** Desktop panel 720 px instead of 480 (matrices, big tables). */
  wide?: boolean;
  children: ReactNode;
}) {
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
    const t = window.setTimeout(() => setMounted(false), reducedMotion() ? 0 : 420);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.documentElement.style.overflow;
    const back = document.activeElement as HTMLElement | null;
    document.documentElement.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    sheet.current?.focus({ preventScroll: true });
    return () => {
      document.documentElement.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
      back?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!mounted || typeof document === 'undefined') return null;
  const desktop = () => window.matchMedia('(min-width: 1024px)').matches;
  const onDown = (e: RPointerEvent) => {
    if (desktop()) return;
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
    <div className={cx('sheet-root', shown && 'open')} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
      <div className="sheet-scrim" onClick={onClose} />
      <div className={cx('sheet', wide && 'wide')} ref={sheet} tabIndex={-1}>
        <div className="sheet-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className="sheet-grab" aria-hidden />
            {kicker && <div className="label" style={{ marginBottom: 6 }}>{kicker}</div>}
            {title && <h2 className="sheet-title">{title}</h2>}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} onPointerDown={(e) => e.stopPropagation()} style={{ marginTop: 4, marginRight: -10 }}>
            <Icon name="close" size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ───────────────────────────────────────── Skeletons ─────────────────────────────────────────

export function Skeleton({ w = '100%', h = 16, r = 'md', className = '', style, inline = false }: { w?: number | string; h?: number | string; r?: 'md' | 'pill' | 'round' | 'text' | 'lg'; className?: string; style?: CSSProperties; /** A <span> (inline-block), valid inside <p>. */ inline?: boolean }) {
  const cls = r === 'md' || r === 'lg' ? '' : r;
  const st = { width: w, height: h, borderRadius: r === 'lg' ? 'var(--r-l)' : undefined, ...(inline ? { display: 'inline-block', verticalAlign: 'middle' } : null), ...style };
  return inline ? <span className={cx('sk', cls, className)} style={st} aria-hidden /> : <div className={cx('sk', cls, className)} style={st} aria-hidden />;
}

export function SkeletonText({ lines = 3, size = 16, last = 0.6 }: { lines?: number; size?: number; last?: number }) {
  return (
    <div style={{ display: 'grid', gap: size * 0.6 }} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} r="text" h={size} w={i === lines - 1 && lines > 1 ? `${last * 100}%` : '100%'} />
      ))}
    </div>
  );
}

export function SkeletonRing({ size = 96 }: { size?: number }) {
  return <div className="sk round" style={{ width: size, height: size }} aria-hidden />;
}

/** Full-screen loading state shaped like the final layout. `story` = Today hero, `page` = the other tabs. */
export function Loading({ text = 'Loading…', variant = 'page' }: { text?: string; variant?: 'page' | 'story' }) {
  if (variant === 'story')
    return (
      <div className="loading content" role="status" aria-live="polite" style={{ paddingTop: 'var(--sp-8)' }}>
        <Skeleton w={200} h={16} r="text" />
        <Skeleton w="min(60%, 420px)" h="var(--t-hero)" r="lg" />
        <SkeletonText lines={2} size={28} />
        <div className="cols">
          {[0, 1].map((i) => (
            <Skeleton key={i} h={72} />
          ))}
        </div>
        <div className="sk-status">{text}</div>
      </div>
    );
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="page-header">
        <div style={{ display: 'grid', gap: 12, flex: 1 }}>
          <Skeleton w="min(50%, 320px)" h={36} r="text" />
          <Skeleton w="min(70%, 480px)" h={16} r="text" />
        </div>
      </div>
      <Skeleton w="min(40%, 280px)" h="var(--t-display)" r="lg" />
      <Readouts n={4}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ display: 'grid', gap: 8 }}>
            <Skeleton w="50%" h={14} r="text" />
            <Skeleton w="70%" h={24} r="text" />
          </div>
        ))}
      </Readouts>
      {[260, 200].map((h, i) => (
        <div key={i} style={{ display: 'grid', gap: 12 }}>
          <Skeleton w="40%" h={22} r="text" />
          <Skeleton h={h} />
        </div>
      ))}
      <div className="sk-status">{text}</div>
    </div>
  );
}

/** Block skeleton with the final content's height (no layout shift). */
export function Placeholder({ height = 160, text }: { height?: number; text?: string }) {
  return (
    <div role="status" aria-label={text ?? 'Loading'} style={{ height, display: 'grid', gap: 8, gridTemplateRows: text ? '1fr auto' : '1fr' }}>
      <Skeleton h="100%" />
      {text && <div className="cap">{text}</div>}
    </div>
  );
}

// ───────────────────────────────────────── Keys / table / width ─────────────────────────────────────────

export type KeyShape = 'line' | 'dash' | 'dot' | 'rect';

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
        <div className="scroll-x" style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table className="data-table">
            {caption && <caption className="sr-only">{caption}</caption>}
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

// ───────────────────────────────────────── DEPRECATED v1 primitives ─────────────────────────────────────────

/**
 * @deprecated v1 numbered eyebrow + two-tone headline. v2: <PageHeader> / <Section title>. The number is no longer
 * shown; `kicker` renders as a .label; line 2 is --text-2.
 */
export function SectionHeader({
  n: _n,
  kicker,
  lines,
  size = 'h1',
  tone: _tone,
  className = '',
  style,
}: {
  n?: number;
  kicker?: ReactNode;
  lines: ReactNode[];
  size?: 'h1' | 'h2';
  tone?: 'accent' | 'muted';
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Reveal as="header" mask className={cx('sh', className)} style={style}>
      {kicker && <div className="sh-kicker">{kicker}</div>}
      <h2 className={cx('sh-title', size === 'h1' ? 'title' : 'head')}>
        {lines.map((l, i) => (
          <span className="sh-line" key={i}>
            <span style={{ ['--i' as string]: i }}>{l}</span>
          </span>
        ))}
      </h2>
    </Reveal>
  );
}

export type Tone = 'good' | 'bad' | 'neutral';

/** @deprecated → <Delta>. Rendered as neutral text (signal only for 'bad'). */
export function DeltaChip({ tone = 'neutral', dir, children, title }: { tone?: Tone; dir?: 'up' | 'down' | 'flat'; children: ReactNode; title?: string }) {
  return (
    <span className={`delta ${tone}`} title={title}>
      {dir && dir !== 'flat' && <i aria-hidden>{dir === 'up' ? '↑' : '↓'}</i>}
      {children}
    </span>
  );
}

function CountNum({ value, dp }: { value: number; dp: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useCountUp(ref, value, { dp });
  return <span ref={ref}>{Number.isFinite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '–'}</span>;
}

/** @deprecated → <Readout> / <Stat>. Kept with its v1 API; rendered without a tile box. */
export function MetricTile({
  label,
  value,
  unit,
  dp = 0,
  countUp = false,
  sub,
  delta,
  spark,
  sparkColor = 'var(--text-2)',
  variant = 'tile',
  big = false,
  icon: _icon,
  className = '',
  style,
}: {
  label: ReactNode;
  value: number | ReactNode;
  unit?: ReactNode;
  dp?: number;
  countUp?: boolean;
  sub?: ReactNode;
  delta?: { text: ReactNode; tone?: Tone; dir?: 'up' | 'down' | 'flat' };
  spark?: { ts: number; v: number }[];
  sparkColor?: string;
  variant?: 'tile' | 'row';
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
    <span className={big ? 'reading' : variant === 'row' ? 't-stat' : 'tile-value'}>
      {v}
      {unit && <span className={variant === 'row' || big ? 'unit' : 'tile-unit'}>{unit}</span>}
    </span>
  );
  const dl = delta && (
    <DeltaChip tone={delta.tone} dir={delta.dir}>
      {delta.text}
    </DeltaChip>
  );
  if (variant === 'row')
    return (
      <div className={cx('mt-row', className)} style={style}>
        <div className="mt-label">
          <span className="label">{label}</span>
          {sub && <span className="cap">{sub}</span>}
        </div>
        <div className="mt-value">{num}</div>
        <div className="mt-side">
          {spark && spark.length > 1 && (
            <div style={{ width: 56 }}>
              <Sparkline values={spark} color={sparkColor} height={28} />
            </div>
          )}
          {dl}
        </div>
      </div>
    );
  return (
    <div className={cx('tile', className)} style={style}>
      <div className="tile-label">{label}</div>
      <div>{num}</div>
      {(delta || sub) && (
        <div className="tile-delta" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {dl}
          {sub}
        </div>
      )}
      {spark && spark.length > 1 && (
        <div className="tile-spark">
          <Sparkline values={spark} color={sparkColor} height={28} />
        </div>
      )}
    </div>
  );
}

/** @deprecated v2 labels series on the chart itself (§7.1). Kept for un-migrated charts. */
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

/** @deprecated JumpBars are removed in v2 (§5.3). Renders the ≥1760 "On this page" rail from the same items. */
export function JumpBar({ items, label = 'On this page' }: { items: readonly { id: string; label: ReactNode }[]; label?: string }) {
  return <OnThisPage items={items} label={label} />;
}

/** @deprecated → <Status>. */
export function StatusDot({ status }: { status: 'good' | 'warn' | 'serious' | 'critical' }) {
  return <i className="status-dot" style={{ background: `var(--${status})` }} aria-hidden />;
}
