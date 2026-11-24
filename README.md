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

A **Down probability** bar under the video fills as your average elbow angle moves from the UP threshold toward the DOWN threshold (0% at ≥152°, 100% at ≤125°). It is smoothed frame to frame and resets when tracking is lost or the camera closes.

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

No calibration is needed. The counter uses fixed thresholds derived from sample pose data. Angles and proximity are smoothed frame to frame before these checks run:

1. The page opens the camera automatically.
2. Counting is enabled when the head, shoulders, elbows and wrists are visible, and the body is in a push-up stance: head level with shoulders, not standing upright, and hands near or below hip level. The hip may be briefly occluded at the bottom of a rep.
3. **Elbow angle** (shoulder–elbow–wrist) is the primary signal, averaged across both visible arms. The DOWN and UP tests are mutually exclusive:
   - **DOWN** — average angle ≤ 125°, or ≤ 118° on its own (unambiguous bend from a side/angled view)
   - **UP** — average angle ≥ 152°
   - The 125–152° band is a deadband, except for the unambiguous-bend and proximity cases below.
4. **Wrist-to-ear proximity** (distance from each wrist to the ear midpoint, divided by a stable body scale) confirms the angle:
   - **DOWN** — proximity ≤ 1.05 with angle ≤ 125°, or proximity ≤ 0.92 with angle ≤ 145° (tucked-elbow front push-up)
   - **UP** — proximity ≥ 1.15 with angle ≥ 152°, or proximity ≥ 1.0 with angle ≥ 162°
5. **Mirror check** — when both arms are visible, their elbow angles must differ by no more than 70°.
6. **Hands-below-hips** — the average wrist position must sit no more than 0.18 body-scale units above the hips. A torso-vertical ratio below 0.90 blocks standing poses from counting.
7. A rep is armed by holding the **DOWN** pose for 80 ms, then counted after returning to and holding the **UP** pose for 80 ms. A 250 ms minimum gap between reps prevents double counts.
8. An 850 ms time-based **grace period** preserves the current rep state through brief tracking dropouts; hips can stay occluded for up to 2500 ms while a rep is armed.

The overlay shows:
- arm bones drawn shoulder→elbow→wrist, colored by angle zone (green = down, cyan = up, amber = between)
- a large filled arc at each elbow spanning the measured shoulder–elbow–wrist angle, with a larger degree label beside it; both glow when the angle passes a DOWN or UP threshold
- dashed line from ear midpoint to each wrist, colored by proximity zone
- proximity value and mirror check status near the ear

## Notes

- No backend, no build step, no package install.
- Plain HTML, CSS, JavaScript, and CDN-loaded MediaPipe Pose.
- Video frames are processed in the browser and are not uploaded.
- Phones default to the back camera; the full pose model is used on all devices.
- An internet connection is needed to load the MediaPipe model files the first time.
