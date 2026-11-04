import { describe, expect, it } from 'vitest';
import {
  batteryAlert,
  batteryCycle,
  batteryFromDevices,
  batteryText,
  estimateDrain,
  hoursLeftText,
  inIctHours,
  listenerAlert,
  needsCharge,
  nextListenerWatch,
  parseAlertSettings,
  staleAlert,
  whenText,
  BATTERY_HOURS,
  STALE_HOURS,
  type BatteryReading,
} from '../src/index.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY_MS = 24 * HOUR;
const t = (s: string) => Date.parse(`${s}+07:00`);

/** Hourly readings from `start`, starting at `level`, losing `rate` %/h. */
const drain = (start: number, level: number, rate: number, hours: number): BatteryReading[] =>
  Array.from({ length: hours + 1 }, (_, i) => ({ ts: start + i * HOUR, level: Math.round(level - rate * i) }));

describe('battery cycle', () => {
  it('starts after the last charge (a rise of ≥ 3 points) and ignores 1-point jitter', () => {
    const s = t('2026-11-03T08:00:00');
    const r: BatteryReading[] = [
      { ts: s, level: 30 },
      { ts: s + HOUR, level: 28 },
      { ts: s + 2 * HOUR, level: 95 }, // charged
      { ts: s + 3 * HOUR, level: 94 },
      { ts: s + 4 * HOUR, level: 95 }, // jitter, not a charge
      { ts: s + 5 * HOUR, level: 93 },
    ];
    const c = batteryCycle(r);
    expect(c.map((x) => x.level)).toEqual([95, 94, 95, 93]);
    expect(c[0]!.ts).toBe(s + 2 * HOUR);
  });

  it('sorts, drops invalid levels and duplicate timestamps', () => {
    const s = t('2026-11-03T08:00:00');
    const c = batteryCycle([
      { ts: s + HOUR, level: 50 },
      { ts: s, level: 51 },
      { ts: s + 2 * HOUR, level: 140 },
      { ts: s + 2 * HOUR, level: NaN },
      { ts: s + HOUR, level: 49 },
    ]);
    expect(c).toEqual([{ ts: s, level: 51 }, { ts: s + HOUR, level: 49 }]);
  });
});

describe('drain estimate', () => {
  it('needs a 3 h span for a rate', () => {
    const s = t('2026-11-04T08:00:00');
    const e = estimateDrain(drain(s, 80, 1, 2), s + 2 * HOUR)!;
    expect(e.ratePerHour).toBeNull();
    expect(e.hoursLeft).toBeNull();
    expect(e.levelNow).toBe(78);
    expect(e.cycleStart).toBe(s);
  });

  it('least-squares rate, projected to now, hours left', () => {
    const s = t('2026-11-04T08:00:00');
    const e = estimateDrain(drain(s, 80, 2, 6), s + 8 * HOUR)!; // last reading 68 at +6 h
    expect(e.ratePerHour).toBeCloseTo(2, 5);
    expect(e.level).toBe(68);
    expect(e.levelNow).toBeCloseTo(64, 5); // 2 h later
    expect(e.hoursLeft).toBeCloseTo(32, 5);
  });

  it('resets after a charge', () => {
    const s = t('2026-11-03T08:00:00');
    const before = drain(s, 60, 3, 10); // down to 30
    const after = drain(s + 11 * HOUR, 100, 0.5, 2); // charged, only 2 h since
    const e = estimateDrain([...before, ...after], s + 13 * HOUR)!;
    expect(e.cycleStart).toBe(s + 11 * HOUR);
    expect(e.ratePerHour).toBeNull();
    expect(e.level).toBe(99);
  });

  it('flat cycle: rate 0, no hours left; none without readings', () => {
    const s = t('2026-11-04T08:00:00');
    const e = estimateDrain(drain(s, 100, 0, 4), s + 4 * HOUR)!;
    expect(e.ratePerHour).toBe(0);
    expect(e.hoursLeft).toBeNull();
    expect(estimateDrain([], s)).toBeNull();
  });

  it('text', () => {
    expect(hoursLeftText(0.5)).toBe('under an hour');
    expect(hoursLeftText(14.2)).toBe('14 h');
    expect(hoursLeftText(120)).toBe('5 days');
    const s = t('2026-11-04T08:00:00');
    expect(batteryText(estimateDrain(drain(s, 90, 0.7, 6), s + 6 * HOUR)!)).toMatch(/^86 %, ~6 days left$/);
    expect(batteryText(estimateDrain(drain(s, 40, 1, 1), s + HOUR)!)).toBe('39 %');
  });
});

