'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const TABS: { href: string; label: string; icon: ReactNode }[] = [
  {
    href: '/',
    label: 'Today',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path {...S} d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
      </svg>
    ),
  },
  {
    href: '/room',
    label: 'Room',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path {...S} d="M4 11.5 12 5l8 6.5V20H4z" />
        <path {...S} d="M9 15.5c1.5-1.2 4.5-1.2 6 0" />
      </svg>
    ),
  },
  {
    href: '/body',
    label: 'Body',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path {...S} d="M3 12h4l2-5 3 10 2.5-7 1.5 2H21" />
      </svg>
    ),
  },
  {
    href: '/lab',
    label: 'Lab',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path {...S} d="M9 3h6M10 3v6L4.5 19a1.3 1.3 0 0 0 1.1 2h12.8a1.3 1.3 0 0 0 1.1-2L14 9V3" />
        <path {...S} d="M7.5 14h9" />
      </svg>
    ),
  },
  {
    href: '/settings',
    label: 'System',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <circle {...S} cx="12" cy="12" r="3" />
        <path {...S} d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5" />
      </svg>
    ),
  },
];

export function TabBar() {
  const path = usePathname();
  return (
    <nav className="tabbar" aria-label="Main">
      <ul>
        {TABS.map((t) => {
          const active = t.href === '/' ? path === '/' : path.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? 'page' : undefined}>
                {t.icon}
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
