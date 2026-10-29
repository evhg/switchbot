'use client';
/**
 * System data and stores (docs/DESIGN.md §9.5). Everything the nine System pages and the phone root share:
 * static copy (tags, setup steps, devices), the stores kept on this device, and the selectors that turn the dataset
 * into plan clock times, "last night on this plan", nights with complete data and CO₂ drift alerts.
 */
import { useEffect, useState } from 'react';
import { DEFAULT_CURVE, DEFAULT_PEOPLE, DEFAULT_REMOTE, planAcSchedule, withQuiet, type CurvePhaseName, type TagKey, type TemperatureCurve } from '@sleep-lab/core';
import { useData } from '@/lib/data/context.tsx';
import { onsetAfterLightsOut, useTonight, type Tonight } from '@/lib/tonight.ts';
import type { Dataset } from '@/lib/data/types.ts';
import { addDays, ictDate, ictHour, MIN } from '@/lib/format.ts';
import { usePref } from '@/lib/prefs.ts';

// ───────────────────────────── static copy ─────────────────────────────

export const TAGS: readonly { key: TagKey; label: string }[] = [
  { key: 'alcohol', label: 'Alcohol' },
  { key: 'late_caffeine', label: 'Caffeine after 14:00' },
  { key: 'late_meal', label: 'Late meal' },
  { key: 'late_exercise', label: 'Late exercise' },
  { key: 'heavy_duvet', label: 'Heavy duvet' },
  { key: 'door_ajar', label: 'Door ajar' },
  { key: 'sick', label: 'Sick' },
  { key: 'travel', label: 'Away' },
];
export const tagLabel = (k: TagKey) => TAGS.find((t) => t.key === k)?.label ?? k;

/** Install order and key steps (docs/SETUP.md), ticked off on unboxing day. */
export const SETUP: readonly { id: string; title: string; steps: readonly string[] }[] = [
  { id: 'app', title: 'SwitchBot app and account', steps: ['Install the SwitchBot app, region Thailand / Asia', 'Allow Bluetooth, Local Network, Notifications', 'Use 2.4 GHz Wi-Fi (or iPhone hotspot with Maximize Compatibility)'] },
  { id: 'hub', title: 'Hub Mini', steps: ['Line of sight to the AC receiver module', 'Note model W0202203 (Matter) or W0202200', 'Pair, then let it update firmware', 'Indicator Light → OFF'] },
  { id: 'meter', title: 'Meter Pro CO2', steps: ['Pair on AA batteries, update firmware', 'Calibrate outdoors on batteries (5 min untouched, expect 400–500 ppm)', 'Remove AAs, run on USB-C 5 V/1 A', 'CO₂ interval 1 min · Alert Sound & Light OFF', 'Store Data in Cloud · bed height, away from AC and shower'] },
  { id: 'ac', title: 'Aircon remote', steps: ['Hub Mini → Add Remote → Air Conditioner → Smart Matching', 'Test on/off, 18/20/22 °C, fan, DRY (full set = setAll)', 'Otherwise "Others" ladder C18…C24, DRY22, OFF', 'Learn ECO SLEEP + Hi-Power; note if the receiver beeps', 'Photograph the RAV-… rating plate'] },
  { id: 'token', title: 'Developer token', steps: ['Profile → Preferences → tap App Version ×10', 'Copy token + secret into Supabase secrets (never git)'] },
  { id: 'cam', title: 'Pan/Tilt Cam Plus 3K', steps: ['Update firmware first (RTSP needs 2025 firmware)', 'Night Vision Auto · indicator off or taped', 'Create a Camera Account for RTSP'] },
  { id: 'dark', title: 'Darkness audit', steps: ['Lights off, eyes adapted 10 min', 'Tape AC receiver LEDs (not the IR window), chargers, router'] },
];
/** Optional groups: shown with "can wait". */
export const SETUP_LATER = new Set(['cam']);

