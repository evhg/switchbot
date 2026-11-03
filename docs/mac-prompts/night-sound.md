Paste everything below the line into the Claude Code session on Erik's Mac.

---

We're changing what this Mac does with the SwitchBot camera. The camera (Pan/Tilt Cam Plus 3K) is now on Cath's bedside table, by the window, pointed at the wall. Erik snores the loudest. From now on:

- **No video leaves the house.** The Tailscale Funnel is turned off. go2rtc keeps running, but only locally.
- **Living-room face recognition / activity is retired.** The camera is in the bedroom facing a wall now, so it's pointless.
- **The Mac only listens, and only while we sleep.** A new "night listener" asks the Sleep Lab backend every 60 s whether to listen. Only while the answer is `listen: true` does it read the camera's **audio** from go2rtc (video dropped). It classifies the sound here on the Mac with Google's YAMNet model through MediaPipe, and posts per-minute summaries and short event records. For notable moments it also uploads ~10 s clips. When the answer is `listen: false`, no audio process runs at all.

Safety rules. These apply to every step:
- **Never print, echo, log or commit the presence token.** Read it from its 0600 file only. Don't `cat` it, and don't put it in a plist, a command line, shell history or a log line. If you need to show that it works, show the `person` the ping returns.
- **No audio is kept on disk.** The only exceptions are the transient clip files, which are written to a 0700 temp folder, uploaded and deleted right away (also after a failed upload). Don't write raw PCM, WAV dumps or debug recordings anywhere. The only exception is the synthetic test file in step 5, which you delete afterwards.
- **Listen only when the backend says so.** Treat any doubt (errors, no answer, a passed `until`) as "stop listening".
- Inspect before you change anything, and tell me what you found.

## 0. Inspect what exists first

Look before touching anything, then summarise for me what you found:
- `ls ~/sleep-lab-home`, `ls ~/sleep-lab-home/logs`, `ls ~/Library/LaunchAgents | grep -i sleeplab`, `launchctl list | grep -i sleeplab`.
- go2rtc: its config (`~/sleep-lab-home/go2rtc.yaml` or wherever the `com.sleeplab.go2rtc` plist points). Note:
  - the stream names (expected: `living` = 640x400 H.264 + AAC 16 kHz mono, and `living_hd`);
  - the RTSP listen address (default `:8554`);
  - any RTSP username/password;
  - any API base path or secret.
- Which other jobs exist. Expected, but check:
  - a face-recognition / activity job that posts to `…/functions/v1/camera-event`;
  - possibly a ticket gate `com.sleeplab.ticket-gate` on port 1985;
  - possibly a Wi-Fi presence job;
  - possibly a `rotate-link.sh`.
- Funnel and Serve: `/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel status` and `… serve status`. Use `tailscale` instead if that CLI is on the PATH.
- `which ffmpeg ffprobe python3`, `python3 --version`, `sw_vers`, `uname -m`.
- Confirm the audio track exists. Use whatever credentials and stream name go2rtc.yaml actually has; this prints stream info only:
  `ffprobe -hide_banner -rtsp_transport tcp -i rtsp://127.0.0.1:8554/living`

## 1. Retire the face recognition and the ticket gate (keep go2rtc)

- For the face-recognition / activity job and the ticket gate (if present), run `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`. Then move each plist into `~/sleep-lab-home/retired/` so it can't load again at login. Keep their code folders for now.
- If the face job stored enrolled faces or embeddings, **don't delete them without asking**. Tell me where they are and how big they are, and I'll decide.
- Keep `com.sleeplab.go2rtc` running and reachable on 127.0.0.1. Keep a Wi-Fi presence job, if there is one.
- If `rotate-link.sh` or any notes mention the Funnel, add a line at the top saying the Funnel is retired as of 2026-11-03.

## 2. Turn the Tailscale Funnel off

- `/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --https=443 off`. If `funnel status` shows other ports or handlers that point at go2rtc (1984) or the gate (1985), turn those off too. `… funnel reset` / `… serve reset` is fine **only if** nothing else on this Mac uses Serve/Funnel; check first.
- Verify:
  - `funnel status` shows no Funnel;
  - `curl -sS -o /dev/null -w '%{http_code}\n' https://<old funnel host>/…/stream.html` from this Mac no longer reaches go2rtc (a connection error or non-200 is expected).
