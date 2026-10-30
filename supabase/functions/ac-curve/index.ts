// Temperature-curve controller. Called by pg_cron every 5 min, around the clock:
// inside the night window, night row + curve + last command + recent readings → decideAcCommand → SwitchBot IR → log;
// outside it (or with the night disabled), only an "ensure off" when the assumed state is still ON.
// Live or dry run (2026-10-30): real IR is sent only when public.household_settings.ac_live is true (toggled in the app,
// System › Tonight's plan) AND the DRY_RUN function secret does not force a dry run (unset, or false/0/no/off; any
// other value forces dry). The secret can force a dry run, never a live one; so can the request ({"dryRun":true}).
// A dry run logs the command (ac_commands.dry_run) without sending it.
// Simulation (cron auth only): {"at": <epoch ms | ISO time>} evaluates the decision as if it were that moment. It is
// ALWAYS a dry run and writes nothing (no command row, no gate status, no landing): for checks like "what will
// 21:30 do tonight?".
// Quiet mode (the receiver beeps on every IR frame): ON by default — from lights-out + 15 min only the planned phase
// steps plus at most one extra command (an emergency correction or a resend; packages/core CONTRACT.md). AC_QUIET=false (or 0/no/off)
// switches it off for every night; anything else, or unset, keeps the stored profile's setting (default on).
// Presence gate (_shared/presence.ts): the command that turns the AC ON for the night (the first power-on command in
// tonight's log) is only sent when someone is home (a fresh iPhone presence event, a stale one plus rising CO₂, or
// "Home tonight" in the app), from the pre-cool start until lights-out + 3 h. The decision is stored on the night
// (precool_status / precool_reason) and returned as `skipped: "precool: …"`; a closed gate also switches off an AC that
// is still assumed ON. A live pre-cool started by a presence signal sends a push ("Away tonight" is one tap away).
// "Away tonight" (or the travel tag), or an active away period covering tonight's evening (public.away_periods), keeps
// the AC off all night, like ac_enabled = false. household_settings.default_presence = 'home' counts the household as
// home unless every phone said "away" within 12 h (_shared/presence.ts).
// Unresponsive aircon (2026-10-31): when two power-on commands in a row got no response and the room stays hot
// (acUnresponsive), the household gets one push per night (deduplicated by an ac_missed event with
// detail.notice = 'unresponsive'): resends cannot fix a wrong IR template or a receiver that missed the frame.
import { acUnresponsive, type ControllerInput, decideAcCommand, evaluateLanding, LANDING_MIN, minIntervalPassed, offCommand } from '../../../packages/core/src/control/controller.ts';
import { DEFAULT_REMOTE, type RemoteProfile, withQuiet } from '../../../packages/core/src/control/remote.ts';
import { toSwitchBotCommand } from '../../../packages/core/src/switchbot/ac.ts';
import type { AcCommand, AcState } from '../../../packages/core/src/types.ts';
import { requireCron } from '../_shared/auth.ts';
import { knownDeviceId } from '../_shared/devices.ts';
import { envFlagSafe, optEnv } from '../_shared/env.ts';
import { background, json, readJson, serve } from '../_shared/http.ts';
import { ensureNight, loadCurve, loadRoom } from '../_shared/load.ts';
import { type AcCommandRow, commandToRow, eventToRow, rowSleepOnset, rowToCommand } from '../_shared/rows.ts';
import { expectedSleepOnset } from '../../../packages/core/src/curve.ts';
import {
  awayPeriodFor,
  co2Rising,
  loadAwayPeriods,
  loadHouseholdSettings,
  loadPresence,
  needsPresenceGate,
  nightAway,
  presenceGate,
  recordGate,
  START_UNTIL_MIN,
} from '../_shared/presence.ts';
import { precoolNotice, pushToAll, unresponsiveNotice } from '../_shared/push.ts';
import { must, serviceClient } from '../_shared/supabase.ts';
import { errorStatus, switchBotSession } from '../_shared/switchbot.ts';
import { addDays, iso, MIN, nightDateFor } from '../_shared/time.ts';

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
  const db = serviceClient();
  await requireCron(req, db);
  const body = await readJson(req);
  // AC_DEVICE_ID / METER_DEVICE_ID when set, else the devices discovered by poll-meter (devices table).
  const [acId, meterId] = await Promise.all([knownDeviceId(db, 'ac'), knownDeviceId(db, 'meter')]);
  if (!acId || !meterId) return json({ skipped: `not discovered yet: ${!acId ? 'aircon remote' : 'meter'}` });
  // A simulated moment ({"at": …}; "now" is the older name) is always a dry run that writes nothing.
  const at = simulatedAt(body.at ?? body.now);
  if (at === undefined) return json({ ok: false, error: 'at: expected epoch ms or an ISO time' }, 400);
  const simulate = at !== null;
  const now = at ?? Date.now();
  // Live only when the household switched it on in the app AND neither the DRY_RUN secret nor the request forces a
  // dry run. Fail safe: a settings read error counts as dry.
  const settings = await loadHouseholdSettings(db);
  const envDry = !!optEnv('DRY_RUN') && envFlagSafe('DRY_RUN');
  const dryReason = simulate ? 'simulated at' : body.dryRun === true ? 'request' : envDry ? 'DRY_RUN secret' : !settings.acLive ? `ac_live off${settings.error ? ` (${settings.error})` : ''}` : null;
  const dryRun = dryReason !== null;
  const mode = { dryRun, ...(dryReason ? { dryReason } : {}), ...(simulate ? { simulatedAt: iso(now) } : {}) };

  const night = await ensureNight(db, nightDateFor(now));
  const lightsOut = Date.parse(night.lights_out);
  const wake = Date.parse(night.wake);
  // Expected sleep onset (nights.sleep_onset, else lights-out + 60 min): one-beep-v2 counts its sleep phases from it.
  const sleepOnset = expectedSleepOnset(lightsOut, rowSleepOnset(night));
  const curve = await loadCurve(db, night.curve_id);
  const onFrom = lightsOut + Math.min(0, curve.phases[0]?.startMin ?? 0) * MIN;
  // Controller window: precool → an hour past the scheduled OFF (wake + 30), room for one OFF resend.
  const period = awayPeriodFor(await loadAwayPeriods(db, addDays(night.date, -1)), night.date);
  const awayWhy = nightAway(night.presence_override, night.tags, period);
  const away = awayWhy !== null;
  const enabled = night.ac_enabled && !away;
  const inWindow = enabled && now >= onFrom && now <= wake + 90 * MIN;

  const stateRow = must(await db.from('ac_state').select('*').eq('device_id', acId).maybeSingle(), 'ac_state') as AcStateRow | null;
  const stored: RemoteProfile = stateRow?.remote ?? DEFAULT_REMOTE;
  const remote: RemoteProfile = envFlagSafe('AC_QUIET') ? stored : withQuiet(stored, false);
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
    if (away && night.ac_enabled && now >= onFrom && now <= lightsOut + START_UNTIL_MIN * MIN && !simulate) {
      await recordGate(db, night, { status: 'away', reason: awayWhy! }, now);
    }
    if (!lastCommand?.state.power) {
      return json({ skipped: !night.ac_enabled ? 'ac disabled for this night' : away ? awayWhy : 'outside night window', ...mode, night: night.date, curve: curve.id, sleepOnset: iso(sleepOnset) });
    }
    if (!minIntervalPassed(now, lastCommand.ts, remote)) return json({ skipped: 'ensure off: waiting for minInterval', ...mode, night: night.date });
    const reason = !night.ac_enabled
      ? 'ensure off: AC disabled for this night'
      : away
      ? `ensure off: ${awayWhy}`
      : now > wake
        ? 'ensure off: still on after wake'
        : 'ensure off: still on outside the night window';
    const off = offCommand(now, remote, lastCommand.state, reason);
    if (!off) return json({ ok: false, error: 'remote profile has no OFF state' }, 500);
    return await send(db, { acId, dryRun, simulate, dryReason, cmd: off, nightDate: lastRow?.night_date ?? night.date, stateRow });
  }

  // Tonight's commands (same dry/live split as the assumed state): the count feeds the nightly cap, the list lets
  // quiet mode count tonight's resends and emergencies.
  const tonightQ = db.from('ac_commands').select('*').eq('device_id', acId).eq('night_date', night.date);
  const { data: tonightRows, error: tonightErr } = await (dryRun ? tonightQ.eq('dry_run', true) : tonightQ.eq('dry_run', false).eq('sent_ok', true))
    .order('ts', { ascending: true })
    .limit(200);
  // Never bypass the nightly cap because the query failed.
  if (tonightErr || !tonightRows) throw new Error(`ac_commands tonight: ${tonightErr?.message ?? 'no rows'}`);
  const tonight = (tonightRows as AcCommandRow[]).map(rowToCommand);
  const commandsTonight = tonight.length;

  const recent = await loadRoom(db, meterId, now - 90 * MIN, now + MIN);

  // Landing check of the previous command (LANDING_MIN of data after it, as in the controller), stored even when
  // nothing new is sent.
  if (!simulate && lastCommand && lastRow?.id && (lastCommand.landed === null || lastCommand.landed === undefined) && now - lastCommand.ts >= LANDING_MIN * MIN) {
    const landed = evaluateLanding(lastCommand, recent.filter((r) => r.ts >= lastCommand.ts));
    if (landed !== null) {
      lastCommand.landed = landed;
      await markLanded(db, lastRow.id, landed, night.date, lastCommand);
    }
  }
  const landedBefore = lastCommand?.landed;

  const input: ControllerInput = {
    now,
    lightsOut,
    wake,
    sleepOnset,
    curve,
    remote,
    commandsTonight,
    tonight,
    recent: recent.filter((r) => r.ts >= now - 60 * MIN),
    ...(lastCommand ? { lastCommand } : {}),
    ...(stateRow?.bias_c !== null && stateRow?.bias_c !== undefined ? { biasC: stateRow.bias_c } : {}),
  };
  const cmd = decideAcCommand(input);
  // decideAcCommand may set landed on the previous command itself.
  if (!simulate && lastCommand && lastRow?.id && landedBefore == null && typeof lastCommand.landed === 'boolean') {
    await markLanded(db, lastRow.id, lastCommand.landed, night.date, lastCommand);
  }
  if (!simulate) await notifyUnresponsive(db, night.date, input, cmd, dryRun);
  // Presence gate: only the command that turns the AC on for the night (pre-cool, or a late start) is gated.
  if (needsPresenceGate(cmd, tonight)) {
    const presence = await loadPresence(db);
    const gate = presenceGate({
      now,
      precoolStart: onFrom,
      lightsOut,
      override: night.presence_override ?? null,
      tags: night.tags ?? [],
      latest: presence.latest,
      people: presence.people,
      co2Rising: co2Rising(recent, now),
      defaultPresence: settings.defaultPresence,
      awayPeriod: period,
    });
    if (!simulate) await recordGate(db, night, gate, now);
    if (!gate.allow) {
      // An AC still assumed ON (e.g. last morning's OFF failed) is switched off rather than left running for nobody.
      if (lastCommand?.state.power && minIntervalPassed(now, lastCommand.ts, remote)) {
        const off = offCommand(now, remote, lastCommand.state, `ensure off: pre-cool gate closed (${gate.reason})`);
        if (off) return await send(db, { acId, dryRun, simulate, dryReason, cmd: off, nightDate: night.date, stateRow, commandsTonight });
      }
      return json({ skipped: `precool: ${gate.reason}`, precool: gate.status, ...mode, night: night.date, curve: curve.id, sleepOnset: iso(sleepOnset) });
    }
    const res = await send(db, { acId, dryRun, simulate, dryReason, cmd: cmd!, nightDate: night.date, stateRow, commandsTonight, precool: gate });
    // Tell the household when a presence signal (not "Home tonight") started a real pre-cool, once per night.
    if (gate.status === 'started' && !dryRun && res.ok && night.precool_status !== 'started') {
      const p = background(pushToAll(db, precoolNotice(night.date, gate.reason), 'precool').then((r) => console.log('precool push', JSON.stringify(r))));
      if (p) await p;
    }
    return res;
  }
  if (!cmd) return json({ ok: true, ...mode, quiet: remote.quiet?.enabled !== false, night: night.date, curve: curve.id, sleepOnset: iso(sleepOnset), command: null, commandsTonight, lastLanded: lastCommand?.landed ?? null });
  return await send(db, { acId, dryRun, simulate, dryReason, cmd, nightDate: night.date, stateRow, commandsTonight });
});

