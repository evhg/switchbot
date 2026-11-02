'use client';
/**
 * Map (/map): where Cath and Erik are now, and a timelapse of where they've been. Fixes come from each iPhone's
 * OwnTracks app through the owntracks Edge Function into public.locations (migration 0023; lib/location.ts).
 *
 *   Now        a marker per person (accuracy circle), home + radius, then a card each: place relative to home, last
 *              seen (ICT), battery, connection; and "Together" / "Apart · 4.1 km". Refreshes every 60 s while visible.
 *   Timelapse  Today / Yesterday / Last 24 h / Last 7 days or an ICT calendar day. A requestAnimationFrame clock moves
 *              the markers (positionAt; grey when the phone went quiet mid-move; each track starts at the last fix
 *              before the range, so someone who stayed put is shown from the start) and grows the tracks (trackUpTo) over the full
 *              tracks drawn faint; the scrubber shows when they were together (togetherSpans). Space plays/pauses,
 *              arrow keys step 5 min (Shift: 1 h). Reduced motion: starts paused.
 *
 * Map objects live in refs and are moved imperatively (components/map/layers.ts); per frame React only sees nothing,
 * the clock label is written straight to the DOM about 10 times a second. Google Maps when a key is saved in
 * System › Location, otherwise a simple SVG view. Signed out or in Simulated mode: a sample day in central Bangkok.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { haversineM, positionAt, togetherSpans, trackUpTo } from '@sleep-lab/core';
import { useAuth } from '@/lib/auth.tsx';
import { useData } from '@/lib/data/context.tsx';
import { DAY, HOUR, MIN, addDays, dayLabel, hm, ictDate, ictMidnight } from '@/lib/format.ts';
import {
  FALLBACK_NAMES,
  PERSON_IDS,
  SAMPLE_HOME,
  TOGETHER_M,
  TOGETHER_SKEW_MS,
  connLabel,
  distLabel,
  fetchTracks,
  sampleTracks,
  useLatestFixes,
  useLocationSettings,
  type Fix,
  type Home,
} from '@/lib/location.ts';
import { ago } from '../system/bands.tsx';
import { MapCanvas } from '../map/MapCanvas.tsx';
import type { LatLon, MapLayer } from '../map/layers.ts';
import { systemHref, useChrome } from '../nav.tsx';
import { Button, PageHeader, Segmented, Skeleton, Status, Switch } from '../ui.tsx';
import s from './map.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type View = 'now' | 'timelapse';
/** A gap longer than this in a track: the marker greys out and "together" isn't claimed across it. */
const MAX_GAP_MS = 30 * MIN;

interface Ctx {
  real: boolean;
  home: Home | null;
  mapsKey: string | null;
  nameOf: (id: string) => string;
}

const initial = (name: string, id: string) => (name.trim()[0] ?? id).toUpperCase();

