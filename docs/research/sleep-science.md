# Sleep science: targets and a dynamic temperature curve for a Phuket bedroom

**Scope.** This covers the evidence on how the bedroom environment affects sleep. It sets targets for a sealed ~110–135 m³ bedroom-plus-bathroom in Phuket, cooled by a ducted air conditioner (air temperature control only), with two adults sleeping. It also proposes an Eight-Sleep-style dynamic air-temperature curve and lists which wearable signals respond to the environment, for correlation dashboards.

**How to read it.** Every claim has a source and a confidence (H/M/L). Lines marked **[Inference]** are my own reasoning or calculation, not a published result. Several citations in the brief needed correcting; the fixes are noted where they apply.

---

## 1. Bedroom air temperature

### 1.1 Mechanism: why cooler helps you fall asleep

- **Core temperature has to fall at sleep onset.** Body heat leaves through vasodilation in the hands and feet ("distal"). In Kräuchi et al. 1999 (*Nature* 401:36, "Warm feet promote the rapid onset of sleep"), the degree of distal vasodilation was the best physiological predictor of how fast people fell asleep. The distal–proximal skin temperature gradient (DPG) later predicted sleep latency better than core temperature, melatonin or sleepiness. https://ui.adsabs.harvard.edu/abs/1999Natur.401...36K/abstract ; https://pubmed.ncbi.nlm.nih.gov/11682282/ (H)
  - **[Inference]** Cool room air helps only if hands and feet stay warm enough to vasodilate. Air that is too cold, or a bare arm or foot outside the duvet, can cause vasoconstriction and work against sleep onset. This is why bedding matters (see 1.2).
- **Heat and cold both push sleep toward wakefulness**, at the expense of REM and slow-wave sleep. With normal bedding and nightwear, heat is the bigger disruptor. Semi-nude subjects are more disturbed by cold. Humidity adds to the heat load. Source: Okamoto-Mizuno & Mizuno 2012 review, *J Physiol Anthropol* 31:14. https://pmc.ncbi.nlm.nih.gov/articles/PMC3427038/ (H)
- **Thermoregulation is weakened in NREM sleep and nearly absent in REM** (REM is close to "poikilothermic", meaning body temperature drifts with the surroundings). The brain cools on entering NREM and rewarms at transitions into REM or waking. https://www.frontiersin.org/journals/neuroscience/articles/10.3389/fnins.2019.00336/pdf (M)
  - **[Inference]** Late-night REM-heavy sleep is the period most exposed to room temperature that is too cold or too hot. This is the physiological reason to raise the setpoint slightly in the second half of the night.

### 1.2 Reported optimal temperatures conflict, and bedding explains it

| Source | Conditions | Result | Conf. |
|---|---|---|---|
| Haskell et al. 1981, *EEG Clin Neurophysiol* 51:494 | 6 men, semi-nude, no bedding; 21/24/29/34/37 °C | 29 °C thermoneutral; 21 °C most disruptive; large individual differences in cold sensitivity. https://pubmed.ncbi.nlm.nih.gov/6165549/ | H |
| Sleep Foundation guidance | With bedding | 60–68 °F (15.6–20 °C). Heavier duvets tolerate a wide range. https://www.sleepfoundation.org/bedroom-environment/bedroom-temperature | M (guidance, not an RCT) |
| CIBSE (cited in an AIVC paper) | Winter, 2.5 clo bedding | 17–19 °C. https://www.aivc.org/sites/default/files/D2_S8C-08.pdf | M |
| Cao, Lian et al. 2021 (chamber) | 17/20/23 °C × 40/55/70 % RH | Temperature dominates and RH matters little; best combination 20 °C / 55 % RH (winter bedding). Summarised via search; full text not read. https://link.springer.com/content/pdf/10.1007/s12273-021-0840-5.pdf | M |
| Cao et al. 2022 (summer chamber) | 23/26/29 °C × 40/60/80 % RH, n=18 | Summer optimum ≈ 26.1 °C / 52 % RH with summer (light) bedding. Summarised via search; full text not read. | M |
| Lan, Lian & Lin 2016, *Build Environ* 103:36 | n=18, summer bedding | Holding a "comfortably cool" 25 °C early in the night kept extremities cold for about 90 min, lengthened sleep onset and worsened subjective sleep compared with 26 °C. A 28→26 °C drift profile did not change sleep quality. https://faculty.sjtu.edu.cn/lanli/en/lwcg/191366/content/123500.htm (DOI 10.1016/j.buildenv.2016.03.030) | M (abstract via aggregator) |
| Baniassadi et al. 2023, *Sci Total Environ* 899:165623 | 50 older adults, about 11,000 nights at home | Sleep was most efficient and restful at 20–25 °C. Sleep efficiency fell 5–10 % from 25 to 30 °C. The relationship was nonlinear with large between-person differences. https://www.sleepfoundation.org/bedroom-environment/bedroom-temperature ; https://www.theweek.in/news/health/2023/08/29/room-temp-of-20-25-degrees-celsius-linked-to-better-sleep-in-the.html | H (abstract-level) |
| BMC Medicine 2025 (Griffith Univ.) | 47 adults ≥65, Fitbit Inspire 3 + SHT45 sensors, 14,179 night-hours | Compared with <24 °C, odds of a clinically relevant drop in lnRMSSD were 1.4× at 24–26, 2.0× at 26–28 and 2.9× at 28–32 °C. Odds of heart rate ≥5 bpm higher were 1.2× / 1.9× / 3.9×. The authors recommend ≤24 °C. https://pmc.ncbi.nlm.nih.gov/articles/PMC12751657/ | H (observational) |

