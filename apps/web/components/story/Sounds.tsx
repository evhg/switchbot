'use client';
// Scene · Snoring & noise (after The air). What the Mac's night listener heard for the selected night (sound_minutes /
// sound_events, migration 0024; lib/sound.ts): loudness and snoring per minute on the night's time axis (lights-out →
// last up, as in The night), both hypnograms under it and Cath's wake-ups marked. One sentence answers "does the
// snoring wake Cath?" (wakeTriggers in @sleep-lab/core: snoring or a loud moment within 2 min before a wake-up).
// Clips of loud moments play inline (signed URLs from the private 'night-sounds' bucket, 1 h). "Sleep talk" lists the
// night's talking in sleep (migration 0029: kept while "Save sleep talk" is on; talking while both were awake is
// removed the next morning): time, "probably Cath/Erik" (talker_hint), the Mac's transcript in quotes and the clip.
// Under each clip: "Snoring" / "Not snoring" (then Cath / Erik / ?) — sound labels, migration 0030, lib/soundLabels.ts;
// after Not snoring, "What was it?" (Bird, Alarm clock, Noise, Movement, Talking, Other) and a free description (0034).
// A label wins over the detector in the minutes counted as snoring, and the Mac retunes itself from the labels.
import { useMemo, useState } from 'react';
import { nightSoundSummary, wakeTriggers } from '@sleep-lab/core';
import { dur, fmt, hm, MIN } from '@/lib/format.ts';
import { isSpeechEvent } from '@sleep-lab/core';
import { useAuth } from '@/lib/auth.tsx';
import { cathWakeStarts, dbText, eventWords, sleepTalkEvents, talkerWords, useClipUrls, useNightSounds, type SoundEvent } from '@/lib/sound.ts';
import { labelTally, useSoundLabels, withLabels, type Labelling, type SoundLabel, type SoundLabelWho } from '@/lib/soundLabels.ts';
import { SoundChart, type WakeMark } from '../charts/SoundChart.tsx';
import { BirdCard } from './BirdCard.tsx';
import { ClipPlayer } from './ClipPlayer.tsx';
import { Reveal } from '../motion.tsx';
import { clock, usePlanClock } from '../system/model.ts';
import { Chip, EventList, Input, Placeholder, Readout, Readouts } from '../ui.tsx';
import { possessive, type StoryModel } from './model.ts';
import { Scene, SceneCols, SceneText, VisHead } from './parts.tsx';
import s from './story.module.css';

/** Cath is household person 'a'. */
const CATH = 'a';
const LOOKBACK_MS = 2 * MIN;

const DEFAULT_NAMES: Readonly<Record<string, string>> = { a: 'Cath', b: 'Erik' };

/** "What was it?" after Not snoring (sound_labels.category, migration 0034). Talking is the existing 'speech' label. */
const WHAT: readonly { key: string; text: string }[] = [
  { key: 'bird', text: 'Bird' },
  { key: 'alarm', text: 'Alarm clock' },
  { key: 'noise', text: 'Noise' },
  { key: 'movement', text: 'Movement' },
  { key: 'talking', text: 'Talking' },
  { key: 'other', text: 'Other' },
];
const whatText = (k: string | null | undefined) => WHAT.find((w) => w.key === k)?.text ?? k ?? null;

/** Free description under a clip; saved on Enter or when the field loses focus. */
function NoteField({ e, labelling, busy }: { e: SoundEvent; labelling: Labelling; busy: boolean }) {
  const cur = labelling.labels.get(e.id) ?? null;
  const [v, setV] = useState(cur?.note ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const save = async () => {
    if ((cur?.note ?? '') === v.trim()) return;
    setState('saving');
    const err = await labelling.setNote(e.id, cur?.category ?? null, v);
    setState(err ? 'idle' : 'saved');
  };
  return (
    <span style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
      <Input
        aria-label={`Describe the sound at ${hm(e.ts)}`}
        placeholder="Describe it (optional): gecko, phone buzzing…"
        maxLength={500}
        value={v}
        disabled={busy}
        onChange={(ev) => {
          setV(ev.target.value);
          setState('idle');
        }}
        onBlur={() => void save()}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            (ev.target as HTMLInputElement).blur();
          }
        }}
        style={{ flex: 1, minWidth: 0 }}
      />
      {state !== 'idle' && <span className="sec">{state === 'saving' ? 'Saving…' : 'Saved'}</span>}
    </span>
  );
}

