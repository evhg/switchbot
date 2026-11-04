// Lab › Experiments engine (migration 0025). pg_cron every 15 min ('{}'), or a household owner/member on demand
// (POST with their JWT, e.g. after "Pin tonight"). JWT verification is off; the function checks the caller itself.
// Each run, in this order:
//   1. Morning (from 10:00 ICT, once wake + 1 h has passed): outcomes of experiment nights (core nightOutcomes from
//      sleep_sessions, the meter's readings and sound_minutes), recomputed every 2 h for 2 days for late syncs; then
//      the verdict (core analyzeExperiment) into experiments.analysis. An experiment that reached its maximum nights
//      finishes on its own (Autopilot's own experiments are finished by step 2).
//   2. Autopilot (household_settings.autopilot): core autopilotStep → start the next candidate / adopt a clear winner
//      (default curve) / finish keeping the default / stop when switched off. Every action is logged (experiment_log);
//      "nothing to do" only when its reason changes.
//   3. Evening (from 12:00 ICT, for the night starting tonight): ensure the night row; unless away (or the aircon is
//      off for an aircon experiment) and while it is not too late, assign tonight's arm (core assignArm: balanced
//      blocks, seeded), apply it (experiment_apply_night: the curve before the pre-cool, or the arm's tag), and for a
//      household experiment send the 20:30 push to every phone once (claimed with notified_at first).
// Response: {ok, morning: [...], autopilot: {...}, tonight: [...]}.
import { analyzeExperiment, assignArm } from '../../../packages/core/src/experiments/analysis.ts';
import { autopilotExperiment, autopilotStep } from '../../../packages/core/src/experiments/autopilot.ts';
import type { Experiment, ExperimentNight } from '../../../packages/core/src/experiments/types.ts';
import { DEFAULT_CURVE } from '../../../packages/core/src/curve.ts';
import { requireCronOrMember } from '../_shared/auth.ts';
import { knownDeviceId } from '../_shared/devices.ts';
import {
  assignmentOpen,
  computeNightOutcomes,
  experimentNotice,
  type ExperimentNightRow,
  type ExperimentRow,
  lastLogMessage,
  logExperiment,
  outcomesDue,
  pushDue,
  ranOtherCurve,
  rowToExperiment,
  rowToExperimentNight,
  storedAnalysis,
} from '../_shared/experiments.ts';
import { json, serve } from '../_shared/http.ts';
import { ensureNight } from '../_shared/load.ts';
import { awayPeriodFor, loadAwayPeriods, nightAway } from '../_shared/presence.ts';
import { pushToAll, type PushSummary } from '../_shared/push.ts';
import type { NightRow } from '../_shared/rows.ts';
import { type Db, must, serviceClient } from '../_shared/supabase.ts';
import { addDays, ictDate, ictHour, iso } from '../_shared/time.ts';

interface Loaded {
  row: ExperimentRow;
  exp: Experiment & { id: number };
  nightRows: ExperimentNightRow[];
  nights: ExperimentNight[];
}

serve(async (req) => {
  const db = serviceClient();
  const caller = await requireCronOrMember(req, db);
  const now = Date.now();
  const nextNight = addDays(ictDate(now), 1);
  const meterId = await knownDeviceId(db, 'meter');

  const morning = await morningStep(db, now, await loadRunning(db), meterId, nextNight);
  const autopilot = await autopilotStepRun(db, now, await loadRunning(db), nextNight);
  const tonight = ictHour(now) >= 12 ? await eveningStep(db, now, await loadRunning(db), nextNight) : [];
  return json({ ok: true, caller: caller === 'cron' ? 'cron' : 'member', now: iso(now), nextNight, morning, autopilot, tonight });
});

