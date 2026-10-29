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
    nightly-report/           events + rule report + Claude rewrite + Web Push (06:30 ICT)
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
| `outdoor_readings` | Outdoor temp/RH | seed / later a weather source |
| `calibrations` | CO₂ outdoor calibrations, offsets | manual |
| `curves` | Temperature curves (`phases` jsonb = `CurvePhase[]`); `default-v1` is inserted by 0001, `one-beep-v1` (the default since 0009) by 0009 | SQL |
| `presence_events`, `presence_latest` (view) | Arrive/leave-home events from the iPhones (0009); household read, service-role write | presence |
| `nights` | lights-out, wake, curve, tags, `ac_enabled` | `set_night()` RPC, ac-curve (default schedule), seed |
| `ac_commands` | Every decision: state, via, button, reason, `landed`, `dry_run`, `sent_ok` | ac-curve |
| `ac_state` | One row per AC: assumed state, last command, `remote` (RemoteProfile jsonb), `bias_c` | ac-curve / SQL |
| `events` | Shower, door, in-bed, `ac_missed` …; `source` = detector / manual / sim_truth / controller | nightly-report, ac-curve, seed |
| `raw_health` | **Append-only** Google Health archive (`point_key`, `payload`, `update_time`, `data_source`); a trigger blocks UPDATE/DELETE | google-health-sync |
| `health_hr` (1-min means), `health_hrv`, `health_spo2`, `sleep_sessions`, `health_daily`, `health_vitals_daily` | Derived layers, rebuildable from `raw_health` | google-health-sync, seed |
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

**Missing configuration.** A required secret that isn't set makes a function answer `503 {"error":"not configured","missing":"<NAME>"}` after authentication (never before it). `switchbot-webhook` answers 404 to any path that matches neither `WEBHOOK_SECRET` nor the Vault secret, `google-health-webhook` 401 while its secret is unset, and `google-oauth/start` shows a "Not configured" page. `ac-curve` is a dry run unless `DRY_RUN` is explicitly `false`/`0`/`no`/`off`; an unset or unrecognised value keeps it dry, and a request can force a dry run but never a live one.

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
| `DRY_RUN` | ac-curve | Defaults to **true**. Set `false` only after the remote is verified |
| `SWITCHBOT_DAILY_BUDGET` | all SwitchBot calls | Default 5000; the server limit is 10,000 |
| `SWITCHBOT_AC_RESERVE` | poll-meter | Default 300. Polling stops when fewer calls are left, keeping room for aircon commands |
| `POLL_SKIP_IF_FRESH_S` | poll-meter | Default 0 (off). For example, 50 skips the poll when a webhook reading is that fresh |
| `DEFAULT_LIGHTS_OUT`, `DEFAULT_WAKE` | ac-curve, nightly-report | ICT `HH:MM` used when a night has no row yet. Defaults are 22:00 (every day) and 08:30 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | google-oauth, google-health-sync | OAuth client of type "Web application" |
| `GOOGLE_HEALTH_WEBHOOK_SECRET` | google-health-webhook | The subscriber's `endpointAuthorization.secret` |
| `GOOGLE_HEALTH_SIGNATURE` | google-health-webhook | `off` / `log` (default) / `enforce`. The ECDSA verifier is best effort |
| `OAUTH_START_SECRET` | google-oauth | Guards `/google-oauth/start` |
| `APP_URL` | nightly-report, google-oauth, ac-curve | The PWA origin, for the live app `https://sleep-lab-lac.vercel.app` (push tap target) |
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
| Authentication → URL Configuration → *Site URL* | `https://sleep-lab-lac.vercel.app` |
| Authentication → URL Configuration → *Redirect URLs* | `https://sleep-lab-lac.vercel.app/**`, `https://sleep-lab-git-claude-determined-ride-59txro-evhg.vercel.app/**`, `https://sleep-lab-*-evhg.vercel.app/**` (all previews), `http://localhost:3000/**` |
| Authentication → Emails → Templates → *Magic Link* | Add the code so the email works on another device, e.g. `<p>Your code: <strong>{{ .Token }}</strong></p>` next to the existing `{{ .ConfirmationURL }}` link |
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
| `sleeplab-ac-curve` | `*/5 * * * *` | every 5 min | Controller from precool (lights-out − 90 min) to wake + 90 min. Outside that window, or when the night has `ac_enabled = false`, it only sends OFF if the assumed live state is still ON ("ensure off"). Failed live sends back off (20, 40, 60 min) |
| `sleeplab-health-sync-morning` | `20 0-2 * * *` | 07:20, 08:20, 09:20 | Google Health pulls after typical wake times |
| `sleeplab-nightly-report` | `*/15 0-7,23 * * *` | every 15 min, 06:00–14:45 | `{"auto":true}`: first report + push once wake + 60 min has passed and every connected person's sleep has synced (or at wake + 4 h), silent regenerate when late sleep data arrives, final silent regenerate after max(12:00, wake + 2 h) for the morning ACH. Tracked in `reports.pushed_at / people_count / final` |
| `sleeplab-health-sync-1030` | `30 3 * * *` | 10:30 | Late syncs and reprocessed stages |
| `sleeplab-health-sync-1400` | `0 7 * * *` | 14:00 | Afternoon backstop |
| `sleeplab-health-sync-queue` | `*/10 * * * *` | every 10 min | Drains webhook-queued jobs (no-op when empty) |
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

