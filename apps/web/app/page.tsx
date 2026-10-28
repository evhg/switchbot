import type { Metadata } from 'next';
import { TodayScreen } from '@/components/screens/TodayScreen.tsx';

export const metadata: Metadata = { title: 'Sleep Lab' };

export default function Page() {
  return <TodayScreen />;
}