export function MapScreen() {
  useChrome({ title: 'Map' });
  const auth = useAuth();
  const { mode, dataset, latest } = useData();
  const real = auth.status === 'signed-in' && !!auth.probe?.member && mode !== 'sim';
  const { settings, error } = useLocationSettings(real);
  const people = (dataset ?? latest)?.people;
  const nameOf = useCallback(
    (id: string) => {
      const n = people?.find((p) => p.id === id)?.name?.trim();
      return n && n.toLowerCase() !== 'you' ? n : (FALLBACK_NAMES[id] ?? id);
    },
    [people],
  );
  const [view, setView] = useState<View>('now');
  const waiting = auth.status === 'loading' || (auth.status === 'signed-in' && !auth.settled) || settings === undefined;
  const ctx: Ctx = { real, home: real ? (settings?.home ?? null) : SAMPLE_HOME, mapsKey: real ? (settings?.mapsKey ?? null) : null, nameOf };

  return (
    <div className={cx('content', s.page)}>
      <PageHeader
        title="Map"
        lede={real ? 'Where you both are, from the OwnTracks app on each iPhone.' : 'A sample day in Bangkok. Sign in as a household member to see your own tracks.'}
        actions={
          <Segmented<View>
            label="Map view"
            value={view}
            onChange={setView}
            options={[
              { value: 'now', label: 'Now' },
              { value: 'timelapse', label: 'Timelapse' },
            ]}
          />
        }
      />
      {error && <p className={cx('sec', s.alert)}>{error}</p>}
      {waiting ? <Skeleton h={420} r="lg" /> : view === 'now' ? <NowView {...ctx} /> : <TimelapseView {...ctx} />}
      {!waiting && real && !ctx.mapsKey && (
        <div className={cx('card', s.setup)}>
          <Status tone="off">
            <b>Simple view: Google Maps isn’t set up</b>
          </Status>
          <p className="sec">
            The tracks are drawn to scale, without streets. To see them on Google Maps, paste the household’s browser key in{' '}
            <a href={systemHref('location')}>System › Location</a> (Google Maps key).
          </p>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────── Now ─────────────────────────────────────────

function useVisibleTick(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const bump = () => document.visibilityState === 'visible' && setN((x) => x + 1);
    const id = window.setInterval(bump, ms);
    document.addEventListener('visibilitychange', bump);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', bump);
    };
  }, [ms]);
  return n;
}

function NowView({ real, home, mapsKey, nameOf }: Ctx) {
  const tick = useVisibleTick(60_000);
  const { fixes, error } = useLatestFixes(real, tick);
  const [layer, setLayer] = useState<MapLayer | null>(null);
  const now = Date.now();

  useEffect(() => {
    if (!layer || !fixes) return;
    layer.setHome(home);
    const pts: LatLon[] = [];
    for (const id of PERSON_IDS) {
      const f = fixes[id];
      layer.setMarker(id, f ? { lat: f.lat, lon: f.lon, accM: f.accM, label: initial(nameOf(id), id), stale: Date.now() - f.ts > 6 * HOUR } : null);
      if (f) pts.push(f);
    }
    if (home && pts.length < 2) pts.push(home);
    layer.fit(pts);
  }, [layer, fixes, home, nameOf]);

  const a = fixes?.a ?? null;
  const b = fixes?.b ?? null;
  const together = a && b ? togetherLine(a, b) : null;

  return (
    <>
      <MapCanvas mapsKey={mapsKey} onLayer={setLayer} label="Map: where everyone is now" />
      {error && <p className={cx('sec', s.alert)}>{error}</p>}
      {together && (
        <p className={s.together} aria-live="polite">
          <Status tone={together.on ? 'on' : 'off'}>{together.text}</Status>
        </p>
      )}
      <div className={s.cards}>
        {PERSON_IDS.map((id) => {
          const f = fixes?.[id];
          return (
            <section key={id} className={cx('card', s.person)} data-person={id}>
              <header className={s.personH}>
                <span className={s.swatch} aria-hidden>
                  {initial(nameOf(id), id)}
                </span>
                <b>{nameOf(id)}</b>
              </header>
              {fixes === undefined ? (
                <Skeleton w={160} h={14} r="text" />
              ) : !f ? (
                <p className="sec">
                  No location yet. Set up OwnTracks in <a href={systemHref('location')}>System › Location</a>.
                </p>
              ) : (
                <dl className={s.kv}>
                  <div>
                    <dt>Where</dt>
                    <dd>{placeLabel(f, home)}</dd>
                  </div>
                  <div>
                    <dt>Last seen</dt>
                    <dd className="num">
                      {ago(f.ts, now)}
                      {now - f.ts >= 60 * MIN ? '' : ` · ${hm(f.ts)}`}
                    </dd>
                  </div>
                  {f.batt !== null && (
                    <div>
                      <dt>Battery</dt>
                      <dd className="num">{f.batt}%</dd>
                    </div>
                  )}
                  {connLabel(f) && (
                    <div>
                      <dt>Connection</dt>
                      <dd>{connLabel(f)}</dd>
                    </div>
                  )}
                  {f.accM != null && (
                    <div>
                      <dt>Accuracy</dt>
                      <dd className="num">± {distLabel(f.accM)}</dd>
                    </div>
                  )}
                </dl>
              )}
            </section>
          );
        })}
      </div>
      {!real && <p className={cx('cap', s.foot)}>Sample data (Simulated).</p>}
    </>
  );
}

function placeLabel(f: Fix, home: Home | null): string {
  if (!home) return 'Home not set';
  const d = haversineM(f, home);
  return d <= home.radiusM ? 'Home' : `${distLabel(d)} from home`;
}

function togetherLine(a: Fix, b: Fix): { on: boolean; text: string } {
  const d = haversineM(a, b);
  const on = d < TOGETHER_M && Math.abs(a.ts - b.ts) <= TOGETHER_SKEW_MS;
  return { on, text: on ? 'Together' : `Apart · ${distLabel(d)}` };
}

// ───────────────────────────────────────── Timelapse ─────────────────────────────────────────

type Preset = 'today' | 'yesterday' | '24h' | '7d';
type Range = { preset: Preset } | { date: string };
const PRESETS: readonly { value: Preset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '24h', label: 'Last 24 h' },
  { value: '7d', label: 'Last 7 days' },
];
/** Playback speed: simulated ms per real second. */
const SPEEDS: readonly { value: string; label: string; rate: number }[] = [
  { value: '60', label: '1 min/s', rate: MIN },
  { value: '600', label: '10 min/s', rate: 10 * MIN },
  { value: '3600', label: '1 h/s', rate: HOUR },
];

