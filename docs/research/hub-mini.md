# SwitchBot Hub Mini: research report (as of 2026-10-28)

Each claim below has a source and a confidence level: **[H]** high, **[M]** medium, **[L]** low. Text marked *Inference* is my own reasoning. No source states it.

---

## 1. Which Hub Mini do you have? (variants)

| Variant | Model no. | Connector | Matter | Notes |
|---|---|---|---|---|
| Hub Mini (original, 2019) | **W0202200** | Micro-USB (early units) or USB-C (later units) | No | No sensors. Model number from the SwitchBot API glossary [H] https://github.com/OpenWonderLabs/SwitchBotAPI (README, Glossary). The connector variants come from SwitchBot's comparison article [H] https://support.switch-bot.com/hc/en-us/articles/13569889726743 |
| Hub Mini **Matter Enabled** (Jan 2024 onward) | **W0202203** | USB-C | Yes, as a Matter bridge with a **4 sub-device** limit | Matter certification for W0202200's successor, SKU W0202203, dated 2023-09-26 [H] https://csa-iot.org/csa_product/hub-mini/. Model W0202203 is also listed by retailers [M] (berrybase, JB Hi-Fi). Older Hub Minis do **not** get a Matter firmware update [M] https://smarthomescene.com/news/switchbot-is-releasing-a-new-matter-hub-mini/ |

- I found no Hub Mini successor such as a "Hub Mini 2" or W0202204 [M]. The SwitchBot line now runs Hub Mini, Hub Mini Matter Enabled, Hub 2, Hub 3 and AI Hub.
- **How to tell which one you have:**
  - The Matter version has a Matter QR/pairing-code sticker and card in the box.
  - It shows a "Matter Setup" entry in the app.
  - Its model is W0202203 on the label.
  - It has a USB-C port.
  - A unit bought in 2026 is very likely the Matter Enabled one. *Inference* [M].
- One retailer, berrybase, says the Matter version ships with a Micro-USB cable. This conflicts with SwitchBot's table, Smarthomescene and IT-Connect, which all say USB-C. Trust USB-C [M].
- **Physical:** 65×65×20 mm, 36 g [H] (us.switch-bot.com product JSON). Operating range −10 to 60 °C and 5–95 %RH [M] (Smarthomescene).

## 2. Power

- **Input:** DC 5 V. SwitchBot's comparison table lists the adapter output as "5V1A/5V2A" for both Mini variants [H] https://support.switch-bot.com/api/v2/help_center/en-us/articles/13569889726743.json. The quick-start PDF says "Please link the Hub Mini to a 5V*1A USB adapter before use" [H] https://cdn.shopify.com/s/files/1/0252/6615/9704/files/Getting_Started_with_SwitchBot_Hub_Mini.pdf
- **In the box:** a USB-A to USB-C cable, but **no power adapter**. Any phone charger works [M] https://www.it-connect.fr/test-du-switchbot-hub-mini-un-hub-compatible-matter/
- **Consumption:** SwitchBot says Hub 2 and Hub Mini draw 1–2 W, about 0.001–0.002 kWh per hour [M]. It does not say whether this was measured. https://support.switch-bot.com/hc/en-us/articles/27957651411735
- **Built-in battery:** none. It needs USB power all the time [H]. Some retailer pages list "lithium batteries"; those are template junk.
- **Power bank:** works electrically, since it is just a 5 V source. I found no official guidance [L].
  - *Inference:* at 1–2 W, a 10,000 mAh bank (about 37 Wh nominal, roughly 30 Wh usable) lasts about 15–30 h. That is impractical for 24/7 use.
  - Some power banks also auto-shut-off at low current draw.
  - A UPS-style power bank with pass-through could serve as backup power during outages.
- **Long cable:** not specified by SwitchBot.
  - *Inference* [M]: USB 2.0 passive cables are specified up to about 5 m. At about 0.2–0.4 A draw, a good-quality (thicker-gauge) 3–5 m USB-C cable, or a USB extension, should work fine.
  - Cheap thin cables longer than 3 m can drop the voltage enough to cause brown-out resets.
  - Better options: a 5 m USB-A to USB-C cable from a wall charger, or a 12 V/24 V run with a buck converter near the hatch.
