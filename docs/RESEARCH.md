# Research summary: SwitchBot sleep lab

Research date: 2026-10-28. Eight parallel research agents covered the topics below, and an independent agent then fact-checked each topic's decision-critical claims.

- **Full reports with sources:** `docs/research/*.md`. Each file ends with its verification section.
- **How sure we are:** each finding is tagged **✅ verified** (primary source), **⚠️ likely** (secondary or partly verified) or **❓ test on unboxing**.

---

## 0. The ten things that change the plan

1. **Your bedroom will probably hit 1,200–1,800 ppm CO₂ by morning.** ⚠️ This is our own calculation, not a measurement.
   - Inputs: two adults, about 120 m³ (45 m² × 2.7 m), 0.1–0.2 air changes per hour.
   - The sleep research says disturbed sleep starts around **1,000 ppm**, and below **800** is better.
   - So ventilation is likely needed. We will **measure** before buying.
2. **The Meter Pro CO2's auto-calibration can hide exactly that build-up.** ⚠️
   - The sensor is almost certainly a Sensirion SCD4x.
   - Its self-calibration assumes it sees outdoor air (about 400 ppm) at least once a week.
   - A room that is never ventilated breaks that assumption, so the readings drift low.
   - The fix is to calibrate it outdoors (on battery) on day 1, then give it a few minutes outside every week.
3. **The Meter must run on USB-C power.** ✅ On batteries, CO₂ updates only every 30 min. On USB it updates every 1 min. No power adapter comes in the box.
4. **The Hub Mini LED does not auto-dim**, because it has no light sensor. ✅ It can be switched fully off:
   - Turn off **"Indicator Light"**, not just "Keep Turned on in Standby". The second setting still blinks on every command.
5. **The Hub Mini does not need to go in the ceiling.** ✅ It needs a USB 5 V/1 A outlet (1–2 W) and a clear view of the aircon's IR receiver module.
   - It can sit on a shelf or wall several metres away, near any socket.
   - Third-party reviews quote about 30 m line-of-sight range. ⚠️
6. **The camera has local RTSP**, which earlier advice said it lacked. ✅
   - RTSP is the standard local video stream that self-hosted tools such as go2rtc and Frigate read.
   - Enable it under *Settings → More Features → Camera Account*. The stream is `rtsp://user:pass@IP:554/live0` (HD) or `/live1` (SD).
   - Its night vision uses **940 nm IR, officially invisible**. I said 850 nm earlier; that was wrong.
   - The SwitchBot cloud API exposes **nothing** for this camera. Any camera AI therefore needs a small always-on box at home, or an unofficial cloud workaround.
7. **The legacy Fitbit Web API shuts down this week** (30 Oct or 2 Nov 2026). ✅
   - Everything must use the new **Google Health API v4**.
   - It returns heart rate stored at 1-second resolution (about 5 s typical in practice), HRV samples, per-minute SpO₂ during sleep, and sleep stages.
   - It does not offer raw PPG, raw accelerometer data or beat-to-beat RR intervals. ✅
8. **A two-way wired aircon interface is possible.** ⚠️ It does **not** need a power outlet.
   - The open-source `esphome-toshiba-ab` board connects to Toshiba's wired "AB" control bus and is powered from that bus.
   - It can read the unit's real setpoint, mode and temperatures, and can feed it the room temperature at bed height.
   - It needs the indoor unit's model number (`RAV-…`) and a check that the unit has AB terminals.
9. **SwitchBot's cloud is fine for a cloud-only build, but flaky.** ✅
   - Limit: 10,000 calls/day. 2026 reports describe multi-hour lockouts and webhooks that went silent for about 6 days.
   - Design: webhook plus 1–2 min polling, a budget under 5k calls/day, and our own history (the API has no history endpoint).
10. **This cloud session is not an always-on server.** Its container is reclaimed when idle.
    - The always-on parts will be **Supabase** (Postgres, cron, Edge Functions) and **Vercel** (the PWA), both already connected here.
    - The Hub Mini is always on, but it is a relay, not a computer we can program.

---

## 1. SwitchBot Hub Mini

