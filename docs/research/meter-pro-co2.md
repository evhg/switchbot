# SwitchBot Meter Pro (CO2 Monitor): research findings

Model W4900010. Research date 2026-10-28. Confidence is marked as **[H]**, **[M]** or **[L]**. "Inference" marks my own reasoning, which no source states.

---

## 0. Summary for this bedroom

1. **The automatic calibration is the main risk.** The device almost certainly uses a Sensirion SCD4x-family sensor. Sensirion's automatic self-calibration (ASC) is on by default. It assumes the sensor sees fresh outdoor air at about 400 ppm for at least 3 minutes every week of operation. A room that is never ventilated may never get back to 400 ppm. ASC then treats the room's lowest level as "400" and **reads low**: it hides exactly the build-up you want to measure. SwitchBot offers **no toggle to turn ASC off** (I found none in the app, docs or reviews). The only control is a **manual "Calibrate" (forced recalibration) in the app, done outdoors**. Plan on a recurring outdoor calibration. Also check now and then against a second reference sensor, or by taking the unit outside.
2. **Run it on USB-C power.** On batteries CO2 updates only every 30 minutes (a newer firmware reportedly allows 5 minutes). On USB it updates every 1 minute by default and is configurable. The CO2 monitor already comes with a USB cable, but it is short (0.9 m) and flat, and no power adapter is included.
3. **Darkness: good, with caveats.** The screen is a reflective LCD with **no backlight**, per SwitchBot's official statement. I found no LED on the device. However, alerts can **flash the screen and sound a buzzer of up to 100 dB**, and there is **no Do-Not-Disturb schedule**. Turn off the device's "Alert Sound & Light" and do alerting in your own app or the SwitchBot app instead.
4. **Data paths:**
   - Cloud OpenAPI (needs a Hub): deviceType `MeterPro(CO2)`, field `CO2` (integer ppm, 0–9999), plus `temperature` (float °C), `humidity` (integer %) and `battery`. Webhooks (`changeReport`) are also supported.
   - BLE advertisements are unencrypted and decoded by pySwitchbot, Home Assistant and Theengs. You would need an always-on BLE listener (for example a cheap ESP32), which you don't have.
   - Inside the app: about 36–40 days of history on the device, 2 years in the cloud, and a manual "Export Data" button.

---

## 1. Sensor hardware

| Item | Finding | Conf. | Source |
|---|---|---|---|
| CO2 technology | SwitchBot calls it NDIR with "Swiss industrial-grade" sensors | H | https://www.switch-bot.com/products/switchbot-meter-pro-co2-monitor ; https://prnewswire.com/news-releases/switchbot-expands-the-environment-meter-product-portfolio-with-advanced-meter-pro--meter-pro-co2-monitor-302234875.html |
| Sensor chip | Reviewers name the **Sensirion SCD40**. No teardown or PCB photo found; SwitchBot doesn't name the chip | M | https://smarthomescene.com/reviews/switchbot-meter-pro-co2-monitor-setup-and-review/ ; https://www.airpurifierfirst.com/review/switchbot-co2-monitor/ |
| What the SCD4x actually is | **Photoacoustic NDIR (PASens®)**, not classic dual-beam NDIR. Some web summaries say SCD40 is "not photoacoustic"; that is wrong per Sensirion | H (for SCD4x) | https://sensirion.com/media/documents/48C4B7FB/67FE0194/CD_DS_SCD4x_Datasheet_D1.pdf |
| SCD40 vs SCD41 | **Inference:** the SCD40 datasheet specifies 400–2000 ppm and has no single-shot mode. A 30-minute battery interval suggests the SCD41 (single-shot) or power-cycling. Unverified | L | same datasheet (§3.11 "Single Shot Measurement Mode (SCD41 & SCD43 only)") |
| Temp/RH sensor | Sensirion part (Japanese reviews) | M | https://shin5noblog.com/switchbot-co2/ (via search summary) |

