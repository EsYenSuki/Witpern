const MEDIAPIPE_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404";
const CALIBRATION_MS = 1000;
const POSE_STABLE_MS = 200;
const HOLD_MS = 100;
const ANGLE_TOLERANCE = 25;
const CIRCLE_DOWN_BIAS = 0.2;
const TORSO_TO_HAND_MAX = 0.5;
const MIN_REP_GAP_MS = 200;
const LANDMARK_HISTORY_LIMIT = 180;
const LANDMARK_SAMPLE_EVERY = 3;
const CAPTURE_DOTS_LIMIT = 20;
const EXPORT_FORMAT = "posetrack-pushup";
const SEND_FORMAT = "posetrack-dot-events";
const SEND_TIMEOUT_MS = 8000;
const SEND_PENDING_LIMIT = 50;
const SEND_SETTINGS_KEY = "posetrack.send";

const DEFAULT_DOWN_REACH = 0.965;
const DEFAULT_DOWN_ANGLE = 145;
const DEFAULT_UP_REACH = 0.97;
const DEFAULT_UP_ANGLE = 155;

const POSE_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [24, 26], [25, 27], [26, 28], [27, 29], [28, 30], [29, 31], [30, 32],
];

const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

const els = {};
const state = {
  pose: null,
  stream: null,
  running: false,
  rafId: null,
  fpsFrames: 0,
  fpsStartedAt: 0,
  lastTrackingStatus: "",
  isMobile: coarsePointer || window.innerWidth <= 560,
  facingMode: coarsePointer ? "environment" : "user",
  lastLandmarks: [],
  landmarkHistory: [],
  landmarkFrame: 0,
  capturedDots: [],
  captureId: 0,
  sender: {
    enabled: false,
    endpoint: "",
    sessionId: "",
    eventSeq: 0,
    pending: [],
    sending: false,
    status: { text: "Server URL not set.", kind: "idle" },
  },
  pushup: {
    phase: "waiting",
    count: 0,
    stanceSince: 0,
    startedAt: 0,
    samples: [],
    downAngle: null,
    upAngle: null,
    downReach: null,
    upReach: null,
    downSince: 0,
    upSince: 0,
    angleThreshold: null,
    thresholdRadius: null,
    elbowPass: false,
    anglePass: false,
    circlePass: false,
    insideSince: 0,
    angleExitSince: 0,
    outsideSince: 0,
    lastRepAt: 0,
    leftAngle: null,
    rightAngle: null,
    leftDist: null,
    rightDist: null,
    leftInside: false,
    rightInside: false,
    armLength: 0,
  },
};

let optionsTimer = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();
  restoreSendSettings();

  setFacingMode(state.facingMode, { restart: false });
  updateConfidenceLabel();
  resetPushup();
  updateCameraButtons();

  if (typeof window.Pose !== "function") {
    const detail = "Pose library did not load. Check your internet connection and reload the page.";
    setMessage(detail, "error");
    setTrackingStatus("Unavailable", "error");
    setPlaceholder("Tracker unavailable", detail);
    setPosePrompt(null);
    els.openCameraBtn.disabled = true;
    els.frontCamBtn.disabled = true;
    els.backCamBtn.disabled = true;
    return;
  }

  try {
    state.pose = new window.Pose({
      locateFile: (file) => `${MEDIAPIPE_BASE}/${file}`,
    });
    state.pose.onResults(onResults);
    await applyPoseOptions();

    setMessage("Starting camera…");
    await openCamera();
  } catch (error) {
    const detail = `Could not initialize the pose tracker: ${error.message || error}`;
    setMessage(detail, "error");
    setTrackingStatus("Unavailable", "error");
    setPlaceholder("Tracker unavailable", detail);
    setPosePrompt(null);
    els.openCameraBtn.disabled = true;
    els.frontCamBtn.disabled = true;
    els.backCamBtn.disabled = true;
  }
}

function cacheElements() {
  els.stage = document.getElementById("stage");
  els.videoWrap = document.getElementById("videoWrap");
  els.video = document.getElementById("video");
  els.overlay = document.getElementById("overlay");
  els.placeholder = document.getElementById("placeholder");
  els.placeholderTitle = document.getElementById("placeholderTitle");
  els.placeholderText = document.getElementById("placeholderText");
  els.hud = document.getElementById("hud");
  els.statusPill = document.getElementById("statusPill");
  els.trackingStatus = document.getElementById("trackingStatus");
  els.fps = document.getElementById("fps");
  els.landmarkCount = document.getElementById("landmarkCount");
  els.calibrationPill = document.getElementById("calibrationPill");
  els.countdown = document.getElementById("countdown");
  els.posePrompt = document.getElementById("posePrompt");
  els.posePromptTitle = document.getElementById("posePromptTitle");
  els.posePromptText = document.getElementById("posePromptText");
  els.hudReps = document.getElementById("hudReps");
  els.message = document.getElementById("message");
  els.confidence = document.getElementById("confidence");
  els.confidenceValue = document.getElementById("confidenceValue");
  els.showSkeleton = document.getElementById("showSkeleton");
  els.smooth = document.getElementById("smooth");
  els.mirror = document.getElementById("mirror");
  els.skipCalibration = document.getElementById("skipCalibration");
  els.counterStatus = document.getElementById("counterStatus");
  els.calibrationTrack = document.getElementById("calibrationTrack");
  els.calibrationBar = document.getElementById("calibrationBar");
  els.armValues = document.getElementById("armValues");
  els.repCount = document.getElementById("repCount");
  els.cameraHint = document.getElementById("cameraHint");
  els.captureDotsBtn = document.getElementById("captureDotsBtn");
  els.exportChoice = document.getElementById("exportChoice");
  els.exportDataBtn = document.getElementById("exportDataBtn");
  els.importDataBtn = document.getElementById("importDataBtn");
  els.importFile = document.getElementById("importFile");
  els.captureNote = document.getElementById("captureNote");
  els.captureList = document.getElementById("captureList");
  els.selectAllCapturesBtn = document.getElementById("selectAllCapturesBtn");
  els.downloadSelectedBtn = document.getElementById("downloadSelectedBtn");
  els.sendEndpoint = document.getElementById("sendEndpoint");
  els.sendEnabled = document.getElementById("sendEnabled");
  els.sendTestBtn = document.getElementById("sendTestBtn");
  els.sendRetryBtn = document.getElementById("sendRetryBtn");
  els.sendStatus = document.getElementById("sendStatus");
  els.openCameraBtn = document.getElementById("openCameraBtn");
  els.closeCameraBtn = document.getElementById("closeCameraBtn");
  els.frontCamBtn = document.getElementById("frontCamBtn");
  els.backCamBtn = document.getElementById("backCamBtn");
}

