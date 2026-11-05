Paste everything below the line into the Claude Code session on Erik's Mac.

---

The night listener misses most of the snoring. Cath snored last night (night 2026-11-05; Erik heard it), but after we both fell asleep the listener found almost no snoring minutes. The camera's microphone is very quiet (about −68 dBFS, quiet floor about −71 dBFS), and YAMNet names real snoring "Whale vocalization", "Animal", "Wild animals", "Outside, rural or natural", "Music" or quiet "Speech". The 04:12–04:13 "Whale vocalization" / "Music" events were very likely snoring.

So we label sounds in the app now. Under each clip there are two buttons, **Snoring** and **Not snoring** (and after Snoring: Cath / Erik / ?). The backend hands those labels back to you, and **you tune the snore rule from them**. To give us something to label, you also send short clips of **borderline sounds**. All server changes are live; the contract is below.

Safety rules. These still apply to every step:
- **Never print, echo, log or commit the token.** It stays in its 0600 file.
- Audio goes only to the signed upload URLs the server returns. No audio is kept on disk: clip files live in the 0700 `tmp/` folder only until uploaded, then are deleted whether or not the upload worked. Never log transcripts.
- Inspect before you change anything, and tell me what you found.

## 0. Inspect first

- Show me the current snore rule in `~/sleep-lab-home/night-sound/listener.py`: the YAMNet Snoring ≥ 0.2 path, the rhythm rule from night-sound-fix-2 (peak threshold above the 10-minute floor, the 80–500 Hz vs 1–4 kHz band check, 4+ peaks in 30 s 2.5–7 s apart with CV < 0.3, the accepted top classes), and the per-night baseline that raises the peak threshold.
- Show me how events are built (run detection, `kind`, `label`, `peakDb`, `wantClip`) and the clip cutting / speech-frame check.
- Run `--status` once and show me the GET answer. It now has `"uncertainClipsLeft"` and `"calibration"`.

## 1. The server contract

**GET** `/functions/v1/night-sound` (the call you already make every 60 s) now looks like this:
```json
{"listen":true,"reason":"Listening until 09:00","from":"2026-11-05T14:45:00.000Z","until":"2026-11-06T02:00:00.000Z",
 "clips":true,"clipsLeft":40,"sleepTalk":true,"speechClipsLeft":20,"uncertainClipsLeft":8,
 "calibration":{
   "labels":[
     {"eventId":1234,"ts":"2026-11-04T21:12:03.000Z","label":"snore","who":"a","kind":"other","yamnet":"Whale vocalization",
      "peakDb":-61,"floorDb":-71,"durationS":6,"score":0.21,"uncertain":true,"labelledAt":"2026-11-05T02:00:00.000Z"},
     {"eventId":1240,"ts":"2026-11-04T21:30:40.000Z","label":"not_snore","who":null,"kind":"loud","yamnet":"Door",
      "peakDb":-44,"floorDb":-70.5,"durationS":1,"score":0.62,"uncertain":false,"labelledAt":"2026-11-05T01:58:00.000Z"}],
   "summary":{
     "total":9,"counts":{"snore":6,"not_snore":3,"speech":0,"other":0},
     "byYamnet":[
       {"yamnet":"Whale vocalization","n":4,"snore":4,"notSnore":0,"precision":1,"trusted":true},
       {"yamnet":"Music","n":3,"snore":1,"notSnore":2,"precision":0.33,"trusted":false},
       {"yamnet":"Door","n":1,"snore":0,"notSnore":1,"precision":0,"trusted":false}],
     "snoreClasses":["Whale vocalization"],
     "peakAboveFloor":{"n":6,"median":9.5},
     "suggestedPeakAboveFloorDb":7.5,
     "updatedAt":"2026-11-05T02:00:00.000Z"}},
 "night":"2026-11-06","now":"2026-11-05T14:46:10.000Z"}
```
- `calibration.labels`: the newest 200 labelled events, newest label first. `label` is `snore`, `not_snore`, `speech` or `other`; `who` is `a` (Cath), `b` (Erik), `both`, `unknown` or null. `yamnet` is the `label` you sent with the event. `floorDb` is the `dbFloor` of the minute the event started in (null if that minute had no summary).
- `calibration.summary` is derived from those labels on the server:
  - `byYamnet[].precision` = share of that class's labelled events that were labelled snoring; `trusted` = at least 3 labels and precision ≥ 0.6. `snoreClasses` lists the trusted ones.
  - `suggestedPeakAboveFloorDb` = median of (peakDb − floorDb) over snore-labelled events, minus 2 dB, rounded to 0.5, kept within 4..10 dB. With fewer than 3 such events it is 10 (the fix-2 value).
- `calibration` is `null` when the server can't read labels. Then use the defaults (fix-2).
- `GET /functions/v1/night-sound?labels=1` returns only `{"calibration":{…},"uncertainClipsLeft":8,"now":"…"}`. Use it for tests or a quick refresh; the normal GET already carries the same data.