async function loadRunning(db: Db): Promise<Loaded[]> {
  const rows = must(await db.from('experiments').select('*').eq('status', 'running').order('id'), 'experiments') as ExperimentRow[];
  if (!rows.length) return [];
  const nightRows = must(
    await db.from('experiment_nights').select('*').in('experiment_id', rows.map((r) => r.id)).order('night_date'),
    'experiment_nights',
  ) as ExperimentNightRow[];
  return rows.map((row) => {
    const mine = nightRows.filter((n) => n.experiment_id === row.id);
    return { row, exp: rowToExperiment(row), nightRows: mine, nights: mine.map(rowToExperimentNight) };
  });
}

// ---------------------------------------------------------------- 1. morning: outcomes + verdict

async function morningStep(db: Db, now: number, running: Loaded[], meterId: string | null, nextNight: string) {
  const out: Record<string, unknown>[] = [];
  for (const l of running) {
    const dates = l.nightRows.filter((n) => n.night_date <= ictDate(now)).map((n) => n.night_date);
    const nightRows = dates.length
      ? must(await db.from('nights').select('date,lights_out,wake,curve_id').in('date', dates), 'nights') as Pick<NightRow, 'date' | 'lights_out' | 'wake' | 'curve_id'>[]
      : [];
    let computed = 0;
    let changed = 0;
    for (const n of l.nightRows) {
      const night = nightRows.find((r) => r.date === n.night_date);
      // An aircon night counts only if it really ran its arm's curve (it may have been changed by hand after the
      // engine applied it).
      const ran = night ? ranOtherCurve(l.exp, n, night.curve_id) : null;
      if (ran) {
        const note = `ran ${ran} instead of ${l.exp.arms.find((a) => a.key === n.arm_key)?.label ?? n.arm_key}`;
        const up = await db.from('experiment_nights').update({ followed: false, apply_note: note, updated_at: iso(now) })
          .eq('experiment_id', l.row.id).eq('night_date', n.night_date);
        if (up.error) console.error('experiment curve check', up.error.message);
        else {
          n.followed = false;
          n.apply_note = note;
          changed++;
          await logExperiment(db, l.row.id, 'marked', `${n.night_date}: not counted, ${note}`, { night: n.night_date, ran });
        }
      }
      if (!night || !outcomesDue(now, n.night_date, Date.parse(night.wake), n.computed_at)) continue;
      try {
        const outcomes = await computeNightOutcomes(db, night, meterId);
        const up = await db.from('experiment_nights').update({ outcomes, computed_at: iso(now), updated_at: iso(now) })
          .eq('experiment_id', l.row.id).eq('night_date', n.night_date);
        if (up.error) throw new Error(up.error.message);
        n.outcomes = outcomes;
        n.computed_at = iso(now);
        computed++;
        if (outcomes.missing.length) console.log('experiment night', n.night_date, 'missing', outcomes.missing.join(','));
      } catch (e) {
        console.error('experiment outcomes', l.row.slug, n.night_date, e instanceof Error ? e.message : String(e));
      }
    }
    const fresh = !l.row.analysis || computed > 0 || changed > 0;
    if (!fresh) continue;
    const nights = l.nightRows.map(rowToExperimentNight);
    l.nights = nights;
    const a = analyzeExperiment(l.exp, nights);
    const stored = storedAnalysis(l.exp, nights, a, nextNight);
    const up = await db.from('experiments').update({ analysis: stored, analyzed_at: iso(now), updated_at: iso(now) }).eq('id', l.row.id);
    if (up.error) console.error('experiments analysis', up.error.message);
    // Log only a change (status, verdict or counts): recomputing late syncs every 2 h must not flood the decision log.
    const prev = l.row.analysis as { status?: string; verdict?: string; counts?: Record<string, number> } | null;
    if (!prev || prev.status !== a.status || prev.verdict !== a.verdict || JSON.stringify(prev.counts ?? {}) !== JSON.stringify(a.counts)) {
      await logExperiment(db, l.row.id, 'analysis', a.verdict, { status: a.status, counts: a.counts, computed });
    }
    if (a.done && !l.exp.autopilot) {
      const f = await db.rpc('experiment_finish', { p_experiment: l.row.id, p_status: 'finished', p_reason: `reached ${a.counted} nights` });
      if (f.error) console.error('experiment_finish', f.error.message);
    }
    out.push({ experiment: l.row.slug, computed, status: a.status, verdict: a.verdict, done: a.done });
  }
  return out;
}