**What this means for the couple.**
- Their preferred 18–20 °C air temperature fits Western guidance **when used with a real duvet**. Asian summer-bedding studies place the neutral point at 24.8–26 °C because the bedding is thin.
- With a duvet, 18–20 °C air keeps the microclimate under the covers comfortable while the face breathes cool air. **[Inference]** The bedding level is therefore the main variable to log alongside room temperature.
- The two strongest home studies with wearables (Baniassadi 2023, BMC Med 2025) both show measurable autonomic harm above ~24–25 °C. **Hard ceiling: never let the room exceed 24 °C during sleep.** (H)

### 1.3 How Eight Sleep varies temperature during the night (published material)

- **Pod phases (Moyen et al. 2024, *Bioengineering* 11:352, written and funded by Eight Sleep)** https://pmc.ncbi.nlm.nih.gov/articles/PMC11048088/ (H for what the paper says; the effects are company-funded)
  - Three phases:
    - **Bedtime:** from getting into bed until 15 min after persistent sleep is detected.
    - **Early:** the next 4 h.
    - **Late:** from the end of Early until waking.
  - The Pod's water-bed surface range is about 13–43 °C, shown in the app as −10 to +10.
  - Suggested defaults: women −1/0/+1 (≈26/27/29 °C); men −2/−1/0 (≈25/26/27 °C).
  - Observed medians with the Pod on: women 25.8 / 26.0 / 28.6 °C; men 23.4 / 25.4 / 26.8 °C. **These are bed-surface temperatures, not air temperatures.**
  - Sample: 54 analysed participants; Zmachine single-channel EEG plus Fitbit Versa 2.
  - Effects of a cool Early phase: men gained 14.3 min of deep sleep (p=0.003); women gained 9.2 min of REM (p=0.033).
  - Cool Bedtime phase (men): deep sleep started 6.7 min sooner.
  - Cardiovascular effects: minimum HR −1.2 bpm (about −2 %); HRV +2.0 ms (about +7 %).
  - No change in total sleep time, sleep efficiency or sleep latency.
  - **A warmer Late phase had downsides:** men had +23 min of light sleep and about 3 more awakenings; women had +8 min of wake.
  - Ambient room temperature was not measured.
  - The paper says it was both Eight Sleep-funded and "no external funding". Many subgroup tests with p≈0.03–0.05 increase the risk of false positives.
- **Autopilot logic (Eight Sleep blog):** "cooler offsets promote deep sleep and warmer offsets promote REM". If the previous night had deep sleep under 15 % or REM under 20 %, the next night's offset is made larger. https://www.eightsleep.com/blog/research-finds-the-pod-can-boost-sleep-and-cardiovascular-metrics-with-real-time-temperature-adjustments-based-on-your-sleep-stages/ (H that this is what they claim; M on efficacy)
- **SLEEP 2025 abstract (company):** n=34, at least 7 nights off and at least 7 nights on Autopilot, measured with Oura. Sleeping HR −2.3 bpm, HRV +4.9 ms (+13 %), deep sleep +4.7 min. Same source as above. (M; not peer-reviewed)
- **Autopilot inputs** include sleep history, preferences, bedroom and local weather, feedback, deep and REM sleep, respiratory rate, RHR and HRV. Example: a room 3.4 °F colder than usual leads Autopilot to warm the bed. https://www.eightsleep.com/blog/smart-temp-autopilot/ (H)
- **Wake-up:** GentleRise / Thermo Alarm *cools* the bed "minutes before" the alarm and adds vibration. The exact lead time was not found. https://www.eightsleep.com/blog/gentle-rise-to-start-day/ (H). A Pod 5 product page instead describes a gentle alarm that "vibrates and warms". The two Eight Sleep sources disagree. (L)
- **Not found:** any published Eight Sleep temperature *values* for Autopilot offsets, or a peer-reviewed description of its stage-triggered real-time algorithm.

### 1.4 Proposed dynamic curve for a ducted air conditioner (air temperature only)

This is **[Inference]** built from the evidence above. Starting values for a couple using a medium-weight duvet:

| Phase | Timing | Room air target (bed-height sensor) | Rationale |
|---|---|---|---|
| Pre-cool | T−90 to T−0 min | Pull the room down to 20–21 °C. Run the bathroom shower before pre-cooling, or allow extra time after it. | Ducted units and room thermal mass lag. Hot-shower humidity spills into the open bathroom. |
| Bedtime / onset | Lights-off to +30–45 min | 20 °C (19 °C for the person who runs hot). Keep feet warm with socks or a heavier blanket at the feet. | Distal vasodilation needs warm extremities (Kräuchi). Lan 2016 suggests early cold with light bedding can *delay* onset, so do not go below the couple's comfort point. |
| Early night (N3-rich) | ~+0.5 h to +4 h | Hold the coolest point, 18.5–20 °C. | Moyen 2024: a cool Early phase gave more deep sleep. Matches the Eight Sleep "cool for deep sleep" logic. |
| Middle | +4 h to +6 h | Ramp +0.5 °C per hour to ~21 °C. | Core temperature reaches its minimum around 4–5 am, and REM share rises. |
| Late (REM-rich) | +6 h to wake −30 min | 21–22 °C. Keep the increase small: +1.5–2 °C, not +3–4 °C. | REM thermoregulation is weak, so avoid cold. Moyen 2024 found that warm Late phases increased awakenings and light sleep, so a gentle rise is safer. |
| Wake | Last 20–30 min | Optional: 23–24 °C plus light, or no change. Test it. | Eight Sleep uses cooling plus vibration; the evidence is unsettled. |

