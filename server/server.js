"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { randomUUID, timingSafeEqual } = require("node:crypto");

function loadEnvFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Could not read ${filePath}: ${error.message}`);
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, ".env"));

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const rawDataDir = process.env.DATA_DIR || "data";
const DATA_DIR = path.isAbsolute(rawDataDir) ? rawDataDir : path.resolve(__dirname, rawDataDir);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const COLLECT_PATH = "/collect";
const COLLECT_USER = process.env.COLLECT_USER || "";
const COLLECT_PASS = process.env.COLLECT_PASS || "";
const CLOUDFLARE_URL = process.env.CLOUDFLARE_URL || "";
const AUTH_ENABLED = Boolean(COLLECT_USER && COLLECT_PASS);
const DAY_DIR_PATTERN = /^dots-(\d{4}-\d{2}-\d{2}|unknown)$/;
const LEGACY_FILE_PATTERN = /^dots-\d{4}-\d{2}-\d{2}\.json$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_FILE_PATTERN = /^([A-Za-z0-9_-]{1,128})\.json$/;
const UNKNOWN_SESSION = "unknown";

function publicCollectUrl() {
  const base = CLOUDFLARE_URL.replace(/\/+$/, "");
  return base ? `${base}/collect` : "";
}

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!AUTH_ENABLED) {
  console.warn("Warning: COLLECT_USER/COLLECT_PASS not set — data pages are open to anyone.");
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function isAuthorized(req) {
  if (!AUTH_ENABLED) return true;

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) return false;

  return (
    safeEqual(decoded.slice(0, separator), COLLECT_USER) &&
    safeEqual(decoded.slice(separator + 1), COLLECT_PASS)
  );
}

function requestLogin(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="PoseTrack data", charset="UTF-8"',
    "Content-Length": 0,
    ...CORS_HEADERS,
  });
  res.end();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character];
  });
}

let writeChain = Promise.resolve();

function dayFrom(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10);
}

function sessionFrom(record) {
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : UNKNOWN_SESSION;
}

function appendEvent(record) {
  const dayDir = `dots-${dayFrom(record.receivedAt)}`;
  const sessionName = sessionFrom(record);
  const file = path.join(DATA_DIR, dayDir, `${sessionName}.json`);
  const relativeName = `${dayDir}/${sessionName}.json`;

  const task = writeChain.catch(() => {}).then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    let events = [];
    try {
      const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
      if (Array.isArray(parsed)) events = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") console.warn(`Could not read ${file}: ${error.message}`);
    }

    events.push(record);
    const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.writeFile(tempFile, `${JSON.stringify(events, null, 2)}\n`, "utf8");
    await fsp.rename(tempFile, file);
    await fsp.writeFile(
      path.join(DATA_DIR, "latest.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    return relativeName;
  });

  writeChain = task.catch((error) => console.error(`Could not save event: ${error.message}`));
  return task;
}

async function describeDataFile(fullPath, name, sessionId = null) {
  const stat = await fsp.stat(fullPath);
  let events = 0;
  try {
    const parsed = JSON.parse(await fsp.readFile(fullPath, "utf8"));
    if (Array.isArray(parsed)) events = parsed.length;
  } catch {
    events = 0;
  }
  return {
    name,
    sessionId,
    events,
    bytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

async function listDataFiles() {
  const entries = await fsp.readdir(DATA_DIR, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isFile() && LEGACY_FILE_PATTERN.test(entry.name)) {
      files.push(await describeDataFile(path.join(DATA_DIR, entry.name), entry.name));
      continue;
    }
    if (!entry.isDirectory() || !DAY_DIR_PATTERN.test(entry.name)) continue;

    const dayDir = path.join(DATA_DIR, entry.name);
    const sessionEntries = await fsp.readdir(dayDir, { withFileTypes: true });
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isFile()) continue;
      const match = SESSION_FILE_PATTERN.exec(sessionEntry.name);
      if (!match) continue;
      files.push(
        await describeDataFile(
          path.join(dayDir, sessionEntry.name),
          `${entry.name}/${sessionEntry.name}`,
          match[1],
        ),
      );
    }
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function dataFilePath(name) {
  const segments = name.split("/");
  let relative;

  if (segments.length === 1) {
    const file = segments[0];
    if (!file || file !== path.basename(file) || !file.endsWith(".json")) return null;
    relative = [file];
  } else if (
    segments.length === 2 &&
    DAY_DIR_PATTERN.test(segments[0]) &&
    SESSION_FILE_PATTERN.test(segments[1])
  ) {
    relative = segments;
  } else {
    return null;
  }

  const fullPath = path.join(DATA_DIR, ...relative);
  const dataRoot = DATA_DIR.endsWith(path.sep) ? DATA_DIR : `${DATA_DIR}${path.sep}`;
  return fullPath.startsWith(dataRoot) ? fullPath : null;
}

function renderIndex(files) {
  const collectUrl = publicCollectUrl();
  const items = files.length
    ? files
        .map((file) => {
          const href = `/data/${file.name.split("/").map(encodeURIComponent).join("/")}`;
          return `<li><a href="${href}">${escapeHtml(file.name)}</a>${file.sessionId ? ` — session <code>${escapeHtml(file.sessionId)}</code>` : ""} — ${file.events} events, ${file.bytes} bytes</li>`;
        })
        .join("")
    : "<li>No events yet. POST JSON to /collect.</li>";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PoseTrack collector</title>
    <style>
      body { max-width: 720px; margin: 48px auto; padding: 0 20px; font: 16px/1.6 system-ui, sans-serif; color: #e2e8f0; background: #0f172a; }
      h1 { font-size: 24px; }
      a { color: #22d3ee; }
      code { color: #a3e635; }
      li { margin: 6px 0; }
      p { color: #94a3b8; }
    </style>
  </head>
  <body>
    <h1>PoseTrack collector</h1>
    <p>POST dot events to <code>/collect</code> (no login needed). Files are written to the server's <code>data/</code> folder.</p>
    ${collectUrl ? `<p>Public POST URL: <code>${escapeHtml(collectUrl)}</code></p>` : ""}
    ${AUTH_ENABLED ? "<p>The data pages require the username and password from <code>.env</code>.</p>" : ""}
    <h2>JSON files</h2>
    <ul>${items}</ul>
    <p><a href="/data">All files as JSON</a> · <a href="/health">Health check</a></p>
  </body>
</html>
`;
}