// ---------------------------------------------------------------- 2. Autopilot

async function autopilotStepRun(db: Db, now: number, running: Loaded[], nextNight: string) {
  const [settings, def, history] = await Promise.all([
    db.from('household_settings').select('autopilot').eq('id', 1).maybeSingle(),
    db.from('curves').select('id').eq('is_default', true).maybeSingle(),
    // Only finished tests count as tested: one stopped early (Autopilot switched off) is tried again.
    db.from('experiments').select('arms,autopilot,status').eq('autopilot', true).eq('status', 'finished'),
  ]);
  if (settings.error) return { error: settings.error.message };
  const enabled = (settings.data as { autopilot?: boolean } | null)?.autopilot === true;
  const defaultCurveId = (def.data as { id?: string } | null)?.id ?? DEFAULT_CURVE.id;
  const auto = running.find((l) => l.exp.kind === 'auto') ?? null;
  const d = autopilotStep({
    enabled,
    defaultCurveId,
    running: auto ? { exp: auto.exp, nights: auto.nights } : null,
    history: ((history.data ?? []) as (Pick<ExperimentRow, 'arms' | 'autopilot'> & { status: 'finished' })[]),
  });
  const id = auto?.row.id ?? null;
  switch (d.action) {
    case 'none': {
      if (enabled && (await lastLogMessage(db, 'autopilot')) !== `Autopilot: ${d.reason}`) await logExperiment(db, id, 'autopilot', `Autopilot: ${d.reason}`);
      return d;
    }
    case 'start': {
      const e = autopilotExperiment(defaultCurveId, d.curveId, nextNight, Math.floor(Math.random() * 2 ** 31));
      const ins = await db.from('experiments').insert({
        slug: e.slug,
        title: e.title,
        kind: 'auto',
        arms: e.arms,
        primary_outcome: e.primaryOutcome,
        started_on: e.startedOn,
        seed: e.seed,
        autopilot: true,
        min_per_arm: e.minPerArm,
        notes: 'Started by Autopilot.',
      }).select('id').single();
      if (ins.error) {
        console.error('autopilot start', ins.error.message);
        return { ...d, error: ins.error.message };
      }
      await logExperiment(db, (ins.data as { id: number }).id, 'autopilot', `Autopilot started "${e.title}" from the night of ${e.startedOn}`, { candidate: d.curveId, default: defaultCurveId });
      return d;
    }
    case 'adopt':
    case 'finish':
    case 'stop': {
      const r = await db.rpc('experiment_finish', {
        p_experiment: id,
        p_status: d.action === 'stop' ? 'stopped' : 'finished',
        p_adopt_arm: d.action === 'adopt' ? d.arm : null,
        p_reason: d.reason,
      });
      if (r.error) {
        console.error('autopilot', d.action, r.error.message);
        return { ...d, error: r.error.message };
      }
      await logExperiment(db, id, 'autopilot', `Autopilot ${d.action === 'adopt' ? 'adopted the winner' : d.action === 'stop' ? 'stopped' : 'finished'}: ${d.reason}`, { action: d.action });
      return d;
    }
  }
}

// ---------------------------------------------------------------- 3. evening: tonight's arm, apply, 20:30 push

