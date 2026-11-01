import type { Metadata } from 'next';
import { FoodScreen } from '@/components/food/FoodScreen.tsx';

export const metadata: Metadata = { title: 'Food · Sleep Lab' };

export default function Page() {
  return <FoodScreen />;
}