function send(res, status, body, contentType = "application/json; charset=utf-8") {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(payload),
    ...CORS_HEADERS,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error("Payload too large");
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    send(res, 400, { ok: false, error: "Bad request" });
    return;
  }

  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }

  const isDataPage =
    req.method === "GET" &&
    (pathname === "/" ||
      pathname === "/index.html" ||
      pathname === "/data" ||
      pathname.startsWith("/data/"));
  if (isDataPage && !isAuthorized(req)) {
    requestLogin(res);
    return;
  }

  try {
    if (req.method === "POST" && pathname === COLLECT_PATH) {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        const tooLarge = error.status === 413;
        send(res, tooLarge ? 413 : 400, {
          ok: false,
          error: tooLarge ? "Payload too large" : "Invalid JSON",
        });
        return;
      }

      if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.event !== "string" || !payload.event) {
        send(res, 400, { ok: false, error: 'Expected a JSON object with an "event" string.' });
        return;
      }

      const record = {
        ...payload,
        id: randomUUID(),
        receivedAt: new Date().toISOString(),
        remoteAddress: req.socket.remoteAddress || null,
      };
      const file = await appendEvent(record);
      console.log(`${record.receivedAt}  ${record.event}=${record.value ?? "-"}  -> ${file}`);
      send(res, 201, { ok: true, id: record.id, receivedAt: record.receivedAt, file });
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      send(res, 200, {
        ok: true,
        now: new Date().toISOString(),
        dataDir: DATA_DIR,
        publicUrl: publicCollectUrl() || null,
        authRequired: AUTH_ENABLED,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/data") {
      send(res, 200, { files: await listDataFiles() });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/data/")) {
      let name;
      try {
        name = decodeURIComponent(pathname.slice("/data/".length));
      } catch {
        send(res, 400, { ok: false, error: "Bad file name" });
        return;
      }
      const fullPath = dataFilePath(name);
      if (!fullPath) {
        send(res, 400, { ok: false, error: "Bad file name" });
        return;
      }
      try {
        const text = await fsp.readFile(fullPath, "utf8");
        send(res, 200, text);
      } catch (error) {
        send(res, error.code === "ENOENT" ? 404 : 500, {
          ok: false,
          error: error.code === "ENOENT" ? "File not found" : "Could not read file",
        });
      }
      return;
    }

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      send(res, 200, renderIndex(await listDataFiles()), "text/html; charset=utf-8");
      return;
    }

    send(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, { ok: false, error: "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PoseTrack collector listening on http://${HOST}:${PORT}`);
  console.log(`POST ${COLLECT_PATH} (open) · GET /data (login required) · GET /health`);
  console.log(`Public POST URL: ${publicCollectUrl() || "not set in .env"}`);
  console.log(`Expose it with: cloudflared tunnel --url http://localhost:${PORT} (or ngrok http ${PORT})`);
});
