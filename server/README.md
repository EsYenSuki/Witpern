# PoseTrack dot collector

Tiny Node.js server (no npm install) that receives push-up dot events and writes them to JSON files.

## Run

```bash
cd server
node server.js
```

It listens on port `8787` by default. Settings come from `server/.env` (already created); shell
environment variables override the file. Copy `.env.example` if you need to recreate it. `.env`
is gitignored.

## Login for data pages

`POST /collect` is deliberately open so the browser can send dots without credentials. Viewing the
data requires HTTP Basic auth:

- Pages: `/`, `/data`, `/data/dots-YYYY-MM-DD.json`
- Username / password: `COLLECT_USER` / `COLLECT_PASS` in `server/.env`
- Open the URL in a browser and enter the credentials in the browser prompt.

`/health` stays open for tunnel checks. If either credential is missing from `.env`, auth is
disabled and a warning is printed at startup.

Start ngrok in another terminal:

```bash
ngrok http 8787
```

Copy the `https://...ngrok-free.app` URL, append `/collect`, and paste the full URL into
**Send dots to server → Server URL** on the PoseTrack page. Tick **Enabled**.
Use **Test send** to confirm the event appears in the server log.

The ngrok URL changes when ngrok restarts, so update the page URL if that happens. It is saved in
your browser's local storage, so you only need to enter it again when it changes.

## Cloudflare Tunnel instead of ngrok

No server change is needed. Install `cloudflared` first:
<https://developers.cloudflare.com/tunnel/downloads/>.

### Quick test (no Cloudflare account or domain)

```bash
cloudflared tunnel --url http://localhost:8787
```

Copy the printed `https://something.trycloudflare.com` URL, append `/collect`, and paste it into
the page. This URL changes every time you restart `cloudflared`, so it behaves like a free ngrok
URL. Quick Tunnels are intended for testing only. The current URL is also stored as
`CLOUDFLARE_URL` in `.env`; the server prints the full POST URL at startup and shows it on its
index page. Update that value when the tunnel URL changes.

### Stable URL with your own domain

Requires a domain added to Cloudflare. One-time setup:

```bash
cloudflared tunnel login
cloudflared tunnel create posetrack-dots
cloudflared tunnel route dns posetrack-dots dots.example.com
```

Create `~/.cloudflared/config.yml` (replace the tunnel ID and credentials path with the values
printed by `cloudflared tunnel create`):

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /home/YOUR_USER/.cloudflared/YOUR_TUNNEL_ID.json
ingress:
  - hostname: dots.example.com
    service: http://localhost:8787
  - service: http_status:404
```

Then start it, with the collector already running:

```bash
cloudflared tunnel run posetrack-dots
```

Use `https://dots.example.com/collect` on the PoseTrack page. The hostname stays the same after
restarts. Check `cloudflared tunnel info posetrack-dots` if it does not connect.

Do not enable Cloudflare Access email OTP on this hostname: that flow needs an interactive browser
login, while the page posts in the background with `fetch`.

## Endpoints

| Request | What it does |
| --- | --- |
| `POST /collect` | Saves one JSON event |
| `GET /` | Simple file listing page |
| `GET /data` | Lists JSON files and event counts |
| `GET /data/dots-YYYY-MM-DD.json` | Returns one day's events |
| `GET /health` | Health check |

## What gets saved

Each POST is appended to `server/data/dots-YYYY-MM-DD.json` as an array of events. The newest
event is also written to `server/data/latest.json`. These files are gitignored.

The page sends exactly two events per push-up: `push_down` with `value: 1` when the bottom pose
is reached, and `push_up` with `value: 1` when the top pose completes the rep. Both events carry
the 33 MediaPipe dot positions plus calibration values and count state.

Example event:

```json
{
  "format": "posetrack-dot-events",
  "version": 1,
  "event": "push_down",
  "value": 1,
  "sessionId": "0e6d...",
  "sentAt": "2026-11-24T12:00:00.000Z",
  "repCount": 1,
  "calibration": {
    "downAngle": 92.4,
    "upAngle": 158.1,
    "downReach": 0.91,
    "upReach": 0.97
  },
  "dotCount": 33,
  "dots": [
    { "index": 0, "x": 0.51, "y": 0.12, "z": -0.02, "visibility": 0.99 }
  ],
  "id": "9a1c...",
  "receivedAt": "2026-11-24T12:00:00.120Z"
}
```

## Notes

- CORS is open (`*`) so a page on `localhost` can post to the ngrok URL.
- Request bodies are capped at 1 MB (`MAX_BODY_BYTES` to change).
- Failed sends stay queued in the page (up to 50) and can be retried with **Retry queued**.
