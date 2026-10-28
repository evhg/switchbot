# Backend: Supabase

Supabase is the always-on part of Sleep Lab. It stores everything in Postgres, runs `pg_cron` schedules, and hosts the Edge Functions that talk to SwitchBot, Google Health, Claude and Web Push. The PWA on Vercel only reads, under row-level security.

Everything in this document can be deployed with the Supabase CLI. No project exists yet. Until the devices are unboxed (Phase 0), the database runs on simulated nights and the aircon controller runs in `DRY_RUN`.

## Layout

```
supabase/
  config.toml                 CLI config (verify_jwt = false for every function; they check their own secrets)
  migrations/0001_init.sql    tables, views, RLS, grants, security-definer RPCs
  migrations/0002_cron.sql    pg_cron + pg_net schedules (secrets read from Vault)
  functions/
    deno.json                 strict TS settings for `deno check` / `deno lint`
    .env.example              every secret the functions read
    _shared/                  env, http, auth, supabase client, row mappers, loaders, SwitchBot quota,
                              Google Health helpers, Claude coach, Web Push (RFC 8291 / 8292)
    switchbot-webhook/        SwitchBot webhook → readings (secret URL path)
    poll-meter/               minute poll of the Meter Pro CO2 (quota-aware)
    ac-curve/                 temperature curve → IR command (every 5 min overnight)
    google-health-sync/       Google Health API v4 pull → raw_health + derived tables
    google-health-webhook/    Google Health notifications → sync jobs (replies 204)
    google-oauth/             /start and /callback; refresh tokens go to Vault
    nightly-report/           events + rule report + Claude rewrite + Web Push (06:30 ICT)
    tests/                    `deno test` (Web Push RFC vector, coach grounding, health helpers)
scripts/seed-supabase.ts      simulated nights → Supabase (Node)
```

The functions import the shared core directly (`../../../packages/core/src/index.ts`). The Supabase CLI bundles static imports from outside `supabase/functions`, so no copy is needed. The only third-party import is `npm:@supabase/supabase-js@2`.

## Data model

All timestamps are `timestamptz` (UTC). A night is keyed by the **ICT wake-up date** (`nights.date`), the same convention as `packages/core/src/types.ts`.

| Table | What | Written by |
|---|---|---|
| `people` | Person ids (`a`, `b`), names, `google_health_user_id` | seed / SQL / OAuth |
| `household_members` | `auth.users` → person; membership gives read access | SQL (manual) |
| `devices` | SwitchBot device ids (meter, AC, sim) | functions / seed |
| `readings` | Room temp/RH/CO₂ per device per **minute**, PK `(device_id, ts)`, BRIN on `ts` | webhook, poll, seed |
| `raw_switchbot` | Every webhook body unchanged, for measuring cadence and lag | webhook |
| `outdoor_readings` | Outdoor temp/RH | seed / later a weather source |
| `calibrations` | CO₂ outdoor calibrations, offsets | manual |
| `curves` | Temperature curves (`phases` jsonb = `CurvePhase[]`); `default-v1` is inserted by the migration | SQL |
| `nights` | lights-out, wake, curve, tags, `ac_enabled` | `set_night()` RPC, ac-curve (default schedule), seed |
| `ac_commands` | Every decision: state, via, button, reason, `landed`, `dry_run`, `sent_ok` | ac-curve |
| `ac_state` | One row per AC: assumed state, last command, `remote` (RemoteProfile jsonb), `bias_c` | ac-curve / SQL |
| `events` | Shower, door, in-bed, `ac_missed` …; `source` = detector / manual / sim_truth / controller | nightly-report, ac-curve, seed |
| `raw_health` | **Append-only** Google Health archive (`point_key`, `payload`, `update_time`, `data_source`); a trigger blocks UPDATE/DELETE | google-health-sync |
| `health_hr` (1-min means), `health_hrv`, `health_spo2`, `sleep_sessions`, `health_daily` | Derived layers, rebuildable from `raw_health` | google-health-sync, seed |
| `health_sync_jobs` | Queue fed by the Google webhook | webhook, OAuth |
| `reports` | `report` (NightReport, possibly Claude-worded), `rule_report`, `generated_by`, `model` | nightly-report, seed |
| `push_subscriptions` | Web Push endpoints per user | `register_push_subscription()` RPC |
| `oauth_tokens` | Per person: **Vault secret id** of the refresh token, scopes, `needs_reconsent` | google-oauth |
| `oauth_states` | Single-use OAuth `state` values (15 min) | google-oauth |
| `api_quota`, `api_quota_log` | Daily call counters (SwitchBot, Google) and one log row per invocation | functions |

