// Temperature-curve controller. Called by pg_cron every 5 min, around the clock:
// inside the night window, night row + curve + last command + recent readings → decideAcCommand → SwitchBot IR → log;
// outside it (or with the night disabled), only an "ensure off" when the assumed state is still ON.
// DRY_RUN=true (the default until the remote is verified) logs commands without sending them.
import {
  type AcCommand,
  type AcState,
  DEFAULT_REMOTE,
  decideAcCommand,
  evaluateLanding,
  offCommand,
  type RemoteProfile,
  toSwitchBotCommand,
} from '../../../packages/core/src/index.ts';
import { requireCron } from '../_shared/auth.ts';
import { env, envFlag } from '../_shared/env.ts';
import { json, readJson, serve } from '../_shared/http.ts';
import { ensureNight, loadCurve, loadRoom } from '../_shared/load.ts';
import { type AcCommandRow, commandToRow, eventToRow, rowToCommand } from '../_shared/rows.ts';
import { must, serviceClient } from '../_shared/supabase.ts';
import { errorStatus, switchBotSession } from '../_shared/switchbot.ts';
import { iso, MIN, nightDateFor } from '../_shared/time.ts';

interface AcStateRow {
  device_id: string;
  state: AcState | null;
  last_command_id: number | null;
  remote: RemoteProfile | null;
  bias_c: number | null;
  failures: number | null;
  last_attempt_at: string | null;
}

type Db = ReturnType<typeof serviceClient>;

serve(async (req) => {
  requireCron(req);
  const body = await readJson(req);
  const db = serviceClient();
  const acId = env('AC_DEVICE_ID');
  const meterId = env('METER_DEVICE_ID');
  const dryRun = envFlag('DRY_RUN', true) || body.dryRun === true;
  const now = typeof body.now === 'number' ? body.now : Date.now();

  const night = await ensureNight(db, nightDateFor(now));
  const lightsOut = Date.parse(night.lights_out);
  const wake = Date.parse(night.wake);
  const curve = await loadCurve(db, night.curve_id);
  const onFrom = lightsOut + Math.min(0, curve.phases[0]?.startMin ?? 0) * MIN;
  // Controller window: precool → an hour past the scheduled OFF (wake + 30), room for one OFF resend.
  const inWindow = night.ac_enabled && now >= onFrom && now <= wake + 90 * MIN;

  const stateRow = must(await db.from('ac_state').select('*').eq('device_id', acId).maybeSingle(), 'ac_state') as AcStateRow | null;
  const remote: RemoteProfile = stateRow?.remote ?? DEFAULT_REMOTE;
  // Live and dry runs keep separate assumed states: live = ac_state (only real, successful sends move it);
  // dry = the newest dry-run row. Flipping DRY_RUN off therefore never inherits a state that was never sent.
  const lastRow = await assumedLastRow(db, acId, dryRun, stateRow);
  const lastCommand: AcCommand | undefined = lastRow ? rowToCommand(lastRow) : undefined;

  // Back off after failed live sends (hub offline etc.): minInterval, doubling, at most 60 min apart.
  const failures = stateRow?.failures ?? 0;
  if (!dryRun && failures > 0 && stateRow?.last_attempt_at) {
    const wait = Math.min(60, remote.minIntervalMin * 2 ** (failures - 1)) * MIN;
    if (now - Date.parse(stateRow.last_attempt_at) < wait) return json({ skipped: 'backing off after failed send', failures, night: night.date });
  }

  if (!inWindow) {
    // Outside the window (or the night is disabled) the only job is: an AC we believe is ON gets switched off.
    if (!lastCommand?.state.power) {
      return json({ skipped: night.ac_enabled ? 'outside night window' : 'ac disabled for this night', night: night.date });
    }
    if (now - lastCommand.ts < remote.minIntervalMin * MIN) return json({ skipped: 'ensure off: waiting for minInterval', night: night.date });
    const reason = !night.ac_enabled
      ? 'ensure off: AC disabled for this night'
      : now > wake
        ? 'ensure off: still on after wake'
        : 'ensure off: still on outside the night window';
    const off = offCommand(now, remote, lastCommand.state, reason);
    if (!off) return json({ ok: false, error: 'remote profile has no OFF state' }, 500);
    return await send(db, { acId, dryRun, cmd: off, nightDate: lastRow?.night_date ?? night.date, stateRow });
  }

  const countQ = db.from('ac_commands').select('id', { count: 'exact', head: true }).eq('device_id', acId).eq('night_date', night.date);
  const { count, error: countErr } = await (dryRun ? countQ.eq('dry_run', true) : countQ.eq('dry_run', false).eq('sent_ok', true));
  // Never bypass the nightly cap because the count failed.
  if (countErr || count === null) throw new Error(`ac_commands count: ${countErr?.message ?? 'no count'}`);
  const commandsTonight = count;

  const recent = await loadRoom(db, meterId, now - 90 * MIN, now + MIN);

  // Landing check of the previous command (40 min of data after it), stored even when nothing new is sent.
  if (lastCommand && lastRow?.id && (lastCommand.landed === null || lastCommand.landed === undefined) && now - lastCommand.ts >= 40 * MIN) {
    const landed = evaluateLanding(lastCommand, recent.filter((r) => r.ts >= lastCommand.ts));
    if (landed !== null) {
      lastCommand.landed = landed;
      await markLanded(db, lastRow.id, landed, night.date, lastCommand);
    }
  }
  const landedBefore = lastCommand?.landed;

  const input = {
    now,
    lightsOut,
    wake,
    curve,
    remote,
    commandsTonight,
    recent: recent.filter((r) => r.ts >= now - 60 * MIN),
    ...(lastCommand ? { lastCommand } : {}),
    ...(stateRow?.bias_c !== null && stateRow?.bias_c !== undefined ? { biasC: stateRow.bias_c } : {}),
  };
  const cmd = decideAcCommand(input);
  // decideAcCommand may set landed on the previous command itself.
  if (lastCommand && lastRow?.id && landedBefore == null && typeof lastCommand.landed === 'boolean') {
    await markLanded(db, lastRow.id, lastCommand.landed, night.date, lastCommand);
  }
  if (!cmd) return json({ ok: true, dryRun, night: night.date, command: null, commandsTonight, lastLanded: lastCommand?.landed ?? null });
  return await send(db, { acId, dryRun, cmd, nightDate: night.date, stateRow, commandsTonight });
});

