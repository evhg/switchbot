# SwitchBot Pan/Tilt Cam Plus 3K: research report for a sleep and baby-cam system

Research date: 2026-10-28. Primary sources were SwitchBot's Zendesk help center (read through its JSON API, with `updated_at` dates checked), the official manual (Alza-hosted PDF), switch-bot.com and switchbot.jp product data, the OpenWonderLabs/SwitchBotAPI repo, go2rtc source, and the hsakoh HA integration source.

---

## 0. Summary of decision-critical findings

1. **Local RTSP is officially supported on the Plus 2K and Plus 3K.** It is off by default and you turn it on by creating a "Camera Account" in the app. The URLs are `rtsp://user:pass@IP:554/live0` (HD main stream) and `/live1` (SD sub-stream). The old "no RTSP" FAQ and pre-2025 reviews only apply to the older Tuya-based models. Confidence: high.
2. **ONVIF is stated in the DE/NL/ES versions of the same article (port 2020, with PTZ), but the current EN-US version no longer mentions ONVIF.** Third-party reports say ONVIF PTZ coverage is incomplete. Treat ONVIF as "probably present, flaky." Confidence: medium.
3. **The SwitchBot OpenAPI gives you almost nothing for this camera.** The Plus 3K (`W4001100`) only appears in the device list. It has no status, no commands and no webhook. Only the old Indoor Cam and Pan/Tilt Cam (1080p) send motion webhooks. Confidence: high.
4. **The camera has no on-device cry or sound detection.** Detection covers motion, human, pet and vehicle. Cry detection has to be built yourself, for example with Frigate's `crying` audio label or your own audio model. Confidence: medium-high, based on absence across official docs plus Frigate docs.
5. **Night vision uses 940 nm infrared, which SwitchBot officially calls "invisible" and suitable for sleeping.** The **red/green status LED** is listed on the official spec page. The device protocol has an `isOpenIndicatorLight` on/off property, which the open-source integration exposes as a switch, so the LED can be turned off. I could not find official documentation of an app toggle. Confidence: medium.
6. **Architecture problem: RTSP is LAN-only and you have no always-on box.** Your realistic options are:
   - (a) Add a small always-on device. The SwitchBot AI Hub (US$259.99) runs Frigate and optional Home Assistant on-device, but it **cannot do IR**, so keep the Hub Mini for the aircon. A Pi 5 or N100 mini PC also works.
   - (b) Use the **unofficial cloud path**. The Plus 3K streams through AWS Kinesis Video Streams (KVS) WebRTC, and go2rtc has a native `#format=switchbot` source. This could run on a cloud VM, but it depends on SwitchBot's private account API.
   - (c) Do not expose RTSP to the internet. SwitchBot explicitly warns against it.

---

## 1. Hardware specs (Pan/Tilt Cam Plus 3K, model W4001100)