Views and functions:
- `latest_readings`: the newest reading per device.
- `readings_5min`: a 5-minute rollup.
- `readings_buckets(from, to, minutes, device)`: the same rollup, filtered on `ts` first so it uses the indexes. Prefer it for charts.

**Access model (two-person household).**
- RLS is on for every table.
- An authenticated user who has a row in `household_members` can `select` everything except the OAuth tables and the sync queue. Push subscriptions are visible only to their owner.
- Only the service role (Edge Functions, seed script) writes to tables.
- The PWA writes through three security-definer RPCs that check membership:
  - `set_night(p_date, p_lights_out, p_wake, p_tags, p_curve_id, p_ac_enabled)`
  - `register_push_subscription(endpoint, p256dh, auth, user_agent)`
  - `unregister_push_subscription(endpoint)`
- **Grants are explicit.** Supabase stops auto-granting Data API access to new tables from 2026-10-30, so the migration grants `select` to `authenticated`, `all` to `service_role` and nothing to `anon`.

**Secrets at rest.**
- Google refresh tokens live in **Supabase Vault** (`vault.secrets`, encrypted). `oauth_tokens` stores only the secret's id.
- `store_google_refresh_token()` and `get_google_refresh_token()` are the only way in or out, and only `service_role` may execute them.
- Everything else is in Edge Function secrets.

## Secrets

Set them with `supabase secrets set NAME=value …` or `supabase secrets set --env-file supabase/functions/.env`. Never commit them. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

| Secret | Used by | Notes |
|---|---|---|
| `CRON_SECRET` | all scheduled functions | Long random string. The same value goes into Vault as `cron_secret` |
| `SWITCHBOT_TOKEN`, `SWITCHBOT_SECRET` | poll-meter, ac-curve | App → Profile → Preferences → Developer Options |
| `METER_DEVICE_ID` | poll-meter, ac-curve, nightly-report | Meter Pro CO2 `deviceId` (MAC without colons). Use `SIM-METER` in Phase 0 |
| `AC_DEVICE_ID` | ac-curve | The IR remote's `deviceId` from `listDevices().infraredRemoteList` |
| `WEBHOOK_SECRET` | switchbot-webhook | Long random string; it becomes the last URL path segment |
| `DRY_RUN` | ac-curve | Defaults to **true**. Set `false` only after the remote is verified |
| `SWITCHBOT_DAILY_BUDGET` | all SwitchBot calls | Default 5000; the server limit is 10,000 |
| `SWITCHBOT_AC_RESERVE` | poll-meter | Default 300. Polling stops when fewer calls are left, keeping room for aircon commands |
| `POLL_SKIP_IF_FRESH_S` | poll-meter | Default 0 (off). For example, 50 skips the poll when a webhook reading is that fresh |
| `DEFAULT_LIGHTS_OUT`, `DEFAULT_WAKE` | ac-curve, nightly-report | ICT `HH:MM` used when a night has no row yet. Defaults are 22:30 and 06:30 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | google-oauth, google-health-sync | OAuth client of type "Web application" |
| `GOOGLE_HEALTH_WEBHOOK_SECRET` | google-health-webhook | The subscriber's `endpointAuthorization.secret` |
| `GOOGLE_HEALTH_SIGNATURE` | google-health-webhook | `off` / `log` (default) / `enforce`. The ECDSA verifier is best effort |
| `OAUTH_START_SECRET` | google-oauth | Guards `/google-oauth/start` |
| `APP_URL` | nightly-report, google-oauth | The PWA origin, e.g. `https://sleep-lab.vercel.app` (push tap target) |
| `ANTHROPIC_API_KEY` | nightly-report | Optional. Without it, reports are rule-only |
| `ANTHROPIC_MODEL` | nightly-report | Default `claude-opus-5-5` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | nightly-report | Base64url raw keys. The PWA uses the same public key as `applicationServerKey` |
| `PUBLIC_FUNCTIONS_URL` | optional | Overrides `<SUPABASE_URL>/functions/v1`, e.g. behind a custom domain |

