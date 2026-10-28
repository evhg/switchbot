# Development

Phase 0 runs entirely on simulated data. You can build and run everything below before any device is unboxed. For installing the hardware, see [SETUP.md](SETUP.md). For deploying the backend, see [BACKEND.md](BACKEND.md).

## Requirements

- Node 22.6 or newer. The scripts run TypeScript directly with `--experimental-strip-types`.
- npm workspaces. Running `npm install` once at the root installs everything, including Deno (an npm devDependency, run as `npx deno`).
- Docker is optional. You only need it for `npx supabase start` / `db reset`, to test the SQL locally.

## Layout

```
packages/core/            @sleep-lab/core: pure TS, no runtime deps; runs in Node, Deno and the browser
  src/types.ts, curve.ts  shared data contract (fixed; see CONTRACT.md)
  src/sim/                deterministic simulator: room physics, people, body/Fitbit data, ground truth
  src/control/            open-loop aircon controller (IR setAll / learned-button ladder)
  src/metrics/            CO2 fits (ACH, build-up, forecast), event detection, nightly metrics, scores, rule report
  src/switchbot/          SwitchBot OpenAPI v1.1 client, HMAC signing, meter/webhook parsers
  src/health/             Google Health API v4 client, OAuth, parsers, webhook signature check
  test/                   vitest suites (incl. integration.test.ts: 60 simulated nights vs ground truth)
apps/web/                 Next.js 15 PWA (Today, Room, Body, Lab, System); simulator data by default
supabase/                 migrations (schema, RLS, pg_cron) and 7 Edge Functions (Deno)
scripts/sim-cli.ts        dump simulated nights as JSON / CSV / summary
scripts/seed-supabase.ts  upsert simulated nights into a Supabase project
docs/                     plan, research, visualisations, setup, backend, this file
```

Core code rules: imports use explicit `.ts` extensions, code uses only Web-standard APIs (no Node built-ins), and TypeScript is strict with `noUncheckedIndexedAccess`. Node's type stripping can't handle TypeScript-only syntax, so core code avoids parameter properties, enums and namespaces.

## Everyday commands (repo root)

| Command | What it does |
|---|---|
| `npm run dev` | PWA dev server on http://localhost:3000, using simulated data |
| `npm test` | core vitest suite (~150 tests, ~20 s, including the 60-night integration run) |
| `npm run typecheck` | `tsc` for core and web, plus `deno check` for the Edge Functions and core |
| `npm run test:functions` | Deno tests for the Edge Functions (Web Push RFC 8291 vector, coach grounding, health helpers) |
| `npm run build` | production `next build` of the PWA |
| `npm run check` | typecheck, then test, then build |
| `npm run sim -- --nights 7 --format summary` | simulator CLI (see below) |
| `npm run seed -- --dry-run` | seed script without a database; prints row counts |

Run a single test file with `cd packages/core && npx vitest run test/metrics-events.test.ts`. Add `-t "<name>"` to run one test by name.

## Simulator CLI

```sh
node --experimental-strip-types scripts/sim-cli.ts [--nights N] [--seed S] [--end YYYY-MM-DD] [--format json|csv|summary] [--out file]
```

- `summary` prints one line per night: lights-out, wake, true ACH, peak CO₂, mean temperature and RH, number of AC commands, deep minutes per person, and tags.
- `csv` prints 1-minute room readings (`date,ts,iso_ict,temp_c,rh,co2`).
- `json` prints the full `Night[]`, including the AC log, body data and `truth`.

Nights are deterministic per (seed, date). The same night comes out identical whatever range you request. `--end` is the wake date of the last night and defaults to today in ICT.

## Seeding Supabase

```sh
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run seed -- --nights 30
```

The seed is idempotent (it upserts). Use `--dry-run` to check it without credentials. With the database seeded, set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `apps/web/.env.local` (optional: `NEXT_PUBLIC_METER_DEVICE_ID` to pin the meter, otherwise the `devices` row of kind `meter` is used, falling back to the simulated meter; `NEXT_PUBLIC_VAPID_PUBLIC_KEY` for push). Then choose the Supabase data source under System in the PWA; reading requires a household-member sign-in.

## Integration test: what "green" means

`packages/core/test/integration.test.ts` simulates 60 nights (seed 2024) and prints a recovery report:

| Check | Requirement | Current result |
|---|---|---|
| Morning decay ACH vs truth | ±30% on ≥70% of clean departure decays | 42/47 (89%) |
| Shower detection (±15 min) | recall ≥80%, precision ≥80% | 86% / 92% |
| Door opening, visible (CO₂ ≥ 800 ppm at opening) | recall ≥70% | 100% (the 44% across all doors is shown but not asserted) |
| In-bed onset | ±30 min on ≥70% of nights | 60/60 |
| Room/person metrics | finite and in range every night | ✓ |
| Controller | 4–16 commands per night, ≥ minInterval apart, no duplicates except resends | 8–12 (median 9) |
| Temperature → deep sleep | warmer-curve arm on the same nights: shallower on ≥80% of nights, −4 to −20 min/°C | +2.4 °C → −24 min (100%) |

Evening door openings while CO₂ is near the outdoor level leave no CO₂ signature, so no CO₂ detector can see them. That is why they are excluded from the door recall. Within a single run, the controller keeps temperature so close to the curve that the night-to-night correlation is weak (r ≈ −0.2). The effect is therefore checked as a two-arm experiment, which is how the Lab tab measures it.

## Conventions

- Timestamps are epoch ms (UTC). Display is in ICT (UTC+7). A night is keyed by its wake-up date.
- Don't change `packages/core/src/types.ts` or `curve.ts` without updating every consumer: the simulator, metrics, Edge Functions, web app and SQL.
- The Edge Functions import core by relative path (`../../../packages/core/src/…`), so core has to keep working in Deno.
