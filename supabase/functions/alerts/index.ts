// Phone alerts (migration 0026), every 15 min from pg_cron (xx:05/20/35/50) or on demand by an owner/member:
//   POST {}            check and send
//   POST {"dry":true}  check only: the decisions, nothing sent or stored
// For each person with a band (public.band_sync):
//   battery  drain rate from public.battery_log (the current discharge cycle, core estimateDrain) → "Charge your
//            Fitbit before bed — 18 %, about 14 h left" when < 24 h are left or ≤ 15 % (≤ 20 % without a rate), once
//            per discharge cycle, 08:00–21:30 ICT (a crossing at night goes out at 08:00). To that person + the owner.
//   stale    the band hasn't reached Google for > 6 h while google-health-sync itself ran in the last 2 h → "Erik's
//            Fitbit hasn't synced since 14:20 — open the Fitbit app", once per gap, 08:00–22:00 ICT. Same recipients.
// And for the household:
//   listener night-sound says the Mac should be listening (_shared/sound.ts currentListen) but no sound_minutes for
//            10 min → "Night listener stopped at 01:43 — check Erik's Mac", once per night, to every member. The
//            silence clock starts no earlier than the current listen=true stretch (alert_state 'listener_watch'), so a
//            pause ending or a late arrival gives the Mac 10 min to resume first.
//   stale is skipped while google-health-sync itself fails (band_sync.last_sync_ok = false: e.g. Google sign-in).
// household_settings.alerts turns each kind off. public.alert_state holds the dedupe state; it is written only after
// at least one push went out, so a household without subscriptions gets the alert once it subscribes.
// JWT verification is off (config.toml); requireCronOrMember checks the caller.
import {
  batteryAlert,
  estimateDrain,
  listenerAlert,
  nextListenerWatch,
  parseAlertSettings,
  staleAlert,
  type AlertDecision,
  type BatteryReading,
} from '../../../packages/core/src/alerts/alerts.ts';
import { requireCronOrMember } from '../_shared/auth.ts';
import { optEnv } from '../_shared/env.ts';
import { json, readJson, serve } from '../_shared/http.ts';
import { appUrl, pushToAll, type PushSummary } from '../_shared/push.ts';
import { currentListen } from '../_shared/sound.ts';
import { type Db, must, selectAll, serviceClient } from '../_shared/supabase.ts';
import { iso } from '../_shared/time.ts';
import {
  alertKey,
  type AlertKind,
  bandSeenAt,
  batteryState,
  LISTENER_WATCH_KEY,
  listenerState,
  listenerWatch,
  listenerWatchData,
  type Member,
  recipients,
  staleState,
  stateData,
} from './logic.ts';

const DAY = 24 * 60 * 60_000;
/** battery_log history read per run: longer than a Fitbit charge lasts, so the cycle start (the dedupe id) is stable. */
const HISTORY_MS = 14 * DAY;

interface Outcome {
  kind: AlertKind;
  person?: string;
  send: boolean;
  reason: string;
  body?: string;
  push?: PushSummary;
}