| Item | Value | Source / confidence |
|---|---|---|
| Resolution | 3K = 5 MP. Usually quoted as 2592×1620. Sold in Japan as "見守りカメラ Plus 5MP". | PCWorld review, Ameridroid, switchbot.jp. High. (Note: the official switch-bot.com spec table oddly says "2K", which looks like a page error. Some EU retailers list 2304×1296.) |
| Field of view | **Conflict.** The manual says 107° diagonal. The switch-bot.com spec table says 100.6° diagonal, 81° horizontal, 43° vertical. PCWorld says 100.6°. The Gadgeteer says 170° (almost certainly a typo). | Manual (Alza PDF), switch-bot.com/pages/switchbot-pan-tilt-cam-plus-3k. Medium. |
| Pan / tilt | 360° horizontal (hard stops at each end, so not endless rotation), 115° vertical | Manual, PCWorld. High. |
| Lens | f/1.6 aperture ("up to 50% more light vs f/2.0") | switch-bot.com, switchbot.jp. High. |
| Codec | H.264 | switch-bot.com spec table. Medium-high (not independently verified with ffprobe). |
| Night vision | IR black-and-white (Auto / On / Off), plus "Full-Color with Low Light" / "Night Full Color" mode | Manual, The Gadgeteer, hsakoh integration (`night_full_color` switch). High. |
| IR wavelength | **940 nm, "invisible to the naked eye … no problems such as … the infrared light being too bright to sleep"** | switch-bot.com product description; switchbot.jp ("肉眼では見えない940nmタイプ"). High. One retailer says 850 nm, which contradicts the official source. Some EU listings say 8 IR LEDs (unverified). |
| Related models' IR | Pan/Tilt Cam (1080p) and Pan/Tilt Cam 2K use **850 nm**, which has a visible red glow | SwitchBot support article 20187400655767. High. |
| Status LED | Red + green indicator on the front. Meanings: red solid = starting; red fast flash = Wi-Fi config; green slow = connecting; green fast = connected to router, reaching internet; **green solid = online**; red/green alternating = errors | Manual. High. |
| Audio | Built-in microphone + speaker. Two-way talk (push-to-talk or two-way "Talk Mode"). Manual "Sound Alarm" siren. | Manual, reviews. High. Quality: Creating Smart Home says the mic is "quite clear" and the speaker average. Another reviewer called the audio "atrocious". A JP Amazon reviewer reports intermittent mic dropouts. Medium. |
| Storage | microSD up to 256 GB, FAT32. Continuous recording "up to 42 days" (official). | Manual, switch-bot.com. High. |
| Power | 5 V ⎓ 2 A, USB-C (adapter included) | Manual. High. |
| Wi-Fi | 802.11 b/g/n, **2.4 GHz only**, IPv4 | Manual. High. |
| Environment | -15 to 45 °C, ≤95% RH, indoor only | Manual. High. |
| Size / weight | 78×78×107 mm, 197 g | switch-bot.com, Ameridroid. High. |
| Mounting | Table, or ceiling/wall with base + screws. Use "Flip Screen" in Settings > Basic Settings when ceiling-mounted. | Manual. High. |
| Bandwidth | Under 1 MB/h idle (about 10 MB/day). **About 11 MB/min while live-viewing** (highest in the range). | Support article 30246368464919. High. |
| Price | US$69.99 (switch-bot.com) | High. |

---

## 2. Privacy mode, LED and bedroom darkness

- **Privacy Mode:** the lens physically rotates into the body. App live view is disabled, and motion detection and tracking turn off. PCWorld says the mic is also muted. It can be triggered by Alexa ("turn on privacy mode"), SwitchBot automations (lock, contact sensor, presence) and the hsakoh HA integration (`privacy_mode` switch). Sources: manual and https://www.pcworld.com/article/2425094/switchbot-pan-tilt-cam-plus-3k-review.html. Confidence: high. I did not verify whether RTSP keeps streaming a black or frozen frame during Privacy Mode.
- **Indicator LED off:** the open-source integration's `switch.py` defines `indicator_light`, which reads `isOpenIndicatorLight` and calls `set_indicator_light(True/False)` on the camera via SwitchBot's cloud MQTT. This shows the firmware supports turning the LED off. Source: https://github.com/hsakoh/ha-switchbot-kvs-camera (README lists "Indicator Light — Sets the indicator light"). Confidence: medium. The toggle probably also appears in the app's Basic Settings, but I found no official doc for it. **Verify on unboxing.** As a fallback, use a small piece of blackout tape or LightDims.
- **940 nm IR in a pitch-black room:** officially invisible. In practice, 940 nm LEDs can show a very faint deep-red speck when you look straight at them in total darkness. That is general knowledge about 940 nm emitters, not tested for this model (low confidence). 940 nm also gives a darker, shorter-range IR image than 850 nm. Over a roughly 6–7 m bedroom span it should be fine, but this is inference.
- **Color night mode needs some ambient light.** PCWorld says it works at dusk but not in complete darkness. **In your pitch-black room you will be on IR B/W.**
- **Beeps:** factory reset plays a prompt tone. No evidence of routine beeps. The Sound Alarm siren only fires when triggered.

---

## 3. Detection features (on-device vs cloud)