function rangeBounds(r: Range, now: number): { from: number; to: number } {
  const today = ictDate(now);
  if ('date' in r) {
    const from = ictMidnight(r.date);
    return { from, to: Math.min(now, from + DAY) };
  }
  switch (r.preset) {
    case 'today':
      return { from: ictMidnight(today), to: now };
    case 'yesterday':
      return { from: ictMidnight(addDays(today, -1)), to: ictMidnight(today) };
    case '24h':
      return { from: now - DAY, to: now };
    case '7d':
      return { from: now - 7 * DAY, to: now };
  }
}

function TimelapseView({ real, home, mapsKey, nameOf }: Ctx) {
  const [range, setRange] = useState<Range>({ preset: 'today' });
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const { from, to } = useMemo(() => rangeBounds(range, loadedAt), [range, loadedAt]);
  const [tracks, setTracks] = useState<Record<string, Fix[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trimmed, setTrimmed] = useState(false);
  const [layer, setLayer] = useState<MapLayer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState('3600');
  const [follow, setFollow] = useState(false);

  const tRef = useRef(from);
  const playingRef = useRef(false);
  const rateRef = useRef(HOUR);
  const followRef = useRef(false);
  const layerRef = useRef<MapLayer | null>(null);
  const tracksRef = useRef<Record<string, Fix[]> | null>(null);
  const boundsRef = useRef({ from, to });
  const scrub = useRef<HTMLInputElement>(null);
  const clockEl = useRef<HTMLSpanElement>(null);
  const dateEl = useRef<HTMLSpanElement>(null);
  const lastLabel = useRef(0);
  const dragging = useRef(false);
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;
  layerRef.current = layer;
  boundsRef.current = { from, to };
  rateRef.current = SPEEDS.find((x) => x.value === speed)?.rate ?? HOUR;
  followRef.current = follow;

  const pick = (r: Range) => {
    setLoadedAt(Date.now());
    setRange(r);
  };

  // Load the range.
  useEffect(() => {
    let alive = true;
    setTracks(null);
    setError(null);
    setTrimmed(false);
    if (!real) {
      setTracks(sampleTracks(from, to));
      return;
    }
    fetchTracks(from, to)
      .then((r) => {
        if (!alive) return;
        setTrimmed(r.trimmed);
        setTracks(r.tracks);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setTracks({});
      });
    return () => {
      alive = false;
    };
  }, [real, from, to]);
  tracksRef.current = tracks;

  const total = tracks ? PERSON_IDS.reduce((n, id) => n + (tracks[id]?.length ?? 0), 0) : 0;
  // Clipped to the range: the tracks start with each person's last fix before it.
  const spans = useMemo(
    () =>
      tracks
        ? togetherSpans(tracks.a ?? [], tracks.b ?? [], { maxGapMs: MAX_GAP_MS, withinM: TOGETHER_M })
            .map((x) => ({ from: Math.max(from, x.from), to: Math.min(to, x.to) }))
            .filter((x) => x.to > x.from)
        : [],
    [tracks, from, to],
  );
  const togetherMs = spans.reduce((n, x) => n + (x.to - x.from), 0);

  /** Draws the moment t: trails, markers, follow, scrubber and (throttled) the clock label. */
  const render = useCallback((t: number, forceLabel = false) => {
    const l = layerRef.current;
    const tr = tracksRef.current;
    if (l && tr) {
      const trails: Record<string, ReturnType<typeof trackUpTo>> = {};
      const pts: LatLon[] = [];
      for (const id of PERSON_IDS) {
        const track = tr[id] ?? [];
        trails[id] = trackUpTo(track, t);
        const p = positionAt(track, t, MAX_GAP_MS);
        l.setMarker(id, p ? { lat: p.lat, lon: p.lon, label: initial(nameRef.current(id), id), stale: p.stale } : null);
        if (p) pts.push(p);
      }
      l.setTrails(trails);
      if (followRef.current && pts.length) l.keepInView(pts);
    }
    const now = performance.now();
    if (scrub.current && !dragging.current) scrub.current.value = String(t);
    if (forceLabel || now - lastLabel.current > 100) {
      lastLabel.current = now;
      const day = dayLabel(ictDate(t));
      if (clockEl.current) clockEl.current.textContent = hm(t);
      if (dateEl.current) dateEl.current.textContent = day;
      scrub.current?.setAttribute('aria-valuetext', `${hm(t)}, ${day}`);
    }
  }, []);

  const setPlay = useCallback((on: boolean) => {
    playingRef.current = on;
    setPlaying(on);
  }, []);

  // New data or a new map: draw the full tracks faint, frame them, start at the beginning.
  useEffect(() => {
    if (!tracks) return;
    tRef.current = boundsRef.current.from;
    if (layer) {
      layer.setHome(home);
      layer.setTracks(tracks);
      const pts: LatLon[] = [];
      for (const id of PERSON_IDS) {
        const tr = tracks[id] ?? [];
        const step = Math.max(1, Math.floor(tr.length / 400));
        for (let i = 0; i < tr.length; i += step) pts.push(tr[i]!);
        if (tr.length) pts.push(tr.at(-1)!);
      }
      if (!pts.length && home) pts.push(home);
      layer.fit(pts);
    }
    render(tRef.current, true);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setPlay(!reduce && total > 0);
  }, [tracks, layer, home, render, setPlay, total]);

  // The clock: runs only while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const { to: end } = boundsRef.current;
      let t = tRef.current + dt * rateRef.current;
      if (t >= end) {
        t = end;
        tRef.current = t;
        render(t, true);
        setPlay(false);
        return;
      }
      tRef.current = t;
      render(t);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, render, setPlay]);

  const seek = useCallback(
    (t: number) => {
      const { from: a, to: b } = boundsRef.current;
      tRef.current = Math.min(b, Math.max(a, t));
      render(tRef.current, true);
    },
    [render],
  );

  const toggle = useCallback(() => {
    if (!playingRef.current && tRef.current >= boundsRef.current.to) seek(boundsRef.current.from);
    setPlay(!playingRef.current);
  }, [seek, setPlay]);

  // Keyboard: Space plays/pauses, arrows step (not while typing in a field, or on the scrubber, which steps itself).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range'))) return;
      if (e.key === ' ' || e.code === 'Space') {
        if (el?.tagName === 'BUTTON' || (el?.getAttribute('role') ?? '') === 'radio') return;
        e.preventDefault();
        toggle();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && el !== scrub.current && el?.getAttribute('role') !== 'radio') {
        e.preventDefault();
        seek(tRef.current + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? HOUR : 5 * MIN));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, seek]);

  const today = ictDate(loadedAt);
  const len = Math.max(1, to - from);

  return (
    <>
      <div className={s.rangeBar}>
        <Segmented<Preset | 'date'>
          label="Range"
          value={'date' in range ? 'date' : range.preset}
          onChange={(v) => v !== 'date' && pick({ preset: v })}
          options={PRESETS}
        />
        <label className={s.dateField}>
          <span className="sr-only">Day</span>
          <input
            type="date"
            className="input num"
            max={today}
            value={'date' in range ? range.date : ''}
            onChange={(e) => e.target.value && pick({ date: e.target.value })}
          />
        </label>
      </div>

      <MapCanvas mapsKey={mapsKey} onLayer={setLayer} label="Map: timelapse of both tracks" />
      {error && <p className={cx('sec', s.alert)}>{error}</p>}
      {trimmed && <p className={cx('sec', s.alert)}>Too many fixes in this range to load them all: the start of the range is left out. Pick a shorter range to see it.</p>}

      {tracks === null ? (
        <Skeleton h={88} r="lg" className={s.controlsSkel} />
      ) : total === 0 ? (
        <div className={cx('card', s.setup)}>
          <Status tone="off">
            <b>No locations in this range</b>
          </Status>
          <p className="sec">
            Locations arrive from the OwnTracks app on each iPhone. Set it up in <a href={systemHref('location')}>System › Location</a> (about 3 minutes); for
            detailed trails choose the “Move” monitoring mode.
          </p>
        </div>
      ) : (
        <div className={cx('card', s.controls)}>
          <div className={s.clockRow}>
            <Button variant="primary" onClick={toggle} aria-keyshortcuts="Space" className={s.playBtn} icon={playing ? undefined : 'play'}>
              {playing ? 'Pause' : 'Play'}
            </Button>
            <div className={s.clock} aria-live="off">
              <span ref={clockEl} className={cx('num', s.clockT)}>
                {hm(from)}
              </span>
              <span ref={dateEl} className={cx('cap', s.clockD)}>
                {dayLabel(ictDate(from))}
              </span>
            </div>
            <Segmented label="Speed" value={speed} onChange={setSpeed} options={SPEEDS} />
          </div>
          <div className={s.scrubWrap}>
            <div className={s.band} aria-hidden>
              {spans.map((x) => (
                <i key={x.from} style={{ left: `${((x.from - from) / len) * 100}%`, width: `${Math.max(0.4, ((x.to - x.from) / len) * 100)}%` }} />
              ))}
            </div>
            <input
              ref={scrub}
              type="range"
              className={s.scrub}
              min={from}
              max={to}
              step={MIN}
              defaultValue={from}
              aria-label="Time"
              onPointerDown={() => {
                dragging.current = true;
                const up = () => {
                  dragging.current = false;
                  window.removeEventListener('pointerup', up);
                  window.removeEventListener('pointercancel', up);
                };
                window.addEventListener('pointerup', up);
                window.addEventListener('pointercancel', up);
              }}
              onInput={(e) => seek(Number((e.target as HTMLInputElement).value))}
            />
          </div>
          <div className={s.scrubFoot}>
            <span className="cap num">{hm(from)}</span>
            <span className={cx('cap', s.legend)}>
              <i className={s.legendBand} aria-hidden /> Together {togetherMs >= HOUR ? `${(togetherMs / HOUR).toFixed(1)} h` : `${Math.round(togetherMs / MIN)} min`}
            </span>
            <span className="cap num">{to >= Date.now() - MIN ? 'now' : hm(to)}</span>
          </div>
          <div className={s.followRow}>
            <Switch checked={follow} onChange={setFollow} label="Follow" />
            <span className="cap">Space plays or pauses; arrow keys step 5 min, with Shift 1 h.</span>
          </div>
        </div>
      )}
      {!real && <p className={cx('cap', s.foot)}>Sample data (Simulated).</p>}
    </>
  );
}