- go2rtc may still bind 0.0.0.0. If its config allows it, bind the API and WebRTC/RTSP listeners to 127.0.0.1 (e.g. `api: listen: "127.0.0.1:1984"`, `rtsp: listen: "127.0.0.1:8554"`), unless the Wi-Fi presence job or anything else needs LAN access. Tell me what you changed. Then restart go2rtc: `launchctl kickstart -k gui/$(id -u)/com.sleeplab.go2rtc`.

In the Sleep Lab app the video player is already hidden: System › Camera → "Show live video" is off by default. I'll leave it off.

## 3. Build the night listener in `~/sleep-lab-home/night-sound/`

### Setup
- `brew install ffmpeg` if ffmpeg is missing.
- Create a venv: `python3 -m venv ~/sleep-lab-home/night-sound/.venv`, then `.venv/bin/pip install --upgrade pip mediapipe numpy`. If pip finds no mediapipe wheel for this Python version, run `brew install python@3.12` and build the venv with `/opt/homebrew/bin/python3.12` instead. Use only the standard library for HTTP (`urllib.request`). If TLS fails with the python.org build, `pip install certifi` and pass `ssl.create_default_context(cafile=certifi.where())`.
- Model: `curl -fL -o ~/sleep-lab-home/night-sound/yamnet.tflite https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite`. It's about 4 MB. The input is 15600 samples = 0.975 s at 16 kHz, and there are 521 AudioSet classes.
- Token file:
  - create it with `install -m 600 /dev/null ~/sleep-lab-home/night-sound/token`;
  - **ask me to paste the token myself**. It's the presence token (`slp_` + 64 hex) from Sleep Lab › System › Presence; Erik's is fine. Tell me a command like `pbpaste > ~/sleep-lab-home/night-sound/token` after I copy it on this Mac;
  - check the format without printing it: `python3 -c "import re,pathlib;print(bool(re.fullmatch(r'slp_[0-9a-f]{64}', pathlib.Path('~/sleep-lab-home/night-sound/token').expanduser().read_text().strip())))"`;
  - make sure `night-sound/token` is in a `.gitignore` if `~/sleep-lab-home` is a git repo.
- Create `~/sleep-lab-home/night-sound/tmp/` (mode 0700) for transient clips. Empty it at startup.

### Backend contract (follow exactly)

Base URL: `https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/night-sound`. Every request carries the header `X-Presence-Token: <token>`. `Authorization: Bearer <token>` also works. 401 means the token is wrong or was rotated: stop listening and log "unauthorized" (not the token).

**GET** (every 60 s), example answer:
```json
{"listen":true,"reason":"Listening until 09:00","from":"2026-11-03T14:45:00.000Z","until":"2026-11-04T02:00:00.000Z",
 "clips":true,"clipsLeft":40,"night":"2026-11-04","now":"2026-11-03T16:02:10.000Z"}
```
- The window runs from tonight's lights-out − 15 min to the aircon's OFF (wake + 30 min), by default 21:45 → 09:00 ICT.
- `listen` is already false when the app has it off or paused, when we're away tonight, or when nobody is home.
- `reason` is a short human string. Log it when it changes.
- `clips` is whether clips are wanted at all; `clipsLeft` is the remaining clip budget for this night (40 per night).

**POST ping** `{"ping":true}` → `{"ok":true,"person":"b"}`.

**POST data** (at most 120 minutes and 100 events per request; timestamps in UTC with `Z`):
```json
{"camera":"bedroom",
 "minutes":[
   {"ts":"2026-11-03T18:23:00Z","dbAvg":-52.1,"dbMax":-31.4,"dbFloor":-61.0,
    "snoreS":24,"snoreProb":0.41,"speechS":0,"coughS":0,
    "classes":{"Snoring":24,"Breathing":11,"Silence":20,"Snort":3,"Inside, small room":2},"n":61}],
 "events":[
   {"ts":"2026-11-03T18:23:12.400Z","durationS":9.5,"kind":"snore","label":"Snoring","peakDb":-31.4,"score":0.62,"wantClip":true},
   {"ts":"2026-11-03T18:40:05.100Z","durationS":1.0,"kind":"loud","label":"Door","peakDb":-12.3,"score":0.55,"wantClip":true},
   {"ts":"2026-11-03T19:02:44.000Z","durationS":3.9,"kind":"speech","label":"Speech","peakDb":-35.0,"score":0.71,"wantClip":false}]}
```
Answer:
```json
{"ok":true,"person":"b","received":{"minutes":1,"events":3},"stored":{"minutes":1,"events":3},
 "duplicates":{"minutes":0,"events":0},"dropped":{"outsideWindow":0,"notListening":0},"rejected":[],
 "uploads":[{"index":0,"path":"2026-11-04/20261103T182312.400Z_snore.m4a","signedUrl":"https://…/storage/v1/object/upload/sign/night-sounds/…?token=…","token":"…"},
            {"index":1,"path":"2026-11-04/20261103T184005.100Z_loud.m4a","signedUrl":"https://…","token":"…"}],
 "listen":true}
```

