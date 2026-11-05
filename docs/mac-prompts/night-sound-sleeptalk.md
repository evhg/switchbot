Paste everything below the line into the Claude Code session on Erik's Mac.

---

We'd like to know what we say in our sleep. Both of us have agreed to this. The Sleep Lab backend now accepts clips of **talking** from the night listener (`~/sleep-lab-home/night-sound/listener.py`), each with a transcript made **here on the Mac**. The next morning the backend checks each one against our Fitbit sleep stages. If at least one of us was asleep, it's sleep talk and is kept. If we were both awake, it was a conversation, and the backend deletes the clip and the transcript.

Until now the rule was "speech is never clipped". That changes. **The server is now the authority on whether a speech clip is allowed.** You may ask for a clip for every speech event. The server only hands out an upload URL when the household's "Save sleep talk" setting is on and the night's speech allowance (20) isn't used up.

Safety rules. These still apply to every step:
- **Never print, echo, log or commit the token.** It stays in its 0600 file.
- **Speech audio goes only to the signed upload URL the server returns.** Never send audio or transcripts to any other service. Transcription runs locally with mlx-whisper: no cloud API, no OpenAI key, no network during transcription. The model weights are downloaded once from Hugging Face; that is the only download.
- **No audio is kept on disk.** Clip files live in the 0700 `tmp/` folder only until they are uploaded, and are deleted afterwards whether or not the upload worked. **Never log transcripts.** Log only their length and language, e.g. `transcript 42 chars nl`.
- Inspect before you change anything, and tell me what you found.

## 0. Inspect first

- Show me how `listener.py` handles speech today: the speech run detection, where `wantClip` is set to false for speech, the "drop the clip if any frame in its window is speech" check, the clip cutting (pre-roll, length, ffmpeg encode), and the automatic input gain applied before classification (night-sound-fix-1).
- `uname -m` (must be `arm64`), the venv's Python version, and free disk space (the large model is about 1.6 GB).
- Run `--status` once and show me the GET answer. After the backend update it has two new fields: `"sleepTalk": true` (speech clips are allowed) and `"speechClipsLeft": 20`.

## 1. Install mlx-whisper

- `~/sleep-lab-home/night-sound/.venv/bin/pip install mlx-whisper`. It needs ffmpeg, which is already installed.
- Model: `mlx-community/whisper-large-v3-turbo`. Download it once and time a transcription of a 10 s clip (step 4). If that takes more than about 8 s on this Mac, or uses more than about 3 GB of memory, switch to `mlx-community/whisper-small-mlx` and tell me.
- Load the model **lazily** on the first speech clip of a night, keep it loaded while listening, and release it when `listen` turns false. The YAMNet path must never wait on Whisper.

## 2. Speech clips

GET answer, example:
```json
{"listen":true,"reason":"Listening until 09:00","from":"2026-11-04T14:45:00.000Z","until":"2026-11-05T02:00:00.000Z",
 "clips":true,"clipsLeft":40,"sleepTalk":true,"speechClipsLeft":20,"night":"2026-11-05","now":"2026-11-04T18:02:10.000Z"}
```

- **Speech events.** Keep the existing detection (a run of ≥ 2 frames with speech score ≥ 0.5, merged within 5 s). This now also covers events with a speech-set label reported as `loud` (e.g. `Shout`). Treat those as speech clips too.
- **wantClip.** Set `wantClip: true` for a speech event when GET said `sleepTalk: true` and your local count still allows it, using `speechClipsLeft`. Otherwise send `false`. If GET has no `sleepTalk` field (old backend), send `false`. The server decides either way: it simply returns no upload for a speech event it won't take.
- **Spacing.** Allow at most one speech clip per 60 s. A long run is a single clip.
- **Cut the whole speech run.** Use a 2 s pre-roll before the run's first speech frame and 1 s after its last. Cap the clip at **30 s** (the upload's `maxS` says so: 30 for speech, 10 for everything else). For a run longer than 30 s, keep the first 30 s. Because the run's end decides the clip, a speech event is posted when its run ends, or at 30 s, whichever comes first. Keep enough ring buffer for that (≥ 35 s).
- **Exempt speech clips from the speech-frame check.** The rule "drop the clip if any frame in its window is speech" stays for **non-speech** clips (snore, cough, loud with a non-speech label, other). A snore clip with talking in it is still dropped. Speech clips are exempt, because talking is their point.
- **Encode as before**: AAC in m4a, mono 16 kHz, 48 kbps. 30 s is about 180 KB, well under the 1 MB limit. Upload with `PUT <signedUrl>`, `Content-Type: audio/mp4`, then delete the file.
- **Keep the "speech never clipped" behaviour only as the server's answer.** No upload for a speech event means no clip: discard its audio from memory, don't retry, don't keep it. The outbox rule stays: every event written to `outbox/` gets `wantClip: false`, and its transcript is kept, since the transcript is text.