Implementation notes (**[Inference]**):
- **Close the loop on the SwitchBot sensor at bed height.** The ducted unit's return-air thermistor sits in the ceiling plenum and will read differently from the bed.
- **Setpoint steps:** IR remotes usually step in 1 °C (sometimes 0.5 °C) and the unit has its own deadband, so expect ±0.5–1 °C oscillation.
- **Avoid audible fan surges** (see Noise).
- **One room, two sleepers:** a single air temperature cannot suit two different preferences. Handle individual differences with bedding (duvet weight, socks). Possible menstrual-cycle effects are not covered by the sources here; worth logging.
- **Personalise like Autopilot, but slowly.** Change at most one parameter per 1–2 weeks and score it with N-of-1 comparisons (see §6).

---

## 2. Humidity

- **Humid heat:** at 35 °C / 75 % RH there was more wake, less SWS and less REM than at 29 °C, and core temperature stayed higher. At 29 °C, the difference between 50 % and 75 % RH was not established. Okamoto-Mizuno et al. 1999, *Sleep* 22:767 (n=7 men, shorts only). https://pubmed.ncbi.nlm.nih.gov/10505822/ (H)
- **In mild conditions temperature matters far more than humidity.** The best-performing RH values were about 52–56 % (Cao 2021: 20 °C/55 %; Cao 2022: 26 °C/52 %). (M)
- **Dust mites:** populations are smallest below 50 % RH and largest around 80 %. Arlian's work found allergen falls in homes kept below 50 %. Mite-reduction trials using dehumidification have mixed results. Most fungi need over 60 % RH. https://pmc.ncbi.nlm.nih.gov/articles/PMC1474709/ (H for the thresholds; M for intervention benefit)
- **EPA guidance** (via secondary sources): 30–50 %, and keep below 60 %. https://standard.wellcertified.com/v4/node/12160 (M)
- **Dryness:** the secondary claim that below ~40 % RH mucosa dry out and ciliary clearance slows is low confidence (Wolkoff 2018 was not retrieved). Strøm-Tejsen found more ventilation raised reports of dry mouth and skin, though that was Danish winter air. (L–M)
- **Target band:**
  - 45–55 % RH (aim ~50 %)
  - Alert above 60 % sustained for more than 2 h (mould and mites)
  - Alert below 35 % (dryness)
  - **[Inference]** At a 19–20 °C room, 50 % RH means a dew point of about 8.5–9.3 °C. A running AC coil usually reaches this. A recently showered open bathroom and any fresh-air intake will push RH up.
- **AC dehumidification facts (Singapore retailer, M):** the coil removes moisture only while it runs long enough to condense water. Oversized or short-cycling units cool the room without drying it. https://megafurniture.sg/apps/aeo/ai/md/default/articles/743079968883.md
  - **[Inference]** Watch for "cold and clammy" (≤20 °C with >60 % RH). If it appears, use DRY mode before bed or add a dehumidifier.
- **Moisture from two sleepers:** not verified. BS 5250 tables exist but the per-hour sleeping value was not found. Commonly cited figures are around 30–50 g/h per person. (L)

---

## 3. CO₂: the evidence

CO₂ mainly stands in for human bioeffluents and stale air.
- Pure CO₂ added to 1000–3000 ppm did not affect perceived air quality, symptoms or cognition.
- **Bioeffluent** CO₂ at 3000 ppm reduced perceived air quality and cognitive performance.

Source: Zhang, Wargocki, Lian & Thyregod 2017, *Indoor Air* 27:47. https://orbit.dtu.dk/en/publications/effects-of-exposure-to-carbon-dioxide-and-bioeffluents-on-perceiv/ (H)