function bindEvents() {
  els.captureDotsBtn.addEventListener("click", captureDots);
  els.exportDataBtn.addEventListener("click", exportData);
  els.importDataBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", handleImportFile);
  els.selectAllCapturesBtn.addEventListener("click", toggleAllCaptures);
  els.downloadSelectedBtn.addEventListener("click", downloadSelectedCaptures);

  els.openCameraBtn.addEventListener("click", () => openCamera());
  els.closeCameraBtn.addEventListener("click", closeCamera);
  els.frontCamBtn.addEventListener("click", () => setFacingMode("user"));
  els.backCamBtn.addEventListener("click", () => setFacingMode("environment"));

  els.video.addEventListener("loadedmetadata", updateCanvasSize);
  window.addEventListener("resize", updateCanvasSize);
  window.addEventListener("orientationchange", updateCanvasSize);

  els.video.addEventListener("play", () => {
    setTrackingStatus("Searching…", "searching");
    startDetection();
  });
  els.video.addEventListener("pause", () => {
    stopDetection();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopDetection();
    } else if (!els.video.paused) {
      startDetection();
    }
  });

  els.confidence.addEventListener("input", () => {
    updateConfidenceLabel();
    schedulePoseOptions();
  });
  els.smooth.addEventListener("change", schedulePoseOptions);
  els.showSkeleton.addEventListener("change", () => {
    if (!els.showSkeleton.checked) clearOverlay();
  });
  els.mirror.addEventListener("change", applyMirrorClass);
  els.skipCalibration.addEventListener("change", resetPushup);

  els.sendEndpoint.addEventListener("change", saveSendSettings);
  els.sendEnabled.addEventListener("change", saveSendSettings);
  els.sendTestBtn.addEventListener("click", testSend);
  els.sendRetryBtn.addEventListener("click", flushPendingEvents);
}

async function openCamera() {
  if (!state.pose) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const detail = window.isSecureContext
      ? "This browser cannot open a camera."
      : "Camera access needs HTTPS or localhost. Open this page on localhost or over HTTPS.";
    setMessage(detail, "error");
    setPlaceholder("Camera unavailable", detail);
    setPosePrompt(null);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: state.facingMode },
        width: { ideal: state.isMobile ? 960 : 1280 },
        height: { ideal: state.isMobile ? 540 : 720 },
      },
    });

    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
    }
    state.stream = stream;
    els.video.loop = false;
    els.video.srcObject = stream;

    updateCanvasSize();
    els.videoWrap.classList.add("active");
    els.placeholder.hidden = true;
    els.hud.hidden = false;

    resetPushup();
    updateCameraButtons();
    await els.video.play();
    setMessage("Camera on. Waiting for push-up pose…", "success");
  } catch (error) {
    const detail = describeCameraError(error);
    updateCameraButtons();
    setMessage(detail, "error");
    setPlaceholder("Camera unavailable", detail);
    setPosePrompt(null);
  }
}

function closeCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  stopDetection();
  els.video.pause();
  els.video.srcObject = null;
  clearOverlay();

  els.videoWrap.classList.remove("active");
  els.hud.hidden = true;
  setPlaceholder("Camera closed", "Press Open camera to start again.");

  updateCameraButtons();
  resetPushup();
  setPosePrompt(null);
  setTrackingStatus("Waiting", "idle");
  setMessage("Camera closed. Press Open camera to start again.");
}

function updateCameraButtons() {
  const open = Boolean(state.stream);
  els.openCameraBtn.disabled = open;
  els.closeCameraBtn.disabled = !open;
  els.openCameraBtn.textContent = open ? "Camera open" : "Open camera";
}

function setFacingMode(mode, { restart = true } = {}) {
  if (mode !== "user" && mode !== "environment") return;

  const changed = state.facingMode !== mode;
  state.facingMode = mode;
  const front = mode === "user";

  els.frontCamBtn.classList.toggle("active", front);
  els.backCamBtn.classList.toggle("active", !front);
  els.frontCamBtn.setAttribute("aria-pressed", String(front));
  els.backCamBtn.setAttribute("aria-pressed", String(!front));

  els.mirror.checked = front;
  applyMirrorClass();
  els.cameraHint.textContent = front
    ? "Front camera selected. Keep the whole body in frame."
    : "Back camera selected. Place it so the full body is visible.";

  if (restart && changed && state.stream) openCamera();
}

function startDetection() {
  if (state.running || !state.pose) return;

  state.running = true;
  state.fpsFrames = 0;
  state.fpsStartedAt = performance.now();
  detectFrame();
}

function stopDetection() {
  state.running = false;
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
}

async function detectFrame() {
  if (!state.running) return;

  try {
    if (els.video.readyState >= 2 && els.video.videoWidth > 0) {
      updateCanvasSize();
      await state.pose.send({ image: els.video });
    }
  } catch (error) {
    console.error(error);
    stopDetection();
    setMessage(`Pose tracking stopped because of an error: ${error.message || error}`, "error");
    return;
  }

  if (state.running) state.rafId = requestAnimationFrame(detectFrame);
}

function onResults(results) {
  updateFps();

  const landmarks = results.poseLandmarks;
  const hasBody = Boolean(landmarks && landmarks.length > 0);

  if (!hasBody) {
    clearOverlay();
    els.landmarkCount.textContent = "0";
    setTrackingStatus("No body found", "searching");
    updatePushupCounter(null, performance.now());
    return;
  }

  if (els.showSkeleton.checked) {
    drawSkeleton(landmarks);
  } else {
    clearOverlay();
  }

  els.landmarkCount.textContent = String(landmarks.length);
  setTrackingStatus("Body found", "found");
  storeLandmarks(landmarks);

  const metrics = getPushupMetrics(landmarks);
  updatePushupCounter(metrics, performance.now());

  if (metrics) {
    drawThresholdGuides(landmarks, metrics);
  }
}

function storeLandmarks(landmarks) {
  state.lastLandmarks = landmarks.map(copyLandmark);
  state.landmarkFrame += 1;

  if (state.landmarkFrame % LANDMARK_SAMPLE_EVERY !== 0) return;

  state.landmarkHistory.push(state.lastLandmarks);
  while (state.landmarkHistory.length > LANDMARK_HISTORY_LIMIT) {
    state.landmarkHistory.shift();
  }
}

function captureDots() {
  if (!state.lastLandmarks.length) {
    setMessage("No dot positions captured yet — wait for the body to be detected.", "warn");
    return;
  }

  state.captureId += 1;
  state.capturedDots.push({
    id: state.captureId,
    capturedAt: new Date().toISOString(),
    frame: state.landmarkFrame,
    points: state.lastLandmarks,
    selected: true,
  });

  while (state.capturedDots.length > CAPTURE_DOTS_LIMIT) {
    state.capturedDots.shift();
  }

  updateCaptureNote();
  setMessage(`Captured ${state.lastLandmarks.length} dot positions.`, "success");
}

