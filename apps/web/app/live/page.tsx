import type { Metadata } from 'next';
import { LiveScreen } from '@/components/screens/LiveScreen.tsx';

export const metadata: Metadata = { title: 'Live · Jarvis', robots: { index: false } };

export default function Page() {
  return <LiveScreen />;
}
