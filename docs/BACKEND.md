# Backend: Supabase

Supabase is the always-on part of Sleep Lab. It stores everything in Postgres, runs `pg_cron` schedules, and hosts the Edge Functions that talk to SwitchBot, Google Health, Claude and Web Push. The PWA on Vercel only reads, under row-level security.

Everything in this document can be deployed with the Supabase CLI or the Supabase MCP tools. The live project is `sleep-lab` (ref `vaelokyqjdsxveqvdtbo`, `ap-southeast-1`); see [Deployment status](#deployment-status). Until the devices are unboxed (Phase 0), the database runs on simulated nights and the aircon controller runs in `DRY_RUN`.

## Layout

```
supabase/
  config.toml                 CLI config (verify_jwt = false for every function; they check their own secrets)
  migrations/0001_init.sql    tables, views, RLS, grants, security-definer RPCs
  migrations/0002_cron.sql    pg_cron + pg_net schedules (secrets read from Vault)
  migrations/0003_health_vitals.sql  health_vitals_daily: steps, resting HR, daily HRV per person and ICT date
  migrations/0004_security_hardening.sql  advisor fixes: definer RPCs moved to `private`, deny-all policies, FK indexes
  migrations/0005_household_claims.sql    people rows 'a' (You) / 'b' (Erik) + one-time household claim codes
  migrations/0006_household_claims_policy.sql  deny-all policy on private.household_claims (advisor 0008)
  functions/
    deno.json                 strict TS settings for `deno check` / `deno lint`
    .env.example              every secret the functions read
    _shared/                  env, http, auth, supabase client, row mappers, loaders, SwitchBot quota,
                              Google Health helpers, Claude coach, Web Push (RFC 8291 / 8292)
    switchbot-webhook/        SwitchBot webhook → readings (secret URL path)
    switchbot-admin/          Registers / inspects the SwitchBot webhook (cron-secret or service key)
    poll-meter/               minute poll of the Meter Pro CO2 (quota-aware)
    ac-curve/                 temperature curve → IR command (every 5 min overnight)
    google-health-sync/       Google Health API v4 pull → raw_health + derived tables
    google-health-webhook/    Google Health notifications → sync jobs (replies 204)
    google-oauth/             /start and /callback; refresh tokens go to Vault
    nightly-report/           night analysis (cleaned readings → events, night_metrics) + rule report + Claude rewrite + Web Push
    push-admin/               VAPID keys (created in the backend, kept in Vault) + public-key GET + test push
    calendar-sync/            both Google Calendars → household trips → away_periods (source 'calendar', 0018)
    weather-poll/             Phuket outdoor temp/RH every 15 min (Google Weather or Open-Meteo) → outdoor_readings
    food-photo/               meal photo (Storage 'meals') → Gemini → meals → Google Health nutrition log (0020)
    camera-event/             Mac relay's camera sightings (labels only) → camera_events; unknown-person push (0022)
    owntracks/                OwnTracks HTTP-mode fixes → locations; home/away from them; friends array (0023)
    camera-ticket/            Ed25519-signed camera viewer tickets for the Mac's stream gate; public key on GET (0023)
    night-sound/              Mac night listener: listen now? (GET); minute summaries + events → sound_minutes/sound_events, clip upload URLs (0024)
    tests/                    `deno test` (Web Push RFC vector, coach grounding, health helpers)
scripts/seed-supabase.ts      simulated nights → Supabase (Node)
```

The functions import the shared core by relative path, one module at a time (`../../../packages/core/src/switchbot/client.ts`, not the `index.ts` barrel), so each function bundles only the core modules it uses (the barrel pulls in the whole simulator). Imports that only carry types use `import type`, so `types.ts` never has to be shipped. The Supabase CLI bundles static imports from outside `supabase/functions`, so no copy is needed; with the MCP `deploy_edge_function` tool, send every file of the function's module graph under its repo path (entrypoint `supabase/functions/<name>/index.ts`), e.g. from `npx deno info --json supabase/functions/<name>/index.ts`. The only third-party import is `npm:@supabase/supabase-js@2`.

## Data model

All timestamps are `timestamptz` (UTC). A night is keyed by the **ICT wake-up date** (`nights.date`), the same convention as `packages/core/src/types.ts`.

| Table | What | Written by |
|---|---|---|
| `people` | Person ids (`a`, `b`), names, `google_health_user_id` | seed / SQL / OAuth |
| `household_members` | `auth.users` → person; membership gives read access | `claim_household()` RPC (one-time code), or SQL |
| `devices` | SwitchBot device ids (meter, AC, sim) | functions / seed |
| `readings` | Room temp/RH/CO₂ per device per **minute**, PK `(device_id, ts)`, BRIN on `ts` | webhook, poll, seed |
| `raw_switchbot` | Every webhook body unchanged, for measuring cadence and lag | webhook |
| `outdoor_readings` | Outdoor temp/RH, PK `ts`; `source` = `open_meteo` / `google_weather` / `manual` / `sim` | weather-poll (every 15 min, 0018), seed |
| `calibrations` | CO₂ outdoor calibrations, offsets | manual |
| `curves` | Temperature curves (`phases` jsonb = `CurvePhase[]`); `default-v1` is inserted by 0001, `one-beep-v1` (the default since 0009) by 0009 | SQL |
| `presence_events`, `presence_latest` (view) | Arrive/leave-home events from the iPhones (0009); household read, service-role write | presence |
| `nights` | lights-out, wake, curve, tags, `ac_enabled` | `set_night()` RPC, ac-curve (default schedule), seed |
| `ac_commands` | Every decision: state, via, button, reason, `landed`, `dry_run`, `sent_ok` | ac-curve |
| `ac_state` | One row per AC: assumed state, last command, `remote` (RemoteProfile jsonb), `bias_c` | ac-curve / SQL |
| `events` | Shower, door, in-bed, `ac_missed` …; `source` = detector / manual / sim_truth / controller | nightly-report, ac-curve, seed |
| `raw_health` | **Append-only** Google Health archive (`point_key`, `payload`, `update_time`, `data_source`); a trigger blocks UPDATE/DELETE | google-health-sync |
| `meals` | Food photos analysed by Gemini: totals, `items` jsonb, `confidence`, `model`, `raw`, `google_status` / `google_point`; `hidden` instead of removal (0020) | food-photo; members edit their own person's (owner: any) |
| `camera_events` | Camera sightings from the Mac relay: `label` (`a`/`b`, a consenting guest's label, `unknown`, `person`), `person_id`, `confidence`, `activity` (zone), `duration_s`; labels only, never biometric data; `hidden` instead of removal (0022) | camera-event; members may set `hidden` |
| `camera_alerts` | Last push per alert kind (`unknown`), claimed atomically by `claim_camera_alert()` (0022); service role only | camera-event |
| `health_hr` (1-min means), `health_hrv`, `health_spo2`, `sleep_sessions`, `health_daily`, `health_vitals_daily` | Derived layers, rebuildable from `raw_health` | google-health-sync, seed |
| `health_sync_jobs` | Queue fed by the Google webhook | webhook, OAuth |
| `reports` | `report` (NightReport, possibly Claude-worded), `rule_report`, `generated_by`, `model` | nightly-report, seed |
| `night_metrics` | One row per night (0016): room metrics from **cleaned** readings, morning ACH fit, data-quality columns (`coverage_pct`, `frozen_*`, `gap_*`, `invalid_co2_count`, `flags[]`, full `quality` jsonb) and counts. Members read it. See [Night analysis](#night-analysis-migration-0016) | nightly-report |
| `push_subscriptions` | Web Push endpoints per user | `register_push_subscription()` RPC |
| `oauth_tokens` | Per person: **Vault secret id** of the refresh token, scopes, `needs_reconsent` | google-oauth |
| `oauth_states` | Single-use OAuth `state` values (15 min) | google-oauth |
| `band_sync` | Per person: last google-health-sync run (`last_sync_at`, `last_sync_ok`, `last_error`), band → Google sync time (`device_last_sync_at` from `pairedDevices`, `newest_point_at` = newest wearable point), `devices`, `last_manual_sync_at` (Sync now rate limit). Members read it (migration 0015) | google-health-sync |
| `api_quota`, `api_quota_log` | Daily call counters (SwitchBot, Google) and one log row per invocation | functions |

Views and functions:
- `latest_readings`: the newest reading per device.
- `readings_5min`: a 5-minute rollup.
- `readings_buckets(from, to, minutes, device)`: the same rollup, filtered on `ts` first so it uses the indexes. Prefer it for charts.

**Access model (two-person household).**
- RLS is on for every table.
- An authenticated user who has a row in `household_members` can `select` everything except the OAuth tables and the sync queue. Push subscriptions are visible only to their owner.
- Only the service role (Edge Functions, seed script) writes to tables.
- A signed-in account that isn't a member yet can call exactly one thing: `claim_household(p_code)` (see [Household and sign-in](#household-and-sign-in)).
- The PWA writes through three RPCs that check membership:
  - `set_night(p_date, p_lights_out, p_wake, p_tags, p_curve_id, p_ac_enabled)`
  - `register_push_subscription(endpoint, p256dh, auth, user_agent)`
  - `unregister_push_subscription(endpoint)`
  - Since migration 0004 the `public` functions are `SECURITY INVOKER` wrappers; the security-definer bodies and the membership helpers (`private.is_household_member()`, `private.is_household_writer()`, used by every RLS policy) live in the `private` schema, which the Data API doesn't expose. `authenticated` has `USAGE` on `private` and `EXECUTE` on exactly those five functions.
- `oauth_tokens`, `oauth_states` and `health_sync_jobs` have an explicit deny-all policy for `anon` and `authenticated`; only the service role (which bypasses RLS) touches them.
- **Grants are explicit.** Supabase stops auto-granting Data API access to new tables from 2026-10-30, so the migration grants `select` to `authenticated`, `all` to `service_role` and nothing to `anon`.

**Secrets at rest.**
- Google refresh tokens live in **Supabase Vault** (`vault.secrets`, encrypted). `oauth_tokens` stores only the secret's id.
- `store_google_refresh_token()` and `get_google_refresh_token()` are the only way in or out, and only `service_role` may execute them.
- `cron_secret` and `project_url` (cron → Edge Function calls) are in Vault too; see [Cron authentication](#cron-authentication).
- Everything else is in Edge Function secrets.

### Cron authentication

pg_cron calls the functions over HTTP with `pg_net` and must prove it's the scheduler, without any API key stored in SQL:

1. Migration 0002 generates `cron_secret` in Vault once (`encode(extensions.gen_random_bytes(32), 'hex')`). Nobody ever needs to see it.
2. `private.invoke_edge_function(name, body, timeout)` (security definer, not executable by API roles) reads `project_url` and `cron_secret` from `vault.decrypted_secrets` at call time and sends `x-cron-secret: <cron_secret>`. Nothing secret is stored in `cron.job`.
3. Each scheduled function (`_shared/auth.ts` → `isCronRequest`) accepts the header when it matches:
   - the `CRON_SECRET` Edge Function secret, if one is set (optional; useful for calling functions by hand), or
   - Vault, via `public.verify_cron_secret(p_secret)`: a security-definer RPC executable **only by `service_role`** that compares SHA-256 digests and returns a boolean, so the secret never leaves the database. Positive results are cached per worker for 5 minutes, so the every-minute poll costs one extra query at most every 5 minutes.
4. The project's own service key also works, as `Authorization: Bearer` or `apikey` (legacy service-role JWT or `sb_secret_…` from `SUPABASE_SECRET_KEYS`). `google-health-webhook` uses this to kick `google-health-sync`.

The only per-project value is `project_url`, which Postgres can't discover by itself. It was created once in the live project with
`select vault.create_secret('https://vaelokyqjdsxveqvdtbo.supabase.co', 'project_url');` (repeat that for any new project; until it exists the jobs only log a warning). To call a cron-protected function by hand, either set a `CRON_SECRET` function secret and send that, or use the service key.

**Key migration.** Supabase retires the legacy JWT keys at the end of 2026. The functions prefer `SUPABASE_SERVICE_ROLE_KEY` while it exists and fall back to `SUPABASE_SECRET_KEYS.default`, and they accept either as a service credential, so switching keys needs no code change. `scripts/seed-supabase.ts` still takes the key in `SUPABASE_SERVICE_ROLE_KEY` (an `sb_secret_…` value works there).

**Missing configuration.** A required secret that isn't set makes a function answer `503 {"error":"not configured","missing":"<NAME>"}` after authentication (never before it). `switchbot-webhook` answers 404 to any path that matches neither `WEBHOOK_SECRET` nor the Vault secret, `google-health-webhook` 401 while its secret is unset, and `google-oauth/start` answers `503 … "missing":"GOOGLE_CLIENT_ID"` (or `GOOGLE_CLIENT_SECRET`) to a signed-in member, which the PWA shows as "Google sign-in isn't set up on the server yet". `ac-curve` sends real IR only when `household_settings.ac_live` is true (migration 0012, toggled in the app) and the `DRY_RUN` secret does not force a dry run: unset or `false`/`0`/`no`/`off` leaves the decision to `ac_live`, any other value forces dry. A request can force a dry run (`{"dryRun":true}`) but never a live one, and `{"at": …}` (a simulated moment) is always a dry run that writes nothing.

## Secrets

Enter them in the dashboard under **Edge Functions → Secrets** (https://supabase.com/dashboard/project/vaelokyqjdsxveqvdtbo/functions/secrets): one row per name, exactly as spelled below. The CLI equivalent is `supabase secrets set NAME=value …` or `supabase secrets set --env-file supabase/functions/.env`. Never commit them. `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_SECRET_KEYS` are injected automatically. New secrets apply to the next invocation; no redeploy is needed.

Until a function's required secrets are set it answers `503 {"error":"not configured","missing":"<NAME>"}` (after authentication), so nothing breaks while they're missing.

| Secret | Used by | Notes |
|---|---|---|
| `CRON_SECRET` | all scheduled functions | **Optional.** pg_cron is verified against Vault (see Cron authentication). Set it only to call functions by hand with a secret you know |
| `SWITCHBOT_TOKEN`, `SWITCHBOT_SECRET` | poll-meter, ac-curve | App → Profile → Preferences → Developer Options |
| `METER_DEVICE_ID` | poll-meter, ac-curve, nightly-report | Meter Pro CO2 `deviceId` (MAC without colons). Use `SIM-METER` in Phase 0 |
| `AC_DEVICE_ID` | ac-curve | The IR remote's `deviceId` from `listDevices().infraredRemoteList` |
| `WEBHOOK_SECRET` | switchbot-webhook | **Optional.** The path secret lives in Vault (`switchbot_webhook_secret`, migration 0008). Set this only to also accept a URL with a secret you chose |
| `DRY_RUN` | ac-curve | Optional kill switch since 0012: any value other than unset/`false`/`0`/`no`/`off` forces a dry run. Live vs dry is otherwise `household_settings.ac_live` (System › Tonight's plan › Aircon control) |
| `SWITCHBOT_DAILY_BUDGET` | all SwitchBot calls | Default 5000; the server limit is 10,000 |
| `SWITCHBOT_AC_RESERVE` | poll-meter | Default 300. Polling stops when fewer calls are left, keeping room for aircon commands |
| `POLL_SKIP_IF_FRESH_S` | poll-meter | Default 0 (off). For example, 50 skips the poll when a webhook reading is that fresh |
| `DEFAULT_LIGHTS_OUT`, `DEFAULT_WAKE` | ac-curve, nightly-report | ICT `HH:MM` used when a night has no row yet. Defaults are 22:00 (every day) and 08:30 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | google-oauth, google-health-sync, calendar-sync | OAuth client of type "Web application" |
| `GOOGLE_HEALTH_WEBHOOK_SECRET` | google-health-webhook | The subscriber's `endpointAuthorization.secret` |
| `GOOGLE_HEALTH_SIGNATURE` | google-health-webhook | `off` / `log` (default) / `enforce`. The ECDSA verifier is best effort |
| `OAUTH_START_SECRET` | google-oauth | **Optional, legacy.** Enables the `GET /start?person=&key=` setup link. Not needed: the PWA starts consent with the member's own sign-in |
| `APP_URL` | nightly-report, google-oauth, ac-curve | The PWA origin (push tap target; google-oauth redirects back to `<APP_URL>/settings/health`). google-oauth falls back to `https://sleep-lab-git-claude-determined-ride-59txro-evhg.vercel.app` when unset |
| `ANTHROPIC_API_KEY` | nightly-report | Optional. Without it, reports are rule-only |
| `ANTHROPIC_MODEL` | nightly-report | Default `claude-opus-5-5` |
| `VAPID_SUBJECT` | nightly-report, ac-curve, push-admin | Optional `mailto:` / `https:` contact; default = the `APP_URL` origin, else `https://sleep-lab-lac.vercel.app` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | — | **Not needed** since 0016: the key pair is generated in the backend and kept in Vault. If set while Vault is empty, they are adopted into Vault once |
| `GOOGLE_WEATHER_API_KEY` | weather-poll | Optional. Google Maps Platform key with the Weather API enabled (needs billing). Unset → the Vault secret `google_weather_api_key` (0020); neither, or a failing call → Open-Meteo (free, no key) |
| `GEMINI_API_KEY` | food-photo | Optional. Unset → the Vault secret `gemini_api_key` (0020). Neither → `503 not configured` |
| `GEMINI_FOOD_MODEL` | food-photo | Optional; default `gemini-3.8-flash` (gemini-2.5-flash is closed to new projects) |
| `WEATHER_LAT`, `WEATHER_LON` | weather-poll | Optional; default Phuket 7.88 / 98.39 |
| `PUBLIC_FUNCTIONS_URL` | optional | Overrides `<SUPABASE_URL>/functions/v1`, e.g. behind a custom domain |

## Setup, step by step

1. **Create the project.**
   - In the Supabase dashboard, create a new project in the Singapore region (`ap-southeast-1`), the closest to Phuket.
   - Note the project ref.
   - Then run `npx supabase login` and `npx supabase link --project-ref <ref>`. The CLI isn't a repo dependency; `npx` fetches it.
2. **Push the schema:** `npx supabase db push`. This applies `0001_init.sql` to `0004_security_hardening.sql`.
   - 0002 enables `pg_cron`, `pg_net` and `pgcrypto`, generates the `cron_secret` Vault secret and creates the jobs. Until step 3 is done they only log a warning (`vault secrets project_url / cron_secret are not set`).
3. **Project URL for cron.** In the dashboard SQL editor, run once:
   ```sql
   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
   ```
4. **Function secrets.**
   - Copy `supabase/functions/.env.example` to `supabase/functions/.env` and fill it in.
   - For Phase 0 use `METER_DEVICE_ID=SIM-METER`, `AC_DEVICE_ID=SIM-AC` and `DRY_RUN=true`.
   - Then run `npx supabase secrets set --env-file supabase/functions/.env`.
5. **Deploy the functions:** `npx supabase functions deploy`. `verify_jwt = false` comes from `config.toml`; each function checks its own secret.
   - Upgrading an existing project: run `npx supabase db push` first. `google-health-sync` writes `health_vitals_daily` (migration 0003), and without it the `steps` and `*:vitals` steps fail on every sync.
6. **Household.** Migration 0005 creates the two person rows; then follow [Household and sign-in](#household-and-sign-in) (invite both addresses, create one claim code per person, each person enters theirs in the app).
7. **Seed simulated data (Phase 0, optional; never on the live project once real data flows):**
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

## Household and sign-in

The PWA (`/signin`) signs in with a 6-digit email code or the magic link in the same email, with `shouldCreateUser: false`, so only addresses that already exist in Auth can sign in. Data access comes only from a `household_members` row; a signed-in non-member sees "Almost there" and can read nothing (RLS).

**Binding the two accounts (claim codes, migration 0005).** `people` already holds `a` = You and `b` = Erik.

1. **Invite both addresses:** Dashboard → Authentication → Users → *Add user* → *Send invitation*.
2. **Create one code per person** in the SQL editor (Dashboard → SQL Editor, which runs as `postgres`). Each call returns the code once; only its SHA-256 is stored:
   ```sql
   select private.create_household_claim('a', 'owner');   -- You
   select private.create_household_claim('b', 'member');  -- Erik ('owner' also works; 'viewer' is read-only)
   ```
   Codes are 24 hex digits (shown as `XXXX-XXXX-…`, 96 random bits), single use, valid 7 days (third argument, e.g. `interval '1 day'`). Creating a new code for a person revokes their unused older ones; a person already linked to an account can't get a code.
3. **Each person signs in** at `<app>/signin`, lands on "Almost there", enters their code under *Household code* → *Join the household*. `public.claim_household(p_code)` (SECURITY INVOKER wrapper of `private.claim_household`, `authenticated` only) inserts their `household_members` row and burns the code. Calling it again as a member just returns the existing row.

Check or undo:
```sql
select person_id, role, created_at, expires_at, claimed_at, revoked_at from private.household_claims order by created_at desc;
select m.person_id, m.role, u.email from household_members m join auth.users u on u.id = m.user_id;
delete from household_members where person_id = 'b';   -- unlink, then issue a new code
```
The SQL alternative still works: `insert into household_members (user_id, person_id, role) select id, 'a', 'owner' from auth.users where email = '<email>';`.

**Auth settings for the live project** (dashboard only; the MCP tools and the CLI's `config.toml` don't change hosted Auth settings. `config.toml` mirrors them for a local stack):

| Where | Setting |
|---|---|
| Authentication → Sign In / Providers → *User Signups* | **Allow new users to sign up: off.** Invites still work. (Email provider stays on.) |
| Authentication → URL Configuration → *Site URL* | `https://sleep.cathnivore.com` (on 2026-10-30 it was still `http://localhost:3000`: every email link went there and was used up on a dead page) |
| Authentication → URL Configuration → *Redirect URLs* | `https://sleep.cathnivore.com/**`, `https://sleep-lab-lac.vercel.app/**`, `https://sleep-lab-git-claude-determined-ride-59txro-evhg.vercel.app/**`, `https://sleep-lab-*-evhg.vercel.app/**` (all previews), `http://localhost:3000/**` |
| Authentication → Emails → Templates → *Magic Link* | **Required for the code step:** the default template has only the link. Add the code, e.g. `<p>Your code: <strong>{{ .Token }}</strong></p>` next to the `{{ .ConfirmationURL }}` link. The installed iOS app can only use the code (or a password): links open in Safari, whose storage is separate |
| (why) | The app sends `emailRedirectTo = <current origin>/signin`; an origin not on the Redirect URLs list is silently replaced by the Site URL |
| Authentication → Emails → SMTP (optional) | The built-in sender is rate-limited (a few emails per hour) and meant for testing; add custom SMTP if codes stop arriving |

**Vercel env** (project `sleep-lab`, all three environments; already set): `NEXT_PUBLIC_SUPABASE_URL=https://vaelokyqjdsxveqvdtbo.supabase.co` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` = the project's publishable key (`sb_publishable_…`, public by design; RLS protects the data). They take effect on the next deployment. Optional: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (= `VAPID_PUBLIC_KEY`), `NEXT_PUBLIC_FUNCTIONS_URL`, `NEXT_PUBLIC_METER_DEVICE_ID`.

## SwitchBot webhook

SwitchBot doesn't sign deliveries, so the URL's last path segment is the credential:
`https://<ref>.supabase.co/functions/v1/switchbot-webhook/<secret>`.

- **Secret.** Migration `0008_switchbot_webhook_secret` generates `switchbot_webhook_secret` in Vault (32 random bytes, hex) and adds two security-definer functions that only `service_role` can execute: `verify_switchbot_webhook_secret(text)` (SHA-256 digest compare, like `verify_cron_secret`) and `switchbot_webhook_secret()` (returns the value so `switchbot-admin` can build the URL). Nobody has to see or paste it.
- **Receiver.** `switchbot-webhook` accepts the path segment (or `?token=`) if it equals the optional `WEBHOOK_SECRET` function secret or verifies against Vault through the RPC; a verified value is cached per worker for 5 minutes. Anything else gets 404.
- **Registration.** `switchbot-admin` (`verify_jwt = false`, x-cron-secret or service key, same as `poll-meter`):
  - `{"action":"status"}` returns the registered URL(s) with `enable`, `deviceList`, create/update times. URLs are always masked (`…/switchbot-webhook/9d3a…(64)`).
  - `{"action":"register-webhook"}` reads `queryUrl` (statusCode 190 there means "none registered"), removes any older `…/switchbot-webhook/…` URL of this project (one URL per account in practice; `updateWebhook` only toggles `enable`), calls `setupWebhook` with `deviceList: "ALL"` (or `updateWebhook enable=true` if ours is registered but disabled), then confirms with `queryDetails`. It is a no-op when ours is already registered and enabled. A URL that belongs to another integration (e.g. Home Assistant) is left alone and the call answers 409, unless the body has `"replace": true`.
  - Every SwitchBot call goes through the quota session (`api_quota`, `api_quota_log` with `fn = 'switchbot-admin'`); a registration costs 3 calls.
- **Re-register** (e.g. SwitchBot dropped the URL, or it shows `enable: false`): run the `register-webhook` SQL above again. It is idempotent.
- **Rotate the secret:**
  ```sql
  select vault.update_secret(id, encode(extensions.gen_random_bytes(32), 'hex'))
  from vault.secrets where name = 'switchbot_webhook_secret';
  select private.invoke_edge_function('switchbot-admin', '{"action":"register-webhook"}', 30000);
  ```
  The second call removes the old URL and registers the new one. Workers may accept the old value for up to 5 more minutes (positive cache), after which it is 404.
- **Delivery vs poll.** The webhook is change-based; the minute poll (`poll-meter`) stays as the reconciler. Compare `readings.source` and `raw_switchbot.received_at` against the poll rows.

## Presence and the pre-cool gate (migrations 0009, 0010)

Decided 2026-10-29: bedtime 22:00 every day, pre-cool at 21:30 **only if someone is home**, one beep per night.

- **Curve** `one-beep-v1` (`DEFAULT_CURVE`): ON at lights-out − 30 min to 19 °C (set 18, fan auto), nothing at lights-out,
  ONE warming step at +4 h 30 to 21 °C (set 20), OFF at wake + 30 min. Quiet mode plans exactly one command while asleep.
- **Presence**: each iPhone runs two Shortcuts personal automations (Arrive / Leave home) that `POST` `{"state":"home"|"away"}`
  to `/functions/v1/presence` with an `X-Presence-Token` header (`verify_jwt = false`; the token is the credential).
  Tokens (`slp_` + 64 hex) are per person, stored only as SHA-256 in `private.presence_tokens`, created or rotated from
  System › Presence via `rotate_presence_token(person)` (shown once; only that person's own account or the household
  owner, migration 0010). `record_presence()` is service-role only; a DB error answers a generic `{"error":"internal"}`.
- **Gate** (`_shared/presence.ts`, used by ac-curve before the first power-on command in tonight's command log, whatever
  the assumed AC state): someone home = any person's latest event is `home` and at most 48 h old, or the night's
  `presence_override = 'home'` ("Home tonight"); `away` override or the `travel` tag keeps the AC off (and switches an
  assumed-on AC off). A `home` older than 48 h (a lost Leave event) is *stale*: it only counts when bedroom CO₂ also rose
  ≥ 120 ppm over the last hour (to ≥ 550 ppm), otherwise the night waits with "home signal stale". No presence data ever →
  no pre-cool. Nobody home → retried every 5 min until lights-out + 3 h; the gate is closed before the pre-cool start. A
  closed gate also switches off an AC still assumed ON. The decision is stored on `nights.precool_status / precool_reason
  / precool_at` and returned as `{"skipped":"precool: …"}`. Times older than today show a weekday ("since Mon 18:42").
- **Push**: when a presence signal (not "Home tonight") starts a live pre-cool, every push subscription gets "Aircon
  pre-cool started", tapping opens Tonight's plan where "Away tonight" switches it off (no push in dry run).
- **App**: Tonight's plan shows lights out, an editable "Asleep by" (`set_sleep_onset`) and wake (`set_night`), Home / Away /
  Unknown with who and since when, the one-tap override (`set_presence_override`) and the pre-cool line.

## Steady 18.5 °C, live switch, home by default, away dates (migrations 0012–0014)

Decided 2026-10-30, after the first real night (aircon at 17 °C by hand: bed 18.5–19.9 °C, CO₂ plateau ~930 ppm, RH
53–55 %): ~18.5 °C all night (Walker: ~18 °C), the room must not warm while either of them may still be in deep sleep
(the watches' stages are not live overnight), and "let the plan run for real".

- **Curve** `steady-18-5-v1` (`DEFAULT_CURVE` since 0012): pre-cool at lights-out − 30 min (21:30) to 18.5 °C, fan auto;
  every later phase 18.5 °C → no command at lights-out, at sleep onset or while asleep; OFF at wake + 30 (09:00).
  `minC` 17 since 2026-11-01 (was 16): the Carrier 42TGF0301BP's Toshiba-type remote encodes 17–30 only
  (`SETALL_MIN_C`), so with set 17 there is no colder emergency (the DB row from 0012 may still say `min_c` 16; the
  controller floors every setpoint at 17 regardless). Upcoming real nights on one-beep-v1/v2 whose
  pre-cool had not started moved to it; stored nights keep their curve.
- **Bias** `ac_state.bias_c = −2` (0012, only when unset): set 17 held the bed at 18.5–19.9 °C, so 18.5 °C needs set 17.
- **Emergency while asleep only cools** (core `QuietConfig.emergencyWarm`, default false): a room ≥ target + 1.5 °C for
  20 min gets one command (setpoint − round(deviation)); a too-cold room is never warmed while asleep. Since
  2026-11-01 only when (a) the new setpoint is strictly colder than the last command (none at the 17 floor) and (b) the
  room has stopped cooling: slope over the last 30 min > −0.3 °C/h (too little data to tell → wait). Night 2026-10-31: "set 16" went out at 23:45 while
  the room was still falling 21.7 → 21.3 °C under Cool 17; the unit stopped cooling and the room rose to 26 °C.
- **`public.household_settings`** (one row, id 1; household read; `set_household_settings(p_ac_live, p_default_presence)`
  for owner/member): `ac_live` (default false) and `default_presence` (`home` | `unknown`, default `unknown`). 0014 set
  `ac_live = true`, `default_presence = 'home'`.
- **`public.away_periods`** (`from_date`, `to_date` = evening dates, inclusive; `note`; `active`): the night ending on D is
  away when D − 1 is in range → AC off all night, like "Away tonight" ("Home tonight" wins for one night). Owner/member:
  `add_away_period(from, to, note)` and `set_away_period_active(id, false)` ("Remove" in the app; rows are never
  removed). Seeded: Bangkok, evenings 5–6 Nov 2026 (home again the evening of 7 Nov).
- **Gate order** (`_shared/presence.ts`): Away tonight / travel → away · Home tonight → home · away period → away · a
  fresh phone `home` → started (push) · `default_presence = 'home'` → home ("home by default", no push) unless every
  person's latest phone signal is `away` and ≤ 12 h old → waits · otherwise the 0009 rules (stale home + CO₂, no data → off).
- **No beep once asleep (follow-up, 2026-10-30)**: the AC is only *started* until lights-out + 15 min (quiet mode's
  settle; `ASLEEP_START_MIN`) unless a phone `home` signal newer than the pre-cool start (a real late arrival) opens it,
  until lights-out + 3 h as before. "Home by default", "Home tonight" and stale home + CO₂ close at 22:15, so a 21:30
  ON that failed (hub offline; retried after 20, 40, 60 min) never beeps after they fell asleep. Until the expected
  sleep onset the controller resends a stalled command (room > target + 2.5 °C, not cooling) at most twice a night
  (2026-10-31); the one cooling emergency only looks at readings after lights-out + 15 (earliest 22:35).
- **Aircon not responding (2026-10-31)**: SwitchBot's statusCode 100 only means the cloud accepted the command (IR is
  one-way), so ac-curve logs the literal request and response of every live send (`switchbot send`). A command counts
  as landed only when the pull-down starts within 20 min of it (a manual fix with the handheld remote is not credited),
  judged after 30 min in both the controller and ac-curve. After two unanswered power-on commands with the room still
  hot, the household gets one push per night (only before the expected sleep onset) ("Aircon isn't cooling"), recorded as an `ac_missed` event with
  `detail.notice = 'unresponsive'`; a dry run only logs it.
- **Frozen meter (poll-meter)**: with the hub unplugged, SwitchBot's GET /status keeps returning the last cached value.
  When the newest 15 rows are polls with exactly the same temperature, RH and CO₂ and no webhook row arrived in 30 min,
  the poll stores nothing (`api_quota_log.status = 'skipped:stale'`); the gap makes the controller's coverage checks
  return null instead of acting on stale data. The first changed value is stored again.
- **Simulation**: `{"at":"2026-10-30T21:30:00+07:00"}` (or epoch ms) evaluates ac-curve as of that moment: always dry,
  nothing stored (no command row, gate status or landing), the decision is in the response. E.g.
  `select private.invoke_edge_function('ac-curve', '{"dryRun":true,"at":"2026-10-30T21:30:00+07:00"}', 30000);` then
  read `net._http_response`.
- **App**: Tonight's plan shows "Home by default" and "Aircon control: Live / Dry-run" switches and the Away dates list
  (add / remove); the plan uses the backend's bias for its set points.

## Quiet fan from 22:30 (migration 0019)

Decided 2026-11-01: the steady-18-5-v1 night ran as planned, but the fan on auto was too loud to fall asleep.

- **Curve** `steady-18-5-quiet-v1` (`DEFAULT_CURVE` since 0019): 18.5 °C all night like steady-18-5-v1; pre-cool at
  21:30 on fan auto (fast pull-down), fan **low** from lights-out + 30 (22:30), OFF at wake + 30 (09:00). With bias −2
  and the learned "Others" ladder in `ac_state.remote`: 21:30 "17 cool auto" · 22:30 "cool 17 low" (fan only, same
  setpoint; the one planned beep after lights-out) · 09:00 "off". The 22:30 step is sent until 23:00 (quiet mode's
  step grace); a fan-only command is never resent and does not use the night's one extra command. A planned step that
  keeps the target never raises the setpoint while asleep (unless `quiet.emergencyWarm`): a room that settled near
  setpoint + 1 (re-measured bias −1) still gets "cool 17 low", not "cool 18 low".
- **Ladder selection** (core `remoteCommand`): nearest setpoint first, then the button with the requested fan (then
  mode) among buttons with that setpoint. Before, the first learned 17 button always won, so "fan low" mapped to "17
  cool auto" (the button already pressed) and was silently skipped; `fanFor` also forced 'auto' for every ladder remote.
- **0019**: inserts the curve, makes it the only default (`steady-18-5-v1` kept, renamed "Steady 18.5 °C (v1, fan
  auto)"), and moves real nights dated 2026-11-02 or later that are still on `steady-18-5-v1` to it. Nights created
  afterwards by `ensureNight` take the default. Needs `ac-curve` (and `nightly-report`, which bundles curve.ts for its
  fallback curve) redeployed: an old ac-curve bundle would map "fan low" back to "17 cool auto" and send nothing at 22:30.

## Calendar trips and outdoor weather (migration 0018)

Decided 2026-10-31: trips in the calendars switch the aircon off by themselves, and the night analysis gets real
outdoor weather.

- **`calendar-sync`** (pg_cron hourly at :23, or a household owner/member's JWT; `{"dryRun":true}` computes without
  writing). Per person: the Google access token from the same Vault refresh token as google-health-sync
  (`_shared/google.ts`; scope `calendar.events.readonly` is part of the one consent), then the primary calendar's events
  from 14 days back, or from the first evening of a stored calendar trip still under way (so its outbound leg is still
  seen), to 45 days ahead (`singleEvents=true`, `orderBy=startTime`, only the needed fields).
- **Trips** (core `calendar/trips.ts`): flights (Gmail `fromGmail` events, "Flight to Bangkok", "HKT → BKK"; an
  outbound from HKT pairs with the next flight to HKT), multi-day all-day events (their last day is the day home;
  "visiting", "guests", "WFH" excluded), overnight hotel / Gmail stays, events at a place outside Phuket (city, airport
  code or a non-83xxx Thai postcode in the location). Keywords like "trip" or "check-in" alone never make a night. An
  evening E of a trip is away when the trip started by E 20:00 and lasts to E+1 03:00 (day trips and late departures
  stay home); a short event located in Phuket that evening vetoes it.
- **Household rule**: an evening is away only when EVERY person is away (core `householdAwayRanges`). Nothing is written
  unless every person's calendar was read (no connection, `needs_reconsent`, calendar scope missing or an API error →
  `409` / `ok:false`, rows untouched).
- **`away_periods`** gains `source` (`manual` | `calendar`), `external_id` (`cal:<first evening>`), `in_calendar`,
  `synced_at`. `sync_calendar_away_periods(ranges, cutoff)` (service role only) upserts the household's trips and sets
  `active = false, in_calendar = false` on calendar rows that are gone; rows that ended before tonight's evening and
  every manual row (the Bangkok seed) are never touched. A trip inside an active manual period is not added again. A
  calendar row removed in the app stays off (also if the trip vanishes and reappears, or reappears with another first
  evening); one the sync retired comes back if the trip reappears. Once tonight's evening has begun (18:00), a sync that
  would newly mark tonight away writes nothing until noon: a trip appearing mid-night must not switch off a running
  aircon. One-way flights alone, and flights they meet or see off ("pick up", "drop off"), make no night.
- **`weather-poll`** (pg_cron every 15 min at :07/:22/:37/:52): Google Weather `currentConditions:lookup` when
  `GOOGLE_WEATHER_API_KEY` is set, otherwise (or when Google fails) Open-Meteo `current=temperature_2m,
  relative_humidity_2m`; parsed by core `weather/parse.ts`, upserted on `ts`. `loadNight()` (nightly report) and the
  app's Room › Outdoor vs bedroom chart read them (`source <> 'sim'` in the app). One `api_quota_log` row per API call.
- **App**: System › Tonight's plan › Away dates labels calendar trips "from calendar"; Remove works as for manual ones.

## Food camera (migration 0020)

Decided 2026-11-01: a photo of each meal gives calories and macros, logged to the person's Google Health.

- **App secrets in Vault.** `public.app_secret(name)` (definer body in `private`, service role only) reads
  `google_weather_api_key` or `gemini_api_key` from Vault; any other name is refused. `_shared/secrets.ts` prefers the
  function secret of the same purpose (`GOOGLE_WEATHER_API_KEY`, `GEMINI_API_KEY`) and caches the Vault value 10 min.
- **Photos**: private Storage bucket `meals` (15 MB, JPEG/PNG/WebP/HEIC), objects `<person_id>/<file>`. Household
  members read every photo; owners/members upload under their own person (the owner under anyone). The app uploads
  with the member's session, then calls food-photo.
- **`food-photo`** (member JWT; cron/service key must pass `personId`):
  `{photoPath, takenAt?, mealType?, personId?, note?}` → downloads the photo (service role), Gemini `generateContent`
  (`_shared/gemini.ts`; inline image, JSON output with core `FOOD_RESPONSE_SCHEMA`), core `parseFoodAnalysis` (clamped,
  totals = item sums), inserts `meals`, then writes a Google Health `nutrition-log` point (token narrowed to
  `nutrition.writeonly`). The Google write is best effort: `google_status` = `ok` / `pending` / `error` / `no_token` /
  `removed`, `google_error` holds the reason. The same `photoPath` twice returns the existing meal; no food → `422`.
  `{mealId, action}`: `regenerate` (Gemini again, row updated, Google point replaced), `hide` (`hidden = true`, Google
  point removed), `resync` (retry Google). Anonymous nutrition logs can't be edited, so a rewrite removes the old point
  first and writes `meal-<uuid>-2`, `-3` …; if the removal fails nothing new is written. Meal type defaults from the ICT
  clock (05–11 breakfast, 11–16 lunch, 17–22 dinner, else snack). One `api_quota_log` row (`api = 'gemini'`) per call.
- **`meals` RLS**: household read; insert/update by owners and members for their own person (owner: any), limited to
  the editable columns (model output and Google state are service-role only). No removal grants.
- **Camera stream**: `household_settings.camera_stream_url` (https only), set with `set_camera_stream_url(url)`
  (owner/member; null clears). The go2rtc URL comes from Erik's Mac.
- **App**: Body › Food (`/body/food`, `apps/web/lib/food.ts`) shrinks the photo to ≤1280 px JPEG, uploads it to
  `meals/<person>/<uuid>.jpg` and calls food-photo; System › Camera (`/settings/camera`) embeds
  `<camera_stream_url>/stream.html?src=living&mode=mse,hls` (a `src`/`mode` already in the URL is kept).

## Camera activity (camera-event, migration 0022)

Decided 2026-11-02: Erik's always-on Mac runs face recognition locally on the living-room camera (go2rtc stream
`living`), for **enrolled, consenting people only** (Cath = `a`, Erik = `b`; a guest only after they agree, under a
label of their choosing). It posts **labels only**: no image, face embedding or other biometric data ever reaches the
backend. A face that matches nobody is `unknown`; a body without a visible face is `person`.

**Request** (`verify_jwt = false`; the credential is any household person's presence token, System › Presence):
```
POST https://<project>.supabase.co/functions/v1/camera-event
X-Presence-Token: slp_<64 hex>        (or Authorization: Bearer slp_…)
Content-Type: application/json

{"camera":"living",                    optional, lower-case [a-z0-9 _-], ≤ 40 chars; default "living"
 "events":[                            1–100 per request (more → 400); oldest or newest first, either is fine
   {"ts":"2026-11-02T14:05:00+07:00",  required: ISO 8601 WITH Z or an offset, or epoch ms; within ±1 day of now
    "label":"b",                       required: "a" | "b" | "unknown" | "person" | a guest label
                                       (1–40 chars: letters, digits, space, . _ ' -; must start with a letter/digit)
    "confidence":0.91,                 optional, 0..1 (rounded to 3 decimals)
    "activity":"sofa",                 optional zone name, lower-case [a-z0-9 _-], ≤ 40 chars (desk, sofa, kitchen, dining)
    "durationS":120}]}                 optional integer seconds 0..86400 (also accepted: duration_s)

{"ping":true}                          token check only; stores nothing
```
**Responses**: `200 {"ok":true,"person":"b"}` (ping) · `200 {"ok":true,"person","received","stored","duplicates",
"rejected":[{"index","reason"}],"alert"}` (`alert`: null, `sent`, `someone_home`, `deduped` or `error`) · `400
{"error"}` (not an object, no `events` array, > 100 events, bad `camera`) · `401 {"error":"unauthorized"}` (missing,
malformed or unknown token) · `405` (not POST) · `500 {"error":"internal"}`. An invalid event is skipped and listed in
`rejected`; the rest are stored. `(camera, ts, label)` is unique, so retrying a batch is safe (`duplicates`).

- **Auth**: `presence_token_person(token)` (service role) returns the token's person without recording presence or
  touching the presence token's `last_used_at`, so the phones' Shortcut status stays readable. Since migration 0028 it
  also accepts device tokens, so the Mac should use its own (see "Device tokens (migration 0028)"); rotating a person's
  presence token then no longer breaks it.
- **Unknown-person push**: a newly stored `unknown` sighting at most 30 min old, while **nobody is home** (every
  person's latest phone signal is `away`, however old; a person with no signal counts as possibly home), sends one push
  "Unknown person seen at home (living room, HH:MM)" (ICT) to every subscription, opening System › Camera.
  `claim_camera_alert('unknown', 30)` makes it at most one per 30 min, also under concurrent uploads.
- **Core**: `camera/events.ts` (`parseCameraRequest`, `cameraEventRow`, `unknownToAlert`, `alertDue`,
  `unknownAlertText`); `_shared/presence.ts` `nobodyHome()`.
- **App**: System › Camera shows "Activity today" below the live view (`apps/web/lib/camera.ts`): today's rows (ICT),
  newest first, as time · Cath / Erik / guest label / Unknown person / Someone · zone · duration. Simulated mode shows
  sample sightings.

## Location (owntracks, migration 0023)

Decided 2026-11-02: both iPhones run the **OwnTracks** app (App Store) in HTTP mode. Each fix goes to
`public.locations`; the app's Map tab draws "now" and a timelapse from it, and fixes near home drive home/away for the
pre-cool gate, so the Shortcut automations become optional.

**Phone setup** (also in the app, System › Location): Settings → Mode **HTTP**; URL
`https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/owntracks`; Authentication **on**, UserID `cath` / `erik`
(informational only), Password = that person's presence token (System › Presence; the same `slp_…` token as the
Shortcut and the Mac, so rotating it means updating every place it is pasted); TrackerID `C` / `E`; Monitoring
**Significant** (battery-friendly) or **Move** (detailed trails). iOS Settings → OwnTracks → Location **Always** + Precise.

**Request** (`verify_jwt = false`; the presence token is the credential):
```
POST https://<project>.supabase.co/functions/v1/owntracks
Authorization: Basic base64(<user>:slp_<64 hex>)   (or X-Presence-Token: slp_… / Authorization: Bearer slp_…, for curl)
Content-Type: application/json

{"_type":"location","lat":7.88,"lon":98.39,"tst":1793606700,"acc":12,"alt":8,"vel":0,"cog":90,"batt":87,
 "conn":"w","SSID":"…","t":"u","inregions":["Home"]}              one message, or an array of messages
{"_type":"transition","event":"enter","desc":"Home","tst":…,"lat":…,"lon":…,"acc":30}
{"ping":true}                                                       token check only → {"ok":true,"person":"a"}
```
**Responses**: `200 [...]` (OwnTracks expects an array; anything else makes the phone queue and retry): for every
**other** person with a fix in the last 7 days a `{"_type":"card","tid":"E","topic":"owntracks/erik/E","name":"Erik"}` and their latest
`{"_type":"location","tid","topic","lat","lon","tst","acc","batt","conn"}`, so each phone shows the other as a friend
(Android keys friends by `tid`, iOS by `topic`) · `200 []`
when the request held only ignored messages (`waypoint(s)`, `lwt`, `status`, unknown types, unparseable JSON) · `401`
with `WWW-Authenticate: Basic realm="Sleep Lab"` (missing, malformed or unknown token) · `405` (not POST; GET answers
`{"ok":true,"hint"}`) · `413` (body > 256 KB: by Content-Length, and the body is read with a byte cap only after the token is checked, so a
chunked upload is never buffered whole) · `500` when storing the fixes failed (the phone keeps them and retries).

- **Validation** (core `location/owntracks.ts`): lat/lon must be finite and in range; `tst` (seconds) at most 1 day
  ahead and at most 400 days old; invalid messages are skipped and logged. Optional numbers out of range (OwnTracks
  sends −1 for unknown) are dropped. `(person_id, ts)` is unique: a retried queue stores nothing twice.
- **Transitions** (region monitoring) are stored as rows too: `event` = enter/leave, `note` = region name.
- **Home/away**: from the batch's newest message that says something and is ≤ 60 min old and newer than the person's
  latest presence event: a transition of a region named Home / thuis / huis / house (enter → home, leave → away; works
  without a home point), or a fix judged against the home circle (`household_settings.home_lat/home_lon/home_radius_m`,
  set in System › Location) by `homeState()`: home inside the radius with acc ≤ max(2 × radius, 250 m); away beyond
  radius + max(150 m, acc); in between, or acc > 1000 m, no change. `record_presence_for(person, state, 'owntracks')`
  stores it only when it differs from the latest state (per-person advisory lock, one statement), as `source 'shortcut'`
  (a phone signal for ac-curve's gate) with `via 'owntracks'`. `presence_events.source` keeps its 0009 check; the new
  `via` column (`shortcut | owntracks | wifi | test | manual`, null for older rows) says which signal it was.
  A failed presence update is logged; the response is still 200 (the fixes are stored).
- **Settings** (owners/members, RPCs returning the settings row): `set_home_location(lat, lon, radius_m = 150)` (null
  lat/lon clears home; radius 30..2000), `set_maps_browser_key(key)` (trimmed, `^[A-Za-z0-9_-]{20,100}$`, null/empty
  clears; a Google Maps JavaScript API key restricted by HTTP referrer to the site, readable by members because the
  browser needs it), `set_camera_ticket_required(bool)` (see Camera ticket).
- **Reading**: household members read `locations` under RLS (`(person_id, ts desc)` and `(ts desc)` indexes); rows are
  never removed.
- **Core**: `location/owntracks.ts` (`parseOwnTracks`, `locationRow`), `location/geo.ts` (`haversineM`, `homeState`,
  `isHomeRegion`, `positionAt`, `trackUpTo`, `togetherSpans`, `together`); `_shared/owntracks.ts` (`owntracksToken`,
  `presenceDecision`, `friendsResponse`). Tests: `packages/core/test/location.test.ts`, `tests/owntracks.test.ts`.

## Camera ticket (camera-ticket)

The go2rtc stream URL (`household_settings.camera_stream_url`) is a secret link: anyone who has it can watch. With
`household_settings.camera_ticket_required` on (System › Camera, "Require sign-in for the stream"), the app first asks
`camera-ticket` for a signed ticket and embeds `<camera_stream_url>/t/<encodeURIComponent(ticket)>/<path>` (e.g.
`…/t/<ticket>/stream.html?src=living&mode=mse,hls`); the Mac's ticket gate in front of go2rtc serves only requests whose
ticket verifies, strips the `/t/<ticket>` prefix and proxies the rest. Turn it on only after the gate runs.

```
GET  /functions/v1/camera-ticket       public, no auth (cache 5 min)
  → {"alg":"Ed25519","publicKey":"<base64url, raw 32 bytes, 43 chars>","format":"<b64url(payload)>.<b64url(sig)>",
     "payload":{"sub":"<user uuid>","exp":"<epoch s>","iat":"<epoch s>","aud":"camera"},"ttlS":43200}
POST /functions/v1/camera-ticket
  Authorization: Bearer <the signed-in user's Supabase access token>
  → 200 {"ticket":"…","exp":"2026-11-03T02:00:00.000Z","ttlS":43200}
    401 (no / invalid user token) · 403 (no public.household_members row; any role may watch)
```
The key pair is created on first use (WebCrypto Ed25519) and kept in `private.camera_ticket_key` (private half as a
JWK; `camera_ticket_key()` / `camera_ticket_key_init()`, service role; the first stored pair wins, so concurrent first
calls agree). The app refreshes a ticket when the quality changes or within 30 min of `exp`.

**Ticket format** (reference: `supabase/functions/_shared/ticket.ts`):
```
ticket = part1 + "." + part2
part1  = base64url_nopad( UTF-8 JSON {"sub":"<uuid>","iat":<int s>,"exp":<int s>,"aud":"camera"} )
part2  = base64url_nopad( Ed25519_sign(private_key, ASCII bytes of part1) )      64-byte signature, pure Ed25519
```
**Verify recipe for the Mac proxy** (fetch `publicKey` once from the GET above and pin it; it only changes if the
`private.camera_ticket_key` row is replaced):
1. URL-decode the path segment after `/t/`; refuse if longer than 1024 chars or not exactly two `.`-separated parts,
   each `[A-Za-z0-9_-]+`.
2. `sig = b64url_decode(part2)`; must be 64 bytes. Verify `sig` over the **ASCII bytes of part1 as received** with the
   32-byte public key (`b64url_decode(publicKey)`; e.g. Python `cryptography` `Ed25519PublicKey.from_public_bytes(pk)
   .verify(sig, part1.encode())`, Node `crypto.verify(null, Buffer.from(part1), crypto.createPublicKey({key: {kty: 'OKP', crv: 'Ed25519', x:
   publicKey}, format: 'jwk'}), sig)`, Go
   `ed25519.Verify(pk, []byte(part1), sig)`). Fail → 403.
3. `payload = JSON.parse(b64url_decode(part1))`; require `aud == "camera"`, `sub` a string, `exp > now_s` and
   `iat <= now_s + 300`. Fail → 403 (expired → the app fetches a new ticket on reload).
4. Proxy `/<rest of the path>?<query>` to go2rtc (including its WebSocket upgrades); never forward the ticket.

## Night sounds (night-sound, migration 0024)

Decided 2026-11-03: the live video is off. The SwitchBot Pan/Tilt Cam Plus 3K stands on Cath's bedside table (window
side), pointed at the wall; Erik snores the loudest. Erik's Mac only **listens, and only while the household sleeps**:
it asks `night-sound` every 60 s and runs its audio pipeline (ffmpeg on go2rtc's local RTSP stream, video dropped →
YAMNet AudioSet classifier, all on the Mac) only while the answer is `listen: true`. No continuous audio leaves the
Mac; it posts per-minute summaries and events, plus ~10 s clips of notable moments (never speech). The Tailscale Funnel
is off, so nothing is streamed publicly. Mac setup: `docs/mac-prompts/night-sound.md`.

**Listen window** = tonight's lights-out − 15 min → the aircon's scheduled OFF at wake + 30 min (`nights.lights_out` /
`nights.wake`, or the default schedule; the controller's "off (wake + 30 min)", core `OFF_AFTER_WAKE_MIN`). With the
22:00 / 08:30 defaults: **21:45 → 09:00 ICT**. Nights are keyed by the wake date (`nightDateFor`: from 12:00 ICT it is
tomorrow's night); between the OFF and 12:00 GET reports the coming night's window. `listen` is true only when also:
`household_settings.sound_mode = 'auto'`, `sound_paused_until` null or past, the night not away (ac-curve's
`nightAway`: "Away tonight" / travel tag / an away period covering tonight, unless "Home tonight"), and not everyone's
latest phone signal a fresh `away` (`everyoneAway`, as the pre-cool gate). Logic: `_shared/sound.ts` `listenDecision`.

```
GET  https://<project>.supabase.co/functions/v1/night-sound
X-Presence-Token: slp_<64 hex>            (any household person's presence token; or Authorization: Bearer slp_…)
→ {"listen":true,"reason":"Listening until 09:00","from":"2026-11-03T14:45:00.000Z","until":"2026-11-04T02:00:00.000Z",
   "clips":true,"clipsLeft":40,"night":"2026-11-04","now":"…"}
   reason: "Listening until 09:00" · "Off — starts 21:45" · "Paused until tomorrow 12:00" · "Away tonight" ·
   "Nobody home" · "Turned off in settings"

POST {"ping":true}                        → {"ok":true,"person":"b"}  (token check, stores nothing)
POST {"camera":"bedroom",                 optional slug, default "bedroom"
  "minutes":[{"ts":"2026-11-04T01:23:00+07:00","dbAvg":-52.1,"dbMax":-31.4,"dbFloor":-61.0,"snoreS":24,
              "snoreProb":0.41,"speechS":0,"coughS":0,"classes":{"Snoring":24,"Breathing":11,"Silence":20},"n":61}],
  "events":[{"ts":"2026-11-04T01:23:12.400+07:00","durationS":9.5,"kind":"snore","label":"Snoring","peakDb":-31.4,
             "score":0.62,"wantClip":true}]}
→ {"ok":true,"person":"b","received":{"minutes":1,"events":1},"stored":{"minutes":1,"events":1},
   "duplicates":{"minutes":0,"events":0},"dropped":{"outsideWindow":0,"notListening":0},"rejected":[],
   "uploads":[{"index":0,"path":"2026-11-04/20261103T182312.400Z_snore.m4a","signedUrl":"https://…/storage/v1/object/upload/sign/night-sounds/…?token=…","token":"…"}],
   "listen":true}
```
- **Validation** (core `sound/payload.ts` `parseSoundPayload`): ≤ 120 minutes and ≤ 100 events per request (more →
  400); ts ISO with a zone or epoch ms, at most 2 min ahead and 36 h old; dB clamped to −120..20 dBFS, seconds to 0..60,
  scores to 0..1; classes: top 5; minute ts floored to the minute; `kind` ∈ snore | loud | cough | speech | other.
  Invalid rows are skipped and listed in `rejected` (`{kind,index,reason}`).
- **Server-side privacy**: a row is stored only when its ts is inside **its own night's** listen window ± 5 min (a
  night without a `nights` row keeps nothing): others count in `dropped.outsideWindow`. While `sound_mode = 'off'` or
  paused, nothing is stored (`dropped.notListening`). Away nights are left to the Mac's GET (presence can be wrong).
- **Idempotent**: `sound_minutes` primary key `(camera, ts)`, `sound_events` unique `(camera, ts, kind)`, inserted with
  on conflict do nothing (`duplicates`).
- **Clips**: for a stored event with `wantClip`, `kind ≠ speech`, a label outside the speech classes (`SPEECH_LABELS` in
  core: Speech, Conversation, Shout, Yell, Whispering, Laughter, …), `ts` at most 10 min old (a re-sent outbox batch
  has no audio), `sound_clips` on, and fewer than 40 clips this night,
  the function reserves `clip_path` (object name in bucket `night-sounds`, **no bucket prefix**:
  `<night>/<YYYYMMDDTHHMMSS[.mmm]Z>_<kind>.m4a`) and returns a signed upload URL (`createSignedUploadUrl`, upsert, valid
  2 h). The Mac PUTs the m4a there: `curl -X PUT -H 'Content-Type: audio/mp4' --data-binary @clip.m4a "<signedUrl>"`
  (≤ 1 MB; the bucket takes audio/mp4, aac, mpeg, ogg, webm up to 2 MB). A retried batch gets a fresh URL for the same
  path. `clip_path` can point at a missing object when the upload failed; the app shows no player when the signed URL
  fails. `index` = position in the request's `events` array.
- **Retention**: on any authorised GET or POST (the Mac GETs every 60 s even while not listening), at most once an
  hour per worker, clips older than 14 days (up to 100 per run) are removed with the
  Storage API and their `clip_path` set to null. Minute and event rows stay (never removed by SQL); `hidden = true`
  takes an event out of the app (owners/members, like `camera_events`).
- **Settings** (owners/members; RPCs return the settings row): `set_sound_settings(p_mode 'auto'|'off', p_clips)` (null
  = keep), `pause_sound_until(p_until)` (null or past = resume; ≤ 7 days ahead; the app's "Pause tonight" passes the
  next 12:00 ICT), `set_live_video(p_on)` (`live_video`, default **false**: the Live tab hides the video player and
  fetches no ticket until it is turned back on in System › Camera).
- **Reading**: members read `sound_minutes` / `sound_events` under RLS (`(night_date, ts)` indexes) and clips with
  `storage.from('night-sounds').createSignedUrls(paths, 3600)`. Core `sound/summary.ts`: `nightSoundSummary`,
  `awakeningStarts` (Cath's awake runs after sleep onset from her stages) and `wakeTriggers` ("4 of your 6 wake-ups came
  within 2 min of snoring").
- **Tests**: `packages/core/test/sound.test.ts`, `supabase/functions/tests/night-sound.test.ts`.
- **Deploy**: apply `0024_night_sounds.sql`, deploy `night-sound` (`verify_jwt = false`, in `config.toml`). The
  living-room face recognition (`camera-event`) is retired on the Mac; `camera_events` is left as it is.

## Experiments (migration 0025)

Decided 2026-11-04 ("build experiments … but think bigger"). **Lab › Experiments** compares 2 (max 3) arms over
nights, randomised, and says which is better per outcome. Core: `packages/core/src/experiments` (CONTRACT.md
"experiments/"); engine: Edge Function `experiments` (`_shared/experiments.ts`); tables: `experiments`,
`experiment_nights`, `experiment_log`; `household_settings.autopilot`.

- **Kinds.** `auto` = Sleep Lab switches the arm: each arm is an aircon curve (`arms[].curve_id`); the engine sets
  `nights.curve_id` for the upcoming night (`experiment_apply_night`) between 12:00 ICT and lights-out − 45 min (the
  pre-cool starts at −30). ac-curve needs no change: it reads `nights.curve_id` (`loadCurve`) on every 5-min tick. A
  curve is only replaced when the night still has the **default curve or one of the arms' curves**: a curve chosen by
  hand (`set_night(p_curve_id)` or the dashboard) wins, and that night is marked not followed. `manual` = the household
  does it: at **20:30 ICT** (or lights-out − 30 min if earlier) one push to every phone, "Tonight's experiment: Door OPEN
  a crack" (claimed with `experiment_nights.notified_at`, so once per night); an arm's `tag` (only existing tags, e.g.
  `door_ajar`) is added to the night (recorded in `experiment_nights.applied_tag`; on a re-pin only that tag is taken
  off, tags set by hand stay; a night already carrying another arm's tag by hand is not followed); in the morning
  "Didn't follow" (`mark_experiment_night(…, false)`) takes the night out. If the 20:30 push reaches nobody (no keys, no
  subscriptions, every send failed) the claim is released and a later run retries until lights-out + 1 h.
- **Assignment** (core `assignArm`): balanced randomisation in blocks of (number of arms), order shuffled with
  `experiments.seed` and the block number, so it is reproducible. Away nights (`nightAway`: Away tonight / travel tag /
  away period) and, for aircon experiments, nights with `ac_enabled = false` get no assignment. A night that does not
  count (didn't follow, or no data for the primary outcome) repeats its slot the next night; a night computed without
  data but still inside the 2-day recompute period keeps its slot (pending), so a late sleep sync can't give two nights
  of one block the same arm. `pin_experiment_arm`
  pins a night by hand (replaces a random one; applied at once when the night row exists).
- **Outcomes** (core `nightOutcomes`, from 10:00 ICT once wake + 1 h has passed; recomputed every 2 h for 2 days for
  late syncs): Cath (a) and Erik (b) each from their main sleep's stages: sleep onset latency from lights-out, deep /
  REM / light minutes, awake minutes after onset, awakenings (awake runs ≥ 2 min after onset); room lights-out → wake:
  CO₂ mean and minutes > 1000 ppm, mean temperature (shown only), snoring minutes (`sound_minutes.snore_s ≥ 10`).
  **Sleep score** per person = (z(deep) + z(REM) − z(awake min) − z(awakenings)) / 4, z against the experiment's own
  nights; household `sleep_score` = mean of the two. Primary outcome of every template: `sleep_score`.
- **Verdict** (core `analyzeExperiment`): per outcome the arm means, challenger − control, a 90 % interval and
  P(challenger better) from the Welch t posterior (flat priors, unequal variances). Status: `running` until every arm
  has `min_per_arm` (4; Autopilot 6) counted nights, then `clear_winner` (P ≥ 0.9 either way on the primary),
  `leaning` (P ≥ 0.75) or `no_difference`. Stored in `experiments.analysis` (`{status, verdict, leader, winner, counts,
  counted, excluded, done, primary, line}`; `line` = "Experiment: door OPEN a crack (night 1 of ≥8)" for the coming
  night). At `max_nights` (21) counted nights the experiment finishes on its own. "Adopt winner"
  (`finish_experiment(id, true)`) makes an aircon arm's curve the default (`curves.is_default`; upcoming nights whose
  pre-cool has not started move with it, except curves chosen by hand). `undo_adoption()` (owner/member; "Undo: go back
  to …" under Autopilot) restores the curve before the newest adoption (one step).
- **Hand-chosen curves**: `nights.curve_source` (`user` | `experiment` | `default`, null = not recorded) — `set_night`
  with a curve records `user`; the engine never replaces it (that night is not followed) and adoptions / finishing leave
  it alone. In the morning an aircon night whose `nights.curve_id` is not its arm's curve (changed after it was applied)
  is marked not followed and logged; `mark_experiment_night(…, true)` refuses such a night. The decision log gets an
  `analysis` entry only when the status, verdict or counts change.
- **Autopilot** (off by default; `set_autopilot(true)`): when no aircon experiment runs, it starts the next candidate
  against the current default (core `AUTOPILOT_CANDIDATES`: `warm-late-19-5-quiet-v1`, `steady-19-5-quiet-v1`,
  `cool-early-warm-late-v1`, then the original `steady-18-5-quiet-v1` so it is re-tested after an adoption; each
  skipped once a *finished* test ran against that default — a test stopped by switching Autopilot off is retried), runs it (≥ 6 counted nights per arm), adopts it
  only when it is the clear winner on the sleep score **and** neither person's awakenings got worse (P(more) ≥ 0.75
  blocks it), else keeps the default, then moves on. Switching it off stops its running experiment (one started by hand is
  left alone). Every decision goes to `experiment_log` (kind `autopilot`; "nothing to do" only when its reason changes).
- **Curve variants** (core `EXPERIMENT_CURVES`, inserted with `is_default = false`): the default's shape (pre-cool −30
  fan auto, fan low from +30, minC 17, every phase from lights-out). The controller forbids warming while asleep only for
  emergencies and re-measured biases, not for a planned step (one-beep curves have one); the variants warm at most once,
  at lights-out + 300 min (03:00), after the deep-sleep window. Tests: every plan and every simulated controller command
  ≥ 17, emergencies only cool, warming only as that planned step (`packages/core/test/experiments.test.ts`).
- **RPCs** (owners/members): `create_experiment(p_title, p_kind, p_arms, p_primary = 'sleep_score', p_slug, p_notes,
  p_started_on = tomorrow's wake date, p_pin_tonight)` (one running experiment per kind: unique index; 2–3 arms with
  unique keys; auto arms need a known curve, manual arms an instruction) · `pin_experiment_arm(p_experiment, p_night,
  p_arm)` · `mark_experiment_night(p_experiment, p_night, p_followed)` · `finish_experiment(p_experiment, p_adopt =
  false, p_arm = winner)` · `set_autopilot(p_on)` · `undo_adoption()`. Service role only: `experiment_apply_night`, `experiment_finish(p_experiment,
  p_status 'finished'|'stopped', p_adopt_arm, p_reason)`, `adopt_default_curve(p_curve_id)`. Members read the tables.
- **Tonight (2026-11-04 evening)**: 0025 starts "Door: open a crack vs closed" (`door-open-vs-closed`, arms `closed` /
  `open` with tag `door_ajar`) with night 2026-11-05 pinned to `open`, unless a household experiment already exists.
- **Run by hand**: `curl -X POST …/functions/v1/experiments -H "x-cron-secret: $CRON_SECRET"` (or an owner/member JWT)
  → `{ok, morning: [...], autopilot: {action, reason}, tonight: [{experiment, night, arm, source, applied, pushed}]}`.
- **Tests**: `packages/core/test/experiments.test.ts`, `supabase/functions/tests/experiments.test.ts`.
- **Deploy**: apply `0025_experiments.sql`, deploy `experiments` (`verify_jwt = false`, in `config.toml`).

## Sleep onset (migration 0011)

Decided 2026-10-29: in bed at 22:00 every day, asleep around 23:00, up around 08:30.

- **Curve** `one-beep-v2` (`DEFAULT_CURVE`, the default since 0011): like one-beep-v1, but the sleep phases (deep, middle =
  the warming step, late, wake) carry `"anchor":"sleepOnset"` and count from the night's expected sleep onset. Tonight:
  ON 18 at 21:30, nothing at 22:00 or 23:00, the one command while asleep at onset + 4 h 30 = 03:30 (set 20), OFF at
  wake + 30 = 09:00. Nights stored with `one-beep-v1` / `default-v1` keep their curve and behave as before; 0011 moved
  upcoming nights still on one-beep-v1 (before their warming step) to v2.
- **`nights.sleep_onset`** (nullable; null = lights-out + 60 min; check: lights-out … +3 h). ac-curve passes it to the
  controller (`ControllerInput.sleepOnset`) and returns it (`"sleepOnset"`) with the curve id. `set_sleep_onset(date, ts|null)`
  (owner/member) sets it from the app.
- **Learning from the watches**: when ac-curve creates a night (`ensureNight`), `learnedSleepOnset` reads the last 30 days
  of real `sleep_sessions` and core `typicalSleepOnset`: per person the median onset (first non-awake stage) of the last
  14 main sleeps (≥ 3 h, starting 18:00–04:00; naps ignored; ≥ 3 nights needed), household = the **later** of the two
  medians (the room must stay cool until both are asleep), rounded to 5 min and clamped to lights-out … +3 h. No data →
  null → 23:00.
- **Default wake 08:30** everywhere a night is created (ac-curve, `set_presence_override`, `set_sleep_onset`, the PWA).

## Schedules (pg_cron runs in UTC; ICT = UTC+7)

| Job | Cron (UTC) | ICT | What |
|---|---|---|---|
| `sleeplab-poll-meter` | `* * * * *` | every minute | Meter status poll (backstop for the change-based webhook) |
| `sleeplab-ac-curve` | `*/5 * * * *` | every 5 min | Controller from precool (lights-out − 30 min with the default curve) to wake + 90 min. Outside that window, or when the night has `ac_enabled = false`, it only sends OFF if the assumed live state is still ON ("ensure off"). Failed live sends back off (20, 40, 60 min) |
| `sleeplab-health-sync-morning` | `20 0-2 * * *` | 07:20, 08:20, 09:20 | Google Health pulls after typical wake times |
| `sleeplab-nightly-report` | `*/15 0-7,23 * * *` | every 15 min, 06:00–14:45 | `{"auto":true}`: night analysis, then first report + push once wake + 45 min (09:15 with an 08:30 wake, after the aircon's OFF at 09:00) has passed and every connected person's sleep has synced (or at wake + 4 h), silent regenerate when late sleep data arrives, final silent regenerate after max(12:00, wake + 2 h) for the morning ACH. Tracked in `reports.pushed_at / people_count / final` |
| `sleeplab-health-sync-1030` | `30 3 * * *` | 10:30 | Late syncs and reprocessed stages |
| `sleeplab-health-sync-1400` | `0 7 * * *` | 14:00 | Afternoon backstop |
| `sleeplab-health-sync-queue` | `*/10 * * * *` | every 10 min | Drains webhook- and OAuth-queued jobs (no-op when empty); a fresh connection backfills 14 days here |
| `sleeplab-health-sync-hourly` | `45 * * * *` | every hour at :45 | Light pull (`hours: 6`, `sleepDays: 2`) that keeps `band_sync` fresh for the Presence page (migration 0015) |
| `sleeplab-calendar-sync` | `23 * * * *` | every hour at :23 | Both Google Calendars → household away nights (0018) |
| `sleeplab-weather-poll` | `7-59/15 * * * *` | :07, :22, :37, :52 | Outdoor temp/RH → `outdoor_readings` (0018) |
| `sleeplab-experiments` | `*/15 * * * *` | every 15 min | Experiments (0025): tonight's arm from 12:00, the 20:30 push, outcomes + verdict from 10:00, Autopilot |
| `sleeplab-housekeeping` | `17 20 * * *` | 03:17 | Prunes `cron.job_run_details` (7 d), `api_quota_log` (60 d), old jobs and OAuth states |

- **The report regenerates after late data** automatically (see `sleeplab-nightly-report`). To regenerate by hand, call `nightly-report` with `{"date": "YYYY-MM-DD"}` (no push unless `"push": true`). Owners and members can do it with their JWT for the last 7 days; `viewer` members are read-only everywhere (also in `set_night`). Scheduled callers use `x-cron-secret`.
- **Dry run vs live.** Dry-run commands never touch `ac_state` (the live assumed state) and don't count against the live nightly cap; the dry-run controller follows its own newest dry-run row. Reports and the PWA hide failed sends, and hide dry-run rows on nights that have live commands.
- **Each function can be run by hand** with a `CRON_SECRET` function secret you set yourself, or with the service key:
  ```sh
  curl -X POST https://<ref>.supabase.co/functions/v1/ac-curve -H "x-cron-secret: $CRON_SECRET" -d '{"dryRun":true}'
  curl -X POST https://<ref>.supabase.co/functions/v1/ac-curve -H "apikey: $SERVICE_KEY" -d '{"dryRun":true}'
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
2. **Register the webhook** (zero-touch; see [SwitchBot webhook](#switchbot-webhook)):
   ```sql
   select private.invoke_edge_function('switchbot-admin', '{"action":"register-webhook"}', 30000);
   -- a few seconds later:
   select status_code, content from net._http_response order by id desc limit 1;
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

### Google Cloud setup (once, about 15 minutes, on a laptop)

1. **Project.** Go to https://console.cloud.google.com/ › project picker › **New project**, name it `sleep-lab`, **Create**, and select it.
2. **Enable the API.** **APIs & Services › Library**, search **Google Health API**, open it, **Enable**.
3. **OAuth consent screen** (**APIs & Services › OAuth consent screen**, called **Google Auth Platform** in the newer console):
   - **Get started** / **Branding**: app name `Sleep Lab`, user support email `cath.tunti@gmail.com`, developer contact `cath.tunti@gmail.com`.
   - **Audience**: user type **External**.
   - **Audience › Test users › Add users**: `cath.tunti@gmail.com` and `verspui@gmail.com` (or whichever Google accounts carry the Fitbit/Google Health profiles).
   - **Data Access › Add or remove scopes** › *Manually add scopes*: paste these and **Add to table**, **Update**, **Save**:
     `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
     `https://www.googleapis.com/auth/googlehealth.sleep.readonly`
     `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`
     `https://www.googleapis.com/auth/googlehealth.settings.readonly` (paired devices: the band's last sync time)
     `https://www.googleapis.com/auth/googlehealth.ecg.readonly`
     `https://www.googleapis.com/auth/googlehealth.irn.readonly`
     `https://www.googleapis.com/auth/googlehealth.location.readonly` (exercise GPS)
     `https://www.googleapis.com/auth/googlehealth.profile.readonly`
     `https://www.googleapis.com/auth/googlehealth.nutrition.writeonly` (food-photo meals → nutrition-log)
     `https://www.googleapis.com/auth/calendar.events.readonly` (trips → away nights)
     `https://www.googleapis.com/auth/youtube.force-ssl` (24/7 bedroom live stream; only the channel owner's grant is used)
     Also enable the **Google Calendar API** and **YouTube Data API v3** in the project.
   - **Audience › Publishing status › Publish app** › Confirm, so the status reads **In production**. Do not submit for verification. In Testing, refresh tokens expire after 7 days; in production (unverified, ≤ 100 users) they last until revoked. Each person sees "Google hasn't verified this app" once: **Advanced › Go to Sleep Lab (unsafe)**.
4. **OAuth client.** **APIs & Services › Credentials › Create credentials › OAuth client ID** (or **Clients › Create client**):
   - Application type **Web application**, name `sleep-lab-supabase`.
   - **Authorized redirect URIs › Add URI**, exactly:
     `https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/google-oauth/callback`
     (in general `https://<ref>.supabase.co/functions/v1/google-oauth/callback`, or `<PUBLIC_FUNCTIONS_URL>/google-oauth/callback`). No JavaScript origins are needed.
   - **Create**, then copy the **Client ID** and **Client secret** (the secret is shown once; download the JSON if offered).
5. **Supabase secrets.** https://supabase.com/dashboard/project/vaelokyqjdsxveqvdtbo/functions/secrets › **Add new secret**:
   - `GOOGLE_CLIENT_ID` = the client ID (`…apps.googleusercontent.com`)
   - `GOOGLE_CLIENT_SECRET` = the client secret (`GOCSPX-…`)
   - optional `APP_URL` = the PWA origin you use on the phones (default `https://sleep-lab-git-claude-determined-ride-59txro-evhg.vercel.app`).
   Secrets apply to the next call; nothing needs redeploying.
6. **Each person, on their own phone:** make sure the Google Health (Fitbit) app is signed in with the same Google account, then open the PWA signed in as themselves › **System › Google Health › Connect Google Health** › pick the Google account › Advanced › Go to Sleep Lab › tick all three permissions › Continue. The app comes back to the same page with "Connected". The 14-day backfill arrives within about 10 minutes (queue job); **Sync now** pulls the last 36 h at once.

### How connecting works

1. **Start (`POST /google-oauth/start`).** The PWA sends `Authorization: Bearer <the user's Supabase access token>`. The function verifies it with the service client (`auth.getUser`), reads `household_members` (owner/member only; viewers get 403) and binds a single-use `oauth_states` row to that user's `person_id`. The owner may pass `{"person":"b"}` to connect someone else. It returns `{url}` (Google consent with `access_type=offline`, `prompt=consent`, the Health, Calendar and YouTube scopes and the user's email as `login_hint`) and the PWA navigates there.
   - The legacy `GET /start?person=a&key=<OAUTH_START_SECRET>` link works only while `OAUTH_START_SECRET` is set.
2. **Callback.** Consumes the state (15 min TTL), exchanges the code, stores the refresh token in Vault (`store_google_refresh_token`), records `healthUserId` when `/users/me/identity` answers, queues a 14-day backfill job, and redirects to `<APP_URL>/settings/health?google=connected&person=a` (`&profile=missing` when the account has no Google Health profile yet). Failures redirect with `google=error&reason=denied|expired|exchange|no_refresh_token|store|no_code`; the page shows a sentence for each.
3. **Sync now.** `POST /google-health-sync` with the member's bearer token runs a full sync of every connected person, at most once per 2 min per person (`band_sync.last_manual_sync_at`, claimed atomically); otherwise `429`. `409` when nobody is connected yet.

3. **Webhook subscriber** (optional; the three daily pulls work without it).
   - Create a subscriber on the project **number** with `POST https://health.googleapis.com/v4/projects/<number>/subscribers?subscriberId=sleep-lab`.
   - Set `endpointUri` to `https://<ref>.supabase.co/functions/v1/google-health-webhook`.
   - Set `endpointAuthorization.secret` to the value of `GOOGLE_HEALTH_WEBHOOK_SECRET`.
   - In `subscriberConfigs`, list `sleep`, `heart-rate`, `heart-rate-variability`, `respiratory-rate-sleep-summary` and the `daily-*` types, with `subscriptionCreatePolicy: AUTOMATIC`.
   - The function answers the verification POSTs (200 when authorized, 401 when not) and replies **204** to notifications, then queues and triggers a sync. Check the field names against the live docs when creating it (`docs/research/health-data.md` §2.7).
4. **What a sync pulls, per person:**
   - The last 36 h of `heart-rate`, `heart-rate-variability` and `oxygen-saturation` (`dataSourceFamily=google-wearables`).
   - The last 7 days of `sleep` (filtered on `end_time`), `respiratory-rate-sleep-summary` and the `daily-*` types (resting HR, daily HRV, SpO₂, respiratory rate, sleep temperature derivations).
   - `steps` from local midnight at the start of that window (whole ICT days, into `health_vitals_daily.steps`).
   - Everything returned is appended to `raw_health` before parsing; derived rows go to `health_hr`, `health_hrv`, `health_spo2`, `sleep_sessions`, `health_daily` and `health_vitals_daily` (steps, resting HR, daily HRV).
   - `GET /users/me/pairedDevices` (best effort: it may need a scope the app doesn't request; a 403 is logged in `band_sync.last_error` and not fatal).
   - Afterwards `band_sync` gets the run's outcome, `device_last_sync_at` (newest `lastSyncTime`) and `newest_point_at` (newest heart-rate/HRV/SpO₂/steps point). Both only move forward.
5. **Presence hint (not a gate).** `public.band_sync` is the place a presence gate can read later: `greatest(device_last_sync_at, newest_point_at)` per person is when the band last reached Google through its phone. It says nothing about where the phone was, and Fitbit data isn't live overnight, so nothing switches the aircon on it today; System › Presence shows it as "Fitbit bands (hint only)".

### Meter data rules

- **CO₂ warm-up artifact.** After a restart or hub reconnect the Meter Pro reports 0 ppm for a while. `parseMeterStatus` / `parseWebhookEvent` treat CO₂ < 300 ppm (`CO2_PLAUSIBLE_MIN`) as implausible: with `{co2Fallback}` (the device's newest plausible CO₂ from the last 30 min, `_shared/readings.ts`) the row keeps temp/RH with that CO₂, otherwise the sample is skipped (`readings.co2` stays NOT NULL). The metrics (`toMinuteGrid`, room metrics, CO₂ fits and forecasts) also ignore CO₂ < 300 in rows already stored.
- **Webhook wins.** `poll-meter` inserts with `ON CONFLICT DO NOTHING`, so a webhook row for the same minute keeps its values and `source = 'webhook'`; a webhook arriving after the poll still replaces the poll row.
- **Split nights.** `typicalSleepOnset` first merges a person's sessions less than 2 h apart (Fitbit sometimes splits one night around a long awakening), except a short doze (< 90 min) an hour or more before bed, then takes the first non-awake start.

## Night analysis (migration 0016)

Every `nightly-report` run first analyses the night (`_shared/analysis.ts`, `analyzeNight`); `{"analyzeOnly": true, "date"?: …}`
runs only that step (default: the night that ended most recently; cron/service callers may pass `"dates": [...]`, ≤ 31).

1. **Load** the meter's 1-minute readings from lights-out − 2 h to max(12:00, wake + 2 h). The meter id is `METER_DEVICE_ID`
   or, when unset, the meter `poll-meter` discovered (`devices` table).
2. **Clean** (core `cleanRoomReadings`): a run of identical temperature + RH longer than 30 min is dropped when CO₂ moved
   ≥ 25 ppm meanwhile (`temp_rh`: the cloud froze T/RH while CO₂ moved, e.g. 2026-10-29 21:02–22:22) or when CO₂ is
   identical too (`all`: a cached snapshot, e.g. the hub offline on 2026-10-30 from 09:08). Identical T/RH with only CO₂
   noise (an empty stable room) is kept. Missing stretches > 5 min are gaps. CO₂ < 300 ppm rows stay (temp/RH count) and are
   counted; every metric ignores that CO₂.
3. **Detect** events (core `detectEvents`) on the cleaned readings and replace the night's `source = 'detector'` events.
4. **Metrics**: core `roomNightMetrics` (lights-out → wake) and the morning decay "after both left" (core `fitDecayAch`
   from the start of a detected `room_empty` that begins after wake − 60 min, else from wake, to the window end).
5. **Store** one `night_metrics` row (upsert on `date`; idempotent): the metric columns, `ach_morning` / `ach_r2` /
   `ach_baseline_ppm` / `decay_start` / `decay_end` / `decay_from` (`room_empty` | `wake`), the data-quality columns and
   `flags` = the cleaning flags (`frozen_temp_rh`, `frozen_all`, `gap_evening`, `gap_overnight`, `gap_morning`,
   `low_coverage` < 80 %, `no_room_data`, `invalid_co2`) plus `no_morning_decay`, `manual_night` (no live aircon command
   reached the AC) and `no_health_data` (no sleep session yet; everything is room-only until Google Health syncs, then the
   same run includes the people automatically).

The report is built from the cleaned night; a one-sentence **data note** ("temperature and humidity were frozen 21:02–22:22
and were left out; no morning ventilation estimate …; clean readings cover 96.3 % …") becomes the last insight, and the
Claude facts carry the same `dataQuality` object so the rewrite mentions it and never treats excluded periods as measured.

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
- **Keys (zero-touch, 0016).** The first push (or `GET /functions/v1/push-admin`) generates a P-256 key pair with WebCrypto
  and stores it in Vault (`vapid_public_key`, `vapid_private_key`) through `store_vapid_keys()` (service_role only; never
  overwrites; concurrent creators serialised by an advisory lock). `vapid_keys()` (service_role only) reads them back, so
  the private key never leaves the database / functions. The public key is copied to `household_settings.vapid_public_key`.
- **Public key for the PWA.** Either `GET https://<ref>.supabase.co/functions/v1/push-admin` (no auth, CORS open,
  `{"publicKey":"<base64url>"}`, cached 5 min) or `select vapid_public_key from household_settings` (members). Use it as
  `applicationServerKey`; `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is no longer needed.
- **push-admin** (`x-cron-secret` / service key): `{"action":"status"}` (public key, subject, subscription count),
  `{"action":"ensure-keys"}`, `{"action":"test","title"?,"body"?}` (a test notification to every subscription).
- **Payload format.** Every subscription gets a Declarative Web Push message: `{"web_push": 8030, "notification": {"title", "body", "navigate": "<APP_URL>/?date=<date>", "tag"}}`; the PWA opens that night from `?date=`. iOS 18.4+ Home Screen apps show it without the service worker; `public/sw.js` handles the same JSON in its `push` event for older clients.
- **Subscribing.** System tab → "Morning report notifications" (Supabase source, signed in) asks for permission and calls `register_push_subscription` with the public key above.
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
- **Bulk writes** (`upsertChunks`): at most 500 rows and about 1 MB of JSON per statement (`_shared/chunks.ts`), so a 48 h heart-rate batch no longer runs into the statement timeout.
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

- Migrations 0001 and 0005 have run against Postgres 17 on the live project. 0002–0004 are written but were not yet applied when this was last updated; see [Deployment status](#deployment-status).
- The real email-code / magic-link round trip hasn't been exercised end to end (only the refusal of an uninvited address against the live project, and the signed-in screens with a mocked session).
- The Google Health filters for `daily-*` (`<type>.date >= "YYYY-MM-DD"`) and `respiratory-rate-sleep-summary` aren't confirmed. On a 400 the sync falls back to the newest page without a filter. `respRate` and `tempDeviationC` are read from the stored payloads by field name (`breathsPerMinute`, `nightlyTemperatureCelsius` − `baselineTemperatureCelsius`).
- Webhook signature verification is best effort, so the default is `log`. The `Authorization` secret is always enforced.
- `ac-curve` uses the night's scheduled lights-out and wake times (or the defaults). Detected in-bed times don't move the curve yet.
- Edge Functions have a 2 s CPU limit. A 14-day Google backfill at 1 Hz heart rate parses tens of thousands of points in one invocation. If it hits the limit, call `google-health-sync` with smaller `hours` windows.

## Deployment status

Live project `sleep-lab` (ref `vaelokyqjdsxveqvdtbo`, region `ap-southeast-1`, URL `https://vaelokyqjdsxveqvdtbo.supabase.co`), as of 2026-10-29:

| Item | State |
|---|---|
| `0001_init` | Applied |
| `0005_household_claims`, `0006_household_claims_policy` | Applied (people `a` = You, `b` = Erik; claim codes). Independent of 0002–0004, so it was applied first; claim → membership → RLS verified in a rolled-back transaction |
| `0002_cron`, `0003_health_vitals`, `0004_security_hardening` | **Pending.** The MCP `apply_migration` call for 0002 needs an interactive confirmation (its housekeeping job contains `delete` statements) that wasn't answered. Apply them in order with `apply_migration` (names = file names) or paste each file into the SQL editor |
| Vault `project_url` | Created |
| Vault `cron_secret` | Created by 0002 when it runs |
| pg_cron jobs | None until 0002 runs; then the eight `sleeplab-*` jobs in [Schedules](#schedules-pg_cron-runs-in-utc-ict--utc7) |
| `0008_switchbot_webhook_secret` | Applied 2026-10-29: Vault `switchbot_webhook_secret` + the two service_role-only RPCs. The SwitchBot webhook was registered by `switchbot-admin` the same day (enabled, `deviceList: ALL`) |
| Edge Functions | All 8 deployed with `verify_jwt = false`: `switchbot-webhook`, `switchbot-admin`, `poll-meter`, `ac-curve`, `google-health-sync`, `google-health-webhook`, `google-oauth`, `nightly-report`. They reject unauthenticated calls and answer "not configured" until their secrets exist; `ac-curve` is live since 2026-10-30 (`household_settings.ac_live = true`, migration 0014; `DRY_RUN` unset) |
| Function secrets | None set yet (see [Secrets](#secrets)) |
| Auth settings | **Manual** (see [Household and sign-in](#household-and-sign-in)) |
| Vercel env | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` set for production, preview and development |
| Data | No readings, nights or simulated rows in the live database; the PWA shows the simulator until real data arrives (Automatic mode) |

Until 0002 is applied, cron isn't scheduled and `x-cron-secret` requests are rejected (the `verify_cron_secret` RPC doesn't exist yet), so the functions only accept the service key.

**Public endpoints of the live project**

| What | URL |
|---|---|
| Google OAuth redirect URI (Google Cloud console) | `https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/google-oauth/callback` |
| Google OAuth start | `POST https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/google-oauth/start` with the member's bearer token (the PWA's Connect button) |
| SwitchBot webhook (registered by `switchbot-admin`) | `https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/switchbot-webhook/<vault switchbot_webhook_secret>` |
| Google Health subscriber endpoint | `https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/google-health-webhook` |

**Night analysis + Web Push keys (2026-10-30 evening).** Migration `0016_night_metrics_vapid` applied (`night_metrics`,
`household_settings.vapid_public_key`, `store_vapid_keys()` / `vapid_keys()`). `push-admin` deployed (new, `verify_jwt =
false`); `nightly-report` v5 deployed as one esbuild bundle. VAPID keys generated in Vault; public key
`BMDsv8jPKC18m5qiWBhXpUCwX8NKWXYBpf8ElPSM1zssGbxOCRMdBcJrgwp35hMvivs_cUrRVT1J6bUZIQ1f-EM`. Night 2026-10-30 analysed and
reported (rules; no `ANTHROPIC_API_KEY`): Sleep Air 73, CO₂ mean 863 / max 940 ppm, 18.88 °C, RH 54.3 %, coverage 96.3 %,
no morning ACH (meter frozen from 09:08). A push end-to-end test against a 410 endpoint encrypted, signed and removed the
subscription. `ac-curve` still runs the previous bundle (its pre-cool push reads `VAPID_*` secrets, which are unset → skipped)
until it is redeployed.

**Google Health (2026-10-30).** `google-oauth` accepts the signed-in member's token (`POST /start`, see [How connecting works](#how-connecting-works)); the old `?access_token=` mismatch is gone. Migration `0015_band_sync` is applied (table + hourly sync job). Waiting on the user: the Google Cloud project and the `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` secrets ([Google Cloud setup](#google-cloud-setup-once-about-15-minutes-on-a-laptop)).

**Calendar trips + weather (2026-10-31, not deployed).** Migration `0018_calendar_trips_weather` and the new functions
`calendar-sync` and `weather-poll` (`verify_jwt = false`) are written but not applied / deployed. `google-health-sync`
now gets its token through `_shared/google.ts` (same behaviour); redeploy it with the others. `GOOGLE_WEATHER_API_KEY`
is not set (Open-Meteo until then).

**Camera activity (2026-11-02, not deployed).** Migration `0022_camera_events` and the new function `camera-event`
(`verify_jwt = false`) are written but not applied / deployed.

### 2026-10-30 evening fixes (nightly-report v6, migration 0017)

- **Manual nights** (no live `ac_commands`): `Night.manual` is set by `loadNight` / the analysis and by the web app; core
  `scoringCurve()` then scores temperature against the steady 18.5 °C comfort target (`manualComfortCurve()`, in-band =
  ±0.75 °C), not the stored plan. Driver labels say "comfort band", and the report adds a "run by hand" insight. The
  first-4-h insight no longer says "tracked the curve".
- **Late sleep data**: `shouldRun()` regenerates (silently) whenever more people have synced sleep than the stored
  report has, even if the report is already final. The report cron now runs every 15 min from 06:00 to 18:45 ICT.
- **Overnight ACH**: core `plateauAch()` (last 90 min before wake; `plateau` if the trend is under 5 ppm/h, otherwise
  `upper_bound`) is stored as `night_metrics.ach_plateau{,_kind,_ppm}`. The occupancy detector's mass balance uses the
  same value, and so does the app.
- **Shower detail**: peak RH and temperature bump are measured within 15 min of onset, and measurement stops once the
  temperature has climbed for more than 3 min.
- **frozen_all**: a stretch where all three values repeat is now dropped only when it lasts more than 60 min and has no
  webhook row after its first row.

## Alerts (migration 0026)

Phone pushes from the app instead of an hourly chat check. Function `alerts` (`verify_jwt = false`; pg_cron job
`sleeplab-alerts` at xx:05/20/35/50, just after the hourly band sync at xx:45; an owner/member may also call it,
`{"dry":true}` returns the decisions without sending). Decisions are pure in core `src/alerts` (see CONTRACT.md).

| Alert | When | Once per | Hours (ICT) | To |
|---|---|---|---|---|
| Fitbit battery: "Charge your Fitbit before bed — 18 %, about 14 h left" | < 24 h left, or ≤ 15 % (≤ 20 % while the drain rate is unknown) | discharge cycle | 08:00–21:30 (a night crossing goes out at 08:00) | that person + owner |
| Not syncing: "Erik’s Fitbit hasn’t synced since 14:20 — open the Fitbit app" | band last reached Google > 6 h ago while `google-health-sync` ran in the last 2 h and succeeded (`last_sync_ok` not false: a failing server sync, e.g. expired Google sign-in, is not the band) | gap (the "last seen" time) | 08:00–22:00 | that person + owner |
| Night listener: "Night listener stopped at 01:43 — check Erik’s Mac" | `night-sound` says listen (same `currentListen`), but no `sound_minutes` for 10 min, counted from no earlier than when listening (re)started (after a pause or a late arrival; `alert_state` key `listener_watch`) | night | the listen window | every member |

- **Battery history**: `public.battery_log (person_id, ts, level)`, filled by the trigger `band_sync_battery_log`
  (AFTER INSERT OR UPDATE on `band_sync`): the TRACKER's `batteryLevel` in `devices`, stamped with its `lastSyncTime`
  (else `device_last_sync_at`); `on conflict do nothing`, and the trigger never fails the band_sync write. Drain rate =
  least-squares slope over the current discharge cycle (readings since the last rise of ≥ 3 points), once it spans 3 h.
  The function reads 14 days so the cycle start (the dedupe id) stays stable.
- **Dedupe**: `public.alert_state (key, last_sent_at, data)`, keys `battery:<person>`, `stale:<person>`, `listener` (plus `listener_watch`, the start of the current listen stretch, not an alert). It is
  written only after at least one push went out, so an alert nobody could receive is retried on the next run.
- **Recipients**: `push_subscriptions.user_id` → `household_members`. `_shared/push.ts` `pushToAll(…, { userIds })`
  limits a push to those users (omitted = everyone, as before).
- **Settings**: `household_settings.alerts` jsonb `{"battery":true,"stale_sync":true,"listener":true}` (missing = on);
  `set_alerts(p jsonb)` merges booleans for those three keys (owner/member; definer in `private`, invoker wrapper).
- **Optional secret**: `LISTENER_MAC_PERSON` (default `b`): whose Mac the listener message names.
- **App**: System › Alerts (`/settings/alerts`): the three switches, each band's "83 %, ~5 days left", the last push of
  each kind, and this device's push switch (the same subscription as the morning report).
- **Deploy**: apply `0026_alerts.sql`, deploy `alerts`, and redeploy every function that imports `_shared/push.ts`
  (`ac-curve`, `nightly-report`, `push-admin`, `camera-event`, `experiments`) only when convenient (the change is backwards compatible).

## Device tokens (migration 0028)

Added 2026-11-04 after rotating Erik's presence token for his phone's OwnTracks stopped the Mac's night listener, which
used the same token. Any device that acts for a person now gets its own token.

- **Table** `private.device_tokens (id, person_id, label 1–60 chars, kind 'listener' | 'phone' | 'device', token_hash
  unique, created_at, created_by, last_used_at, revoked_at)`: RLS on, no access for anon/authenticated (definer
  functions only), service_role all. Only the SHA-256 (`private.presence_token_hash`) is stored. Revoking sets
  `revoked_at`; rows are kept and listed as Revoked.
- **Format**: the same as presence tokens, `slp_` + 64 hex (256 random bits), so `PRESENCE_TOKEN` in
  `_shared/presence.ts`, the token parsing of every function and all clients are unchanged.
- **Resolution**: `presence_token_person(token)` (camera-event, night-sound) returns the person of a presence token,
  else of a non-revoked device token of any kind, and sets that device token's `last_used_at` (at most once a minute).
  Now `volatile` (it writes); name, argument and return type are unchanged. New `presence_token_person_kinds(token,
  kinds text[])` (service_role) does the same but accepts only device tokens of the listed kinds (null = any);
  owntracks calls it with `{phone,device}` (`owntracksPerson` in `_shared/owntracks.ts`, falling back to
  `presence_token_person` while 0028 is not applied). `record_presence(token, state, source)` (the `presence` function)
  also accepts non-revoked device tokens of kind `phone` or `device` (e.g. a second phone's Shortcut). So a `listener`
  token is refused by `presence` and owntracks (401: no home/away, no locations) and accepted only by night-sound and
  camera-event. `source` / `via` are unchanged.
- **RPCs** (definer in `private`, invoker wrapper in `public`, `authenticated`):
  `create_device_token(person, label, kind default 'listener') → (id, token)` returns the plain token once;
  `revoke_device_token(id) → boolean` (true when this call revoked it); both need an owner/member role and the own
  person (`household_members.person_id`) unless household owner, the same rule as `rotate_presence_token` (0010).
  `list_device_tokens() → (id, person_id, label, kind, created_at, last_used_at, revoked_at)` for any household member,
  never the hash.
- **App**: System › Presence › Other devices (`/settings/presence#devices`, `apps/web/lib/device-tokens.ts`): each token
  with its label, whose it is, last use and Working / Waiting / Revoked, Revoke (with a confirm step), and "New device
  token" (name default "Night listener (Erik’s Mac)", person default Erik, kind Night listener / Phone / Other). After
  creating, the token is shown once with Copy buttons; for a night listener also the line to paste into the Mac
  session. Before the migration the group says so; signed out / simulator shows a sample row. System › Camera's night
  sounds group links to it ("Night listener token").
- **Deploy**: apply `0028_device_tokens.sql`, then redeploy `owntracks` (the only function that changed; it works
  before and after the migration, so the order does not matter). The others call the same RPCs as before. Then create
  a Night listener token for Erik in System › Presence › Other devices and paste it on the Mac
  (`~/sleep-lab-home/night-sound/token`, 0600); from then on the phone's token can be rotated freely.

## Sleep talk (migration 0029)

Added 2026-11-05 at Cath's request ("save clips of sleep talk, and send in the morning summary"); both household
members agreed to the bedroom recording. Until now speech was never clipped. Now, with **"Save sleep talk"** on
(`household_settings.sound_sleeptalk`, default true; it also needs `sound_clips` on), speech is clipped and transcribed
on the Mac. Talking while both of us were awake (a conversation) is removed the next morning.

- **Schema** (`0029_sleep_talk.sql`). `sound_events` gets these columns:
  - `transcript` (≤ 2000 chars);
  - `transcript_lang` (≤ 10);
  - `sleep_talk` (null = not judged yet, true = someone asleep, false = both awake);
  - `talker_hint` (`a` | `b`: the only person asleep at that moment);
  - `judged_at`.

  It also adds the partial index `sound_events_speech_unjudged`, and `household_settings.sound_sleeptalk` with
  `set_sound_sleeptalk(p_on)` (owner/member; definer in `private`, invoker wrapper in `public`). The grants are
  unchanged: members read, and only the service role writes the new columns.
- **night-sound** (core `clipAllowed(e, now, { speech })`, `isSpeechEvent`, `applyTranscriptPolicy`):
  - Speech events are kind `speech`, or carry a speech-class label (a `loud` event labelled `Shout` included).
  - With sleep talk and clips on, they get upload URLs from a **separate allowance of 20 a night**
    (`SOUND_SPEECH_CLIPS_PER_NIGHT`), on top of the 40. Each upload says `maxS: 30` for speech and 10 otherwise.
  - Events may carry `transcript` (string, ≤ 2000, whitespace collapsed) and `transcriptLang` (≤ 10, e.g. `en`, `nl`,
    `th`). These are stored only for speech events and only with sleep talk on; otherwise they are dropped before
    anything is written.
  - The GET answer adds `sleepTalk` and `speechClipsLeft`; the POST answer adds `sleepTalk`. All other privacy rules
    stay: only inside the listen window, not while off or paused, no clip for events older than 10 min, 14-day
    retention.
  - Before 0029 the function reads `household_settings` with `select('*')`, so the missing column means "off" and
    nothing breaks.
- **Morning judge** (`_shared/sleeptalk.ts`, run by `nightly-report`):
  - **Why nightly-report.** Its cron job runs every 15 min from 06:00 to 18:45 ICT (0017), after the morning health
    syncs, and it already decides the morning push.
  - **When it runs.** On every `{auto:true}` run it first judges the unjudged speech events of the night and of the
    night before, each against both people's `sleep_sessions` for that night (`end_ts` in 18:00 → 14:00 ICT, the
    same as `shouldRun`). Only speech events with a clip or a transcript are judged (one without either keeps nothing
    to delete or show). They are read with that filter in SQL and in pages of 500, so a night full of snoring events
    can never push speech events out of the read.
  - **The verdict** (core `judgeSleepTalk`, pure):
    - If anyone's sessions are missing, the event stays pending, until 13:00 ICT on the night's date
      (`sleepTalkFinal`). From then on a person with no data counts as awake: privacy first.
    - A person counts as asleep when a non-awake stage overlaps the event ± 1 min (`SLEEPTALK_TOLERANCE_MS`), or the
      event falls inside a session that has no stage there.
    - At least one person asleep → `sleep_talk = true`, and `talker_hint` = that person when exactly one was asleep
      and both people's data is known.
    - Otherwise it was a conversation: at once `sleep_talk = false` and `transcript`, `transcript_lang` and
      `talker_hint` are set to null; the app never plays a `sleep_talk = false` clip. The clip object is removed
      (`storage.from('night-sounds').remove()`, then `clip_path = null`) once the row is at least 2 h 30 min old
      (`UPLOAD_GRACE_MS`): the signed upload URL night-sound handed the Mac lasts 2 h (re-issued for a re-sent batch up
      to 10 min after the event), and removing the object before a late upload would leave that audio in the bucket
      with nothing pointing at it. Every judge run does this removal step; a failed removal keeps `clip_path` and is
      retried.
  - The judge never blocks the report. Errors land in the response's `sleepTalk`.
- **Morning push.**
  - When the morning report push goes out (`shouldRun` push) and the night is fully judged, its body gets a second
    line from core `sleepTalkLine`: `Sleep talk: 2 clips (01:12 Cath?, 03:40) — tap to listen. “first snippet ≤ 80
    chars”`. The link is Today (`/?date=<night>`). The line is recorded in `alert_state` key `sleeptalk` (`data.night`).
  - If the report went out before the judging finished (e.g. at wake + 4 h while a band hadn't synced), a separate
    push **"Sleep talk from last night"** (tag `sleeptalk-<night>`, link `/?date=<night>#sounds`) follows once per
    night, as soon as nothing is pending and there is sleep talk. The dedupe uses the same `alert_state` key.
  - It counts the same moments Today › Sleep talk lists (speech with a clip or a transcript, not a conversation),
    so the push never says more clips than the app shows.
  - No sleep talk → no line and no push. With "Save sleep talk" off there is never a line or a sleep-talk push (the
    judge still runs, so conversations recorded earlier are still removed).
- **App.**
  - Today › Snoring & noise: a "Sleep talk" list (time, "probably Cath/Erik", the transcript in quotes, the clip
    player from a 1-h signed URL); unjudged ones carry a note. Empty state: "No sleep talk last night".
  - Live › Latest moments: speech clips show who probably said it and the transcript.
  - System › Camera: the "Save sleep talk" switch, with "Clips where you were both awake are deleted the next morning."
  - The simulator adds two sample sleep-talk moments to each night.
- **Mac**: `docs/mac-prompts/night-sound-sleeptalk.md`. The Mac:
  - requests clips for speech;
  - cuts the whole run (2 s pre-roll, ≤ 30 s);
  - transcribes locally with mlx-whisper (`whisper-large-v3-turbo`, or small if slow; language auto-detect, input
    gain as on the classifier path);
  - posts `transcript` and `transcriptLang`.

  Audio goes only to the signed upload URL. The server decides whether a speech clip is allowed.
- **Tests**: `packages/core/test/sleeptalk.test.ts` (both asleep, one asleep, both awake, missing data, the push line,
  speech clip / transcript rules); `supabase/functions/tests/night-sound.test.ts`.
- **Deploy**:
  1. Apply `0029_sleep_talk.sql`.
  2. Redeploy `night-sound` and `nightly-report`. Both work before the migration too: speech stays unclipped, and the
     judge reports an error and is skipped.
  3. Then paste the Mac prompt.

## Sound labels (migration 0030)

Added 2026-11-05 ("build 2"). The Mac listener missed most snoring: the camera's microphone is very quiet (about
−68 dBFS, floor about −71) and YAMNet names real snoring "Whale vocalization", "Animal", "Wild animals", "Outside,
rural or natural", "Music" or quiet "Speech". On night 2026-11-05 Cath snored but the detector found almost no snoring
minutes after we both fell asleep. Now the household labels clips in the app and the Mac tunes itself from the labels.

- **Schema** (`0030_sound_labels.sql`):
  - `public.sound_labels`: `event_id` (primary key, references `sound_events.id`: one label per event, a re-label
    replaces it), `label` (`snore` | `not_snore` | `speech` | `other`), `who` (`a` | `b` | `both` | `unknown` | null;
    kept only for `snore`), `labelled_by` (auth.uid()), `labelled_at`. RLS: household members read; owners and members
    write only through `label_sound_event(p_event_id, p_label, p_who default null)` (upsert; definer in `private`,
    invoker wrapper in `public`); service role all. Index on `labelled_at desc`.
  - `sound_events.uncertain` (boolean, default false): a borderline sound the Mac sent so we can label it.
  - `household_settings.sound_uncertain_clips` (0..40, default 8; 0 = off) and `set_sound_uncertain_clips(p_n)`.
- **night-sound**:
  - GET adds `uncertainClipsLeft` (0 with clips off or the setting 0) and `calibration` (`_shared/sound.ts`
    `loadCalibration`): `labels` = the newest 200 labelled events, newest label first, each
    `{eventId, ts, label, who, kind, yamnet, peakDb, floorDb, durationS, score, uncertain, labelledAt}` (`yamnet` = the
    event's YAMNet label; `floorDb` = `sound_minutes.db_floor` of the event's minute), and `summary` = core
    `calibrationSummary` (counts, per-YAMNet-class snore precision and `trusted`, `snoreClasses`, `peakAboveFloor`,
    `suggestedPeakAboveFloorDb`, `updatedAt`). `calibration` is null before the migration or on a read error (listening
    is never blocked by it). `GET ?labels=1` returns only `{calibration, uncertainClipsLeft, now}`.
  - Events may carry `"uncertain": true`. A non-speech uncertain event with `wantClip` gets a clip (maxS 10) from its
    own allowance, `sound_uncertain_clips` a night, separate from the 40 ordinary and 20 sleep-talk clips (core
    `clipAllowance`: speech → uncertain → other). A speech-class event keeps every sleep-talk rule whatever its flag.
    Before 0030 the flag is dropped before storing (no column) and no borderline clip is handed out.
- **Calibration math** (core `sound/labels.ts`, pure):
  - precision of a YAMNet class = labelled snore / labelled events with that class; `trusted` = ≥ 3 labels
    (`CALIBRATION_MIN_LABELS`) and precision ≥ 0.6 (`CALIBRATION_MIN_PRECISION`);
  - `suggestedPeakAboveFloorDb` = median(peakDb − floorDb) over snore-labelled events with both values, − 2 dB, rounded
    to 0.5, within 4..10; 10 (the night-sound-fix-2 value) with fewer than 3 such events.
- **Labels win over the detector** (core `labelledSnore`, used by `nightSoundSummary` and `wakeTriggers`): an event
  labelled `snore` makes the minutes it covers ([ts, ts + durationS], at least its own minute, at most 60) snoring
  minutes, even without a minute summary; one labelled `not_snore` takes them out (a snore label in the same minute
  wins). `speech` / `other` labels leave the detector alone. The summary adds `labelAddedMin` / `labelRemovedMin`.
  The nightly report and experiments still read the raw detector minutes.
- **App** (`lib/soundLabels.ts`, one shared store): under each clip in Today › Snoring & noise (notable moments, now
  every clipped or borderline moment, up to 24), Today › Sleep talk and Live › Latest moments: **Snoring** / **Not
  snoring**, then Cath / Erik / ? after Snoring; optimistic, reverted with a message when the RPC fails. Viewers see the
  label as text. A line "Labelled: 6 snore, 3 not. The Mac retunes itself every evening from these." The Today card's
  snoring minutes and wake-up sentence use the labels. Borderline moments read "Unclear sound" with "sounded like
  “Whale vocalization”". System › Camera: "Save unclear sounds to label" (8 a night, or off). The simulator labels in
  memory and adds two borderline sample moments per night.
- **Mac**: `docs/mac-prompts/night-sound-labels.md` (read `calibration` at the start of the listen window and at most
  hourly; snore = YAMNet Snoring ≥ 0.2, or the rhythm rule with the suggested peak threshold and a trusted top class,
  falling back to the fix-2 class list for classes with fewer than 3 labels; borderline clips at most one per 20 min).
- **Tests**: `packages/core/test/sound-labels.test.ts`, `supabase/functions/tests/sound-labels.test.ts`.
- **Deploy**:
  1. Apply `0030_sound_labels.sql`.
  2. Redeploy `night-sound` (it also works before the migration: `calibration: null`, `uncertainClipsLeft: 0`).
  3. Deploy the web app.
  4. Paste the Mac prompt.
