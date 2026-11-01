'use client';
/**
 * Body › Food (route /body/food; the tab bar is full, so Food lives under Body and is a drill-in on the phone).
 *
 *   Header    "Food" + one sentence.
 *   Hero      "Add meal": opens the phone camera (input capture=environment). For whom: the signed-in person; the
 *             owner (and the sample) can pick. While the photo travels a pending card shows it; then the result card.
 *   Sections  Today: totals per person, both people side by side (like the other screens).
 *             Recent meals: the last 14 days by day; a row opens the meal in a sheet (items, confidence, Google
 *             Health status, Analyse again / Retry Google Health / Hide).
 * Data: lib/food.ts (public.meals + the food-photo function, or sample meals with the simulator).
 */
import { useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { useData } from '@/lib/data/context.tsx';
import { dayTotals, useMeals, type GoogleStatus, type Meal, type MealAction, type PendingMeal } from '@/lib/food.ts';
import { addDays, dayLabel, fmt, hm, ictDate } from '@/lib/format.ts';
import { useChrome } from '../nav.tsx';
import { Button, Group, PageHeader, Readout, Readouts, Row, Section, Segmented, Sheet, Skeleton, Status } from '../ui.tsx';
import s from './food.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

const MEAL_LABEL: Record<Meal['mealType'], string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };

const GOOGLE_COPY: Record<NonNullable<GoogleStatus> | 'none', { tone: 'ok' | 'on' | 'alert' | 'off'; short: string; long: string }> = {
  ok: { tone: 'on', short: 'In Google Health', long: 'Logged to Google Health.' },
  pending: { tone: 'ok', short: 'Sending', long: 'Google Health is still processing it.' },
  error: { tone: 'alert', short: 'Google Health failed', long: 'Couldn’t log it to Google Health. The meal is saved here.' },
  no_token: { tone: 'off', short: 'Google Health not connected', long: 'Google Health isn’t connected for this person (System › Google Health). The meal is saved here.' },
  removed: { tone: 'off', short: 'Removed from Google Health', long: 'Taken out of Google Health.' },
  none: { tone: 'off', short: 'Not sent', long: 'Not sent to Google Health.' },
};
const google = (g: GoogleStatus) => GOOGLE_COPY[g ?? 'none'];

const confidenceWord = (c: number | null) => (c === null ? '–' : c >= 0.75 ? 'High' : c >= 0.5 ? 'Medium' : 'Low');

const STAGE: Record<PendingMeal['stage'], string> = { shrinking: 'Preparing the photo…', uploading: 'Uploading…', reading: 'Reading the plate…' };

function Dot({ color, hollow }: { color: string; hollow?: boolean }) {
  return <i className={cx(s.dot, hollow && s.hollow)} style={{ ['--dot' as string]: color } as CSSProperties} aria-hidden />;
}