| Study | Design | CO₂ | Findings | Conf. |
|---|---|---|---|---|
| Strøm-Tejsen et al. 2016, *Indoor Air* 26:679 (DOI 10.1111/ina.12254) | Danish dormitories, 1-week conditions. Exp 2: n=16, inaudible intake fan off, or switched on above 900 ppm | 2395 vs 835 ppm (Exp 2); 2585 vs 660 ppm (Exp 1, window) | At lower CO₂: better actigraphy sleep quality, fresher-feeling air, less next-day sleepiness, better concentration and better logical-thinking test scores. More dry mouth and skin with higher ventilation. https://www.pubmed.gov/26452168/ ; https://backend.orbit.dtu.dk/ws/portalfiles/portal/101895512/Roomvent_2014_Paper_ID_148.pdf | H |
| Mishra et al. 2018, *Indoor Air* (10.1111/ina.12435) | n=17, window or door open vs closed | 717 vs 1150 ppm | Better sleep depth (questionnaire) and actigraphy measures when open. Confounded by noise and temperature. https://www.hu.nl/onderzoek/publicaties/windowdoor-openingmediated-bedroom-ventilation-and-its-impact-on-sleep-quality-of-healthy-young | M |
| Xu et al. 2021, *Indoor Air* 31:440 (Lian group) | Chamber, n=12, 54 days | 800 / 1900 / 3000 ppm | Subjective score at 3000 ppm was 80.8 % of the 800 ppm score. Sleep latency rose linearly with CO₂; SWS fell linearly. Unclear whether CO₂ was pure or included bioeffluents (not verified). https://www.aminer.org/pub/5f7064fe9fced0a24b64b05f | M |
| Xiong, Lan, Lian & de Dear 2020, *Sci Technol Built Environ* 26:1274 (field study, not dosing as the brief assumed) | Summer bedrooms, Southern Hemisphere | natural range | Less deep sleep when CO₂ was higher (lower ventilation). A "4.3 % decrement per +100 ppm" figure seen in a snippet could not be attributed to this paper. | M |
| Fan et al. 2023, *Sci Total Environ* (DTU, single-blind) | 29 bedrooms, 4 weeks; 23 with confirmed ventilation difference | — | Deep sleep significantly shorter at low ventilation; no difference in cognition. https://orbit.dtu.dk/en/publications/a-single-blind-field-intervention-study-of-whether-increased-bedr/ | H |
| Danish cross-section (Sekhar co-author) | 84 bedrooms, 2020 | median of nightly means 1,120 ppm (741–4,804) | Closed-room median ACH 0.40 h⁻¹. https://proceedings.open.tudelft.nl/clima2022/article/view/150 | H |
| **Akimoto, Fan, Lan, Sekhar, Tanabe, Wyon, Wargocki 2025**, *Sci Technol Built Environ* 31(8), ASHRAE RP-1837 (DOI 10.1080/23744731.2025.2531317) | Review: 17 studies, 22 datasets | — | Disturbed sleep starts around 1,000 ppm. **Keep below 1,000, preferably ≤800 ppm.** That needs about 8 L/s per person outdoor air, at least twice many residential standards. https://www.eurekalert.org/news-releases/1102252 ; https://orbit.dtu.dk/en/publications/new-research-on-bedroom-ventilation-and-sleep-quality-suggests-th/ | H |
| Akimoto, Sekhar et al. 2021, *ASHRAE J* 63(4):56 | Review | — | Below 800 ppm recommended; higher levels likely disturb sleep up to 2,600 ppm. https://nxtbook.com/nxtbooks/ashrae/ashraejournal_JPPKRR/index.php?startid=60 | M |

Citation corrections:
- "Sekhar, Lan 2021" is really Sekhar et al. 2020, *Build Environ* 184:107229 (review of standards), plus the 2021 ASHRAE Journal piece and the 2025 STBE paper above.
- "Lan et al." on CO₂ is mainly Fan et al. 2023 and the 2025 review.

**Dashboard thresholds (from Akimoto 2025, plus Strøm-Tejsen and Xu for higher levels):**
- **<800 ppm:** green (target)
- **800–1000 ppm:** amber
- **1000–1500 ppm:** orange (sleep disturbance likely)
- **>1500 ppm:** red
- **>2500 ppm:** clear evidence of next-day effects

Also show the **nightly mean CO₂** and **time above 1000 ppm** per night, since those are the exposure metrics the studies used.

---

## 4. CO₂ build-up in this room

**Assumptions:**
- **Room volume:** V = 110 / 120 / 135 m³.
- **Outdoor CO₂:** about 425 ppm.
- **CO₂ at bedtime:** C₀ = 500 ppm.
- **CO₂ generation rate (G).** The Persily & de Jonge method (*Indoor Air* 2017, 27:868) is VCO₂ (L/s) = BMR (MJ/day) × M (met) × 0.000484. Ages 30–60 BMR: male 0.048·m + 3.653; female 0.034·m + 3.538 (body mass m in kg). https://pmc.ncbi.nlm.nih.gov/articles/PMC5907511 (H for the formula)
  - Sleeping is taken as M ≈ 0.95 met (**[Assumption]**, M confidence).
  - Male 80 kg: ≈ 0.0034 L/s. Female 60 kg: ≈ 0.0026 L/s. **Total G ≈ 0.0062 L/s.**
  - The brief's 0.0035–0.0045 L/s per person gives about 0.008 L/s total, so both are modelled.

**Equations.**
- Q = ACH·V/3600 (m³/s)
- C_ss = C_out + G/Q (steady state)
- C(t) = C_ss − (C_ss − C₀)·e^(−ACH·t)

Results for **V = 120 m³** (computed):

| ACH (h⁻¹) | G (L/s) | Steady state | 1 h | 2 h | 4 h | **8 h** |
|---|---|---|---|---|---|---|
| 0.1 | 0.0062 | 2,285 | 670 | 824 | 1,088 | **1,483** |
| 0.1 | 0.0080 | 2,825 | 721 | 921 | 1,267 | **1,780** |
| 0.2 | 0.0062 | 1,355 | 655 | 782 | 971 | **1,182** |
| 0.2 | 0.0080 | 1,625 | 704 | 871 | 1,120 | **1,398** |
| 0.3 | 0.0062 | 1,045 | 641 | 746 | 881 | **996** |
| 0.5 | 0.0062 | 797 | 617 | 688 | 757 | **792** |
| 0.5 | 0.0080 | 905 | 659 | 756 | 850 | **898** |
| 1.0 | 0.0080 | 665 | 604 | 643 | 662 | **665** |

