import type { Metadata } from 'next';
import { LabScreen } from '@/components/screens/LabScreen.tsx';

export const metadata: Metadata = { title: 'Lab · Sleep Lab' };

export default function Page() {
  return <LabScreen />;
}
