# Infra dimension: running the sleep system 24/7 without a home server

Research date: 2026-10-28. Confidence: **H** = primary or official source, **M** = secondary or partly verified, **L** = inference or anecdote. Inferences are labelled.

---

## TL;DR (recommended architecture)

1. **Phase 1 is cloud-only and costs nothing.** The data path is:
   - Meter Pro CO2 → BLE → Hub Mini → SwitchBot cloud.
   - From there, (a) a webhook POSTs to a Supabase Edge Function, and (b) Supabase `pg_cron` + `pg_net` also polls `GET /v1.1/devices/{id}/status` every 1–2 minutes as a backstop.
   - Readings land in Postgres. A PWA on Vercel reads from Supabase.
   - Aircon control is `POST /v1.1/devices/{irDeviceId}/commands` with `setAll`, sent from an Edge Function that pg_cron triggers on a schedule (the dynamic-temperature curve).
   - A nightly Claude report runs from pg_cron or Vercel Cron.
2. **Plug the Meter Pro CO2 into USB-C power.** On battery, CO2 only refreshes every **30 min**. On a 5V/1A USB supply it refreshes every **1 min** by default. This matters more than any cloud choice.
3. **The camera cannot be done cloud-only.** The Pan/Tilt Cam Plus 3K exposes **RTSP on the LAN only**, and the SwitchBot API gives this model no status, command or webhook support. Any babycam AI, cry detection or grandparent stream needs a small always-on box at home. Cheapest sensible option: an N100 mini PC (about $150, 6–10 W) running go2rtc/Frigate, reached over Tailscale. A Raspberry Pi 5 is no longer cheap after the 2026 RAM price hikes.
4. **A $3–10 ESP32 is optional insurance.** It can read the Meter Pro CO2's BLE advertisements directly and POST them to Supabase. That removes dependence on SwitchBot cloud freshness and gives about 1-minute or faster local data. The decode offsets are known from pySwitchbot (details in §3).
5. **Hub Mini power: don't put it in the ceiling.** It needs USB-C 5V/1A (1–2 W). Its IR range is about **30 m line-of-sight**. Put it on a wall shelf or bedside location that has an outlet and a clear view of the dangling receiver module. Don't modify the Toshiba/Carrier receiver cable.
6. **Health data needs separate bridges:**
   - **Apple Health:** a PWA cannot read HealthKit. Use an iOS bridge app (Health Auto Export → REST) or a Shortcuts automation.
   - **Fitbit:** the legacy Fitbit Web API is being shut off **right now** (endpoints off **2026-11-02** per Google). Build against the **Google Health API** only. Its scopes are "Restricted".

---

## 1. Cloud-only architecture (SwitchBot cloud → serverless → Postgres)

### 1.1 SwitchBot OpenAPI facts

| Fact | Detail | Source | Conf. |
|---|---|---|---|
| Rate limit | "The amount of API calls per day is limited to **10000** times". Exceeding it returns "Unauthorized". | https://github.com/OpenWonderLabs/SwitchBotAPI | H |
| Auth | Header `sign` = HMAC-SHA256(secret, `token + t + nonce`), uppercased. Plus headers `t` (13-digit ms timestamp) and `nonce` (UUID). | same | H |
| Webhook management | `POST /v1.1/webhook/setupWebhook`, `queryWebhook` (`action: queryUrl` / `queryDetails`), `updateWebhook`, `deleteWebhook`. "All device and scene events will be delivered to this endpoint." | same | H |
| Webhook limit | Only **one** webhook URL per account. Home Assistant docs say to use a proxy to fan out to several apps. | https://www.home-assistant.io/integrations/switchbot_cloud | H |
| Webhook security | The README documents **no signature or HMAC on webhook deliveries**. They are plain JSON POSTs. | SwitchBotAPI README | H (absence) |
| Meter Pro CO2 webhook support | Webhook ✓ for Meter, Meter Plus, Meter Pro and Meter Pro CO2. The Hub Mini row shows "-". | SwitchBotAPI README sensors/hubs tables | H |
| Meter Pro CO2 status fields | `deviceId`, `deviceType` = `MeterPro(CO2)`, `hubDeviceId`, `battery` (0-100), `version`, `temperature` (float °C), `humidity` (int %), `CO2` (int ppm 0–9999) | https://raw.githubusercontent.com/OpenWonderLabs/SwitchBotAPI/main/devices/sensors/meter-pro-co2.md | H |
| Meter Pro CO2 webhook payload | Top level: `eventType`, `eventVersion`. Inside `context`: `deviceType`, `deviceMac`, `temperature`, `scale`, `humidity`, `CO2`, `battery`, `timeOfSample` (Long timestamp) | same | H |
| Webhook firing cadence | **Not documented** (on change vs every sample). Example events use `eventType: "changeReport"`. | SwitchBotAPI README | Not found (L that it is change-based) |
| AC IR command | `{"command":"setAll","parameter":"{temp},{mode},{fan},{power}","commandType":"command"}`. Mode: 1 auto, 2 cool, 3 dry, 4 fan, 5 heat. Fan: 1 auto, 2 low, 3 medium, 4 high. Power: on/off. Example `26,1,3,on`. | https://raw.githubusercontent.com/OpenWonderLabs/SwitchBotAPI/main/README-v1.0.md (v1.1 README shows the same example) | H |
| Learned buttons | Custom learned buttons are sent with `commandType: "customize"` and `command` = button name. This is useful for ECO SLEEP or Hi-Power, which `setAll` doesn't cover. | SwitchBotAPI README | H |
| IR state | The cloud doesn't know the AC's real state. Home Assistant notes IR device state is inferred from sent commands. | HA switchbot_cloud docs | H |
| Camera | Pan/Tilt Cam Plus 3K appears in the API "List" only. No status, command or webhook support. | SwitchBotAPI README cameras table | H |

