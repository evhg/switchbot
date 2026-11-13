Paste everything below the line into the Claude Code session on Erik's Mac.

---

The Pan/Tilt Cam is moving from the bedside table to the **villa's front entrance door**. Its microphone is too weak to hear snoring, so it now watches who comes and goes. Cath and Erik want the live stream on, and a notification in the Jarvis app whenever someone enters or leaves.

Safety rules:
- Never print, echo, log or commit any token. Reuse the existing token files.
- No video or images are stored on disk, except enrolled face embeddings already kept from before. Ask before deleting anything.
- Inspect before you change anything, and tell me what you found.

## 1. Database (through your Supabase connector)

Apply `supabase/migrations/0039_entrance_camera.sql` from branch `claude/determined-ride-59txro` of evhg/switchbot to project **vaelokyqjdsxveqvdtbo** (never udvtuxaxzfimeoubofdz). It:
- turns the night listener off (`sound_mode = 'off'`) and the live video on (`live_video = true`);
- adds a trigger on `camera_events`: every new sighting from camera `entrance` pushes "Erik at the front door (18:42) · Arriving / Leaving / Seen at the entrance", or "Someone at the front door" for an unknown face or a person without a face. At most one notice per person per 10 minutes.

Run it as written: it has no DROP or DELETE. Report success.

## 2. Night listener

With `sound_mode = 'off'` the listener idles by itself. Leave its LaunchAgent loaded; it only polls. Confirm with `--status` that it says it isn't listening.

## 3. Bring back the stream gate and face recognition (retired on 4 Nov)

They were moved to `~/sleep-lab-home/retired/` when the camera went to the bedroom.
- **Ticket gate** (`com.sleeplab.ticket-gate`): move its plist back to ~/Library/LaunchAgents and load it. Check that Tailscale Funnel points at 1985 (`tailscale funnel status`). The app's Live tab then shows the entrance stream once signed in.
- **Face recognition / activity job**: move it back and adapt it.
  - Camera name **`entrance`** in every POST to `…/functions/v1/camera-event`. The contract is unchanged: `X-Presence-Token`, `{"camera":"entrance","events":[{"ts","label","confidence","activity","durationS"}]}`. `label` is `a` (Cath), `b` (Erik), `unknown` (a face that matched nobody) or `person` (a body, no face).
  - **Direction**: set `activity` to `arrive` or `leave`. Use the person's track across the frame: towards the door from outside = `arrive`, away from the door towards outside = `leave`. If you can't tell, leave it null. Tell me which side of the frame is inside once the camera is mounted; until then, null is fine.
  - **One event per pass**, not per frame: merge a track into a single event with its duration. The server rate-limits to one push per person per 10 minutes anyway.
  - Re-enrol Cath and Erik if the old embeddings came from the living-room angle and the new view matches poorly. Ask Cath to walk past once each.
  - It reads go2rtc's stream locally (127.0.0.1:1984), as before.
- Run a test: walk past the door, check the POST answer and that a row with `camera = 'entrance'` appears.

## 4. Camera reboots

The camera rebooted every ~650 s in the bedroom. Check whether that continues at the entrance (port/ping watch, 30 min). If it does, the stream and the face job will have gaps every 11 minutes: report it, and suggest the SwitchBot firmware update or support ticket.

## 5. Report

Report to Cath: the migration result, which jobs are running (`launchctl list | grep sleeplab`), the test sighting, and whether the reboots persist.