/** "Snoring" / "Not snoring" under a clip, then who snored (Cath / Erik / ?). Read-only text for viewers. */
function LabelButtons({ e, labelling, names }: { e: SoundEvent; labelling: Labelling; names: Readonly<Record<string, string>> }) {
  const cur = labelling.labels.get(e.id) ?? null;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = async (label: SoundLabel, who: SoundLabelWho | null = null) => {
    setBusy(true);
    setMsg(null);
    setMsg(await labelling.setLabel(e.id, label, who));
    setBusy(false);
  };
  const whoName = (w: SoundLabelWho | null) => (w === 'a' || w === 'b' ? (names[w] ?? DEFAULT_NAMES[w]) : w === 'both' ? 'both' : null);
  if (!labelling.canLabel) {
    if (!cur) return null;
    const what = whatText(cur.category);
    const words =
      cur.label === 'snore'
        ? `Labelled snoring${whoName(cur.who) ? ` (${whoName(cur.who)})` : ''}`
        : cur.label === 'not_snore'
          ? `Labelled ${what ? what.toLowerCase() : 'not snoring'}`
          : `Labelled ${cur.label === 'speech' ? 'sleep talk' : 'other'}`;
    return (
      <span style={{ display: 'block', marginTop: 4 }}>
        {words}
        {cur.note ? `: “${cur.note}”` : ''}
      </span>
    );
  }
  const chips = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } as const;
  return (
    <span style={{ display: 'block' }}>
      <span className="chips" role="group" aria-label={`Was the sound at ${hm(e.ts)} snoring?`} style={chips}>
        <Chip selected={cur?.label === 'snore'} disabled={busy} onClick={() => void set('snore', cur?.label === 'snore' ? cur.who : null)}>
          Snoring
        </Chip>
        <Chip selected={cur?.label === 'not_snore'} disabled={busy} onClick={() => void set('not_snore')}>
          Not snoring
        </Chip>
      </span>
      {cur?.label === 'snore' && (
        <span className="chips" role="group" aria-label="Who snored?" style={chips}>
          {(['a', 'b', 'unknown'] as const).map((w) => (
            <Chip key={w} selected={cur.who === w} disabled={busy} onClick={() => void set('snore', w)}>
              {w === 'unknown' ? '?' : (names[w] ?? DEFAULT_NAMES[w])}
            </Chip>
          ))}
        </span>
      )}
      {(cur?.label === 'not_snore' || cur?.label === 'speech' || cur?.label === 'other') && (
        <span className="chips" role="group" aria-label="What was it?" style={chips}>
          {WHAT.map((w) => {
            const selected = w.key === 'talking' ? cur.label === 'speech' : cur.label !== 'speech' && cur.category === w.key;
            return (
              <Chip
                key={w.key}
                selected={selected}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setMsg(null);
                  const done = (m: string | null) => {
                    setMsg(m);
                    setBusy(false);
                  };
                  if (w.key === 'talking') void labelling.setLabel(e.id, 'speech').then(done);
                  else if (cur.label === 'speech') void labelling.setLabel(e.id, 'not_snore').then((m) => (m ? done(m) : labelling.setNote(e.id, w.key, cur.note ?? null).then(done)));
                  else void labelling.setNote(e.id, selected ? null : w.key, cur.note ?? null).then(done);
                }}
              >
                {w.text}
              </Chip>
            );
          })}
        </span>
      )}
      {cur && <NoteField key={e.id} e={e} labelling={labelling} busy={busy} />}
      {msg && (
        <span className="sig" style={{ display: 'block', marginTop: 4 }}>
          {msg}
        </span>
      )}
    </span>
  );
}

/** "Labelled: 6 snore, 3 not. The Mac retunes itself every evening from these." */
export function LabelTally({ labelling }: { labelling: Labelling }) {
  const tally = labelTally(labelling.counts);
  if (!tally && !labelling.canLabel && !labelling.error) return null;
  return (
    <p className="sec">
      {tally ? `${tally}. ` : 'Tap Snoring or Not snoring under a clip. '}
      The Mac retunes itself every evening from these.
      {labelling.error && <span className="sig"> {labelling.error}</span>}
    </p>
  );
}

/**
 * Notable moments, with an inline player when a clip was kept (talking: who probably said it and the transcript).
 * With `labelling`, every moment with a clip (or a transcript, or sample data) gets the Snoring / Not snoring buttons.
 */
