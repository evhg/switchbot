Paste everything below the line into the Claude Code session on Erik's Mac.

---

The night listener is running again (thanks). But the new breathing-rhythm snore rule is giving false alarms. From 21:49 to 21:58 tonight both of us were awake and quiet, yet it posted snoreS of 15–59 seconds per minute. YAMNet called every one of those minutes "Silence", and the level was a steady −64.7 dBFS against a floor of about −67. So it is counting the aircon or room noise's small regular ripples as snoring. Tighten it without a long restart gap:

1. Only let the rhythm rule count a second as snoring when ALL of these hold:
   - Peaks are at least 10 dB above the 10-minute floor (was 6 dB), and the peak level is also at least 4 dB above that minute's average.
   - The peaks are in the snore band: energy at 80–500 Hz is at least 2× the energy at 1–4 kHz during the peak, measured on the raw (un-boosted) audio.
   - There are 4 or more such peaks in 30 s, 2.5–7 s apart, with a coefficient of variation under 0.3.
   - YAMNet's top class at the peak is Snoring, Snort, Breathing, Gasp, Wheeze, Grunt, Roar, Growling, Animal, Wild animals, Owl, Hoot, Whale vocalization or Stomach rumble. "Silence" and "Inside, small room" are no longer accepted.
   - A YAMNet Snoring score of at least 0.2 on the boosted audio still counts on its own, as before.
2. Add a per-night baseline. During the first 10 minutes after listening starts (people are usually still awake), measure the false-positive rate of the rhythm rule. If it would have flagged more than 10 % of those seconds, raise the peak threshold by 3 dB, and repeat up to 2 times. Log the final thresholds once ("calibrated: peak +13 dB").
3. Quick check: re-run the analysis on the last 10 minutes of live audio with `--dry-run-live 600`. Or, if you kept no audio, run a 3-minute `--dry-run-live 180` right now while the room is quiet. snoreS should be close to 0 for every minute. Then run your snoring test file again: it should still find most of the snoring.
4. Restart the LaunchAgent. Report the before/after numbers. Never print the token.