Generate the VAPID keys once:

```sh
npx deno eval "import('./supabase/functions/_shared/webpush.ts').then(async (m) => console.log(await m.generateVapidKeys()))"
```

## Setup, step by step

1. **Create the project.**
   - In the Supabase dashboard, create a new project in the Singapore region (`ap-southeast-1`), the closest to Phuket.
   - Note the project ref.
   - Then run `npx supabase login` and `npx supabase link --project-ref <ref>`. The CLI isn't a repo dependency; `npx` fetches it.
2. **Push the schema:** `npx supabase db push`. This applies `0001_init.sql` and `0002_cron.sql`.
   - The cron jobs are created straight away. Until step 3 is done they only log a warning (`vault secrets project_url / cron_secret are not set`).
3. **Vault secrets for cron.** In the dashboard SQL editor, run:
   ```sql
   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
   ```
4. **Function secrets.**
   - Copy `supabase/functions/.env.example` to `supabase/functions/.env` and fill it in.
   - For Phase 0 use `METER_DEVICE_ID=SIM-METER`, `AC_DEVICE_ID=SIM-AC` and `DRY_RUN=true`.
   - Then run `npx supabase secrets set --env-file supabase/functions/.env`.
5. **Deploy the functions:** `npx supabase functions deploy`. `verify_jwt = false` comes from `config.toml`; each function checks its own secret.
6. **Household.** In Auth → Users, invite both email addresses; the PWA signs in with magic links. Then run:
   ```sql
   insert into people (id, name, color_key) values ('a', 'Alex', 'personA'), ('b', 'Sam', 'personB')
     on conflict (id) do update set name = excluded.name;
   insert into household_members (user_id, person_id, role)
   select id, case email when '<email A>' then 'a' else 'b' end, 'owner' from auth.users;
   ```
7. **Seed simulated data (Phase 0):**
   ```sh
   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service role key> \
     node --experimental-strip-types scripts/seed-supabase.ts --nights 60
   ```
   - This writes nights, 1-minute readings, the AC log, events (both truth and detector), sleep/HR/HRV/SpO₂ and rule reports.
   - `--dry-run` prints the row counts without connecting (about 1,080 readings per night).
   - It is idempotent (upserts), so it can be re-run with `--end YYYY-MM-DD` to extend.