Minute fields:
- `ts` is the minute start (UTC, seconds = 0).
- `dbAvg`: mean of the frame dBFS values. `dbMax`: their max. `dbFloor`: their 10th percentile.
- `snoreS`, `speechS`, `coughS`: seconds 0..60 classified as snoring / speech / cough.
- `snoreProb`: mean snoring score 0..1.
- `classes`: the top 5 frame-winning classes → seconds.
- `n`: the number of frames in that minute (~61).

dBFS range: −120..20, where 0 = full scale. A frame's dBFS is `20*log10(max(rms, 1e-6))` of the float samples in −1..1.

Event fields:
- `kind`: `snore` | `loud` | `cough` | `speech` | `other`.
- `label`: the YAMNet class name, exactly as the model gives it.
- `score` 0..1; `durationS` in seconds; `wantClip` true/false.

Server behaviour:
- **The server drops anything outside the night's listen window (± 5 min)**, so a stale batch posted in the afternoon is simply dropped (`dropped.outsideWindow`). That's fine; don't retry dropped rows.
- `(camera, ts)` for minutes and `(camera, ts, kind)` for events are unique, so re-posting a batch is safe (`duplicates`).
- Speech is never clipped; the server ignores `wantClip` for speech anyway. Still send `false`.
- `uploads[i].index` is the position in this request's `events` array.

Clip upload: PUT the m4a to the `signedUrl` exactly as given, with `Content-Type: audio/mp4`, at most 1 MB. A 10 s clip at 48 kbps AAC is about 60 KB. The URL is valid 2 h. Example: `curl -X PUT -H 'Content-Type: audio/mp4' --data-binary @clip.m4a "<signedUrl>"`, but do it in Python. Delete the file whether or not the upload works.

### `listener.py`: design

You can adapt the details, but keep the behaviour below.

**Main loop (one process, run by launchd)**
- Every 60 s, GET the decision. Keep `listen`, `until`, `clipsLeft`, `clips` and `night`. Log `reason` when it changes.
- When `listen` is true and no capture is running, start ffmpeg on go2rtc's local RTSP, audio only:
  ```
  ffmpeg -nostdin -hide_banner -loglevel error -rtsp_transport tcp \
         -i "rtsp://127.0.0.1:8554/living" -vn -ac 1 -ar 16000 -f s16le -
  ```
  - Use the stream name and credentials from go2rtc.yaml.
  - Try `rtsp://127.0.0.1:8554/living?audio` first: go2rtc then requests only the audio track, which is lighter. Fall back to the plain URL if that yields no data.
  - Read stdout in a thread in 15600-sample chunks (31200 bytes).
  - If ffmpeg dies while listening, restart it with backoff: 5 s, then 15 s, 60 s, capped at 5 min.
- Stop ffmpeg **immediately**, with terminate then kill after 3 s, when any of these happens:
  - `listen` turns false;
  - a POST answer says `"listen":false`;
  - the local clock passes `until` (check every frame, not just at the poll);
  - the GET fails 3 times in a row.

  On stop:
  - flush the current partial minute (post it with its `n`) and any finished events;
  - clear the ring buffer and pending clip audio from memory.
- go2rtc only pulls the camera while it has a consumer, so with no ffmpeg running nothing is read at all.