| Feature | Where it runs | Notes | Source |
|---|---|---|---|
| Motion detection (3 sensitivity levels, zones, schedule) | Device | Takes a photo and records a clip (SD card or cloud), then pushes a notification | Manual; https://the-gadgeteer.com/2024/08/15/switchbot-pan-tilt-cam-plus-3k-review-now-with-higher-resolution-and-snappier-performance/ (high) |
| Human detection filter | Device, **no cloud and no subscription** | "detect person … using on-device AI detection (no cloud involved)" | https://www.creatingsmarthome.com/index.php/2024/07/12/review-switchbot-3k-pan-tilt-cam-plus/ (medium-high) |
| Pet / vehicle detection | Marketed. Probably cloud-assisted under the AI Guard Basic plan ("AI recognition for pets and vehicles"). | | switch-bot.com page; questreviewcenter Oct 2026 (medium) |
| Motion tracking (auto-follow) | Device | Stops at the pan hard stops. Reviewers say it loses targets easily. | PCWorld (high) |
| Patrol / Auto Cruise, 6 Presets, 4 "Preset Points" | Device | **Only Preset Points (max 4) can be used in SwitchBot Scenes/Automations.** Presets (max 6) cannot. | Support article 10154862632727 (high) |
| **Sound / cry detection** | **Not found.** | No official SwitchBot doc lists sound or cry detection for this model. One JP comparison blog explicitly says cry detection is not supported. Another lists "AI sound detection" (unverified). | switchbot.jp, support center searches, smart-iot-note.com (medium-high that it does not exist) |
| AI Guard Plan (replaced "Cloud Storage" from app v9.27): Basic = 30-day event cloud storage + people/pet/vehicle AI. Premium/Plus = natural-language alerts, AI video search, AI daily summary/"Smart Report", face recognition (Oct 2026), package detection, AI automations (hub required). | Cloud | Compatible with Pan/Tilt Cam Plus 2K/3K, Video Doorbell, Outdoor PTC 3K. The Smart Report strip under live view cannot be hidden. | Support 40872091634711, 41137739203735; PR TIMES 2026-06-11 (JP: Premium from ¥500/mo/camera, Basic from ¥400); questreviewcenter 2026-10-22 (tiers named Basic/Plus/Ultra). **Tier naming conflicts between regions.** (medium) |
| Legacy cloud plan prices (USD, page still live) | | Basic $3.99/mo or $34.99/yr for 1 camera; Plus $6.99/mo for 2; Premium $10.99/mo for 3; 30-day rolling event history; 30-day free trial | Support 13068430935703 (medium, may be superseded by AI Guard pricing, e.g. Premium from $4.99/mo US per one report) |

**Baby-monitor features advertised by SwitchBot:** marketing only covers watching children and pets, two-way talk, privacy shutter, and IR that won't disturb sleep. There is **no** cry alert, breathing or motion-of-chest monitoring, temperature overlay, lullaby or white noise, or a dedicated parent unit. A "Watch over a child" use case appears in AI Guard examples ("running child"). Sources: switch-bot.com, PR TIMES. Confidence: high that no dedicated baby features exist.

---

## 4. Local streaming: RTSP, ONVIF, per model

### Official (support article 31984833990423, EN-US updated 2026-10-11)
https://support.switch-bot.com/hc/en-us/articles/31984833990423
- Applies to: **Pan/Tilt Cam Plus 2K, Pan/Tilt Cam Plus 3K, Smart Video Doorbell** (and the Outdoor Pan/Tilt Cam 3K per article 40965007131415).
- Enable it: App → camera → gear → **More Features → Camera Account** → toggle on → set username/password. Use a password that is **not** your SwitchBot account password. Turning the Camera Account on is what enables RTSP (article 35052394328343: "Enable RTSP service by setting up a camera account").
- URLs:
  - HD: `rtsp://USER:PASS@IP:554/live0`
  - SD: `rtsp://USER:PASS@IP:554/live1`
  - Doorbell: `rtsp://USER:PASS@IP:554/<MAC-without-colons>/live1`
