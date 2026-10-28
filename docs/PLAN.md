# Plan: Bedroom Sleep Lab

**Goals:**
- An Oura/Whoop-style sleep and air app on the iPhone home screen.
- An Eight-Sleep-style dynamic room temperature curve.
- A bedroom that is pitch black and silent.
- CO₂ data good enough to decide whether to buy ventilation.
- Later: a babycam with grandparent streaming.

See [RESEARCH.md](RESEARCH.md) for the evidence and [VISUALIZATIONS.md](VISUALIZATIONS.md) for the charts.

## The room
- Phuket, about 30 °C outdoors all year.
- Bedroom and bathroom are one open space (no door between them): about 45 m² × 2.7 m ≈ **120 m³**.
- The bedroom door is usually closed. The sliding doors are always closed. There is no ventilation.
- Toshiba Carrier ducted aircon with a dangling wired IR receiver module.
- Two sleepers, both wearing a Fitbit Air, both on iPhone.
- Preferences: fall asleep at 18–20 °C, about 50 % RH.

## Architecture (Phase 1–2: no home server)

```
Meter Pro CO2 ──BLE──► Hub Mini ──Wi-Fi──► SwitchBot cloud ──webhook──┐
                         ▲  IR                     ▲ /status poll      │
                         │                         │ (pg_cron 1–2 min) ▼
Toshiba AC ◄─ IR receiver┘        setAll / customize ◄── Supabase Edge Functions ◄── pg_cron (curve every 5 min)
                                                         │   Postgres (readings, ac_state, raw_health, reports)
Fitbit Air ─► Google Health app ─► Google Health API v4 ─┤   webhooks + 10:00/14:00 backfill
iPhone ─► Health Auto Export (optional) ─► REST ─────────┤
                                                         ├─► Claude (nightly report, structured JSON) 06:30 ICT
                                                         └─► Web Push
PWA (Vercel, home-screen app, red night mode) ◄── Supabase (read, row-level security)
```

- **Supabase** is the always-on brain: cron, Edge Functions and Postgres. **Vercel** hosts the PWA. This cloud session is only where we write code.
- **SwitchBot quota:** budget under 5k of the 10k calls/day (one poll per minute is about 1.4k). Read `X-RateLimit-Remaining`, back off on 429, and expect lockouts that can last hours.
- **Aircon state:** IR has no feedback, so we store an `ac_state` table of what we last commanded. A command counts as "landed" only if the bed-height temperature moves within N minutes; otherwise resend once.
- **Raw health data is append-only:** every Google Health response is stored unchanged with `updateTime` and `dataSource`. Our own metrics are computed from it. Google's sleep stages and scores are kept as a versioned layer.

## Unboxing day checklist
1. **Hub Mini**
   - Check the label: W0202203 (Matter) or W0202200.
   - Plug into any socket with a clear view of the AC's receiver module. It does not need to go in the ceiling.
   - Connect to 2.4 GHz Wi-Fi.
   - Settings: **Indicator Light OFF** (not just the "standby" option).
2. **Aircon remote**
   - Add Air Conditioner → **Smart Matching** with the Carrier remote. Try Toshiba, then Carrier.
   - Check that temperature, mode and fan all respond. If they do, we get `setAll`.
   - Otherwise fall back to "Others" mode with a button ladder (`C18`…`C24`, `DRY22`, `OFF`).
   - Also learn the **ECO SLEEP** and **Hi-Power** buttons.
   - **Listen: does the receiver beep or flash on every command?**
3. **Meter Pro CO2**
   - Calibrate **outdoors on batteries**: 1 min outside, tap Calibrate, leave it untouched for 5 min. Expect 400–500 ppm.
   - Then remove the AAs and run it on a **USB-C 5 V/1 A** adapter (not included).
   - CO₂ interval: 1 min.
   - **Alert Sound & Light: OFF.**
   - Tap "Store Data in Cloud".
   - Place it at bed height, out of the aircon airflow, away from the shower.