- **Placement for this house:**
  - The hub does **not** need to be inside the ceiling. IR range is up to 30 m line of sight (see §4).
  - Two options:
    - Mount the hub on a wall or shelf near a power outlet, with line of sight to the dangling IR receiver module.
    - Or bring the receiver module down or out to a visible spot, then put the hub within a few metres of it.
  - SwitchBot's guidance is simply that the hub must face the appliance's IR receiver with no walls in between [H] https://support.switch-bot.com/api/v2/help_center/en-us/articles/8069379964695.json

## 3. LED indicator: important for the pitch-black bedroom requirement

- **Original Hub Mini, official** [H] (app V6.22+, article updated Feb 2023) https://support.switch-bot.com/hc/en-us/articles/360038348474
  - **Default:** the LED is **on constantly** and dims once when it sends IR or operates a SwitchBot device.
  - **Setting "Keep Turned on in Standby Mode" OFF:** the LED is off in standby and **blinks once** each time it operates.
  - **Setting "Indicator Light" OFF:** the LED is **always off, even during operation**. This is the setting you want.
  - **Setup:** the LED flashes at first power-on. Holding the button gives fast flashing (pairing mode). After the first internet connection, the LED stays solid.
- **Slow white blink** means the hub is connecting to the network [M] https://support.switch-bot.com/hc/en-us/articles/7131887006231
- **Auto-dimming: NO.** The Hub Mini has **no light sensor**. SwitchBot's table lists "Light sensor: ×" for both Mini variants. Only Hub 2 and Hub 3 have one [H] (comparison article above). The belief that the Hub Mini "auto-dims" is therefore not correct. You must turn the indicator off in the app settings.
- **Matter Enabled variant:**
  - I found no Matter-specific LED article.
  - IT-Connect's review says no LED is visible in normal operation [M].
  - Another reviewer saw a small white flashing light at the top right after power-up [L] https://tech.scargill.net/matter-enabled-switchbot-hub-mini/
  - *Recommendation:* check that the Indicator Light toggle exists on your unit. If not, cover the LED with a dot of black electrical tape. Tape over the LED does not block the IR emitters if you place it carefully. *Inference*.
- **Beeps:** the hub has no speaker. I found no report of the hub beeping [M].
  - **Watch out:** the **AC's IR receiver module** likely beeps and flashes its LEDs on every received command. Many Toshiba/Carrier indoor units do this. *Inference* [L].
  - This matters for an "Eight Sleep-like" schedule with many overnight adjustments. Test whether your receiver beeps.
  - If it does, limit command frequency (for example, change the setpoint only at 2–4 planned points per night). The other option is a wired controller or interface instead of IR, which is outside the Hub Mini's scope.

## 4. IR performance

- **Range and angle:** up to **30 m**, 360° vertical and 180° horizontal [M].
  - Sources: retailer listing https://arvutitark.ee/nutiseadmed/nutikodu/smart-home-hub-miniw0202200-switchbot-1359656 and IT-Connect review (same figures).
  - The manual excerpt confirms the angles only.
  - The "120 m" and "80 m" figures quoted by retailers refer to **Bluetooth**, not IR [M].
- **Very short distances (a few cm):** I found no documented minimum distance or saturation behaviour. A "20 cm" figure in the manual is an RF-exposure rule for the human body [M].
  - *Inference* [L]: consumer IR receivers have automatic gain control, so very close placement usually works.
  - If commands fail, SwitchBot's advice is to move or angle the hub until the appliance responds [H] (article 8069379964695).
  - Bouncing IR off a white ceiling or wall from 0.5–3 m away is a common and reliable approach.