**Classifier.** MediaPipe Tasks audio. Use AUDIO_CLIPS mode with one 0.975 s chunk per call; it's synchronous and simplest. AUDIO_STREAM + `classify_async` + `result_callback` also works if you prefer it.
```python
import numpy as np
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import audio as mp_audio
from mediapipe.tasks.python.components.containers import audio_data as mp_audio_data

SR = 16000
FRAME = 15600            # YAMNet input: 0.975 s at 16 kHz
FRAME_S = FRAME / SR

options = mp_audio.AudioClassifierOptions(
    base_options=mp_tasks.BaseOptions(model_asset_path=str(MODEL_PATH)),
    running_mode=mp_audio.RunningMode.AUDIO_CLIPS,
    max_results=-1,          # all 521 classes, so Snoring's score is always there (None also means "all")
    score_threshold=0.0,
)
classifier = mp_audio.AudioClassifier.create_from_options(options)

def classify(chunk_i16: np.ndarray) -> dict[str, float]:
    x = chunk_i16.astype(np.float32) / 32768.0
    data = mp_audio_data.AudioData.create_from_array(x, SR)
    results = classifier.classify(data)          # list[AudioClassifierResult]; one entry for a 0.975 s chunk
    cats = results[0].classifications[0].categories
    return {(c.category_name or c.display_name): c.score for c in cats}

def dbfs(chunk_i16: np.ndarray) -> float:
    x = chunk_i16.astype(np.float32) / 32768.0
    rms = float(np.sqrt(np.mean(x * x))) if x.size else 0.0
    return max(-120.0, min(20.0, 20.0 * np.log10(max(rms, 1e-6))))
```
- Some mediapipe versions name the enum `mp_audio.AudioTaskRunningMode` or `mp.tasks.audio.RunningMode`. Check `dir(mp_audio)` and adapt.
- If `max_results=-1` is rejected, use `None`.
- If more than one result comes back for a chunk, take the scores per class as the max across results.

**YAMNet class names to use.** These are exact display names from the AudioSet / YAMNet class map:
- Snoring: `Snoring` (main signal), plus `Snort`. `Breathing`, `Wheeze`, `Gasp` and `Pant` are context only. Define a frame as snoring when `Snoring >= 0.3`, or when `Snort >= 0.3` and `Breathing + Snoring >= 0.4`. Document this heuristic at the top of the file, as a constant you can tune. The frame's `snoreProb` contribution is `max(Snoring, Snort)`.
- Cough: `Cough` (also count `Throat clearing` and `Sneeze` as cough-kind, keeping their label).
- Speech (the **speech set**): `Speech`, `Child speech, kid speaking`, `Conversation`, `Narration, monologue`, `Babbling`, `Speech synthesizer`, `Shout`, `Bellow`, `Whoop`, `Yell`, `Children shouting`, `Screaming`, `Whispering`, `Laughter`, `Baby laughter`, `Giggle`, `Snicker`, `Belly laugh`, `Chuckle, chortle`, `Crying, sobbing`, `Baby cry, infant cry`, `Whimper`, `Wail, moan`, `Sigh`, `Singing`, `Humming`. A frame's speech score is the max over this set. The backend keeps the same list and refuses a clip for any event labelled with one of these classes.
- Other notable (kind `other`, or `loud` if loud enough):
  - doors: `Door`, `Slam`, `Knock`, `Sliding door`;
  - animals: `Dog`, `Bark`, `Cat`, `Meow`, `Bird`, `Gecko` (if present), `Insect`, `Mosquito`;
  - traffic: `Vehicle`, `Car`, `Motorcycle`, `Vehicle horn, car horn, honking`, `Siren`, `Aircraft`;
  - weather: `Thunder`, `Rain`;
  - `Music`, `Television`, `Alarm`, `Telephone`, `Ringtone`, `Mechanical fan`, `Air conditioning`.

  Check each name against the model's actual label list at startup: print `len(labels)` and warn about any names in your sets that don't exist. Don't guess spellings.
- `Silence` is a class too. It shows up in `classes` naturally.

**Per-frame state**
- Frame wall-clock time = capture start time + samples read / 16000. If it drifts more than 2 s from `time.time()`, resync to `time.time()`.
- Keep a rolling 10-minute noise floor = 10th percentile of frame dB over the last 10 min. Use about 615 frames in a deque, and require at least 30 frames before declaring "loud".
- Keep a **20 s ring buffer** of int16 samples, about 640 KB, in memory only.

**Per-minute aggregation**
Group frames by the UTC minute they start in. When a minute ends, build one minute record:
- `dbAvg`, `dbMax`, `dbFloor` from the frame dB values (10th percentile for the floor);
- `snoreS` = round(snoring frames × 0.975), capped at 60;
- `snoreProb` = mean frame snore score;
- `speechS` / `coughS` the same way;
- `classes` = the top 5 by seconds of each frame's top-1 class;
- `n` = frames.

Round dB to 0.1 and probabilities to 0.001.