- **V = 110 m³:** at ACH 0.1, 8 h reaches 1,576–1,900 ppm.
- **V = 135 m³:** at ACH 0.1, 8 h reaches 1,369–1,633 ppm.
- **Interpretation:** a sealed room at 0.1–0.2 ACH should reach about 1,200–1,800 ppm by morning, and is still rising (far from steady state). This is above the 1,000 ppm level where sleep disturbance starts. A Danish-typical 0.4 ACH would end at about 900–1,000 ppm.

**Outdoor air needed for two sleepers** (computed):

| Target | G = 0.0062 L/s | G = 0.0080 L/s |
|---|---|---|
| ≤1000 ppm | 10.8 L/s ≈ 39 m³/h ≈ 0.32 ACH | 13.9 L/s ≈ 50 m³/h ≈ 0.42 ACH |
| ≤800 ppm | 16.5 L/s ≈ 60 m³/h ≈ 0.50 ACH | 21.3 L/s ≈ 77 m³/h ≈ 0.64 ACH |

This agrees with Akimoto 2025's ~8 L/s per person, which is 57.6 m³/h for two people. **Design target: 50–80 m³/h of continuous outdoor air.**

**Measure ACH from your own data — dashboard feature.** **[Inference]**, standard tracer-decay method:
- After both leave the closed room in the morning: ACH = ln[(C₁ − C_out)/(C₂ − C_out)] / Δt (hours).
- Alternatively, fit the overnight rise with the C(t) equation using a known G.
- Plot nightly ACH over time. It shows the effect of door-open versus door-closed nights and whether any ventilation added later is working.
- Note: if the ducted unit's return draws from a ceiling void that leaks to outside or to the house, real ACH may be higher than assumed.

---

## 5. Ventilation options for a sealed, hot-humid bedroom

**Fresh-air load at Phuket conditions** (**[Inference]**, psychrometric calculation):
- Outdoor 27 °C / 85 % RH (night) or 30 °C / 75 % RH has a humidity ratio of about 19–20 g/kg. Indoor air at 23 °C / 50 % is about 8.7 g/kg.
- 40 m³/h: about 0.5 kg of water per hour, 0.33–0.37 kW latent load, total about 0.4–0.46 kW.
- 60 m³/h: about 0.74–0.81 kg/h, total about 0.58–0.69 kW.
- 80 m³/h: about 1.0–1.1 kg/h, total about 0.77–0.92 kW.
- An enthalpy recovery core at about 60 % total effectiveness cuts this to about 0.15–0.37 kW.
- **Conclusion:** in Phuket, moisture is the main cost of fresh air, not heat. This is why an ERV (which also transfers moisture) is preferred over an HRV (heat only).

**Literature on ERVs in the tropics:**
- Hydrophilic-membrane ERVs tested under tropical air: latent effectiveness 42–74 %, sensible 45–78 % (Malaysia). Latent recovery can be about 6× sensible near tropical conditions (CFD, Singapore). https://khub.utp.edu.my/scholars/15963/ ; https://libmast.utm.my/Record/ntu-10356%2F68513/Details (M)
- ERV over HRV where humidity matters. https://ahrinet.org/scholarships-education/education/contractors-and-specifiers/hvacr-equipmentcomponents/air-air-energy-recovery-ventilators-ervs (H)

**Options, cheapest first** (**[Inference]** on suitability unless cited):

1. **Measure first.** One to two weeks of SwitchBot CO₂ data plus nightly ACH from the decay method. Compare door-open and door-closed nights. Cost: 0.
2. **Leave the bedroom door ajar or undercut it**, if the rest of the house has more volume or leaks. Free, but it conflicts with the couple's reason for closing the door (faster cooling) and may let in light or noise.
3. **Bathroom exhaust fan, if one exists or can be added**, run at low speed overnight. It pulls in make-up air through leaks and door gaps. Cheap, but the incoming air is unconditioned and humid, which adds latent load and RH.
4. **Window trickle vent or slot in a sliding-door frame.** Cheap, but brings in humid air, noise and insects, and the flow is uncontrolled. Poor fit for Phuket.
5. **Single-room through-wall ERV.**
   - **Mitsubishi Lossnay VL-100U5-E / VL-100EU5-E:** up to about 106 m³/h, up to 80 % recovery, 2×75 mm spigots, 7.5 kg. Prices: about £250–£383 (UK), €559 (FI), US$1,475 RRP (an Australian-style distributor listing). No Thai price found. https://mitsubishi-electric.co.nz/publications/ventilation/Lossnay-Single-Room-VL100-Series ; https://www.swatengineering.co.uk/shop/mitsubishi-electric-lossnay-vl-100u5-e-ventilator (M)
   - **Blauberg Vento Expert A50:** ceramic regenerator, mostly sensible recovery. The installation manual limits indoor RH to 65 % (short-term up to 80 % with condensation possible). Poor fit for the tropics. https://blauberg-na.com/download/vento-expert-a50-1-pro-bl-na-datasheet-14911.pdf (M)
   - Through-wall units need a core hole and an exterior wall, and they make some fan noise; check dB(A) ratings.
