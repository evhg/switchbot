import { describe, expect, it } from 'vitest';
import {
  calibrationLabelFromRow,
  calibrationSummary,
  clipAllowance,
  eventMinutes,
  labelCounts,
  labelledSnore,
  nightSoundSummary,
  parseSoundPayload,
  soundEventFromRow,
  soundEventRow,
  suggestedPeakAboveFloor,
  wakeTriggers,
  DEFAULT_PEAK_ABOVE_FLOOR_DB,
  type CalibrationLabel,
  type SoundEvent,
  type SoundMinute,
} from '../src/index.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-11-05T04:30:00+07:00');

const minute = (offsetMin: number, o: Partial<SoundMinute> = {}): SoundMinute => ({
  ts: NOW + offsetMin * MIN,
  dbAvg: -68,
  dbMax: -64,
  dbFloor: -71,
  snoreS: 0,
  snoreProb: 0,
  speechS: 0,
  coughS: 0,
  classes: {},
  n: 61,
  ...o,
});
const event = (offsetMin: number, o: Partial<SoundEvent> = {}): SoundEvent => ({
  ts: NOW + offsetMin * MIN,
  durationS: 5,
  kind: 'other',
  label: 'Whale vocalization',
  peakDb: -60,
  score: 0.3,
  wantClip: false,
  ...o,
});
const lab = (label: CalibrationLabel['label'], yamnet: string | null, peakDb: number | null = -60, floorDb: number | null = -71, at = '2026-11-05T05:00:00.000Z') => ({
  label,
  yamnet,
  peakDb,
  floorDb,
  labelledAt: at,
});

describe('calibrationSummary', () => {
  it('per YAMNet class snore precision, trusted classes and counts', () => {
    const s = calibrationSummary([
      lab('snore', 'Whale vocalization'),
      lab('snore', 'Whale vocalization'),
      lab('snore', 'Whale vocalization', -62),
      lab('not_snore', 'Whale vocalization', -50, -71, '2026-11-05T06:00:00.000Z'),
      lab('snore', 'Music', -58),
      lab('not_snore', 'Music'),
      lab('not_snore', 'Music'),
      lab('speech', 'Speech'),
      lab('other', null),
    ]);
    expect(s.total).toBe(9);
    expect(s.counts).toEqual({ snore: 4, not_snore: 3, speech: 1, other: 1 });
    expect(s.byYamnet[0]).toEqual({ yamnet: 'Whale vocalization', n: 4, snore: 3, notSnore: 1, precision: 0.75, trusted: true });
    expect(s.byYamnet.find((y) => y.yamnet === 'Music')).toMatchObject({ n: 3, snore: 1, precision: 0.33, trusted: false });
    expect(s.byYamnet.find((y) => y.yamnet === 'Speech')).toMatchObject({ n: 1, trusted: false });
    expect(s.snoreClasses).toEqual(['Whale vocalization']);
    // Snore gaps: 11, 11, 9, 13 → median 11 → 11 − 2 = 9.
    expect(s.peakAboveFloor).toEqual({ n: 4, median: 11 });
    expect(s.suggestedPeakAboveFloorDb).toBe(9);
    expect(s.updatedAt).toBe('2026-11-05T06:00:00.000Z');
  });

  it('defaults without labels', () => {
    const s = calibrationSummary([]);
    expect(s).toMatchObject({ total: 0, byYamnet: [], snoreClasses: [], peakAboveFloor: { n: 0, median: null }, updatedAt: null });
    expect(s.suggestedPeakAboveFloorDb).toBe(DEFAULT_PEAK_ABOVE_FLOOR_DB);
  });

  it('suggested threshold: needs 3, clamped to 4..10, 0.5 dB steps', () => {
    expect(suggestedPeakAboveFloor([3, 4])).toBe(10);
    expect(suggestedPeakAboveFloor([3, 4, 5])).toBe(4);
    expect(suggestedPeakAboveFloor([20, 25, 30])).toBe(10);
    expect(suggestedPeakAboveFloor([7.3, 8.1, 8.4])).toBe(6);
    expect(suggestedPeakAboveFloor([7.3, 8.4, 8.9, 9])).toBe(6.5);
  });

  it('a stored row joined with its event', () => {
    const l = calibrationLabelFromRow(
      { event_id: '17', label: 'snore', who: 'a', labelled_at: '2026-11-05T05:00:00+00:00' },
      { ts: '2026-11-04T21:12:03+00:00', kind: 'other', label: 'Whale vocalization', peak_db: -60.5, duration_s: 6, score: 0.21, uncertain: true },
      -71,
    );
    expect(l).toEqual({
      eventId: 17,
      ts: '2026-11-04T21:12:03.000Z',
      label: 'snore',
      who: 'a',
      kind: 'other',
      yamnet: 'Whale vocalization',
      peakDb: -60.5,
      floorDb: -71,
      durationS: 6,
      score: 0.21,
      uncertain: true,
      labelledAt: '2026-11-05T05:00:00.000Z',
    });
    expect(calibrationLabelFromRow({ event_id: 1, label: 'maybe', labelled_at: 'x' }, { ts: 'x', kind: 'other' })).toBeNull();
    expect(calibrationLabelFromRow({ event_id: 1, label: 'snore', labelled_at: 'x' }, null)).toBeNull();
  });

  it('labelCounts', () => {
    expect(labelCounts(['snore', 'snore', 'not_snore', 'speech', null, undefined])).toEqual({ snore: 2, notSnore: 1, total: 4 });
  });
});