- HA Generic Camera settings: transport **TCP**, auth **digest**.
- Latency: 1–2 s more than the app. Switch to `live1` if it lags.
- Troubleshooting: toggle the Camera Account off and on, update firmware, check firewall and VPN.
- The DE/NL/ES versions of the same article add: **"RTSP/ONVIF … for video streaming and pan/tilt control"**, HA "ONVIF" integration, **ONVIF port 2020**, and "Home Assistant will detect the camera, allowing live viewing, motion logs, and pan/tilt control (for Pan/Tilt Cam Plus models)". **The EN-US version has dropped all ONVIF wording**, which may mean SwitchBot walked back the ONVIF claim (inference).
- Security note (article 37081974410263): RTSP "has lower security … Avoid using this feature on public networks." **Do not port-forward 554 to reach it from Vercel or Supabase.**

### Legacy "no RTSP" article
https://support.switch-bot.com/hc/en-us/articles/13677807305879 (content dated April 2023). It says Indoor Cam, Pan/Tilt Cam, Pan/Tilt Cam 2K/3MP and Outdoor Spotlight Cam do not support RTSP. **This is still true for those Tuya-based models.** It is not true for the Plus line.

### Per-model summary
| Model | Platform | RTSP | ONVIF | OpenAPI webhook | IR |
|---|---|---|---|---|---|
| Pan/Tilt Cam (1080p) | Tuya | No | No | Yes (motion `DETECTED`) | 850 nm |
| Pan/Tilt Cam 2K (3MP) | Tuya | No | No | No | 850 nm |
| **Pan/Tilt Cam Plus 2K** | AWS KVS | **Yes** (Camera Account) | Claimed in non-EN docs | No | (not checked) |
| **Pan/Tilt Cam Plus 3K** | AWS KVS | **Yes** (Camera Account) | Claimed in non-EN docs, PTZ reported incomplete | **No** | **940 nm** |
| Outdoor Pan/Tilt Cam 3K | AWS KVS | Yes | Yes (official article 40965007131415) | n/a | n/a |

Sources: go2rtc docs (KVS vs Tuya split), OpenAPI README, support articles. Confidence: high.

### When RTSP arrived
- Creating Smart Home (July 2024, updated Jan 2025) says "there's no RTSP stream out of the camera".
- The hsakoh README says that as of **June 10, 2025** an official ONVIF/RTSP feature was "not yet configurable".
- The support article was created 2025-05-09.

So RTSP shipped via firmware in roughly mid-to-late 2025 (medium confidence). For AI Hub pairing, SwitchBot requires camera firmware **V1.0.0.224 or later** (article 31572631619095), which is a good proxy for an RTSP-capable firmware (inference).

### Audio over RTSP
Not confirmed. The hsakoh project notes the camera only offers **AAC** audio over its WebRTC path, which go2rtc's WebRTC cannot relay. RTSP audio presence is unverified. **Test with `ffprobe rtsp://…/live0`.** This matters for cry detection.

---

## 5. Cloud and unofficial streaming path (relevant because you have no home server)

- The Plus 2K/3K and Doorbell stream through **Amazon Kinesis Video Streams WebRTC**. go2rtc (since about v1.9.9) has a native source:
  `webrtc:wss://...amazonaws.com/?...#format=switchbot#resolution=hd#play_type=0#client_id=...#ice_servers=[...]`
  The resolution values are hd=0, sd=1, auto=2. Video only: the offer is recvonly video, with no audio. Source: https://github.com/AlexxIT/go2rtc/blob/master/internal/webrtc/README.md and `internal/webrtc/switchbot.go`. Confidence: high.
- **hsakoh/ha-switchbot-kvs-camera** (HACS, v0.2.2, 16 stars):
  - Logs in with your **SwitchBot account email and password** (private app API, `iot_class: cloud_polling`, uses boto3 and MQTT).
  - Gets the KVS signaling URL and hands it to go2rtc.
  - Exposes switches: privacy_mode, motion_detection, detect_human, motion_tracking, night_vision, night_full_color, **indicator_light**, local_recording, mute_recording, flip view, cruise_mode, time_watermark, auto_upgrade, and **rstp_open** (toggles RTSP).
  - Also exposes presets (create, move, remove), volume, intercom mode, and SD-card sensors.
  - Requires HA 2025.4.1+ (go2rtc ≥1.9.9). No audio. No events or recordings.
  - Source: https://github.com/hsakoh/ha-switchbot-kvs-camera. Confidence: high for README contents. I did not test it.
