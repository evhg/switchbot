'use client';
/**
 * Phone bottom tab bar (docs/DESIGN.md §5.3): a solid --rail strip with a top hairline, five tabs (24 px icon over a
 * 13 px sentence-case label). Active: label --text, icon --signal. Hidden at ≥1024 px (the Sidebar takes over).
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type MouseEvent } from 'react';
import { Icon } from './icons.tsx';
import { useNavigate } from './motion.tsx';
import { TABS, activeTab } from './nav.tsx';

export function TabBar() {
  const path = usePathname();
  const navigate = useNavigate();
  const router = useRouter();
  // Warm every tab's route chunks once the first screen has settled and the browser is idle.
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const run = () => {
      for (const t of TABS) if (t.href !== path) router.prefetch(t.href);
    };
    const id = window.setTimeout(() => (w.requestIdleCallback ? w.requestIdleCallback(run) : run()), 5000);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);
  const ai = activeTab(path);
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
      <ul>
        {TABS.map((t, i) => {
          const active = i === ai;
          return (
            <li key={t.href}>
              <Link href={t.href} prefetch={false} aria-current={active ? 'page' : undefined} onClick={onClick(t.href)}>
                <Icon name={t.icon} size={24} />
                <span>{t.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