8. **Check the scheduled jobs:**
   ```sql
   select jobname, schedule, active from cron.job order by jobname;
   select * from cron.job_run_details order by start_time desc limit 20;
   select id, status_code, content::text from net._http_response order by id desc limit 20;
   ```
   In Phase 0, `poll-meter` returns SwitchBot errors (there's no device) and `ac-curve` logs dry-run decisions against simulated readings only if the seed covers tonight. To pause polling, use `select cron.unschedule('sleeplab-poll-meter');`.

## Schedules (pg_cron runs in UTC; ICT = UTC+7)

| Job | Cron (UTC) | ICT | What |
|---|---|---|---|
| `sleeplab-poll-meter` | `* * * * *` | every minute | Meter status poll (backstop for the change-based webhook) |
| `sleeplab-ac-curve` | `*/5 * * * *` | every 5 min | Controller from precool (lights-out − 90 min) to wake + 90 min. Outside that window, or when the night has `ac_enabled = false`, it only sends OFF if the assumed live state is still ON ("ensure off"). Failed live sends back off (20, 40, 60 min) |
| `sleeplab-health-sync-morning` | `20 0-2 * * *` | 07:20, 08:20, 09:20 | Google Health pulls after typical wake times |
| `sleeplab-nightly-report` | `*/15 0-7,23 * * *` | every 15 min, 06:00–14:45 | `{"auto":true}`: first report + push once wake + 60 min has passed and every connected person's sleep has synced (or at wake + 4 h), silent regenerate when late sleep data arrives, final silent regenerate after max(12:00, wake + 2 h) for the morning ACH. Tracked in `reports.pushed_at / people_count / final` |
| `sleeplab-health-sync-1030` | `30 3 * * *` | 10:30 | Late syncs and reprocessed stages |
| `sleeplab-health-sync-1400` | `0 7 * * *` | 14:00 | Afternoon backstop |
| `sleeplab-health-sync-queue` | `*/10 * * * *` | every 10 min | Drains webhook-queued jobs (no-op when empty) |
| `sleeplab-housekeeping` | `17 20 * * *` | 03:17 | Prunes `cron.job_run_details` (7 d), `api_quota_log` (60 d), old jobs and OAuth states |

- **The report regenerates after late data** automatically (see `sleeplab-nightly-report`). To regenerate by hand, call `nightly-report` with `{"date": "YYYY-MM-DD"}` (no push unless `"push": true`). Owners and members can do it with their JWT for the last 7 days; `viewer` members are read-only everywhere (also in `set_night`). Scheduled callers use `x-cron-secret`.
- **Dry run vs live.** Dry-run commands never touch `ac_state` (the live assumed state) and don't count against the live nightly cap; the dry-run controller follows its own newest dry-run row. Reports and the PWA hide failed sends, and hide dry-run rows on nights that have live commands.
- **Each function can be run by hand:**
  ```sh
  curl -X POST https://<ref>.supabase.co/functions/v1/ac-curve -H "x-cron-secret: $CRON_SECRET" -d '{"dryRun":true}'
  ```

## Unboxing day: switching to the real devices

Follow [SETUP.md](SETUP.md) for the hardware order (Hub Mini → Meter Pro CO2 → aircon remote → developer token → camera). Then, on the backend:

1. **Find device ids** (one-off, from a laptop; never commit the token):
   ```sh
   SWITCHBOT_TOKEN=… SWITCHBOT_SECRET=… npx deno eval "
   import { SwitchBotClient } from './packages/core/src/index.ts';
   const c = new SwitchBotClient({ token: Deno.env.get('SWITCHBOT_TOKEN')!, secret: Deno.env.get('SWITCHBOT_SECRET')! });
   console.log(JSON.stringify(await c.listDevices(), null, 2));"
   ```
   - Copy the Meter Pro CO2 `deviceId` into `METER_DEVICE_ID`.
   - Copy the aircon remote's id (under `infraredRemoteList`) into `AC_DEVICE_ID`.
   - Run `supabase secrets set …`.
2. **Register the webhook.** Only one URL per account in practice, and SwitchBot doesn't sign deliveries:
   ```sh
   … npx deno eval "
   import { SwitchBotClient } from './packages/core/src/index.ts';
   const c = new SwitchBotClient({ token: Deno.env.get('SWITCHBOT_TOKEN')!, secret: Deno.env.get('SWITCHBOT_SECRET')! });
   console.log(await c.setupWebhook('https://<ref>.supabase.co/functions/v1/switchbot-webhook/<WEBHOOK_SECRET>'));
   console.log(await c.queryWebhook());"
   ```
   - The first delivery is a `TESTMAC` placeholder, which is ignored.
   - Real events show up in `raw_switchbot` and `readings` (source `webhook`).
3. **Aircon remote.**
   - If Smart Matching worked (all of temperature, mode and fan respond), the default `setAll` profile applies and nothing needs configuring.
   - If you fell back to learned buttons, store the ladder:
     ```sql
     insert into ac_state (device_id, remote) values ('<AC_DEVICE_ID>', '{
       "kind":"customize","minIntervalMin":20,"maxCommandsPerNight":12,
       "ladder":[{"button":"C18","state":{"power":true,"setpointC":18,"mode":"cool","fan":"auto"}}, …,
                 {"button":"OFF","state":{"power":false,"setpointC":24,"mode":"cool","fan":"auto"}}]}')
     on conflict (device_id) do update set remote = excluded.remote;
     ```
   - If the receiver beeps, raise `minIntervalMin` or add `quietAfterLightsOutMin`.
4. **Measure first.** Keep `DRY_RUN=true` for the 1–2 baseline weeks (PLAN.md Phase 1); the log shows what the controller *would* have done.
   - Then set `DRY_RUN=false`. Dry runs never wrote `ac_state`, so the live controller starts from "AC off" (or whatever it last really sent).
5. **Remove the simulated data** once real data flows. `raw_health` is untouched by the seed.
   ```sql
   delete from readings where source = 'sim';
   delete from events where source = 'sim_truth';
   delete from nights where is_sim;
   ```
   Alternatively, keep it and point `METER_DEVICE_ID` at the real meter: reads are always per device.

## Google Health (Phase 2)

1. **Google Cloud project.**
   - Enable the Google Health API.
   - Set the OAuth consent screen to **External** and publish it **"In production" (unverified)**. In Testing mode, refresh tokens die after 7 days.
   - Add the three `googlehealth.*.readonly` scopes.
   - Create a Web OAuth client with the redirect URI `https://<ref>.supabase.co/functions/v1/google-oauth/callback`.
2. **Connect each person.** Each person opens `https://<ref>.supabase.co/functions/v1/google-oauth/start?person=a&key=<OAUTH_START_SECRET>` (then `person=b`) and clicks through the unverified-app warning once.
   - The callback stores the refresh token in Vault and records `healthUserId`.
   - It also queues a 14-day backfill, which the 10-minute queue job picks up.
3. **Webhook subscriber** (optional; the three daily pulls work without it).
   - Create a subscriber on the project **number** with `POST https://health.googleapis.com/v4/projects/<number>/subscribers?subscriberId=sleep-lab`.
   - Set `endpointUri` to `https://<ref>.supabase.co/functions/v1/google-health-webhook`.
   - Set `endpointAuthorization.secret` to the value of `GOOGLE_HEALTH_WEBHOOK_SECRET`.
   - In `subscriberConfigs`, list `sleep`, `heart-rate`, `heart-rate-variability`, `respiratory-rate-sleep-summary` and the `daily-*` types, with `subscriptionCreatePolicy: AUTOMATIC`.
   - The function answers the verification POSTs (200 when authorized, 401 when not) and replies **204** to notifications, then queues and triggers a sync. Check the field names against the live docs when creating it (`docs/research/health-data.md` §2.7).
4. **What a sync pulls, per person:**
   - The last 36 h of `heart-rate`, `heart-rate-variability` and `oxygen-saturation` (`dataSourceFamily=google-wearables`).
   - The last 7 days of `sleep` (filtered on `end_time`), `respiratory-rate-sleep-summary` and the `daily-*` types (resting HR, daily HRV, SpO₂, respiratory rate, sleep temperature derivations).
   - Everything returned is appended to `raw_health` before parsing.

## Nightly report and Claude

`nightly-report` loads:
- the night: 1-minute room data from 18:00 to 12:00 ICT, AC log, sleep sessions with 1-minute HR, HRV and SpO₂, and daily extras;
- up to 14 earlier nights: 5-minute room buckets.

It then runs `detectEvents`, which replaces this night's `detector` events, and `buildRuleReport`.

**The Claude rewrite.** With `ANTHROPIC_API_KEY` set, it sends the computed facts to the Messages API.
- The request uses model `claude-opus-5-5` with `output_config.format` = JSON schema `{headline, insights[], drivers[{index,label}]}`, `effort: medium`, and `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`).
- Claude only rewords. Numbers and driver points always come from the rules, and any sentence containing a number (> 10) that isn't in the facts is dropped.
- On any failure (HTTP error, refusal, truncation, bad JSON) the stored report is the rule report, with `generated_by = 'rules'`.
- The request sends `anthropic-version: 2026-10-21` (no sampling parameters, so it is equally valid on `2023-06-01`).
- Cost: roughly 4k input + 2k output tokens per day at $4/$20 per M tokens, about $0.05 per day.

