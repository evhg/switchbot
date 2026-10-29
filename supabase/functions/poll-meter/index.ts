// Minute poll of the Meter Pro CO2 (backstop for the change-based webhook). Called by pg_cron.
import { SwitchBotError } from '../../../packages/core/src/switchbot/client.ts';
import { parseMeterStatus } from '../../../packages/core/src/switchbot/parse.ts';
import { requireCron } from '../_shared/auth.ts';
import { discoverDevices, knownDeviceId } from '../_shared/devices.ts';
import { envNumber } from '../_shared/env.ts';
import { json, serve } from '../_shared/http.ts';
import { readingToRow } from '../_shared/rows.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { errorStatus, switchBotSession } from '../_shared/switchbot.ts';
import { floorMinute, iso } from '../_shared/time.ts';

serve(async (req) => {
  const db = serviceClient();
  await requireCron(req, db);
  let deviceId = await knownDeviceId(db, 'meter');
  const now = Date.now();

  // Optional quota saver: skip when the webhook already delivered this minute (default off, so week 1
  // can compare webhook vs poll).
  const freshS = envNumber('POLL_SKIP_IF_FRESH_S', 0);
  if (deviceId && freshS > 0) {
    const { data } = await db.from('readings').select('ts').eq('device_id', deviceId).gte('ts', iso(now - freshS * 1000)).limit(1);
    if (data?.length) return json({ skipped: 'fresh' });
  }

  const sb = await switchBotSession(db, 'poll-meter');
  // Keep a reserve for aircon commands, which matter more than one missed minute.
  const reserve = envNumber('SWITCHBOT_AC_RESERVE', 300);
  if (sb.remaining() <= reserve) {
    await sb.finish('skipped:budget', `remaining ${sb.remaining()} <= reserve ${reserve}`);
    return json({ skipped: 'budget', remaining: sb.remaining() });
  }

  try {
    if (!deviceId) {
      // First run after the token was entered: find the meter (and the aircon remote) once.
      const found = await discoverDevices(db, sb);
      if (!found.meter) {
        await sb.finish('error:no-meter', JSON.stringify(found.devices).slice(0, 300));
        return json({ ok: false, error: 'no Meter Pro CO2 in this SwitchBot account', discovered: found }, 404);
      }
      deviceId = found.meter;
    }
    const body = await sb.client.getStatus(deviceId);
    const reading = parseMeterStatus(body, now);
    if (!reading) {
      await sb.finish('error:parse', JSON.stringify(body).slice(0, 300));
      return json({ ok: false, error: 'unparseable status' }, 502);
    }
    reading.ts = floorMinute(reading.ts);
    const [dev, up] = await Promise.all([
      db.from('devices').upsert({ device_id: deviceId, kind: 'meter', name: 'Meter Pro CO2' }, { onConflict: 'device_id', ignoreDuplicates: true }),
      db.from('readings').upsert(readingToRow(deviceId, reading), { onConflict: 'device_id,ts' }),
    ]);
    if (dev.error) console.error('devices', dev.error.message);
    if (up.error) throw new Error(`readings: ${up.error.message}`);
    await sb.finish('ok');
    return json({ ok: true, reading, quota: sb.client.quota() });
  } catch (e) {
    await sb.finish(errorStatus(e), e instanceof Error ? e.message : String(e));
    const status = e instanceof SwitchBotError && e.kind === 'rate_limit' ? 429 : 502;
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, status);
  }
});