- **What this means for you (inference):** a small cloud VM (not Vercel serverless, which cannot hold WebRTC sessions) could run go2rtc with this KVS source. That gives you snapshots, an HLS/WebRTC re-stream for the PWA, and frames for Claude vision, with **no device in the house**. Risks: it is unofficial, can break with SwitchBot app/API changes, likely violates the ToS spirit, and live-viewing costs about 11 MB/min of upstream.
- The same author's **hsakoh/switchbot-mqtt** HA add-on bridges the official OpenAPI to MQTT. It does not cover cameras.

---

## 6. SwitchBot OpenAPI (v1.1) and webhooks

From https://github.com/OpenWonderLabs/SwitchBotAPI (README "Cameras" table plus `devices/cameras/pantilt-cam-plus-3k.md`):

| Device | List | Status | Command | Webhook |
|---|---|---|---|---|
| Indoor Cam (`WoCamera`) | ✓ | – | – | ✓ |
| Pan/Tilt Cam (`WoPanTiltCam`) | ✓ | – | – | ✓ |
| Pan/Tilt Cam 2K | ✓ | – | – | – |
| Pan/Tilt Cam Plus 2K (`W3101102`) | ✓ | – | – | – |
| **Pan/Tilt Cam Plus 3K (`W4001100`)** | ✓ | – | – | – |

- The Plus 3K returns only `deviceId`, `deviceName`, `deviceType`, `enableCloudService` and `hubDeviceId`.
- **No stream URL, no PTZ, no privacy mode, no motion webhook.**
- For the old models, the webhook payload is `{eventType:"changeReport", context:{deviceType, deviceMac, detectionState:"DETECTED", timeOfSample}}`.
- The AI Hub (`W8002100`) has status (version, online) only.
- Confidence: high.

**Workarounds for getting camera events into Supabase:**
1. SwitchBot app automation (hub required): camera condition → action on a device that *does* emit webhooks (e.g. toggle a virtual device or Plug Mini). This is hacky (inference).
2. AI Hub "Detects a scenario (AI Hub)" can be an automation condition and a notification trigger (articles 35052412902807, 35052429179287).
3. Frigate MQTT/webhooks via a local box.
4. The hsakoh integration on HA.

---

## 7. Ecosystem integrations

- **Alexa:** official skill "SwitchBot Smart". Live view on Echo Show and privacy mode by voice. App ≥9.19. Article 4420063570327. High.
- **Google Assistant / Google Home:** voice control officially. Live view in Google Home / Nest Hub is **not confirmed**, and a user comment says the feed doesn't show. Medium.
- **HomeKit / HomeKit Secure Video:** **no native support.** A scos.co.uk page claims HKSV after a firmware update, but it is a non-official, undated SEO page. I treat it as false: SwitchBot's own Matter/HomeKit docs never list cameras. Workaround: RTSP → Scrypted or go2rtc `homekit` output → HKSV (needs an always-on box plus HomePod/Apple TV). Medium.
- **Matter:** cameras do not appear in SwitchBot's Matter compatibility list (article 38979658026519, updated 2026-10-27). Matter 1.5 (Nov 2025) added cameras, but SwitchBot has only said "planned for future cameras" (matteralpha). High that it is not supported today.
- **SwitchBot Scenes/Automations:** need a SwitchBot hub. The Hub Mini qualifies for cloud automations. Documented combos:
  - Motion Sensor → rotate to Preset Point and record
  - Lock / Contact Sensor → privacy on or off when leaving or arriving
  - Hub 2 shows temp/RH next to the video
  - Sources: switch-bot.com, article 10154862632727. High.
- **SwitchBot AI Hub** (US$259.99):
  - Pairs Plus 2K/3K, Doorbell, Outdoor PTC 3K and up to 8 cameras including third-party RTSP. Requires a Camera Account.
  - Built-in **Frigate** (6 TOPS NPU), optional on-device **Home Assistant**, Matter bridge.
  - VLM "Care/Pet/Security Manager" features are cloud and paid ($4.99/mo after a 1-month trial).
  - **It cannot learn IR remotes**, so the Hub Mini is still needed for the aircon.
  - Sources: articles 37081327446423, 36489728002199; smarthomelabo.com review (Mar 2026). High.
