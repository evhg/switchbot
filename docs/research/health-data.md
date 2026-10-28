# Health-data dimension: getting the rawest Fitbit Air / Google Health / Apple Health data into a cloud web app

*Research date 2026-10-28. Confidence (H/M/L) is in brackets after each claim. Inferences are marked **[inference]**.*

---

## 0. TL;DR (decisions)

1. **Use the Google Health API v4 (`https://health.googleapis.com/v4`) as the main pipe.** It is the official successor to the Fitbit Web API and it returns intraday data by default. Heart rate is stored at 1-second resolution, SpO2 and steps at 1-minute resolution, and sleep stages come as interval lists. [H] https://developers.google.com/health/data-types , https://developers.google.com/health/release-notes
2. **Do not build anything on the legacy Fitbit Web API.** Support ended 2026-09-30, and the endpoints shut down in a few days. Sources disagree on the exact date: Google's docs say **Nov 2, 2026 (HTTP 410 Gone)**, while banners still on dev.fitbit.com say **Oct 30, 2026**. [H that it is dead; the exact date conflicts] https://developers.google.com/health/about , https://dev.fitbit.com/build/reference/web-api/intraday/get-hrv-intraday-by-date/
3. **Truly raw sensor data (PPG waveform, raw accelerometer or gyroscope, the beat-to-beat RR series) is NOT available from any Google cloud API.** The closest thing to raw in the cloud is 1-second-resolution heart rate. The only path to beat-to-beat RR intervals is the Air's **Bluetooth "Share heart rate"** broadcast (standard BLE Heart Rate Profile, 0x180D, which includes RR intervals), and that needs a BLE receiver near the bed. [H for the API gap, M for the BLE path]
4. **Apple Health adds nothing for the Fitbit data.** Since Google Health v5.05 (Aug 2026), Fitbit data syncs to Apple Health: steps, distance, heart rate, sleep. **HRV does not transfer.** Use Apple Health only for iPhone-sourced or third-party data, via the "Health Auto Export" app posting to a REST endpoint. No native app is needed. [M] https://www.macrumors.com/2026/08/03/fitbit-apple-health-syncing/
5. **OAuth gotcha:** all `googlehealth.*` scopes are **Restricted**. In **Testing** mode, refresh tokens **expire after 7 days**. For a two-person personal app, set the OAuth app to **"In production" but unverified**. That allows up to 100 users, shows an "unverified app" warning you click through once, and gives long-lived refresh tokens. [H for the facts, M that this exact route works smoothly for restricted health scopes] https://developers.google.com/health/setup , https://developers.google.com/health/app-verification

---

## 1. What "Fitbit Air" is

| Item | Detail | Conf. | Source |
|---|---|---|---|
| Product | Google's screenless band. A pod ("pebble") sits in a band. Announced 2026-05-07, $99.99, in stores 2026-05-26. Stephen Curry edition $129.99. | H | https://9to5google.com/2026/05/07/fitbit-air-launch/ |
| Sensors | Optical heart rate monitor, 3-axis accelerometer + gyroscope, red and infrared sensors (SpO2), device temperature sensor (skin temperature *variation*). | H | same; https://www.stuff.tv/review/fitbit-air-review/ |
| Features | 24/7 heart rate with high/low alerts, AFib irregular rhythm notifications, HRV, sleep stages, silent vibration "Smart Wake" alarm, auto activity detection. | H | 9to5google |
| Hardware | Pod 5.2 g (12 g with band), Bluetooth 5.0, water resistant to 50 m, up to 7-day battery, 0-100% charge in about 90 min, pill-shaped magnetic USB-C charger. **Red status light and vibration for low battery.** | H | 9to5google |
| App | Google Health app (the renamed Fitbit app). iOS and Android. Comes with 3 months of Google Health Premium; Google Health Coach is a paid add-on. | H | 9to5google; https://us.smartprix.com/bytes/google-launches-fitbit-air-a-99-screenless-fitness-tracker/ |
| Temperature hardware | Google calls the Air a **single-sensor** temperature device. It only reports nightly derived temperature, not per-minute skin temperature. | H | https://developers.google.com/health/data-types/skin-temperature |

