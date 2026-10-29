'use client';
/**
 * Desktop sidebar, the "inverted L" (docs/DESIGN.md §5.3). Shown at ≥1024 px only (CSS). Top to bottom: wordmark,
 * night picker ([ and ] keys), five destinations, System's second level (only while in System), and a footer with
 * the live bedroom readings and the data source.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';
import { useData, useLive } from '@/lib/data/context.tsx';
import { fmt, hm } from '@/lib/format.ts';
import { Icon } from './icons.tsx';
import { useNavigate } from './motion.tsx';
import { SYSTEM_DEFAULT, SYSTEM_GROUPS, TABS, activeTab, systemHref, useNightNav } from './nav.tsx';

export function Brand() {
  return (
    <span className="brand">
      <i aria-hidden />
      Sleep Lab
    </span>
  );
}

/** Invisible native date input laid over its parent (position: relative): tap the date to pick any night. */
export function NightDateInput() {
  const n = useNightNav();
  return (
    <input
      type="date"
      className="night-date"
      aria-label="Pick a night"
      value={n.date ?? ''}
      min={n.dates[0]}
      max={n.dates.at(-1)}
      disabled={!n.ready}
      onChange={(e) => n.dates.includes(e.target.value) && n.setDate(e.target.value)}
    />
  );
}

export function NightPicker({ className = '' }: { className?: string }) {
  const n = useNightNav();
  return (
    <div className={`nightpick ${className}`.trim()}>
      <div className="nightpick-t" aria-live="polite">
        <b>{n.title || '\u00a0'}</b>
        <span>{n.sub || '\u00a0'}</span>
        <NightDateInput />
      </div>
      <button type="button" className="icon-btn" aria-label="Previous night" aria-keyshortcuts="[" disabled={!n.canPrev} onClick={n.prev}>
        <Icon name="chevron-left" size={18} />
      </button>
      <button type="button" className="icon-btn" aria-label="Next night" aria-keyshortcuts="]" disabled={!n.canNext} onClick={n.next}>
        <Icon name="chevron-right" size={18} />
      </button>
    </div>
  );
}

function LiveFooter() {
  const { sourceKind } = useData();
  const { reading } = useLive(1);
  const rows: [string, ReactNode][] = [
    ['Bedroom now', reading ? `${fmt(reading.tempC, 1)}°` : '–'],
    ['CO₂', reading ? `${fmt(reading.co2)} ppm` : '–'],
    ['Humidity', reading ? `${fmt(reading.rh)}%` : '–'],
  ];
  return (
    <div className="side-live">
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="num">{v}</dd>
          </div>
        ))}
      </dl>
      {/* The time is only known in the browser (never prerendered: a build-time clock caused hydration error #418). */}
      <Link href={systemHref('data')} prefetch={false} className="side-src cap" title="Data & devices">
        <i className={`dot ${sourceKind === 'sim' ? '' : 'on'}`} aria-hidden />
        {sourceKind === 'sim' ? 'Simulated data' : 'Real data'}
        {reading ? ` · ${hm(reading.ts)}` : ''}
      </Link>
    </div>
  );
}

export function Sidebar() {
  const path = usePathname();
  const navigate = useNavigate();
  const ai = activeTab(path);
  const inSystem = path === '/settings' || path.startsWith('/settings/');
  const go = (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (href !== path) navigate(href);
  };
  return (
    <aside className="sidebar">
      <Link href="/" className="brand-link" onClick={go('/')} aria-label="Sleep Lab, Today">
        <Brand />
      </Link>
      <NightPicker />
      <nav aria-label="Main">
        <ul className="side-nav">
          {TABS.map((t, i) => {
            const active = i === ai;
            return (
              <li key={t.href}>
                <Link href={t.href} prefetch={false} onClick={go(t.href)} aria-current={active ? 'page' : undefined} className="side-item">
                  <Icon name={t.icon} size={20} />
                  {t.label}
                </Link>
                {t.href === '/settings' && inSystem && (
                  <ul className="side-sub">
                    {SYSTEM_GROUPS.map((g) => (
                      <li key={g.label}>
                        <span className="side-group cap">{g.label}</span>
                        <ul>
                          {g.pages.map((p) => {
                            const href = systemHref(p.slug);
                            const on = path === href || (path === '/settings' && p.slug === SYSTEM_DEFAULT);
                            return (
                              <li key={p.slug}>
                                <Link href={href} prefetch={false} onClick={go(href)} aria-current={on ? 'page' : undefined} className="side-subitem">
                                  {p.label}
                                </Link>
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="side-grow" />
      <LiveFooter />
    </aside>
  );
}
