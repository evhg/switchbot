import { describe, expect, it } from 'vitest';
import {
  alertDue,
  cameraEventRow,
  normalizeCameraLabel,
  parseCameraRequest,
  parseCameraTs,
  unknownAlertText,
  unknownToAlert,
  CAMERA_MAX_EVENTS,
  type CameraEvent,
} from '../src/index.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-11-02T14:05:00+07:00');
const iso = (offsetMin: number) => new Date(NOW + offsetMin * MIN).toISOString();

describe('parseCameraTs', () => {
  it('takes ISO with a zone or epoch ms, nothing else', () => {
    expect(parseCameraTs('2026-11-02T14:05:00+07:00')).toBe(NOW);
    expect(parseCameraTs('2026-11-02T07:05:00Z')).toBe(NOW);
    expect(parseCameraTs('2026-11-02T07:05:00.250Z')).toBe(NOW + 250);
    expect(parseCameraTs(NOW)).toBe(NOW);
    expect(parseCameraTs('2026-11-02T14:05:00')).toBeNull();
    expect(parseCameraTs('yesterday')).toBeNull();
    expect(parseCameraTs(-1)).toBeNull();
    expect(parseCameraTs(null)).toBeNull();
  });
});

describe('normalizeCameraLabel', () => {
  it('lower-cases fixed labels and person ids, keeps guest names', () => {
    expect(normalizeCameraLabel(' A ')).toBe('a');
    expect(normalizeCameraLabel('Unknown')).toBe('unknown');
    expect(normalizeCameraLabel('PERSON')).toBe('person');
    expect(normalizeCameraLabel('Noi  (maid)')).toBeNull();
    expect(normalizeCameraLabel('Noi   maid')).toBe('Noi maid');
    expect(normalizeCameraLabel('Khun Ploy')).toBe('Khun Ploy');
    expect(normalizeCameraLabel('ปลา')).toBe('ปลา');
  });
  it('refuses empty, long, markup and non-strings', () => {
    expect(normalizeCameraLabel('')).toBeNull();
    expect(normalizeCameraLabel('x'.repeat(41))).toBeNull();
    expect(normalizeCameraLabel('x'.repeat(40))).toBe('x'.repeat(40));
    expect(normalizeCameraLabel('<b>hi</b>')).toBeNull();
    expect(normalizeCameraLabel('-dash')).toBeNull();
    expect(normalizeCameraLabel(42)).toBeNull();
  });
});

describe('parseCameraRequest', () => {
  it('ping', () => {
    expect(parseCameraRequest({ ping: true }, NOW)).toEqual({ kind: 'ping' });
  });

  it('valid events are normalised, mapped to people and sorted; bad ones are reported by index', () => {
    const r = parseCameraRequest(
      {
        camera: 'Living',
        events: [
          { ts: iso(-1), label: 'b', confidence: 0.91, activity: 'Sofa', durationS: 120.4 },
          { ts: iso(-5), label: 'a', confidence: '0.8', activity: 'desk' },
          { ts: iso(-2), label: 'unknown', confidence: 0.4 },
          { ts: iso(-3), label: 'person' },
          { ts: iso(-3), label: 'Khun Ploy', confidence: 0.77, duration_s: 600 },
          { ts: iso(-3), label: 'a', confidence: 1.2 },
          { ts: iso(-60 * 25), label: 'a' },
          { ts: iso(-3), label: '' },
          { ts: iso(-3), label: 'a', activity: 'Desk<script>' },
          { ts: iso(-3), label: 'a', durationS: -1 },
          'nope',
        ],
      },
      NOW,
    );
    expect(r.kind).toBe('events');
    if (r.kind !== 'events') return;
    expect(r.events.map((e) => e.label)).toEqual(['a', 'person', 'Khun Ploy', 'unknown', 'b']);
    expect(r.events[0]).toEqual({ ts: NOW - 5 * MIN, camera: 'living', label: 'a', personId: 'a', confidence: 0.8, activity: 'desk', durationS: null });
    expect(r.events[4]).toMatchObject({ personId: 'b', activity: 'sofa', durationS: 120 });
    expect(r.events[2]).toMatchObject({ personId: null, durationS: 600 });
    expect(r.events[1]).toMatchObject({ personId: null, confidence: null });
    expect(r.rejected.map((x) => x.index)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(r.rejected[0]!.reason).toMatch(/confidence/);
    expect(r.rejected[1]!.reason).toMatch(/1 day/);
  });

  it('whole-request errors', () => {
    expect(parseCameraRequest([], NOW)).toMatchObject({ kind: 'error' });
    expect(parseCameraRequest({}, NOW)).toMatchObject({ kind: 'error', error: 'events must be an array' });
    expect(parseCameraRequest({ events: [], camera: 'Bad/Name' }, NOW)).toMatchObject({ kind: 'error' });
    const many = Array.from({ length: CAMERA_MAX_EVENTS + 1 }, () => ({ ts: iso(0), label: 'a' }));
    expect(parseCameraRequest({ events: many }, NOW)).toMatchObject({ kind: 'error', error: 'at most 100 events per request' });
    expect(parseCameraRequest({ events: many.slice(1) }, NOW)).toMatchObject({ kind: 'events' });
  });

  it('only the household person ids map to person_id', () => {
    const r = parseCameraRequest({ events: [{ ts: iso(0), label: 'c' }, { ts: iso(0), label: 'C' }] }, NOW, ['a', 'b', 'c']);
    expect(r.kind === 'events' && r.events.map((e) => e.personId)).toEqual(['c', 'c']);
  });
});

describe('row and alert helpers', () => {
  const ev = (label: string, offsetMin: number): CameraEvent => ({ ts: NOW + offsetMin * MIN, camera: 'living', label, personId: null, confidence: null, activity: null, durationS: null });

  it('cameraEventRow', () => {
    expect(cameraEventRow({ ...ev('a', 0), personId: 'a', durationS: 30 })).toEqual({
      ts: '2026-11-02T07:05:00.000Z', camera: 'living', label: 'a', person_id: 'a', confidence: null, activity: null, duration_s: 30, source: 'mac-relay',
    });
  });

  it('alertDue: never sent, or 30 min since the last push', () => {
    expect(alertDue(null, NOW)).toBe(true);
    expect(alertDue(NOW - 29 * MIN, NOW)).toBe(false);
    expect(alertDue(NOW - 30 * MIN, NOW)).toBe(true);
    expect(alertDue(NOW - 5 * MIN, NOW, 5)).toBe(true);
  });

  it('unknownToAlert: the newest recent unknown, never a backlog', () => {
    expect(unknownToAlert([ev('a', -1), ev('person', -1)], NOW)).toBeNull();
    expect(unknownToAlert([ev('unknown', -10), ev('unknown', -2), ev('a', 0)], NOW)?.ts).toBe(NOW - 2 * MIN);
    expect(unknownToAlert([ev('unknown', -45)], NOW)).toBeNull();
    expect(unknownToAlert([ev('unknown', 5)], NOW)).toBeNull();
  });

  it('unknownAlertText in ICT', () => {
    expect(unknownAlertText(ev('unknown', 0))).toBe('Unknown person seen at home (living room, 14:05)');
    expect(unknownAlertText({ ts: NOW, camera: 'bedroom' })).toBe('Unknown person seen at home (bedroom, 14:05)');
  });
});