- **Multitasking Household Robot K20+ Pro mobile base:** accepts only the Plus 2K/3K. Not relevant here except as proof the Plus line is a different platform.

---

## 8. Open-source support summary

| Project | Status for Plus 3K | Source |
|---|---|---|
| go2rtc | Native `switchbot` (KVS WebRTC) source, plus generic RTSP `live0`/`live1` | github.com/AlexxIT/go2rtc |
| Frigate | Works via RTSP (official AI Hub ships Frigate). Audio detection supports a **`crying` label** ("covers baby cries, sobbing, and whimpering") if the stream has audio. Defaults are bark, fire_alarm, speech, yell. | docs.frigate.video/configuration/audio_detectors |
| Home Assistant | Generic Camera (RTSP) or ONVIF (PTZ unreliable), or the hsakoh HACS KVS integration | SwitchBot support; smarthomeassistant.co.uk (Sept 2026) |
| Scrypted | No SwitchBot plugin. Use the RTSP or ONVIF plugin. | Scrypted docs (medium) |
| Tuya route | Only for the *older* Tuya-based SwitchBot cams (re-pair in Smart Life). **Not applicable to the Plus 3K.** | hsakoh README |

---

## 9. Fallback / companion cameras with RTSP

Only needed if the Plus 3K disappoints.
- **TP-Link Tapo C200/C210/C220:** RTSP + ONVIF, cheap (~US$25–40). But **850 nm IR (visible red glow)**, and per TP-Link community the IR cannot be turned off while in night mode. Poor fit for a pitch-black bedroom unless IR is disabled and you rely on an external 940 nm illuminator. Source: Tapo store listing, TP-Link community post 910348. Medium.
- **Reolink E1 series:** RTSP/ONVIF, mostly 850 nm (not verified here). Low.
- Purpose-built baby monitors (Nanit, Owlet Cam, Miku, Cubo AI) offer breathing-motion and cry analytics but mostly closed ecosystems. Not researched in depth.

**Bottom line:** the Plus 3K's 940 nm IR plus official RTSP make it **one of the better cheap choices for a dark bedroom.** Keep it.

---

## 10. Creative and practical uses for your setup

Sections a–c are verified SwitchBot capabilities. Sections d–h are inference or design ideas.

a. **Ceiling-mount, Flip Screen on.** Set Preset Point 1 = bed and Preset Point 2 = wall/away (daytime privacy). SwitchBot automations can move to a Preset Point. Schedule Privacy Mode during the day and turn it off at bedtime.

b. **Night recording:** continuous recording to a 256 GB card (up to 42 days, overwrites oldest) gives you a free nightly archive with no cloud plan.

c. **Two-way talk** for the future nursery. Note the documented metallic feedback when the phone is near the camera.

d. **Sleep-video analytics.** With an always-on box (Frigate or ffmpeg on `live1`), compute per-minute motion energy as a video actigraphy track. Overlay it with Fitbit heart rate, CO₂, temperature and RH on a hypnogram-style chart, and correlate restlessness with CO₂ peaks or temperature setpoint changes.

e. **Claude vision on snapshots.** Every 5–10 minutes, take a frame (RTSP snapshot via go2rtc `/api/frame.jpeg`, or the KVS path from a cloud VM) and classify sleep position (back/side/prone), covers on/off, partner out of bed, or light leaks. Store labels in Supabase and render them as a timeline in the PWA.

f. **Audio channel** (if RTSP carries audio): snore and noise dB logging, and later baby `crying` detection with Frigate's audio detector or a YAMNet/PANNs model. That can trigger a soothing IR or speaker action via the Hub Mini or a smart speaker.

g. **Grandparent live stream.** SwitchBot Home Sharing works but may fail across countries (article 11717481940887). A cleaner option is go2rtc re-stream → WebRTC/HLS link in the PWA.

