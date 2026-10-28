# Open-source projects and real-world SwitchBot uses for a Phuket sleep-optimisation build

Research date: 2026-10-28. Star counts come from GitHub search on that date. GitHub's `updated_at` changes on any repo event, so I use it only as a rough sign of activity. Confidence is marked H (high), M (medium) or L (low).

---

## 0. What decides the architecture

1. **The cloud-only path works, but its data is coarse.**
   - The official SwitchBot OpenAPI v1.1 exposes the Meter Pro CO2 (`deviceType: "MeterPro(CO2)"`). It supports Status and Webhook, but not Command.
   - The status fields are `temperature` (float °C), `humidity` (int %), `CO2` (int ppm, 0-9999) and `battery`.
   - Webhook events (`eventType: "changeReport"`) carry `temperature`, `scale`, `humidity`, `CO2`, `battery` and `timeOfSample`.
   - Source: https://raw.githubusercontent.com/OpenWonderLabs/SwitchBotAPI/main/devices/sensors/meter-pro-co2.md (H).
   - The API is limited to **10,000 calls/day** (https://github.com/OpenWonderLabs/SwitchBotAPI, H).
   - SwitchBot does not say how often a Meter webhook fires (not found). SwitchBot's own note on cloud-side recording says that once data goes through a Hub, the stored interval "will depend on how much the temperature changes": about every 30 min when stable, 2-10 min when it changes (https://support.switch-bot.com/hc/en-us/articles/25328810947351, H for the statement).
   - So a Supabase webhook receiver plus polling will work. Expect roughly 1-30 min resolution, and measure the real webhook cadence on day 1.
2. **Dense data needs a small always-on BLE listener. A Raspberry Pi is not required.**
   - The Meter Pro CO2 broadcasts its readings unencrypted in BLE manufacturer data, so any BLE scanner can read them.
   - From pySwitchbot source (commit 6d4feac, 2026-10-16), `switchbot/adv_parsers/meter.py`:
     - manufacturer ID 2409 (0x0969)
     - temp/humidity in `mfr_data[8:11]`
     - **CO2 = big-endian uint16 at `mfr_data[13:15]`**, with values above 9999 discarded as parse artifacts
     - model byte `b"\x15"` / `"5"` = Meter Pro CO2
   - Source: https://github.com/sblibs/pySwitchbot (H, read directly).
   - A ~US$5-10 ESP32 running ESPHome (`esp32_ble_tracker` + `http_request`) could POST each advertisement straight to a Supabase Edge Function, with no Home Assistant. This is my design inference (M): the ESPHome components exist, but I found no published project doing exactly this.
3. **CO2 sampling depends on power.**
   - On batteries, CO2 updates **every 30 min and cannot be changed**.
   - On a **5V/1A USB-C supply** it switches to **every 1 min** and can be customised: App → Meter Pro (CO2 Monitor) → gear → Panel Display → Data Update Interval → CO2. Intervals under 1 min keep the sensor on, which "may cause the device to heat up slightly and affect accuracy."
   - Source: https://support.switch-bot.com/hc/en-us/articles/26502008033303 (H, updated 2026-10-27).
   - Retail pages say "every second on Type-C / 5 s on battery" (https://eu.switch-bot.com/products/switchbot-meter-pro-co2-monitor). That **conflicts** with the support article. Trust the support article.
   - **Keep the meter on USB power for sleep analytics.**
4. **Hub Mini indicator LED: it does not auto-dim, but it can be turned fully off.**
   - The official article says the indicator is on by default. Disabling "Keep Turned on in Standby Mode" leaves it off in standby, but it still blinks once per command.
   - Disabling "Indicator Light" keeps it **always off, even when sending IR**. It still flashes at first power-on and in pairing mode.
   - Source: https://support.switch-bot.com/hc/en-us/articles/360038348474 (H). I found no ambient-light auto-dimming in any SwitchBot source, so the user's belief is not supported (M).
   - For a pitch-black room, turn "Indicator Light" off. The camera's status LED (manual: steady green = online) is a separate issue; check whether the app can disable it.
5. **The camera is local-only for video.**
   - Pan/Tilt Cam Plus 3K (`W4001100`) is **list-only** in the OpenAPI: no status, command or webhook (API README device table, H).
   - Video goes over local RTSP: create a "Camera Account" in the app (Settings → More Features → Camera Account).
   - URL: `rtsp://user:pass@IP:554/live0` (HD) or `/live1` (SD). Expect 1-2 s latency. Supports Home Assistant via ONVIF/Generic Camera, including pan/tilt.
   - Source: https://support.switch-bot.com/hc/en-us/articles/31984833990423 (H, edited 2026-09-02).
   - Any cry/pose AI therefore needs something on the LAN to pull RTSP: an old phone, a Mac, a mini-PC, or a later Pi/N100. A cloud-only stack cannot reach the stream.

---

## 1. Ranked shortlist: the projects most useful to this couple

| # | Project | What it is | Maturity (2026-10-28) | Why it matters here |
|---|---|---|---|---|
| 1 | **OpenWonderLabs/SwitchBotAPI** https://github.com/OpenWonderLabs/SwitchBotAPI | Official OpenAPI v1.1 docs: devices, status, commands, webhooks | ~1,230★, 187 open issues, active | The source of truth for the Supabase/Vercel integration. Webhook endpoints: `setupWebhook`, `queryWebhook`, `updateWebhook`, `deleteWebhook`. (H) |
| 2 | **sblibs/pySwitchbot** https://github.com/sblibs/pySwitchbot | Python BLE library behind HA's `switchbot` integration | ~178★, latest commit 2026-10-16 | Authoritative BLE decode for the Meter Pro CO2 (bytes above). Also has `SwitchbotMeterProCO2` with time-offset, datetime and 12/24h display commands. (H) |
| 3 | **makusets/esphome-toshiba-ab** https://github.com/makusets/esphome-toshiba-ab | ESPHome component plus custom ESP8266 board on Toshiba's 2-wire **AB bus** (wired-remote bus). Two-way: reads real unit state, sends commands, optional BME280 room-temperature feed to the AC | 34★, 21 forks, 873 commits, changelog to Oct 2026; author sells assembled boards | **The only route found to true two-way control of a Toshiba ducted unit.** Supports TCC-Link, HM and TU2C (TU2C not auto-detected). README lists RAV-SM1103DT-A, and HA-thread users run RAV-SM802BT-E / RAV-SM1404BT-E (BT/DT model suffixes are, I believe, ducted: inference, M). Warns it "is not suitable for most domestic split systems controlled only by IR" and never to wire AB straight to an ESP UART. (H for README facts) |
| 4 | **AlexxIT/go2rtc** https://github.com/AlexxIT/go2rtc | Universal camera restreamer (RTSP → WebRTC/HLS/MSE/HomeKit) | ~14.5k★, very active | Turns the 3K's `live0/live1` RTSP into low-latency WebRTC for the PWA and grandparents. Needs a LAN host. (H) |
| 5 | **blakeblackshear/frigate** https://github.com/blakeblackshear/frigate | Local NVR with object detection and **audio detection** | ~37k★, very active | Built-in CPU audio model supports a `crying` label ("baby crying, sobbing, whimpering"). Defaults are `bark, fire_alarm, speech, yell`, so add `crying` under `audio.listen`, tuned by `min_volume`. Also local Whisper/sherpa-onnx transcription. https://docs.frigate.video/configuration/audio_detectors (H). The SwitchBot AI Hub page claims Frigate support for Pan/Tilt Cam Plus (marketing, M). |
| 6 | **Google-Health-API/google-health-cli** https://github.com/Google-Health-API/google-health-cli | Go CLI (`ghealth`) for the new Google Health API v4, with agent skills and `webhooks` management | ~274★, created 2026-06 | The quickest way to pull **raw** Fitbit Air samples. Heart rate `list` returns per-reading `beatsPerMinute`. HRV has a sample type (RMSSD) plus `daily-heart-rate-variability`. `--raw` returns the unsimplified response. Lives under a "Google-Health-API" org that links to developers.google.com/health, but the page never states it is official (M). |
| 7 | **OpenWonderLabs/switchbot-openapi-cli** https://github.com/OpenWonderLabs/switchbot-openapi-cli | Official 2026 CLI: `devices watch`, `webhook setup`, `events tail`, `rules` (cron/webhook/MQTT), and **`mcp serve`** (18-29 tools) with Claude Code setup | ~136★, created 2026-04 | Lets Claude Code or the Anthropic API agent drive the Hub Mini and read the meter through MCP. Handy for prototyping and for an "AI sleep coach" loop. `npm i -g @switchbot/openapi-cli`. (H) |
| 8 | **AyushSagar16/fitbit-air** https://github.com/AyushSagar16/fitbit-air | Reads **live beat-by-beat HR + RR intervals** from Fitbit Air over the standard BLE Heart Rate Service (0x180D) when "real-time HR sharing" is on; REST + WebSocket + dashboard | 8★, 2026 | Raw RR intervals mean you can compute your own HRV, independent of Fitbit's algorithms. Sharing drains battery, so it is not for all-night use. Not independently verified (M). |
| 9 | **Luraxx/pulse** https://github.com/Luraxx/pulse | Open-source iOS Whoop-style app for Fitbit Air on the Google Health API: Recovery (HRV 40% / RHR 25% / sleep 25% / resp 10% vs 30-day baseline), Strain 0-21 (Karvonen zones), sleep debt, ±1.65 SD baseline bands, "Pulse Age" | 45★, Apache-2.0, active Oct 2026 | A transparent reference algorithm for Oura/Whoop-style daily reports. Copy the methods, not the app. (M) |
| 10 | **smartHomeHub/SmartIR** https://github.com/smartHomeHub/SmartIR | HA climate entities over IR (Broadlink, ESPHome, MQTT, LOOKin) | ~2.85k★ | Only relevant if they later swap the Hub Mini for an ESPHome/Broadlink IR blaster. (H for existence) |
| 11 | **KiraPC/ha-switchbot-remote** https://github.com/KiraPC/ha-switchbot-remote | HACS integration: SwitchBot hub IR remotes as proper HA climate entities with temp/fan/mode and a linked temp/humidity sensor | ~102★ | Useful only if they run HA. The core `switchbot_cloud` integration also exposes IR ACs (temp and mode) with *assumed* state. (M) |
| 12 | **hsakoh/switchbot-mqtt** https://github.com/hsakoh/switchbot-mqtt | HA add-on: OpenAPI + webhook → MQTT discovery; Meter Pro CO2 verified for Status and Webhook; IR AC commands | ~135★ | Good reference for parsing webhook payloads. (M) |
| 13 | **zeenolife/ai-baby-monitor** https://github.com/zeenolife/ai-baby-monitor | Local video-LLM (Qwen2.5-VL 7B via vLLM) checks an RTSP feed against plain-English YAML rules ("baby is standing in crib") and beeps | ~518★ | Strong concept for gesture/safety rules, but **needs a GPU**. A Claude-vision variant on sampled frames from the cloud is an obvious adaptation (inference). |
| 14 | **lars-frogner/OpenBabyMonitor** https://github.com/lars-frogner/OpenBabyMonitor | Pi Zero baby monitor: loudness or AudioSet-trained NN cry detection, browser streaming | 68★, README says **not actively maintained** | Reference only. |
| 15 | **moelzek/Beddington** https://github.com/moelzek/Beddington, **devagupt/baby-cry-classifier** | YAMNet TFLite cry detectors with night logs and Telegram alerts | ~0-1★, 2026 | Small, but show the YAMNet recipe: classes 19 "Crying, sobbing" + 20 "Baby cry, infant cry" (https://huggingface.co/chayuto/yamnet-cry-distill-int8, M). |

Other projects found, lower relevance:
- **Prometheus/Grafana exporter:** nasa9084/switchbot-exporter (Go, 31★).
- **CO2 dashboards (2025-26, mostly 0-1★):**
  - nlink-jp/sensor-lens: OpenAPI v1.1 → SQLite, quota-aware polling, CSV backfill.
  - karamem0/switch-bot-co2-dashboard.
  - Mutsumix/switchbot-co2-thingspeak.
  - Nu424/switchbotble-co2-GAS-monitor: BLE → Google Apps Script dashboard.
  - pxshaaa/nofuss-home-automation: Mac-hosted, no hub, iPhone web app with SwitchBot CO2.
- **Cloudflare Worker webhook receiver:** i4M1k0SU/switchbot-webhook-worker. A template for the Supabase/Vercel equivalent.
- **mathismueller/ha-switchbot:** HACS extension of the core integration for the Meter Pro CO2, created 2026-10-21, so very new.
- **devWaves/SwitchBot-MQTT-BLE-ESP32** (622★): does **not** list the Meter Pro / Meter Pro CO2. Only Meter/MeterPlus are named (M).
- **Google Health API, other:**
  - davidmosiah/google-health-mcp (75★): MCP server for Claude.
  - rudrankriyam/Google-Health-CLI (63★).
  - santekotturi/airlift: Fitbit Air → Apple Health, on-device.
  - allenporter/python-google-health-api: Python client by an HA core developer.
  - Paari/fitbit-health-explorer: local Whoop/Bevel alternative.
  - 9-7-8/fitbit-air-export: daily JSON/CSV of sleep, RHR, HRV, SpO2 and steps.
  - juliaserebro/health-dashboard: React + Supabase + Google Health API + Claude, the closest match to this couple's stack, 0★.
- **Apple Health → server:** Health Auto Export (closed-source iOS app with a REST "API Export" automation; docs at https://github.com/Lybron/health-auto-export), plus receivers irvinlim/apple-health-ingester and fuergaosi233/apple-health-exporter, both stale since 2023-24.
- **Homebridge:** OpenWonderLabs/homebridge-switchbot (~301★) only got a **CarbonDioxideSensor service for the Meter Pro (CO2) on 2026-10-09** (commit 588a59d, issue #1197, https://github.com/OpenWonderLabs/homebridge-switchbot/issues/1197). Release number not stated (H).

---

## 2. Aircon control: what the Hub Mini can do, and the two-way upgrade path

### 2a. Hub Mini IR, which they own

- **API command for IR ACs:**
  - `setAll` with parameter `"{temp},{mode},{fan},{on|off}"`.
  - Modes: 0/1 auto, 2 cool, 3 dry, 4 fan, 5 heat. Fan: 1 auto, 2 low, 3 med, 4 high.
  - Example: `"19,2,1,on"` = cool 19°C, auto fan.
  - Source: https://raw.githubusercontent.com/OpenWonderLabs/SwitchBotAPI/main/devices/others/virtual-infrared-remote-devices.md (H).
- **`setAll` only works if the remote is matched** via "Smart Matching" or "Select Manually." If the Toshiba Carrier ducted remote isn't in SwitchBot's IR database, there are two fallbacks:
  - **"Learn Buttons" (AC type):** only **ON and OFF** buttons. ON stores one full mode+temp state, e.g. "cool 25°C auto". Works with Alexa/Google/IFTTT. https://support.switch-bot.com/hc/en-us/articles/360038373593 (H).
  - **"Others" mode:** learn any number of custom buttons, each a full remote state, because AC remotes send mode+temp together. Not available to Alexa/Google. Button names cannot be the bare numbers 1-100 ("N1" is OK). https://support.switch-bot.com/hc/en-us/articles/34885181590807 (H).
- **Creative workaround (inference, M):** in "Others" mode, learn a ladder of buttons, e.g. `C17`, `C18` … `C26` (cool, auto fan), plus `DRY24`, `OFF`. Fire them from the cloud with `{"command":"C19","commandType":"customize"}`. That gives a stepped temperature curve even without database matching.
- **IR is one-way.** HA's `switchbot_cloud` says IR state "is inferred from commands" and goes out of sync if the physical remote is used (https://www.home-assistant.io/integrations/switchbot_cloud/, H). The Hub Mini cannot tell whether the unit beeped, received the code, or was in Hi-Power/ECO SLEEP.
- **IR line of sight:** the ducted unit's IR receiver is the separate wired module dangling on a cable, so the Hub Mini must see *that module*, not the ceiling unit (inference from user context, M). Put the Hub Mini at a USB outlet with line of sight to the module, or fix the module somewhere visible. The Hub Mini doesn't need to be in the ceiling at all.

### 2b. ESPHome IR alternative

- ESPHome's built-in `toshiba` IR climate platform supports `GENERIC` (17-30°C), `RAC-PT1411HWRU-C/-F` (16-30°C) and `RAS-2819T` (18-30°C, two-packet protocol).
- An optional `remote_receiver` can sniff the original remote so state stays in sync.
- On RAC-PT1411HWRU, the `sensor` value is transmitted to the AC ("Comfort Sense," update every <7 min).
- Source: https://esphome.io/components/climate/climate_ir/ (H). Whether the Carrier/Toshiba ducted IR kit speaks one of these codesets: **not found**. Test by sniffing.

### 2c. True two-way: AB bus, the "Eight Sleep for the room" enabler

- A dangling **wired** IR receiver/display module is typical of Toshiba ducted "wireless remote controller kits" (e.g. RBC-AX22CE / TCB-AX21E). These sit on the indoor unit's remote-controller terminal block.
  - Toshiba app-control tables list both kits as wireless remote kits (https://manualmachine.com/toshiba/bmsiflsv1e/10509182-application-control-manual, M).
  - That the receiver connects on **A/B** specifically is my inference (M). Verify on the indoor unit's wiring label/PCB: an HA user found **CN41 A/B** on an MCC-1631 board of a Toshiba Carrier ducted unit (https://community.home-assistant.io/t/toshiba-ac-central-systems-integration-ab-protocol/885640, M).
- If A/B is present, esphome-toshiba-ab gives:
  - actual setpoint, mode, fan and room/coil temperatures
  - commands with ACKs
  - a remote room-temperature input (BME280, or the Meter Pro's reading) so the unit regulates on *bed-level* temperature rather than return-air temperature
- Caveats:
  - The custom board must be bought or built.
  - The ESP8266 needs power. Check whether the board can draw from the AB line or needs 5V: **not found**.
  - Isolate power at the breaker before wiring.
  - 2026 thread posts include unACKed writes on some models (RAV-SM802BT-E + RBC-AMT32E, Apr 2026) (M).
- Older alternatives: muxa/esphome-tcc-link (stale since 2022) and issalig/toshiba_air_cond (AB decoder, not reviewed).

---

## 3. CO2 science and open methods: ventilation without a ventilator

### Air changes per hour from overnight decay

From OpenEnergyMonitor (https://docs.openenergymonitor.org/heatpumps/measuring_ach_with_co2.html, H):

`ACH = −ln((C_end − C_base)/(C_start − C_base)) / t_hours`

- Worked example: 890 → 440 ppm over 8 h with baseline 420 ppm gives **0.4 ACH**.
- Use a 3-8 h window. Better: **fit** the exponential `C(t) = (C0−Cb)·e^(−ACH·t) + Cb` rather than assume a baseline.
- Raising CO2 to ~2000 ppm first gives a cleaner test.
- Decay measures total effective dilution, infiltration included (https://jhss.scholasticahq.com/article/146444-..., M).

**When to measure (inference):** the cleanest decay comes right after both people leave the bedroom in the morning with the door shut. Run that fit daily in a Supabase cron job and chart ACH over time.

### Steady-state averaging method (same source)

`ACH = (P/24) / (V·(c − c0)·10⁻³)`, with P in L/day of CO2 production. It is very sensitive to the P estimate.

### Back-of-envelope for this room (my calculation, M)

- Two sleeping adults emit roughly 15 L/h CO2 each, so ~30 L/h.
- Room volume V ≈ 110-135 m³ (bed + bath open plan).
- **With zero air exchange:** CO2 rises ≈ 30 / 120 000 L ≈ **+250 ppm/h**. That is about +2,000 ppm over 8 h, so ~2,400 ppm by morning.
- **At 0.2 ACH:** steady state ≈ 420 + 30/(0.2·120) × 1000 ≈ **~1,670 ppm**.
- **At 0.5 ACH:** ≈ **~920 ppm**.
- An overnight curve will therefore show quickly whether ventilation is needed. A plateau above ~1,000-1,400 ppm signals that an ERV or trickle ventilation is worth buying.

### CO2-based occupancy and bedtime detection

- The literature supports CO2 as an occupancy signal but flags confounders (ventilation, metabolic rate) (Nottingham study https://nottingham-repository.worktribe.com/OutputFile/1411127, M).
- No validated "count sleepers from rise rate" project was found.
- Practical rules (inference):
  - Door-closed, two-occupant **dCO2/dt ≈ +200-300 ppm/h** marks the in-bed period.
  - The slope falls to near zero when someone leaves (e.g. a bathroom trip is invisible, because the bathroom is in the same air volume).
  - A sharp drop means a door or slider was opened.
  - Cross-check against Fitbit sleep sessions.

### BLE path reliability note

- A 2026 HA thread reports **Shelly Bluetooth proxies don't deliver Meter Pro CO2 values**, while a local USB adapter does (https://community.home-assistant.io/t/shelly-bluetooth-for-switchbot-meter-pro-co2/996306, M).
- HA issue #164817: the Meter Pro CO2 broke in HA 2026.3.0 (opened 2026-03-05, closed 2026-03-25).
- ESPHome proxies are not mentioned either way: **not found**.
- The HA core `switchbot` (BLE) integration lists Meter Pro CO2: temperature, humidity, CO2, battery, plus time-format, offset and datetime sync (https://www.home-assistant.io/integrations/switchbot/, H).
- SmartHomeScene has a raw-ESPHome decode guide for the Meter Pro / Pro CO2 (https://smarthomescene.com/guides/how-to-integrate-switchbot-meter-pro-and-meter-pro-co2-in-esphome/, M; byte offsets for CO2 confirmed from pySwitchbot instead).
- HA discussion #2305 (2026-01-04) asks for a way to trigger a manual CO2 reading. The interval on battery is fixed (https://github.com/orgs/home-assistant/discussions/2305, H).

---

## 4. "Eight Sleep for the room": DIY temperature curves

- **No open-source project drives a *room* AC from live wearable sleep stages** (not found).
- Closest pieces:
  - **LiamSnow/opensleep:** Rust firmware replacing Eight Sleep Pod 3 software. Supports unlimited-point temperature profiles spread between sleep and wake times, plus MQTT/HA (https://github.com/LiamSnow/opensleep, M).
  - **HA blueprints:**
    - Interpolated day/night setpoint curve: https://community.home-assistant.io/t/link-a-thermostat-to-the-day-night-cycle/722104 (M).
    - EN 16798-1 smart setpoint with learning: https://community.home-assistant.io/t/en-16798-1-smart-setpoint-blueprint/956624 (M).
  - **Eight Sleep's published approach:** U-shaped profile, with deep-sleep phase one step cooler than bedtime and REM/wake phase warmer. Autopilot calibrates over ~7 days (https://www.eightsleep.com/blog/sleeping-temp-101-find-the-optimal-temperature-for-you/, M; vendor blog).
  - **CircadiaOS** (paid iOS app, $19.99/mo): four-phase thermostat schedule, no live sensing (App Store, M).
- **Wearable data is too slow to drive the curve in real time (inference).** Google Health API sleep sessions arrive after sync, not live. Only BLE HR sharing is live, and it drains the battery.
- **Practical design (inference):**
  1. Run a **fixed 3-4 phase schedule** (pre-cool → hold → slight warm-up before wake), anchored to the habitual bedtime.
  2. Tune it **nightly** with the Anthropic API: correlate last night's deep/REM minutes, awakenings, HR dip and HRV with the room's temp, RH and CO2 traces.
  3. Run it through the Hub Mini (`setAll` or learned "Others" buttons), or later AB-bus control with real feedback.

---

## 5. Wearables combined with the room

### Google Health API (Fitbit Air)

- Fitbit Air data is reached through the Google Health API (v4), the successor to the Fitbit Web API (https://developers.google.com/health/migration/api-specifications, H).
- Terra's analysis (2026-05-18) lists 31 data types (https://tryterra.co/blog/everything-you-need-to-know-about-google-health-new-api, M):
  - **Samples:** `heart-rate` (~5 s cadence observed, 8,728 samples/day, no intraday approval needed "so far"), `heart-rate-variability`, `oxygen-saturation`.
  - **Daily:** `daily-resting-heart-rate`, `daily-heart-rate-variability`, `daily-respiratory-rate`, `daily-sleep-temperature-derivations`.
  - **Session:** `sleep`, with stage arrays AWAKE/LIGHT/DEEP/REM.
  - Scopes `googlehealth.*` are **Restricted**.
- **OAuth "Testing" mode refresh tokens expire after 7 days** (https://developers.google.com/health/setup, H). For a personal app that means re-consenting weekly, or going through publishing/verification. Personal-use exemptions: **not found**.
- **Legacy Fitbit Web API shutdown:** Google pages give conflicting dates, **2026-10-30 vs 2026-11-02** (per search snippets, M). Either way it is days away, so build only on Google Health API v4.

### Apple Health

- Health Auto Export can POST HealthKit data on a schedule to a REST endpoint, e.g. a Supabase Edge Function (https://apps.apple.com/dk/app/id1115567069, M).
- It is useful mainly for iPhone-derived data and anything that isn't Fitbit.

### Analyses worth building (inference; ideas, not sourced findings)

- Nightly scatter/regression of **deep-sleep minutes and HR nadir vs mean room temperature** in the first 3 h.
- **CO2 at 03:00 vs awakenings or HRV.**
- **RH vs sleep-temperature derivation.**
- **Time-to-HR-dip after pre-cooling.**
- **Per-partner differences.** The same room serves both, so there is a compromise setpoint.
- **Weekly ACH trend.**

---

## 6. Babycam stack: open-source building blocks for the future

1. **Video out:** 3K RTSP → **go2rtc** → WebRTC in the PWA / grandparent link. Needs a LAN host. SwitchBot's own app sharing is the zero-infra fallback (inference).
2. **Cry detection:** Frigate `crying` audio label, or a YAMNet TFLite loop on RTSP audio in ~1 s windows (https://asawo.github.io/blog/posts/005_raspberry_pi_baby_monitor/, M), alerting via ntfy/push.
3. **Rule/gesture detection:** zeenolife/ai-baby-monitor pattern (VLM + plain-English rules). MediaPipe pose for an infant/crib: **no maintained OSS project found**.
4. **Pan/tilt automation:** HA ONVIF supports PTZ for Pan/Tilt Cam Plus per SwitchBot (H). The camera's built-in Motion Tracking and Privacy Mode (lens rotates inward) are in the manual (H, local manual PDF).
5. **Night vision:** retail listings claim 8 × 940 nm IR LEDs, "invisible," meant for nurseries (https://ca.switch-bot.com/products/switchbot-pan-tilt-cam-plus-3k, M, marketing). 940 nm is typically far less visible than 850 nm (general knowledge, M). Verify in the dark on night 1.

---

## 7. Recommended open-source-informed build order (inference)

1. **Day 1 (no new hardware):**
   - Hub Mini on any USB outlet with line of sight to the AC's IR module; LED off.
   - Meter Pro CO2 on USB-C, CO2 interval 1 min.
   - SwitchBot webhook → Supabase Edge Function → Postgres, plus a ~5-min polling backstop (288 calls/day/device, far under 10k).
   - Pull Fitbit Air data daily via the Google Health API v4.
2. **Week 1:**
   - Daily CO2-decay ACH fit.
   - Overnight charts.
   - Learn IR "Others" buttons C17-C26 if Smart Matching fails.
   - Run a fixed 3-phase cooling schedule from Supabase cron / Vercel cron.
3. **Upgrade (~US$10):** an ESP32 running ESPHome as a BLE → HTTPS bridge gives ~1-min dense data independent of the SwitchBot cloud. It can optionally add an IR LED and receiver for the ESPHome `toshiba` climate platform.
4. **Upgrade (AB bus):** if A/B terminals are confirmed, use esphome-toshiba-ab for real two-way control and to feed bed-level temperature to the unit.
5. **Babycam:** add a LAN box (mini-PC or N100) when needed for go2rtc + Frigate.


---

# Adversarial verification (independent fact-check)

# VERDICTS
- [partially-true] IR AC command is setAll 'temp,mode,fan,power' (mode 2=cool, 3=dry; fan 1=auto). Learn Buttons mode gives only ON/OFF. Others mode allows any number of learned full-state buttons called with commandType 'customize'.
  -> setAll format and codes are confirmed (modes 0/1 auto, 2 cool, 3 dry, 4 fan, 5 heat; fan 1 auto, 2 low, 3 med, 4 high; power on/off). Learn Buttons ON/OFF is confirmed. The article adds that you can create several separate AC remotes, each with its own ON state (e.g. cool 25C auto), so a ladder can also be built as multiple Learn-mode remotes, and those work with Alexa/Google/IFTTT. Others mode adds buttons one by one, and button names cannot be bare numbers 1-100 (use 'N1', 'T19' etc.). Others-mode remotes do not work with Alexa/Google Home. 'Any number' is not documented either way. One correction to the premise: setAll is only available when the remote was added by Smart Matching or Select Manually (database), not by Learn or Others. (https://support.switch-bot.com/hc/en-us/articles/360038373593)
- [partially-true] Fitbit Air data comes via Google Health API v4. A one-day test returned HR every ~5 s with no intraday approval. All googlehealth.* scopes are Restricted.
  -> The 5 s median HR interval and 'no intraday tier approval' come from a third-party Terra blog dated 18 May 2026, which does not mention Fitbit Air. Google's vitals page says only that HR storage resolution is 1 s. Google's own Scopes page lists the googlehealth.* scopes but does not classify any as Restricted, so the 'all Restricted' claim rests on Terra alone and is unverified from a primary source. Release notes (2026-03-24) do mention default intraday support through the list endpoint. (https://developers.google.com/health/data-types/vitals)
- [partially-true] Shelly Bluetooth proxies were reported (2026) not to deliver Meter Pro CO2 values to HA while a local USB BT adapter worked.
  -> This is a single user report (Eddie8, 2026-04-05). A Shelly Plug S Gen3 got no CO2 values in any active/passive or RPC combination, while a UGREEN BT 5.3 USB adapter worked. The original poster (2026-03-16) said Shellys HAD worked before an internet outage, and the thread links HA issue #164817 (a Meter Pro CO2 regression in HA 2026.3.0, closed 2026-03-25). There is no resolution. It is anecdotal, not established incompatibility. (https://community.home-assistant.io/t/shelly-bluetooth-for-switchbot-meter-pro-co2/996306)
# ANSWERED
- Q: Does the esphome-toshiba-ab board draw power from the AB line or need a separate 5V supply?
  A: It powers from the AB line. USB is only for initial flashing and has no comms. v3.2/v3.3_SMD have a power-selection jumper: set USB to flash, then AB in service. So no outlet is needed at the ceiling hatch for this board, unlike the Hub Mini.
- Q: Which frame format (TCC-Link/HM/TU2C) would the unit use?
  A: It cannot be determined without the model number. TCC-Link is used by classic RAV-SM / MMD ducted units (2400 8E1, 'auto' detects it). HM is used by newer RAV-HM/RAV-RM (8E1). TU2C is used by U-series RAS-M...U2 (8N1, must be set explicitly). Read the indoor-unit rating plate (RAV-... model). The README tells you to confirm the unit has an AB port first.
- Q: Exact legacy Fitbit Web API shutdown date and Google Health API rate limits / personal-use options?
  A: Google says support for the legacy Fitbit Web API ended 2026-09-30, and the legacy API and Fitbit OAuth endpoints 'will be turned off' on 2026-11-02, which is 5 days from today. Rate limits: 300 req/min and 5 QPS per user; unverified apps 250 QPS total at 2.5 QPS per user for up to 100 users. There is no documented personal-use exemption. Testing mode works but needs re-consent every 7 days. Publishing to production avoids the 7-day expiry, and the 100-user cap applies until a security review is done.
- Q: Does Fitbit Air expose skin/core temperature samples via the Google Health API?
  A: Probably not as raw samples. The new 'skin-temperature-sensors' type (v4beta only, added 2026-10-01) is documented as continuous minutely raw readings from Pixel Watch 4 and 5. Fitbit devices otherwise get 'daily-sleep-temperature-derivations' (a daily derived value). A core-body-temperature type exists but is not wrist-sensor data. Test on the Air to be sure.
- Q: How often does the cloud fire Meter Pro CO2 changeReport webhooks?
  A: Not documented, so keep the plan to log it. Constraints that are known: CO2 refreshes every 30 min on battery and every 1 min (adjustable) on USB, and the hub must be in BLE range. Expect at most one event per sensor update.
- Q: Is Pan/Tilt Cam Plus 3K status LED disable-able / IR invisible?
  A: Not answered. No primary source was found before the web search budget ran out, so check in the app's device settings. A follow-up search can continue this.
# MISSED
- Meter Pro CO2 has audible alerts with NO Do-Not-Disturb or schedule (support article, last updated 2024-12-18). To keep the bedroom beep-free, disable its alert sounds entirely and do alerting in the PWA instead. https://support.switch-bot.com/hc/en-us/articles/28611503749527
- No SwitchBot meter, Meter Pro CO2 included, has a backlight (to avoid heat skewing readings). The display emits no light, which is good for a pitch-black room but means it cannot be read in the dark. https://support.switch-bot.com/hc/en-us/articles/27211671722775
- CO2 accuracy is ±(50 ppm + 5% of reading), e.g. 800 ppm ±90. Manual calibration: in the app, place the meter outdoors in fresh air for 1 min, then a 5-min calibration, done within BLE range. Charts should show this tolerance band. https://support.switch-bot.com/hc/en-us/articles/28265078873495 and https://support.switch-bot.com/hc/en-us/articles/26500991854487
- Hub Mini power: it needs a USB 5V/1A (or 2A) adapter, micro-USB on the original model and USB-C on Hub Mini Matter Enabled, and draws about 1-2 W. It has no battery, so the ceiling hatch with no outlet needs a USB power run or a placement with line of sight to the IR receiver module. https://support.switch-bot.com/hc/en-us/articles/13569889726743 and https://support.switch-bot.com/hc/en-us/articles/27957651411735
- The original Hub Mini has no Matter, no temp/humidity sensor and no offline IR control. Hub Mini Matter Enabled can sync 4 sub-devices to Apple Home. Hub 3 shows CO2 status. Which Hub Mini variant they own affects the Apple Home route. https://support.switch-bot.com/hc/en-us/articles/13569889726743
- The Hub Mini itself has no status or webhook in the OpenAPI (list only), and IR virtual remotes are command-only with no status. There is no state feedback, so the cloud must track the last commanded AC state itself. https://github.com/OpenWonderLabs/SwitchBotAPI
- Meter Pro CO2 runs on 2x AA (about 1 year). Rechargeables must not exceed 3V combined. The USB adapter is not included. https://support.switch-bot.com/hc/en-us/articles/26500977424535
- Once relayed via a Hub, meter data is stored in the SwitchBot cloud for up to 2 years, and the meter keeps 36 days on-device. This backs up the user's own Supabase store. https://support.switch-bot.com/hc/en-us/articles/360038241213
- Since app 9.0, the Meter Pro CO2 connects to a nearby Hub automatically (the Cloud Service toggle was removed), and CO2 can be used as a condition in native SwitchBot Automations, e.g. a CO2 threshold driving an IR AC scene with no cloud code. https://support.switch-bot.com/hc/en-us/articles/26500881438999
- Learn Buttons mode allows multiple AC remotes, each storing one full ON state. That is a ladder alternative to Others mode and keeps Alexa/Google/IFTTT compatibility. https://support.switch-bot.com/hc/en-us/articles/360038373593
- pySwitchbot drops CO2 values above 9999 as transient parse artifacts, so any custom ESP32 or webhook ingester should filter spikes the same way.
- Google Health API release notes added a dataSourceFamily filter on 2026-10-14, which lets a query restrict to one device family. This helps when both phones and the Air write overlapping data.