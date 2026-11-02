Paste everything below the line into the Claude Code session on Erik's Mac.

---

Add a sign-in gate in front of the Sleep Lab camera stream on this Mac. The goal: the public Tailscale Funnel link only serves the stream to someone who is signed in to sleep.cathnivore.com. The app now gets a signed 12-hour ticket and embeds the stream at `https://<funnel host>/<secret>/t/<ticket>/stream.html?src=…`. Today Funnel points straight at go2rtc on port 1984, under the base path `/<secret>`, which you can find in ~/sleep-lab-home and go2rtc.yaml. After this change, Funnel points at the gate.

Ticket format. Verify exactly this:
- `ticket = part1 + "." + part2`, both base64url without padding.
- `part1` decodes to the JSON `{"sub":"<uuid>","iat":<s>,"exp":<s>,"aud":"camera"}`.
- `part2` is a 64-byte pure Ed25519 signature over the ASCII bytes of `part1`, exactly as received.
- The public key is the `publicKey` field from `GET https://vaelokyqjdsxveqvdtbo.supabase.co/functions/v1/camera-ticket`: base64url of the raw 32 bytes. That call needs no auth. Fetch it at startup and cache it on disk. Re-fetch at most once an hour if verification of a well-formed ticket fails, in case the key rotates.

What the gate does:
1. It listens on 127.0.0.1:1985.
2. It accepts only paths of the form `/<secret>/t/<ticket>/<rest>`. It URL-decodes `<ticket>` and verifies it:
   - the ticket is at most 1024 chars, has two parts, and each part matches `[A-Za-z0-9_-]+`;
   - the signature is valid;
   - `aud` is `"camera"`, `exp` is later than now, and `iat` is no more than now + 300 s.
3. On success it proxies to `http://127.0.0.1:1984/<secret>/<rest>?<query>`, never forwarding the ticket. That includes WebSocket upgrades (go2rtc's player uses `api/ws`) and streamed responses (MSE/HLS), with no buffering.
4. Anything else gets a 403 with no detail. That includes the old `/<secret>/stream.html` link without a ticket and requests to `/`.
5. It logs one line per request: time, path without the ticket, status. It never logs the ticket.

Use what's already on this Mac: Node, if `node -v` works, with only built-in modules (`crypto.verify` supports Ed25519, and http plus the upgrade event handles WebSockets). Otherwise use Python 3 with `cryptography`. Put it in `~/sleep-lab-home/ticket-gate/` with a LaunchAgent `com.sleeplab.ticket-gate` (KeepAlive, RunAtLoad, logs in ~/sleep-lab-home/logs/). Then:
- run `/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 1985` so the public link goes to the gate instead of 1984;
- update `rotate-link.sh` and any notes that mention `funnel --bg 1984`.

Leave go2rtc itself on 1984 and reachable locally. The face-recognition and Wi-Fi presence jobs keep using it directly.

Test before reporting:
- the old link `https://<host>/<secret>/stream.html` → 403;
- a made-up ticket → 403;
- a ticket with its last character changed → 403.
For a positive test, ask me for a ticket: I'll copy it from the browser after switching on "Require sign-in for the stream" in Sleep Lab › System › Camera. Or confirm with me that the Live tab plays once I've switched it on.

Report: the files created, the LaunchAgent status, the Funnel status, the test results, and a command to turn the gate off again (point Funnel back at 1984).