export function SoundMoments({
  events,
  clips,
  max = 12,
  empty,
  names = {},
  labelling,
}: {
  events: readonly SoundEvent[];
  clips: Record<string, string>;
  max?: number;
  empty?: string;
  names?: Readonly<Record<string, string>>;
  labelling?: Labelling;
}) {
  if (!events.length) return empty ? <p className="sec">{empty}</p> : null;
  return (
    <EventList
      className={s.events}
      items={events.slice(0, max).map((e) => {
        const url = e.clipPath ? clips[e.clipPath] : undefined;
        const speech = isSpeechEvent(e);
        const facts = [
          speech ? talkerWords(e.talkerHint, names) : null,
          e.uncertain && e.label && !speech ? `sounded like “${e.label}”` : null,
          e.durationS === null ? null : e.durationS >= 60 ? dur(e.durationS / 60) : `${Math.max(1, Math.round(e.durationS))} s`,
          !speech && e.peakDb !== null ? `peak ${dbText(e.peakDb)}` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return {
          time: hm(e.ts),
          title: eventWords(e),
          detail: (
            <>
              {facts}
              {speech && e.transcript && <span style={{ display: 'block', marginTop: 4, fontStyle: 'italic' }}>“{e.transcript}”</span>}
              {url && <ClipPlayer url={url} label={`${eventWords(e)} at ${hm(e.ts)}`} />}
              {e.bird && <BirdCard bird={e.bird} />}
              {labelling && (e.clipPath || e.transcript || e.sample) && <LabelButtons e={e} labelling={labelling} names={names} />}
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
  const auth = useAuth();
  const labelling = useSoundLabels(real, real && (auth.probe?.role === 'owner' || auth.probe?.role === 'member'));
  const pc = usePlanClock();
  const listenWindow = `from ${clock(pc.lightsOut - 15)} to ${clock(pc.wake + 30)}`;

  const minutes = useMemo(() => data?.minutes ?? [], [data]);
  // The household's labels win over the detector (core nightSoundSummary / wakeTriggers read humanLabel).
  const events = useMemo(() => withLabels(data?.events ?? [], labelling.labels), [data, labelling.labels]);
  const summary = useMemo(() => (minutes.length ? nightSoundSummary(minutes, events) : null), [minutes, events]);
  const wakeStarts = useMemo(() => (cath ? cathWakeStarts(cath.night.sleep.stages) : []), [cath]);
  const triggers = useMemo(() => {
    if (!minutes.length || !wakeStarts.length) return [];
    const res = wakeTriggers(wakeStarts, minutes, events, { lookbackMs: LOOKBACK_MS });
    return res.rows.filter((r) => r.heard).map((r) => ({ ts: r.wakeAt, snore: r.snore, loud: r.loud }));
  }, [minutes, events, wakeStarts]);
  // Every clipped (or borderline) moment, at least the 8 loudest, at most 24: each clip can be labelled.
  const clipEvents = useMemo(() => {
    const rest = [...events].filter((e) => !isSpeechEvent(e));
    const keep = (e: SoundEvent) => !!e.clipPath || !!e.uncertain;
    const n = Math.min(24, Math.max(8, rest.filter(keep).length));
    return rest
      .sort((a, b) => (keep(b) ? 1 : 0) - (keep(a) ? 1 : 0) || (b.peakDb ?? -999) - (a.peakDb ?? -999))
      .slice(0, n)
      .sort((a, b) => a.ts - b.ts);
  }, [events]);
  const talk = useMemo(() => sleepTalkEvents(events), [events]);
  const clipped = useMemo(() => [...clipEvents, ...talk], [clipEvents, talk]);
  const clips = useClipUrls(clipped, real);
  const names = useMemo(() => Object.fromEntries(model.people.map((p) => [p.id, p.name])), [model.people]);

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
    summary.labelAddedMin || summary.labelRemovedMin
      ? `Your labels ${[summary.labelAddedMin ? `added ${dur(summary.labelAddedMin)}` : null, summary.labelRemovedMin ? `took out ${dur(summary.labelRemovedMin)}` : null].filter(Boolean).join(' and ')} of snoring.`
      : null,
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
          <SoundMoments events={clipEvents} clips={clips} names={names} labelling={labelling} max={24} empty="Nothing stood out." />
          <LabelTally labelling={labelling} />
        </Reveal>
        <Reveal delay={140}>
          <h3 className="label">Sleep talk</h3>
          <SoundMoments events={talk} clips={clips} names={names} labelling={labelling} max={20} empty="No sleep talk last night." />
          {talk.some((e) => e.sleepTalk == null) && <p className="sec">Some talking isn’t checked against your sleep yet. If you were both awake, it’s deleted this morning.</p>}
        </Reveal>
      </SceneCols>
    </Scene>
  );
}