describe('needs charge', () => {
  const base = { level: 50, at: 0, levelNow: 50, ratePerHour: 1, hoursLeft: 50, cycleStart: 0, readings: 5 };
  it('hours left < 24, level ≤ 15, or ≤ 20 without a rate', () => {
    expect(needsCharge(base)).toBe(false);
    expect(needsCharge({ ...base, hoursLeft: 23 })).toBe(true);
    expect(needsCharge({ ...base, levelNow: 15, hoursLeft: 100 })).toBe(true);
    expect(needsCharge({ ...base, levelNow: 20, ratePerHour: null, hoursLeft: null })).toBe(true);
    expect(needsCharge({ ...base, levelNow: 21, ratePerHour: null, hoursLeft: null })).toBe(false);
    expect(needsCharge({ ...base, levelNow: 20, ratePerHour: 0, hoursLeft: null })).toBe(false);
  });
});

describe('quiet hours', () => {
  it('[from, until) in ICT', () => {
    expect(inIctHours(t('2026-11-04T07:59:00'), BATTERY_HOURS)).toBe(false);
    expect(inIctHours(t('2026-11-04T08:00:00'), BATTERY_HOURS)).toBe(true);
    expect(inIctHours(t('2026-11-04T21:29:00'), BATTERY_HOURS)).toBe(true);
    expect(inIctHours(t('2026-11-04T21:30:00'), BATTERY_HOURS)).toBe(false);
    expect(inIctHours(t('2026-11-04T21:45:00'), STALE_HOURS)).toBe(true);
    expect(inIctHours(t('2026-11-04T22:00:00'), STALE_HOURS)).toBe(false);
  });

  it('when text', () => {
    const now = t('2026-11-04T10:00:00');
    expect(whenText(t('2026-11-04T08:20:00'), now)).toBe('08:20');
    expect(whenText(t('2026-11-03T14:20:00'), now)).toBe('yesterday 14:20');
    expect(whenText(t('2026-11-02T14:20:00'), now)).toBe('Mon 14:20');
  });
});