6. **Ducted ERV into the ducted AC return plenum (best fit with the existing system).**
   - Panasonic Thailand lists an "ERV DC series" (FV-50ZY1, FV-65ZY1, FV-80ZY1, FV-1HZY1), so local supply exists. Airflows and prices were not retrieved, and these may be larger than one room needs. https://www.panasonic.com/th/air-solutions/products/fan-ventilating-fan/vf/erv/erv-dc-series/fv-50zy1.html (M that the products exist; specs not verified)
   - Delivering fresh air into the AC return means the coil dehumidifies it.
   - Needs: a balanced exhaust path, insulated ducts (condensation risk on cold surfaces), filters and a backdraft damper. Have a local HVAC contractor size it.
7. **Inline fan bringing unrecovered outdoor air straight into the return plenum.** Cheapest ducted option, but the AC must absorb the full ~0.4–0.9 kW load. Risk of high RH and duct condensation; requires a relief path.
8. **Daikin Japan split units with outdoor-air intake through a hose** exist, but they are not ducted. https://coolingpost.com/world-news/daikin-adds-fresh-air-supply-to-split-air-conditioners (M)

**Not found:** any Toshiba or Carrier documentation on fresh-air connections for this ducted model; Thai prices for any ERV.

**Decision rule:** consider ventilation if the median nightly mean CO₂ exceeds 1,000 ppm, or if CO₂ regularly passes 1,200 ppm by morning (likely, given the maths). Then size for 50–80 m³/h and **monitor RH alongside CO₂** after installing.

---

## 6. Light and darkness

- **Melatonin suppression:** 50 % suppression (ED50) at **24.6 lux** on average. Individual ED50 ranged from **6 to 350 lux**, a more than 50-fold spread. Phillips et al. 2019, *PNAS* 116:12019 (n=55, 5 h evening exposure). https://pmc.ncbi.nlm.nih.gov/articles/PMC6575863 (H)
- **Light during sleep:** one night at 100 lux vs <3 lux raised night-time HR, lowered HRV and raised next-morning insulin resistance. Mason, Zee et al. 2022, *PNAS* (10.1073/pnas.2113290119). https://news.feinberg.northwestern.edu/2022/03/14/exposure-to-artificial-light-during-sleep-may-increase-risk-of-heart-disease-and-diabetes/ (H)
- **Low-level bedroom light (HEIJO-KYO cohort, Obayashi):** ≥5 lux at night was linked to later depressive symptoms in older adults; ≥10 lux for ≥30 min was linked to depressive symptoms (OR 1.71). Observational. https://time.com/5189387/dark-room-sleep-study/ (M)
- **Conclusions:**
  - The "pitch black" goal is supported: aim for **<1 lux at eye level**.
  - **[Inference]** Single small indicator LEDs at a distance usually contribute well under 1 lux at the eye. The evidence does not show these are harmful, but a highly sensitive person (ED50 ~6 lux) is the reason to cover them.
  - Cover or turn off the camera's IR status LED and any AC status LEDs; tape is acceptable. Note that 850 nm IR night vision is mostly invisible, though some people see a faint red glow.
  - **Not found:** the "Cho 2016, 10 lux shallow sleep" study was not verified.

---

## 7. Noise

- **WHO 1999 Community Noise Guidelines:** bedroom 30 dB LAeq continuous; 45 dB LAmax for single events.
- **WHO 2009 Night Noise Guidelines:** 42 dB LAmax as the no-effect level for conscious awakening; biological effects from about 32–35 dB LAmax; 40 dB Lnight outdoors.
- These figures are secondary summaries; check the WHO texts. https://www.ioa.org.uk/system/files/proceedings/10._n_conlan.pdf (M)
- **[Inference]** Practical points:
  - Ducted AC fan-speed changes and compressor starts are the likely loudest night-time events, so prefer fixed low fan speed and smooth setpoint steps.
  - None of the three SwitchBot devices reports dB. The camera microphone, or an iPhone app on test nights, could log noise.
  - Mishra 2018 and Liao & Laverge 2019 show that opening windows trades lower CO₂ for more noise — another reason to prefer mechanical ventilation here.

---

## 8. Wearable signals that respond to the environment (for correlation dashboards)

| Signal | Evidence that it responds to the environment | Typical effect size | Notes |
|---|---|---|---|
| Sleeping / minimum HR | BMC Med 2025: higher HR more likely above 24 °C (OR 3.9 at 28–32 °C). Moyen 2024: −1.2 bpm with cooling. Mason 2022: higher with light. | ~1–5 bpm | Strongest and most reliable signal (H) |
| HRV (RMSSD) | BMC Med 2025 (Fitbit lnRMSSD, OR 2.9 at 28–32 °C); Moyen 2024 (+2 ms); Mason 2022 (lower with light) | ~2–5 ms, 7–13 % | Use RR intervals if the raw export has them; otherwise nightly RMSSD (H) |
| Deep sleep minutes | Moyen (+14 min, men); Fan 2023 (less with poor ventilation); Xu 2021 (SWS falls with CO₂); Okamoto-Mizuno (less in humid heat) | 5–15 min | Consumer staging has only moderate agreement with EEG (M) |
| WASO / restlessness / sleep efficiency | Baniassadi (5–10 % lower efficiency from 25 to 30 °C); Strøm-Tejsen (actigraphy); Moyen (more wake with a warm Late phase) | 5–10 % | Raw accelerometer-based movement is a good "raw" metric (H) |
| Sleep onset latency | Kräuchi (DPG); Lan 2016; Xu 2021 (rises with CO₂); Mishra | minutes | Self-report or wearable (M) |
| Skin temperature variation | Wrist skin temperature is dominated by ambient and bedding: about 2 °C swings from ambient. Fitbit reports a *variation from baseline*, not absolute temperature. https://www.wareable.com/fitbit/fitbit-skin-temperature-readings-set-for-huge-accuracy-boost ; https://store.google.com/intl/en/ideas/articles/track-your-skin-temperature | — | **Treat room temperature as a confounder, not an outcome.** Correct skin temperature for room temperature before using it (for example, for cycle tracking) (M) |
| Respiratory rate | Listed as an Eight Sleep Autopilot input; no direct environment study found | — | L |

