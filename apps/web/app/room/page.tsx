import type { Metadata } from 'next';
import { RoomScreen } from '@/components/screens/RoomScreen.tsx';

export const metadata: Metadata = { title: 'Room · Sleep Lab' };

export default function Page() {
  return <RoomScreen />;
}
