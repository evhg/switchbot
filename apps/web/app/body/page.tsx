import type { Metadata } from 'next';
import { BodyScreen } from '@/components/screens/BodyScreen.tsx';

export const metadata: Metadata = { title: 'Body · Sleep Lab' };

export default function Page() {
  return <BodyScreen />;
}