async function eveningStep(db: Db, now: number, running: Loaded[], nightDate: string) {
  const out: Record<string, unknown>[] = [];
  const active = running.filter((l) => l.row.started_on <= nightDate);
  if (!active.length) return out;
  let night: NightRow = await ensureNight(db, nightDate);
  const lightsOut = Date.parse(night.lights_out);
  const period = awayPeriodFor(await loadAwayPeriods(db, addDays(nightDate, -1)), nightDate);
  const away = nightAway(night.presence_override, night.tags, period);

  for (const l of active) {
    let en = l.nightRows.find((n) => n.night_date === nightDate);
    if (!en) {
      const skip = away
        ? `away (${away})`
        : l.exp.kind === 'auto' && !night.ac_enabled
        ? 'aircon off for this night'
        : !assignmentOpen(now, l.exp.kind, nightDate, lightsOut)
        ? 'too late to assign tonight'
        : null;
      if (skip) {
        const msg = `${nightDate}: no assignment, ${skip}`;
        if ((await lastLogMessage(db, 'skipped')) !== msg) await logExperiment(db, l.row.id, 'skipped', msg);
        out.push({ experiment: l.row.slug, night: nightDate, skipped: skip });
        continue;
      }
      const armKey = assignArm(l.exp, l.nights, nightDate);
      const ins = await db.from('experiment_nights')
        .upsert({ experiment_id: l.row.id, night_date: nightDate, arm_key: armKey, source: 'random' }, { onConflict: 'experiment_id,night_date', ignoreDuplicates: true });
      if (ins.error) {
        console.error('experiment assign', ins.error.message);
        continue;
      }
      const reread = must(await db.from('experiment_nights').select('*').eq('experiment_id', l.row.id).eq('night_date', nightDate).maybeSingle(), 'experiment_nights') as ExperimentNightRow | null;
      if (!reread) continue;
      en = reread;
      l.nightRows.push(en);
      l.nights.push(rowToExperimentNight(en));
      if (en.source === 'random' && en.arm_key === armKey) {
        await logExperiment(db, l.row.id, 'assigned', `${nightDate}: ${l.exp.arms.find((a) => a.key === armKey)?.label ?? armKey} (random)`, { night: nightDate, arm: armKey });
      }
    }
    if (!en.applied_at) {
      const r = await db.rpc('experiment_apply_night', { p_experiment: l.row.id, p_night: nightDate });
      if (r.error) console.error('experiment_apply_night', r.error.message);
      else {
        en.apply_note = typeof r.data === 'string' ? r.data : null;
        night = await ensureNight(db, nightDate);
      }
    }
    const arm = l.exp.arms.find((a) => a.key === en!.arm_key);
    let pushed: unknown = null;
    if (l.exp.kind === 'manual' && arm && en.followed && pushDue(now, nightDate, lightsOut, en.notified_at)) {
      // Claim first so two overlapping runs never send twice.
      const claim = await db.from('experiment_nights').update({ notified_at: iso(now) })
        .eq('experiment_id', l.row.id).eq('night_date', nightDate).is('notified_at', null).select('night_date');
      if (!claim.error && claim.data?.length) {
        const claimedAt = iso(now);
        const line = analyzeLine(l, nightDate);
        const res: PushSummary & { error?: string } = await pushToAll(db, experimentNotice(l.exp, arm, nightDate, line), 'experiment')
          .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
        pushed = res;
        if (res.error || !res.sent) {
          // Nobody got it: release the claim so a later run (until lights-out + 1 h) tries again.
          const rel = await db.from('experiment_nights').update({ notified_at: null })
            .eq('experiment_id', l.row.id).eq('night_date', nightDate).eq('notified_at', claimedAt);
          if (rel.error) console.error('experiment push release', rel.error.message);
          const msg = `${nightDate}: push not delivered (${res.error ?? res.skipped ?? `${res.failed ?? 0} failed`}), will retry`;
          if ((await lastLogMessage(db, 'push')) !== msg) await logExperiment(db, l.row.id, 'push', msg, { night: nightDate, result: res });
        } else {
          await logExperiment(db, l.row.id, 'push', `${nightDate}: told both phones "${arm.instruction ?? arm.label}"`, { night: nightDate, result: res });
        }
      }
    }
    out.push({ experiment: l.row.slug, night: nightDate, arm: en.arm_key, source: en.source, applied: en.apply_note, pushed });
  }
  return out;
}

function analyzeLine(l: Loaded, nightDate: string): string | null {
  return storedAnalysis(l.exp, l.nights, analyzeExperiment(l.exp, l.nights), nightDate).line;
}
