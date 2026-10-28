# Installation guide: order and steps

Total time is about 1½–2 hours. Do it in this order:

1. **Hub Mini.** It is the gateway: the meter only reaches the cloud through it, and the aircon only through its IR.
2. **Meter Pro CO2.** Start measuring as early as possible, because we want 1–2 weeks of baseline data before the system starts changing anything.
3. **Aircon remote.** Set it up on the Hub Mini.
4. **Developer token.** This lets our app talk to SwitchBot.
5. **Pan/Tilt Cam Plus 3K.** Most setup, least urgent. Do it last, or another day.

> Have ready: an iPhone, your **2.4 GHz** Wi-Fi password, **two USB power adapters** (5 V/1 A or better; neither the Hub Mini nor the Meter includes one), the Carrier remote, a ladder or chair for the aircon hatch, and some black electrical tape.

---

## 0. App and account (5 min)
1. Install the **SwitchBot** app from the App Store and create an account. Set the region to Thailand / Asia.
2. Allow **Bluetooth**, **Local Network** and **Notifications** when asked.
3. Wi-Fi: SwitchBot devices only work on **2.4 GHz**.
   - If your router uses one name for both 2.4 and 5 GHz and pairing fails, temporarily disable 5 GHz.
   - Alternatively, pair through your iPhone hotspot with **Maximize Compatibility** on, then switch Wi-Fi in the app later.

## 1. Hub Mini (15 min)
1. **Where to put it:** near a socket, at roughly ceiling-hatch height or on a high shelf, with a **clear line of sight to the aircon's IR receiver module** (the small box with 3 LEDs hanging from the unit).
   - It does not need to be in the ceiling, and it does not need to be close; across the room is fine.
   - Leave the receiver module where you can see it. Fix it with its own clip or tape, and don't extend or splice its cable.
2. Check the label: **W0202203** means the Matter Enabled model, **W0202200** means the original. Tell me which one you have.
3. Plug it in. App → **+** → Add Device → Hub Mini. Hold the button until the LED flashes fast, then join your Wi-Fi.
4. Leave it powered for about 10 min so it can **update its firmware** (App → Hub Mini → ⚙ → Firmware).
5. **Darkness:** ⚙ → **Indicator Light → OFF**.
   - Turning off only "Keep Turned on in Standby" is not enough: the light still blinks on every command.
   - If your model has no Indicator Light setting, put a dot of tape over the LED. Keep the tape off the IR emitter, which sits to the right of the LED.
6. **Matter / Apple Home:** skip it for now. It caps you at 4 devices and doesn't show CO₂. Our app replaces it.

## 2. Meter Pro CO2 (20 min, plus 5 min outside)
1. Insert the 2× AA batteries. App → **+** → Meter Pro (CO2 Monitor) → follow the pairing steps (hold the button 2 s).
2. Update its firmware if the app offers it.
3. **Calibrate outdoors on batteries** (this matters for a room that is never ventilated):
   - Take it outside: balcony or garden, in the shade, away from people and car exhaust.
   - Wait about 1 min, then go to ⚙ → **Calibrate → CO₂ Monitor → Calibrate**.
   - **Don't touch it for 5 minutes.** Keep your phone within Bluetooth range.
   - Health check: it should read **400–500 ppm** outside.
4. Bring it in. **Remove the AAs** and power it from **USB-C on a 5 V/1 A adapter**. On USB it refreshes CO₂ every minute; on batteries, only every 30 minutes.
5. Settings (⚙):
   - Panel Display → Data Update Interval → **CO₂: 1 min**. Don't set it below 1 min; that self-heats the sensor.
   - Alert Conditions → **Alert Sound & Light: OFF**. Otherwise it can beep at up to 100 dB at night, and it has no do-not-disturb. Our app will handle alerts.
   - Units: °C. Clock: 24 h.
6. Open the meter's chart page and tap **Store Data in Cloud**. This keeps 2 years of history and makes the data available to our app.
7. **Where to put it:** bed height (bedside table), 1–2 m from your heads.
   - Not in the aircon's airflow.
   - **Not near the shower.** Long periods above 80 % RH age the sensor.
   - Leave at least 1 cm of free air around the vents.
