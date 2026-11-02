import type { Metadata } from 'next';
import { LiveScreen } from '@/components/screens/LiveScreen.tsx';

export const metadata: Metadata = { title: 'Live · Sleep Lab', robots: { index: false } };

export default function Page() {
  return <LiveScreen />;
}