h. **Darkness audit.** Use an IR-off / night-color test frame to spot standby LEDs in the room. Remember the camera's own LED and the aircon IR receiver's 3 status LEDs.

---

## 11. Gaps and not found

- Official documentation of an in-app indicator-LED toggle for the Plus 3K: **not found** (protocol support confirmed via hsakoh).
- Whether RTSP includes audio, and its codec (AAC?): **not found**.
- Exact firmware version that introduced RTSP: **not found** (≥V1.0.0.224 is the AI Hub requirement).
- Whether the RTSP stream continues during Privacy Mode: **not found**.
- Why the EN-US article dropped ONVIF: **unknown**.
- Exact FOV (100.6° vs 107°): official sources conflict.
- Number of IR LEDs and IR range: only retailer claims (8 LEDs, ~10 m). Unverified.

---

# Adversarial verification (independent fact-check)

# VERDICTS
- [partially-true] ONVIF (port 2020, with pan/tilt) is described in the DE/NL/ES versions of the same support article, but the current EN-US version (updated 2026-10-11) no longer mentions ONVIF. Third-party testing reports incomplete ONVIF PTZ on the indoor Plus 3K.
  -> Locale part confirmed via the Zendesk API. DE (edited 2025-11-17) says 'RTSP/ONVIF', 'ONVIF: 2020, RTSP: 554'. EN (edited 2026-09-02) removed ONVIF. Correction: 2026-10-11 is the shared updated_at for every locale, so EN's real content edit date is 2026-09-02. EN still contains a leftover line: 'RTSP ... for video streaming and pan/tilt control'. The 'third-party testing reports incomplete ONVIF PTZ on indoor Plus 3K' part could not be verified; no source was found. ONVIF is still officially claimed for the separate Outdoor Pan Tilt Cam 3K (article 40965007131415). The design advice not to rely on ONVIF PTZ still holds; probe port 2020 on unboxing. (https://support.switch-bot.com/hc/de/articles/31984833990423)