**Events**
- `snore`:
  - a run starts after 3 consecutive snoring frames and ends after 5 s without one;
  - `ts` = the first frame of the run, `durationS` = the run length;
  - `peakDb` = the run's max dB, `score` = the mean snore score;
  - emit the event when the run ends, or every 60 s for very long runs as a new event with a new ts;
  - the clip is decided at the run's **start**, not its end: at run start + 7 s, decide `wantClip` (rules below) and,
    if true, snapshot the PCM from 3 s before the run start to 7 s after from the ring buffer right then. Keep that PCM
    in memory with the pending event and attach it when the event is emitted at run end. (A 20 s ring buffer no longer
    holds the start of a run longer than ~13 s, so never cut the clip at run end.)
- `loud`:
  - a frame whose dB is at least the rolling floor + 15 dB;
  - `label` = that frame's top class, `score` = that class's score;
  - merge loud frames less than 2 s apart into one event.
- `cough`: a frame with Cough-kind score ≥ 0.5; merge within 2 s.
- `speech`:
  - a run of ≥ 2 frames with speech score ≥ 0.5; merge within 5 s;
  - `wantClip` is always false;
  - **never cut, encode or upload speech audio**. Two more rules make sure of that for the other kinds:
    1. an event whose `label` is in the speech set gets `wantClip: false`, whatever its kind (a raised voice is
       reported as `loud` with label `Shout` or `Speech`; it is never clipped);
    2. before encoding any clip, check every frame in its 10 s window: if any frame has a speech score ≥ 0.5, or a
       speech-set class as its top-1 class, drop the clip (send the event with `wantClip: false`, or skip the upload
       if the event was already posted, and discard the PCM).
- `other`: a notable class from the list above with score ≥ 0.4 that isn't already a loud event; merge within 5 s.

**Clips**
- `wantClip` = true only when all of these hold:
  - the kind is not speech and the label is not in the speech set;
  - no frame in the clip's 10 s window is speech (rule 2 above);
  - GET said `clips: true`;
  - your local count of clips still allows it, using `clipsLeft`;
  - a per-kind spacing rule is met: at most one snore clip per 20 min, one loud/cough/other clip per 2 min.
- For such an event, snapshot ~10 s of audio from the ring buffer, from 3 s before the event's start to 7 s after. Hold the event until those 7 s have passed. (Snore events: snapshot at run start + 7 s as described under Events.)
- Keep the PCM in memory with the event until the POST answer arrives. For each `uploads[i]`:
  - encode the matching event's PCM to `tmp/<random>.m4a`:
    `ffmpeg -nostdin -loglevel error -f s16le -ar 16000 -ac 1 -i - -c:a aac -b:a 48k -movflags +faststart tmp/x.m4a`
    (feed the PCM on stdin);
  - PUT it to `signedUrl` with `Content-Type: audio/mp4`;
  - delete the file in a `finally`.
- Drop PCM for events that got no upload.
- Never retry a clip after the process restarts. Clip audio is never persisted.

**Posting**
- Once a minute, after the minute rolls over, POST all finished minutes and events in one batch (≤ 120 minutes, ≤ 100 events; split if more).
- On a network error or 5xx, retry with backoff (5 s, 30 s, 2 min, then every 5 min).
- Persist unsent batches as JSON (numbers and labels only, no audio) in `outbox/` and resend them on the next success or at startup. **Set every event's `wantClip` to `false` before writing a batch to `outbox/`** (its clip PCM is not kept, so the server must not reserve a clip for it; the server also refuses clips for events older than 10 min). Drop outbox files older than 36 h; the server rejects those anyway.
- On a 400 answer, log the error and drop that batch. A 401 means stop.
- Log counts per POST: received, stored, duplicates, dropped, rejected, uploads.

**Logging**
- Write to `~/sleep-lab-home/logs/night-sound.log`. Rotate at about 5 MB and keep 3 files. Python's `RotatingFileHandler` is fine.
- Log one line per state change (listening on/off with the reason) and one line per POST.
- At most one summary line per minute while listening, e.g. `23:41 avg -52 dB, snore 24 s, top Snoring/Breathing`.
- Never log the token, signed URLs (their `token` query is a credential) or audio.