describe('labels win over the detector', () => {
  it('eventMinutes covers [ts, ts + duration], own minute at least', () => {
    expect(eventMinutes({ ts: NOW + 30_000, durationS: 5 })).toEqual([NOW]);
    expect(eventMinutes({ ts: NOW + 50_000, durationS: 20 })).toEqual([NOW, NOW + MIN]);
    expect(eventMinutes({ ts: NOW, durationS: 60 })).toEqual([NOW]);
    expect(eventMinutes({ ts: NOW, durationS: null })).toEqual([NOW]);
    expect(eventMinutes({ ts: NOW, durationS: 7200 })).toHaveLength(60);
  });

  it('snore labels add minutes, not-snore labels take them out', () => {
    const ms = [minute(0), minute(1), minute(2, { snoreS: 30 }), minute(3, { snoreS: 30 }), minute(4)];
    const es = [
      event(0.2, { humanLabel: 'snore', labelWho: 'a' }), // minute 0
      event(1.5, { humanLabel: 'snore', durationS: 10 }), // minute 1
      event(2.1, { kind: 'snore', label: 'Snoring', humanLabel: 'not_snore' }), // minute 2 out
      event(4.1, { humanLabel: 'speech' }), // no effect
      event(9.5, { humanLabel: 'snore' }), // no summary row: still counted
    ];
    expect([...labelledSnore(es)].map(([t, v]) => [(t - NOW) / MIN, v])).toEqual([
      [0, true],
      [1, true],
      [2, false],
      [9, true],
    ]);
    const s = nightSoundSummary(ms, es);
    expect(s).toMatchObject({ listenedMin: 6, snoreMin: 4, labelAddedMin: 3, labelRemovedMin: 1, longestSnoreRunMin: 2 });
    // Without labels: the detector only.
    expect(nightSoundSummary(ms, es.map((e) => ({ ...e, humanLabel: null })))).toMatchObject({ listenedMin: 5, snoreMin: 2, labelAddedMin: 0, labelRemovedMin: 0 });
  });

  it('a snore label beats a not-snore label in the same minute', () => {
    const es = [event(0.1, { humanLabel: 'not_snore' }), event(0.5, { humanLabel: 'snore' })];
    expect(labelledSnore(es).get(NOW)).toBe(true);
  });

  it('wakeTriggers uses the labels', () => {
    const ms = [minute(0), minute(1), minute(2)];
    // 04:12 "Whale vocalization" labelled snoring, then Cath wakes at minute 2.
    const labelled = wakeTriggers([NOW + 2 * MIN], ms, [event(1.2, { humanLabel: 'snore' })]);
    expect(labelled.withSnore).toBe(1);
    expect(labelled.rows[0]!.event).toMatchObject({ label: 'Whale vocalization' });
    expect(wakeTriggers([NOW + 2 * MIN], ms, [event(1.2)]).withSnore).toBe(0);
    // A detector snore minute and snore event labelled "Not snoring" no longer count.
    const ms2 = [minute(0), minute(1, { snoreS: 30 }), minute(2)];
    const es2 = [event(1.2, { kind: 'snore', label: 'Snoring', humanLabel: 'not_snore', durationS: 30 })];
    expect(wakeTriggers([NOW + 2 * MIN], ms2, es2).withSnore).toBe(0);
    expect(wakeTriggers([NOW + 2 * MIN], ms2, [{ ...es2[0]!, humanLabel: null }]).withSnore).toBe(1);
  });
});

describe('uncertain (borderline) events', () => {
  it('parsed, stored only when true, and their own clip allowance', () => {
    const p = parseSoundPayload(
      {
        events: [
          { ts: NOW - MIN, kind: 'other', label: 'Whale vocalization', uncertain: true, wantClip: true },
          { ts: NOW - MIN, kind: 'snore', label: 'Snoring' },
          { ts: NOW - MIN, kind: 'other', label: 'Speech', uncertain: true, wantClip: true },
        ],
      },
      NOW,
    );
    expect(p.events.map((e) => e.uncertain)).toEqual([true, false, true]);
    // Before 0030: no uncertain key at all.
    expect(p.events.every((e) => !('uncertain' in soundEventRow(e)))).toBe(true);
    // After 0030: the key is on every row of a mixed batch (a bulk upsert would send NULL for a missing key).
    const rows = p.events.map((e) => soundEventRow(e, 'bedroom', '2026-11-05', { uncertainColumn: true }));
    expect(rows.map((r) => r.uncertain)).toEqual([true, false, true]);
    expect(rows.every((r) => 'uncertain' in r)).toBe(true);
    expect(new Set(rows.map((r) => Object.keys(r).sort().join(','))).size).toBe(1);
    expect(rows[0]).toMatchObject({ uncertain: true, kind: 'other' });
    expect(p.events.map(clipAllowance)).toEqual(['uncertain', 'other', 'speech']);
    expect(soundEventFromRow({ ts: new Date(NOW).toISOString(), kind: 'other', uncertain: true }).uncertain).toBe(true);
  });
});