async function assumedLastRow(db: Db, acId: string, dryRun: boolean, stateRow: AcStateRow | null): Promise<AcCommandRow | null> {
  if (dryRun) {
    return must(
      await db.from('ac_commands').select('*').eq('device_id', acId).eq('dry_run', true).order('ts', { ascending: false }).limit(1).maybeSingle(),
      'ac_commands',
    ) as AcCommandRow | null;
  }
  if (!stateRow?.last_command_id) return null;
  return must(await db.from('ac_commands').select('*').eq('id', stateRow.last_command_id).maybeSingle(), 'ac_commands') as AcCommandRow | null;
}

async function send(
  db: Db,
  o: { acId: string; dryRun: boolean; cmd: AcCommand; nightDate: string; stateRow: AcStateRow | null; commandsTonight?: number },
): Promise<Response> {
  const { acId, dryRun, cmd } = o;
  let sentOk: boolean | null = null;
  let error: string | null = null;
  if (!dryRun) {
    const sb = await switchBotSession(db, 'ac-curve');
    try {
      await sb.client.sendCommand(acId, toSwitchBotCommand(cmd));
      sentOk = true;
      await sb.finish('ok', cmd.reason);
    } catch (e) {
      sentOk = false;
      error = e instanceof Error ? e.message : String(e);
      await sb.finish(errorStatus(e), error);
    }
  }

  const row = { ...commandToRow(acId, o.nightDate, cmd), dry_run: dryRun, sent_ok: sentOk, error };
  const ins = must(await db.from('ac_commands').insert(row).select('id').single(), 'ac_commands insert') as { id: number };
  if (!dryRun) {
    const at = iso(cmd.ts);
    // The assumed (live) AC state only moves on a successful send; a failure only feeds the backoff.
    const up = sentOk
      ? await db.from('ac_state').upsert(
        { device_id: acId, state: cmd.state, via: cmd.via, button: cmd.button ?? null, last_command_id: ins.id, failures: 0, last_attempt_at: at, updated_at: at },
        { onConflict: 'device_id' },
      )
      : await db.from('ac_state').upsert(
        { device_id: acId, failures: (o.stateRow?.failures ?? 0) + 1, last_attempt_at: at, updated_at: at },
        { onConflict: 'device_id' },
      );
    if (up.error) console.error('ac_state', up.error.message);
  }
  return json(
    { ok: sentOk !== false, dryRun, night: o.nightDate, command: cmd, ...(o.commandsTonight !== undefined ? { commandsTonight: o.commandsTonight + 1 } : {}), error },
    sentOk === false ? 502 : 200,
  );
}

async function markLanded(db: Db, id: number, landed: boolean, nightDate: string, cmd: AcCommand) {
  const r = await db.from('ac_commands').update({ landed }).eq('id', id);
  if (r.error) console.error('ac_commands landed', r.error.message);
  if (!landed) {
    const e = await db.from('events').insert(
      eventToRow(nightDate, { kind: 'ac_missed', start: cmd.ts, confidence: 0.7, detail: { reason: cmd.reason, commandId: id } }, 'controller'),
    );
    if (e.error) console.error('events', e.error.message);
  }
}