export type DeviceState = 'Not linked' | 'Open loop' | 'Later';
export const DEVICES: readonly { name: string; detail: string; state: DeviceState }[] = [
  { name: 'Hub Mini', detail: 'IR to the aircon, gateway for the meter', state: 'Not linked' },
  { name: 'Meter Pro CO2', detail: 'USB-C power · CO₂ every minute · battery n/a', state: 'Not linked' },
  { name: 'Aircon (Toshiba Carrier)', detail: 'Remote profile setAll (assumed)', state: 'Open loop' },
  { name: 'Fitbit Air × 2', detail: 'Google Health paired devices: last sync, battery', state: 'Not linked' },
];
export const CAMERA_LATER: readonly string[] = [
  'Movement strip under the hypnogram (IR video frame difference)',
  'Sleep position and covers on or off, from snapshots',
  'Snoring and sound timeline with playable clips',
  'Nightly light-leak map: new glows get circled',
];

export const PHASE_NAME: Record<CurvePhaseName, string> = {
  precool: 'Pre-cool',
  onset: 'Falling asleep',
  deep: 'Deep window',
  middle: 'Middle',
  late: 'Late / REM',
  wake: 'Wake',
};
export const PHASE_ABOUT: Record<CurvePhaseName, string> = {
  precool: 'Cools the room before you get into bed.',
  onset: 'Comfortable while you fall asleep. Always starts at lights out.',
  deep: 'Coolest stretch, timed for the first sleep cycles: in the default plan from 30 min after you fall asleep.',
  middle: 'The middle of the night. In the default plan this is the one warming step, 4 h 30 after you fall asleep, the only command while you sleep.',
  late: 'A little warmer for the REM-rich last hours.',
  wake: 'A warm room to wake up into.',
};

export const NIGHT_MODE_HOURS = '21:00 – 07:00';
export const TIME_ZONE = 'Phuket (UTC+7)';