4. **Camera**
   - Update the firmware.
   - Night vision: Auto (940 nm IR).
   - Look for an indicator LED toggle; otherwise use tape.
   - Create a **Camera Account** to enable RTSP.
   - Test `ffprobe rtsp://…/live1` for an audio track (this needs a laptop on the home Wi-Fi).
5. **Darkness audit:** lights off, eyes adapted for 10 min. Tape anything still glowing: the AC receiver LEDs (not its IR window), chargers, and the Fitbit charger.
6. **Model number:** photograph the indoor or outdoor unit's rating plate (`RAV-…`). This decides whether the two-way AB-bus upgrade is possible.
7. **SwitchBot app → Profile → Preferences → Developer Options:** copy the token and secret. They go into Supabase secrets, never into git.

## Phases

### Phase 0: scaffold (can start now, with simulated data)
- Repository layout: `apps/web` (Next.js PWA), `supabase/` (migrations, functions), `packages/core` (SwitchBot client, signing, curve logic, metrics).
- SwitchBot client:
  - HMAC-SHA256 base64 signature, uppercase.
  - Quota tracking.
  - `setAll` with integers 16–30.
  - `customize` for learned buttons.
- Database schema:
  - `readings` (deduplicated on device + time)
  - `ac_commands`, `ac_state`
  - `events`
  - `raw_health`, `health_metrics`
  - `nights`, `reports`
  - `tags`, `push_subs`, `calibrations`
- A data simulator that replays realistic nights (CO₂ build-up model, aircon cooling curve, HR curve), so the charts can be built before the devices arrive.

### Phase 1: room (week 1)
- Webhook receiver and minute poller.
- Live tiles, night strip, CO₂ forecast, ACH tracker, comfort chart, event detection (shower, door, in-bed).
- **Measure for 1–2 weeks** before changing anything: webhook lag, real CO₂ curves, ACH with the door closed vs ajar.
- Aircon: start with a **fixed** 4-phase curve, then add closed-loop corrections.

### Phase 2: body (as soon as the OAuth app is set up)
- Google Cloud project with the Google Health API enabled, published "In production" (unverified), with both accounts consented.
- Webhooks plus scheduled backfills. Our own metrics: HR nadir and its timing, HRV baseline bands, SpO₂ dips, our own sleep/wake estimate.
- Nightly Claude report (structured JSON, then the report card, then a push notification).
- Experiment engine: randomised alternating-night A/B tests with a forest plot.

### Phase 3: home box and camera (optional purchases)
- **ESP32-C3 by the bed ($3–10):** local 1-min CO₂ over BLE, and optionally the Fitbit Air's beat-to-beat RR intervals.
- **N100 mini PC (~$150):**
  - go2rtc and Frigate, with the `snoring` and `crying` audio labels.
  - Video movement tracking, light-leak scan, Claude vision snapshots.
  - Tailscale for remote access, and a private WebRTC link for the grandparents.
- **esphome-toshiba-ab** (only if the model has AB terminals; installed by an electrician): two-way aircon control, with the bed-height temperature fed back to the unit.
- **Ventilation decision:** if the median nightly mean CO₂ is above 1,000 ppm, get an ERV quote (ducted into the return plenum, 50–80 m³/h).

## Decisions made
- Privacy: everything may go to the cloud. Audio clips are OK.
- Health source: Google Health API v4 only. The legacy Fitbit API is dead. Apple Health is for iPhone-only extras.
- Hosting: Supabase + Vercel free tiers. Claude via the Anthropic API.

## Open questions
- Hub Mini variant (Matter or not), whether Smart Matching works, and whether the receiver beeps → unboxing.
- AC model number and AB terminals → photo of the rating plate.
- Is a Health Auto Export premium subscription OK? (A few dollars; optional.)
- Budget for Phase 3 hardware (ESP32 / N100 / ERV).