**CLI flags**
- `--ping`: POST `{"ping":true}` and print the person.
- `--status`: GET once and print `listen`, `reason`, `from`, `until`, `night` and `clipsLeft`.
- `--dry-run FILE.wav`: classify a local file and print per-frame top 3 classes, dB and the minute summary JSON. It never POSTs or uploads anything.
- `--dry-run-live SECONDS`: read the go2rtc RTSP audio (same ffmpeg command as the daemon) for that many seconds, ignoring the backend's `listen`, and print per-frame dB and top 3 classes. It never POSTs, never uploads and never writes audio (no clips, no outbox); ffmpeg is stopped when the time is up.
- No flag: the daemon.

## 4. LaunchAgent `com.sleeplab.night-sound`

- Path: `~/Library/LaunchAgents/com.sleeplab.night-sound.plist`.
  - `ProgramArguments`: the venv's python + `listener.py`;
  - `WorkingDirectory`: `~/sleep-lab-home/night-sound`;
  - `RunAtLoad` true, `KeepAlive` true, `ThrottleInterval` 30;
  - `StandardOutPath`/`StandardErrorPath`: `~/sleep-lab-home/logs/night-sound.out.log` / `.err.log`;
  - `ProcessType` `Background`, `LowPriorityIO` true;
  - an `EnvironmentVariables` PATH that includes `/opt/homebrew/bin`.
- **The token is not in the plist.** The script reads the token file.
- Load it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sleeplab.night-sound.plist`, then check with `launchctl print gui/$(id -u)/com.sleeplab.night-sound | head -30`.
- Make sure the Mac doesn't sleep at night (`pmset -g`). If needed, keep it awake while on power with `sudo pmset -c sleep 0`, but ask me before changing power settings.

## 5. Test before reporting

1. `listener.py --ping` prints `person: b` (or `a`).
2. `listener.py --status` prints the decision. During the day it should say something like `Off — starts 21:45`. If it already says `listen: true`, check the window with me first.
3. Dry run, no network:
   - generate a 30 s test WAV in `tmp/`, e.g. bursts of low-passed brown noise:
     `ffmpeg -f lavfi -i "anoisesrc=d=30:c=brown:r=16000:a=0.5,volume='if(lt(mod(t,4),1.5),1,0.05)':eval=frame,lowpass=f=600" -ac 1 -ar 16000 tmp/test.wav`;
   - or, better, download a short Creative-Commons snoring recording (e.g. from Wikimedia Commons or freesound with an attribution-free license) and convert it to 16 kHz mono WAV;
   - run `listener.py --dry-run tmp/test.wav` and show me the per-frame top classes for ~10 frames and the minute JSON;
   - then **delete the test files**.
4. Real stream, briefly, without posting: run `listener.py --dry-run-live 30`. It must not post and must not write audio. That confirms the RTSP audio path works.
5. Check `ls ~/sleep-lab-home/night-sound/tmp` is empty and nothing audio-like was written (`find ~/sleep-lab-home -newer <start marker> \( -name '*.wav' -o -name '*.m4a' -o -name '*.pcm' -o -name '*.raw' \)` returns nothing).
6. Leave the LaunchAgent running. Tonight it starts by itself at the window, and the server drops anything outside the window anyway.

Report back:
- what you found in step 0;
- the files created or changed;
- which jobs you stopped (with where their plists went);
- `funnel status` output (should be empty/off);
- `launchctl print` state for `com.sleeplab.night-sound` and `com.sleeplab.go2rtc`;
- the ping and status results;
- the dry-run output.

Tomorrow morning, also paste the first minute summary line from tonight's log and one POST result line.

## Turn it all off

- Stop listening for a night: Sleep Lab › Live → "Pause tonight", or System › Camera → Listening: Off. The Mac's next GET gets `listen:false` and ffmpeg stops within 60 s.
- Stop the listener on the Mac: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.sleeplab.night-sound.plist`, and move the plist to `~/sleep-lab-home/retired/` so it stays off after a reboot.
- Revoke its access: rotate the presence token in Sleep Lab › System › Presence. Note that this also breaks the phones' Shortcut and OwnTracks until the new token is pasted there.
- Stop the camera feed entirely: `launchctl bootout gui/$(id -u)/com.sleeplab.go2rtc`, or unplug the camera.
- Clips older than 14 days are removed by the backend automatically, checked at most once an hour whenever the night-sound function is called (the listener's GET every 60 s does that, even while not listening). With the listener booted out for good, nothing calls it, so old clips stay until it runs again: before you stop it for good, leave it running (paused is fine) for 14 days after the last clip, or ask me to remove them.