8. Every week or two: give it **5–10 min outside** again. A monthly re-calibration is optional.

## 3. Aircon remote on the Hub Mini (20 min)
1. App → Hub Mini → **Add Remote → Air Conditioner → Smart Matching** (it may be called Smart Learning).
2. Point the **Carrier remote** at the Hub Mini from about 10–20 cm away and press power. The app suggests a code set.
   - If it doesn't find one, try **Select Manually → Toshiba**, then **Carrier**.
3. **Test properly:** on/off, cool at 18 / 20 / 22 °C, fan speed, and DRY mode. All of them must work, which means you got the full code set. Our app then uses `setAll`.
4. If no code set works fully, create an **"Others"** remote instead. Learn these buttons, each as a complete remote state (set the Carrier remote to the state, then learn power/send):
   - `C18`, `C19`, `C20`, `C21`, `C22`, `C23`, `C24` — cool, auto fan, at each temperature
   - `DRY22`
   - `OFF`

   Button names can't be plain numbers, which is why each starts with a letter.
5. Also learn **ECO SLEEP** and **Hi-Power** as custom buttons.
6. **Listen and look at the receiver module** while you send commands. Note whether it **beeps** and which LEDs light up.
   - Tape over the LEDs, but **not over the black IR window**.
   - If it beeps on every command, our controller will send fewer, larger steps.
7. **Rating plate:** while you're up the ladder, photograph the indoor unit's plate (`RAV-…` model), or the outdoor unit's plate instead. This decides whether the two-way wired control upgrade is possible.

## 4. Developer token (2 min)
1. App → **Profile → Preferences**. If you don't see **Developer Options**, tap **App Version** about 10 times.
2. Copy the **Token** and **Secret**. Send them to me privately when we connect the backend; don't paste them into GitHub. We'll store them as Supabase secrets.
3. Get each device's ID. Our app lists them automatically, so you don't need to do anything here.

## 5. Pan/Tilt Cam Plus 3K (30 min, can wait)
1. Optional: insert a **microSD card** (up to 256 GB, FAT32) for continuous local recording, about 42 days at 256 GB.
2. Plug in the included **5 V/2 A** adapter. App → **+** → Pan/Tilt Cam Plus 3K → scan the QR code shown in the app with the camera.
3. **Update the firmware first.** Local video streaming (RTSP) only arrived in 2025 firmware.
4. **Where to put it:** a shelf or ceiling mount (base and screws included) that looks at the bed. If it's on the ceiling, turn on ⚙ Basic Settings → **Flip Screen**.
5. Settings:
   - **Night Vision: Auto.** It uses 940 nm IR, officially invisible. Check in the dark whether you can see any glow.
   - **Indicator light: OFF**, if the toggle exists; otherwise tape over it. When online the LED is solid green.
   - **More Features → Camera Account:** create a username and password (different from your SwitchBot password). This enables the local video stream for our later babycam work.
   - Motion detection: on, with notifications **off at night** (use a schedule) so your phone doesn't light up.
   - **Privacy Mode:** optionally schedule it on during the day; the lens rotates away.
6. "AI Guard" cloud plan: you don't need it. Our own pipeline will do the AI.

## 6. Fitbit Air and Google Health (5 min)
1. Make sure each of you has a profile in the **Google Health** app. Our app reads the data through Google's API.
2. Charge the bands **outside sleep hours**. The Air has a red low-battery light and vibrates for Smart Wake.
3. Optional: Google Health → Profile → Partner apps → **Apple Health** sync.

## 7. Darkness audit (10 min, at night)
Turn the lights off and let your eyes adapt for 10 minutes. Then cover anything that still glows:
- the aircon receiver LEDs
- the Hub Mini (if it isn't fully off)
- the camera LED
- chargers, TV standby lights and the router

## What to send me afterwards
- Hub Mini model (W0202203 or W0202200)
- Whether Smart Matching worked, and which brand/code set
- Whether the receiver beeps
- A photo of the aircon rating plate
- Outdoor calibration reading (ppm)
- Camera firmware version