**POST** events may now carry `"uncertain": true` (a borderline sound sent so we can label it):
```json
{"camera":"bedroom",
 "minutes":[],
 "events":[
   {"ts":"2026-11-05T21:12:03.000Z","durationS":6.2,"kind":"other","label":"Whale vocalization","peakDb":-61.4,"score":0.31,
    "uncertain":true,"wantClip":true}]}
```
Answer:
```json
{"ok":true,"person":"b","received":{"minutes":0,"events":1},"stored":{"minutes":0,"events":1},
 "duplicates":{"minutes":0,"events":0},"dropped":{"outsideWindow":0,"notListening":0},"rejected":[],
 "uploads":[{"index":0,"path":"2026-11-06/20261105T211203Z_other.m4a","signedUrl":"https://…","token":"…","maxS":10}],
 "listen":true,"sleepTalk":true}
```
Then PUT the ~10 s m4a (`Content-Type: audio/mp4`) to that `signedUrl`, as for any clip.
- Uncertain non-speech events get clips from their **own allowance** (`uncertainClipsLeft`, default 8 a night; 0 = turned off in the app), separate from the 40 ordinary and 20 sleep-talk clips. `maxS` is 10.
- An event whose `label` is a speech class (e.g. `Speech`) is still a **speech event**, uncertain or not: it follows the sleep-talk rules (only with `sleepTalk: true`, from `speechClipsLeft`, `maxS: 30`, judged next morning, deleted if we were both awake).
- All other rules are unchanged: only inside the listen window, nothing while off or paused, no clip for events older than 10 min, rows are unique by `(camera, ts, kind)` and a re-post is ignored.

## 2. Tune the snore rule from the labels

1. **When.** Read `calibration` from the GET answer when `listen` turns true (start of the night's listen window), and refresh it at most once an hour after that. Keep the last good one in memory; if `calibration` is null or missing, keep the last good one, or use the defaults.
2. **Derive** (use the server's `summary`; it's computed exactly like this):
   - `trusted(class)` = the class is in `summary.snoreClasses` (≥ 3 labels, precision ≥ 0.6).
   - `labelled(class)` = the class appears in `summary.byYamnet` with `n ≥ 3`.
   - `peak_threshold_db` = `summary.suggestedPeakAboveFloorDb` (10 with no labels). The per-night baseline from fix-2 still runs on top of it: if the rhythm rule would flag more than 10 % of the first 10 minutes' seconds, raise it by 3 dB, up to 2 times.
3. **The rule.** A second counts as snoring when
   - YAMNet Snoring ≥ 0.2 on the boosted audio (unchanged), **or**
   - the rhythm rule passes (peaks ≥ `peak_threshold_db` above the 10-minute floor and ≥ 4 dB above the minute's average; the 80–500 Hz vs 1–4 kHz band check; 4+ peaks in 30 s, 2.5–7 s apart, CV < 0.3) **and** the frame's YAMNet top class is accepted:
     - if `labelled(class)`: accepted only when `trusted(class)` (so a class you two keep labelling "Not snoring" stops counting, even if fix-2 listed it);
     - otherwise: the fix-2 list (Snoring, Snort, Breathing, Gasp, Wheeze, Grunt, Roar, Growling, Animal, Wild animals, Owl, Hoot, Whale vocalization, Stomach rumble).
   - With no labels at all this is exactly the fix-2 rule.
4. **Log once per night** when the calibration is first applied, without the token, e.g.
   `calibration: 9 labels (6 snore, 3 not), trusted [Whale vocalization], untrusted [Music, Door], peak +7.5 dB (baseline +0)`.
   Log again only if an hourly refresh changes it.

## 3. Borderline clips

So we have something to label, send clips of sounds you're unsure about:

- **Candidate**: a sound run of ≥ 4 s whose YAMNet top class is one of Whale vocalization, Animal, Wild animals, Music, Snort, Breathing, Grunt, or Speech quieter than −55 dBFS peak, and that is **not already part of a snore event**.
- **Event**: post it with `"uncertain": true` and `"wantClip": true`:
  - `kind`: `"snore"` if the snore rule (step 2) fires during the run, else `"other"`;
  - `label`: the YAMNet top class of the run; `peakDb`, `durationS`, `score` (that class's mean score) as for other events.
- **Allowance**: only while `uncertainClipsLeft` > 0 (from the latest GET; also count down locally for each upload you get). At most **one borderline clip per 20 minutes**, so they are spread over the night. When the allowance is used up, don't send uncertain events with `wantClip: true` (an uncertain event without a clip is fine to send, but not needed).
- **Quiet Speech**: an event labelled `Speech` is a speech event on the server. Ask for its clip only when GET said `"sleepTalk": true`; it comes from `speechClipsLeft` and may be up to 30 s (`maxS`). It is exempt from the speech-frame check like other speech clips. All other borderline clips keep the rule "drop the clip if any frame in its window is speech".
- **Clip**: as for other clips: about 10 s around the run (2 s pre-roll), AAC m4a mono 16 kHz 48 kbps, PUT to the `signedUrl`, then delete the file. No upload in the answer means no clip: drop the audio, don't retry.
- Outbox rule unchanged: events written to `outbox/` get `wantClip: false`.

## 4. Test, restart, report

1. `--status`: show the GET answer's `uncertainClipsLeft` and the `calibration` summary (labels count only; never the token).
2. Dry run: `--dry-run-live 300` while the room is quiet. Print the derived calibration line and any borderline candidates (time, class, peak, duration). snoreS should stay near 0 for every minute while we're awake.
3. If you kept the 04:12–04:13 audio from last night, or have a snoring test file: run the analysis on it with the current calibration and with none, and show the snoreS per minute for both.
4. Restart: `launchctl kickstart -k gui/$(id -u)/com.sleeplab.night-sound`.

Report back:
- what you found in step 0;
- the diff summary of `listener.py`;
- the calibration line it logged and the test numbers (before / after);
- anything you couldn't do.
