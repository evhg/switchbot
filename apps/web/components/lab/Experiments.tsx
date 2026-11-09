'use client';
/**
 * Lab › Experiments: planned tests over nights (lib/experiments.ts; migration 0025, the experiments Edge Function).
 *
 *   Running     one card per running experiment (at most one aircon test and one household test): tonight's arm with
 *               "Pin tonight", nights per arm, the verdict sentence, one outcome at a time as arms side by side with
 *               90 % intervals (IntervalPlot), every outcome in a table, the recent nights with "Didn't follow".
 *   Start       five templates; the sheet lets you pick tonight's arm or leave it to the random draw.
 *   Autopilot   keeps one aircon test going against the current default, adopts a winner only when it is clearly better.
 *               Every decision is in the log.
 *   Finished    earlier experiments with their verdict.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { BUILTIN_CURVES } from '@sleep-lab/core';
import { addDays, dayLabel, fmt, hm, ictDate, shortDate, shortDay } from '@/lib/format.ts';
import {
  analyze,
  armInterval,
  isEnded,
  NOT_YET,
  SLEEP_SCORE_EXPLAINED,
  STATUS_WORDS,
  TEMPLATES,
  useExperiments,
  type Experiment,
  type ExperimentAnalysis,
  type ExperimentArm,
  type ExperimentsState,
  type ExpNight,
  type Template,
} from '@/lib/experiments.ts';
import { IntervalPlot, type IntervalRow } from '../charts/lab.tsx';
import { Button, Chip, Chips, Disclosure, EventList, Group, Row, Segmented, Sheet, Status, Switch } from '../ui.tsx';
import s from './experiments.module.css';

type Analysis = ExperimentAnalysis;
type Outcome = Analysis['perOutcome'][number];

const ARM_COLORS = ['var(--muted)', 'var(--accent)', 'var(--outdoor)'];
const armColor = (exp: Experiment, key: string) => ARM_COLORS[Math.max(0, exp.arms.findIndex((a) => a.key === key))] ?? 'var(--muted)';
const nightText = (d: string) => `${shortDay(d)} ${shortDate(d)}`;
const labelOf = (exp: Experiment, key: string | null | undefined) => exp.arms.find((a) => a.key === key)?.label ?? key ?? '';
/** What to do tonight, as in the 20:30 push ("Door OPEN a crack"); the label for aircon arms. */
const armWords = (exp: Experiment, arm: ExperimentArm) => (exp.kind === 'manual' && arm.instruction ? arm.instruction : arm.label);

function toneOf(v: Analysis['status'] | 'finished'): 'ok' | 'on' | 'alert' | 'off' {
  return v === 'clear_winner' ? 'alert' : v === 'leaning' ? 'on' : v === 'finished' ? 'off' : 'ok';
}

