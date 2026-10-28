# SwitchBot OpenAPI v1.1: deep dive for the Hub Mini, Meter Pro CO2 and Pan/Tilt Cam Plus 3K

Research date: 2026-10-28. The main source is the official README on the `main` branch of https://github.com/OpenWonderLabs/SwitchBotAPI, which I downloaded and read in full today. The README now delegates per-device specs to `devices/**/*.md` files, and I read the relevant ones. I also checked SwitchBot support articles through the Zendesk JSON API, recent GitHub issues, and package registries.

Confidence labels:
- **H**: verified from a primary source today.
- **M**: secondary source, or a single report.
- **L**: inference.

---

## 1. Basics

| Item | Value | Source | Conf. |
|---|---|---|---|
| Base URL | `https://api.switch-bot.com`; paths are prefixed `/v1.1/` | README "Host Domain" https://github.com/OpenWonderLabs/SwitchBotAPI#host-domain | H |
| Methods | GET, PUT, POST, DELETE. POST uses `Content-Type: application/json; charset=utf8` | README | H |
| Daily limit | **10,000 calls/day**. The README says going over returns "Unauthorized" (401). A 2026 user report observed **HTTP 429** with an `X-RateLimit-Remaining: 0` header instead | README "Request limit"; issue #518 https://github.com/OpenWonderLabs/SwitchBotAPI/issues/518 | H (limit) / M (429 and header) |
| Reset time | Not documented. Issue #518 (Oct 27 2026) saw resets roughly every 24.00 h at about 15:11–15:17 UTC, drifting later. This looks like a rolling window anchored to first use, not midnight. On 2026-10-26 the reset failed for about 34 h. No staff reply | #518 | M |
| Usage terms | "limited to personal uses"; commercial or large-scale use needs the Enterprise API | README intro | H |
| v1.0 | Legacy; no new devices are added to it. Use v1.1 | README "About the New Version" | H |
| Getting a token | App ≥ V9.0: Profile > Preferences > About, tap App Version 10× > Developer Options > Get Token (gives token and secret) | README "Getting Started" | H |

### Authentication headers (v1.1)
| Header | Value |
|---|---|
| `Authorization` | open token |
| `t` | 13-digit epoch milliseconds |
| `nonce` | a random UUID |
| `sign` | `Base64(HMAC-SHA256(key=secret, msg=token + t + nonce))` |

Source: README "Request Header" and "How to Sign?" (H).

**Doc inconsistency (H):**
- The prose pseudo-code says `HMAC-SHA256(token + t, secret).toUpperCase()`. It leaves out the nonce and uppercases the result.
- The official Python 3 and JavaScript samples base64-encode the digest and do **not** uppercase it. They include the nonce.
- Real clients split:
  - The official `@switchbot/openapi-cli` 3.9.0 (in its `src/auth.ts`) does `.digest("base64").toUpperCase()`.
  - `switchbot-api` 2.13.1 (SeraphicCorp, used by Home Assistant) sends plain base64 without uppercasing.
- Both clients are in production, so the server apparently accepts either form. This is inference from working code (M).
- **Recommendation:** follow the official sample: base64, include the nonce, no uppercase.

Deno/TypeScript signing, suitable for a Supabase Edge Function or a Vercel function:
```ts
async function sbHeaders(token: string, secret: string) {
  const t = Date.now().toString();
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token + t + nonce));
  const sign = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return { Authorization: token, t, nonce, sign, "Content-Type": "application/json; charset=utf8" };
}
```

### Response envelope and error codes (H, README)
Every response has the form `{statusCode, message, body}`; success is `statusCode: 100`.

| Code | Meaning |
|---|---|
| 151 | Device type error |
| 152 | Device not found |
| 160 | Command not supported |
| 161 | Device offline |
| 171 | **Hub offline** |
| 190 | Device internal error / state not synced, or an invalid command format |
| HTTP 401 | Bad token |