serve(async (req) => {
  const db = serviceClient();
  await requireCronOrMember(req, db);
  const body = req.method === 'POST' ? await readJson(req) : {};
  const dry = body.dry === true;
  const now = Date.now();

  const [settingsRow, people, members, bands, states] = await Promise.all([
    db.from('household_settings').select('alerts').eq('id', 1).maybeSingle(),
    db.from('people').select('id,name'),
    db.from('household_members').select('user_id,person_id,role'),
    db.from('band_sync').select('person_id,last_sync_at,last_sync_ok,device_last_sync_at,newest_point_at'),
    db.from('alert_state').select('key,data'),
  ]);
  const settings = parseAlertSettings((must(settingsRow, 'household_settings') as { alerts?: unknown } | null)?.alerts);
  const names = new Map((must(people, 'people') as { id: string; name: string }[]).map((p) => [p.id, p.name]));
  const memberRows = must(members, 'household_members') as Member[];
  const bandRows = must(bands, 'band_sync') as { person_id: string; last_sync_at: string | null; last_sync_ok: boolean | null; device_last_sync_at: string | null; newest_point_at: string | null }[];
  const stateRows = new Map((must(states, 'alert_state') as { key: string; data: Record<string, unknown> }[]).map((s) => [s.key, s.data]));
  const nameOf = (id: string) => names.get(id)?.trim() || id;

  const outcomes: Outcome[] = [];
  const deliver = async <S,>(kind: AlertKind, person: string | undefined, d: AlertDecision<S>) => {
    const o: Outcome = { kind, person, send: d.send, reason: d.reason, body: d.body };
    outcomes.push(o);
    if (!d.send || dry) return;
    const users = recipients(kind, person ?? null, memberRows);
    o.push = await pushToAll(
      db,
      { title: d.title ?? 'Sleep Lab', body: d.body ?? '', navigate: `${appUrl()}/settings/alerts`, tag: alertKey(kind, person) },
      `alert-${kind}${person ? `-${person}` : ''}`,
      { userIds: users, urgency: 'normal', ttlSec: 6 * 3600 },
    );
    if (!o.push.sent) return;
    const up = await db.from('alert_state').upsert(
      {
        key: alertKey(kind, person),
        last_sent_at: iso(now),
        data: stateData(kind, d.state as never, { title: d.title, body: d.body, personId: person }),
        updated_at: iso(now),
      },
      { onConflict: 'key' },
    );
    if (up.error) console.error('alert_state', up.error.message);
  };

  const readings = settings.battery ? await batteryReadings(db, now) : new Map<string, BatteryReading[]>();
  for (const b of bandRows) {
    const name = nameOf(b.person_id);
    if (settings.battery) {
      const estimate = estimateDrain(readings.get(b.person_id) ?? [], now);
      await deliver('battery', b.person_id, batteryAlert({ name, estimate, state: batteryState(stateRows.get(alertKey('battery', b.person_id))), now }));
    }
    if (settings.staleSync) {
      const checkedAt = b.last_sync_at ? Date.parse(b.last_sync_at) : null;
      await deliver(
        'stale',
        b.person_id,
        staleAlert({ name, seenAt: bandSeenAt(b), checkedAt, checkOk: b.last_sync_ok, state: staleState(stateRows.get(alertKey('stale', b.person_id))), now }),
      );
    }
  }

  if (settings.listener) {
    const c = await currentListen(db, now);
    let lastMinute: number | null = null;
    if (c.listen) {
      const r = await db.from('sound_minutes').select('ts').gte('ts', iso(c.from - 5 * 60_000)).order('ts', { ascending: false }).limit(1).maybeSingle();
      const ts = (must(r, 'sound_minutes') as { ts?: string } | null)?.ts;
      lastMinute = ts ? Date.parse(ts) : null;
    }
    // When the current listen=true stretch began (after a pause or a late arrival the Mac gets 10 min to resume).
    const prevWatch = listenerWatch(stateRows.get(LISTENER_WATCH_KEY));
    const watch = nextListenerWatch(prevWatch, c.listen, c.night, now);
    if (!dry && JSON.stringify(watch) !== JSON.stringify(prevWatch)) {
      const up = await db.from('alert_state').upsert({ key: LISTENER_WATCH_KEY, data: listenerWatchData(watch), updated_at: iso(now) }, { onConflict: 'key' });
      if (up.error) console.error('alert_state listener_watch', up.error.message);
    }
    const macOwner = optEnv('LISTENER_MAC_PERSON') ?? 'b';
    await deliver(
      'listener',
      undefined,
      listenerAlert({
        listening: c.listen,
        night: c.night,
        from: c.from,
        lastMinute,
        listeningSince: watch?.since ?? null,
        macLabel: `${nameOf(macOwner)}’s Mac`,
        state: listenerState(stateRows.get('listener')),
        now,
      }),
    );
  }

  return json({ ok: true, dry, now: iso(now), settings, outcomes });
});

/** battery_log of the last 14 days, by person. */
async function batteryReadings(db: Db, now: number): Promise<Map<string, BatteryReading[]>> {
  const rows = await selectAll<{ person_id: string; ts: string; level: number }>(
    (from, to) => db.from('battery_log').select('person_id,ts,level').gte('ts', iso(now - HISTORY_MS)).order('ts').range(from, to),
    'battery_log',
  );
  const out = new Map<string, BatteryReading[]>();
  for (const r of rows) {
    const list = out.get(r.person_id) ?? [];
    list.push({ ts: Date.parse(r.ts), level: Number(r.level) });
    out.set(r.person_id, list);
  }
  return out;
}