**Analysis design (all [Inference]):**
- **Model:** each person is their own control, using mixed-effects or within-person regression of each nightly metric against:
  - room temperature (mean and early-night mean)
  - RH
  - nightly mean CO₂ and minutes above 1,000 ppm
  - light events
  - bedding, alcohol, late meals, exercise, caffeine, menstrual phase
- **Effects are small** compared with night-to-night noise (deep sleep SD typically 15–20 min).
  - Two-sample estimate to detect a 10-minute deep-sleep change (α=0.05, 80 % power): about 35 nights per arm if SD=15, about 63 if SD=20.
  - Do **randomised alternating-night N-of-1 trials** (e.g. curve A vs B on random nights for 4–8 weeks) rather than before/after comparisons.
  - HR and HRV usually need fewer nights.
- **Charts to build:**
  - Hypnogram overlaid with room temperature, RH and CO₂ (minute resolution)
  - Scatter plots with LOESS curves: nightly HR, HRV and deep sleep vs early-night room temperature and vs mean CO₂
  - CO₂ ramp per night with the fitted ACH
  - Weekly heat map of "minutes above 1000 ppm"
  - A/B experiment panel showing effect estimates with confidence intervals

---

## 9. Summary of targets

| Parameter | Target | Alert |
|---|---|---|
| Air temperature, bed height | Curve: 20 → 19–20 (first 4 h) → 21–22 (late) | >24 °C at any point during sleep; <17 °C |
| RH | 45–55 % | >60 % for >2 h; <35 % |
| CO₂ | <800 ppm (preferred), <1000 ppm (minimum) | >1000 amber; >1500 red |
| Light at the eye | <1 lux (pitch black) | any lux reading above ~1 during sleep |
| Noise | ≤30 dB LAeq; events <42 dB LAmax | — |
| Ventilation needed for CO₂ <800 | ~50–80 m³/h of outdoor air (about 8 L/s per person) | measured ACH <0.3 h⁻¹ |


---

# Adversarial verification (independent fact-check)

# VERDICTS
- [unverifiable] Lan, Lian & Lin 2016: a 'comfortably cool' 25 C early-night setting with summer bedding kept extremities cold for about 90 min and delayed sleep onset vs 26 C; distal vasodilation (warm feet) is the best predictor of fast sleep onset (Kräuchi 1999).
  -> The cited SJTU page timed out twice and the search budget ran out, so I could not check the numbers (25 vs 26 C, 90 min). The paper appears to be Lan L, Lian Z, Lin Y, Build Environ 2016, 'Comfortably cool bedroom environment during the initial phase of the sleeping period delays the onset of sleep in summer'. That title is consistent with the claim, but the details are unconfirmed. Kräuchi et al. 1999 (Nature) on the distal-proximal skin temperature gradient predicting sleep onset is well established. Note that 25-26 C with summer bedding is very different from the couple's 18-20 C. Their bedding and clothing determine whether the extremities stay cold. (https://faculty.sjtu.edu.cn/lanli/en/lwcg/191366/content/123500.htm)