### CO2 range and accuracy
- **SwitchBot spec: ±(50 ppm + 5% of reading).** At 800 ppm, a second unit may read anywhere from 710 to 890 ppm. [H] https://support.switch-bot.com/hc/en-us/articles/28265078873495
- **Range conflict:**
  - Product page, manual and pySwitchbot: 400–9999 ppm.
  - The 2024 press release and HomeTechHacker: 400–9000 ppm.
  - The OpenAPI documents `CO2` as 0–9999.
  - The SCD40 datasheet *specifies* accuracy only over 400–2000 ppm; its output range is 0–40,000. [H for each source's statement]
- **SCD4x datasheet:**
  - SCD40 accuracy: ±(50 ppm + 5%) over 400–2000 ppm.
  - SCD41 accuracy: ±(50 + 2.5%) to 1000 ppm, ±(50 + 3%) to 2000 ppm, ±(40 + 5%) to 5000 ppm.
  - Drift: the specified accuracy and drift figures assume either FRC, or ASC with *weekly 400 ppm exposure*. [H]
- **Press release:** "±50ppm", alarm up to 100 dB with low/medium/high volume. [H that the release says this]

### Temperature and humidity (official)
- Temperature [H]:
  - ±0.4 °C from −20 to 0 °C
  - **±0.2 °C from 0 to 65 °C**
  - ±0.3 °C from 65 to 80 °C
- Humidity: **±2 %RH at 25 °C over 10–90 %RH**. The support pages give ±4 % outside that band; the manual gives ±3 %. [H] https://support.switch-bot.com/hc/en-us/articles/9696123584535 and the manual
- Measuring range: −20 to 80 °C and 0–99 %RH. Resolution in BLE and API is 0.1 °C and 1 %RH (integer). [H]
- The manual warns that prolonged exposure outside 5–60 °C and **20–80 %RH** "may lead to premature aging". [H] Manual: https://dwn.alza.cz/manual/142051
  - **Inference:** don't mount it next to the open shower area.
- Temperature and humidity offsets can be calibrated in the app (Settings → Calibration). [H] https://support.switch-bot.com/hc/en-us/articles/28410554197783
- Real-world readings:
  - techtest.org measured about 0.2–0.3 °C deviation. [M]
  - A Japanese blogger found the CO2 unit ran about 1 °C warmer than a BME280. [M] https://rcmdnk.com/blog/2025/01/06/comuter-iot/
  - SwitchBot itself warns that intervals under 1 minute keep the sensor continuously on, "may cause the device to heat up slightly and affect the sensor's accuracy". [H]

---

## 2. Measurement and refresh intervals

| Layer | Behaviour | Conf. | Source |
|---|---|---|---|
| CO2, battery power | **Every 30 min, "cannot be customized"** (support article, edited 2024-12-31). A countdown timer is shown on screen. Press the top button, or tap "Refresh" in the app, to force a reading | H (for that doc) | https://support.switch-bot.com/hc/en-us/articles/26502008033303 |
| CO2, battery, newer firmware | A user reported in Dec 2025 that **5-minute battery intervals** are now settable in the app. Not confirmed by SwitchBot docs | L–M | https://community.home-assistant.io/t/best-co2-sensor/333610/142 |
| CO2, USB-C 5V/1A | **Automatically every 1 min, configurable** in App → Meter Pro (CO2) → gear → Panel Display → Data Update Interval → CO2. A blogger reports a range of 1 s to 30 min. Under 1 min means continuous operation and self-heating | H / M (range) | same support article; https://rcmdnk.com/blog/2025/01/06/comuter-iot/ |
| USB + batteries installed | USB takes priority and the interval switches to 1 min. SwitchBot recommends removing the batteries when running on USB, to avoid leakage | H | https://support.switch-bot.com/hc/en-us/articles/36635644782615 |
| Display deadband | "Indoor CO2 concentration may not be displayed for small changes (±20ppm)" | H | 26502008033303 |
| Temperature/humidity sampling | Meters "collect data every 4 seconds and save it every minute". Press release: temperature/humidity every 4 s | H | https://support.switch-bot.com/hc/en-us/articles/25328810947351 |
| Cloud history granularity (via Hub) | For meters, the recorded interval "will depend on how much the temperature changes": about 30 min if stable, 10 min or even 2 min if changing. This article covers temperature/humidity; CO2 is not described | H (as stated for T/H) | 25328810947351 |
| Cloud API "freshness" | **Not documented.** The HA `switchbot_cloud` integration polls every 600 s. The API limit is 10,000 calls/day, so 1-minute polling (1,440 calls/day) fits. Homey users report uneven update times | M | https://www.home-assistant.io/integrations/switchbot_cloud/ ; https://github.com/AdyRock/com.switchbot/issues/237 |
| Marketing claims | The product page says "every second (Type-C), every 5 seconds (battery)". This contradicts the support article and appears to mean sensing capability or T/H, not the CO2 logging interval | M | product page vs support article |

**Recommendation (inference):**
- Run on USB-C with a 1-minute CO2 interval.
- Poll `GET /v1.1/devices/{id}/status` every 1–2 min from a Supabase cron or Edge Function, and/or register a webhook.
- Log your own timestamps, because the status response has no sample timestamp. The webhook carries `timeOfSample`.
- Measure the real freshness empirically before building on it.

---

## 3. Calibration (most important for a sealed room)

### What SwitchBot exposes
- **Manual CO2 calibration (forced recalibration):** App → device → gear → "Calibrate" → "CO2 Monitor". Place the unit "**outdoors in a well-ventilated area for 1 minute**", tap Calibrate, and don't move it for **5 minutes**. Your phone must be within Bluetooth range. Requires app 9.1+. [H] https://support.switch-bot.com/hc/en-us/articles/26500991854487
- **Health check:** outdoors, 5 minutes undisturbed, press the button; **400–500 ppm means it is working correctly**. Above 500 ppm, recalibrate. [H] https://support.switch-bot.com/hc/en-us/articles/28322226696983
- The manual says "**battery power is recommended for calibrating the CO₂ monitor**". [H] Manual
  - **Inference:** this is probably because USB operation self-heats the sensor.
- **No setting found** to disable ASC, change the ASC target, or enter a reference value. Searched: support center (Zendesk API), reviews, forums. [M, absence of evidence]

### What the sensor does by default (SCD4x datasheet v1.7, April 2025) [H]
- "By default, ASC is enabled."
- ASC "assumes that the sensor ... was exposed to outdoor fresh air at **400 ppm** CO2 concentration at least once for **>3 minutes after every week of operation** accumulated" in periodic, low-power periodic, or 5-minute single-shot mode.
- The initial ASC period is **44 h**, adjustable.
- The baseline target (default 400 ppm) and enable/disable flag can be changed over I²C (commands 0x2416 and 0x243a). That is firmware-level access only; SwitchBot doesn't expose it.
- Footnote: correct ASC function requires weekly 400 ppm exposure.
- Source: https://sensirion.com/media/documents/48C4B7FB/67FE0194/CD_DS_SCD4x_Datasheet_D1.pdf
- Japanese reviews also say the unit self-corrects by treating the lowest value over a 24 h to several-day cycle as 400 ppm. [M; secondary] (search summaries of https://shin5noblog.com/switchbot-co2/ and others)
- **Caveat:** whether SwitchBot's firmware keeps ASC on is **not confirmed by SwitchBot**. Several reviewers say it self-calibrates. [M]

### Consequences for your room (inference, M)
- The bedroom has no mechanical ventilation, the door is usually closed and the sliding doors stay shut. During the day, when nobody is in the room, CO2 may decay only to about 500–700 ppm rather than 400.
- With ASC on, the sensor will gradually shift that minimum to 400. Absolute readings would then be **biased low by roughly 100–300 ppm**, while shapes and trends stay correct.
- techtest.org saw the Meter Pro read **lower than an air-Q** reference (400–450 vs 400–550 ppm). That pattern fits, but it doesn't prove ASC offset. [M] https://techtest.org/der-switchbot-meter-pro-im-test-smart-home-co2-messung/
- An unverified commenter on SmartHomeScene reported a lab offset of about 250–300 ppm. [L]

### Mitigation plan
1. On day 1, run the outdoor calibration (on battery, outdoors, 5 minutes undisturbed).
2. **Weekly or bi-weekly:** carry the unit onto the balcony for at least 5–10 minutes, ideally away from people breathing on it. This satisfies the ASC assumption *and* serves as a check. Log a "calibration event" in your app.
3. Optionally air the room once a week by opening the sliding doors for a few minutes with the unit inside.
4. Optionally cross-check against a sensor that lets you turn ABC off. Options:
   - Aranet4 (ABC can be turned off in its app; not researched here)
   - AirGradient ONE (open-source firmware, ABC configurable)
5. In the pipeline, flag readings below about 420 ppm indoors at night as suspicious (impossible with two sleepers in a sealed room).

---

## 4. Display, lights and sounds (bedroom darkness)

### Display
- **Reflective segment LCD**, no backlight.
- SwitchBot says no Meter product has a backlight, because "Adding a backlight could generate heat". [H] https://support.switch-bot.com/hc/en-us/articles/27211671722775
- techtest.org and SmartHomeScene confirm there is no backlight. [H]
- bestpick.guide claims "backlit LCD". **That is wrong**: it contradicts official SwitchBot docs, and the site doesn't appear to be hands-on. [H that it's unreliable]

### What the screen shows (manual) [H]
- Weather forecast icon (needs a Hub; updates every 12 h)
- Date and time
- CO2 level indicator, CO2 ppm, and "CO2 collection time" (the battery-mode countdown)
- Comfort level with pointer
- Indoor/outdoor icon
- Two temperature/humidity rows
- The **top CO2 section cannot be changed** to other data. [H] https://support.switch-bot.com/hc/en-us/articles/26478900271255
- The bottom row can show another SwitchBot meter (e.g. the Outdoor Meter). [H]

### CO2 color levels
- Manual: Green 400–1000 "Good", Yellow 1000–1400 "Average", Red 1400+ "Poor". [H]
- These are indicators on the LCD; the press release says "three different colors on the screen".
- **No separate LED found** in the manual's device overview, which lists only the button, mounting hole, CO2 sensor, stand, T/H sensor and Type-C port. [M–H]

### Alerts
- Press release: an audible alarm of up to **100 dB** with low/medium/high volume, mutable via the button or the app, plus "number flashing" visual alerts. [H]
- In the app: gear → **Alert Conditions** → set ranges → toggle "**Alert Sound & Light**" (screen flash and buzzer). The doc covers the Meter Pro; the CO2 model shares the UI. [H/M] https://support.switch-bot.com/hc/en-us/articles/26966864494359
- **No Do-Not-Disturb or schedule-based mute** for the Meter Pro (CO2). [H] https://support.switch-bot.com/hc/en-us/articles/28611503749527
- A single button press mutes an active alarm. [H] https://support.switch-bot.com/hc/en-us/articles/27266690216471
- **Recommendation:** disable "Alert Sound & Light" on the device. Keep app push alerts only, which need the Hub, or handle alerts in your own PWA.

### Button [H]
- 2 s hold: pairing
- 1 press: mute, refresh, or °C/°F toggle
- 15 s hold: factory reset, which **erases the on-device history**

---

## 5. Power [H]

- 2× AA alkaline, about **1 year at a 30-minute CO2 interval**. Don't use rechargeables whose combined voltage exceeds 3 V. https://support.switch-bot.com/hc/en-us/articles/26500977424535
- USB-C at 5 V 1 A. The **adapter is not included**. The included cable is 0.9 m.
- A Japanese blogger found the port is recessed, so the included flat cable is "effectively required". [M] https://rcmdnk.com/blog/2025/01/06/comuter-iot/
- SwitchBot suggests the Hub 2's 2 m cable as a longer option. That cable's own T/H sensor then takes over the temperature/humidity readings. [H] https://support.switch-bot.com/hc/en-us/articles/27730159946775

### Physical [H] (manual)
- 92 × 79 × 25 mm, 154 g with batteries
- Foldable stand and wall-mount hole
- BLE 4.2+, quoted range 120 m in open air

---

## 6. Data history and export

- **On the device:** the support doc says 36 days for the CO2 model. The press release says 40 days; the US product page says 38 days. [H; sources conflict]
- **Cloud:** with a Hub, "up to two years" of data. Export from the app via the "Export Data" button. The export format is not documented in what I read. [H]
- **Cloud upload** isn't automatic since app v9.0. You must tap "**Store Data in Cloud**" at the bottom of the chart page, with the meter in range of the Hub. Without this, the API, widgets, Alexa and Google won't receive data. [H] https://support.switch-bot.com/hc/en-us/articles/29238392261655 ; https://support.switch-bot.com/hc/en-us/articles/20426539496727
- **There is no history endpoint in the OpenAPI.** Only current status and webhooks exist (README checked 2026-10-28). Build your own time series. [H] https://github.com/OpenWonderLabs/SwitchBotAPI
- **iOS widget:** available (app 9.4+) and shows CO2. [H] https://support.switch-bot.com/hc/en-us/articles/28197492642839
- **Hub 3 screen:** can show the CO2 level as a colored icon (Green/Orange/Red 400–1000/1000–1400/1400–2000), not as a number. [H] https://support.switch-bot.com/hc/en-us/articles/36303041754391
- **Apple Home via Hub 2 or Hub Mini Matter:** temperature and humidity only. **CO2 is not exposed.** [H as of the 2024-12 doc] https://support.switch-bot.com/hc/en-us/articles/28409755655063
- **Automations:** CO2 can be an automation condition when connected to a Hub (Hub Mini, Hub 2 or Hub Mini Matter). [H] https://support.switch-bot.com/hc/en-us/articles/26500881438999
- **AI Hub local automation:** Meter Pro (CO2) is supported. [H] https://support.switch-bot.com/hc/en-us/articles/36405172630039

---

## 7. Cloud OpenAPI (v1.1)

Source: https://github.com/OpenWonderLabs/SwitchBotAPI/blob/main/devices/sensors/meter-pro-co2.md [H]

- Device type string: **`MeterPro(CO2)`**. The README product table lists the Meter Pro (CO2 Monitor) as W4900010.
- `GET /v1.1/devices` returns: `deviceId`, `deviceName`, `deviceType`, `enableCloudService`, `hubDeviceId`.
- `GET /v1.1/devices/{deviceId}/status` returns: `deviceId`, `deviceType`, `hubDeviceId`, `battery` (0–100), `version`, `temperature` (Float °C), `humidity` (Integer %), **`CO2` (Integer ppm, 0–9999)**.
- No commands are available: you cannot trigger a refresh or calibration via the API.
- Webhook event:
  ```json
  {"eventType":"changeReport","eventVersion":"1","context":{"deviceType":"MeterPro(CO2)","deviceMac":"...","temperature":22.5,"scale":"CELSIUS","humidity":31,"CO2":1203,"battery":100,"timeOfSample":123456789}}
  ```
  Set it up with `POST /v1.1/webhook/setupWebhook`. It needs a public HTTPS URL, which a Supabase Edge Function or Vercel route can provide.
- Webhook firing frequency for meters is **not documented**. A Homey forum user says newer meters push on change. [L]
- Limit: **10,000 calls/day**; exceeding it returns "Unauthorized". Auth is token + secret using an HMAC-SHA256 signature (`sign`, `t`, `nonce`). [H]

### Third-party integration notes
- The HA `switchbot_cloud` integration supports "Meter Pro CO2 Monitor" with temperature, humidity, CO2 and battery, polling every 10 min. [H]
- node-switchbot had a bug where `getStatus()` dropped `co2`. It was reported in Sep 2026, and a fix PR exists in homebridge-switchbot. Watch out if you use those libraries. [M] https://github.com/OpenWonderLabs/node-switchbot/issues/339 ; https://github.com/OpenWonderLabs/homebridge-switchbot/pull/1413

---

## 8. BLE advertisement format (local, no cloud)

Source: pySwitchbot at https://github.com/sblibs/pySwitchbot, commit of 2026-10-16. [H]

- Model string `WoTHPc` (`SwitchbotModel.METER_PRO_CO2`). Service-data model byte `'5'`, or `0x15` in the newer format. Manufacturer ID **2409 (0x0969)**.
- Parsing (`adv_parsers/meter.py`, `process_wosensorth_c`):
  - Temperature/humidity: manufacturer data bytes **8–10**.
    - byte0 bits[3:0] = 0.1 °C decimal
    - byte1 bit7 = sign (1 = positive), bits[6:0] = integer °C
    - byte2 bit7 = °F display flag, bits[6:0] = RH %
  - **CO2:** manufacturer data bytes **13–14, big-endian uint16**. Values above 9999 are discarded as parse artifacts.
  - Battery: service data byte 2 & 0x7F.
- **Unencrypted.** [H]
- The device class supports setting time, time offset, and 12/24 h format over a GATT connection. No calibration commands are implemented. [H]
- **Home Assistant `switchbot` (Bluetooth) integration** [H] https://www.home-assistant.io/integrations/switchbot/
  - Entities: Temperature, Humidity, Carbon dioxide, Battery, a display-time-format select, a time-offset number, and a "Sync date and time" button.
  - Certified "Bluetooth-certified – Worldwide".
  - There were regressions in 2026: issue #164817 (unavailable after 2026.3.0), plus PRs #180898 and #187757. [M]
- **Theengs Decoder:** model "W490001X – Meter Pro (CO2)", decoding temperature, humidity, battery and CO2. [H] https://decoder.theengs.io/devices/SBMP.html
- **BLE reception reliability:** the Homey developer found that many advertisements arrive without service data on some receivers. His ESP32 "SwitchBotBLEHub" never missed any. [M] https://github.com/AdyRock/com.switchbot/issues/237
- **Inference:** BLE is the only fully local, low-latency path. You have no always-on BLE host, though. A roughly $5–10 ESP32 running ESPHome or a BLE proxy, powered by USB in the bedroom, would give real-time CO2 independent of the cloud. The Hub Mini does not expose a local API for this.

---

## 9. Accuracy versus other monitors

- **Classroom test vs Aranet4** (HA forum, March 2025): the trend lines were "quite similar". The SwitchBot is slower and possibly averaged. It's a "decent option" for stationary use on USB, and "essentially useless" on battery at 30-minute intervals. [M] https://community.home-assistant.io/t/best-co2-sensor/333610/136
- **techtest.org vs air-Q basic:** the SwitchBot reads somewhat lower but tracks the same trend. [M]
- **rcmdnk.com:** closely matched an MH-Z19C after all units were calibrated outdoors. [M]
- **SwitchBot itself:** "different brands use different sensors ... direct comparisons may not provide meaningful results". [H]
- **No independent lab test against a reference instrument found.** No direct AirGradient comparison found.
- **Inference:** treat the device as good for trends and the ~±100 ppm band. Don't trust absolute values without periodic outdoor checks, especially in a never-ventilated room.

---

## 10. Creative and practical uses (inference unless cited)

- **Ventilation and air-change estimate:** after you leave the room in the morning (or after a brief door opening), fit the exponential CO2 decay. ln(C − C_out) versus time gives the air-change rate (ACH) of the room.
  - Room volume is about 110–135 m³. Two sleepers produce about 0.03–0.04 m³/h of CO2 (rough figure for sleeping adults).
  - Steady-state rise ≈ G / (ACH × V). At 0.2 ACH that is roughly 1,200–1,500 ppm above outdoor.
  - This gives you an evidence-based answer to "do we need a ventilator / ERV".
- **Sleep-quality correlation:** chart nightly CO2 (mean, p95, minutes above 1000/1400 ppm) against Fitbit sleep stages, HRV and resting HR in a daily report.
  - Published work (e.g. Strøm-Tejsen et al., *Indoor Air* 2016) linked lower bedroom CO2 to better sleep and next-day performance. [M; not re-verified here]
- **Occupancy and "in-bed" proxy:** the CO2 rise rate tells you when both partners are in the room, which helps label sleep windows.
- **Door-open detection:** sudden CO2 drops show when the bedroom door was opened.
- **Aircon logic:** CO2 can't be fixed by the aircon, which only recirculates air. But cloud or app automations on CO2 could, for example, send a push to "crack the door" or switch on a future ventilation fan or ERV plug.
- **Humidity and dew point from the same unit:** the app's alert conditions also support absolute humidity, dew point and VPD for the Meter Pro line. [H for the Meter Pro doc] Use these for mould and condensation risk with the open bathroom.
- **Placement:**
  - Put it at bed or head height, 1–2 m from the sleepers, and not directly in the aircon supply stream.
  - Keep it away from the shower area (RH above 80% ages the sensor).
  - Keep it within Hub Mini Bluetooth range.
  - Keep the vents clear (SwitchBot asks for ≥1 cm clearance when comparing units).

## Sources consulted
- SwitchBot support articles, pulled via the Zendesk API (support.switch-bot.com/api/v2/help_center/en-us/articles/{id}.json):
  - 26502008033303, 26500991854487, 28265078873495, 28322226696983
  - 27211671722775, 28611503749527, 27266690216471, 26500977424535
  - 36635644782615, 28410554197783, 9696123584535, 25328810947351
  - 360060298693, 29238392261655, 26966864494359, 26503579941399
  - 28409755655063, 26500881438999, 36303041754391, 27730159946775
  - 28197492642839, 26287879750423, 36405172630039
- Official manual (Alza-hosted): https://dwn.alza.cz/manual/142051
- Press release: https://prnewswire.com/news-releases/switchbot-expands-the-environment-meter-product-portfolio-with-advanced-meter-pro--meter-pro-co2-monitor-302234875.html
- OpenAPI: https://github.com/OpenWonderLabs/SwitchBotAPI
- pySwitchbot: https://github.com/sblibs/pySwitchbot
- Home Assistant: https://www.home-assistant.io/integrations/switchbot/ and https://www.home-assistant.io/integrations/switchbot_cloud/
- Theengs: https://decoder.theengs.io/devices/SBMP.html
- Sensirion SCD4x datasheet v1.7: https://sensirion.com/media/documents/48C4B7FB/67FE0194/CD_DS_SCD4x_Datasheet_D1.pdf
- Reviews:
  - https://smarthomescene.com/reviews/switchbot-meter-pro-co2-monitor-setup-and-review/
  - https://hometechhacker.com/switchbot-meter-pro-co2-monitor-smart-sensor-review/
  - https://techtest.org/der-switchbot-meter-pro-im-test-smart-home-co2-messung/
  - https://www.airpurifierfirst.com/review/switchbot-co2-monitor/
  - https://rcmdnk.com/blog/2025/01/06/comuter-iot/
  - https://community.home-assistant.io/t/best-co2-sensor/333610/136


---

# Adversarial verification (independent fact-check)

# VERDICTS
- [partially-true] Reviewers (not SwitchBot) report the CO2 sensor as a Sensirion SCD40, which is photoacoustic NDIR.
  -> SmartHomeScene says 'uses the very accurate Sensirion SCD40', but cites no teardown. SwitchBot only says 'NDIR ... Swiss industrial-grade sensors', which fits Sensirion. The SCD4x is photoacoustic NDIR. Doubt about the variant: the SCD40 does not support single-shot mode (SCD41/43 only), and a 30-minute battery mode with year-long AA life suggests single-shot or power cycling. That makes an SCD41 plausible. The model is unverified. (https://smarthomescene.com/reviews/switchbot-meter-pro-co2-monitor-setup-and-review/)
- [partially-true] CO2 accuracy is ±(50 ppm + 5%); temperature ±0.2 °C (0-65 °C); humidity ±2 %RH (10-90 %RH at 25 °C).
  -> The CO2 figure ±(50 ppm + 5% of reading) is confirmed on the product page and the multiple-monitors article. The temperature and humidity figures come from SwitchBot's general 'About the Accuracy of SwitchBot Meter Products' article, which is about Meter/Meter Plus, not the cited CO2 article. Retailers list Meter Pro CO2 figures that differ (±0.2-0.5 °C, ±1.8-3 %RH). Also missed: if the sensor is an SCD40, Sensirion specifies its accuracy only from 400-2000 ppm. Two people in a sealed room can exceed 2000 ppm overnight, where error bands should widen. For an SCD41, the specified range is 400-5000 ppm. (https://support.switch-bot.com/hc/en-us/articles/9696123584535-About-the-Accuracy-of-SwitchBot-Meter-Products)
- [partially-true] No SwitchBot Meter, including the Meter Pro (CO2), has a backlight; the display is a reflective LCD.
  -> Two independent reviews confirm the Meter Pro (CO2) display is not backlit (SmartHomeScene: 'The displays also do not have a backlight'; techtest.org: 'nicht beleuchtet'). I could not open the cited support article (HTTP 403), so the claim that no Meter has a backlight is not verified here. Marketing says visual alerts 'flash numbers and show three different colours on the screen'. Those are colored LCD segments, which are reflective and not self-lit, but this is worth checking in the dark. (https://smarthomescene.com/reviews/switchbot-meter-pro-co2-monitor-setup-and-review/)
- [partially-true] There is no Do-Not-Disturb or schedule-based mute. Alerts can flash the screen and sound a buzzer of up to 100 dB, so turn off 'Alert Sound & Light'.
  -> Confirmed: an alarm of up to 100 dB with low, medium and high volume (press release). It can be muted with the top button or the app. The 'Alert Sound & Light' toggle is documented for the Meter Pro alert article (26966864494359). That article is not CO2-specific, though the CO2 model has the same three warning modes. No official source confirms or rules out a DND or schedule feature: it is absent from docs, not proven absent. Advice to disable on-device alerts and alert from your own app stands. (https://support.switch-bot.com/hc/en-us/articles/26966864494359-SwitchBot-Meter-Pro-Alert-Conditions-Feature)
- [partially-true] On-device history is about 36-40 days; with a Hub, cloud history is kept for up to 2 years and can be exported. A factory reset erases on-device data.
  -> The support article says the CO2 monitor keeps the most recent 36 days on the device (68 days for the plain Meter Pro). The product page says 38 days. The 40-day figure was not found. Two years in the cloud with a Hub is confirmed. Factory-reset erasure was not verified, as the support pages returned 403. (https://support.switch-bot.com/hc/en-us/articles/360060298693)
# ANSWERED
- Q: Does SwitchBot firmware keep Sensirion ASC enabled, and with what period?
  A: This is not documented by SwitchBot. Sensirion's default is enabled, with weekly >3 min exposure to 400 ppm counted over at least 4-hour blocks of periodic or 5-minute single-shot operation. However, if battery mode power-cycles the sensor between single shots, the datasheet says ASC is unavailable in that mode. On USB in continuous periodic mode, default ASC would be active and would drift low in a sealed room. Ask SwitchBot support and verify empirically by doing an outdoor calibration and watching for drift.
- Q: SCD40 or SCD41?
  A: No teardown was found. SmartHomeScene says SCD40, without evidence. The SCD40 lacks single-shot mode (SCD41/43 only), and the year-long battery life with 30-minute measurements fits an SCD41 better. Unresolved. A teardown photo or a BLE/firmware dump would settle it.
- Q: Is a 5-minute battery CO2 interval officially available?
  A: No official source found. The support doc still says a fixed 30 minutes. The product page claims '5-second interval in battery mode', which contradicts the support doc and looks like marketing error. Techtest's '5 min' figure is for temperature/humidity BLE updates on battery, not CO2, and may be the source of the confusion.
- Q: Exact on-device storage duration?
  A: The support article says 36 days for the CO2 model (68 days for the Meter Pro). The product page says 38 days. No source for 40 days was found. Plan for about 36 days.
- Q: Can screen flash be disabled separately from the buzzer?
  A: Not determinable from docs. The 'Alert Sound & Light' toggle seems to control both together, and the buzzer volume can be set low, medium or high (up to 100 dB). Test on the device.
# MISSED
- USB power adapter (5V/1A) is NOT included. With USB and AAs both installed, USB takes priority, and SwitchBot recommends removing the AAs for long-term USB use to avoid leakage (support 36635644782615).
- If the sensor is an SCD40, its accuracy is only specified from 400-2000 ppm (SCD41: 400-5000 ppm). Overnight CO2 for two people in a sealed 110-135 m3 room with no ventilation can exceed 2000 ppm, so readings above that are less reliable.
- Matter/Apple Home bridging requires a Matter-capable hub (Hub 2, Hub 3 or Hub Mini Matter Enabled). The legacy Hub Mini cannot bridge Matter, so check the exact Hub Mini model.
- Webhook timeOfSample is documented as the time the event is sent, not the measurement time. Store your own server receive time too.
- An independent review (techtest.org) found the Meter Pro reads CO2 noticeably lower than an air-Q reference (400-450 vs 400-550 ppm) while tracking the trend. This is consistent with ASC/baseline bias, which favors trend-based rather than absolute-threshold logic.
- Home Assistant's official SwitchBot Bluetooth integration supports Meter Pro (CO2) locally, a ready-made local path if they later add an always-on device or ESP32 BLE proxy.
- Sensirion's default ASC also assumes the sensor never sees CO2 below 400 ppm; exposure below 400 ppm with ASC on can hurt accuracy (datasheet footnote 5).