describe('battery alert', () => {
  // 2 %/h from 45 % at 08:00 → 33 % at 14:00, about 17 h left.
  const s = t('2026-11-04T08:00:00');
  const r = drain(s, 45, 2, 6);
  it('sends once per cycle, inside 08:00–21:30', () => {
    const now = t('2026-11-04T14:00:00');
    const e = estimateDrain(r, now)!;
    const d = batteryAlert({ name: 'Erik', estimate: e, state: { cycle: null }, now });
    expect(d.send).toBe(true);
    expect(d.body).toBe('Charge your Fitbit before bed — 33 %, about 17 h left');
    expect(d.title).toBe('Erik’s Fitbit battery');
    expect(d.state.cycle).toBe(s);
    const again = batteryAlert({ name: 'Erik', estimate: e, state: d.state, now: now + HOUR });
    expect(again.send).toBe(false);
    expect(again.reason).toMatch(/already/);
  });

  it('a crossing at night waits for 08:00', () => {
    const night = t('2026-11-04T23:00:00');
    const e = estimateDrain(r, night)!;
    expect(batteryAlert({ name: 'Cath', estimate: e, state: { cycle: null }, now: night }).send).toBe(false);
    const morning = t('2026-11-05T08:00:00');
    const d = batteryAlert({ name: 'Cath', estimate: estimateDrain(r, morning)!, state: { cycle: null }, now: morning });
    expect(d.send).toBe(true);
  });

  it('a new cycle after a charge alerts again', () => {
    const now = t('2026-11-04T14:00:00');
    const first = batteryAlert({ name: 'Erik', estimate: estimateDrain(r, now)!, state: { cycle: null }, now });
    const later = drain(t('2026-11-04T16:00:00'), 31, 1, 4);
    const now2 = t('2026-11-04T20:00:00');
    const d = batteryAlert({ name: 'Erik', estimate: estimateDrain([...r, ...later], now2)!, state: first.state, now: now2 });
    // 33 → 31 → 27 is not a rise; still the same cycle as before → no second alert.
    expect(d.send).toBe(false);
    const charged = drain(t('2026-11-05T15:00:00'), 100, 5, 18); // a fast drain after charging
    const now3 = t('2026-11-06T09:30:00');
    const d3 = batteryAlert({ name: 'Erik', estimate: estimateDrain([...r, ...later, ...charged], now3)!, state: first.state, now: now3 });
    expect(d3.send).toBe(true);
    expect(d3.state.cycle).toBe(t('2026-11-05T15:00:00'));
  });

  it('no rate yet: ≤ 20 % alerts without hours', () => {
    const now = t('2026-11-04T09:00:00');
    const d = batteryAlert({ name: 'Cath', estimate: estimateDrain([{ ts: now - HOUR, level: 18 }], now), state: { cycle: null }, now });
    expect(d.send).toBe(true);
    expect(d.body).toBe('Charge your Fitbit before bed — 18 %');
  });

  it('fine battery does nothing', () => {
    const now = t('2026-11-04T14:00:00');
    const d = batteryAlert({ name: 'Cath', estimate: estimateDrain(drain(s, 90, 0.7, 6), now), state: { cycle: null }, now });
    expect(d.send).toBe(false);
    expect(d.reason).toMatch(/^fine/);
    expect(batteryAlert({ name: 'Cath', estimate: null, state: { cycle: null }, now }).send).toBe(false);
  });
});

describe('stale sync', () => {
  const now = t('2026-11-04T20:30:00');
  const seen = t('2026-11-04T14:20:00');
  it('once per episode, only when the server sync runs', () => {
    const d = staleAlert({ name: 'Erik', seenAt: seen, checkedAt: now - 30 * MIN, state: { seenAt: null }, now });
    expect(d.send).toBe(true);
    expect(d.body).toBe('Erik’s Fitbit hasn’t synced since 14:20 — open the Fitbit app');
    expect(staleAlert({ name: 'Erik', seenAt: seen, checkedAt: now, state: d.state, now: now + HOUR }).send).toBe(false);
    // A new sync then another gap: a new episode.
    const seen2 = t('2026-11-05T01:00:00');
    const now2 = t('2026-11-05T08:00:00');
    const d2 = staleAlert({ name: 'Erik', seenAt: seen2, checkedAt: now2, state: d.state, now: now2 });
    expect(d2.send).toBe(true);
    expect(d2.body).toBe('Erik’s Fitbit hasn’t synced since 01:00 — open the Fitbit app');
  });

  it('not stale, never synced, server down, outside hours', () => {
    expect(staleAlert({ name: 'E', seenAt: now - 5 * HOUR, checkedAt: now, state: { seenAt: null }, now }).send).toBe(false);
    expect(staleAlert({ name: 'E', seenAt: null, checkedAt: now, state: { seenAt: null }, now }).send).toBe(false);
    expect(staleAlert({ name: 'E', seenAt: seen, checkedAt: now - 3 * HOUR, state: { seenAt: null }, now }).reason).toMatch(/server/);
    // The server's run is fresh but failed (Google sign-in expired): not the band, no push.
    const failing = staleAlert({ name: 'E', seenAt: seen, checkedAt: now - 10 * MIN, checkOk: false, state: { seenAt: null }, now });
    expect(failing.send).toBe(false);
    expect(failing.reason).toMatch(/server sync failing/);
    expect(staleAlert({ name: 'E', seenAt: seen, checkedAt: now - 10 * MIN, checkOk: true, state: { seenAt: null }, now }).send).toBe(true);
    const late = t('2026-11-04T22:15:00');
    expect(staleAlert({ name: 'E', seenAt: seen, checkedAt: late, state: { seenAt: null }, now: late }).send).toBe(false);
  });
});