/** Decimals for an outcome (analyzeExperiment's results carry the unit, not the rounding). */
const dp = (o: Pick<Outcome, 'key' | 'unit'>) => (/score$/.test(o.key) ? 2 : /awakenings$/.test(o.key) || o.unit === '°C' ? 1 : 0);
const signedText = (x: number | null, d: number) => (x !== null && Number.isFinite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : '±'}${fmt(Math.abs(x), d)}` : '–');

/** Outcome picker: room outcomes are one row group, person outcomes one group per person. */
const CHIPS: { id: string; label: string; keys: (people: string[]) => string[] }[] = [
  { id: 'score', label: 'Sleep score', keys: (p) => ['sleep_score', ...p.map((id) => `${id}_score`)] },
  { id: 'co2_mean', label: 'CO₂', keys: () => ['co2_mean'] },
  { id: 'co2_over_1000', label: 'Over 1,000 ppm', keys: () => ['co2_over_1000'] },
  { id: 'onset', label: 'Falling asleep', keys: (p) => p.map((id) => `${id}_onset`) },
  { id: 'deep', label: 'Deep', keys: (p) => p.map((id) => `${id}_deep`) },
  { id: 'rem', label: 'REM', keys: (p) => p.map((id) => `${id}_rem`) },
  { id: 'awake', label: 'Time awake', keys: (p) => p.map((id) => `${id}_awake`) },
  { id: 'awakenings', label: 'Awakenings', keys: (p) => p.map((id) => `${id}_awakenings`) },
  { id: 'snore_min', label: 'Snoring', keys: () => ['snore_min'] },
  { id: 'temp_mean', label: 'Room temp', keys: () => ['temp_mean'] },
];
const chipOf = (primary: string) => (primary === 'sleep_score' ? 'score' : (CHIPS.find((c) => c.id === primary || primary.endsWith(`_${c.id}`))?.id ?? 'score'));

export function ExperimentsPanel({ names }: { names: Record<string, string> }) {
  const st = useExperiments();
  const [startTpl, setStartTpl] = useState<Template | null>(null);
  const [openDone, setOpenDone] = useState<Experiment | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const running = st.experiments.filter((e) => !isEnded(e));
  const finished = st.experiments.filter(isEnded);
  const autoRunning = running.find((e) => e.kind === 'auto') ?? null;

  const act = async (p: Promise<string | null>) => {
    setMsg(null);
    const e = await p;
    if (e) setMsg(e);
    return e;
  };

  return (
    <div className={s.wrap}>
      {st.error && <p className={s.note}>{/migration 0025/.test(st.error) ? NOT_YET : `${st.error} Showing the sample instead.`}</p>}
      {!st.real && !st.error && !st.loading && <p className={s.cap}>Sample experiment (Simulated data). Sign in as a household member to run real ones.</p>}
      {msg && (
        <p className={s.err} role="alert">
          {msg}
        </p>
      )}

      {running.length === 0 && <p className={s.note}>No experiment is running. Pick one below: Jarvis alternates the options over nights in random pairs, then tells you which one helped.</p>}
      {running.map((e) => (
        <RunningExperiment key={e.id} exp={e} st={st} names={names} act={act} />
      ))}

      <div className={s.col}>
        <h3 className="label">Start an experiment</h3>
        <ul className={s.templates}>
          {TEMPLATES.map((t) => {
            const busy = running.some((e) => e.kind === t.kind);
            return (
              <li key={t.slug}>
                <button type="button" className={s.tpl} disabled={busy || !st.canWrite} onClick={() => setStartTpl(t)}>
                  <b>{t.title}</b>
                  <span>{t.description}</span>
                  <em>{busy ? `Waits for the running ${t.kind === 'auto' ? 'aircon' : 'household'} test` : t.kind === 'auto' ? 'Jarvis runs it' : 'You do it, with a 20:30 reminder'}</em>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <Autopilot st={st} running={autoRunning} act={act} />

      {finished.length > 0 && (
        <Group label="Finished">
          {finished.map((e) => {
            const a = analyze(e, st.nights, names);
            const p = a.primary?.pBetter ?? null;
            return (
              <Row
                key={e.id}
                title={e.title}
                sub={`${nightText(e.startedOn)}${e.endedOn ? ` – ${nightText(e.endedOn)}` : ''} · ${e.arms.map((x) => a.counts[x.key] ?? 0).join(' vs ')} nights`}
                value={e.winnerArm ? `Adopted: ${labelOf(e, e.winnerArm)}` : p !== null ? `P = ${p.toFixed(2)}` : 'No verdict'}
                onClick={() => setOpenDone(e)}
              />
            );
          })}
        </Group>
      )}

      <StartSheet tpl={startTpl} onClose={() => setStartTpl(null)} st={st} act={act} names={names} />
      <Sheet open={openDone !== null} onClose={() => setOpenDone(null)} title={openDone?.title ?? ''} wide>
        {openDone && (
          <div className={s.sheet}>
            <p className={s.verdict}>{analyze(openDone, st.nights, names).verdict}</p>
            {openDone.notes && <p className={s.note}>{openDone.notes}</p>}
            <Results exp={openDone} a={analyze(openDone, st.nights, names)} names={names} />
          </div>
        )}
      </Sheet>
    </div>
  );
}

function RunningExperiment({ exp, st, names, act }: { exp: Experiment; st: ExperimentsState; names: Record<string, string>; act: (p: Promise<string | null>) => Promise<string | null> }) {
  const a = useMemo(() => analyze(exp, st.nights, names), [exp, st.nights, names]);
  const [confirm, setConfirm] = useState<null | 'finish' | 'adopt'>(null);
  const tonight = st.nights.find((n) => n.experimentId === exp.id && n.nightDate === st.tonight) ?? null;
  const tonightArm = tonight ? exp.arms.find((x) => x.key === tonight.armKey) ?? null : null;
  const recent = st.nights
    .filter((n) => n.experimentId === exp.id && n.nightDate < st.tonight)
    .sort((x, y) => (x.nightDate < y.nightDate ? 1 : -1))
    .slice(0, 8);
  const goal = exp.arms.length * a.minPerArm;
  const needed = exp.arms.reduce((sum, x) => sum + Math.max(0, a.minPerArm - (a.counts[x.key] ?? 0)), 0);
  const auto = exp.kind === 'auto';
  const canAdopt = auto && a.status === 'clear_winner' && !!a.winner && a.winner !== a.control;
  const hourIct = (Date.now() / 3_600_000 + 7) % 24;

  return (
    <article className={s.exp} aria-label={exp.title}>
      <div className={s.expHead}>
        <h3 className={s.expTitle}>{exp.title}</h3>
        <span className={s.kind}>
          <Status tone={toneOf(a.status)}>{STATUS_WORDS[a.status]}</Status> · {auto ? (exp.autopilot ? 'Autopilot, aircon' : 'Aircon, Jarvis runs it') : 'You do it'} · since {nightText(exp.startedOn)}
        </span>
      </div>

      <div className={s.tonight}>
        <p className="label">Tonight</p>
        <p className={s.tonightArm}>
          {tonightArm ? armWords(exp, tonightArm) : hourIct >= 12 && hourIct < 20.25 ? 'Drawn at 20:15' : 'Not drawn yet'}
          {tonight && <small>{tonight.source === 'pinned' ? 'pinned by hand' : 'random draw'}</small>}
        </p>
        <p className={s.cap}>{auto ? 'Jarvis sets tonight’s aircon plan before the pre-cool. Nothing to do.' : 'At 20:30 you both get a phone reminder, and the night is tagged by itself.'}</p>
        {st.canWrite && (
          <div className={s.pinRow}>
            <span className={s.cap}>Pin tonight:</span>
            <Segmented
              value={tonight?.source === 'pinned' ? tonight.armKey : ''}
              onChange={(k) => {
                if (k) void act(st.pin(exp, st.tonight, k));
              }}
              options={exp.arms.map((x) => ({ value: x.key, label: x.label }))}
              label="Pin tonight's option"
            />
          </div>
        )}
      </div>

      <div className={s.col}>
        <p className={s.verdict}>{a.verdict}</p>
        <ul className={s.arms}>
          {exp.arms.map((x) => (
            <li key={x.key}>
              <i style={{ background: armColor(exp, x.key) } as CSSProperties} aria-hidden />
              {x.label} <b>{a.counts[x.key] ?? 0}</b>
            </li>
          ))}
        </ul>
        <div>
          <div className={s.bar} role="progressbar" aria-valuemin={0} aria-valuemax={goal} aria-valuenow={Math.min(goal, a.counted)} aria-label="Counted nights">
            <i style={{ transform: `scaleX(${Math.min(1, a.counted / goal)})` }} />
          </div>
          <p className={s.cap}>
            {needed > 0
              ? `${a.counted} counted night${a.counted === 1 ? '' : 's'}${a.excluded ? ` (${a.excluded} left out)` : ''}; a first verdict after ${a.minPerArm} of each, ${needed} more to go.`
              : `${a.counted} counted nights${a.excluded ? ` (${a.excluded} left out)` : ''}. Ends by itself after ${a.maxNights}, or when you finish it.`}
          </p>
        </div>
      </div>

      <Results exp={exp} a={a} names={names} />

      <div className={s.col}>
        <h4 className="label">Recent nights</h4>
        {recent.length ? (
          <ul className={s.nights}>
            {recent.map((n) => (
              <NightRow key={n.nightDate} exp={exp} n={n} canWrite={st.canWrite} onMark={(f) => act(st.mark(exp, n.nightDate, f))} />
            ))}
          </ul>
        ) : (
          <p className={s.cap}>No nights yet. The first one is tonight.</p>
        )}
      </div>

      {st.canWrite && (
        <div className={s.actions}>
          {confirm === null ? (
            <>
              {canAdopt && (
                <Button variant="primary" size="sm" onClick={() => setConfirm('adopt')}>
                  Adopt {labelOf(exp, a.winner)}
                </Button>
              )}
              <Button size="sm" onClick={() => setConfirm('finish')}>
                Finish
              </Button>
            </>
          ) : (
            <>
              <span className={s.note}>{confirm === 'adopt' ? `Make ${labelOf(exp, a.winner)} the default aircon plan from tomorrow?` : 'Finish this experiment now? Its results stay here.'}</span>
              <Button
                variant="primary"
                size="sm"
                onClick={async () => {
                  await act(st.finish(exp, confirm === 'adopt'));
                  setConfirm(null);
                }}
              >
                {confirm === 'adopt' ? 'Adopt' : 'Finish'}
              </Button>
              <Button variant="text" size="sm" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function NightRow({ exp, n, canWrite, onMark }: { exp: Experiment; n: ExpNight; canWrite: boolean; onMark: (followed: boolean) => void }) {
  const morningPassed = n.nightDate <= ictDate(Date.now());
  const missing = n.outcomes?.missing.length ? ` · no ${n.outcomes.missing.map((m) => (m === 'room' ? 'room data' : m === 'sound' ? 'sound' : m.startsWith('sleep:') ? 'sleep data' : m)).filter((v, i, xs) => xs.indexOf(v) === i).join(', ')}` : '';
  return (
    <li className={n.followed ? undefined : s.off}>
      <span>
        <i style={{ background: armColor(exp, n.armKey) } as CSSProperties} aria-hidden />
        <b>{nightText(n.nightDate)}</b>
        {labelOf(exp, n.armKey)}
        {!n.followed ? ' · not counted' : n.outcomes ? missing : morningPassed ? ' · waiting for sleep data' : ''}
        {n.source === 'pinned' ? ' · pinned' : ''}
      </span>
      {canWrite && (
        <Button variant="text" size="sm" onClick={() => onMark(!n.followed)}>
          {n.followed ? (exp.kind === 'auto' ? 'Leave out' : 'Didn’t follow') : 'Count it'}
        </Button>
      )}
    </li>
  );
}

/** One outcome at a time as arms side by side (90 % intervals), then every outcome in a table. */
function Results({ exp, a, names }: { exp: Experiment; a: Analysis; names: Record<string, string> }) {
  const people = Object.keys(names).length ? Object.keys(names) : ['a', 'b'];
  const byKey = useMemo(() => new Map(a.perOutcome.map((o) => [o.key, o])), [a]);
  const has = (o: Outcome | undefined) => !!o && Object.values(o.arms).some((x) => x.n > 0);
  const chips = CHIPS.filter((c) => c.keys(people).some((k) => has(byKey.get(k))));
  const [chip, setChip] = useState<string>(chipOf(exp.primaryOutcome));
  const current = chips.find((c) => c.id === chip) ?? chips[0];
  const shown = (current?.keys(people) ?? []).map((k) => byKey.get(k)).filter((o): o is Outcome => has(o));
  const unit = shown[0]?.unit ?? '';
  const digits = shown[0] ? dp(shown[0]) : 0;
  const rows: IntervalRow[] = shown.flatMap((o) =>
    exp.arms.map((arm) => {
      const st = o.arms[arm.key] ?? { n: 0, mean: null, sd: null };
      const iv = armInterval(st);
      return {
        group: shown.length > 1 ? (o.person ? (names[o.person] ?? o.person) : 'Both of you') : undefined,
        label: arm.label,
        sub: `${st.n} night${st.n === 1 ? '' : 's'}`,
        est: st.mean ?? NaN,
        lo: iv.lo,
        hi: iv.hi,
        color: armColor(exp, arm.key),
      };
    }),
  );

  if (!chips.length) return <p className={s.cap}>Results appear here after the first morning&rsquo;s sleep sync (from 10:00).</p>;
  const versus = labelOf(exp, a.leader);
  const control = labelOf(exp, a.control);
  return (
    <div className={s.grid}>
      <div className={s.col}>
        <Chips label="Outcome">
          {chips.map((c) => (
            <Chip key={c.id} selected={c.id === current?.id} onClick={() => setChip(c.id)}>
              {c.label}
            </Chip>
          ))}
        </Chips>
        {rows.length > 0 && <IntervalPlot rows={rows} unit={unit} digits={digits} animKey={current?.id} axisLabel={`${current?.label}${unit ? `, ${unit}` : ''}, average per night`} ciLabel="90% interval" />}
        <p className={s.cap}>
          Average per night for each option, with a 90 % interval. Only nights that were followed and have data count.
          {current?.id === 'score' ? ` ${SLEEP_SCORE_EXPLAINED}` : ''}
        </p>
      </div>
      <div className={s.col}>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <caption className="sr-only">
              {versus} minus {control}, every outcome
            </caption>
            <thead>
              <tr>
                <th>Outcome</th>
                <th>
                  {versus} vs {control.toLowerCase()}
                </th>
                <th>Better?</th>
              </tr>
            </thead>
            <tbody>
              {a.perOutcome
                .filter((o) => o.diff !== null)
                .map((o) => {
                  const d = dp(o);
                  const clear = !o.info && o.pBetter !== null && o.pBetter >= 0.9;
                  return (
                    <tr key={o.key} className={o.key === exp.primaryOutcome ? s.primary : undefined}>
                      <td>{o.label}</td>
                      <td>
                        {signedText(o.diff, d)}
                        {o.unit ? ` ${o.unit}` : ''}
                        {o.lo !== null && o.hi !== null && (
                          <span className="cap">
                            {' '}
                            ({signedText(o.lo, d)} to {signedText(o.hi, d)})
                          </span>
                        )}
                      </td>
                      <td className={clear ? s.good : undefined}>{o.info || o.pBetter === null ? '–' : `${Math.round(o.pBetter * 100)}%`}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <p className={s.cap}>
          Difference with its 90 % interval, and the chance that {versus.toLowerCase()} is better. The bold row decides: 90 % or more is a clear winner. Room temperature is shown, not judged.
        </p>
      </div>
    </div>
  );
}

/** A stacked radio list: long option labels wrap instead of running off a 375 px screen. */
function Choices({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: readonly { value: string; label: string }[]; label: string }) {
  const name = `choice-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className={s.choices} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className={s.choice}>
          <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

