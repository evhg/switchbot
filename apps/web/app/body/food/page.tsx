import type { Metadata } from 'next';
import { FoodScreen } from '@/components/food/FoodScreen.tsx';

export const metadata: Metadata = { title: 'Food · Jarvis' };

export default function Page() {
  return <FoodScreen />;
}