| Topic | Finding | |
|---|---|---|
| Variants | Original **W0202200** (micro-USB or USB-C). **Matter Enabled W0202203** (USB-C). A 2026 purchase is almost certainly the Matter version. Check the label. | ✅ |
| Power | 5 V 1 A USB, 1–2 W. No battery and no adapter in the box. A 3–5 m good-quality USB cable is fine. | ✅ |
| LED | On by default. **Indicator Light = off** keeps it dark even while sending IR. It still flashes at power-on and in pairing mode. No light sensor, so no auto-dimming. The off toggle is documented for the original Mini; check it on the Matter model, and use a dot of tape if it is missing. | ✅ / ❓ |
| Sound | No speaker. | ⚠️ |
| IR | About 30 m line of sight (third-party figure). Works across the room. IR cannot pass walls. | ⚠️ |
| Aircon control | **Smart Matching** (point the real remote at the hub) unlocks `setAll` = `"{temp},{mode},{fan},{on/off}"`. Use integers 16–30 (API range; this Carrier 42TGF unit's Toshiba-type remote encodes 17–30 only, so core floors at `SETALL_MIN_C` 17); mode 2 = cool, 3 = dry; fan 1 = auto … 4 = high. If matching fails, learn a **ladder** of buttons in "Others" mode (`C18`, `C19` … `DRY`, `OFF`; names can't be bare numbers) and send them as `customize` commands. Toshiba extras (ECO SLEEP, Hi-Power) need learned buttons. | ✅ |
| Feedback | **None.** The Hub Mini cannot read the AC's state or the physical remote. We keep our own "assumed AC state" and use the meter's temperature trend to confirm a command landed. | ✅ |
| Offline | Hub Mini IR control needs the cloud. Hub 2 and Hub 3 can run IR offline; the Mini cannot. | ✅ |
| Matter | Bridges up to 4 devices to Apple Home. The IR AC appears as on/off, cool/heat and set temperature. The CO₂ reading does not reach Apple Home (temperature and humidity do). | ✅ |
| Programmable? | No. It is a cloud-tethered IR + Bluetooth gateway. | ✅ |
| Data push | SwitchBot cloud **webhook** (one URL per account in practice, `deviceList: "ALL"`, **no signature**, so put a secret in the URL). | ✅ |

## 2. SwitchBot Meter Pro (CO2 Monitor), W4900010

| Topic | Finding | |
|---|---|---|
| Sensor | NDIR, "Swiss". Reviewers say Sensirion SCD40; the 30 min battery mode hints at SCD41. Accuracy ±(50 ppm + 5 %). The SCD40 is only rated for **400–2,000 ppm**, so above about 2,000 ppm the error widens. | ✅ / ⚠️ |
| Temp / RH | ±0.2 °C (0–65 °C), ±2 % RH (10–90 %). Offsets can be calibrated in the app. | ✅ |
| Update rate | **USB-C: 1 min** (adjustable; under 1 min self-heats the sensor). **Battery: 30 min**, fixed. With both connected, USB wins; remove the AAs. Temp/RH sampled every 4 s. | ✅ |
| Cloud cadence | Undocumented. The app history is adaptive (2–30 min). The API `/status` returns the latest reading, so **poll every 1–2 min** for a dense series. The webhook carries `timeOfSample`. | ⚠️ |
| Calibration | Manual: App → ⚙ → Calibrate → CO₂ Monitor. Put it **outdoors**, wait 1 min, tap, and leave it untouched for 5 min. Battery power is recommended for this. Health check: outdoors it should read 400–500 ppm. **There is no switch to turn off auto-calibration.** | ✅ |
| Darkness | **No backlight** (reflective LCD). No LED found. Alerts can **flash the screen and buzz at up to 100 dB**, with **no Do Not Disturb**, so turn "Alert Sound & Light" off and alert from our app instead. | ✅ |
| History | 36 days on the device, 2 years in the cloud (tap "Store Data in Cloud" once in the app since v9.0). There is a CSV "Export Data" button. The API has no history endpoint. | ✅ |
| Placement | Bed height, 1–2 m from your heads, out of the aircon airflow, and **away from the shower** (RH above 80 % ages the sensor). | ✅ / ⚠️ |
| Local BLE | Broadcasts unencrypted. Manufacturer ID 0x0969; CO₂ in bytes 13–14 (big-endian). Decoders exist in pySwitchbot, Home Assistant and Theengs, so a $3–10 ESP32 could read it with no cloud. | ✅ |
| API | `deviceType: "MeterPro(CO2)"`. Status fields `temperature`, `humidity`, `CO2`, `battery`. Webhook `changeReport` events. | ✅ |

## 3. SwitchBot Pan/Tilt Cam Plus 3K, W4001100