// ───────────────────────────── clock helpers ─────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
/** Minute of day (may be out of 0..1439) → "23:57". */
export const clock = (mod: number) => {
  const m = ((Math.round(mod) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
/** Minutes relative to lights out → "40 min after lights out" / "1 h 30 min before lights out". */
export function relWords(m: number): string {
  if (m === 0) return 'at lights out';
  const a = Math.abs(m);
  const h = Math.floor(a / 60);
  const r = a % 60;
  const d = h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`;
  return `${d} ${m < 0 ? 'before' : 'after'} lights out`;
}
/** Minutes relative to sleep onset → "4 h 30 min after you fall asleep". */
export function relSleepWords(m: number): string {
  if (m === 0) return 'when you fall asleep';
  const a = Math.abs(m);
  const h = Math.floor(a / 60);
  const r = a % 60;
  const d = h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`;
  return `${d} ${m < 0 ? 'before' : 'after'} you fall asleep`;
}


// ───────────────────────────── selectors ─────────────────────────────

export interface PlanClock {
  /** Tonight's lights out, minute of day: 22:00 every day unless tonight's night says otherwise. */
  lightsOut: number;
  /** Tonight's wake, minute of day: 08:30 until you set it (Tonight's plan). */
  wake: number;
  /** Tonight's expected sleep onset, minute of day: lights out + 60 min (23:00) until set. */
  sleepOnset: number;
  ready: boolean;
  tonight: Tonight;
}

/** Tonight's schedule (lib/tonight.ts): the backend's night when signed in, else this device's settings. */
export function usePlanClock(): PlanClock {
  const { dataset, latest } = useData();
  const people = (dataset ?? latest)?.people ?? DEFAULT_PEOPLE;
  const tonight = useTonight(people);
  return { lightsOut: tonight.lightsOutMin, wake: tonight.wakeMin, sleepOnset: tonight.sleepOnsetMin, ready: tonight.date !== null, tonight };
}

export interface PlanTimes {
  /** Minute of day the pre-cool starts. */
  starts: number;
  /** Minute of day the wake phase starts ("Wake"). */
  wake: number;
  /** Minute of day the aircon switches off: wake + 30 min. */
  off: number;
  coolest: number;
}
/**
 * Tonight's plan on the clock, from the lights-out anchor. `wakeMin` (minute of day) is tonight's wake; without it the
 * curve's wake phase start stands in. Today and System both read this.
 */
export function planTimes(curve: TemperatureCurve, lightsOut: number, wakeMin?: number): PlanTimes {
  const ph = curve.phases;
  const wake =
    wakeMin !== undefined ? (wakeMin < lightsOut ? wakeMin + 1440 : wakeMin) : lightsOut + (ph.find((p) => p.name === 'wake') ?? ph.at(-1)!).startMin;
  return {
    starts: lightsOut + ph[0]!.startMin,
    wake,
    off: wake + OFF_AFTER_WAKE,
    coolest: Math.min(...ph.map((p) => p.targetC)),
  };
}
export const OFF_AFTER_WAKE = 30;

export interface ScheduleStep {
  at: string;
  /** The plan's target (0.5° steps); null for Off. */
  targetC: number | null;
  /** What the aircon is actually sent (whole degrees). */
  setC: number | null;
  what: string;
  /** Sent while you sleep (lights out + settle → wake): the receiver beeps. */
  asleep: boolean;
}
export interface AirconPlan {
  steps: ScheduleStep[];
  /** Commands (= receiver beeps) while asleep. */
  asleepCount: number;
  total: number;
  quiet: boolean;
  /** Quiet mode: extra commands it may still send while asleep (a resend or an emergency correction, one budget). */
  maxExtraAsleep: number | null;
}
const PLAN_DAY = Date.UTC(2026, 0, 1);
/**
 * What the controller will send tonight (`planAcSchedule` from core, the same rules the backend runs): the pre-cool,
 * the falling-asleep command, then in quiet mode only the planned steps while asleep (a ramp is one step), off at
 * wake + 30 min. Whole-degree set points with `biasC` when known (the backend's ac_state.bias_c), else the default
 * (the bed reads about 1° above the aircon's sensor). The backend sends the same number of steps while asleep; a set
 * point may differ by 1° once it has measured the room's offset.
 */
export function aircon(curve: TemperatureCurve, lightsOut: number, quiet = true, biasC?: number, wakeMin?: number, sleepOnsetMin?: number): AirconPlan {
  const t = planTimes(curve, lightsOut, wakeMin);
  const lo = PLAN_DAY + lightsOut * MIN;
  const wake = lo + (t.wake - lightsOut) * MIN;
  // Onset-anchored curves (the default) count the deep window and the warming step from the expected sleep onset.
  const sleepOnset = sleepOnsetMin === undefined ? undefined : lo + onsetAfterLightsOut(lightsOut, sleepOnsetMin) * MIN;
  const plan = planAcSchedule({
    curve,
    lightsOut: lo,
    wake,
    remote: withQuiet(DEFAULT_REMOTE, quiet),
    ...(biasC !== undefined ? { biasC } : {}),
    ...(sleepOnset !== undefined ? { sleepOnset } : {}),
  });
  const glide = (name: CurvePhaseName) => {
    const i = curve.phases.findIndex((p) => p.name === name);
    return curve.phases[i + 1]?.targetC;
  };
  const steps = plan.commands.map((c): ScheduleStep => {
    const at = clock(lightsOut + (c.ts - lo) / MIN);
    if (c.kind === 'off') return { at, targetC: null, setC: null, what: `Off, ${OFF_AFTER_WAKE} min after wake (${clock(t.wake)})`, asleep: false };
    const name = c.phase === 'off' ? '' : PHASE_NAME[c.phase];
    const what =
      c.kind === 'ramp'
        ? quiet
          ? `${name}, one step toward ${fmtC(glide(c.phase as CurvePhaseName))}`
          : `${name}, gliding`
        : c.kind === 'on'
          ? `${name}, aircon on`
          : name;
    return { at, targetC: c.targetC, setC: c.state.setpointC, what, asleep: c.asleep };
  });
  return { steps, asleepCount: plan.asleepCount, total: plan.total, quiet: plan.quiet, maxExtraAsleep: plan.maxExtraAsleep };
}
const fmtC = (c: number | undefined) => (c === undefined ? '' : `${c.toFixed(1)}°`);

/**
 * Preview of the plan with or without quiet mode, kept on this device like the plan itself. It does not change the
 * aircon: the backend runs quiet mode unless AC_QUIET=false is set on the server.
 */
export const useQuietMode = () => usePref<boolean>('quietMode', true);

export interface LastNightOnPlan {
  date: string;
  onTargetPct: number;
  earlyMean: number;
  warmest: number;
  warmestAt: number;
  corrections: number;
  commands: number;
}
export function lastNightOnPlan(ds: Dataset | null): LastNightOnPlan | null {
  const n = ds?.nights.at(-1);
  const r = ds?.room.at(-1);
  if (!n || !r) return null;
  const inBed = n.room.filter((x) => x.ts >= n.lightsOut && x.ts <= n.wake);
  let warm = inBed[0];
  for (const x of inBed) if (warm && x.tempC > warm.tempC) warm = x;
  const total = Math.max(1, (n.wake - n.lightsOut) / MIN);
  return {
    date: n.date,
    onTargetPct: Math.min(100, (r.minutesTempInTarget / total) * 100),
    earlyMean: r.tempEarlyMean,
    warmest: warm?.tempC ?? NaN,
    warmestAt: warm?.ts ?? n.wake,
    corrections: n.ac.filter((c) => c.reason.startsWith('correction') || c.reason.startsWith('emergency')).length,
    commands: n.ac.length,
  };
}

export interface NightCounts {
  total: number;
  complete: number;
  sick: number;
  away: number;
  gaps: number;
  first: string;
  last: string;
}
/** "90 nights, 80 with complete data": sick and away nights and nights missing a person are left out of the Lab. */
export function nightCounts(ds: Dataset | null): NightCounts | null {
  if (!ds || !ds.nights.length) return null;
  let sick = 0;
  let away = 0;
  let gaps = 0;
  ds.nights.forEach((n, i) => {
    if (n.tags.includes('sick')) sick++;
    else if (n.tags.includes('travel')) away++;
    else if (ds.people.some((p) => !ds.person[p.id]?.[i])) gaps++;
  });
  return { total: ds.nights.length, complete: ds.nights.length - sick - away - gaps, sick, away, gaps, first: ds.nights[0]!.date, last: ds.nights.at(-1)!.date };
}

export interface DriftAlert {
  date: string;
  min: number;
}
export function driftAlerts(ds: Dataset | null): DriftAlert[] {
  return (ds?.nights ?? [])
    .map((n) => {
      const xs = n.room.filter((r) => r.ts >= n.lightsOut && r.ts <= n.wake).map((r) => r.co2);
      return { date: n.date, min: xs.length ? Math.min(...xs) : Infinity };
    })
    .filter((x) => x.min < 420)
    .reverse();
}

// ───────────────────────────── stores (this device) ─────────────────────────────

/** The night tags apply to: from noon on, the night ending tomorrow morning. */
export const tonightDate = (now = Date.now()) => (ictHour(now) >= 12 ? addDays(ictDate(now), 1) : ictDate(now));

/** Tonight's tags. `night` is null until mounted (the date depends on the clock, so it is never prerendered). */
export function useTonightTags(): [TagKey[], (k: TagKey) => void, string | null] {
  const [store, setStore] = usePref<Record<string, TagKey[]>>('tags', {});
  const [night, setNight] = useState<string | null>(null);
  useEffect(() => setNight(tonightDate()), []);
  const tags = night ? store[night] ?? [] : [];
  const toggle = (k: TagKey) =>
    night &&
    setStore((st) => {
      const cur = st[night] ?? [];
      return { ...st, [night]: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] };
    });
  return [tags, toggle, night];
}

export function useSetupProgress() {
  const [done, setDone] = usePref<Record<string, boolean>>('setup', {});
  const count = SETUP.filter((g) => done[g.id]).length;
  return { done, setDone, count, total: SETUP.length };
}

export interface Calibration {
  date: string;
  ppm: number;
  note: string;
}
export const useCalibrations = () => usePref<Calibration[]>('calibrations', []);

export const useMorningReport = () => usePref<boolean>('morningReport', false);

export const isDefaultCurve = (c: TemperatureCurve) => c === DEFAULT_CURVE;
