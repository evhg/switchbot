'use client';
// The calm stand-in for body data on a room-only night: one card that says what Google Health adds and where to
// connect it. When the first synced night arrives, Today switches to the people-led story by itself.
import { systemHref } from '../nav.tsx';
import { AdviceCard } from '../ui.tsx';

export function ConnectHealthCard({ everSynced = false, className = '' }: { everSynced?: boolean; className?: string }) {
  return everSynced ? (
    <AdviceCard
      className={className}
      title="No watch data for this night."
      reason="Google Health is connected, but no sleep came through for this night (a watch off the wrist, or the sync is still catching up). The room story is complete."
      primary={{ label: 'Google Health status', href: systemHref('health') }}
    />
  ) : (
    <AdviceCard
      className={className}
      title="Add your sleep to this story."
      reason="Connect Google Health and each morning gains sleep stages, heart rate, HRV and recovery for both of you, next to the room. Until then, Today is told from the room alone."
      primary={{ label: 'Connect Google Health', href: systemHref('health') }}
    />
  );
}
