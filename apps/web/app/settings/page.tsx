import type { Metadata } from 'next';
import { SettingsScreen } from '@/components/screens/SettingsScreen.tsx';

export const metadata: Metadata = { title: 'System · Sleep Lab' };

export default function Page() {
  return <SettingsScreen />;
}