### 1.2 Data freshness you can actually get

- **Meter Pro CO2 on battery:** CO2 updates every **30 min**, not customizable. On **5V/1A USB-C** it switches to every **1 min** automatically and is customizable in-app via *Device → ⚙ → Panel Display → Data Update Interval → CO2*. Setting it below 1 min keeps the sensor continuously active, which "may cause the device to heat up slightly and affect the sensor's accuracy". Source: https://support.switch-bot.com/hc/en-us/articles/26502008033303 (H, quoted via search; direct fetch returned 403). **Recommendation: USB power, 1-minute interval.**
- **Hub → cloud upload cadence:** not documented by SwitchBot (not found). A third-party Homey developer reports BLE-via-hub data can lag, and users have seen hours-old values in some cases (https://community.homey.app/t/app-cloud-pro-switchbot-release-2-0-87-test-2-0-93/42296?page=13). L/M.
- **Polling budget:** polling one meter every 60 s is 1,440 calls/day. Every 30 s is 2,880. Both fit easily within 10,000/day, leaving room for AC commands. Home Assistant's own cloud integration polls every 600 s. (H for numbers; arithmetic is mine.)
- **Practical design (inference):** store both webhook events and polled samples. Dedupe on `(device, timeOfSample)`. Measure real end-to-end lag in week 1. If lag is often more than about 2–3 min, add the ESP32 BLE path (§3).

### 1.3 Supabase (recommended backend)

| Item | Fact | Source | Conf. |
|---|---|---|---|
| Scheduling | `pg_cron` + `pg_net` can invoke Edge Functions on a schedule. The official example runs every minute, with secrets in Vault. pg_cron ≥1.5 supports second-level schedules (e.g. `'30 seconds'`). | https://supabase.com/docs/guides/functions/schedule-functions, https://supabase.com/docs/guides/database/extensions/pgcron | H |
| pg_net semantics | Async, fire-and-forget, no automatic retry. Log responses from `net._http_response`. | crontap/cronic guides | M |
| Edge Function limits | Wall clock **150 s on Free**, **400 s on paid**. **2 s CPU** per request (async I/O excluded). 150 s idle timeout → 504. | https://supabase.com/docs/guides/functions/limits | H |
| Free plan | 500 MB DB, 2 active projects, about 500k Edge Function invocations/month, 5 GB egress. **Projects pause after 7 days without DB activity.** A 1-minute pg_cron job is itself DB activity, so the project should stay awake (inference, M). | https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/ and others; check supabase.com/pricing | M |
| Upcoming change | Existing free projects are affected from **2026-10-30** by explicit Postgres grants for Data API (PostgREST) access. Write explicit `GRANT`s for the tables the PWA reads. | same blog roundup | M |
| Webhook auth | Edge Functions verify a Supabase JWT by default. SwitchBot can't send one, so deploy the webhook function with `verify_jwt = false` and check a long random secret in the URL path or query, plus the `deviceMac`. | Supabase function config docs (general knowledge) + SwitchBot webhook has no signature | H/M |

**Storage sizing (inference):** 1 sample/min × 1 meter is about 525k rows/year. At roughly 100–150 B/row with an index, that is about 60–100 MB/year, which fits the 500 MB free tier for several years. Roll up to 5-minute aggregates after 90 days if needed. Note on extensions: Supabase deprecated the TimescaleDB extension on Postgres 17 projects (not re-verified here, M). Plain Postgres with a BRIN index on `ts`, plus a `date_trunc` rollup view or materialized view refreshed by pg_cron, is plenty at this scale.

**Fan-out of the single webhook (inference):** make the Supabase Edge Function the one registered URL. If anything else needs events later, it forwards them.

### 1.4 Vercel (host the PWA; optional cron)

| Item | Fact | Source | Conf. |
|---|---|---|---|
| Hobby cron | **Once per day minimum** per job. Precision is ±59 min within the hour. Up to 100 cron jobs per project (docs updated 2026-01-28; older docs said 2 per account). | https://vercel.com/docs/cron-jobs/usage-and-pricing | H |
| Pro cron | Per-minute schedules allowed. | same | H |
| Function duration (Fluid compute) | Hobby: 300 s default and max. Pro: 300 s default, up to 800 s, "extended" 1,800 s. | https://vercel.com/docs/functions/limitations | H |

**Conclusion (inference):** on Hobby, Vercel Cron is fine for the nightly report but useless for 1-minute polling or temperature-curve stepping. Use Supabase pg_cron for all sub-daily scheduling. Vercel is mainly for the PWA and longer-running functions (300 s on Hobby vs 150 s on Supabase Free). Vercel Hobby is for non-commercial use, which fits this personal project.

### 1.5 Dynamic "Eight Sleep-style" aircon control, serverless

- **What pg_cron does:** every 5–10 min overnight, call an Edge Function. It reads the latest meter values and today's schedule (for example: 19 °C at lights-out → step to about 21–22 °C mid-night → 23 °C before wake). It sends `setAll` only when the target changes. (Design inference. The temperature targets belong to another research dimension.)
- **Command cost:** about 6–15 IR commands per night. Negligible against 10k/day.
- **Limitation:** IR is open-loop. Use the Meter's temperature as feedback to detect when a command didn't land (no temperature response within N minutes → resend). Inference.

---

## 2. What cloud-only cannot do

| Capability | Why not cloud-only | Source | Conf. |
|---|---|---|---|
| Babycam video analytics, cry detection, live stream to grandparents | The Plus 3K offers **RTSP on the LAN**: `rtsp://[user]:[pass]@[cam-IP]:554/live0` (main) or `/live1` (sub-stream), using a "Camera Account" created in the SwitchBot app. SwitchBot advises using it only on trusted local networks. The cloud API has no stream or webhook for this model. Something on the LAN must pull RTSP. | https://support.switch-bot.com/hc/en-us/articles/31984833990423 (via search excerpt); API README | H (official article). Older SwitchBot article (2023) and some 2024–25 reviews say "no RTSP", so **verify on your unit and firmware**. |
| Local BLE reads (sub-minute CO2, no cloud dependency) | Needs a BLE radio in range of the meter. | — | H |
| Instant reaction if internet or SwitchBot cloud is down | All control goes through the cloud. | — | H |
| HealthKit (Apple Health) reads | Only native iOS apps can read HealthKit. A PWA cannot (see §4). | Apple platform constraint | H |

---

## 3. Cheapest always-on local options

### 3.1 ESP32 BLE sniffer → POST to Supabase (no Home Assistant)

**Hardware:**
- ESP32-C3 SuperMini, about **$3** (Wi-Fi). https://smarthome-field-guide.pages.dev/blog/esp32-bluetooth-proxy-home-assistant/ (M)
- ESP32-S3, about **$8–10**. https://pamfinds.pages.dev/guides/esp32-s3-bluetooth-proxy-ha/ (M)
- Ethernet/PoE boards (Olimex ESP32-PoE-ISO, Seeed PoE kit about $20 before shipping) are said to give better BLE because the radio isn't shared with Wi-Fi. https://esp32.co.uk/esp32-w5500-ethernet-bluetooth-proxy-home-assistant/, https://community.home-assistant.io/t/great-esp32-board-for-an-esphome-bluetooth-proxy/916767 (M)

**Decoding the Meter Pro CO2 advertisement** (from pySwitchbot master `switchbot/adv_parsers/meter.py` and `adv_parser.py`, H):
- Manufacturer ID **2409 (0x0969)**. Model byte `"5"` / `0x15` = Meter Pro CO2.
- Temperature and humidity come from `mfr_data[8:11]`, decoded by `decode_temp_humidity`.
- **CO2 is `mfr_data[13:15]`, big-endian uint16.** Values above 9999 are discarded as artifacts.
- Battery is `service_data[2] & 0x7F` (service UUID 0xFD3D).
- Example raw advert: https://zenn.dev/team_soda/articles/switch-bot-meter-pro-co2-ble (M).
- Source: https://github.com/sblibs/pySwitchbot/blob/master/switchbot/adv_parsers/meter.py

**Implementation:**
- ESPHome `esp32_ble_tracker` with a lambda on manufacturer data. Passive scan is enough for this. Active scanning can drain SwitchBot device batteries (forum anecdote, M). Then `http_request` POST to the Supabase Edge Function.
- Or use Arduino/NimBLE. The devWaves SwitchBot-MQTT-BLE-ESP32 project exists but is older (2022), needs MQTT, and has no confirmed Meter Pro CO2 support. https://github.com/devWaves/SwitchBot-MQTT-BLE-ESP32 (M)

**Caveat:** an ESPHome *Bluetooth proxy* on its own does **not** decode anything. It forwards raw adverts to Home Assistant, which does the parsing (HA's `switchbot` BLE integration supports Meter Pro CO2: temp, humidity, CO2, battery, with no hub needed: https://www.home-assistant.io/integrations/switchbot/, H). Without HA you must decode in the ESP32 firmware as above. A Shelly proxy reportedly failed to pass CO2 for one user. https://community.home-assistant.io/t/shelly-bluetooth-for-switchbot-meter-pro-co2/996306 (M)

**Power:** about 0.5 W (inference). It can share the USB charger that powers the meter.

### 3.2 Mini-PC / SBC / appliance (needed for the camera AI phase)

| Option | Price (2026) | Idle power | Notes | Source | Conf. |
|---|---|---|---|---|---|
| Home Assistant Green | about **$219** (Oct 2026 listing) | about 2 W (est.) | RK3566, 4 GB. Fine for HA and BLE but **too weak for video AI**. | https://www.bitdoze.com/best-home-assistant-hardware/ | M |
| Raspberry Pi 5 | 4 GB about $85–110, 8 GB about $125–175, 16 GB about $205, after **three 2025–26 RAM price hikes** (sources conflict on April 2026 figures). Add PSU, case, cooler, SSD. | about 3–5 W (est.) | No longer the cheap choice. | https://www.omgubuntu.co.uk/2026/02/raspberry-pi-annouce-more-price-rises, https://www.gigazine.net/gsc_news/en/20260402-raspberry-pi-price-increases, Tom's Hardware | M |
| Intel N100/N150 mini PC (e.g. GMKtec NucBox G3 Plus) | about **$150** (Feb 2026). Beelink EQ14 N150 about $369 (Oct 2026, RAM inflation). | about 6–10 W | Best value for go2rtc + Frigate (OpenVINO on the iGPU) + HA + a cry-detection model. | https://dev.to/selfhostingsh/best-mini-pcs-for-home-servers-in-2026-2b0i, https://esp32.co.uk/home-assistant-hardware-compared-green-raspberry-pi-5-mini-pc-nas/ | M |
| Old Android phone (Termux) | about $0 | about 1–3 W | OK for light scripts or a BLE relay. Reports of **battery swelling** after months on charge, so use a charge limit (about 80%) if available. Android background-kill issues. Not recommended for 24/7 video. | https://shop.zimaspace.com/blogs/support-tips/can-an-old-android-phone-become-a-home-server, lemmy anecdotes | M/L |
| Old iPhone | — | — | iOS can't run persistent background servers. Only useful as a dedicated foreground camera or monitor app. | Platform constraint (inference) | M |

**Running cost (inference):** a 7 W N100 is about 61 kWh/yr. At an assumed Thai residential tariff of about 4–5 THB/kWh (not verified), that is roughly 250–300 THB/yr.

### 3.3 Exposing local streams securely

- **Tailscale (recommended for the babycam):** the Personal plan is reportedly free for up to **6 users** with unlimited user devices since an April 2026 change, for non-commercial use. https://www.ssdnodes.com/learn/is-tailscale-free-plan-limits (M; check tailscale.com/pricing). Install it on the N100 and on both iPhones (and grandparents' devices if they are added as users). go2rtc's WebRTC or MSE then works directly over the tailnet. No public exposure, and no UDP or TURN headaches.
- **Cloudflare Tunnel:** free, outbound-only, fine for the HTTP UI or API. But (a) WebRTC media is UDP and generally won't traverse a tunnel. Forum users needed port 8555 forwarded or TURN (https://community.home-assistant.io/t/go2rtc-project-help-thread/454451?page=11, M). (b) Cloudflare's own docs warn against streaming video through the proxy outside paid video products (https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/, H on existence of policy; exact terms not fetched). **For grandparent streaming:** use Tailscale (add them as tailnet users), or have the N100 push HLS to a paid relay. Don't put video through a free Cloudflare Tunnel.
- **go2rtc:** RTSP→WebRTC/MSE/HLS. A newer stream viewer added an iPhone path because older iOS lacked MSE (forum report, M). The SwitchBot article recommends the `live1` sub-stream if lag occurs.

---

## 4. PWA on iPhone

| Item | Fact | Source | Conf. |
|---|---|---|---|
| Web Push | Works only for web apps **installed to the Home Screen** (Safari → Share → Add to Home Screen), iOS/iPadOS **16.4+**. Permission must be requested from a user gesture. | https://ionic.io/blog/safari-catches-up, https://webkit.org/?p=16535 | H |
| Declarative Web Push | Supported in Home Screen web apps from Safari/iOS **18.4** (some sources say 18.5). The server sends a JSON notification that is shown without running service-worker code, which is more reliable. It can also set the app badge. | https://webkit.org/?p=16535, https://progressier.com/pwa-capabilities/declarative-web-push | M-H |
| Reliability | Developer reports of subscriptions lost after long inactivity. Re-subscribe on each app open. | https://webscraft.org/blog/pwa-pushspovischennya-na-ios-u-2026-scho-realno-pratsyuye?lang=en | M |
| Background work | No background sync or periodic execution on iOS. All scheduled logic must be server-side (pg_cron). | Platform behaviour (inference, widely known) | M |
| HealthKit | Not available to web apps. | Platform constraint | H |
| Night UI | `<meta name="theme-color">` + `prefers-color-scheme`, plus a manual "red night mode" (CSS with black background and #300/#600 reds, very low luminance). Use `apple-mobile-web-app-status-bar-style=black-translucent`. | Design inference | M |

**Sending push from Supabase:** an Edge Function holds VAPID keys and uses a `web-push`-compatible library, or posts Declarative Web Push JSON to the subscription endpoint. Triggers come from pg_cron or a DB trigger, e.g. CO2 above a threshold, or the morning report being ready. Inference/M.

---

## 5. Health-data ingestion (infra side)

- **Fitbit / Google Health:**
  - Google says legacy Fitbit Web API support ended **2026-09-30**. Endpoints and Fitbit OAuth turn off **2026-11-02**, with HTTP 410 after that. Use the **Google Health API** (OAuth 2.0). All scopes are **Restricted** and need a privacy/security review. It offers intraday data via a list endpoint and "expanded webhook support".
  - Source: https://developers.google.com/health/about (H). Third-party posts claim Google is "not onboarding new projects at this time" (https://www.themomentum.ai/blog/fitbit-web-api-deprecation-google-health-migration, M) and that webhooks don't cover heart rate (forum, L).
  - **Open question:** whether a personal, unverified OAuth app in "testing" mode with your two accounts as test users can use the restricted scopes without the review. Not found. Verify early, because it decides whether you get raw Fitbit Air data at all.
  - Infra-wise, a pg_cron job that pulls daily or hourly into Postgres via an Edge Function fits the same pattern.
- **Apple Health:** a native bridge is required.
  - **Health Auto Export** (iOS app, updated 2026-03-24) has REST API automations with a Bearer header. Premium is needed for automations. https://apps.apple.com/app/id1115567069, https://github.com/irvinlim/apple-health-ingester (M)
  - Free alternative: an iOS Shortcuts personal automation ("Find Health Samples" → "Get Contents of URL" POST) at wake time (inference, M).
  - Endpoint: a Supabase Edge Function with a Bearer secret.

---

## 6. Nightly Claude analysis job, serverless

**Simplest option (recommended):**
1. pg_cron fires at about 06:30 ICT (pg_cron runs in UTC, so 23:30 UTC).
2. It calls an Edge Function or Vercel Function that queries the night's aggregates: CO2 / temp / RH per 5 min, AC command log, sleep stages, HR/HRV.
3. That function sends **one** Messages API call with **structured outputs** (`output_config.format` JSON schema) to produce the report JSON (scores, findings, chart annotations).
4. The result is stored in a `reports` table and triggers a Web Push.

Source: claude-api skill reference (cached 2026-10-06), H for API shapes.

**Wall-clock risk:**
- Supabase Free allows 150 s. A long, high-effort generation can exceed that. Options:
  - Run the job on a **Vercel Function** (300 s on Hobby).
  - Use **streaming** and keep the prompt compact. Pre-aggregate in SQL and send at most a few thousand tokens, not raw minute data.
  - Use the **Message Batches API** (async, **50% cheaper**): submit at 05:00, collect at 06:30 with a second cron.
- **Managed Agents** (Anthropic-hosted agent loop + sandbox) has **scheduled deployments** that fire sessions on a cron cadence with no client-side scheduler. That's overkill for one report, but useful if the agent should run code or produce charts itself (skill reference, M-H).

**Model and cost (cached 2026-10-06 skill table, H):**

| Model | Input $/MTok | Output $/MTok |
|---|---|---|
| `claude-opus-5-5` (default) | $4 | $20 |
| `claude-sonnet-5-5` | $2 | $10 |
| `claude-haiku-5-5` | $0.10 | $0.50 |

- **Example:** a nightly report of about 15k input + 3k output tokens on Opus 5.5 is about $0.12/night, about $3.6/month. Halve that with Batch (arithmetic inference).
- **API notes:**
  - Opus 5.5 always thinks. Its effort defaults to `medium`. `budget_tokens` and `temperature` are rejected.
  - Check `stop_reason` for `refusal`.

---

## 7. Powering and placing the Hub Mini (no ceiling outlet)

**Hub Mini facts:**
- **Hub Mini Matter Enabled**: USB-C, 5V⎓1A (support table says 5V1A/5V2A adapter), 65×65×20 mm, 36 g. https://support.switch-bot.com/hc/en-us/articles/13569889726743, https://smarthomescene.com/news/switchbot-is-releasing-a-new-matter-hub-mini/ (H/M). Older Hub Mini: micro-USB on some units.
- **Consumption:** 1–2 W. https://support.switch-bot.com/hc/en-us/articles/27957651411735 (H)
- **IR range:**
  - Original Hub Mini: up to **30 m line-of-sight**, 360° vertical, 180° horizontal (or 360° when hung vertically). https://www.manualslib.com/manual/3614133/Switchbot-Hub-Mini.html, https://www.howtogeek.com/824106/switchbot-hub-mini-review/ (M-H)
  - Hub Mini Matter manual: 360° horizontal and vertical. https://www.manualslib.com/manual/4145180/Switchbot-Hub-Mini-Matter.html (M)
  - One third-party guide says 7 m (outlier, L).
- **Placement guidance:** the IR emitter is to the right of the LED. Keep no walls or obstacles between the hub and the appliance, and adjust by trial. https://support.switch-bot.com/hc/en-us/articles/360037882334 (H)

**Recommended (inference, high practical confidence):**
- **Don't put the hub in the ceiling.** In one 40–50 m² open room, the dangling Toshiba/Carrier IR receiver is easily within 30 m. Mount the hub on a wall or high shelf near an outlet, aimed at the receiver. Command-strip it on top of a wardrobe or headboard shelf.
- Test with Learn mode and setAll before fixing it in place. IR also reflects off light walls, so near-line-of-sight usually works.
- The hub must also be in BLE range of the Meter Pro CO2 to relay it to the cloud. Same room, so fine.

**If you must reach a specific spot:**
- **USB-C extension or long USB-A→USB-C cable:**
  - Power-only runs of 3–5 m are fine for a 1–2 W load. Pick thicker VBUS conductors (e.g. 20–24 AWG) and a 5V/2A charger.
  - Beyond about 5 m, voltage drop becomes a concern. Better to use a 5 V charger at the far end on a short cable.
  - Flat adhesive cable raceway along the ceiling or cornice hides the run.
  - No specific product data found; voltage-drop guidance is engineering inference (M).
- **PoE → USB-C splitter:** 802.3af/at in, 5 V 2–2.4 A USB-C out (about 10–12 W). Needs a PoE switch or injector and an Ethernet run up to 100 m. These splitters don't support USB-PD or QC, which is fine for the hub. https://m.reach.dog/shop/poe-texas/products/af-usbc, https://www.electrokit.com/en/poe-extractor-usb-c-5v-2a, https://b2b.100mega.com/en/326425-xtendlan-xl-poes-5vuc (M). Overkill for a hub, but sensible if you later want a PoE camera or ESP32 up there.
- **Extending or relocating the AC's IR receiver:**
  - No source found for extending this Toshiba/Carrier receiver cable.
  - Toshiba manuals warn that the receiver won't work if the connector isn't connected, and that control wires must not be bundled with power wiring (https://manuals.online/toshiba/remote-control/rbc-axu33upb-e/user-manual/vjyw, M).
  - **Recommendation:** don't splice it yourself. Use an approved extension kit or a Toshiba/Carrier technician if relocation is really needed. Relocating the receiver is usually unnecessary given the hub's 30 m range.
  - Also, the receiver module's own 3 status LEDs are a light source (relevant to the pitch-black goal; handled in another dimension).

---

## 8. Suggested phased build (inference)

1. **Week 0:**
   - Plug the Meter Pro CO2 into USB-C and set a 1-min CO2 interval. Mount the Hub Mini on a wall with line of sight to the receiver.
   - Create the Supabase project with tables `readings`, `ac_commands`, `reports`, `push_subs`.
   - Create Edge Functions `switchbot-webhook` (verify_jwt off + secret path), `poll-meter` (pg_cron every minute), `ac-curve` (pg_cron every 5–10 min, 22:00–08:00) and `nightly-report`.
   - Register the webhook with `setupWebhook`.
   - Deploy the PWA (Next.js on Vercel Hobby) with Recharts/uPlot charts and Web Push.
2. **Week 1:** measure webhook vs poll lag. If it's poor, add an ESP32-C3 BLE sniffer (about $3–10) that POSTs decoded adverts.
3. **Phase 2 (babycam):** N100 mini PC (about $150, 6–10 W) running go2rtc + Frigate (+ an audio cry-detection model), plus Tailscale for parents and grandparents. Optionally HA OS in a VM for local BLE and IR fallback.


---

# Adversarial verification (independent fact-check)

# VERDICTS
- [partially-true] OpenAPI allows 10,000 calls/day. Meter Pro CO2 supports webhooks with temperature/humidity/CO2 (0-9999)/battery/timeOfSample in context. Only one webhook URL is accepted, and POSTs carry no signature.
  -> Confirmed in the README and devices/sensors/meter-pro-co2.md: the 10,000/day limit (going over returns 'Unauthorized'), the payload fields (plus deviceType, deviceMac and scale) and eventType 'changeReport'. The device status endpoint also returns CO2, so polling works. Not confirmed: the docs give no limit on webhook URLs. setupWebhook takes one url, queryUrl returns a 'urls' array, and deviceList only supports 'ALL'. 'Only one URL' comes from community experience, not the docs, so treat it as likely but unverified. The docs describe no webhook signing, which is consistent with 'no signature'. The 'changeReport' name suggests events may fire only on change, not on every sample. (https://raw.githubusercontent.com/OpenWonderLabs/SwitchBotAPI/main/devices/sensors/meter-pro-co2.md)
- [partially-true] AC IR command setAll '{temp},{mode},{fan},{power}'. Modes 1 auto, 2 cool, 3 dry, 4 fan, 5 heat. Fan 1 auto to 4 high. Learned buttons use commandType 'customize'.
  -> The format and values are correct. The current device doc lists modes as '0/1 (auto)'. Fan is 1 auto, 2 low, 3 med, 4 high. One caveat changes the design: setAll only works if the AC was added as a recognized 'Air Conditioner' code set (Smart Matching or Select Manually). For a Toshiba/Carrier ducted unit, matching may fail. Then the remote has to be added through 'Others' or 'Learn Buttons', where each button is learned separately (e.g. one per temperature). Those remotes accept only commandType 'customize' with the button name, and button names cannot be bare numbers 1-100 (use 'T20', not '20'). SwitchBot also notes that AC remotes send combined mode+temp frames, so mode and temperature cannot be learned separately. Week 1 must check whether a code set matches. (https://raw.githubusercontent.com/OpenWonderLabs/SwitchBotAPI/main/devices/others/virtual-infrared-remote-devices.md)
- [partially-true] Hub Mini draws 1-2 W from USB (Matter version USB-C 5V 1A); IR range up to 30 m line-of-sight.
  -> Power is confirmed: the official article covering Hub Mini, Hub Mini Matter Enabled and Hub 2 gives 1-2 W. The product page says '5V 1A/2A USB-powered'. I could not verify the 30 m IR range from an official source here (my search budget ran out). Treat it as a marketing figure. A ducted unit's wired IR receiver is a small window, so aim the hub at it. The page also says the Hub Mini supports 2.4 GHz Wi-Fi only, which the claims leave out. (https://support.switch-bot.com/hc/en-us/articles/27957651411735-Power-Consumption-of-SwitchBot-Hub-2-Hub-Mini)
- [partially-true] iOS Web Push only for Home Screen web apps on iOS 16.4+; Declarative Web Push arrived with Safari/iOS 18.4; PWAs cannot read HealthKit.
  -> The cited post (webkit.org/?p=16535) is the Declarative Web Push announcement. It says Declarative Web Push could be tested on iOS/iPadOS 18.4 and macOS 15.5 betas, and it mentions Home Screen web app push only as background. The 16.4 Home Screen requirement is correct but lives in a separate WebKit post. That HealthKit has no web API is correct as general knowledge, but this source does not cover it. (https://webkit.org/?p=16535)
- [partially-true] Raspberry Pi 5 prices rose three times in 2025-26 (8 GB about $125-175); N100 mini PC about $150 at 6-10 W; HA Green about $219 at about 2 W.
  -> The cited OMG Ubuntu article (Feb 2026) calls it the second round of rises, not the third. After it: 1 GB $45, 2 GB $65, 4 GB $85, 8 GB $125, 16 GB $205. The $175 upper figure and the N100 and HA Green numbers are not supported by this source and were not verified. (https://www.omgubuntu.co.uk/2026/02/raspberry-pi-annouce-more-price-rises)
- [partially-true] Cloudflare discourages video through its proxy outside paid video products; WebRTC UDP doesn't traverse a tunnel; Tailscale Personal free for 6 users.
  -> Cloudflare's policy does prohibit serving video through the proxy on Free/Pro/Business without paid video products, and Tunnel public hostnames fall under it. It also states 'The restriction does not apply to private network routes' (Tunnel plus WARP private networking), which the researcher missed. Tailscale's pricing page confirms the free Personal plan: up to 6 users, unlimited devices. The WebRTC/UDP-over-tunnel point was not checked against a source. (https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)
# ANSWERED
- Q: How often does SwitchBot cloud deliver Meter Pro CO2 webhooks?
  A: This is not documented, so it is only partly answered. The webhook eventType is 'changeReport', which suggests events fire on change, not every sample. SwitchBot's Meter Data Update Frequency article (it covers the Meter Pro CO2) says the meter samples every 4 s and saves every minute. It also says that once a hub uploads to the cloud, the recorded interval in the app and export depends on how much the temperature changes: about every 30 min when changes are small, and every 10 or even 2 min when they are larger. So cloud and webhook data are probably adaptive and sparser than 1 minute. Measure this in week 1. For guaranteed 1-minute data, poll /status every minute (1,440 calls/day, within the 10k limit) or read the BLE adverts locally.
- Q: Does the Pan/Tilt Cam Plus 3K firmware expose RTSP?
  A: Yes, officially. The current SwitchBot article (updated 2026-10-11) explicitly lists the Pan/Tilt Cam Plus 2K and 3K. Enable it under Settings > More Features > Camera Account, then use rtsp://user:pass@IP:554/live0 (HD) or /live1 (SD). The 'no RTSP' article is from 2023 and covers only older models. If the stream drops, toggle Camera Account off and on. Update the camera firmware first.
- Q: Can a personal unverified Google OAuth app use Restricted Google Health API scopes without review?
  A: Yes, it appears so. The Google Health app-verification page says an unverified app is limited to 100 users and that verification (OAuth review plus annual CASA) is needed only to support more users. Google Cloud's verification help says apps for personal use (fewer than 100 users) or in testing can skip verification, with users clicking through the unverified-app warning. One caveat from Google's general OAuth policy (not re-verified here): an External app left in 'Testing' publishing status gets refresh tokens that expire after 7 days. Set the app to 'In production' but unverified to avoid weekly re-auth. Google's pages do not say whether new projects are being onboarded; the migration page mentions a 'new console for registering your apps'.
- Q: Hub Mini variant and can its LED be fully disabled?
  A: Yes, the LED can be fully disabled. SwitchBot's indicator article: by default the LED stays on. Turning off 'Keep Turned on in Standby Mode' makes it off in standby with one blink per command. Turning off 'Indicator Light' makes it always off, even when sending commands. It still flashes at first power-on and in pairing mode. The user's idea that the Hub Mini has 'auto-dimming LEDs' is not accurate; it is a manual setting. Both Hub Mini variants are 1-2 W. The variant (Matter vs original) has to be read off the box.
- Q: Current Supabase free-tier numbers.
  A: 500 MB DB, 1 GB file storage, 500,000 Edge Function invocations, 5 GB egress plus 5 GB cached egress, pause after 1 week of inactivity, and 2 active free projects. The 2026-10-30 Data API grants change was not verified.
- Q: Does a CO2 interval under 1 minute meaningfully degrade accuracy?
  A: SwitchBot says only that it 'may' heat the device slightly and affect accuracy. It also notes the temp/humidity readings may then need the sample interval reset. Stated tolerance is ±(50 ppm + 5% of reading). No independent measurement was found. Keep the 1-minute default.
# MISSED
- For the 'pitch black, no beeps' goal: the Meter Pro CO2 has no Do Not Disturb mode, so alert sounds cannot be muted on a schedule (SwitchBot article 28611503749527). Turn off on-device sound alerts and send alerts through the app or PWA. Its display is not backlit (article 27211671722775), so it gives off no light.
- The Pan/Tilt Cam Plus 3K manual says the LED shows solid green whenever the camera is online. I found no confirmed setting to turn it off, so plan on tape or an in-app toggle check. Its night-vision IR LEDs also glow faintly. Power is 5V 2A.
- The AC control path depends on code matching. If the Toshiba/Carrier ducted unit has no matching AC code set, it must be added through 'Others' or 'Learn Buttons'. Then setAll does not work: every state (e.g. cool 20C auto fan) must be learned as its own button and triggered with commandType 'customize'. Button names cannot be bare numbers 1-100. 'Others' remotes also do not work with Alexa or Google Home.
- Calibration: the Meter Pro CO2 manual recommends battery power when calibrating CO2. SwitchBot's check procedure is outdoors for 5 minutes, where a reading of 400-500 ppm is normal. Its stated CO2 tolerance is ±(50 ppm + 5% of reading). Manual calibration is in the app (v9.4+).
- Possible calibration drift (inference, not confirmed): if the sensor is a Sensirion SCD4x-type photoacoustic NDIR (not confirmed for the Meter Pro CO2), automatic self-calibration assumes weekly exposure to about 400 ppm air. In a sealed, unventilated bedroom that rarely reaches 400 ppm, ASC could drift low. Take the meter outside periodically, or do a manual outdoor calibration.
- Cloud data resolution: the SwitchBot cloud and app history records adaptively, about every 2-30 min depending on how much readings change, not every minute. For true 1-minute series, poll /v1.1/devices/{id}/status every minute or read the BLE adverts locally.
- The Hub Mini supports 2.4 GHz Wi-Fi only.
- The Meter Pro CO2's own colour bands are green 400-1000, yellow 1000-1400 and red 1400+ ppm (manual). Its recommended operating range is 5-60C and 20-80% RH, and long exposure outside that may age the device. This matters near the open bathroom.
- The Fitbit legacy API turns off on 2026-11-02, five days from today. The Google Health API's categories are calories, vitals, skin temperature, workouts, nutrition, steps, sleep & recovery and women's health. The docs did not confirm whether intraday or raw heart rate/HRV is exposed, so check that before promising 'raw' data.
- SwitchBot publishes an official Frigate setup guide for its cameras (support article 35928989867799), which fits the planned local babycam AI box.
- Cloudflare Tunnel private network routes (via WARP) are exempt from the video restriction, so Cloudflare is a possible alternative to Tailscale.