| Topic | Finding | |
|---|---|---|
| Video | 5 MP, H.264, about 107° diagonal, 360° pan (with end stops) / 115° tilt, f/1.6. microSD up to 256 GB (about 42 days of continuous recording). 5 V 2 A USB-C, adapter included. 2.4 GHz only. | ✅ |
| Night | **940 nm IR: officially invisible and "won't disturb sleep."** Colour night mode needs some ambient light, so in your dark room it will be black-and-white IR. | ✅ |
| LED | Red/green status LED, **solid green while online**. The firmware supports switching it off (`isOpenIndicatorLight`). Look for the toggle in the app; otherwise use tape. | ❓ |
| Local stream | **RTSP** via Camera Account: `/live0` HD and `/live1` SD, TCP, digest auth, 1–2 s latency. ONVIF on port 2020 is in the German/Dutch/Spanish docs but was removed from the English docs, so it may be unreliable. Audio on RTSP is unconfirmed; check with `ffprobe`. | ✅ / ❓ |
| Cloud API | List only: no status, commands, webhooks or stream URL. | ✅ |
| Detection | On-device motion and human detection, motion tracking, patrol, 4 preset points (usable in SwitchBot scenes), privacy mode (the lens rotates inward). **No cry or sound classification.** Paid "AI Guard" plans add cloud AI search and summaries. | ✅ |
| Unofficial cloud path | The camera streams through AWS Kinesis WebRTC. go2rtc has a native `#format=switchbot` source; the `hsakoh/ha-switchbot-kvs-camera` project logs in with your account. Video only, unofficial, could break. | ✅ |
| Babycam | Frigate's audio detector has `crying` and `snoring` labels (not on by default), and SwitchBot publishes a Frigate setup guide. Two-way talk works. Sharing across countries may fail for the grandparents, so plan our own relay stream. | ✅ |

## 4. Aircon: Toshiba Carrier ducted unit

- The receiver module dangling from the unit is a Toshiba ducted **wireless remote kit**: an IR window plus three LEDs (operation, timer, mode). ⚠️
  - **Tape over the LEDs, not the IR window.** Test whether it beeps on every command. If it does, limit commands to a few per night.
- **Two-way upgrade:** `makusets/esphome-toshiba-ab`, an ESP8266 board on the 2-wire AB bus. ⚠️
  - It reads the real state, sends commands with acknowledgement, and can feed the unit a remote room temperature so it regulates on the **bed-height** reading.
  - It is powered from the AB bus. Supported protocols: TCC-Link, HM and TU2C.
  - **Before buying, we need:**
    - the model number on the indoor or outdoor unit's rating plate (`RAV-SM…BT/DT`);
    - confirmation that the unit has A/B terminals (an HA user found **CN41 A/B** on a Toshiba Carrier ducted PCB);
    - an electrician, with the power off at the breaker.
- **Other routes:** ESPHome's `toshiba` IR climate component (sniff your remote to check compatibility), or the Hub Mini alone (works, but open-loop).

## 5. Health data: Fitbit Air, Google Health, Apple Health

- **Fitbit Air** (May 2026, $99) ✅
  - Screenless band with optical HR, accelerometer, gyroscope, SpO₂ (red/IR) and a skin-temperature sensor.
  - **It has a red low-battery light and vibrates for Smart Wake**, so charge it outside sleep hours.
- **Google Health API v4** (`health.googleapis.com/v4`) ✅
  - Setup: create an OAuth "Web" client, add both of you as users, and set the app to **"In production" while unverified**. The unverified-app warning is fine because the limit is 100 users. In Testing mode, refresh tokens expire every 7 days.
  - Each of you must have a profile in the Google Health app, otherwise calls fail with 412.
  - Rate limit: 300 requests/min per user. Webhooks are signed (ECDSA) and expect a 204 reply.
- **Closest-to-raw data, ranked:**
  1. `heart-rate` (1 s storage, about 5 s median, with a motion context flag)
  2. `steps` (1 min)
  3. `oxygen-saturation` (1 min, sleep only, heavily filtered; **no webhook**, so it has to be polled)
  4. `heart-rate-variability` (RMSSD + SDNN samples during sleep)
  5. `respiratory-rate-sleep-summary` (per stage)
  6. `sleep` (stages, short awakenings, out-of-bed segments)
  7. Daily values: HRV (with deep-sleep RMSSD and entropy), resting HR, SpO₂, sleep temperature derivation (nightly vs. baseline)
- **Not available:** raw PPG, raw accelerometer data, RR intervals. Per-minute skin temperature exists only for Pixel Watch 4/5.
- **True beat-to-beat RR** is only available from the Air's Bluetooth **"Share heart rate"** broadcast, which drains the battery. It would need an ESP32 by the bed. This is an experiment for later.
- **Handling Google's algorithm changes:**
  - Store every API response unchanged (append-only, with `updateTime` and `dataSource`). Google reprocesses nights; we keep every version.
  - Compute our own metrics from heart rate, SpO₂ and steps.
  - Treat Google's sleep stages and scores as a separate, versioned layer.
- **Apple Health** ⚠️
  - Google Health has synced into Apple Health since v5.05 (Aug 2026), covering steps, HR, sleep and vitals. HRV reportedly does not sync.
  - So Apple Health adds nothing for the Fitbit data. It adds **iPhone-sourced data**: walking metrics, headphone audio exposure, State of Mind, and any future scale, blood pressure cuff or CGM.
  - Route: the **Health Auto Export** iOS app (premium) posting to a REST endpoint. A web app cannot read HealthKit directly.