**Push.**
- **Payload format.** Every subscription gets a Declarative Web Push message: `{"web_push": 8030, "notification": {"title", "body", "navigate": "<APP_URL>/?date=<date>", "tag"}}`; the PWA opens that night from `?date=`. iOS 18.4+ Home Screen apps show it without the service worker; `public/sw.js` handles the same JSON in its `push` event for older clients.
- **Subscribing.** System tab → "Morning report notifications" (Supabase source, signed in) asks for permission and calls `register_push_subscription`. It needs `NEXT_PUBLIC_VAPID_PUBLIC_KEY` = the `VAPID_PUBLIC_KEY` secret in the web app's env.
- **Encryption.** Payloads are encrypted per RFC 8291 (aes128gcm) and signed with VAPID (RFC 8292) using `crypto.subtle` only. The encryption is tested against the RFC 8291 Appendix A vector.
- **Dead subscriptions.** A subscription is deleted when the push service answers 404 or 410.

## Quota budget

| API | Daily use | Limit |
|---|---|---|
| SwitchBot | poll 1,440 + aircon ≤ 12 + occasional `listDevices` ≈ **1,460** | local budget 5,000 (`SWITCHBOT_DAILY_BUDGET`), server 10,000 |
| Google Health | ~11 types × 1–2 pages × 2 people × 3 pulls ≈ **100–150**, plus webhook-triggered runs | per-project limits (generous at this scale) |
| Anthropic | 1 call | — |
| Edge Function invocations | ~1,440 + 170 + ~150 + 4 ≈ **1,800/day ≈ 55k/month** | 500k/month on Free |

