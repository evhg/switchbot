import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SystemPage } from '@/components/screens/SettingsScreen.tsx';
import type { SystemSlug } from '@/components/nav.tsx';

// Mirrors SYSTEM_PAGES in components/nav.tsx (a client module, so its values can't be read here).
const TITLES: Record<SystemSlug, string> = {
  plan: 'Tonight’s plan',
  tags: 'Tonight’s tags',
  general: 'General',
  morning: 'Morning report',
  data: 'Data & devices',
  health: 'Google Health',
  co2: 'CO₂ calibration',
  setup: 'Setup guide',
  diagnostics: 'Diagnostics',
};
const isSlug = (x: string): x is SystemSlug => x in TITLES;

export const dynamicParams = false;
export function generateStaticParams() {
  return Object.keys(TITLES).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${isSlug(slug) ? TITLES[slug] : 'System'} · Sleep Lab` };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isSlug(slug)) notFound();
  return <SystemPage slug={slug} />;
}