describe('night listener', () => {
  const from = t('2026-11-04T21:45:00');
  const base = { listening: true, night: '2026-11-05', from, macLabel: 'Erik’s Mac', state: { night: null } };
  it('stopped: 10 min without a minute row', () => {
    const last = t('2026-11-05T01:42:00');
    expect(listenerAlert({ ...base, lastMinute: last, now: t('2026-11-05T01:52:00') }).send).toBe(false);
    const d = listenerAlert({ ...base, lastMinute: last, now: t('2026-11-05T01:53:00') });
    expect(d.send).toBe(true);
    expect(d.body).toBe('Night listener stopped at 01:43 — check Erik’s Mac');
    expect(listenerAlert({ ...base, lastMinute: last, state: d.state, now: t('2026-11-05T03:00:00') }).send).toBe(false);
  });

  it('after a pause or a late arrival: 10 min from when listening resumed', () => {
    const last = t('2026-11-04T23:30:00');
    const resumed = t('2026-11-05T01:00:00');
    const w = nextListenerWatch(null, true, '2026-11-05', resumed);
    expect(w).toEqual({ since: resumed, night: '2026-11-05' });
    expect(nextListenerWatch(w, true, '2026-11-05', resumed + 15 * MIN)).toBe(w);
    expect(nextListenerWatch(w, false, '2026-11-05', resumed + 15 * MIN)).toBeNull();
    expect(nextListenerWatch(w, true, '2026-11-06', resumed + DAY_MS)).toEqual({ since: resumed + DAY_MS, night: '2026-11-06' });
    const at5 = listenerAlert({ ...base, lastMinute: last, listeningSince: resumed, now: resumed + 5 * MIN });
    expect(at5.send).toBe(false);
    expect(at5.reason).toMatch(/listening again since 01:00/);
    const at10 = listenerAlert({ ...base, lastMinute: last, listeningSince: resumed, now: resumed + 10 * MIN });
    expect(at10.send).toBe(true);
    // A minute row after the resume clears it.
    expect(listenerAlert({ ...base, lastMinute: resumed + 3 * MIN, listeningSince: resumed, now: resumed + 10 * MIN }).send).toBe(false);
  });

  it('never started; not listening', () => {
    const d = listenerAlert({ ...base, lastMinute: t('2026-11-04T07:00:00'), now: from + 15 * MIN });
    expect(d.body).toBe('Night listener didn’t start at 21:45 — check Erik’s Mac');
    expect(listenerAlert({ ...base, lastMinute: null, now: from + 5 * MIN }).send).toBe(false);
    expect(listenerAlert({ ...base, listening: false, lastMinute: null, now: from + 60 * MIN }).send).toBe(false);
  });
});

describe('settings and devices', () => {
  it('parses settings with defaults on', () => {
    expect(parseAlertSettings(null)).toEqual({ battery: true, staleSync: true, listener: true });
    expect(parseAlertSettings({ battery: false, stale_sync: 'x', listener: false })).toEqual({ battery: false, staleSync: true, listener: false });
  });

  it('battery from pairedDevices: the tracker first', () => {
    expect(batteryFromDevices([{ deviceType: 'PHONE', batteryLevel: 50 }, { deviceType: 'TRACKER', batteryLevel: '80', lastSyncTime: '2026-11-04T04:00:00Z' }])).toEqual({
      level: 80,
      ts: Date.parse('2026-11-04T04:00:00Z'),
    });
    expect(batteryFromDevices([{ deviceType: 'X', batteryLevel: 'LOW' }])).toBeNull();
    expect(batteryFromDevices(null)).toBeNull();
    expect(batteryFromDevices([{ batteryLevel: 33 }])).toEqual({ level: 33, ts: null });
  });
});