function updateCaptureNote() {
  const count = state.capturedDots.length;
  els.captureDotsBtn.textContent = count ? `Capture dots (${count})` : "Capture dots";
  els.captureNote.textContent = count
    ? `${count} snapshot${count === 1 ? "" : "s"} saved. Check the ones you want, then download selected.`
    : "No dot snapshots captured yet.";
  renderCaptureList();
}

function renderCaptureList() {
  els.captureList.textContent = "";

  if (!state.capturedDots.length) {
    els.captureList.hidden = true;
    updateSelectAllButton();
    return;
  }

  for (const [index, capture] of state.capturedDots.entries()) {
    const row = document.createElement("label");
    row.className = "capture-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(capture.id);
    checkbox.checked = capture.selected !== false;
    checkbox.addEventListener("change", () => {
      capture.selected = checkbox.checked;
      updateSelectAllButton();
    });

    const text = document.createElement("span");
    const time = capture.capturedAt ? new Date(capture.capturedAt).toLocaleTimeString() : "";
    text.textContent =
      `Capture ${index + 1} · frame ${capture.frame} · ${capture.points.length} dots` +
      (time ? ` · ${time}` : "");

    row.append(checkbox, text);
    els.captureList.appendChild(row);
  }

  els.captureList.hidden = false;
  updateSelectAllButton();
}

function updateSelectAllButton() {
  const allSelected =
    state.capturedDots.length > 0 &&
    state.capturedDots.every((capture) => capture.selected !== false);

  els.selectAllCapturesBtn.textContent = allSelected ? "Select none" : "Select all";
  els.downloadSelectedBtn.disabled = !state.capturedDots.some((capture) => capture.selected !== false);
}

function toggleAllCaptures() {
  const shouldSelect = !state.capturedDots.every((capture) => capture.selected !== false);
  for (const capture of state.capturedDots) {
    capture.selected = shouldSelect;
  }
  renderCaptureList();
}

function downloadSelectedCaptures() {
  const selected = state.capturedDots.filter((capture) => capture.selected !== false);
  if (!selected.length) {
    setMessage("Select at least one capture first.", "warn");
    return;
  }

  downloadJson(
    {
      format: EXPORT_FORMAT,
      version: 2,
      exportedAt: new Date().toISOString(),
      contents: "selectedCaptures",
      capturedDots: selected,
    },
    "selected-captures",
  );

  setMessage(`Downloaded ${selected.length} capture${selected.length === 1 ? "" : "s"}.`, "success");
}

function makeSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getSessionId() {
  try {
    const stored = sessionStorage.getItem("posetrack.sessionId");
    if (stored) return stored;
    const id = makeSessionId();
    sessionStorage.setItem("posetrack.sessionId", id);
    return id;
  } catch {
    return makeSessionId();
  }
}

function normalizeSendEndpoint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!url.hostname) return "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function restoreSendSettings() {
  const sender = state.sender;
  sender.sessionId = getSessionId();

  try {
    const saved = JSON.parse(localStorage.getItem(SEND_SETTINGS_KEY) || "{}");
    if (typeof saved.endpoint === "string") {
      sender.endpoint = normalizeSendEndpoint(saved.endpoint);
      els.sendEndpoint.value = saved.endpoint;
    }
    sender.enabled = Boolean(saved.enabled) && Boolean(sender.endpoint);
  } catch {
    sender.enabled = false;
  }

  els.sendEnabled.checked = sender.enabled;
  setSendReadyStatus();
}

function saveSendSettings() {
  const endpoint = normalizeSendEndpoint(els.sendEndpoint.value);
  const enabled = els.sendEnabled.checked && Boolean(endpoint);

  state.sender.endpoint = endpoint;
  state.sender.enabled = enabled;
  if (!endpoint) els.sendEnabled.checked = false;

  try {
    localStorage.setItem(
      SEND_SETTINGS_KEY,
      JSON.stringify({ endpoint: els.sendEndpoint.value.trim(), enabled }),
    );
  } catch {
    // Storage can be unavailable (private mode); sending still works for this page load.
  }

  setSendReadyStatus();
}

function isSendReady() {
  return state.sender.enabled && Boolean(state.sender.endpoint);
}

function sendableNumber(value) {
  return Number.isFinite(value) ? roundNumber(value) : null;
}

function buildSendEvent(event) {
  const sender = state.sender;
  const pushup = state.pushup;
  sender.eventSeq += 1;

  const dots = state.lastLandmarks.map((point, index) => ({
    index,
    x: roundNumber(point.x),
    y: roundNumber(point.y),
    z: roundNumber(point.z),
    visibility: roundNumber(point.visibility),
  }));

  return {
    format: SEND_FORMAT,
    version: 1,
    event,
    value: 1,
    eventId: `${sender.sessionId}-${sender.eventSeq}`,
    sessionId: sender.sessionId,
    sentAt: new Date().toISOString(),
    frame: state.landmarkFrame,
    repCount: pushup.count,
    calibration: {
      phase: pushup.phase,
      downAngle: sendableNumber(pushup.downAngle),
      upAngle: sendableNumber(pushup.upAngle),
      downReach: sendableNumber(pushup.downReach),
      upReach: sendableNumber(pushup.upReach),
      angleThreshold: sendableNumber(pushup.angleThreshold),
      thresholdRadius: sendableNumber(pushup.thresholdRadius),
    },
    metrics: {
      leftAngle: sendableNumber(pushup.leftAngle),
      rightAngle: sendableNumber(pushup.rightAngle),
      leftDist: sendableNumber(pushup.leftDist),
      rightDist: sendableNumber(pushup.rightDist),
      armLength: sendableNumber(pushup.armLength),
      leftInside: pushup.leftInside,
      rightInside: pushup.rightInside,
      elbowPass: pushup.elbowPass,
      anglePass: pushup.anglePass,
      circlePass: pushup.circlePass,
    },
    dotCount: dots.length,
    dots,
  };
}

function sendDotEvent(event) {
  if (!isSendReady()) return;
  void dispatchSendEvent(buildSendEvent(event));
}

async function dispatchSendEvent(event) {
  const sender = state.sender;
  if (sender.sending) {
    queueSendEvent(event);
    return;
  }

  sender.sending = true;
  updateSendStatus(`Sending ${event.event}…`);

  const ok = await postSendEvent(event);
  if (!ok) {
    queueSendEvent(event);
  } else {
    while (sender.pending.length) {
      const next = sender.pending[0];
      updateSendStatus(`Sending queued ${next.event}…`);
      if (!(await postSendEvent(next))) break;
      sender.pending.shift();
    }
  }

  sender.sending = false;
  updateSendStatus();
}

