import type { Metadata } from 'next';
import { TodayScreen } from '@/components/screens/TodayScreen.tsx';

export const metadata: Metadata = { title: 'Jarvis' };

export default function Page() {
  return <TodayScreen />;
}
