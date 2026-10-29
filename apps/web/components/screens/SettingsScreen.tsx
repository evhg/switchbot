'use client';
/**
 * System (docs/DESIGN.md §9.5). Two levels, one navigation layer each:
 *   /settings          phone: the root list (featured Tonight's plan card + grouped rows)
 *                      desktop (≥1024): Tonight's plan (the sidebar's second level is the list)
 *   /settings/<slug>   one page per topic: plan, tags, general, morning, data, health, co2, setup, diagnostics
 * Pages live in components/system/pages.tsx; the root list in components/system/Root.tsx.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { SystemSlug } from '../nav.tsx';
import { PlanPage, SYSTEM_SCREENS } from '../system/pages.tsx';
import { SystemRoot } from '../system/Root.tsx';
import s from './settings.module.css';

export function SettingsScreen() {
  const router = useRouter();
  // v1 deep link (Today › "Edit tonight's plan" pointed at /settings#curve).
  useEffect(() => {
    if (window.location.hash === '#curve') router.replace('/settings/plan');
  }, [router]);
  return (
    <>
      <div className={s.phoneOnly}>
        <SystemRoot />
      </div>
      <div className={s.deskOnly}>
        <PlanPage back={false} />
      </div>
    </>
  );
}

export function SystemPage({ slug }: { slug: SystemSlug }) {
  return <>{SYSTEM_SCREENS[slug]()}</>;
}
