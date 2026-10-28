# Visualization catalogue

Every signal we can measure, and how to show it. **Phase** tells you what each chart depends on:
- **P1** — room data only (Meter + Hub Mini via the cloud)
- **P2** — adds Google Health (Fitbit Air)
- **P3** — needs the camera and a home box (a small always-on computer)
- **iOS** — needs the Health Auto Export app

Design rules:
- Every room chart shares one time axis and one "night window" (lights-out to wake), so charts stack and line up.
- CO₂ uses fixed bands with a ±(50 ppm + 5 %) tolerance ribbon. The bands are <800 green, 800–1,000 amber, 1,000–1,500 orange and >1,500 red.
- Night mode is red-on-black with very low brightness. Day mode is the normal theme.

---

## 1. Morning report (the home screen)

| # | Visual | Data | Phase |
|---|---|---|---|
| 1.1 | **Score rings** (Oura style): *Sleep Air*, *Recovery*, *Sleep*, one set per person. Tap a ring to see what drove the score. | Room metrics; HR, HRV, stages | P1 / P2 |
| 1.2 | **Night strip**: a hypnogram (sleep stages over the night) with the room traces stacked under it on the same time axis. Rows: temperature, RH, CO₂ with colour bands, aircon commands as ticks, events (shower, door, out-of-bed). | Everything | P1 → P2 |
| 1.3 | **Score drivers waterfall**: each factor's contribution to the score, e.g. "+6 cool first 4 h · −9 CO₂ > 1,000 for 3 h 10 m". | Model output | P2 |
| 1.4 | **One-line insight card** written by Claude, with a "why" link to the chart behind it. | Nightly job | P1 |
| 1.5 | **Tonight's plan**: the planned temperature curve drawn over last night's actual curve. Drag to adjust it. | Schedule, room data | P1 |

## 2. Room environment

| # | Visual | Data | Phase |
|---|---|---|---|
| 2.1 | **Live tiles** with 6-hour sparklines: temperature, RH, CO₂, dew point. | Meter | P1 |
| 2.2 | **CO₂ ramp with forecast**: tonight's curve, the fitted build-up model, and a dashed projection ("≈1,450 ppm by 06:30"). | CO₂ + model | P1 |
| 2.3 | **Air-change (ACH) tracker**: each morning's CO₂ decay fit as a dot. Fresh air per hour, plotted over weeks. Annotate door-open nights and a future ventilation install. | CO₂ decay | P1 |
| 2.4 | **Ventilation verdict gauge**: median nightly CO₂ against the 1,000 ppm decision line, plus "ERV payback" text. | CO₂ | P1 |
| 2.5 | **Comfort chart**: a temperature × RH scatter with the sleep-comfort box (18–22 °C, 45–55 %), one dot per 5 min, coloured by time of night. Shows "cold and clammy" drift. | Temp, RH | P1 |
| 2.6 | **Calendar heatmap**: minutes above 1,000 ppm per night, plus a second heatmap for minutes outside the temperature target. | CO₂, temp | P1 |
| 2.7 | **24-hour radial clock**: the room's daily cycle of CO₂ and temperature. Shows when you're home, when the aircon runs, and when the room "breathes". | Meter | P1 |
| 2.8 | **Event timeline** of detected events: 🚿 shower (RH spike), 🚪 door or slider opened (CO₂ drop), 🛏 in-bed / both-in-bed (CO₂ rise rate), 🏠 empty room. | Derived | P1 |
| 2.9 | **Shower impact card**: temperature and RH before, during and after a shower, the minutes to recover, and the extra aircon time it cost. | RH, temp | P1 |
| 2.10 | **Outdoor vs indoor**: Phuket weather (Open-Meteo) next to the bedroom. Shows aircon load and dew point. | Weather API | P1 |

## 3. Aircon and thermal model

| # | Visual | Data | Phase |
|---|---|---|---|
| 3.1 | **Setpoint vs actual**: a step line of commanded °C over the measured bed-height °C. Shaded gaps show lag. Flag "command probably missed" when the temperature doesn't respond. | AC log, temp | P1 |
| 3.2 | **Room response curves**: minutes to cool 1 °C, by outdoor temperature and door state. Our learned model of the room. | AC log, temp | P1 |
| 3.3 | **Aircon duty estimate and 🧹 filter clock**: estimated runtime from the cooling slope, and days since the last filter clean. | Derived | P1 |
| 3.4 | **Curve editor**: Eight-Sleep-style phases (pre-cool, onset, deep, REM, wake) as draggable handles. | Schedule | P1 |

## 4. Body (per person, from Google Health)