/** kcal + the four macros, as one readout row. */
function Macros({ m, large }: { m: Pick<Meal, 'kcal' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g'>; large?: boolean }) {
  return (
    <Readouts n={5} className={s.macros}>
      <Readout label="Energy" value={<span className="num">{fmt(m.kcal)}</span>} unit=" kcal" large={large} />
      <Readout label="Protein" value={<span className="num">{fmt(m.protein_g)}</span>} unit=" g" />
      <Readout label="Carbs" value={<span className="num">{fmt(m.carbs_g)}</span>} unit=" g" />
      <Readout label="Fat" value={<span className="num">{fmt(m.fat_g)}</span>} unit=" g" />
      <Readout label="Fibre" value={<span className="num">{fmt(m.fiber_g)}</span>} unit=" g" />
    </Readouts>
  );
}

/** One meal in full: photo, totals, items, confidence, Google Health, actions. The result card and the sheet. */
function MealDetail({ meal, who, onAct, canWrite, inSheet }: { meal: Meal; who: string; onAct: (a: MealAction) => Promise<string | null>; canWrite: boolean; inSheet?: boolean }) {
  const [busy, setBusy] = useState<MealAction | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const g = google(meal.googleStatus);
  const run = async (a: MealAction) => {
    setBusy(a);
    setMsg(null);
    const err = await onAct(a);
    setBusy(null);
    setMsg(err);
  };
  const retry = meal.googleStatus === 'error' || meal.googleStatus === 'no_token' || meal.googleStatus === 'pending' || meal.googleStatus === null;
  return (
    <div className={s.detail}>
      {meal.photoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- a signed Storage URL / object URL, not a static asset
        <img className={s.photo} src={meal.photoUrl} alt={`Photo of ${meal.title}`} />
      )}
      <div>
        {!inSheet && <h3 className={s.title}>{meal.title}</h3>}
        <p className="sec">
          {who} · {MEAL_LABEL[meal.mealType]} · {dayLabel(ictDate(meal.takenAt))}, {hm(meal.takenAt)}
        </p>
      </div>
      <Macros m={meal} large />
      {meal.items.length > 0 && (
        <Group label="On the plate" footer={`Confidence: ${confidenceWord(meal.confidence)}${meal.confidence !== null ? ` (${fmt(meal.confidence * 100)}%)` : ''}. Portions and nutrition are estimates from one photo.`}>
          {meal.items.map((it, i) => (
            <Row key={i} title={it.name} sub={`${fmt(it.grams)} g · ${fmt(it.protein_g)} g protein`} value={<span className="num">{fmt(it.kcal)} kcal</span>} />
          ))}
        </Group>
      )}
      <div className={s.google}>
        <Status tone={g.tone}>{g.long}</Status>
        {meal.googleStatus === 'error' && meal.googleError && <p className="cap">{meal.googleError}</p>}
      </div>
      {canWrite && (
        <div className={s.actions}>
          <Button size="sm" icon="refresh" onClick={() => run('regenerate')} disabled={busy !== null}>
            {busy === 'regenerate' ? 'Analysing…' : 'Analyse again'}
          </Button>
          {retry && (
            <Button size="sm" onClick={() => run('resync')} disabled={busy !== null}>
              {busy === 'resync' ? 'Sending…' : 'Retry Google Health'}
            </Button>
          )}
          <Button size="sm" variant="text" onClick={() => run('hide')} disabled={busy !== null}>
            {busy === 'hide' ? 'Hiding…' : 'Hide'}
          </Button>
        </div>
      )}
      {msg && (
        <p className={cx('sec', s.alert)} role="alert">
          {msg}
        </p>
      )}
      {meal.sample && <p className="cap">Sample meal. Sign in to log real ones.</p>}
    </div>
  );
}

