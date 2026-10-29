import type { Metadata } from 'next';
import { SignIn } from '@/components/account/SignIn.tsx';

export const metadata: Metadata = { title: 'Sign in · Sleep Lab', robots: { index: false } };

export default function Page() {
  return <SignIn />;
}
