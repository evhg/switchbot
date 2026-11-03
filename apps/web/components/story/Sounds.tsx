'use client';
// Scene · Snoring & noise (after The air). What the Mac's night listener heard for the selected night (sound_minutes /
// sound_events, migration 0024; lib/sound.ts): loudness and snoring per minute on the night's time axis (lights-out →
// last up, as in The night), both hypnograms under it and Cath's wake-ups marked. One sentence answers "does the
// snoring wake Cath?" (wakeTriggers in @sleep-lab/core: snoring or a loud moment within 2 min before a wake-up).
// Clips of loud moments play inline (signed URLs from the private 'night-sounds' bucket, 1 h).
import { useMemo } from 'react';
import { nightSoundSummary, wakeTriggers } from '@sleep-lab/core';
import { dur, fmt, hm, MIN } from '@/lib/format.ts';
import { cathWakeStarts, dbText, eventWords, useClipUrls, useNightSounds, type SoundEvent } from '@/lib/sound.ts';
import { SoundChart, type WakeMark } from '../charts/SoundChart.tsx';
import { Reveal } from '../motion.tsx';
import { clock, usePlanClock } from '../system/model.ts';
import { EventList, Placeholder, Readout, Readouts } from '../ui.tsx';
import { possessive, type StoryModel } from './model.ts';
import { Scene, SceneCols, SceneText, VisHead } from './parts.tsx';
import s from './story.module.css';

/** Cath is household person 'a'. */
const CATH = 'a';
const LOOKBACK_MS = 2 * MIN;

/** Notable moments, with an inline player when a clip was kept. */
export function SoundMoments({ events, clips, max = 12, empty }: { events: readonly SoundEvent[]; clips: Record<string, string>; max?: number; empty?: string }) {
  if (!events.length) return empty ? <p className="sec">{empty}</p> : null;
  return (
    <EventList
      className={s.events}
      items={events.slice(0, max).map((e) => {
        const url = e.clipPath ? clips[e.clipPath] : undefined;
        const facts = [e.durationS === null ? null : e.durationS >= 60 ? dur(e.durationS / 60) : `${Math.max(1, Math.round(e.durationS))} s`, e.peakDb !== null ? `peak ${dbText(e.peakDb)}` : null].filter(Boolean).join(' · ');
        return {
          time: hm(e.ts),
          title: eventWords(e),
          detail: (
            <>
              {facts}
              {url && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <audio controls preload="none" src={url} style={{ display: 'block', width: '100%', maxWidth: 320, height: 36, marginTop: 6 }} aria-label={`${eventWords(e)} at ${hm(e.ts)}`} />
              )}
            </>
          ),
        };
      })}
    />
  );
}

/** "4 of your 6 wake-ups came within 2 min of snoring." (or a loud moment), from wakeTriggers' rows. */
function triggerSentence(name: string, rows: readonly { snore: boolean; loud: boolean }[]): string | null {
  if (!rows.length) return null;
  const who = possessive(name).toLowerCase() === 'your' ? 'your' : possessive(name);
  const n = rows.length;
  const snore = rows.filter((r) => r.snore).length;
  const any = rows.filter((r) => r.snore || r.loud).length;
  const wakes = `${n === 1 ? '' : `${n} `}wake-up${n === 1 ? '' : 's'}`;
  if (!any) return n === 1 ? `${who[0]!.toUpperCase()}${who.slice(1)} one wake-up didn’t follow snoring or a loud noise.` : `None of ${who} ${wakes} came within 2 min of snoring or a loud noise.`;
  if (snore === any) return n === 1 ? `${who[0]!.toUpperCase()}${who.slice(1)} one wake-up came within 2 min of snoring.` : `${snore} of ${who} ${wakes} came within 2 min of snoring.`;
  if (!snore) return `${any} of ${who} ${wakes} came within 2 min of a loud noise, none right after snoring.`;
  return `${any} of ${who} ${wakes} came within 2 min of snoring (${snore}) or a loud noise.`;
}