function queueSendEvent(event) {
  const pending = state.sender.pending;
  pending.push(event);
  while (pending.length > SEND_PENDING_LIMIT) pending.shift();
  updateSendStatus();
}

async function postSendEvent(event) {
  if (!state.sender.endpoint) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const response = await fetch(state.sender.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: controller.signal,
      keepalive: true,
    });
    if (!response.ok) throw new Error(`server returned ${response.status}`);
    updateSendStatus(`Sent ${event.event} = 1 · ${new Date().toLocaleTimeString()}`, "success");
    return true;
  } catch (error) {
    const reason = error.name === "AbortError" ? "timed out" : error.message || String(error);
    updateSendStatus(`Send failed (${reason}). Event kept for retry.`, "error");
    console.warn("PoseTrack send failed:", error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function flushPendingEvents() {
  const sender = state.sender;
  if (!isSendReady() || sender.sending || !sender.pending.length) return;

  sender.sending = true;
  updateSendStatus();
  while (sender.pending.length) {
    const next = sender.pending[0];
    if (!(await postSendEvent(next))) break;
    sender.pending.shift();
  }
  sender.sending = false;
  updateSendStatus();
}

function testSend() {
  const endpoint = normalizeSendEndpoint(els.sendEndpoint.value);
  if (!endpoint) {
    setMessage("Enter your ngrok URL first, then test the connection.", "warn");
    els.sendEndpoint.focus();
    return;
  }

  state.sender.endpoint = endpoint;
  state.sender.enabled = true;
  els.sendEnabled.checked = true;
  saveSendSettings();
  void dispatchSendEvent(buildSendEvent("test"));
  setMessage("Test event sent. Check the send status below.", "info");
}

function setSendReadyStatus() {
  const sender = state.sender;
  if (!sender.endpoint) {
    updateSendStatus("Server URL not set.", "idle");
  } else if (!sender.enabled) {
    updateSendStatus("Sending is off.", "idle");
  } else {
    updateSendStatus(`Ready · ${sender.endpoint}`, "success");
  }
}

function updateSendStatus(text, kind = "idle") {
  const sender = state.sender;
  if (text) sender.status = { text, kind };

  els.sendStatus.textContent = sender.status.text;
  els.sendStatus.dataset.kind = sender.status.kind;
  els.sendRetryBtn.disabled = !sender.pending.length || sender.sending || !isSendReady();
}

function drawSkeleton(landmarks) {
  const ctx = els.overlay.getContext("2d");
  const width = els.overlay.width;
  const height = els.overlay.height;
  const lineWidth = Math.max(2, width * 0.004);
  const dotRadius = Math.max(3, width * 0.0055);

  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const [startIndex, endIndex] of POSE_CONNECTIONS) {
    const start = landmarks[startIndex];
    const end = landmarks[endIndex];
    if (!start || !end) continue;

    const confidence = Math.min(start.visibility ?? 1, end.visibility ?? 1);
    if (confidence < 0.12) continue;

    ctx.globalAlpha = 0.3 + confidence * 0.7;
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(start.x * width, start.y * height);
    ctx.lineTo(end.x * width, end.y * height);
    ctx.stroke();
  }

  for (let index = 0; index < landmarks.length; index += 1) {
    const point = landmarks[index];
    if (!point) continue;

    const confidence = point.visibility ?? 1;
    if (confidence < 0.12) continue;

    ctx.globalAlpha = 0.35 + confidence * 0.65;
    ctx.fillStyle = index >= 11 && index <= 22 ? "#fb7185" : "#a3e635";
    ctx.strokeStyle = "rgba(2, 6, 23, 0.85)";
    ctx.lineWidth = Math.max(1, width * 0.0015);
    ctx.beginPath();
    ctx.arc(point.x * width, point.y * height, dotRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

function drawThresholdGuides(landmarks, metrics) {
  const ctx = els.overlay.getContext("2d");
  const width = els.overlay.width;
  const height = els.overlay.height;
  const pushup = state.pushup;

  let normalizedRadius = pushup.thresholdRadius;
  if (normalizedRadius === null) normalizedRadius = pushup.upReach;
  if (normalizedRadius === null) normalizedRadius = pushup.downReach;
  if (normalizedRadius === null) {
    normalizedRadius = (metrics.leftDist + metrics.rightDist) / 2;
  }

  const radius = Math.max(
    10,
    Math.min(width * 0.25, normalizedRadius * metrics.armLength * width),
  );

  const arms = [
    {
      shoulder: landmarks[11],
      elbow: landmarks[13],
      wrist: landmarks[15],
      inside: pushup.leftInside,
      angle: metrics.leftAngle,
      label: "L",
    },
    {
      shoulder: landmarks[12],
      elbow: landmarks[14],
      wrist: landmarks[16],
      inside: pushup.rightInside,
      angle: metrics.rightAngle,
      label: "R",
    },
  ];

  for (const arm of arms) {
    if (!arm.shoulder || !arm.elbow || !arm.wrist) continue;

    const sx = arm.shoulder.x * width;
    const sy = arm.shoulder.y * height;
    const ex = arm.elbow.x * width;
    const ey = arm.elbow.y * height;
    const wx = arm.wrist.x * width;
    const wy = arm.wrist.y * height;
    const color = arm.inside ? "#a3e635" : "#22d3ee";

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, width * 0.003);
    ctx.setLineDash([Math.max(5, width * 0.006), Math.max(4, width * 0.005)]);
    ctx.beginPath();
    ctx.arc(wx, wy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, width * 0.003);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(wx, wy);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ex, ey, Math.max(3, width * 0.005), 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(wx, wy, Math.max(3, width * 0.005), 0, Math.PI * 2);
    ctx.fill();

    drawReadableText(ctx, `${arm.label} ${Math.round(arm.angle)}°`, ex, ey - 12, width, color);
  }
}

function drawReadableText(ctx, text, x, y, width, color) {
  ctx.save();
  ctx.font = `700 ${Math.max(11, width * 0.013)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineWidth = Math.max(2, width * 0.002);
  ctx.strokeStyle = "rgba(2, 6, 23, 0.9)";
  ctx.fillStyle = color;

  if (els.mirror.checked) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.strokeText(text, width - x, y);
    ctx.fillText(text, width - x, y);
  } else {
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

function clearOverlay() {
  const ctx = els.overlay.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
}

function updateCanvasSize() {
  const width = els.video.videoWidth || 1280;
  const height = els.video.videoHeight || 720;

  if (width && height) {
    els.stage.style.aspectRatio = `${width} / ${height}`;
  }

  if (els.overlay.width !== width || els.overlay.height !== height) {
    els.overlay.width = width;
    els.overlay.height = height;
    clearOverlay();
  }
}

function updateFps() {
  state.fpsFrames += 1;
  const now = performance.now();
  const elapsed = now - state.fpsStartedAt;

  if (elapsed >= 600) {
    els.fps.textContent = String(Math.round((state.fpsFrames * 1000) / elapsed));
    state.fpsFrames = 0;
    state.fpsStartedAt = now;
  }
}

function resetPushup() {
  const pushup = state.pushup;
  pushup.phase = "waiting_down";
  pushup.count = 0;
  pushup.stanceSince = 0;
  pushup.startedAt = 0;
  pushup.samples = [];
  pushup.downAngle = null;
  pushup.upAngle = null;
  pushup.downReach = null;
  pushup.upReach = null;
  pushup.downSince = 0;
  pushup.upSince = 0;
  pushup.angleThreshold = null;
  pushup.thresholdRadius = null;
  pushup.elbowPass = false;
  pushup.anglePass = false;
  pushup.circlePass = false;
  pushup.insideSince = 0;
  pushup.angleExitSince = 0;
  pushup.outsideSince = 0;
  pushup.lastRepAt = 0;
  pushup.leftAngle = null;
  pushup.rightAngle = null;
  pushup.leftDist = null;
  pushup.rightDist = null;
  pushup.leftInside = false;
  pushup.rightInside = false;
  pushup.armLength = 0;

  state.lastLandmarks = [];
  state.landmarkHistory = [];
  state.landmarkFrame = 0;
  updateCaptureNote();

  if (els.skipCalibration && els.skipCalibration.checked) {
    applyDefaultCalibration(performance.now());
    return;
  }

  updateCounterUI();
  els.armValues.textContent = "elbow pass – · angle pass – · circle pass –";
  setCounterStatus("Get into push-up pose, then GO DOWN and hold.", "idle");
  setPosePrompt("GO DOWN FIRST", "Bend your elbows and hold the bottom position.");
}

function applyDefaultCalibration(now = performance.now()) {
  const pushup = state.pushup;
  pushup.phase = "counting";
  pushup.count = 0;
  pushup.stanceSince = 0;
  pushup.startedAt = 0;
  pushup.samples = [];
  pushup.downAngle = DEFAULT_DOWN_ANGLE;
  pushup.upAngle = DEFAULT_UP_ANGLE;
  pushup.downReach = DEFAULT_DOWN_REACH;
  pushup.upReach = DEFAULT_UP_REACH;
  pushup.downSince = 0;
  pushup.upSince = 0;
  pushup.angleThreshold = (DEFAULT_DOWN_ANGLE + DEFAULT_UP_ANGLE) / 2;
  pushup.thresholdRadius = circleThreshold(DEFAULT_DOWN_REACH, DEFAULT_UP_REACH);
  pushup.elbowPass = false;
  pushup.anglePass = false;
  pushup.circlePass = false;
  pushup.insideSince = 0;
  pushup.angleExitSince = 0;
  pushup.outsideSince = 0;
  pushup.lastRepAt = now;

  updateCounterUI();
  els.armValues.textContent =
    `DOWN ${DEFAULT_DOWN_ANGLE}° · UP ${DEFAULT_UP_ANGLE}° (defaults)`;
  setPosePrompt(null);
  setCounterStatus("Calibration disabled. Using default thresholds.", "good");
}

function averageArm(metrics) {
  return {
    angle: (metrics.leftAngle + metrics.rightAngle) / 2,
    reach: (metrics.leftDist + metrics.rightDist) / 2,
  };
}

function circleThreshold(downReach, upReach) {
  const low = Math.min(downReach, upReach);
  const high = Math.max(downReach, upReach);
  return low + (high - low) * CIRCLE_DOWN_BIAS;
}

function isDownPose(metrics) {
  if (!metrics || !metrics.inPushupPose) return false;
  const arm = averageArm(metrics);
  return arm.reach <= DEFAULT_DOWN_REACH || arm.angle <= DEFAULT_DOWN_ANGLE;
}

function isUpPose(metrics) {
  if (!metrics || !metrics.inPushupPose) return false;
  const arm = averageArm(metrics);
  return arm.reach >= DEFAULT_UP_REACH && arm.angle >= DEFAULT_UP_ANGLE;
}

function beginDownCalibration(now) {
  const pushup = state.pushup;
  pushup.phase = "calibrating_down";
  pushup.startedAt = now;
  pushup.samples = [];
  els.countdown.textContent = "5";
  setCalibrationProgress(0);
  setPosePrompt("HOLD DOWN", "Keep the bottom position still for 5 seconds.");
  setCounterStatus("Down pose found. Calibrating DOWN for 5 seconds…", "warn");
}

function beginUpCalibration(now) {
  const pushup = state.pushup;
  pushup.phase = "calibrating_up";
  pushup.startedAt = now;
  pushup.samples = [];
  els.countdown.textContent = "5";
  setCalibrationProgress(0);
  setPosePrompt("HOLD UP", "Straighten your arms and hold for 5 seconds.");
  setCounterStatus("Up pose found. Calibrating UP for 5 seconds…", "warn");
}

function saveCalibrationSample(metrics) {
  state.pushup.samples.push({
    leftAngle: metrics.leftAngle,
    rightAngle: metrics.rightAngle,
    leftDist: metrics.leftDist,
    rightDist: metrics.rightDist,
  });
  state.pushup.armLength = metrics.armLength;
}

function medianCalibration() {
  const samples = state.pushup.samples;
  const leftAngle = median(samples.map((sample) => sample.leftAngle));
  const rightAngle = median(samples.map((sample) => sample.rightAngle));
  const leftDist = median(samples.map((sample) => sample.leftDist));
  const rightDist = median(samples.map((sample) => sample.rightDist));

  return {
    angle: (leftAngle + rightAngle) / 2,
    reach: (leftDist + rightDist) / 2,
  };
}

function updatePushupCounter(metrics, now) {
  const pushup = state.pushup;

  if (pushup.phase === "waiting_down") {
    if (isDownPose(metrics)) {
      if (!pushup.downSince) pushup.downSince = now;
      if (now - pushup.downSince >= POSE_STABLE_MS) beginDownCalibration(now);
    } else {
      pushup.downSince = 0;
      setCounterStatus("GO DOWN first. Bend your elbows and hold.", "idle");
      setPosePrompt("GO DOWN FIRST", "Bend your elbows and hold the bottom position.");
    }
    return;
  }

  if (pushup.phase === "calibrating_down") {
    if (!isDownPose(metrics)) {
      pushup.startedAt = now;
      pushup.samples = [];
      els.countdown.textContent = "5";
      setCalibrationProgress(0);
      setPosePrompt("GO DOWN FIRST", "Bend your elbows and hold the bottom position.");
      setCounterStatus("Hold the DOWN position — countdown restarted.", "warn");
      return;
    }

    saveCalibrationSample(metrics);
    const elapsed = now - pushup.startedAt;
    const remaining = Math.max(0, Math.ceil((CALIBRATION_MS - elapsed) / 1000));
    els.countdown.textContent = String(remaining);
    setCalibrationProgress((elapsed / CALIBRATION_MS) * 100);
    setCounterStatus(`DOWN calibration… ${remaining}s. Hold still.`, "warn");

    if (elapsed < CALIBRATION_MS) return;

    const down = medianCalibration();
    if (down.angle > 155 && down.reach > DEFAULT_DOWN_REACH) {
      pushup.startedAt = now;
      pushup.samples = [];
      setCounterStatus("Bend deeper at the BOTTOM and hold.", "warn");
      return;
    }

    pushup.downAngle = down.angle;
    pushup.downReach = down.reach;
    pushup.phase = "waiting_up";
    pushup.samples = [];
    pushup.upSince = 0;
    els.countdown.textContent = "5";
    setCalibrationProgress(0);
    els.armValues.textContent = `DOWN saved · elbow ${Math.round(down.angle)}°`;
    setPosePrompt("NOW GO UP", "Straighten your arms and hold the top position.");
    setCounterStatus("DOWN saved. Now GO UP and hold the top.", "good");
    return;
  }

  if (pushup.phase === "waiting_up") {
    if (isUpPose(metrics)) {
      if (!pushup.upSince) pushup.upSince = now;
      if (now - pushup.upSince >= POSE_STABLE_MS) beginUpCalibration(now);
    } else {
      pushup.upSince = 0;
      setCounterStatus("Now GO UP. Straighten your arms and hold.", "idle");
      setPosePrompt("NOW GO UP", "Straighten your arms and hold the top position.");
    }
    return;
  }

  if (pushup.phase === "calibrating_up") {
    if (!isUpPose(metrics)) {
      pushup.startedAt = now;
      pushup.samples = [];
      els.countdown.textContent = "5";
      setCalibrationProgress(0);
      setPosePrompt("NOW GO UP", "Straighten your arms and hold the top position.");
      setCounterStatus("Hold the UP position — countdown restarted.", "warn");
      return;
    }

    saveCalibrationSample(metrics);
    const elapsed = now - pushup.startedAt;
    const remaining = Math.max(0, Math.ceil((CALIBRATION_MS - elapsed) / 1000));
    els.countdown.textContent = String(remaining);
    setCalibrationProgress((elapsed / CALIBRATION_MS) * 100);
    setCounterStatus(`UP calibration… ${remaining}s. Hold still.`, "warn");

    if (elapsed < CALIBRATION_MS) return;

    const up = medianCalibration();
    if (up.angle < 150 && up.reach < 0.95) {
      pushup.startedAt = now;
      pushup.samples = [];
      setCounterStatus("Straighten your arms at the TOP and hold.", "warn");
      return;
    }

    pushup.upAngle = up.angle;
    pushup.upReach = up.reach;
    pushup.angleThreshold = (pushup.downAngle + up.angle) / 2;
    pushup.thresholdRadius = circleThreshold(pushup.downReach, up.reach);
    pushup.phase = "counting";
    pushup.elbowPass = false;
    pushup.anglePass = false;
    pushup.circlePass = false;
    pushup.insideSince = 0;
    pushup.angleExitSince = 0;
    pushup.outsideSince = 0;
    pushup.lastRepAt = now;
    updateCounterUI();
    els.armValues.textContent =
      `DOWN ${Math.round(pushup.downAngle)}° · UP ${Math.round(up.angle)}°`;
    setPosePrompt(null);
    setCounterStatus("DOWN and UP saved. Start push-ups!", "good");
    return;
  }

  if (pushup.phase !== "counting") return;

  if (!metrics || !metrics.inPushupPose) {
    pushup.elbowPass = false;
    pushup.anglePass = false;
    pushup.circlePass = false;
    pushup.insideSince = 0;
    pushup.angleExitSince = 0;
    pushup.outsideSince = 0;
    pushup.leftInside = false;
    pushup.rightInside = false;
    pushup.leftAngle = null;
    pushup.rightAngle = null;
    els.armValues.textContent = "elbow pass – · angle pass – · circle pass –";
    setCounterStatus("Low push-up pose required — standing is ignored.", "warn");
    return;
  }

  pushup.armLength = metrics.armLength;
  pushup.leftAngle = metrics.leftAngle;
  pushup.rightAngle = metrics.rightAngle;
  pushup.leftDist = metrics.leftDist;
  pushup.rightDist = metrics.rightDist;
  pushup.leftInside = metrics.leftDist < pushup.thresholdRadius;
  pushup.rightInside = metrics.rightDist < pushup.thresholdRadius;

  const bendLimit = pushup.downAngle - ANGLE_TOLERANCE;
  const releaseLimit = pushup.downAngle + ANGLE_TOLERANCE;
  const bothInside = pushup.leftInside && pushup.rightInside;
  const bothOutside = !pushup.leftInside && !pushup.rightInside;
  const bothBent = metrics.leftAngle <= bendLimit && metrics.rightAngle <= bendLimit;
  const bothReleased = metrics.leftAngle >= releaseLimit && metrics.rightAngle >= releaseLimit;

  els.armValues.textContent =
    `Elbow ${Math.round(metrics.leftAngle)}°/${Math.round(metrics.rightAngle)}° · ` +
    `bend ${pushup.elbowPass ? "✓" : "–"} · angle ${pushup.anglePass ? "✓" : "–"} · ` +
    `circle ${pushup.circlePass ? "✓" : "–"}`;

  if (bothInside && bothBent) {
    if (!pushup.insideSince) pushup.insideSince = now;

    if (!pushup.elbowPass && now - pushup.insideSince >= HOLD_MS) {
      pushup.elbowPass = true;
      pushup.anglePass = false;
      pushup.circlePass = false;
      pushup.angleExitSince = 0;
      pushup.outsideSince = 0;
      sendDotEvent("push_down");
    }
  } else {
    pushup.insideSince = 0;
  }

  if (pushup.elbowPass && bothReleased) {
    if (!pushup.angleExitSince) pushup.angleExitSince = now;

    if (!pushup.anglePass && now - pushup.angleExitSince >= HOLD_MS) {
      pushup.anglePass = true;
    }
  } else {
    pushup.angleExitSince = 0;
  }

  if (pushup.elbowPass && bothOutside) {
    if (!pushup.outsideSince) pushup.outsideSince = now;

    if (!pushup.circlePass && now - pushup.outsideSince >= HOLD_MS) {
      pushup.circlePass = true;
    }
  } else {
    pushup.outsideSince = 0;
  }

  if (pushup.anglePass && pushup.circlePass && now - pushup.lastRepAt >= MIN_REP_GAP_MS) {
    pushup.count += 1;
    pushup.elbowPass = false;
    pushup.anglePass = false;
    pushup.circlePass = false;
    pushup.insideSince = 0;
    pushup.angleExitSince = 0;
    pushup.outsideSince = 0;
    pushup.lastRepAt = now;
    updateCounterUI();
    sendDotEvent("push_up");
    const reps = pushup.count;
    setCounterStatus(`${reps} rep${reps === 1 ? "" : "s"} counted. Go down again!`, "good");
    return;
  }

  if (pushup.elbowPass && pushup.anglePass && !pushup.circlePass) {
    setCounterStatus("Angle pass set. Move shoulders out of both circles.", "good");
  } else if (pushup.elbowPass && pushup.circlePass && !pushup.anglePass) {
    setCounterStatus("Circle pass set. Straighten elbows to set angle pass.", "good");
  } else if (bothInside && bothBent) {
    setCounterStatus(
      pushup.elbowPass
        ? "Bend pass set. Straighten elbows to set angle pass."
        : "Shoulders in circles — hold the bent elbows.",
      pushup.elbowPass ? "good" : "warn",
    );
  } else if (pushup.elbowPass && bothReleased && !pushup.anglePass) {
    setCounterStatus("Hold straight elbows to set angle pass.", "good");
  } else if (pushup.elbowPass && bothOutside && !pushup.circlePass) {
    setCounterStatus("Hold shoulders outside to set circle pass.", "good");
  } else if (bothInside) {
    setCounterStatus("Shoulders in circles — bend elbows past calibrated bottom.", "warn");
  } else if (bothOutside) {
    setCounterStatus("Shoulders outside — go down into both circles.", "idle");
  } else {
    setCounterStatus("Move both shoulders into or out of the circles together.", "warn");
  }
}

function getPushupMetrics(landmarks) {
  const head = landmarks[0];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftElbow = landmarks[13];
  const rightElbow = landmarks[14];
  const leftWrist = landmarks[15];
  const rightWrist = landmarks[16];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];

  const needed = [
    head, leftShoulder, rightShoulder, leftElbow, rightElbow,
    leftWrist, rightWrist, leftHip, rightHip,
  ];
  if (!needed.every(isVisible)) return null;

  const shoulder = midpoint(leftShoulder, rightShoulder);
  const hip = midpoint(leftHip, rightHip);

  const leftArmLength = distance(leftShoulder, leftElbow) + distance(leftElbow, leftWrist);
  const rightArmLength = distance(rightShoulder, rightElbow) + distance(rightElbow, rightWrist);
  if (leftArmLength < 0.02 || rightArmLength < 0.02) return null;

  const armLength = (leftArmLength + rightArmLength) / 2;
  const handSpan = (
    distance(leftShoulder, leftWrist) + distance(rightShoulder, rightWrist)
  ) / 2;
  if (handSpan < 0.02) return null;

  const torsoToHand = distance(shoulder, hip) / handSpan;
  const headLevel = Math.abs(head.y - shoulder.y) < 0.18;
  const hipLevel = Math.abs(hip.y - shoulder.y) < 0.38;
  const lowPushupPose = torsoToHand < TORSO_TO_HAND_MAX;

  return {
    inPushupPose: headLevel && hipLevel && lowPushupPose,
    armLength,
    leftAngle: jointAngle(leftShoulder, leftElbow, leftWrist),
    rightAngle: jointAngle(rightShoulder, rightElbow, rightWrist),
    leftDist: distance(leftShoulder, leftWrist) / leftArmLength,
    rightDist: distance(rightShoulder, rightWrist) / rightArmLength,
  };
}

function isVisible(point) {
  return Boolean(point && (point.visibility ?? 1) >= 0.4);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function jointAngle(start, joint, end) {
  const startAngle = Math.atan2(start.y - joint.y, start.x - joint.x);
  const endAngle = Math.atan2(end.y - joint.y, end.x - joint.x);
  let difference = Math.abs(startAngle - endAngle) * (180 / Math.PI);
  if (difference > 180) difference = 360 - difference;
  return difference;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function copyLandmark(point) {
  return {
    x: roundNumber(point.x),
    y: roundNumber(point.y),
    z: roundNumber(point.z ?? 0),
    visibility: roundNumber(point.visibility ?? 1),
  };
}

function roundNumber(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function cleanPoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return {
    x: point.x,
    y: point.y,
    z: Number.isFinite(point.z) ? point.z : 0,
    visibility: Number.isFinite(point.visibility) ? point.visibility : 1,
  };
}

function cleanFrame(frame) {
  if (!Array.isArray(frame)) return null;
  const points = frame.slice(0, 33).map(cleanPoint).filter(Boolean);
  return points.length ? points : null;
}

function buildExportData(choice) {
  const pushup = state.pushup;
  const data = {
    format: EXPORT_FORMAT,
    version: 2,
    exportedAt: new Date().toISOString(),
    contents: choice,
  };

  if (choice === "all" || choice === "calibration") {
    data.calibration = {
      phase: pushup.phase,
      downAngle: pushup.downAngle,
      upAngle: pushup.upAngle,
      downReach: pushup.downReach,
      upReach: pushup.upReach,
      angleThreshold: pushup.angleThreshold,
      thresholdRadius: pushup.thresholdRadius,
    };
  }

  if (choice === "all" || choice === "counter") {
    data.counter = {
      count: pushup.count,
      elbowPass: pushup.elbowPass,
      anglePass: pushup.anglePass,
      circlePass: pushup.circlePass,
      lastRepAt: pushup.lastRepAt,
    };
  }

  if (choice === "all" || choice === "latest") {
    data.latestDots = state.lastLandmarks;
  }

  if (choice === "all" || choice === "captured") {
    data.capturedDots = state.capturedDots;
  }

  if (choice === "all" || choice === "recent") {
    data.recentDots = state.landmarkHistory;
  }

  return data;
}

function exportData() {
  const choice = els.exportChoice.value;
  downloadJson(buildExportData(choice), choice);
  setMessage(`Exported ${choice.replace(/([A-Z])/g, " $1").toLowerCase()}.`, "success");
}

function downloadJson(data, nameSuffix) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `posetrack-${nameSuffix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

async function handleImportFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const data = JSON.parse(await file.text());
    applyImportedData(data);
    setMessage(`Imported ${file.name}.`, "success");
  } catch (error) {
    setMessage(`Import failed: ${error.message || error}`, "error");
  } finally {
    els.importFile.value = "";
  }
}

function applyImportedData(data) {
  if (!data || data.format !== EXPORT_FORMAT) {
    throw new Error("This is not a PoseTrack export file.");
  }

  const pushup = state.pushup;
  const calibration = data.calibration || {};
  const aliases = {
    downAngle: ["downAngle", "bottomAngle"],
    upAngle: ["upAngle", "topAngle"],
    downReach: ["downReach", "bottomDist"],
    upReach: ["upReach", "topDist"],
    angleThreshold: ["angleThreshold"],
    thresholdRadius: ["thresholdRadius"],
  };

  for (const [target, names] of Object.entries(aliases)) {
    const value = names.map((name) => calibration[name]).find(Number.isFinite);
    if (value !== undefined) pushup[target] = value;
  }

  if (Number.isFinite(pushup.downReach) && Number.isFinite(pushup.upReach)) {
    pushup.thresholdRadius = circleThreshold(pushup.downReach, pushup.upReach);
  }

  const hasCalibration =
    Number.isFinite(pushup.downAngle) &&
    Number.isFinite(pushup.upAngle) &&
    Number.isFinite(pushup.downReach) &&
    Number.isFinite(pushup.upReach) &&
    Number.isFinite(pushup.thresholdRadius);

  if (hasCalibration) {
    pushup.phase = "counting";
    pushup.elbowPass = false;
    pushup.anglePass = false;
    pushup.circlePass = false;
    pushup.insideSince = 0;
    pushup.angleExitSince = 0;
    pushup.outsideSince = 0;
    pushup.lastRepAt = performance.now();
    els.armValues.textContent =
      `DOWN ${Math.round(pushup.downAngle)}° · UP ${Math.round(pushup.upAngle)}°`;
    setPosePrompt(null);
    setCounterStatus("Imported calibration. Start push-ups!", "good");
  } else {
    pushup.phase = "waiting_down";
    setPosePrompt("GO DOWN FIRST", "Bend your elbows and hold the bottom position.");
    setCounterStatus("Imported file has no complete calibration. Calibrate first.", "warn");
  }

  if (Number.isFinite(data.counter?.count)) {
    pushup.count = Math.max(0, data.counter.count);
  }
  if (typeof data.counter?.elbowPass === "boolean") {
    pushup.elbowPass = data.counter.elbowPass;
  } else if (typeof data.counter?.inside === "boolean") {
    pushup.elbowPass = data.counter.inside;
  }
  if (typeof data.counter?.anglePass === "boolean") {
    pushup.anglePass = data.counter.anglePass;
  }
  if (typeof data.counter?.circlePass === "boolean") {
    pushup.circlePass = data.counter.circlePass;
  }

  state.lastLandmarks = cleanFrame(data.latestDots) || [];
  state.landmarkHistory = Array.isArray(data.recentDots)
    ? data.recentDots.map(cleanFrame).filter(Boolean).slice(-LANDMARK_HISTORY_LIMIT)
    : [];
  const importedCaptures = Array.isArray(data.capturedDots)
    ? data.capturedDots
        .map((capture, index) => ({
          id: Number.isFinite(capture?.id) ? capture.id : index + 1,
          capturedAt: typeof capture?.capturedAt === "string" ? capture.capturedAt : new Date().toISOString(),
          frame: Number.isFinite(capture?.frame) ? capture.frame : 0,
          points: cleanFrame(capture?.points),
          selected: typeof capture?.selected === "boolean" ? capture.selected : true,
        }))
        .filter((capture) => capture.points)
        .slice(-CAPTURE_DOTS_LIMIT)
    : [];

  state.capturedDots = importedCaptures;
  state.captureId = importedCaptures.reduce((max, capture) => Math.max(max, capture.id), 0);

  updateCaptureNote();
  updateCounterUI();

  if (els.skipCalibration && els.skipCalibration.checked) {
    applyDefaultCalibration(performance.now());
  }
}

function setCalibrationProgress(percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  els.calibrationBar.style.width = `${value}%`;
  els.calibrationTrack.setAttribute("aria-valuenow", String(value));
}

function setCounterStatus(text, kind = "idle") {
  if (els.counterStatus.textContent.trim() !== text) {
    els.counterStatus.textContent = text;
  }
  if (els.counterStatus.dataset.kind !== kind) {
    els.counterStatus.dataset.kind = kind;
  }
}

function updateCounterUI() {
  const pushup = state.pushup;
  const calibrating = ["waiting_down", "calibrating_down", "waiting_up", "calibrating_up"].includes(pushup.phase);
  const counting = pushup.phase === "counting";

  els.repCount.textContent = String(pushup.count);
  els.hudReps.textContent = String(pushup.count);
  els.calibrationPill.hidden = !calibrating;

  if (calibrating) {
    els.countdown.textContent = "5";
    setCalibrationProgress(0);
  } else {
    setCalibrationProgress(counting ? 100 : 0);
  }
}

function schedulePoseOptions() {
  if (optionsTimer !== null) clearTimeout(optionsTimer);
  optionsTimer = setTimeout(() => {
    optionsTimer = null;
    applyPoseOptions().catch((error) => {
      setMessage(`Could not update tracker settings: ${error.message || error}`, "error");
    });
  }, 160);
}

async function applyPoseOptions() {
  if (!state.pose) return;

  const confidence = Number(els.confidence.value) / 100;
  await state.pose.setOptions({
    modelComplexity: state.isMobile ? 0 : 1,
    smoothLandmarks: els.smooth.checked,
    minDetectionConfidence: confidence,
    minTrackingConfidence: confidence,
  });
}

function updateConfidenceLabel() {
  els.confidenceValue.textContent = `${els.confidence.value}%`;
}

function applyMirrorClass() {
  els.videoWrap.classList.toggle("mirror", els.mirror.checked);
}

function setTrackingStatus(text, kind) {
  if (state.lastTrackingStatus !== text) {
    els.trackingStatus.textContent = text;
    state.lastTrackingStatus = text;
  }
  els.statusPill.dataset.state = kind;
}

function setMessage(text, kind = "info") {
  els.message.textContent = text;
  els.message.dataset.kind = kind;
}

function setPlaceholder(title, text) {
  els.placeholderTitle.textContent = title;
  els.placeholderText.textContent = text;
  els.placeholder.hidden = false;
}

function setPosePrompt(title, text) {
  if (title === null) {
    els.posePrompt.hidden = true;
    return;
  }
  els.posePromptTitle.textContent = title;
  els.posePromptText.textContent = text;
  els.posePrompt.hidden = false;
}

function describeCameraError(error) {
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
    return "Camera permission was denied. Allow access and reload the page.";
  }
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return "No camera was found. Connect a camera and reload the page.";
  }
  if (error.name === "OverconstrainedError") {
    return "This camera mode is not available on this device. Reload the page to try again.";
  }
  if (!window.isSecureContext) {
    return "Camera access needs HTTPS or localhost. Open this page on localhost or over HTTPS.";
  }
  return `Could not start the camera: ${error.message || error}`;
}