| # | Visual | Data | Phase |
|---|---|---|---|
| 4.1 | **Sleeping-HR curve**: minute-median heart rate, with the **nadir** (lowest point) and its time marked. A late nadir means a late meal, alcohol or a warm room. | `heart-rate` | P2 |
| 4.2 | **Ridgeline of the last 14 nights' HR curves**: one stacked curve per night, to spot patterns. | `heart-rate` | P2 |
| 4.3 | **HRV through the night**: RMSSD samples with nightly deep-sleep RMSSD, against a 30-day baseline band (±1 SD). | `heart-rate-variability`, daily HRV | P2 |
| 4.4 | **SpO₂ strip**: per-minute SpO₂ with dips of ≥3 % flagged; an ODI-style count of dips per hour. | `oxygen-saturation` | P2 |
| 4.5 | **Breathing rate by stage**, with signal quality. | `respiratory-rate-sleep-summary` | P2 |
| 4.6 | **Temperature deviation trend**: nightly reading vs baseline, with room temperature drawn alongside as a confounder. | daily sleep temperature | P2 |
| 4.7 | **Our own sleep/wake estimate vs Google's stages**, to show when Google's algorithm changes. Re-processed nights are shown as versions. | HR + steps vs `sleep` | P2 |
| 4.8 | **Recovery trend**: resting HR, HRV and deep-sleep minutes over 7, 30 and 90 days, with baseline bands. | daily types | P2 |

## 5. Room × body ("what actually helps")

| # | Visual | Data | Phase |
|---|---|---|---|
| 5.1 | **Scatter with a fitted trend line**: deep sleep, HR nadir or HRV against early-night room temperature, mean CO₂ or RH. One dot per night per person. | Joined | P2 |
| 5.2 | **CO₂ bucket comparison**: HRV and deep sleep on nights below 800, 800–1,200 and above 1,200 ppm, with confidence intervals. | Joined | P2 |
| 5.3 | **Experiment board**: randomised alternating-night A/B tests (curve A vs B, door ajar vs closed) shown as a forest plot. Each estimate has an interval, and nights are counted towards the ~35 needed per arm. | Joined | P2 |
| 5.4 | **Correlation matrix** across about 20 nightly features (room, behaviour tags, body). Exploratory only, with a warning about chance correlations. | Joined | P2 |
| 5.5 | **Lagged effects**: does a hot or high-CO₂ night show up in the *next* day's resting HR, steps or mood? | Joined + iOS | P2 / iOS |

## 6. Couple view

| # | Visual | Data | Phase |
|---|---|---|---|
| 6.1 | **Mirrored hypnograms**: both partners' stages above and below one shared room axis. | `sleep` ×2 | P2 |
| 6.2 | **Synchrony**: overlapping wake bouts. Who woke whom, and was it the room? | `sleep` ×2 | P2 |
| 6.3 | **Thermal preference compromise**: each partner's best-night temperature, and where tonight's curve sits between them. | Model | P2 |

## 7. Camera and sound (later)

| # | Visual | Data | Phase |
|---|---|---|---|
| 7.1 | **Video movement track**: motion per minute from IR video, as a restlessness strip under the hypnogram. | RTSP + frame diff | P3 |
| 7.2 | **Sleep-position timeline**: back, side or front, and covers on or off, from Claude vision on snapshots. | Snapshots | P3 |
| 7.3 | **Snore and sound timeline**: Frigate `snoring` / `speech` / `crying` events, with clips you can play. | RTSP audio | P3 |
| 7.4 | **Light-leak map**: a nightly IR-off frame. Bright spots get circled ("new light at the wardrobe"). | Snapshot | P3 |
| 7.5 | **Room brightness proxy**: camera exposure / gain over the night. No lux sensor needed. | RTSP metadata | P3 |
| 7.6 | **Babycam (future)**: cry and motion events, soothing actions taken, and a "grandparents live" indicator. | Frigate + go2rtc | P3 |

## 8. Lifestyle tags and iPhone data

| # | Visual | Data | Phase |
|---|---|---|---|
| 8.1 | **One-tap evening tags**: alcohol, caffeine after 14:00, late meal, late exercise, bedding weight, cycle phase. These become colours and filters on every chart. | PWA input | P1 |
| 8.2 | **Daytime context**: steps, exercise end time, daylight minutes and audio exposure from the iPhone. | Health Auto Export | iOS |

## 9. System health (so we can trust the charts)

| # | Visual | Data | Phase |
|---|---|---|---|
| 9.1 | **Data freshness**: webhook vs poll lag, gaps, and SwitchBot quota left today (with the lockout risk). | Ingest log | P1 |
| 9.2 | **Calibration log**: outdoor checks, plus nights where indoor CO₂ fell below 420 ppm (impossible with two sleepers, so it means sensor drift). | CO₂ | P1 |
| 9.3 | **Device status**: Meter battery and power source, Fitbit last sync and battery (via `pairedDevices`). | APIs | P1 / P2 |