Bedroom note: the Air has no screen, but it has a red low-battery status light and it vibrates for Smart Wake and alerts. Charge it outside sleep hours. [H]

---

## 2. Google Health API v4: the main pipe

### 2.1 Status and timeline
- Launched **2026-03-24** as the successor to the Fitbit Web API. "The list endpoint returns granular intraday data by default." Under the legacy API you needed approval for intraday data; now you don't. [H] https://developers.google.com/health/release-notes ; https://tryterra.co/blog/everything-you-need-to-know-about-google-health-new-api
- 2026-04-14: webhooks for heart rate, steps, sleep and weight; `dataPoints.get`; OAuth Playground and API Explorer support. 2026-05-26: rate limits defined; `pairedDevices`, ECG and IRN scopes added; **scopes renamed** to explicit `.readonly` / `.writeonly`. 2026-10-01: `v4beta` channel added, with `skin-temperature-sensors`. 2026-10-14: `dataSourceFamily` filter on `list`. [H] release notes
- Q4 2026 roadmap: "granular skin temperature" and basal metabolic rate, plus more types matching Health Connect in Q4 2026 and Q1 2027. [M] https://developers.google.com/health/about
- The API is still changing (beta channel, renamed scopes). Pin the version (`v4`), and store the raw JSON exactly as returned. [H]