/** `at` / `now` of the request: null when absent, the epoch ms of a number or ISO string, undefined when unparsable. */
function simulatedAt(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

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
  o: {
    acId: string;
    dryRun: boolean;
    /** Simulated moment: nothing is sent or stored, the decision is only returned. */
    simulate?: boolean;
    dryReason?: string | null;
    cmd: AcCommand;
    nightDate: string;
    stateRow: AcStateRow | null;
    commandsTonight?: number;
    precool?: { status: string; reason: string };
  },
): Promise<Response> {
  const { acId, dryRun, cmd } = o;
  const extra = { ...(o.dryReason ? { dryReason: o.dryReason } : {}), ...(o.precool ? { precool: o.precool.status, precoolReason: o.precool.reason } : {}) };
  if (o.simulate) {
    return json({ ok: true, dryRun: true, simulated: true, ...extra, simulatedAt: iso(cmd.ts), night: o.nightDate, command: cmd, ...(o.commandsTonight !== undefined ? { commandsTonight: o.commandsTonight + 1 } : {}) });
  }
  let sentOk: boolean | null = null;
  let error: string | null = null;
  if (!dryRun) {
    const sb = await switchBotSession(db, 'ac-curve');
    // Log the literal request and response: statusCode 100 only means the cloud accepted it, IR is one-way.
    const req = toSwitchBotCommand(cmd);
    try {
      const res = await sb.client.sendCommand(acId, req);
      console.log('switchbot send', JSON.stringify({ request: req, response: res ?? null, reason: cmd.reason }));
      sentOk = true;
      await sb.finish('ok', cmd.reason);
    } catch (e) {
      sentOk = false;
      error = e instanceof Error ? e.message : String(e);
      console.log('switchbot send failed', JSON.stringify({ request: req, error }));
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
    { ok: sentOk !== false, dryRun, ...extra, night: o.nightDate, command: cmd, ...(o.commandsTonight !== undefined ? { commandsTonight: o.commandsTonight + 1 } : {}), error },
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

/**
 * One push per night when the aircon seems to ignore us (acUnresponsive), also while quiet mode allows no more IR.
 * Deduplicated by an ac_missed event (detail.notice = 'unresponsive'), which also puts it on the night's timeline.
 * A dry run only logs it.
 */
async function notifyUnresponsive(db: Db, nightDate: string, input: ControllerInput, cmd: AcCommand | null, dryRun: boolean) {
  const u = acUnresponsive(input);
  if (!u) return;
  const resending = !!cmd?.state.power && cmd.reason.startsWith('resend');
  if (dryRun) {
    console.log('ac unresponsive (dry run, no push)', JSON.stringify({ ...u, resending }));
    return;
  }
  const seen = await db.from('events').select('id').eq('night_date', nightDate).eq('kind', 'ac_missed').contains('detail', { notice: 'unresponsive' }).limit(1);
  if (seen.error) return console.error('events', seen.error.message);
  if (seen.data?.length) return;
  const sp = input.lastCommand?.state.setpointC ?? 0;
  const e = await db.from('events').insert(
    eventToRow(nightDate, {
      kind: 'ac_missed',
      start: u.since,
      confidence: 0.9,
      detail: { notice: 'unresponsive', commands: u.commands, roomC: Math.round(u.roomC * 10) / 10, targetC: u.targetC, setpointC: sp },
    }, 'controller'),
  );
  if (e.error) return console.error('events', e.error.message);
  const n = unresponsiveNotice(nightDate, { roomC: u.roomC, targetC: u.targetC, setpointC: sp, sinceMin: Math.round((input.now - u.since) / MIN), commands: u.commands, resending });
  const p = background(pushToAll(db, n, 'ac-unresponsive').then((r) => console.log('unresponsive push', JSON.stringify(r))));
  if (p) await p;
}