- **Offline IR control:** the comparison table says "IR offline control: × (Hub Mini / Hub Mini Matter)" but ✓ for Hub 2/Hub 3 [H]. In practice the Hub Mini needs the cloud for app, API and scene IR commands.
  - One user report says the Hub Mini Matter kept working through Matter with outbound internet blocked, but only once mDNS (224.0.0.251:5353/UDP) was allowed [L] https://community.home-assistant.io/t/switchbot-hub-mini-matter-offline-mode-seems-to-work/1013035

## 5. Air-conditioner remotes (Toshiba Carrier ducted)

- **Learning modes** [H] (quick-start PDF; https://support.switch-bot.com/api/v2/help_center/en-us/articles/360038373593.json; https://support.switch-bot.com/api/v2/help_center/en-us/articles/34885181590807.json):
  1. **Smart Matching / Smart Learning (recommended).** Point the real remote at the hub and the app matches the code set in its database. This gives a full virtual AC remote: power, mode, temperature, fan.
  2. **Select Manually.** Pick the brand, then the model. If the exact model isn't listed, try similar ones.
  3. **Learn Buttons.** For an AC you can only learn **two buttons, ON and OFF**. Each learned signal is a complete state frame, because AC remotes send mode and temperature together in one signal, so they can't be learned separately. You can create **several AC remotes**, each with its own ON/OFF pair (for example, a "summer cooling" remote). Requires app 9.16+. Works with Alexa, Google and IFTTT.
  4. **Others (DIY).** Learn any number of named buttons one by one. Button names can't be a bare number 1–100 ("N1" is fine). Names can't be edited later. These remotes don't work with Alexa or Google directly; use Scenes instead.
- **Brand database:** SwitchBot publishes searchable compatible-model lists, updated about every 6 months: https://us.switch-bot.com/pages/search-for-compatible-infrared [M].
  - I could not confirm Toshiba or Carrier **ducted** remote coverage. Not found.
  - *Inference* [L]: Toshiba ducted wireless kits usually speak the same Toshiba AC IR protocol as Toshiba split units, so the Toshiba codes in Smart Matching have a reasonable chance of working. You can only confirm this by testing.
- **API control of the AC** (stateless "setAll") [H] https://github.com/OpenWonderLabs/SwitchBotAPI/blob/main/devices/others/virtual-infrared-remote-devices.md
  - The command looks like `{"commandType":"command","command":"setAll","parameter":"{temp},{mode},{fan},{power}"}`, for example `"19,2,2,on"`.
  - Temperature is in Celsius.
  - Mode: 0/1 auto, 2 cool, 3 dry, 4 fan, 5 heat.
  - Fan: 1 auto, 2 low, 3 medium, 4 high.
  - Power: `on` or `off`.
  - `turnOn` and `turnOff` also work for all types except Others.
  - Learned DIY buttons need `commandType:"customize"`, `command:"<button name>"`, `parameter:"default"`.
- **There is NO status read-back for IR remotes.** The API has no getStatus for virtual IR devices. Home Assistant infers state from previous commands: "might not reflect reality if you use other ways to control the device" [H] https://www.home-assistant.io/integrations/switchbot_cloud
  - Your app must keep its own state table and should always send full `setAll` frames.
- **The Hub Mini cannot read the physical remote.** The AC remote state-sync (IR decoder, beta, about 1,800 AC models, whitelist required) is documented for **Hub 2 only** [H] https://support.switch-bot.com/api/v2/help_center/en-us/articles/17171727415703.json. If someone uses the physical remote, your app's state drifts.
- **Smart Schedule (Beta):** SwitchBot's own AC temperature-schedule feature (Home, Away, Sleep, Comfort, Custom modes; 14-day auto-learning) is **Hub 2/Hub 3 only**, not Hub Mini [H] https://support.switch-bot.com/api/v2/help_center/en-us/articles/28729959265303.json
- **Fallback if Smart Matching fails:** create several "Learn Buttons" AC remotes, each holding one full state ("AC 18 °C cool low", "AC 20 °C", "AC 22 °C", ...), then call `turnOn` on whichever remote matches the target. Or use Others mode with named buttons and call them through `customize`. *Inference, built from documented features* [M].

## 6. Bluetooth gateway role

- The Hub Mini bridges SwitchBot BLE devices, including the **Meter Pro (CO2 Monitor)**, to the SwitchBot cloud. Without a hub, the meter is phone-BLE only and gets no API, webhook, cloud history or alerts [H].
  - Sources: API README ("You MUST first add a SwitchBot Hub such as Hub 2, Hub Mini with Matter Enabled, or Hub Mini"); Meter Pro CO2 product page; https://hometechhacker.com/switchbot-meter-pro-co2-monitor-smart-sensor-review/
- **BLE spec:** BLE 4.2+, about 80 m stated range [M] (IT-Connect). Retailers quote up to 120 m line of sight [L]. In a single 40–50 m² room, range is not an issue.
- **Update cadence:**
  - Meter Pro CO2 on **USB-C power (5 V 1 A)**: CO2 updates **every 1 min**, and the interval is customisable in App > Meter Pro (CO2) > gear > Panel Display > Data Update Interval > CO2. Going below 1 min keeps the sensor always on, which warms the device and hurts accuracy [H] https://support.switch-bot.com/api/v2/help_center/en-us/articles/26502008033303.json
  - On **battery**: CO2 updates every 30 min, fixed [H]. **Run it on USB.**
  - The meter samples every 4 s and saves every minute [H] https://support.switch-bot.com/api/v2/help_center/en-us/articles/25328810947351.json
  - Upload to the cloud through the hub is variable: about every 30 min when stable, 10 min with larger changes, as often as 2 min with big changes. That article covers temperature and humidity [H].
- **The cloud is coarser than the device's own log.** For full 1-minute resolution, you would need BLE history sync or CSV export through the phone app. *Inference* [M]; I did not verify a device history length.

## 7. Wi-Fi

- **2.4 GHz only** (802.11b/g/n), IPv4. No 5 GHz [H] (quick-start PDF: "5G Wi-Fi is not supported for now"; IT-Connect).
- SwitchBot support articles add: WPA-PSK/WPA2-PSK are supported; WPA2-PEAP, WEP and WPS are not. Some Wi-Fi 6 and IPv6-only setups are problematic [M] https://support.switch-bot.com/hc/en-us/articles/4403394297751
- With a dual-band single-SSID router, pairing may need the phone forced onto 2.4 GHz [M].
- Tip: an iPhone hotspot with "Maximize Compatibility" switched on runs at 2.4 GHz [M].

## 8. Matter (Hub Mini Matter Enabled only)

- **It is a Matter bridge with a 4 sub-device cap.** Hub 2 has 8, Hub 3 has 30 [H] https://support.switch-bot.com/api/v2/help_center/en-us/articles/13282638111127.json
  - Some reviews claim 8 for the Mini (easygoingnerd, July 2026) [L]. Another said 6 (HomeKitNews, Jan 2024) [L]. SwitchBot's own article says **4**.
- **What it can expose** (SwitchBot Matter compatibility article, updated 2026-10-27) [H] https://support.switch-bot.com/hc/en-us/articles/38979658026519
  - Bridged "IR Appliances: Air Conditioner", plus other IR devices (on/off only).
  - Sensors: Meter Pro and **Meter Pro (CO2 Monitor)**.
  - Locks, Bot, Curtain and so on.
  - Some items, such as the virtual IR remote, sit under a "Lab Feature (Beta)" list.
- **IR AC in Apple Home:**
  - SwitchBot marketing says AC gets power on/off, mode change and temperature adjustment; other IR devices are on/off only [M] (product pages).
  - SwitchBot's Matter page lists AC functions as On/Off, Cool, Warm (heat) and Set Temperature. **Fan speed is not exposed** [M] (search snippet of https://us.switch-bot.com/pages/matter; the full table could not be fetched).
  - Exact Matter device type (thermostat or something else): **not confirmed** in any source I found.
  - One review (easygoingnerd) claims IR is not bridged at all. This contradicts SwitchBot's documentation [L].
- **CO2 in Apple Home:** "Currently, CO2 readings are not supported on the Apple Home App" [H] (article 13282638111127). Temperature and humidity from the meter do come through.
- **Hub Mini Matter onboard sensor:** none built in. Temperature and humidity are possible only with a dedicated sensor charging cable, which you can request free through App > Profile > Support > Feedback [H] (articles 13569889726743 and 13282638111127).
- **Matter controller needed:** a HomePod, Apple TV or Nest hub is required for Matter in Apple Home [H].
- **Home Assistant:** HA can add the hub through its Matter integration, and bridged devices then appear [M] (IT-Connect).
- *Inference:* Matter is the **only local (LAN) control path** for this hub. It is not relevant to a cloud-only app with no home server.

## 9. Local API? Programmability? "Always-on compute"?

- **No local API.** The documented API is cloud-only at `https://api.switch-bot.com` [H] (README).
- The Hub Mini has no getStatus of its own. The hub row in the API table shows List ✓, Status −, Command −, Webhook − for "Hub/Hub Plus/Hub Mini/Hub 2/Hub 3" [H]. Hub 2 and Hub 3 have their own Status and Webhook entries; the Mini does not.
- **It is not programmable compute.** You cannot run code on it. I found no supported custom firmware or ESPHome port for the Hub Mini; searches found ESPHome flashing only for the SwitchBot Plug Mini [M].
- It is an always-on **gateway**: Wi-Fi, BLE to cloud bridge, and IR emitter.
- **SwitchBot app Scenes run in the SwitchBot cloud**, not on the Mini [M].
  - The quick-start PDF says scenes are "executed within 2 minutes once the condition(s) has met."
  - Local automations exist only with an AI Hub as master hub; a Hub Mini can join as a slave [M] https://support.switch-bot.com/hc/en-us/articles/37437759812247

## 10. How a cloud app gets near-real-time data (no Raspberry Pi needed)

- **Auth (API v1.1)** [H] (README):
  - Headers: `Authorization` (token), `t` (13-digit ms timestamp), `nonce` (UUID), and `sign`.
  - `sign` = uppercase(base64(HMAC-SHA256(secret, token + t + nonce))). The token and secret are in app ≥ V6.14.
  - Note: this is **base64**, not hex.
- **Rate limit:** **10,000 calls/day**. Going over returns "Unauthorized" [H].
  - Polling one meter every minute is 1,440 calls/day.
  - Leave headroom for AC commands.
- **Webhooks** [H] (README):
  - Register with `POST /v1.1/webhook/setupWebhook` and body `{"action":"setupWebhook","url":"https://...","deviceList":"ALL"}`.
  - Related endpoints: queryWebhook, updateWebhook, deleteWebhook.
  - "All device and scene events will be delivered to this endpoint."
  - **Meter Pro CO2 webhook payload** [H] https://github.com/OpenWonderLabs/SwitchBotAPI/blob/main/devices/sensors/meter-pro-co2.md:

    `{"eventType":"changeReport","eventVersion":"1","context":{"deviceType":"MeterPro(CO2)","deviceMac":"...","temperature":22.5,"scale":"CELSIUS","humidity":31,"CO2":1203,"battery":100,"timeOfSample":123456789}}`

  - **Meter Pro CO2 status** via `GET /v1.1/devices/{id}/status` returns `temperature` (float °C), `humidity` (int %), `CO2` (int ppm, 0–9999), `battery`, `version` [H].
  - **No webhook signature or verification is documented.** Use an unguessable secret path or query token on your Supabase Edge Function or Vercel endpoint. *Inference* [M].
  - Home Assistant notes that "Only ONE webhook URL seems to be accepted by the SwitchBot's cloud" [M] https://www.home-assistant.io/integrations/switchbot_cloud. If you also use Home Assistant or Homebridge, they would compete for that URL.
  - **Webhook cadence for meters is not documented.** It tracks the hub's upload cadence (§6). A Homey forum user says newer meters report on change [L]. **Log `timeOfSample` deltas for a few days**, and back up the webhook with a light poll (every 5–10 min).
- **Recommended architecture** (*inference* [M]):
  - Sensor path: SwitchBot cloud webhook → Supabase Edge Function or Vercel route → Postgres → PWA charts.
  - Control path: a scheduled cron job (Supabase pg_cron or Vercel Cron) computes the target temperature and calls `setAll`.
  - The app keeps an AC state table, because IR gives no feedback.
- **Scenes via API:**
  - `GET /v1.1/scenes` lists manual scenes.
  - `POST /v1.1/scenes/{sceneId}/execute` runs one [H].

## 11. Open-source and creative uses found

- **OpenWonderLabs/homebridge-switchbot** (official) [M]:
  - Exposes the IR AC to HomeKit with on/off, temperature and mode.
  - v2.7.0 added using a SwitchBot Meter's temperature as the AC's current temperature.
  - v4.3.0 added Meter Pro and Meter Pro (CO2) as `meterType` for the IR AC. This gives closed-loop display in Apple Home.
  - Source: https://newreleases.io/project/github/OpenWonderLabs/homebridge-switchbot/release/v2.7.0. It needs a Homebridge host, which you don't have.
- **Home Assistant `switchbot_cloud`** [H]:
  - IR AC: on/off, temperature and mode; state inferred.
  - Polls sensors every 600 s.
  - Webhook push for some devices.
- **yasu89/switch-bot-mcp-server** (Go, MIT) [M]:
  - MCP server with tools `get_switch_bot_devices`, `get_switch_bot_device_status` and `execute_command`.
  - Could let Claude query and control the devices directly.
  - Small project; last push June 2025.
  - https://mcpservers.org/servers/yasu89/switch-bot-mcp-server
- **Patterns people use** [M]:
  - Meter-triggered scenes, for example "if temp > X then AC cool", run in the cloud with up to about 2 min latency.
  - Scheduled AC on/off.
  - Multiple "Learn Buttons" AC remotes as presets (seasonal profiles; documented by SwitchBot).
  - Requesting the Hub Mini Matter sensor cable to get a free extra temperature/humidity point.

## 12. Known issues and gotchas

- 2.4 GHz-only pairing failures on mesh or single-SSID routers [M].
- IR state drift: no feedback, and the Hub Mini can't decode the physical remote [H].
- Hub Mini scenes need the cloud. Latency is about seconds via the API and up to about 2 min for meter-triggered scenes [M].
- Firmware updates on first connect: leave the hub plugged in for about 10 min [L].
- Matter: 4 sub-devices max. CO2 is not shown in Apple Home [H].
- The LED is on by default. Turn off "Indicator Light" for a dark bedroom [H].
- If the remote is added via Learn Buttons or Others, `setAll` won't work. Use `turnOn`/`turnOff` on separate preset remotes, or `customize` buttons [H].

## Bottom line for this project

- The Hub Mini is a cloud-tethered IR and BLE gateway, not compute.
- Run the Meter Pro CO2 on USB-C, so CO2 updates every 1 min.
- Turn the Hub Mini indicator light off.
- Mount the hub anywhere with line of sight to the AC's IR receiver, within 30 m, on a wall-powered USB adapter. It does not need to go in the ceiling.
- Try Smart Matching for the Toshiba remote first, so the app can use `setAll`.
- Build the "dynamic temperature" loop in Supabase or Vercel: webhook ingest plus scheduled `setAll`, keeping AC state server-side.
- Test whether the AC receiver beeps on each command before committing to frequent overnight changes.


---

# Adversarial verification (independent fact-check)

# VERDICTS
- [partially-true] The Hub Mini has no ambient light sensor, so it does not auto-dim. The LED is on by default, and switching 'Indicator Light' off in the app keeps it off even while sending IR.
  -> Confirmed: the Hub Mini and the Hub Mini Matter Enabled have no light sensor (official comparison table: Light sensor x), so the LED does not auto-dim. There are two settings, though. 'Indicator Light' and 'Keep Turned on in Standby Mode' are both on by default; in that state the LED stays lit and dims once for each command. Turning off only 'Keep Turned on in Standby' leaves the LED off at rest, but it BLINKS ONCE on every IR command, which would flash all night under a dynamic-temperature loop. Only turning off 'Indicator Light' itself keeps it dark during commands. The LED still flashes at first power-on, in pairing mode, and is solid when it first connects. The article dates from Feb 2023 and names only the original Hub Mini, so the toggle on the Matter model is unconfirmed. (https://support.switch-bot.com/hc/en-us/articles/360038348474-Learn-More-About-the-Indicator-of-SwitchBot-Hub-Mini)
- [partially-true] Power is DC 5V via USB (5V1A/5V2A adapter). The Matter Enabled model uses USB-C. No adapter is included and there is no battery. Draw is about 1-2 W.
  -> Official table: adapter output 5V1A/5V2A. The connector is 'Micro USB / USB Type C' for the Hub Mini (it varies by revision) and USB-C for the Matter Enabled model. The Getting Started PDF says 'link the Hub Mini to a 5V*1A USB adapter before use'. I found no primary source for 'no adapter included' or for a 1-2 W draw, so treat both as plausible but unverified. Missed fact: the Matter Enabled model can read temperature and humidity through a special charging cable with a built-in sensor, available only on request through app Feedback. (https://support.switch-bot.com/hc/en-us/articles/13569889726743)
- [unverifiable] IR range is up to 30 m line of sight (360° vertical, 180° horizontal). Higher range figures quoted by retailers are for Bluetooth. No minimum distance is documented.
  -> No SwitchBot primary source gives an IR range for the Hub Mini; the only support statements are that IR does not pass walls and that you should adjust placement until the appliance responds. Retailer figures of 120 m are for Bluetooth, which is correct. For comparison, SwitchBot states that its Universal Remote reaches 13.5 m head-on. Treat 30 m as a third-party review figure and test it in place. (https://support.switch-bot.com/hc/en-us/articles/23466706934167)
- [partially-true] Meter Pro CO2 updates CO2 every 1 min on USB-C (customisable) but only every 30 min on battery. Cloud upload through the hub varies, roughly every 2-30 min.
  -> Confirmed: 30 min on battery (not customisable) and 1 min automatically on a 5V1A USB-C supply, adjustable in the app; below 1 min the sensor stays on and self-heating can hurt accuracy. Small changes (±20 ppm) may not be displayed. The '2-30 min cloud upload' figure is not documented by SwitchBot. (https://support.switch-bot.com/hc/en-us/articles/26502008033303-Update-Frequency-of-CO2-Readings-on-SwitchBot-Meter-Pro-CO2-Monitor)
- [partially-true] The API is cloud-only (api.switch-bot.com), limited to 10,000 calls/day, with HMAC-SHA256 base64 uppercase signing. There is no local API, and the Hub Mini cannot run code.
  -> The 10,000-call daily limit and HMAC-SHA256 base64 upper-case signing are confirmed in the README. 'No local API' holds for the Hub Mini's Wi-Fi, but it overstates things. The Meter Pro CO2 broadcasts its readings as BLE advertisements, which local tools such as Home Assistant or ESPHome can read. The Hub Mini Matter Enabled also exposes bridged devices locally over Matter. Neither route helps without a local controller, which this couple does not have. (https://github.com/OpenWonderLabs/SwitchBotAPI)
- [partially-true] The Hub Mini (and Hub Mini Matter) cannot control IR offline. IR offline control is Hub 2/Hub 3 only. App scenes run in the cloud with up to about 2 min latency.
  -> The comparison table confirms 'Infrared remote offline control' is not available on the Hub Mini or the Hub Mini Matter. One nuance: a separate article says the Hub 3 lacks Hub 2-style offline IR and only offers offline control through its own buttons. The '~2 min scene latency' figure has no primary source. (https://support.switch-bot.com/hc/en-us/articles/13569889726743)
- [partially-true] Hub Mini Matter Enabled bridges at most 4 sub-devices to Matter. CO2 readings are not supported in Apple Home. The IR AC is listed as bridgeable (on/off, cool/heat, set temperature; no fan speed).
  -> Confirmed: 4 sub-devices (note 11) and no CO2 in Apple Home (note 9); the Meter Pro CO2 bridges temperature and humidity only. The AC row is worded 'IR remotes learned by Hub 2...' and lists 'cooling, heating, and on/off', with no fan speed, dry or fan mode. Learn Buttons remotes are not syncable to Apple Home, and Others-mode remotes are on/off only. 'Set temperature' is not stated explicitly for the Matter Mini. (https://support.switch-bot.com/hc/en-us/articles/13282638111127)
- [partially-true] AC remote-state sync from the physical remote (IR decoder) and SwitchBot Smart Schedule are Hub 2/Hub 3 only, not the Hub Mini.
  -> Smart Schedule (Beta) is Hub 2/Hub 3 only. The IR Decoding article names only the Hub 2, not the Hub 3. It covers about 1,800 AC models, will get no further additions, and requires a whitelist request through app Feedback. Either way, a Hub Mini cannot track state, so using the physical remote causes the app's stored state to drift. (https://support.switch-bot.com/hc/en-us/articles/17171727415703)
# ANSWERED
- Q: Does the Hub Mini Matter Enabled expose the same 'Indicator Light' toggle?
  A: Not documented. The LED article dates from Feb 2023 and names only the Hub Mini. Check in the app after setup; if the toggle is missing, cover the LED with black tape (it has no light sensor, so tape will not affect anything).
- Q: Does SwitchBot's cloud accept more than one webhook URL per account?
  A: Unresolved. The API docs return 'urls' as an array and queryDetails takes a urls list, which hints that several may be allowed, but nothing confirms it, and community reports say only one is accepted. Design for a single URL and fan out from Supabase or Vercel.
- Q: How much on-device history does the Meter Pro CO2 store?
  A: SwitchBot says the Meter and the Meter Pro CO2 store the most recent 36 days of temperature and humidity on the device, read over Bluetooth. The article does not say whether CO2 history is stored on the device or at what resolution. With a hub, data is stored in the cloud; the Outdoor Meter article cites up to 2 years.
- Q: Is the Toshiba Carrier ducted remote in SwitchBot's IR database?
  A: This can only be verified by testing Smart Matching or Select Manually in the app. If neither works, use Others mode with one button per setpoint (works through the API with customize) or Learn Buttons (ON/OFF presets).
# MISSED
- The LED trap: turning off only 'Keep Turned on in Standby Mode' still makes the LED blink once per IR command. The main 'Indicator Light' toggle must be off for a pitch-black room.
- Others-mode IR remotes cannot be linked to Alexa or Google Home, and button names cannot be bare numbers from 1 to 100. Learn Buttons remotes cannot sync to Apple Home.
- The Hub Mini Matter Enabled can provide temperature and humidity only with a special sensor charging cable, requested through app Feedback.
- Meter Pro CO2 accuracy is ±(50 ppm + 5% of reading). Manual calibration means placing it outdoors for about 1 minute, which in Phuket's heat and humidity also disturbs the temperature and humidity readings for a while.
- Setting the Meter Pro CO2 interval below 1 minute keeps the sensor on and self-heating hurts accuracy, so 1 minute is the practical minimum.
- SwitchBot app automations can use CO2 level as a trigger once the meter is connected to a hub. Since App 9.0 no manual 'Cloud Service' toggle is needed; the meter only has to be within the hub's Bluetooth range.
- Hub 2/Hub 3 Smart Schedule offers sleep-mode setpoints, a minimum on/off time and a margin. If an always-on cloud loop proves unreliable, upgrading to a Hub 3 (which also shows CO2 status and has a light sensor) is a fallback.
- IR Decoding (state sync from the physical remote) requires a whitelist request, covers a fixed list of about 1,800 AC models with no further additions, and is documented for the Hub 2 only.