function StartSheet({ tpl, onClose, st, act, names }: { tpl: Template | null; onClose: () => void; st: ExperimentsState; act: (p: Promise<string | null>) => Promise<string | null>; names: Record<string, string> }) {
  const [choice, setChoice] = useState<string>('random');
  const [busy, setBusy] = useState(false);
  const key = tpl?.slug ?? '';
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    // The door test offers tonight = open a crack first (the plan for the evening of 4 Nov 2026).
    setChoice(tpl && /door/i.test(tpl.slug) ? (tpl.arms.find((a) => /open/i.test(a.key))?.key ?? 'random') : 'random');
  }
  const primaryLabel = tpl ? (analyze({ id: 'x', slug: tpl.slug, title: tpl.title, kind: tpl.kind, arms: [...tpl.arms], primaryOutcome: tpl.primaryOutcome, status: 'running', startedOn: st.tonight, seed: 1, createdAt: 0 }, [], names).primary?.label ?? 'Sleep score') : '';
  return (
    <Sheet open={tpl !== null} onClose={onClose} title={tpl?.title ?? ''}>
      {tpl && (
        <div className={s.sheet}>
          <p className={s.note}>{tpl.description}</p>
          <ul className={s.arms}>
            {tpl.arms.map((x, i) => (
              <li key={x.key}>
                <i style={{ background: ARM_COLORS[i] } as CSSProperties} aria-hidden />
                <b>{x.label}</b>
                {i === 0 ? ' · today’s habit' : ''}
              </li>
            ))}
          </ul>
          <p className={s.note}>
            Decided on: {primaryLabel.toLowerCase()}; CO₂, deep sleep, REM, wake-ups and snoring are tracked too. Nights are drawn in random pairs, so each option gets one of every two nights. Away nights and nights without data are skipped. A first verdict after 4 nights of each; it ends by itself after 21.
          </p>
          <div className={s.col}>
            <p className="label">Tonight ({dayLabel(addDays(st.tonight, -1))} evening)</p>
            <Choices value={choice} onChange={setChoice} options={[{ value: 'random', label: 'Random draw' }, ...tpl.arms.map((x) => ({ value: x.key, label: x.label }))]} label="Tonight" />
          </div>
          <div className={s.actions}>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const e = await act(st.create(tpl, choice === 'random' ? null : choice));
                setBusy(false);
                if (!e) onClose();
              }}
            >
              {busy ? 'Starting…' : 'Start'}
            </Button>
            <Button variant="text" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

const curveName = (id: string) => BUILTIN_CURVES.find((c) => c.id === id)?.name ?? id;

function Autopilot({ st, running, act }: { st: ExperimentsState; running: Experiment | null; act: (p: Promise<string | null>) => Promise<string | null> }) {
  const undo = st.lastAdoption;
  const testing = running ? `Testing now: ${running.arms.map((a) => a.label).join(' vs ')}.` : st.autopilot ? 'Starts the next aircon test at 20:15 when no aircon test is running.' : null;
  return (
    <div className={s.auto}>
      <div className={s.autoRow}>
        <div>
          <h3 className="label">Autopilot</h3>
          <p className={s.note}>
            Keeps one aircon test going against the current default, from a short list of safe plans: never below 17°, no warming during deep sleep (a warmer plan steps up at 03:00 at the earliest), at most one extra beep a night. A plan is adopted only when it is clearly better on the sleep score and nobody wakes up more often. Off by default.
          </p>
        </div>
        <Switch checked={st.autopilot} onChange={(v) => void act(st.setAutopilot(v))} disabled={!st.canWrite} label={<span className="sr-only">Autopilot</span>} />
      </div>
      {testing && <p className={s.cap}>{testing}</p>}
      {undo && (
        <div className={s.pinRow}>
          <span className={s.cap}>
            Default aircon plan: {curveName(undo.curveId)} (since {shortDay(ictDate(undo.at))}).
          </span>
          {st.canWrite && (
            <Button variant="text" onClick={() => void act(st.undoAdoption())}>
              {`Undo: go back to ${curveName(undo.previous)}`}
            </Button>
          )}
        </div>
      )}
      <Disclosure title="Decision log" count={st.log.length ? `${st.log.length}` : undefined}>
        {st.log.length ? (
          <EventList items={st.log.slice(0, 30).map((l) => ({ time: `${shortDay(ictDate(l.at))} ${hm(l.at)}`, title: l.message || l.kind, detail: l.kind }))} />
        ) : (
          <p className={s.cap}>Nothing decided yet.</p>
        )}
      </Disclosure>
    </div>
  );
}