- **How the SwitchBot budget is shared.** The counter is the `api_quota` row for (`switchbot`, UTC day), shared by all invocations through `bump_api_quota()`. Each invocation writes one `api_quota_log` row with the server's `X-RateLimit-Remaining`.
- **How it is protected.** `poll-meter` stops when fewer than `SWITCHBOT_AC_RESERVE` calls are left, so aircon commands always have headroom.
- **If polling ever needs to be cheaper**, set `POLL_SKIP_IF_FRESH_S=50` after week 1 to skip polls when a webhook reading just arrived.

## Storage

- **Readings:** about 525k rows per year per meter (≈ 60–100 MB with indexes).
- **`health_hr`:** stored as 1-minute means, about 1M rows per year for two people.
- **`raw_health` heart rate:** archived as **hourly chunks** of the unchanged points, keyed by content hash, so a re-fetch with more points adds a version instead of being lost. At the 1 s storage resolution Google allows, this is the largest table: plan on a few hundred MB per year.
- **Free tier:** 500 MB is enough for the first months. Before it fills, move to Pro or export old `raw_health` chunks to Storage.

## Verifying locally

There is no local Postgres. These checks need neither Docker nor a project:

```sh
npx deno check --config supabase/functions/deno.json supabase/functions/*/index.ts
npx deno lint  --config supabase/functions/deno.json supabase/functions/
npx deno test  --config supabase/functions/deno.json supabase/functions/tests/
node --experimental-strip-types scripts/seed-supabase.ts --dry-run
```

With Docker available, `npx supabase start` followed by `npx supabase db reset` applies both migrations to a local stack. That run is the real SQL test; it hasn't been done yet.

## Known gaps

- The SQL migrations have only been reviewed by reading, not executed against Postgres. Run `supabase db reset` locally or check the first `db push` output.
- The Google Health filters for `daily-*` (`<type>.date >= "YYYY-MM-DD"`) and `respiratory-rate-sleep-summary` aren't confirmed. On a 400 the sync falls back to the newest page without a filter. `respRate` and `tempDeviationC` are read from the stored payloads by field name (`breathsPerMinute`, `nightlyTemperatureCelsius` − `baselineTemperatureCelsius`).
- Webhook signature verification is best effort, so the default is `log`. The `Authorization` secret is always enforced.
- `ac-curve` uses the night's scheduled lights-out and wake times (or the defaults). Detected in-bed times don't move the curve yet.
- Edge Functions have a 2 s CPU limit. A 14-day Google backfill at 1 Hz heart rate parses tens of thousands of points in one invocation. If it hits the limit, call `google-health-sync` with smaller `hours` windows.