- [partially-true] No on-device sound or baby-cry detection exists. Detection is motion plus on-device human detection, with pet/vehicle and natural-language AI via the cloud AI Guard Plan. Frigate's audio detector has a 'crying' label usable on an RTSP stream with audio.
  -> Frigate is confirmed: the docs list `crying` ('Baby crying and sobbing') and the labelmap also has `snoring`. Default listen labels are bark, fire_alarm, speech and yell, so crying and snoring must be added. The camera side is murkier. The Plus 3K manual lists only Motion Detection and Motion Tracking. However, the Shopify product description of the Plus 3K (apparently copied 2K text) advertises 'Customizable Motion and Sound Detection... notifications when motion or sound is detected', and the firmware status has a 'soundAlarm' boolean of unclear meaning. Generic sound alerts may therefore exist in the app; check on unboxing. Cry classification does not exist. The cloud plan was renamed 'AI Guard Plan' as of app 9.27. JP marketing says the AI auto-sort feature detects animals and vehicles. (https://docs.frigate.video/configuration/audio_detectors/)
- [partially-true] Plus 2K/3K stream via AWS Kinesis Video Streams WebRTC. go2rtc has a native '#format=switchbot' source (video only, resolution hd/sd/auto). The hsakoh HACS integration logs in with SwitchBot account credentials to obtain it and also exposes privacy, LED, RTSP toggle, presets and night-vision switches.
  -> Confirmed from the go2rtc README and switchbot.go: KVS-based, resolution hd=0, sd=1, auto=2, plus play_type; the older Tuya-based cams are not supported. 'Video only' is not a go2rtc restriction. hsakoh's README says audio is unsupported because the camera returns a broken SDP for non-AAC and go2rtc/pion WebRTC lacks AAC. The RTSP toggle is not in the README feature table but exists in code (rtspEnable, rtspUsernamePasswd). Setting preset POINTS is not implemented; only named presets are. Control and status go over SwitchBot's cloud MQTT. It requires HA Core 2025.4.1+ (go2rtc 1.9.9+). Last commit 2026-10-12. (https://github.com/AlexxIT/go2rtc/blob/master/internal/webrtc/README.md)
# ANSWERED
- Q: Does the SwitchBot app expose an indicator-LED off toggle for the Plus 3K?
  A: No official doc found. The firmware supports it: KvsStatus.isOpenIndicatorLight plus a 'setIndicatorLight' command, exposed as the 'Indicator Light' switch in hsakoh's integration. That means the hsakoh/HA route can turn the LED off even if the app does not. Verify in the app's Settings on unboxing.
- Q: Does the RTSP live0/live1 stream include audio, and which codec?
  A: Not documented officially. The camera has a built-in mic, and hsakoh notes the KVS/WebRTC path negotiates AAC (a non-AAC request gives a broken SDP). AAC on RTSP is therefore plausible but unverified; run ffprobe. Video is H.264 per the spec table.
- Q: Is ONVIF (port 2020) active on current Plus 3K firmware?
  A: Unresolved. The EN article (edited 2026-09-02) removed ONVIF. DE/ES/NL (edited 2025-11) still list ONVIF:2020. ONVIF is still officially claimed for the Outdoor Pan Tilt Cam 3K. Probe TCP 2020 with an ONVIF discovery tool on unboxing.
- Q: Does RTSP keep streaming when Privacy Mode is on?
  A: Very likely it stops. Officially, Privacy Mode puts the camera into a 'sleep state' or 'hibernate mode' with the lens rotated inward, and disables live view, motion detection, tracking and recording. RTSP behaviour is not explicitly documented, so expect a dropped or black stream and handle reconnects.
- Q: Which camera firmware introduced RTSP?
  A: Not published. The only official version gate is that AI Hub requires Plus 2K/3K firmware V1.0.0.224 or later. hsakoh noted on 2025-06-10 that RTSP 'was not yet configurable', so it arrived after mid-2025. Update to the latest firmware.
- Q: Exact FOV: 107° vs 100.6°?
  A: Use 107° diagonal from the Plus 3K user manual. The switch-bot.com spec table showing 100.6° diagonal / 81° H / 43° V also says 'Video Resolution 2K', so it appears to be copied from the Plus 2K spec.
- Q: Does 940 nm IR produce perceptible glow?
  A: Officially it is 'invisible to the naked eye'. No independent measurement for this unit was found. Check in the fully dark room on unboxing; Night Vision can also be set to off or auto.
# MISSED
- Power: the camera needs a constant 5V 2A over USB-C (no battery), so it needs a nearby outlet or a USB-C cable run. The SwitchBot K20+ Pro 'Mobile Base' can carry the Plus 2K/3K for about 6 hours, which is not a power fix.
- Hub 2 (not Hub Mini) overlays room temperature and humidity on the camera live view in the app ('Link your camera to SwitchBot Hub 2'). The Hub Mini has no sensor.
- Grandparent live stream: SwitchBot says home-sharing 'may not be able to see the monitoring screen if you cross the country/region'. Overseas grandparents may need the owner account, or a self-hosted or relayed stream.
- The 2023 support article 13677807305879 still says SwitchBot cameras 'cannot support RTSP'. It covers only the Tuya-based older models (Indoor Cam, Pan/Tilt Cam, Pan/Tilt Cam 2K, Spotlight Cam). The Plus models are KVS-based and different.
- SwitchBot warns that RTSP is lower-security and recommends a Camera Account password different from the SwitchBot account password (article 37081974410263).
- The cloud storage plan was renamed 'AI Guard Plan' from app 9.27. Basic is US$3.99/mo or $34.99/yr per camera with a 30-day free trial; AI Smart Report needs Premium.
- The AI Hub + Plus 3K bundle is US$299.99. AI Hub needs app 9.20+ and formats its microSD on pairing.
- hsakoh/go2rtc KVS route: audio is not supported, setting preset points is not implemented, and control runs over SwitchBot cloud MQTT using the account login. Requires HA Core 2025.4.1+.
- Frigate's audio labelmap includes 'snoring' as well as 'crying'. That is useful for snore logging if RTSP carries audio, but these labels are not enabled by default.
- Ceiling mounting is officially supported, with a base and a Flip Screen setting under Settings > Basic Settings.