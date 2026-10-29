'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type MouseEvent } from 'react';
import { Icon, type IconName } from './icons.tsx';
import { useNavigate } from './motion.tsx';

const TABS: { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'Today', icon: 'moon' },
  { href: '/room', label: 'Room', icon: 'house' },
  { href: '/body', label: 'Body', icon: 'pulse' },
  { href: '/lab', label: 'Lab', icon: 'flask' },
  { href: '/settings', label: 'System', icon: 'gear' },
];

/** Floating glass pill; the active tab sits on a capsule that slides between items (transform only). */
export function TabBar() {
  const path = usePathname();
  const navigate = useNavigate();
  const router = useRouter();
  // Warm every tab's route chunks once the first screen has settled (and the browser is idle), so a cold switch never
  // waits on a download behind a frozen view-transition snapshot. Links don't prefetch on sight: on Today that would
  // parse the Recharts chunk during the first scroll.
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const run = () => {
      for (const t of TABS) if (t.href !== path) router.prefetch(t.href);
    };
    const id = window.setTimeout(() => (w.requestIdleCallback ? w.requestIdleCallback(run) : run()), 5000);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);
  const activeIndex = Math.max(
    0,
    TABS.findIndex((t) => (t.href === '/' ? path === '/' : path.startsWith(t.href))),
  );
  const onClick = (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (href === path) {
      window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      return;
    }
    navigate(href);
  };
  return (
    <nav className="tabbar" aria-label="Main">
      <ul style={{ ['--i' as string]: activeIndex }}>
        <li className="tabbar-capsule" aria-hidden />
        {TABS.map((t, i) => {
          const active = i === activeIndex;
          return (
            <li key={t.href}>
              <Link href={t.href} prefetch={false} aria-current={active ? 'page' : undefined} onClick={onClick(t.href)}>
                <Icon name={t.icon} size={22} filled={active && t.icon === 'moon'} />
                <span>{t.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