## 6. Sleep science: targets

| Parameter | Target | Alert | Basis |
|---|---|---|---|
| Air temperature at bed height | Dynamic curve (below) | **>24 °C** at any time; <17 °C | Baniassadi 2023; BMC Med 2025 (HRV odds ×1.4 at 24–26 °C, ×2.9 at 28–32 °C) |
| Relative humidity | **45–55 %** (aim for 50) | >60 % for >2 h (mites, mould); <35 % | Arundel 1986; Cao 2021/22 chamber studies |
| CO₂ | **<800** (ideal), <1,000 (minimum) | >1,000 amber, >1,500 red | Akimoto et al. 2025 review (ASHRAE RP-1837); Strøm-Tejsen 2016 |
| Light at the eye | <1 lux | any visible LED | Phillips 2019; Mason 2022 |
| Noise | ≤30 dB average; peaks <42 dB | aircon fan surges | WHO 1999 and 2009 |

**Dynamic temperature curve.** This is our own synthesis, not a published protocol.

| Phase | Timing | Target | Why |
|---|---|---|---|
| Pre-cool | 60–90 min before bed | 20–21 °C | A ducted unit and the room's thermal mass react slowly |
| Falling asleep | Lights-out → +45 min | 20 °C (warm feet: socks or a heavier duvet at the foot end) | Warm hands and feet release heat fastest and predict quick sleep onset (Kräuchi 1999) |
| Deep-sleep window | +0.5 → +4 h | **18.5–20 °C (coolest)** | Eight Sleep study: cool early phase → more deep sleep |
| Middle | +4 → +6 h | Rise by +0.5 °C/h | Core body temperature is lowest around 4–5 am; more REM sleep |
| REM-heavy late night | +6 h → wake | 21–22 °C (a small rise only) | The body barely regulates its temperature in REM; warming too much caused awakenings |
| Wake | Last 20–30 min | Optional 23 °C; A/B test it | Evidence is mixed |

**Caveats**
- Eight Sleep's evidence comes from **bed-surface** temperature and is company-funded. Applying it to room air is our extrapolation.
- Per-person preferences are handled with bedding.
- Change one parameter at a time, and use **randomised alternating nights** (N-of-1 trials). Detecting a 10-minute change in deep sleep takes about 35 nights per arm.

**CO₂ and ventilation**
- Staying under 800 ppm with two sleepers needs about **50–80 m³/h of outdoor air** (roughly 8 L/s per person).
- In Phuket, fresh air is mostly a **humidity** load: about 0.5–1.1 kg of water per hour, or 0.4–0.9 kW of cooling.
- That means an **ERV** (it transfers moisture), not an HRV. Best fit: a ducted ERV feeding the aircon's return plenum (Panasonic Thailand sells ERV DC units), or a through-wall unit such as the Mitsubishi Lossnay VL-100.
- **Decision rule:** consider buying if the median nightly mean CO₂ is above 1,000 ppm, or the morning value is regularly above 1,200 ppm.

**Humidity watch-out.** At an 18–20 °C setpoint, a lightly loaded ducted unit can short-cycle (switch on and off rapidly), so RH creeps above 60 % ("cold and clammy"). Fixes: DRY mode before bed, or a dehumidifier.

## 7. Infrastructure without a home server

- **Supabase**
  - Free tier: 500 MB database, `pg_cron` down to second-level schedules, `pg_net`.
  - Edge Functions: 150 s wall time and 2 s CPU on the free tier. Deploy the webhook function with `verify_jwt = false` and a secret path.
  - Data volume: about 525k rows/year at 1 sample/min (about 100 MB), which fits the free tier.
- **Vercel Hobby:** hosts the PWA. Its cron runs only once a day, so do all minute-level scheduling in Supabase.
- **iOS PWA:** Web Push works for home-screen apps (iOS 16.4+, declarative push in 18.4). No background execution and no HealthKit access.
- **Claude nightly report:** `pg_cron` at about 06:30 ICT (23:30 UTC) runs an Edge Function or Vercel function. It aggregates in SQL and makes **one** Messages API call with a structured JSON output, then stores the report and sends a push notification.
- **Optional local hardware (later):**
  - ESP32-C3 ($3–10): local BLE CO₂ readings, Fitbit RR intervals.
  - N100 mini PC (about $150, 6–10 W): go2rtc + Frigate for the camera, accessed over Tailscale (free).
  - SwitchBot AI Hub ($260): runs Frigate, but cannot do IR.
- **Never** port-forward the camera's RTSP to the internet. SwitchBot warns against it.