## 3. Transcribe before posting

For every speech event with a cut clip, transcribe it **before** the POST, so the event carries its transcript:

- Input: the same PCM that went into the clip (16 kHz mono float32). Apply the same automatic input gain as the classifier path (floor to about −50 dBFS, cap +36 dB, soft limiter), because whispers and mumbles are quiet. The gain affects only what Whisper hears; the uploaded clip keeps its raw level.
- Call it like this:
  `mlx_whisper.transcribe(audio_np, path_or_hf_repo=MODEL, language=None, task="transcribe", condition_on_previous_text=False, no_speech_threshold=0.6, temperature=(0.0, 0.2, 0.4), word_timestamps=False)`
  - `language=None` auto-detects the language. We speak English and Dutch, maybe Thai.
  - Use `task="transcribe"`, **not** translate: keep the words as they were said.
- `transcript` = the result's `text`, stripped, with whitespace collapsed, at most 2000 characters. Drop it (send no `transcript` field) when:
  - it's empty;
  - every segment has `no_speech_prob` > 0.6;
  - it's a known Whisper hallucination on silence: "Thank you.", "Thanks for watching!", "Bedankt voor het kijken", "Ondertiteld door …", "you", "…". Compare case-insensitively after stripping punctuation.
- `transcriptLang` = the result's `language` ("en", "nl", "th"), at most 10 characters.
- **If transcription fails or takes longer than 20 s**, post the event without `transcript`. Still upload the clip if the server gave a URL. Log only `transcription failed: <error type>`.
- Transcription runs in a worker thread, so the audio reader and classifier never block. Post the event when its transcript is ready or has failed. Minutes are posted as usual.

**Exact POST example with a transcript** (the server stores `transcript` and `transcriptLang` only for speech events and only while "Save sleep talk" is on; otherwise it silently drops them):
```json
{"camera":"bedroom",
 "minutes":[],
 "events":[
   {"ts":"2026-11-04T18:12:03.200Z","durationS":7.4,"kind":"speech","label":"Speech","peakDb":-38.2,"score":0.66,
    "wantClip":true,"transcript":"No, the blue one. Put it with the others.","transcriptLang":"en"}]}
```
Answer:
```json
{"ok":true,"person":"b","received":{"minutes":0,"events":1},"stored":{"minutes":0,"events":1},
 "duplicates":{"minutes":0,"events":0},"dropped":{"outsideWindow":0,"notListening":0},"rejected":[],
 "uploads":[{"index":0,"path":"2026-11-05/20261104T181203.200Z_speech.m4a","signedUrl":"https://…","token":"…","maxS":30}],
 "listen":true,"sleepTalk":true}
```
Then PUT the m4a (the speech run, up to 30 s) to that `signedUrl`.

Event row uniqueness is `(camera, ts, kind)`, and a re-posted event is ignored rather than updated. So send the transcript in the **first** POST of the event, never in a later one.

## 4. Test, then report

1. **Sample clip.** Record yourself saying a sentence in English and one in Dutch with `ffmpeg -f avfoundation -i ":0" -t 8 -ar 16000 -ac 1 /tmp/claude-test-speech.wav`, or ask me to say something. Run the transcription function on it and print the transcript, the language and the time it took. Do it once with large-v3-turbo; if that is too slow, once with small. Delete the wav afterwards.
2. **Dry run**: `--dry-run-live 120` while I talk quietly near the camera for a bit. It should print a speech event with its clip span (pre-roll, length), the transcript length and language. Nothing is posted or uploaded in a dry run.
3. **Backend check** (only inside tonight's listen window, otherwise the server drops it): let the daemon run during the window and talk briefly. Check the log for `uploads` with `maxS: 30` and a successful PUT. The app shows it under Live › Latest moments with the transcript.
4. **Rules check**:
   - a snore clip with talking inside its window is still dropped;
   - with "Save sleep talk" off in the app (System › Camera), GET says `sleepTalk: false` and no speech clip is requested;
   - grep the log to show no transcript text was ever logged.
5. Restart: `launchctl kickstart -k gui/$(id -u)/com.sleeplab.night-sound`.

Report back:
- the model you chose and its timing on the sample;
- the diff summary of `listener.py`;
- the test results;
- the memory use of the listener while Whisper is loaded (`ps -o rss= -p <pid>`);
- anything you couldn't do.
