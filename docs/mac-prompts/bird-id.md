Paste everything below the line into the Claude Code session on Erik's Mac.

---

We want to know **which bird** makes the bird sounds in the night clips (Cath labelled the 04:13 clip of 5 Nov "bird"). Add a small **bird ID job** next to the night listener: once a day it fetches the clips it hasn't checked yet, runs **BirdNET** (Cornell's bird-call model) on each, and reports the species back. The app then shows the bird's name and a photo under the clip. The server side is live.

Safety rules. These still apply:
- **Never print, echo, log or commit the token.** Reuse the night listener's token file (`~/sleep-lab-home/night-sound/token`, 0600), read it in the script.
- Clips go to a 0700 temp folder only while being analysed, then are deleted (also after an error). Keep no audio.
- Don't touch the night listener itself (`listener.py`, its LaunchAgent). This is a separate script and a separate LaunchAgent.
- Inspect before you change anything, and tell me what you found.

## 1. The server contract

Base URL: `https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/bird-id`. Header `X-Presence-Token: <token>` on every request.

- `GET ?days=3` → `{"location": {"lat": 7.89, "lon": 98.3}, "clips": [{"id": 426, "ts": "2026-11-04T21:13:15Z", "label": "Music", "url": "https://…signed…m4a"}]}`
  Clips with no bird check yet, newest first, at most 50; the URLs work for 1 hour.
- `POST {"results": [{"id": 426, "species": "Eudynamys scolopaceus", "common": "Asian Koel", "confidence": 0.87}, {"id": 427, "none": true}]}` → `{"ok": true, "stored": 2}`
  Send **one result per clip you checked**, with `"none": true` when BirdNET found no bird above the threshold, so it isn't sent again. `species` is the scientific name, `common` the English name, `confidence` 0–1.
- 401 = token wrong or rotated: log "unauthorized" (not the token) and stop.

## 2. The job

- New folder `~/sleep-lab-home/bird-id/` with its own venv: `python3 -m venv .venv && .venv/bin/pip install birdnetlib librosa resampy`. birdnetlib pulls TensorFlow Lite; if `tflite-runtime` won't install on this Mac, use `tensorflow` (Apple Silicon: `tensorflow-macos`) as birdnetlib's docs say. ffmpeg is already installed (needed for .m4a).
- `bird_id.py`:
  1. GET the clips.
  2. For each: download to the temp folder, run `birdnetlib.Recording(analyzer, path, lat=7.89, lon=98.3, date=<the clip's date>, min_conf=0.25)` with one shared `Analyzer()`, then `recording.analyze()`.
  3. Take the detection with the highest confidence. If its confidence ≥ 0.25: `{"id", "species": scientific_name, "common": common_name, "confidence"}`; otherwise `{"id", "none": true}`.
  4. Delete the file. POST all results in one request at the end (or every 20 clips).
  5. Log one line per run: `checked N clips, M birds` (no URLs, no token).
  - The clips are very quiet (peaks around −40 to −65 dBFS). If BirdNET finds nothing at all on a first run, try normalising each clip to −1 dBFS peak before analysing (load with librosa, scale, write a temp .wav) and tell me whether that changed anything.
- Run it once by hand and show me the log line and the POST answer. Clip 426 (5 Nov, 04:13, Cath heard a bird) should be in the first batch if it is within `days`; use `?days=14` for the first run.
- LaunchAgent `com.sleeplab.bird-id`, `StartCalendarInterval` at 10:30 every day (after the night listener stops at wake + 30 min), `ProcessType Background`, logs to `~/sleep-lab-home/bird-id/bird-id.log`. Load it and show me `launchctl list | grep bird`.

## 3. Tell me

- What birds it found on the first run (common names + confidence), and whether clip 426 got a species.
- How long one run takes.
