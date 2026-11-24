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

## Tracking options

- **Disable calibration** — skips the DOWN/UP calibration and starts counting immediately with fixed default thresholds. Turning it back on resets the counter and returns to calibration mode.

## Raw dots, export and import

In the push-up counter card:

- **Capture dots** saves a snapshot of the current 33 raw landmark positions (`x`, `y`, `z`, `visibility`). Up to 20 snapshots are kept.
- Saved snapshots appear in a list with checkboxes. Use **Select all / Select none** and **Download selected** to download only the captures you choose.
- **Download contents** selects other data groups the exported JSON file contains:
  - All data
  - Calibration
  - Reps
  - Latest dots
  - Captured dots
  - Recent dot frames
- **Export** downloads the selected JSON file.
- **Import** loads a previous PoseTrack JSON file. Imported calibration restores counting immediately; imported dots and snapshots are restored for further export.

## How it works

1. The page opens the camera automatically.
2. Counting is enabled when head, shoulders, elbows, wrists and hips are visible. Feet/ankles are not used.
3. A large message on the camera tells you **GO DOWN FIRST**. Hold the bottom position for 5 seconds.
4. DOWN calibration saves your own:
   - bent elbow angle
   - shoulder-to-hand reach, measured as a fraction of arm length
5. The message changes to **NOW GO UP**. Straighten your arms and hold for 5 seconds.
6. UP calibration saves your own straight-arm angle and reach.
7. The two saved poses set the counting zones for your body:
   - angle bend zone = your calibrated DOWN angle, with a ±5° deadband
   - threshold circle = 20% of the way from your down reach to your up reach, so the circle stays smaller and closer to the hand at the bottom pose
8. The dashed threshold circle is drawn at each **hand**. Going down brings the shoulder inside the hand circle.
9. While the shoulder is inside the circle, both elbows must reach `down angle − 5°` to set the **bend pass**. Moving down alone does not set it.
10. Straightening both elbows to `down angle + 5°` sets the **angle pass**. Holding between those two values does not count.
11. Pushing back up until both shoulders leave the circles sets the **circle pass**.
12. When **angle pass + circle pass** are both set, **one push-up is counted** and all passes reset. A short hold and gap timer prevent accidental double counts.

The starting pose detection uses values measured from the sample captures in `data/`: down is detected around `145°`/`0.965` reach, and up around `155°`/`0.97` reach. Those are only starting hints; after calibration the app uses your saved values instead.

The overlay shows:
- dashed cyan circle at each **hand** as soon as the body is detected
- after DOWN calibration, the circle uses your saved down reach
- after UP calibration, the circle becomes your final threshold
- green circle and hand dot — shoulder is inside the hand circle
- live elbow angle label near each elbow
- bend, angle, and circle pass state in the counter panel

## Notes

- No backend, no build step, no package install.
- Plain HTML, CSS, JavaScript, and CDN-loaded MediaPipe Pose.
- Video frames are processed in the browser and are not uploaded.
- Phones use the lighter pose model and default to the back camera.
- An internet connection is needed to load the MediaPipe model files the first time.
