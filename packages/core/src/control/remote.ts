import type { AcCommand, AcState, Ms } from '../types.ts';

/**
 * Quiet mode. The Toshiba Carrier receiver beeps on every IR frame, so while the sleepers are asleep the controller
 * sends only the planned phase boundaries (plus at most one extra command per night: an emergency correction or a resend).
 * Every field is optional; see DEFAULT_QUIET for the defaults.
 */
export interface QuietConfig {
  /** Default true. false = the original closed-loop behaviour (corrections whenever the room drifts). */
  enabled?: boolean;
  /** Minutes after lights-out during which the controller still behaves as before lights-out. Default 15. */
  settleMin?: number;
  /** Emergency correction only when the bed-height room is at least this far from target… Default 1.5 °C. */
  emergencyThresholdC?: number;
  /** …for at least this many minutes. Default 20. */
  emergencyMinMinutes?: number;
  /** Default 1. */
  maxEmergencyPerNight?: number;
  /**
   * Extra commands (emergency corrections and resends together) allowed while asleep, on top of the planned steps.
   * Default 1, so a night has at most planned steps + 1 beeps while asleep.
   */
  maxExtraPerNight?: number;
  /**
   * How a ramped phase (e.g. middle 19 → 21.5 over 2 h) is executed while asleep, always as ONE command:
   * 'third' (default): at 1/3 of the ramp, jump to the target 2/3 of the way along. For a linear ramp followed by
   *   the next phase's own step this minimises the worst error: Δ/3 (0.8 °C for the default 2.5 °C ramp);
   * 'midpoint': at the midpoint, jump to the midpoint target (worst error Δ/2);
   * 'end': no step during the ramp; the next phase's boundary command carries the whole change (worst error Δ).
   */
  rampStrategy?: 'third' | 'midpoint' | 'end';
}

export type ResolvedQuiet = Required<QuietConfig>;

export const DEFAULT_QUIET: ResolvedQuiet = {
  enabled: true,
  settleMin: 15,
  emergencyThresholdC: 1.5,
  emergencyMinMinutes: 20,
  maxEmergencyPerNight: 1,
  maxExtraPerNight: 1,
  rampStrategy: 'third',
};

/** Fill in quiet-mode defaults. A profile stored before quiet mode existed (no `quiet`) gets quiet mode ON. */
export function resolveQuiet(remote: RemoteProfile): ResolvedQuiet {
  const q = remote.quiet ?? {};
  const out = { ...DEFAULT_QUIET };
  for (const k of Object.keys(DEFAULT_QUIET) as (keyof ResolvedQuiet)[]) {
    if (q[k] !== undefined && q[k] !== null) (out as Record<string, unknown>)[k] = q[k];
  }
  if (!['third', 'midpoint', 'end'].includes(out.rampStrategy)) out.rampStrategy = 'third';
  return out;
}

/** The same profile with quiet mode switched on or off (other quiet settings kept). */
export function withQuiet(remote: RemoteProfile, enabled: boolean): RemoteProfile {
  return { ...remote, quiet: { ...remote.quiet, enabled } };
}

export interface RemoteProfile {
  kind: 'setAll' | 'customize';
  /** For 'customize': learned buttons, e.g. C18..C24, each a full state frame. */
  ladder?: { button: string; state: AcState }[];
  /** IR receivers beep, so keep commands rare. */
  minIntervalMin: number;
  maxCommandsPerNight: number;
  /** No commands in the first N minutes after lights-out. */
  quietAfterLightsOutMin?: number;
  /** Quiet mode while asleep; omitted = DEFAULT_QUIET (on). */
  quiet?: QuietConfig;
}

export const DEFAULT_REMOTE: RemoteProfile = {
  kind: 'setAll',
  minIntervalMin: 20,
  maxCommandsPerNight: 12,
  quiet: { ...DEFAULT_QUIET },
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
  quiet: { ...DEFAULT_QUIET },
};

/** `state` in the remote's vocabulary: setAll as is, or the nearest learned ladder button (null if none fits). */
export function remoteCommand(now: Ms, state: AcState, remote: RemoteProfile, reason: string): AcCommand | null {
  if (remote.kind === 'setAll') return { ts: now, state, via: 'setAll', reason, landed: null };
  const ladder = remote.ladder ?? [];
  let best: { button: string; state: AcState } | undefined;
  for (const step of ladder) {
    if (step.state.power !== state.power) continue;
    if (!state.power) {
      best = step;
      break;
    }
    if (!best || Math.abs(step.state.setpointC - state.setpointC) < Math.abs(best.state.setpointC - state.setpointC)) {
      best = step;
    }
  }
  if (!best) return null;
  return { ts: now, state: { ...best.state }, via: 'customize', button: best.button, reason, landed: null };
}