export function Sounds({ model }: { model: StoryModel }) {
  const cath = model.people.find((p) => p.id === CATH) ?? null;
  const erik = model.people.find((p) => p.id !== CATH) ?? null;
  const input = useMemo(
    () => ({ date: model.date, lightsOut: model.lo, wake: model.wake, snorerStages: erik?.night.sleep.stages }),
    [model.date, model.lo, model.wake, erik],
  );
  const { real, data, error } = useNightSounds(input);
  const pc = usePlanClock();
  const listenWindow = `from ${clock(pc.lightsOut - 15)} to ${clock(pc.wake + 30)}`;

  const minutes = data?.minutes ?? [];
  const events = data?.events ?? [];
  const summary = useMemo(() => (minutes.length ? nightSoundSummary(minutes, events) : null), [minutes, events]);
  const wakeStarts = useMemo(() => (cath ? cathWakeStarts(cath.night.sleep.stages) : []), [cath]);
  const triggers = useMemo(() => {
    if (!minutes.length || !wakeStarts.length) return [];
    const res = wakeTriggers(wakeStarts, minutes, events, { lookbackMs: LOOKBACK_MS });
    return res.rows.filter((r) => r.heard).map((r) => ({ ts: r.wakeAt, snore: r.snore, loud: r.loud }));
  }, [minutes, events, wakeStarts]);
  const clipEvents = useMemo(
    () => [...events].filter((e) => e.kind !== 'speech').sort((a, b) => (b.clipPath ? 1 : 0) - (a.clipPath ? 1 : 0) || (b.peakDb ?? -999) - (a.peakDb ?? -999)).slice(0, 8).sort((a, b) => a.ts - b.ts),
    [events],
  );
  const clips = useClipUrls(clipEvents, real);

  const wakes: WakeMark[] = triggers.length ? triggers.map((t) => ({ ts: t.ts, noisy: t.snore || t.loud })) : wakeStarts.map((ts) => ({ ts, noisy: false }));
  const lanes = model.people.map((p) => ({ name: p.name, stages: p.night.sleep.stages }));
  const cathName = cath?.name ?? 'Cath';

  if (data === null)
    return (
      <Scene id="sounds" title="Snoring & noise">
        <SceneCols text={<SceneText label="Snoring & noise" title="Listening back…" />}>
          <Placeholder height={260} />
        </SceneCols>
      </Scene>
    );

  if (!summary)
    return (
      <Scene id="sounds" title="Snoring & noise">
        <SceneCols
          text={
            <SceneText
              label="Snoring & noise"
              title="No night sounds for this night."
              lede={error ?? `Night sounds start tonight: the Mac listens ${listenWindow}, only while you sleep. Only loudness, snoring and short clips of loud moments are kept.`}
            />
          }
        >
          <Placeholder height={200} text="Nothing recorded" />
        </SceneCols>
      </Scene>
    );

  const snoreWords = summary.snoreMin >= 5 ? `Snoring for ${dur(summary.snoreMin)}` : 'Hardly any snoring';
  const longest = summary.longestSnoreRunMin >= 5 ? `, the longest stretch ${dur(summary.longestSnoreRunMin)}` : '';
  const title = `${snoreWords}${longest}.`;
  const sentence = triggerSentence(cathName, triggers);
  const lede = [
    `${fmt(summary.snorePct)}% of the ${dur(summary.listenedMin)} the Mac listened.`,
    summary.loudEvents ? `${summary.loudEvents} loud moment${summary.loudEvents === 1 ? '' : 's'}.` : 'No loud moments.',
    sentence,
    real ? null : 'Sample sounds (Simulated data).',
  ]
    .filter(Boolean)
    .join(' ');
  // The listen window runs lights-out − 15 min to wake + 30 min, a bit wider than the night's own axis: widen the
  // axis to every minute and moment heard, so everything counted in the stats is also drawn.
  const heardTs = [...minutes.map((m) => m.ts), ...events.map((e) => e.ts)];
  const from = Math.min(model.lo, ...heardTs);
  const to = Math.max(model.end, ...minutes.map((m) => m.ts + MIN), ...events.map((e) => e.ts));
  const aria = `Loudness and snoring per minute from ${hm(from)} to ${hm(to)}: ${dur(summary.snoreMin)} of snoring, ${summary.loudEvents} loud moments.`;

  return (
    <Scene id="sounds" title="Snoring & noise">
      <SceneCols text={<SceneText label="Snoring & noise" reading={dur(summary.snoreMin)} readingCap="Minutes with snoring" title={title} lede={lede} />}>
        <Reveal>
          <VisHead
            title={sentence ?? 'Loudness and snoring, minute by minute'}
            cap={`Average loudness (floor dotted) · snoring seconds per minute · ${cathName}’s wake-ups marked${wakes.some((w) => w.noisy) ? ', in colour when noise came first' : ''}`}
          />
          <SoundChart minutes={minutes} events={events} from={from} to={to} lanes={lanes} wakes={wakes} label={aria} />
        </Reveal>
        <Reveal delay={80}>
          <Readouts n={4}>
            <Readout label="Snoring" value={`${fmt(summary.snorePct)}%`} sub={dur(summary.snoreMin)} />
            <Readout label="Longest stretch" value={dur(summary.longestSnoreRunMin)} />
            <Readout label="Loud moments" value={fmt(summary.loudEvents)} sub={summary.loudestDb !== null ? `loudest ${dbText(summary.loudestDb)}` : undefined} />
            <Readout label="Quiet floor" value={dbText(summary.floorDb)} sub="room at its quietest" />
          </Readouts>
        </Reveal>
        <Reveal delay={120}>
          <h3 className="label">Notable moments</h3>
          <SoundMoments events={clipEvents} clips={clips} empty="Nothing stood out." />
        </Reveal>
      </SceneCols>
    </Scene>
  );
}