function PendingCard({ p, who, onDismiss }: { p: PendingMeal; who: string; onDismiss: () => void }) {
  return (
    <div className={cx('card', s.card)} aria-live="polite">
      <div className={s.pending}>
        {/* eslint-disable-next-line @next/next/no-img-element -- local object URL of the photo just taken */}
        <img className={s.thumb} src={p.previewUrl} alt="The photo just taken" />
        <div className={s.pendingT}>
          {p.error ? (
            <>
              <b className="sig">Not logged</b>
              <p className="sec">{p.error}</p>
              <div className={s.actions}>
                <Button size="sm" variant="text" onClick={onDismiss}>
                  Dismiss
                </Button>
              </div>
            </>
          ) : (
            <>
              <b>{STAGE[p.stage]}</b>
              <p className="sec">For {who}. This takes a few seconds.</p>
              <Skeleton w="70%" h={14} r="text" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function FoodScreen() {
  useChrome({ back: { href: '/body', label: 'Body' } });
  const { latest, dataset } = useData();
  const f = useMeals();
  const people = useMemo(() => (dataset ?? latest)?.people ?? [{ id: 'a', name: 'You' }, { id: 'b', name: 'Erik' }], [dataset, latest]);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  const colorOf = (id: string) => (people.findIndex((p) => p.id === id) === 1 ? 'var(--person-b)' : 'var(--person-a)');
  const input = useRef<HTMLInputElement>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  // Who the next photo is for: members log their own meals; the owner and the sample can choose.
  const choose = !f.real || f.owner;
  const forPerson = (choose ? pick : null) ?? f.myPerson ?? people[0]?.id ?? 'a';
  const today = ictDate(Date.now());
  const meals = f.meals;
  const openMeal = meals?.find((m) => m.id === open) ?? null;

  const byDay = useMemo(() => {
    const out = new Map<string, Meal[]>();
    for (const m of meals ?? []) {
      const d = ictDate(m.takenAt);
      out.set(d, [...(out.get(d) ?? []), m]);
    }
    return [...out];
  }, [meals]);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void f.addPhoto(file, forPerson);
  };

  const busy = !!f.pending && !f.pending.error;
  const dayName = (d: string) => (d === today ? 'Today' : d === addDays(today, -1) ? 'Yesterday' : dayLabel(d));

  return (
    <div className={s.page}>
      <PageHeader title="Food" lede="Photograph a meal. Gemini estimates what’s on the plate, and the meal goes to that person’s Google Health." className={s.header} />

      <section className={s.add} aria-label="Add a meal">
        {choose && people.length > 1 && (
          <Segmented
            value={forPerson}
            onChange={setPick}
            label="Meal for"
            block
            options={people.map((p, i) => ({
              value: p.id,
              label: (
                <span className={s.who}>
                  <Dot color={colorOf(p.id)} hollow={i === 1} />
                  {p.name}
                </span>
              ),
            }))}
          />
        )}
        <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={onFile} />
        <Button variant="primary" icon="camera" block className={s.addBtn} onClick={() => input.current?.click()} disabled={busy || !f.canWrite}>
          {busy ? 'Reading the plate…' : 'Add meal'}
        </Button>
        {!f.canWrite && <p className="cap">Your household role is read-only.</p>}
        {!f.real && <p className="cap">Sample meals. Sign in as a household member to log real ones; a photo here gets a sample analysis.</p>}
      </section>

      {f.pending && <PendingCard p={f.pending} who={nameOf(f.pending.personId)} onDismiss={f.dismissPending} />}
      {!f.pending && f.latest && (
        <div className={cx('card', s.card)}>
          <div className={s.resultHead}>
            <span className="label">Just added</span>
            <Button size="sm" variant="text" onClick={f.clearLatest}>
              Done
            </Button>
          </div>
          <MealDetail meal={f.latest} who={nameOf(f.latest.personId)} canWrite={f.canWrite} onAct={(a) => f.act(f.latest!, a)} />
        </div>
      )}

      <Section id="today" title="Today" cap="Sums of every meal logged since midnight.">
        <div className={s.people}>
          {people.map((p, i) => {
            const t = meals ? dayTotals(meals, p.id, today) : null;
            return (
              <div key={p.id} className={s.person}>
                <p className={cx('label', s.who)}>
                  <Dot color={colorOf(p.id)} hollow={i === 1} />
                  {p.name}
                  {t && <span className="cap">{t.count === 1 ? '1 meal' : `${t.count} meals`}</span>}
                </p>
                {t ? <Macros m={t} large /> : <Skeleton h={64} />}
              </div>
            );
          })}
        </div>
      </Section>

      <Section id="recent" title="Recent meals" cap="The last 14 days. Hidden meals are left out.">
        {f.error && <p className={cx('sec', s.alert)}>{f.error}</p>}
        {!meals ? (
          <Skeleton h={168} r="lg" />
        ) : !meals.length ? (
          <p className="sec">No meals yet. Tap Add meal at the next one.</p>
        ) : (
          byDay.map(([d, list]) => (
            <Group key={d} label={dayName(d)}>
              {list.map((m) => (
                <Row
                  key={m.id}
                  title={m.title}
                  sub={
                    <>
                      {hm(m.takenAt)} · {MEAL_LABEL[m.mealType]} · {nameOf(m.personId)}
                      {m.googleStatus !== 'ok' && <> · {google(m.googleStatus).short}</>}
                    </>
                  }
                  value={<span className="num">{fmt(m.kcal)} kcal</span>}
                  onClick={() => setOpen(m.id)}
                />
              ))}
            </Group>
          ))
        )}
      </Section>

      <Sheet open={!!openMeal} onClose={() => setOpen(null)} title={openMeal?.title}>
        {openMeal && (
          <MealDetail
            key={openMeal.id}
            inSheet
            meal={openMeal}
            who={nameOf(openMeal.personId)}
            canWrite={f.canWrite}
            onAct={async (a) => {
              const err = await f.act(openMeal, a);
              if (!err && a === 'hide') setOpen(null);
              return err;
            }}
          />
        )}
      </Sheet>
    </div>
  );
}