Two quirks:
- `switchbot-api` notes that some devices return 171 when it is the device, not the hub, that is offline. Treat 161 and 171 as the same "offline" case (M; source https://github.com/SeraphicCorp/py-switchbot-api, `__init__.py`).
- The official CLI advises honouring `Retry-After` on 429, and says a 429 does not by itself prove the daily quota is used up (M; CLI README in the npm tarball).

---

## 2. Endpoints

| Purpose | Method and path | Body |
|---|---|---|
| List devices and IR remotes | `GET /v1.1/devices` | none |
| Device status | `GET /v1.1/devices/{deviceId}/status` | none |
| Send command | `POST /v1.1/devices/{deviceId}/commands` | `{command, parameter, commandType}` |
| List manual scenes | `GET /v1.1/scenes` | none |
| Run a scene | `POST /v1.1/scenes/{sceneId}/execute` | none |
| Register webhook | `POST /v1.1/webhook/setupWebhook` | `{"action":"setupWebhook","url":"https://…","deviceList":"ALL"}` (only "ALL" is supported) |
| Query webhook | `POST /v1.1/webhook/queryWebhook` | `{"action":"queryUrl"}` or `{"action":"queryDetails","urls":["https://…"]}` |
| Update webhook | `POST /v1.1/webhook/updateWebhook` | `{"action":"updateWebhook","config":{"url":"https://…","enable":true}}` |
| Delete webhook | `POST /v1.1/webhook/deleteWebhook` | `{"action":"deleteWebhook","url":"https://…"}` |

Source: README sections Devices, Scenes and Webhook (H). The README's `queryDetails` table names the field `url`, but its example uses `urls: []`. Use the array form, as in the example (H that the doc is inconsistent).

**History endpoint: none exists (H).** The README defines only a current-status call. Issue #506 (Aug 18 2026) requests `GET /v1.1/devices/{id}/history?startTime&endTime&interval`; it is open and labelled enhancement, with no staff reply (https://github.com/OpenWonderLabs/SwitchBotAPI/issues/506).

The app keeps cloud history and can export CSV, but not through the API. You must store your own time series, for example in Supabase.

The new official CLI has `devices diary --start --end`, but it is only for **Kata Friends**, with windows of up to 31 days (CLI README, H).

Sample `GET /v1.1/devices` response (README):
```json
{"statusCode":100,"body":{
 "deviceList":[{"deviceId":"500291B269BE","deviceName":"…","deviceType":"Humidifier","enableCloudService":true,"hubDeviceId":"000000000000"}],
 "infraredRemoteList":[{"deviceId":"02-202008110034-13","deviceName":"Living Room TV","remoteType":"TV","hubDeviceId":"FA7310762361"}]},
 "message":"success"}
```

---

## 3. Your three devices in the API

The feature matrix comes from the README section "Device Specifications and Supported Features List" (H).

| Device | Model | List | Status | Command | Webhook | `deviceType` string |
|---|---|---|---|---|---|---|
| Hub Mini | W0202200 | ✓ | **–** | – | – | `Hub Mini` (devices/hubs/hubhub-plushub-minihub-2hub-3.md) |
| Meter Pro (CO2 Monitor) | W4900010 | ✓ | ✓ | – | ✓ | **`MeterPro(CO2)`** (no spaces; devices/sensors/meter-pro-co2.md) |
| Pan/Tilt Cam Plus 3K | W4001100 | ✓ | **–** | **–** | **–** | `Pan/Tilt Cam Plus 3K` (devices/cameras/pantilt-cam-plus-3k.md) |
| Virtual IR remotes (made on the Hub Mini) | n/a | ✓ (`infraredRemoteList`) | – | ✓ | – | `remoteType` = e.g. `Air Conditioner`, `Others` |

What this means for your setup:
- **Hub Mini:** it has no sensors, so there is no status to read. In `deviceList` its `hubDeviceId` is `000000000000`.
  - The Matter-enabled Hub Mini may report a different string. node-switchbot issue #335 (Sep 24 2026) mentions an unmapped `Hub Mini2` type (M, https://github.com/OpenWonderLabs/node-switchbot/issues/335).
  - Read the actual string from `/devices` rather than hard-coding it.
- **Pan/Tilt Cam Plus 3K:** the API only lists it. There is no motion webhook, no pan/tilt or PTZ commands and no stream URL (H).
  - Only the **original Pan/Tilt Cam** (`WoPanTiltCam`) and the Indoor Cam send a webhook, `{"detectionState":"DETECTED"}` (devices/cameras/pantilt-cam.md).
  - For babycam features you will need something other than the OpenAPI (out of scope for this dimension).
- **Meter Pro CO2 status fields** (H, devices/sensors/meter-pro-co2.md):
  - `deviceId`, `deviceType`, `hubDeviceId`
  - `battery` (int 0–100)
  - `version` (firmware string)
  - `temperature` (float °C)
  - `humidity` (int %)
  - **`CO2` (int ppm, 0–9999; note the capital letters)**

  ```json
  GET /v1.1/devices/{id}/status  →
  {"statusCode":100,"body":{"deviceId":"…","deviceType":"MeterPro(CO2)","hubDeviceId":"…","battery":100,"version":"V1.x","temperature":24.1,"humidity":52,"CO2":812},"message":"success"}
  ```
  The structure is from the docs; the values are illustrative.
- **The CO2 alarm/buzzer cannot be controlled via the API or BLE.** Issue #491 (Jun 2026) asks for this, with no staff reply (H, https://github.com/OpenWonderLabs/SwitchBotAPI/issues/491). For a pitch-black, silent bedroom, disable the buzzer and screen in the app; you cannot schedule it from your own code.

### The BLE-only device needs the hub (H)
- The Meter Pro CO2 is Bluetooth. Remote and cloud access, including the API, needs a SwitchBot hub.
- Since app V9.0 there is no "Cloud Services" toggle. You place the meter in BLE range of the hub and it pairs automatically. The Hub Mini, Hub 2 and Hub Mini Matter are listed as compatible.
  - Support article "Is It Possible to Use the CO2 Value…", updated 2026-06-24: https://support.switch-bot.com/hc/en-us/articles/26500881438999
  - README "Legacy Cloud Services"
- The README note on `GET /devices` still says to "enable Cloud Services" for BLE devices; this is out of date.
- Once linked, the CO2 value can be used as a condition in **SwitchBot app automations**, for example to fire an IR AC or fan command with no server at all (H, same article).

### How fresh is the data (decision-critical)
- **CO2 sampling** (support article "Update Frequency of CO2 Readings", updated 2026-10-27, https://support.switch-bot.com/hc/en-us/articles/26502008033303), all H:
  - On batteries, CO2 updates every **30 min** and this cannot be changed.
  - On **5V/1A USB-C**, it updates every **1 min**, and the interval can be changed in the app under Gear > Panel Display > Data Update Interval > CO2.
  - Intervals under 1 min keep the sensor on continuously, which warms the unit and hurts accuracy.
  - Changes under ±20 ppm may not be displayed.
  - **Keep it on USB power.**
- **Cloud upload** (support article "SwitchBot Meter Data Update Frequency", applies to the Meter Pro CO2, https://support.switch-bot.com/hc/en-us/articles/25328810947351), H:
  - The meter samples every 4 s and saves every minute.
  - What reaches the server and the export is adaptive: about **every 30 min when stable**, 10 min or even 2 min when values change.
  - So polling `/status` every minute will often return the same value. A third-party review puts hub-to-cloud updates at about 10 min (M).
- **Polling budget:** one device polled every 60 s uses 1,440 calls/day, within the 10,000 limit. Home Assistant's cloud integration polls every 600 s (https://www.home-assistant.io/integrations/switchbot_cloud/, H).
- If you need truly fresh 1-min CO2 data, the only path is local **BLE**. That needs an always-on BLE device near the meter, such as an ESP32 Bluetooth proxy or a Pi. With the cloud-only setup you have, plan for **2–30 min effective resolution** (L, inferred from the above).

---

## 4. Controlling the aircon through the Hub Mini IR (virtual remote)

Source: devices/others/virtual-infrared-remote-devices.md (H).

| remoteType | commandType | command | parameter |
|---|---|---|---|
| all types except Others | `command` | `turnOn` / `turnOff` (case-sensitive) | `default` |
| **Air Conditioner** | `command` | **`setAll`** | `"{temperature},{mode},{fan speed},{power state}"`, e.g. `"26,1,3,on"` |
| any remote with learned or custom buttons, and `Others` | **`customize`** | *the button's name exactly as in the app* | `default` |

`setAll` codes (H):
- **Mode:** 0 or 1 = auto, 2 = cool, 3 = dry, 4 = fan, 5 = heat.
- **Fan:** 1 = auto, 2 = low, 3 = medium, 4 = high.
- **Power:** `on` / `off`.
- Temperature is in °C.

Examples:
```http
POST https://api.switch-bot.com/v1.1/devices/02-202007201626-70/commands
{"command":"setAll","parameter":"19,2,2,on","commandType":"command"}   // 19°C, cool, low fan, on
→ {"statusCode":100,"body":{},"message":"success"}

POST …/devices/02-202007201626-10/commands
{"command":"ECO SLEEP","parameter":"default","commandType":"customize"}  // a learned button
```

Caveats:
- **Send the temperature as an integer.** Home Assistant issue #130516 (Nov 2024) found the AC always switching to cooling until the fix forced integer temperatures. A contributor also mentioned a SwitchBot-side fix (M, https://github.com/home-assistant/core/issues/130516). The official CLI only accepts integer `--temp` from 16 to 30 (H, CLI source).
- **Infrared is one-way, so there is no state feedback.** The API has no status call for IR remotes. Your app only knows the last command it sent, and someone using the physical remote breaks that assumption (H: the Status column is "–" for virtual IR remotes; masakasakasama PR #19 says the same).
  - Use the Meter Pro CO2 temperature, and its trend after a command, as indirect confirmation (L).
- **Each `setAll` sends the whole state** (temperature, mode, fan and power) in one IR frame, the way most AC remotes work. It does not send increments. This means an `on` command to a unit that is already on is generally safe (L; standard AC IR behaviour).
- **Special functions are not in `setAll`.** Toshiba/Carrier features such as Hi-Power, ECO SLEEP, swing and PRESET need **learned custom buttons** sent with `commandType:"customize"`.
  - A support guide says AC remotes added in "Customize" mode only support on/off. It recommends the "Other" learning mode plus "Test" for custom buttons (M; manuals.plus Hub 2 troubleshooting).
- **Line of sight:** the IR blaster has to see the dangling wired IR receiver module on the ducted unit. This is physical placement, not an API limit (L).
- **Scenes:** you can also build "Night 19 °C" scenes in the app and run them with `POST /v1.1/scenes/{id}/execute`. The API lists **manual** scenes only (H).

---

## 5. Webhooks

- **Register:** `setupWebhook` with `deviceList:"ALL"`; there is no per-device filter yet (H).
- **One URL per account:**
  - Home Assistant says "Only ONE webhook URL seems to be accepted," so multiple consumers need a fan-out proxy (M; https://www.home-assistant.io/integrations/switchbot_cloud/).
  - The API returns `urls` as an array, which hints that several might be possible, but this is undocumented (L).
  - **Plan one endpoint**, for example a Supabase Edge Function, and fan out from it.
- **No delivery signature is documented** (H, absence in the README). Put a long random secret in the URL path or query, e.g. `/switchbot-webhook/<random>`, and check that `deviceMac` is one of your devices (L).
- **Common event envelope (H):** `{eventType:"changeReport", eventVersion:"1", context:{deviceType, deviceMac, …, timeOfSample}}`.
- **Meter Pro CO2 event (H, devices/sensors/meter-pro-co2.md):**
  ```json
  {"eventType":"changeReport","eventVersion":"1","context":{"deviceType":"MeterPro(CO2)","deviceMac":"XX:…","temperature":22.5,"scale":"CELSIUS","humidity":31,"CO2":1203,"battery":100,"timeOfSample":123456789}}
  ```
  - `deviceMac` is the MAC address, while `/devices` uses a `deviceId` that is the MAC without colons, uppercase. Normalise both before joining them (L, based on the README samples: deviceId "C271111EC0AB").
  - `timeOfSample` is in ms in practice (L).
- **Which devices push events:** meters (Meter, Plus, Pro, Pro CO2, Outdoor), Hub 2/3, sensors, locks, curtains, plugs, the original Pan/Tilt Cam and Indoor Cam. **Not** the Hub Mini, **not** the Pan/Tilt Cam 2K / Plus 2K / Plus 3K, **not** IR remotes (H, feature matrix).
- **How often:** not documented (H, absent). Events are pushed on change ("changeReport"), and the cadence follows the adaptive cloud-upload behaviour above (L/M). One Hub 2 user saw two events 15 minutes apart with identical values, which suggests a heartbeat or coarse sampling (M, #502).
- **Reliability: mixed. Do not use webhooks as the only data source.**
  - Issue #502 (Aug–Sep 2026, Hub 2): registration succeeded and `queryDetails` showed `enable:true`, but **no events arrived for weeks**, apart from a `deviceMac:"TESTMAC"` placeholder after each re-registration. Some later events carried stale values. Delivery recovered on its own around Sep 20. No staff reply (M, https://github.com/OpenWonderLabs/SwitchBotAPI/issues/502).
  - Issue #407 (2025, Lock Pro): no events received. A staff-adjacent contributor could not reproduce it; one user's cause turned out to be their own Home Assistant `local_only` setting (M, https://github.com/OpenWonderLabs/SwitchBotAPI/issues/407).
  - Issue #513 (Sep 2026): a webhook `lockState` value did not match the status API (M).
  - **Recommended pattern:** use webhooks for low-latency ingest, plus a scheduled poll as a reconciler, for example `pg_cron` or Vercel cron every 2–5 min calling `/status`. Deduplicate on (device, timeOfSample) (L).
  - Expect a `TESTMAC` placeholder event after each setup and filter it out (M, #502).

---

## 6. Undocumented: MQTT real-time "shadow" stream (found in official tooling)

The official `@switchbot/openapi-cli` 3.9.0 is published by OpenWonderLabs; the repository is github.com/OpenWonderLabs/switchbot-openapi-cli, first published 2026-04-17 and updated 2026-10-13. It includes `switchbot events mqtt-tail`. Its source (H, read from the npm tarball):
- Calls `POST https://api.switchbot.net/v1.1/iot/credential` with the normal HMAC headers and `{instanceId}`.
- Gets back `body.channels.mqtt = {brokerUrl, clientId, tls:{caBase64, certBase64, keyBase64}, topics:{status}}`.
- Connects with mutual TLS and subscribes to `topics.status`. The payloads look like webhook `context` objects or `state` objects.

Caveats:
- This endpoint is **not in the public README**, so it may change (M).
- It needs a **persistent connection**, which serverless (Vercel/Supabase functions) cannot hold. You would need a small always-on process, for example a cheap VM or Fly.io (L).
- The CLI also ships an MCP server (`switchbot mcp serve`) and a rules daemon whose rules can include an LLM condition. This could help an agent built on your Anthropic API key (H that it exists).

---

## 7. SDKs and libraries: status as of Oct 2026

Versions checked live on npm and PyPI today (H).

| Library | Transport | Latest | Status / notes |
|---|---|---|---|
| **@switchbot/openapi-cli** (official, OpenWonderLabs) | Cloud v1.1, MQTT, MCP | 3.9.0 (2026-10-13) | Active. Full v1.1, webhook commands, `setAll` helpers (`--temp 16-30 --mode cool --fan low`), local quota tracking, MCP server |
| **node-switchbot** (OpenWonderLabs) | BLE with OpenAPI fallback | 5.2.3 (6.0.0-beta.1; modified 2026-10-25) | Active. Before PR #336 (Sep 2026), `MeterPro(CO2)` from the API was dropped as an unknown type; use ≥ that fix |
| **@switchbot/homebridge-switchbot** (official) | HomeKit via Homebridge | 5.2.5 (2026-10-25) | Active; issue #1197 asked about the CO2 output. (The unscoped npm `homebridge-switchbot` 0.1.0 from 2022 is unrelated and stale) |
| **PySwitchbot** (sblibs; used by Home Assistant's local BLE `switchbot` integration) | BLE only | 3.1.0 (2026-10-16) | Active. HA 2026.3.0 broke Meter Pro CO2 discovery via BT proxies; fixed in 2026.4.0 (HA #164817) |
| **switchbot-api** (SeraphicCorp/py-switchbot-api; used by HA `switchbot_cloud`) | Cloud v1.1 (async) | 2.13.1 (2026-10-19) | Active. setup/query/delete webhook, `send_command(commandType=…)` |
| **python-switchbot** (jonghwanhyeon) | Cloud v1.1 | 2.3.1 (2023-04-09) | Stale; avoid |
| Home Assistant `switchbot_cloud` | Cloud | n/a | Polls every 600 s; IR AC climate entity; Meter Pro CO2 sensor; webhook only for some devices |

Library sources:
- https://www.npmjs.com/package/node-switchbot
- https://www.npmjs.com/package/@switchbot/homebridge-switchbot
- https://pypi.org/project/PySwitchbot/
- https://pypi.org/project/switchbot-api/
- https://github.com/home-assistant/core/issues/164817

---

## 8. Recommended architecture

All of this is inference (L), built on the facts above.
1. Put the Meter Pro CO2 on USB power with a 1-min CO2 interval, paired to the Hub Mini. Turn off its alarm and screen in the app.
2. Run a Supabase Edge Function as the webhook receiver. Register it with `setupWebhook`, put a secret in the path, and insert rows into a `readings` table.
3. Run `pg_cron` every 2–5 min to poll `/devices/{co2}/status` as a gap-filler, at about 300–700 calls/day.
4. Write a control function that sends `setAll` with integer temperatures and logs each command as "assumed AC state". Add learned `customize` buttons for ECO SLEEP and Hi-Power.
5. Optional: run an always-on worker for the MQTT shadow stream, or later an ESP32 BLE proxy, for real-time data.
6. Store your own history, because the API has none.


---

# Adversarial verification (independent fact-check)

# VERDICTS
- [partially-true] The API base is https://api.switch-bot.com/v1.1. Authentication uses the headers Authorization, t, nonce and sign = Base64(HMAC-SHA256(secret, token+t+nonce)). The README prose says to uppercase the sign, while its samples do not.
  -> The base URL, headers and HMAC construction are right. 'Its samples do not' is wrong: the README's PHP sample (strtoupper(base64_encode(...))) and Go sample (strings.ToUpper(...)) both uppercase the sign, while the Python, JS, C#, Java and Swift samples do not. The README prose itself is also sloppy: it says 'HMAC-SHA256(token + t, secret).toUpperCase()' and leaves out the nonce. The official @switchbot/openapi-cli v3.9.0 uses createHmac('sha256', secret).update(token+t+nonce).digest('base64').toUpperCase() at dist/index.js line 5534, so uppercase is the vendor's own current choice. Use uppercase base64. (https://github.com/OpenWonderLabs/SwitchBotAPI#how-to-sign)
- [partially-true] The limit is 10,000 calls per day. The reset is undocumented and was observed as a rolling roughly 24-hour window. Once exhausted, a 2026 report saw HTTP 429 with X-RateLimit-Remaining: 0, while the README says 401.
  -> The 10,000/day limit is confirmed. The README says going over it returns 'Unauthorized', and its error table separately lists 429. Issue #518 (opened 2026-10-27, still open) confirms HTTP 429 with X-RateLimit-Remaining at 0. It does not describe a simple rolling window. The counter reset at a fixed time every day (about 15:16-15:17 UTC, drifting 0-15 s per day) for 35 days. On 2026-10-26 the reset was skipped and the counter kept falling for about 34 h, which left the account locked out for over 12 h. The reporter also saw unexplained lockouts in May, August and September 2026. The reporter guesses the window resets 24 h after the first request of the previous window, but that is speculation. The CLI README adds that a 429 is not necessarily daily-quota exhaustion and that clients should honor Retry-After. Budget well under 10k, for example under 5k/day, and handle multi-hour lockouts. (https://github.com/OpenWonderLabs/SwitchBotAPI/issues/518)
- [partially-true] Send the setAll temperature as an integer. A 2024 Home Assistant bug made the AC always switch to cool until temperatures were forced to integers. The official CLI accepts only 16-30.
  -> HA issue #130516 (Nov 2024, closed Dec 2024 via PR #132231) was mostly a SwitchBot server-side bug that SwitchBot fixed; the 'always cool' symptom was not caused only by decimals. The integer cast was a separate fix that HA also added. Current HA code sends f"{int(new_temperature)},..." with temperature step 1. The CLI v3.9.0 does reject temperatures outside integers 16-30 ('setAll field 1 (temp) must be an integer 16-30'). The practical conclusion stands: use whole degrees between 16 and 30. (https://github.com/home-assistant/core/issues/130516)
- [partially-true] Meter Pro CO2 readings update every 30 min on battery (fixed) and every 1 min on 5V/1A USB-C (configurable). Cloud upload through the hub is adaptive: about 30 min when stable, 10 or 2 min when values change.
  -> The battery figure (30 min, not customizable) and the USB 5V/1A figure (switches automatically to 1 min, adjustable in the app) match SwitchBot's support article as quoted in search results. That article also warns that setting the interval below 1 minute keeps the CO2 sensor running continuously, which may warm the device and reduce accuracy. I could not verify the adaptive cloud-upload cadence (30, 10 or 2 min) against any primary source, because the support pages return 403 to fetches and searches found nothing. Treat it as unverified and measure it. (https://support.switch-bot.com/hc/en-us/articles/26502008033303-Update-Frequency-of-CO2-Readings-on-SwitchBot-Meter-Pro-CO2-Monitor)
- [partially-true] Webhooks are registered with deviceList 'ALL' only, carry no documented signature, and in practice only one URL is accepted. The Meter Pro CO2 pushes changeReport events. Delivery has failed silently for weeks in 2026 reports.
  -> 'ALL' only, no documented signature, and the changeReport payload are all confirmed. On the single URL: HA core's code comments 'it seems is impossible to register multiple webhook' and deletes the old URL before registering a new one, so this is an inference, not an official limit. Issue #502 concerns Hub 2 lightLevel events, not the Meter Pro CO2. Its confirmed outage ran about 6 days (Aug 5-11, 2026), plus partial anomalies with stale values on Sep 18-22. No official reply or root cause was given, and delivery recovered by about Sep 20. 'Weeks' overstates it. The design conclusion still holds: back webhooks with polling. (https://github.com/OpenWonderLabs/SwitchBotAPI/issues/502)
- [unverifiable] The Meter Pro CO2 is BLE and needs a hub for cloud and API access. Since app V9.0 it auto-links in BLE range. CO2 can be used as a condition in app automations.
  -> That a hub is required for cloud access is confirmed by the README ('You MUST first add a SwitchBot Hub such as Hub 2, Hub Mini with Matter Enabled, or Hub Mini' and 'enable Cloud Services'), and the device list carries hubDeviceId. I could not verify the app V9.0 auto-link or CO2-as-automation-condition details, because the support article returns 403. These are plausible, so check them in the app. (https://github.com/OpenWonderLabs/SwitchBotAPI#get-device-list)
# ANSWERED
- Q: What deviceType does a Hub Mini (Matter Enabled) report?
  A: No official doc gives it. The hubs doc lists only 'Hub', 'Hub Plus', 'Hub Mini', 'Hub 2' and 'Hub 3', and there is no separate Matter-enabled hub file. Retail listings give the Matter Hub Mini's model as W0202203, while the README glossary lists the Hub Mini as W0202200. Call GET /v1.1/devices to find out. It doesn't matter much because the hub is list-only. The code should key on the meter's hubDeviceId, not on the hub's type string.
- Q: Does the server accept uppercased and plain base64 signs?
  A: There is no official statement. The README samples use both forms (PHP and Go uppercase; Python, JS, C#, Java and Swift don't), and the official CLI v3.9.0 uppercases. Both forms evidently work in practice. Use uppercase to match the vendor's current client.
- Q: Can more than one webhook URL be registered?
  A: It is not documented, and the evidence points to one URL in practice. HA core's switchbot_cloud code says 'it seems is impossible to register multiple webhook' and deletes the existing URL before setting up its own. If they also use HA or another integration later, it will overwrite the app's URL. Use one fan-out endpoint.
- Q: Is the MQTT iot/credential endpoint stable and what is its credential lifetime?
  A: It is used by the vendor-official @switchbot/openapi-cli v3.9.0 (OpenWonderLabs) but is not in the public API README. It returns AWS IoT mutual-TLS credentials (CA, cert and key as base64), a brokerUrl, a clientId and topics.status. The credentials expire (the CLI has a 'credential expired' path and re-provisions), but the lifetime isn't stated. Whether it is faster than webhooks for the Meter Pro CO2 has to be measured. It needs a persistent MQTT client, which serverless Vercel/Supabase functions can't hold.
- Q: When exactly does the daily quota reset?
  A: It is undocumented. Issue #518 observed a reset at a fixed time each day, about 15:16-15:17 UTC, possibly anchored to the account's first request, for 35 days. One reset was then skipped and the account was locked out for more than 12 h. Read X-RateLimit-Remaining on every response and treat 429s as possibly lasting for hours.
# MISSED
- Running the CO2 meter at an interval under 1 minute keeps the sensor continuously on, which may warm the device and reduce temperature and CO2 accuracy (SwitchBot support article). That matters for the temperature control loop in an 18-20C bedroom.
- Scenes API: GET /v1.1/scenes and POST /v1.1/scenes/{id}/execute run manual scenes built in the app. This is a useful path for AC states that must be learned (Toshiba ECO SLEEP, Hi-Power), with the scene wrapping the custom IR button.
- The AC also accepts plain turnOn and turnOff. The IR doc has no swing or eco parameters in setAll, so any Toshiba-specific mode needs learned buttons.
- The README says the API is 'prohibited for commercial uses or for large-scale applications'. That is fine for personal use, but it explains the strict quota.
- POST /v1.1/webhook/updateWebhook can enable or disable the webhook and change its URL, and queryWebhook returns a 'urls' array. Webhooks carry no signature, so the receiving URL must contain a secret token.
- The official CLI (v3.9.0) ships Claude Code and Gemini plugins plus a 'rules/daemon' engine with mqtt, cron and webhook triggers and an 'llm' condition. It is a ready-made reference, but it needs a persistent host.
- The README's CLI notes say a 429 can be throttling rather than daily-quota exhaustion, and clients should honor Retry-After.
- The Hub Mini has no sensors, so there is no API status for it, and IR success cannot be confirmed through the API. The meter's temperature trend is the only feedback.