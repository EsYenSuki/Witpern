# PoseTrack

A static, client-side automatic push-up counter.

## Run it

Camera access requires `https` or `localhost`. From this folder:

```bash
git clone https://github.com/EsYenSuki/Witpern.git Witpern
cd Witpern
python3 -m http.server 8000
```

Then open <http://localhost:8000> and allow camera access.

The camera starts automatically when the page opens. Camera controls are available under the video:

- **Open camera / Camera open** — starts or shows the camera state.
- **Close camera** — stops the camera track and resets the counter.
- **Front / Back** — switches camera direction and restarts the camera if it is open.

## Raw dots, export and import

In the push-up counter card:

- **Capture dots** saves a snapshot of the current 33 raw landmark positions (`x`, `y`, `z`, `visibility`). Up to 20 snapshots are kept.
- Saved snapshots appear in a list with checkboxes. Use **Select all / Select none** and **Download selected** to download only the captures you choose.
- **Download contents** selects other data groups the exported JSON file contains:
  - All data
  - Calibration (fixed threshold values)
  - Reps
  - Latest dots
  - Captured dots
  - Recent dot frames
- **Export** downloads the selected JSON file.
- **Import** loads a previous PoseTrack JSON file. Imported dots and snapshots are restored for further export; the rep count is restored if present.

## Sending dots to your server (ngrok)

The counter can post dot data to your own server while you exercise:

1. In `server/`, run `node server.js`. No npm install needed.
2. In another terminal, run `ngrok http 8787` (or your configured `PORT`). Cloudflare Tunnel works too — see `server/README.md`.
3. On the page, paste the ngrok URL with `/collect` appended, e.g.
   `https://your-name.ngrok-free.app/collect`, into **Send dots to server → Server URL**.
4. Tick **Enabled** (or press **Test send** to check it). The URL is saved in browser storage.

Exactly two events are sent per push-up: `push_down` with `value: 1` when the bottom pose is
reached, and `push_up` with `value: 1` when the top pose finishes the rep. Each event includes all
33 dot positions, the elapsed rep count, and the current metrics and threshold values. If a send
fails, the event is queued and can be retried with **Retry queued**.

The collector stores events as JSON arrays in `server/data/dots-YYYY-MM-DD.json`, with the newest
event in `server/data/latest.json`. `POST /collect` needs no login; viewing the data pages requires
the username/password from `server/.env` (see `.env.example`). See `server/README.md` for details.

## How it works

No calibration is needed. The counter uses fixed thresholds derived from sample pose data:

1. The page opens the camera automatically.
2. Counting is enabled when ears, shoulders, elbows, wrists and hips are all visible, and the body is in a push-up stance: head level with shoulders, hips level with shoulders, and both hands below the hips in the frame. This blocks standing or raised poses from counting.
3. **Elbow angle** (shoulder–elbow–wrist) is the primary signal, averaged across both arms:
   - **DOWN** — average angle ≤ 155°
   - **UP** — average angle ≥ 163°
   - The 156–162° gap is a deadband so jitter cannot flip states.
4. **Wrist-to-ear proximity** (distance from each wrist to the ear midpoint, divided by shoulder width) is a confirmation signal:
   - **DOWN** — proximity ≤ 1.90
   - **UP** — proximity ≥ 1.80
5. **Mirror check** — the left and right elbow angles must differ by no more than 70°, since the front-view camera sees both arms symmetrically.
6. **Hands-below-hips** — both wrists must sit below the hip line in the image (average `wrist.y − hip.y > 0.03`). This replaces the old torso-ratio gate and does not reject valid push-up stances.
7. A rep is counted when the body holds the **DOWN** pose for 100 ms (arming the rep), then returns to and holds the **UP** pose for 100 ms. A 200 ms minimum gap between reps prevents double counts.
8. A 5-frame **grace period** keeps the current state through brief wrist dropouts instead of immediately resetting.

The overlay shows:
- arm bones drawn shoulder→elbow→wrist, colored by angle zone (green = down, cyan = up, amber = between)
- elbow angle in degrees at each elbow
- dashed line from ear midpoint to each wrist, colored by proximity zone
- proximity value and mirror check status near the ear

## Notes

- No backend, no build step, no package install.
- Plain HTML, CSS, JavaScript, and CDN-loaded MediaPipe Pose.
- Video frames are processed in the browser and are not uploaded.
- Phones use the lighter pose model and default to the back camera.
- An internet connection is needed to load the MediaPipe model files the first time.