- [partially-true] 50% melatonin suppression at about 24.6 lux on average, individual ED50 6 to 350 lux (Phillips 2019 PNAS); 100 lux during sleep raised HR, lowered HRV and raised next-day insulin resistance vs <3 lux (Mason 2022 PNAS).
  -> The Phillips numbers are correct: ED50 24.60 lux, individual range 6.0-349.8 lux, n=55, PNAS 116:12019. But this was evening light with eyes open before bedtime, not light during sleep. Closed eyelids pass only a small fraction of light, and a tiny device LED gives far below 1 lux at the eye. So Phillips does not justify treating LED pinpoints as equivalent to 25 lux. Mason 2022 (100 lux overhead room light for one night vs <3 lux, n=20) is accurately summarized from memory. The PNAS page returned 403, so I could not re-check it. Pitch-black is still a reasonable preference, but the dose argument is weaker than claimed. (https://pmc.ncbi.nlm.nih.gov/articles/PMC6575863)
- [partially-true] Dust mites are minimised below 50% RH and most fungi need above 60% RH; humid heat (35 C/75%) worsens sleep, but at mild temperatures RH has small effects, with best values around 52-55% RH.
  -> The cited source (Arundel et al. 1986, Environ Health Perspect 65:351) supports only the first half: mites minimised below 50% RH and peaking at 80%, most fungi needing above 60%. It recommends 40-60% RH overall. It says nothing about sleep, 35 C/75% RH, or 52-55% RH. The sleep-humidity parts need their own sources (e.g. Okamoto-Mizuno/Tsuzuki), which I could not check. An RH target of 45-55% with an alert above 60% is still sensible. At an 18-20 C setpoint in Phuket, the aircon will usually push RH up toward 60% or more once the compressor cycles off, not down. (https://pmc.ncbi.nlm.nih.gov/articles/PMC1474709/)
- [partially-true] Fresh air in Phuket is mostly a latent load: 40-80 m3/h of 27-30 C/75-85% air adds about 0.5-1.1 kg/h of water and about 0.4-0.9 kW of total cooling load; an enthalpy ERV cuts this by about 60%. ERVs, not HRVs, are recommended for humid climates.
  -> My psychrometric check roughly agrees. 30 C/80% air (about 21.6 g/kg) brought to 24 C/50% (about 9.3 g/kg) removes about 12 g/kg. At about 46-92 kg/h that is 0.55-1.1 kg/h, plus about 0.4-1.0 kW total, mostly latent. 27 C/75% air at 40 m3/h is lower, about 0.4 kg/h. Typical enthalpy effectiveness is 50-70%, so '~60%' is plausible, but I did not verify it against the AHRI page. Key nuance: an ERV only recovers energy. It does not dehumidify, so the remaining moisture still falls on the aircon. Under light load at an 18-20 C setpoint a ducted unit may short-cycle and leave RH high, so a dehumidifier may still be needed. (https://ahrinet.org/scholarships-education/education/contractors-and-specifiers/hvacr-equipmentcomponents/air-air-energy-recovery-ventilators-ervs)
- [partially-true] Fitbit skin temperature is reported as variation from a baseline and is strongly confounded by ambient temperature and bedding (about 2 C swings).
  -> The 'variation from baseline' part is confirmed by the official Fitbit API docs. The skin temperature endpoint returns only nightlyRelative: the average during a sleep of 3 h or more, relative to the user's baseline, one value per night. It is not a raw time series. The cited Wareable page returned 403, so the '~2 C swings / strongly confounded' wording is unverified. Treating room temperature as a confounder is still correct practice. (https://dev.fitbit.com/build/reference/web-api/temperature/get-temperature-skin-summary-by-date/)
# ANSWERED
- Q: Whether the Fitbit Air raw export provides RR intervals / raw accelerometry (needed for 'raw' HRV and restlessness).
  A: Partially answered. The legacy Fitbit Web API exposes skin temperature only as a nightly value relative to baseline, not raw. The bigger finding: per Fitbit's own docs, support for the legacy Fitbit Web API ended 30 Sep 2026, and the API is switched off on 30 Oct 2026, two days from today. Any pipeline must use the Google Health API (or the Google Takeout / Health Connect / Apple HealthKit routes). Whether RR intervals or raw accelerometry are exposed there was not verified. Historically, the Fitbit Web API offered HRV summaries (RMSSD at 5-min intervals during sleep), not RR intervals, and no raw accelerometry.
- Q: Per-person CO2 generation for sleeping adults (input to the ACH model).
  A: Persily & de Jonge method: V_CO2 = BMR x M x 0.000484 L/s. At M of about 0.95-1.0 met, a 60-80 kg adult produces about 0.0026-0.0035 L/s, so two sleepers total about 0.006-0.007 L/s. The researcher's 0.0062-0.0080 range is realistic to conservative. My independent recomputation of the sealed-room projections matches within about 1%.
- Q: Actual ACH / bathroom fan / ceiling-void return.
  A: Not answerable from sources; these need on-site checks. Method: after both occupants leave the bedroom in the morning, fit ln(C - C_out) against time on the Meter Pro CO2 decay. The slope is the ACH. If the ducted return draws from a leaky ceiling void, the decay will look faster than a sealed room would suggest.
# MISSED
- CRITICAL: the legacy Fitbit Web API is shut off on 30 Oct 2026 (support ended 30 Sep 2026). New code must target the Google Health API or Health Connect/HealthKit, not dev.fitbit.com endpoints.
- Fitbit skin temperature via the API is one nightly relative-to-baseline value (needs a sleep of 3 h or more), not a raw continuous stream. It cannot be correlated minute by minute with the room temperature curve.
- The Eight Sleep results were for bed-surface (water mattress) temperature changes, not room air temperature. Aircon air setpoint curves are an extrapolation, and a ducted unit responds far more slowly.
- Phillips 2019 measured eyes-open pre-bed light. Closed eyelids strongly attenuate light, so tiny indicator LEDs at sleep time are a much smaller dose than the 24.6 lux ED50 implies. The pitch-black rule is still reasonable, but the dose is overstated.
- CO2 sensors with automatic baseline calibration (ABC) assume the room regularly reaches about 400 ppm. A sealed bedroom that never gets fresh air can make ABC drift low. I could not verify the Meter Pro CO2's specific ABC or manual calibration procedure (search budget exhausted). Check the SwitchBot manual and calibrate outdoors.
- Even with an ERV, Phuket outdoor air needs dehumidification by the aircon. A ducted unit at an 18-20 C setpoint under low night load may short-cycle and let RH climb above 60%, so a standalone dehumidifier or a dry-mode schedule may be needed.
- The BMC Medicine HRV effect is graded and already significant at 24-26 C (OR 1.4), so 'below 24 C' is a dose-response guide rather than a threshold. The cohort was 65 and older.
- Akimoto et al. treat CO2 as a ventilation/bioeffluent marker. Lowering CO2 by any means other than outdoor-air ventilation (e.g. scrubbers) is not supported by the evidence.
- Verification limits: the web search budget was exhausted early, the Lan 2016 and Wareable sources could not be fetched, and the Mason 2022 PNAS page returned 403. Those details remain unverified. No SwitchBot device claims were in this claim set.