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
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | google-oauth, google-health-sync | OAuth client of type "Web application" |
| `GOOGLE_HEALTH_WEBHOOK_SECRET` | google-health-webhook | The subscriber's `endpointAuthorization.secret` |
| `GOOGLE_HEALTH_SIGNATURE` | google-health-webhook | `off` / `log` (default) / `enforce`. The ECDSA verifier is best effort |
| `OAUTH_START_SECRET` | google-oauth | **Optional, legacy.** Enables the `GET /start?person=&key=` setup link. Not needed: the PWA starts consent with the member's own sign-in |
| `APP_URL` | nightly-report, google-oauth, ac-curve | The PWA origin (push tap target; google-oauth redirects back to `<APP_URL>/settings/health`). google-oauth falls back to `https://sleep-lab-git-claude-determined-ride-59txro-evhg.vercel.app` when unset |
| `ANTHROPIC_API_KEY` | nightly-report | Optional. Without it, reports are rule-only |
| `ANTHROPIC_MODEL` | nightly-report | Default `claude-opus-5-5` |
| `VAPID_SUBJECT` | nightly-report, ac-curve, push-admin | Optional `mailto:` / `https:` contact; default = the `APP_URL` origin, else `https://sleep-lab-lac.vercel.app` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | — | **Not needed** since 0016: the key pair is generated in the backend and kept in Vault. If set while Vault is empty, they are adopted into Vault once |
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

## Steady 18.5 °C, live switch, home by default, away dates (migrations 0012–0014)

Decided 2026-10-30, after the first real night (aircon at 17 °C by hand: bed 18.5–19.9 °C, CO₂ plateau ~930 ppm, RH
53–55 %): ~18.5 °C all night (Walker: ~18 °C), the room must not warm while either of them may still be in deep sleep
(the watches' stages are not live overnight), and "let the plan run for real".

- **Curve** `steady-18-5-v1` (`DEFAULT_CURVE` since 0012): pre-cool at lights-out − 30 min (21:30) to 18.5 °C, fan auto;
  every later phase 18.5 °C → no command at lights-out, at sleep onset or while asleep; OFF at wake + 30 (09:00).
  `minC` 16, so a cooling emergency still has a degree below set 17. Upcoming real nights on one-beep-v1/v2 whose
  pre-cool had not started moved to it; stored nights keep their curve.
- **Bias** `ac_state.bias_c = −2` (0012, only when unset): set 17 held the bed at 18.5–19.9 °C, so 18.5 °C needs set 17.
- **Emergency while asleep only cools** (core `QuietConfig.emergencyWarm`, default false): a room ≥ target + 1.5 °C for
  20 min gets one command (setpoint − round(deviation)); a too-cold room is never warmed while asleep.
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
  ON that failed (hub offline; retried after 20, 40, 60 min) never beeps after they fell asleep. Before lights-out the
  closed loop resends a stalled pre-cool at most once (never a resend of a resend, none after lights-out); the one
  cooling emergency only looks at readings after lights-out + 15 (earliest 22:35).
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
   - **Data Access › Add or remove scopes**: paste these three and **Update**, **Save**:
     `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`
     `https://www.googleapis.com/auth/googlehealth.sleep.readonly`
     `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`
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

1. **Start (`POST /google-oauth/start`).** The PWA sends `Authorization: Bearer <the user's Supabase access token>`. The function verifies it with the service client (`auth.getUser`), reads `household_members` (owner/member only; viewers get 403) and binds a single-use `oauth_states` row to that user's `person_id`. The owner may pass `{"person":"b"}` to connect someone else. It returns `{url}` (Google consent with `access_type=offline`, `prompt=consent`, the three read-only scopes and the user's email as `login_hint`) and the PWA navigates there.
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