### 2.2 Auth and setup (per Google's setup page) [H] https://developers.google.com/health/setup
1. Create a Google Cloud project and enable the **Google Health API**.
2. Create an OAuth client of type **Web Server**. Use your own redirect URI (e.g. `https://<app>.vercel.app/api/oauth/callback`; Google's example uses `https://www.google.com`).
3. Audience: User type **External**, default status **Testing**. Add both partners' Google accounts as **Test users**.
4. Data Access: add only the read scopes you need (below).
5. Authorize with `access_type=offline` and `prompt=consent` to get a refresh token. Access tokens last about 3599 s.
6. **Testing mode: refresh tokens expire after 7 days. Production: they last until revoked or unused for about 6 months.** Google says to "publish the app" to avoid the 7-day expiry.
7. Before OAuth, each person must be signed into the **Google Health mobile app** with a Google Account (new profile, or a Fitbit account migrated to Google). Then call `GET /v4/users/me/identity`. If that returns `400 ACCOUNT_NOT_LINKED`, the account isn't migrated yet.
- Verification: all scopes are Restricted. Unverified apps are capped at **100 users**. Full verification needs a CASA security assessment ($500-4,500, yearly), which **you don't need for two users**. [H] https://developers.google.com/health/app-verification
- Google's general policy: apps that show the unverified-app screen are limited to "100 new users in total". There is no explicit "personal use" exemption on that page. [H] https://support.google.com/cloud/answer/7454865 . **[inference, M]** Setting the app to "In production" while unverified is the practical choice: you click "Advanced, go to app (unsafe)" once per person and get non-expiring refresh tokens. Fallback: stay in Testing and re-consent every 7 days. Verify this works in practice.
- Avoid adding legacy Google Fit scopes or `include_granted_scopes=true`. Terra's testing reports 403s on data reads when they are mixed in. [M] tryterra

### 2.3 Scopes (prefix `https://www.googleapis.com/auth/googlehealth.`) [H] https://developers.google.com/health/scopes
Request **read-only**:
- `health_metrics_and_measurements.readonly`: heart rate, HRV, SpO2, respiratory rate, temperature, resting HR, weight
- `sleep.readonly`
- `activity_and_fitness.readonly`: steps, activity level, sedentary periods, AZM, VO2 max, exercise
- `irn.readonly` (AFib notification beat data), `ecg.readonly`, `profile.readonly`, `settings.readonly` as wanted

### 2.4 Endpoints [H] https://developers.google.com/health/endpoints
| Purpose | Call |
|---|---|
| Identity | `GET /v4/users/me/identity` → `{name, legacyUserId, healthUserId}` |
| Raw points with per-point provenance | `GET /v4/users/me/dataTypes/{kebab-type}/dataPoints?filter=...&page_size=...&pageToken=...` |
| Merged single stream (deduplicated across devices) | `GET .../dataPoints:reconcile` (returns `dataPointName`, no `dataSource`) |
| Aggregates | `POST .../dataPoints:rollUp` (`range.startTime/endTime`, `windowSize:"60s"`), `POST .../dataPoints:dailyRollUp` |
| Single point | `dataPoints.get` |
| Devices | `GET /v4/users/me/pairedDevices` → `deviceType, batteryLevel, lastSyncTime, deviceVersion, features` (use for "battery low / not synced" alerts) |
| Webhooks | `POST /v4/projects/{project-NUMBER}/subscribers?subscriberId=...` |

- Filters use snake_case field paths, e.g. `heart_rate.sample_time.physical_time >= "2026-10-27T12:00:00Z"`, `sleep.interval.civil_end_time >= "2026-10-27"`, `steps.interval.civil_start_time >= "..."`. [H]
- `page_size` is capped at **10,000** for most types and **25** for sleep and exercise. RollUp ranges are limited to **14 days** for heart-rate, active-minutes, calories-in-HR-zone and total-calories, and **90 days** for other types. [H]
- `dataSourceFamily`: `all-sources` (default), `google-wearables`, `google-sources`, `self-sources`. Use `google-wearables` so phone-sourced or Apple-Health-imported points don't mix in. [H] endpoints and release notes
- Quirks (Terra testing): floors, total-calories, active-minutes, calories-in-heart-rate-zone, time-in-heart-rate-zone and daily-heart-rate-zones **reject `:list` (400)**, so use rollUp for those. There is no endpoint that lists which data types a user has; you have to probe. Field paths share nothing with the old Fitbit JSON, so old parsers won't work. [M] tryterra
- **Rate limits:** 300 requests/min per user. Unverified apps get 2.5 QPS per user (250 QPS total). Each project gets 86.4M requests/day. Over-limit calls return 429. A nightly pull for two people is far below this. [H] https://developers.google.com/health/rate-limits

### 2.5 Data types available for Fitbit Air, ranked from closest-to-raw to most derived

| Rank | dataType (path) | Record / resolution | Shape (key fields) | Raw or derived | Air? |
|---|---|---|---|---|---|
| 1 | `heart-rate` | Sample, **1 s storage**; Terra measured a **~5 s median interval** over one day (8,728 samples) | `heartRate:{sampleTime:{physicalTime, utcOffset, civilTime}, beatsPerMinute (int64 string), metadata:{motionContext: ACTIVE/SEDENTARY, sensorLocation: WRIST}}` | **Closest to raw available in the cloud** (on-device PPG to BPM) | Yes [H] |
| 2 | `steps` | Interval, 1 min | `steps:{interval, count}` | Near-raw (on-device step detection) | Yes [H] |
| 3 | `oxygen-saturation` | Sample, 1 min | `oxygenSaturation:{sampleTime, percentage}` | Derived and **heavily filtered**: arm movement, loose fit, confidence <50%, ±3 min around invalid readings, and runs <4 consecutive minutes are all dropped. Expect gaps. | Yes [H] https://developers.google.com/health/migration/api-specifications |
| 4 | `heart-rate-variability` | Sample (window length **not documented**) | `heartRateVariability:{sampleTime, rootMeanSquareOfSuccessiveDifferencesMilliseconds, standardDeviationMilliseconds, metadata:{highFrequencyPower, lowFrequencyPower}}` | Computed from beat intervals per window. Legacy API used **5-min windows during main sleep** (rmssd, coverage, hf, lf), so v4 is probably the same **[inference, M]** | Yes [H] |
| 5 | `respiratory-rate-sleep-summary` | Sample (per sleep session) | per-stage stats (deep/light/REM/full): `breathsPerMinute`, `standardDeviation`, `signalToNoise` | Derived. **No intraday breathing rate type exists.** | Yes [H] |
| 6 | `sleep` | Session | `sleep:{interval, type: STAGES/CLASSIC, stages:[{startTime, endTime, type: AWAKE/LIGHT/DEEP/REM}], shortAwakenings[], outOfBedSegments[], metadata:{stagesStatus, processed, nap, mainSleep, manuallyEdited}, summary:{stagesSummary[], minutesAsleep, minutesAwake, minutesToFallAsleep(0 if auto), minutesAfterWakeUp, minutesInSleepPeriod}, createTime, updateTime}` | **Fully algorithmic** (staging model). Edits trigger recalculation. | Yes [H] |
| 7 | `daily-sleep-temperature-derivations` | Daily | `{date, nightlyTemperatureCelsius, baselineTemperatureCelsius (30-day median), relativeNightlyStddev30dCelsius}` | Derived ("specialized thermal algorithms"). Deviation = nightly minus baseline. | Yes [H] |
| 8 | `daily-heart-rate-variability` | Daily | `{date, averageHeartRateVariabilityMilliseconds, nonRemHeartRateBeatsPerMinute, entropy, deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds}` | Derived | Yes [H] |
| 9 | `daily-resting-heart-rate` | Daily | `{date, beatsPerMinute, dailyRestingHeartRateMetadata:{calculationMethod: WITH_SLEEP / ONLY_WITH_AWAKE_DATA}}` | Derived (algorithm can change) | Yes [H] |
| 10 | `daily-oxygen-saturation`, `daily-respiratory-rate`, `daily-heart-rate-zones`, `activity-level`, `sedentary-period`, `active-zone-minutes`, `daily-vo2-max` | Daily / interval | — | Derived | mostly yes [M] |
| — | `irregular-rhythm-notification` | Session | contains `HeartBeat.beatsPerMinute` computed as 60000/rr (IBI) | The **only cloud place with beat-level data**, and only around AFib alert events | [H] for field |
| ✗ | `skin-temperature-sensors` (v4beta, per-minute skin and internal/ambient sensor) | — | — | **Not supported on Fitbit Air** (only Pixel Watch 4/5) | [H] |
| ✗ | Raw PPG, raw accelerometer/gyro, continuous RR/IBI series | — | — | **Not in any data type list** | [H] (absent from the data-type list and the v4beta reference) |

Every `list` point has a `dataSource` with `recordingMethod` (manual / passive or active measurement / **derived by backend algorithm** / unknown), `device` (form factor, manufacturer, display name), `application`, and `platform` (Fitbit / Health Connect / HealthKit). Store it; it tells you which values the backend algorithm produced. [H] https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints

Not in the API: Fitbit/Google "Sleep Score", Readiness/Cardio-load-style Premium scores, 30-day stage averages, `efficiency`, `isMainSleep` (replaced by `metadata.mainSleep`), `logId`. [M] tryterra. You would compute your own scores anyway.

### 2.6 Handling algorithm changes (the user's main concern)
- Sleep sessions carry `createTime`/`updateTime`, and webhooks send `operation: UPSERT/DELETE`. So you can **detect when Google reprocesses a night**. [H for the fields; that reprocessing shows up this way is **inference, M**]
- Strategy **[inference]**:
  - Keep an append-only `raw_datapoints` table (jsonb payload, fetch timestamp, `updateTime`, `dataSource`) and never overwrite it.
  - Compute **your own** metrics from the rawest series: sleeping HR curve, HR nadir and nadir timing, own resting HR, minute HR during each stage, own sleep/wake estimate from HR plus steps, ODI-like SpO2 dip counts from the 1-min SpO2.
  - Use Google's stages and derived dailies only as a labelled, versioned layer.

### 2.7 Webhooks (for "data is ready" nightly triggers) [H] https://developers.google.com/health/webhooks
- Subscriber body: `endpointUri` (public HTTPS, TLS 1.2+), `subscriberConfigs` (data types plus `subscriptionCreatePolicy: AUTOMATIC | MANUAL`), `endpointAuthorization.secret` (echoed in the `Authorization` header). Use the project **number**, not the project ID.
- Verification: two POSTs with body `{"type":"verification"}`. Return 200/201 when the auth header is present and 401/403 when it isn't.
- Payload: batches of up to 99 notifications. Each has `data:{healthUserId, dataType, operation, clientProvidedSubscriptionName, intervals[{physicalTimeInterval?, civilDateTimeInterval, civilIso8601TimeInterval}], recordId?}`. Signed in the `GOOGLE-HEALTH-API-SIGNATURE` header (ECDSA P-256, keys rotate every 30 days). **Reply 204 immediately**, then call `reconcile`/`list` for each interval. Retries continue for up to 7 days.
- Supported types include heart rate, HRV, sleep, steps, respiratory-rate-sleep-summary and the daily HRV/RHR/SpO2/RR/sleep-temperature types.
- Data reaches Google only after the Air syncs to the phone app. Expect some delay after waking; Google gives no latency figure. The legacy HRV docs said "up to 15 minutes to process after sync". [M]

### 2.8 Tooling
- **ghealth** (Google Health CLI): Go binary, Apache-2.0, in the `Google-Health-API` GitHub org. JSON/CSV output, ships agent SKILL.md files. Useful for testing scopes and schemas. Sources conflict on whether it is "official". [M] https://9to5google.com/2026/07/01/google-health-cli/
- Community: `AyushSagar16/fitbit-air` (Google Health API for history plus BLE live heart rate), `davidmosiah/google-health-mcp` (MCP server). [M] https://github.com/AyushSagar16/fitbit-air

---

## 3. Beat-to-beat data: the BLE "Share heart rate" path (the only true RR source)
- Fitbit Air can broadcast heart rate over the **standard Bluetooth Heart Rate Profile (0x180D)**. Turn it on in Google Health app → Connections → Fitbit Air → **"Share heart rate"**. It is meant for Peloton, Zwift, Strava, Wahoo and similar. [M] https://androidcentral.com/wearables/fitbit/first-things-you-should-do-with-google-fitbit-air ; support.google.com/fitbit/answer/14236705 (seen only through a proxy)
- The community repo shows the readings include **`rrIntervals`** (e.g. 833 and 812 ms) as well as bpm and contact. It notes battery drain and that the Air won't advertise 0x180D continuously. [M] https://github.com/AyushSagar16/fitbit-air
- Constraints:
  - iOS Safari has **no Web Bluetooth**, so a PWA can't do this. [H, general knowledge]
  - The Hub Mini can't relay generic BLE HR data. [M]
  - You would need a small always-on BLE-to-Wi-Fi bridge by the bed (e.g. an ESP32, USB-powered from a bedside outlet) posting RR intervals to Supabase, or a native iOS app. **[inference]**
  - Unknown: whether the broadcast keeps running all night, how much battery it costs (the 7-day battery would fall a lot), and whether it changes on-device tracking. Treat it as a **phase-2 experiment**, not the baseline. **[not found]**

---

## 4. Google Takeout / in-app export (one-time historical backfill)
- Takeout still labels it "Fitbit". The archive unpacks to `Takeout/Fitbit/Global Export Data/...`, mostly JSON. Guides describe per-day heart rate files (`heart_rate-YYYY-MM-DD.json`; older archives `heartrate-...`) with readings about every 5 s during activity and less often overnight. Also per-night sleep files with `levels.data` (stages), plus folders for HRV (nightly rmssd/low/high, device dependent), SpO2, activity, weight and profile. File names and granularity vary by archive age. **No official 2026 file list was found.** [M/L] https://takeoutday.org/guides/fitbit-data-export (verified 2026-09-28); https://medium.com/@abhik.ch6/parsing-fitbit-hr-from-google-takeout-9d9e98ce6aee
- The Google Health app also has an in-app CSV/JSON export for recent date ranges. [L] https://dev.to/antivex/how-to-keep-your-fitbit-data-after-the-google-health-switch-2803
- Use: a one-off backfill since each person started wearing the Air. It is not a nightly pipe (manual, slow). [inference]

## 5. Health Connect
- Android-only on-device store. Not relevant for iPhones. [H] https://en.wikipedia.org/wiki/Health_Connect

## 6. Apple Health (HealthKit)
- **There is no Apple Health web API.** Data leaves only through an on-device app. [H, general knowledge]
- **Google Health → Apple Health:** two-way since Google Health **v5.05 (Aug 3, 2026)**. Writes "exercise records, sleep, vitals, steps, and more", explicitly including steps, distance, heart rate and sleep. **HRV does not transfer.** Granularity is not documented. Set up via Google Health → Profile → Partner apps/Connections → Apple Health. [M] https://www.macrumors.com/2026/08/03/fitbit-apple-health-syncing/ ; https://512pixels.net/2026/08/google-health-now-syncs-with-apple-health/
- So Apple Health carries a *subset* of the Fitbit data already in the Google Health API, possibly resampled. **Don't use it as the Fitbit source.** [inference, H]
- What Apple Health *is* useful for: iPhone-sourced data (steps, walking metrics, headphone audio exposure, Screen Time is not in HealthKit), plus third-party apps you might add later (smart scale, BP cuff, CGM, nutrition apps, mic-based snoring apps), and State of Mind logs.
- **Health Auto Export – JSON+CSV** (App Store id1115567069): automations to a **REST API (POST, custom headers such as Authorization, JSON)**, Home Assistant, MQTT, iCloud/Dropbox/Google Drive. Aggregation from seconds to yearly and detailed per-metric export (sleep phases, ECG) need the paid tier. **Automations only run while the iPhone is unlocked.** The sync cadence is a minimum, not a schedule, and a Home Screen widget improves reliability. [M] https://apps.apple.com/app/id1115567069 ; https://tzovar.as/exporting-data-apple-health/
- iOS Shortcuts personal automations ("Find Health Samples" → "Get contents of URL" POST) are a free alternative, but they are clunkier and also run on the device. [M, general knowledge]
- A native HealthKit app (TestFlight or a personal dev build) would only be worth it for background delivery or BLE RR logging. **Not needed for the baseline.** [inference]

---

## 7. Recommended pipeline (two people, nightly, cloud-only) [inference built on the facts above]

1. **Google Cloud project** with the Google Health API enabled. Web OAuth client, redirect to a Vercel route. Both accounts added. Read-only scopes from §2.3. Set the app to **In production (unverified)** to avoid 7-day token expiry. Fallback: Testing mode plus weekly re-consent.
2. **Supabase:**
   - `oauth_tokens` (encrypted refresh token per person)
   - `raw_datapoints` (person, dataType, point_key, sample/interval times, `dataSource`, `updateTime`, payload jsonb, fetched_at; append-only, with a version column)
   - derived tables (`hr_minute`, `sleep_stage`, `nightly_summary`)
3. **Triggers:**
   - Webhook subscriber (Vercel or Supabase Edge Function) for `sleep`, `heart-rate`, `heart-rate-variability`, `oxygen-saturation`, `respiratory-rate-sleep-summary`, `daily-*`. Reply 204, then queue.
   - A **fallback cron** (pg_cron or Vercel Cron) around 10:00 and 14:00 local time: `list` with `dataSourceFamily=google-wearables` over the last 36 h, re-fetch the last 7 days of `sleep` and the daily types to catch reprocessing, and check `pairedDevices.lastSyncTime`.
4. **Volume check:** heart rate at ~5 s median is about 17k points/day per person, i.e. 2 pages at page_size 10,000. That is trivial. [inference from Terra's number]
5. **Join with SwitchBot room data** (CO2, temperature, humidity from the Meter Pro CO2) at 1-min resolution in Postgres. Then run a nightly Claude API job that writes an Oura/Whoop-style report from the computed metrics.
6. **Optional:** a one-time Takeout backfill; Health Auto Export → REST for iPhone-only metrics; a phase-2 ESP32 BLE RR logger.

## 8. Useful combinations to chart (room + body) [inference / ideas]
- Hypnogram (stages) overlaid on bedroom temperature, humidity and CO2. Look at how much deep sleep falls in the first ~3 h at different setpoints, and at awakenings vs temperature changes or aircon cycling.
- Sleeping-HR curve (1 s/5 s heart rate, minute medians): nadir value and **nadir time** (a late nadir suggests a late meal, alcohol or a warm room) vs room temperature and evening activity.
- HRV RMSSD per window plus nightly deep-sleep RMSSD and HRV entropy, against CO2 ppm buckets (<800, 800-1200, >1200) and room temperature.
- SpO2 1-min dips and respiratory rate by stage vs CO2. **Each person is a natural control the other can't be:** both breathe the same air.
- Nightly temperature deviation (`nightly - baseline`) vs aircon setpoint and humidity. Illness or cycle tracking.
- Couple synchrony: overlap of wake bouts and movement between the two partners.
- Steps/activity and late exercise time vs sleep latency and HR nadir.
- Battery and sync health from `pairedDevices`.

---

## 9. Conflicts and unknowns
- **Fitbit Web API shutdown date:** Nov 2, 2026 (developers.google.com/health about, setup, release notes) vs Oct 30, 2026 (dev.fitbit.com banner). An earlier newsletter summary said support ended Sep 30 and gave a turn-down date. Either way it is days away.
- **HRV sample window length** in v4 is not documented (5 min under the legacy API).
- **Actual heart rate sampling on the Air** overnight vs active: storage is 1 s; one test measured a ~5 s median (device not stated).
- **Whether unverified production apps** with restricted `googlehealth` scopes get long-lived refresh tokens without friction: Google's docs imply yes, but this isn't tested here.
- **Granularity of Fitbit→Apple Health data**, and whether SpO2 or respiratory rate transfer: not documented.
- **Official Takeout file list for 2026:** not found.


---

# Adversarial verification (independent fact-check)

# VERDICTS
- [partially-true] Google Health API v4 (https://health.googleapis.com/v4) returns intraday data by default without special approval; heart-rate is stored at 1 s, oxygen-saturation and steps at 1 min.
  -> Correct: the base URL is https://health.googleapis.com/v4/{users/*/dataTypes/*}/dataPoints, heart-rate storage resolution is 1 second, and SpO2 and steps are 1 minute. Overstated: 'without special approval'. There is no separate intraday permit like the legacy API had, but the app-verification page says most Google Health scopes are Restricted, and unverified apps are capped at 100 users. That cap is fine for 2 users. Storage resolution is not the same as how often the device actually samples. Per-minute SpO2 is recorded only during sleep. (https://developers.google.com/health/data-types)
- [partially-true] Testing-mode refresh tokens expire after 7 days; unverified apps are capped at 100 users; all googlehealth scopes are Restricted; full verification needs CASA ($500-4,500/yr).
  -> The 7-day expiry in Testing mode and the 100-user cap (for both testing and production) are confirmed on the setup page. The setup page also says that 'In Production' refresh tokens 'generally don't expire unless revoked or unused for a prolonged period'. The app-verification page says 'Most scopes' are restricted, not all, and gives assessor fees of $500 to $4,500 for an annual CASA review. The 'all' wording comes from the /about page. For two users, the practical answer is to publish to production as an unverified app. Verification is not needed. (https://developers.google.com/health/app-verification)
- [partially-true] Fitbit Air is compatible with heart-rate, heart-rate-variability (RMSSD, SDNN, LF/HF power), oxygen-saturation, respiratory-rate-sleep-summary, sleep stages, and the daily HRV/SpO2/RR/temperature types.
  -> Device compatibility is confirmed for all of those types, plus vo2-max, run-vo2-max, daily-resting-heart-rate, sedentary-period and active-zone-minutes. The field list is wrong: the v4 HeartRateVariability sample has only rootMeanSquareOfSuccessiveDifferencesMilliseconds (1 to 200) and standardDeviationMilliseconds. It has no LF or HF power. DailyHeartRateVariability has averageHeartRateVariabilityMilliseconds, deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds, entropy and nonRemHeartRateBeatsPerMinute. Sleep stages are LIGHT/DEEP/REM/AWAKE, and short awakenings are listed separately and can overlap the stages. (https://googleapis.dev/dotnet/Google.Apis.GoogleHealthAPI.v4/latest/api/Google.Apis.GoogleHealthAPI.v4.Data.HeartRateVariability.html)
- [partially-true] Since Google Health v5.05 (Aug 2026), Fitbit data syncs to Apple Health (steps, distance, HR, sleep) but HRV does not transfer.
  -> Google Health 5.05 does sync to Apple Health. It is off by default, needs iOS 16.4 or later, and is set up under Profile > Partner apps. Coverage also includes exercise and vitals. The 'HRV doesn't transfer' point rests only on a Reddit post cited by MacRumors, not an official source, so it is anecdotal. (https://macrumors.com/2026/08/03/fitbit-apple-health-syncing)
- [partially-true] Webhooks exist for sleep, HR, HRV, SpO2 dailies etc.; signed (ECDSA P-256), expect 204, retry up to 7 days, batches up to 99.
  -> Confirmed: webhooks cover 28 types, signatures are ECDSA P-256 with SHA-256 via Tink in the GOOGLE-HEALTH-API-SIGNATURE header, keys rotate every 30 days, the reply must be 204, retries continue for up to 7 days, and batches hold at most 99 messages. Endpoint verification expects 200/201 on the authorized request and 401/403 on the unauthorized challenge. Correction: per-minute oxygen-saturation is NOT in the webhook table, and daily-respiratory-rate may be missing too. daily-oxygen-saturation, heart-rate, heart-rate-variability, sleep and respiratory-rate-sleep-summary are supported. A webhook only notifies, so the app still has to pull the data. (https://developers.google.com/health/webhooks)
# ANSWERED
- Q: Which shutdown date applies: Oct 30 (dev.fitbit.com) or Nov 2, 2026 (developers.google.com)?
  A: The two official pages disagree. dev.fitbit.com says Oct 30 and developers.google.com/health/about says Nov 2. Assume Oct 30. It doesn't matter if the build uses only Google Health v4. Old tokens don't migrate, and users must consent again.
- Q: What window does the v4 HRV Sample use, and is it sleep-only?
  A: The docs don't state a window length. The sample fields are RMSSD and SD only. The sleep guide says HRV is 'recorded specifically during sleep'. Whether the legacy 5-minute window carries over is not documented and should be checked empirically from the sample timestamps.
- Q: Does an unverified app set 'In production' with restricted scopes get non-expiring refresh tokens?
  A: The setup page says that in production, refresh tokens 'generally don't expire unless revoked or unused for a prolonged period'. It also says the 100-user cap applies to unverified apps for both testing and production, so an unverified production app is officially supported for 2 users. Users will still see the unverified-app warning screen.
- Q: Have both accounts been linked to Google accounts (otherwise errors)?
  A: The API requires the user to sign in to the Google Health mobile app with a Google Account and set up a profile. Without that, the API returns 412 Precondition Failed. The exact string ACCOUNT_NOT_LINKED was not found in the docs. users.getIdentity returns healthUserId and legacyUserId. Fitbit Air is a 2026 device set up through the Google Health app, so it is very likely already on a Google account.
- Q: Can BLE Share heart rate run all night, and what does it cost in battery?
  A: No official source answers this. The community repo says the Air doesn't advertise 0x180D all the time because it drains the battery, and it mentions a bonding caveat. Overnight use needs a hands-on test.
- Q: Which Fitbit types reach Apple Health?
  A: Officially: exercise, sleep, steps, distance, heart rate and 'vitals'. The exact HealthKit types and sample granularity are not published. HRV reportedly does not transfer (Reddit, via MacRumors).
# MISSED
- Per-minute SpO2 is recorded only during sleep, and the per-minute oxygen-saturation type has NO webhook support. Only daily-oxygen-saturation does, so the app must poll for the minute-level SpO2 series after the sleep webhook arrives.
- The v4 HRV sample has no LF/HF fields. The daily HRV type adds deep-sleep RMSSD, Shannon entropy of IBIs, and non-REM heart rate, which are useful nightly metrics for charts.
- A user who has authorized OAuth but has no Google Health profile gets a 412 Precondition Failed error.
- List results come back newest-first with a default of 1440 points, and sleep and exercise are capped at 25 per page.
- Signing keys rotate every 30 days, so cache the public keys with refresh rather than pinning them.
- Health Auto Export needs Premium for REST automations. The vendor suggests adding the Automations Home Screen widget to improve how often background runs happen.
- Read-only vitals: vitals data cannot be written through the API.
- The /about page warns the API is 'actively evolving' and may change, so pin to v4 and watch the changelog. v4beta holds extra types such as skin-temperature-sensors.