1. **Google Cloud project.**
   - Enable the Google Health API.
   - Set the OAuth consent screen to **External** and publish it **"In production" (unverified)**. In Testing mode, refresh tokens die after 7 days.
   - Add the three `googlehealth.*.readonly` scopes.
   - Create a Web OAuth client with this exact authorized redirect URI (live project):
     `https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/google-oauth/callback`
     (in general `https://<ref>.supabase.co/functions/v1/google-oauth/callback`, or `<PUBLIC_FUNCTIONS_URL>/google-oauth/callback`).
   - Put its id and secret into the `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` function secrets.
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
| Edge Functions | All 8 deployed with `verify_jwt = false`: `switchbot-webhook`, `switchbot-admin`, `poll-meter`, `ac-curve`, `google-health-sync`, `google-health-webhook`, `google-oauth`, `nightly-report`. They reject unauthenticated calls and answer "not configured" until their secrets exist; `ac-curve` stays in dry run unless `DRY_RUN=false` |
| Function secrets | None set yet (see [Secrets](#secrets)) |
| Auth settings | **Manual** (see [Household and sign-in](#household-and-sign-in)) |
| Vercel env | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` set for production, preview and development |
| Data | No readings, nights or simulated rows in the live database; the PWA shows the simulator until real data arrives (Automatic mode) |

Until 0002 is applied, cron isn't scheduled and `x-cron-secret` requests are rejected (the `verify_cron_secret` RPC doesn't exist yet), so the functions only accept the service key.

**Public endpoints of the live project**

| What | URL |
|---|---|
| Google OAuth redirect URI (Google Cloud console) | `https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/google-oauth/callback` |
| Google OAuth start (per person) | `https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/google-oauth/start?person=a&key=<OAUTH_START_SECRET>` |
| SwitchBot webhook (registered by `switchbot-admin`) | `https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/switchbot-webhook/<vault switchbot_webhook_secret>` |
| Google Health subscriber endpoint | `https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/google-health-webhook` |

**Known mismatch.** The PWA's "Connect Google Health" button opens `google-oauth/start?access_token=<user JWT>&login_hint=<email>`, but the deployed function only accepts `?person=…&key=<OAUTH_START_SECRET>`. Until `/start` also accepts a member's JWT (verify with `auth.getUser`, map to `household_members.person_id`, 403 otherwise), connect with the `key` URL above.
