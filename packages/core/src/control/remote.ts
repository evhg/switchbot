import type { AcState } from '../types.ts';

export interface RemoteProfile {
  kind: 'setAll' | 'customize';
  /** For 'customize': learned buttons, e.g. C18..C24, each a full state frame. */
  ladder?: { button: string; state: AcState }[];
  /** IR receivers beep, so keep commands rare. */
  minIntervalMin: number;
  maxCommandsPerNight: number;
  /** No commands in the first N minutes after lights-out. */
  quietAfterLightsOutMin?: number;
}

export const DEFAULT_REMOTE: RemoteProfile = {
  kind: 'setAll',
  minIntervalMin: 20,
  maxCommandsPerNight: 12,
};

const ladderStep = (c: number) => ({
  button: `C${c}`,
  state: { power: true, setpointC: c, mode: 'cool', fan: 'auto' } satisfies AcState,
});

/** Fallback when Smart Matching fails: learned "Others" buttons C17..C24 (cool, fan auto) plus OFF. */
export const DEFAULT_LADDER_REMOTE: RemoteProfile = {
  kind: 'customize',
  ladder: [
    ...[17, 18, 19, 20, 21, 22, 23, 24].map(ladderStep),
    { button: 'OFF', state: { power: false, setpointC: 24, mode: 'cool', fan: 'auto' } },
  ],
  minIntervalMin: 20,
  maxCommandsPerNight: 12,
};
