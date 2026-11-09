import type { Metadata } from 'next';
import { MapScreen } from '@/components/screens/MapScreen.tsx';

export const metadata: Metadata = { title: 'Map · Jarvis', robots: { index: false } };

export default function Page() {
  return <MapScreen />;
}
