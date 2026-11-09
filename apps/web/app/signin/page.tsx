import type { Metadata } from 'next';
import { SignIn } from '@/components/account/SignIn.tsx';

export const metadata: Metadata = { title: 'Sign in · Jarvis', robots: { index: false } };

export default function Page() {
  return <SignIn />;
}
