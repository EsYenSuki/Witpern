const MEDIAPIPE_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404";
const HOLD_MS = 80;
const MIN_REP_GAP_MS = 250;
const REP_STATUS_HOLD_MS = 1200;
const LANDMARK_HISTORY_LIMIT = 180;
const LANDMARK_SAMPLE_EVERY = 3;
const CAPTURE_DOTS_LIMIT = 20;
const EXPORT_FORMAT = "posetrack-pushup";
const SEND_FORMAT = "posetrack-dot-events";
const SEND_TIMEOUT_MS = 8000;
const SEND_PENDING_LIMIT = 50;
const SEND_SETTINGS_KEY = "posetrack.send";

// Fixed counting thresholds (aspect-ratio corrected pixel space; works across front, 45°, and side views).
// Elbow angle (shoulder–elbow–wrist) zones.
const UP_ANGLE_MIN = 152;       // arms straight: avg angle >= this is the UP pose
const DOWN_ANGLE_MAX = 125;     // arms bent:     avg angle <= this is the DOWN pose
const DEEP_BEND_ANGLE_MAX = 118; // unambiguous elbow bend across any camera angle
// Head→wrist distance divided by stable body scale. Smaller value means the body is lower (DOWN).
const PROX_UP_MIN = 1.15;
const PROX_DOWN_MAX = 1.05;
// Mirror check: |leftAngle − rightAngle| when both arms are visible.
const MIRROR_MAX_DIFF = 70;
// Vertical hand margin relative to hips (blocks standing / arm-curl false positives while allowing angled views).
const HANDS_BELOW_HIP_MIN = -0.18;
// Maximum vertical hip-to-shoulder drop ratio (standing upright is ~1.15–1.50; push-up is typically -0.50 to +0.60).
const MAX_TORSO_VERTICAL_RATIO = 0.90;
// Grace period (ms) to preserve rep state through brief tracking dropouts at the bottom of a rep.
const GRACE_MS = 850;
// Keep hip-valid memory briefly when chest occludes hips at the bottom of a front-view push-up.
const HIP_OCCLUSION_MEMORY_MS = 2500;
// Landmark visibility thresholds (lower than 0.4 to prevent dropouts during prone/push-up frames).
const ARM_VISIBILITY_MIN = 0.25;
const AUX_VISIBILITY_MIN = 0.18;
// Time-constant (ms) for FPS-independent EMA smoothing of angles and proximity.
const SMOOTH_TAU_MS = 60;
// Slow decay time-constant (ms) for reference body scale so bending arms never collapses the scale denominator.
const SCALE_DECAY_TAU_MS = 3000;
// Default detection confidence (%) applied on startup for reliable prone/push-up tracking.
const DEFAULT_CONFIDENCE_PCT = 35;
// Consecutive pose.send errors tolerated before stopping the tracking loop.
const MAX_CONSECUTIVE_ERRORS = 5;

const POSE_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [24, 26], [25, 27], [26, 28], [27, 29], [28, 30], [29, 31], [30, 32],
];

const coarsePointer =
  typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

const els = {};
const state = {
  pose: null,
  stream: null,
  cameraOpId: 0,
  cameraBusy: false,
  running: false,
  rafId: null,
  optionsDirty: false,
  consecutiveErrors: 0,
  videoWidth: 0,
  videoHeight: 0,
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
    phase: "counting",
    count: 0,
    armed: false,
    downSince: 0,
    upSince: 0,
    lastRepAt: 0,
    invalidFrames: 0,
    invalidSince: 0,
    lastValidAt: 0,
    lastHipValidAt: 0,
    refScale: 0,
    smoothAngle: null,
    smoothProx: null,
    avgAngle: null,
    prox: null,
    isDown: false,
    isUp: false,
    mirrorOk: false,
    handsBelow: false,
    leftAngle: null,
    rightAngle: null,
    armLength: 0,
    trackedArms: "",
  },
};

let optionsTimer = null;
let endpointInputTimer = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();
  restoreSendSettings();

  // Lower default slider from 50% to 35% so prone push-up tracking doesn't drop out on startup.
  if (els.confidence && Number(els.confidence.value) === 50) {
    els.confidence.value = String(DEFAULT_CONFIDENCE_PCT);
  }

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

  els.video.addEventListener("loadedmetadata", () => updateCanvasSize(true));
  window.addEventListener("resize", () => updateCanvasSize(false));
  window.addEventListener("orientationchange", () => updateCanvasSize(true));

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
    } else if (!els.video.paused && state.stream) {
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

  els.sendEndpoint.addEventListener("input", scheduleEndpointSave);
  els.sendEndpoint.addEventListener("change", () => saveSendSettings({ strictToggle: true }));
  els.sendEnabled.addEventListener("change", () => saveSendSettings({ strictToggle: true }));
  els.sendTestBtn.addEventListener("click", testSend);
  els.sendRetryBtn.addEventListener("click", flushPendingEvents);
}

function stopStreamTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      // Ignore already-stopped tracks.
    }
  });
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

  const opId = ++state.cameraOpId;
  state.cameraBusy = true;
  updateCameraButtons();

  // Release any previous stream first so mobile devices can switch cameras reliably.
  stopDetection();
  if (state.stream) {
    stopStreamTracks(state.stream);
    state.stream = null;
    els.video.srcObject = null;
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

    // Discard stream if user closed or switched camera while permission/hardware was pending.
    if (opId !== state.cameraOpId) {
      stopStreamTracks(stream);
      return;
    }

    state.stream = stream;
    els.video.loop = false;
    els.video.srcObject = stream;

    updateCanvasSize(true);
    els.videoWrap.classList.add("active");
    els.placeholder.hidden = true;
    els.hud.hidden = false;

    resetPushup();
    await els.video.play();

    if (opId !== state.cameraOpId) {
      stopStreamTracks(stream);
      if (state.stream === stream) state.stream = null;
      return;
    }

    updateCanvasSize(true);
    startDetection();
    setMessage("Camera on. Get into push-up pose (front, 45° angle, or side view).", "success");
  } catch (error) {
    if (opId !== state.cameraOpId) return;
    const detail = describeCameraError(error);
    setMessage(detail, "error");
    setPlaceholder("Camera unavailable", detail);
    setPosePrompt(null);
  } finally {
    if (opId === state.cameraOpId) {
      state.cameraBusy = false;
      updateCameraButtons();
    }
  }
}

function closeCamera() {
  state.cameraOpId += 1;
  state.cameraBusy = false;

  if (state.stream) {
    stopStreamTracks(state.stream);
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
  const busy = state.cameraBusy;
  els.openCameraBtn.disabled = open || busy;
  els.closeCameraBtn.disabled = !open && !busy;
  els.frontCamBtn.disabled = busy;
  els.backCamBtn.disabled = busy;
  els.openCameraBtn.textContent = busy ? "Starting…" : open ? "Camera open" : "Open camera";
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
    ? "Front camera selected. Keep head, arms and hips in frame (front, 45° angle, or side view)."
    : "Back camera selected. Place it so head, arms and hips stay in frame (front, 45° angle, or side view).";

  if (restart && changed && (state.stream || state.cameraBusy)) openCamera();
}

function startDetection() {
  if (state.running || !state.pose || !state.stream) return;

  state.running = true;
  state.consecutiveErrors = 0;
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
    if (state.optionsDirty) {
      state.optionsDirty = false;
      await applyPoseOptions();
    }

    if (els.video.readyState >= 2 && els.video.videoWidth > 0) {
      updateCanvasSize(false);
      await state.pose.send({ image: els.video });
    }
  } catch (error) {
    state.consecutiveErrors += 1;
    console.warn(`Pose frame error (${state.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, error);

    if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      stopDetection();
      setMessage(`Pose tracking stopped because of an error: ${error.message || error}`, "error");
      return;
    }
  }

  if (state.running) {
    state.rafId = requestAnimationFrame(detectFrame);
  }
}

function onResults(results) {
  // Guard against stale results arriving after camera closed or paused mid-frame.
  if (!state.running || !state.stream) return;

  state.consecutiveErrors = 0;
  updateFps();

  const landmarks = results.poseLandmarks;
  const hasBody = Boolean(landmarks && landmarks.length > 0);
  const now = performance.now();

  if (!hasBody) {
    clearOverlay();
    els.landmarkCount.textContent = "0";
    setTrackingStatus("No body found", "searching");
    updatePushupCounter(null, now);
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

  const metrics = getPushupMetrics(landmarks, now);
  updatePushupCounter(metrics, now);

  if (metrics && els.showSkeleton.checked) {
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
  els.downloadSelectedBtn.disabled = !state.capturedDots.some(
    (capture) => capture.selected !== false,
  );
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

  setMessage(
    `Downloaded ${selected.length} capture${selected.length === 1 ? "" : "s"}.`,
    "success",
  );
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

function scheduleEndpointSave() {
  if (endpointInputTimer !== null) clearTimeout(endpointInputTimer);
  endpointInputTimer = setTimeout(() => {
    endpointInputTimer = null;
    saveSendSettings({ strictToggle: false });
  }, 250);
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

function saveSendSettings({ strictToggle = true } = {}) {
  const endpoint = normalizeSendEndpoint(els.sendEndpoint.value);
  const enabled = els.sendEnabled.checked && Boolean(endpoint);

  state.sender.endpoint = endpoint;
  state.sender.enabled = enabled;
  if (strictToggle && !endpoint) {
    els.sendEnabled.checked = false;
  }

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
      upAngleMin: UP_ANGLE_MIN,
      downAngleMax: DOWN_ANGLE_MAX,
      proxUpMin: PROX_UP_MIN,
      proxDownMax: PROX_DOWN_MAX,
      mirrorMaxDiff: MIRROR_MAX_DIFF,
      handsBelowHipMin: HANDS_BELOW_HIP_MIN,
    },
    metrics: {
      leftAngle: sendableNumber(pushup.leftAngle),
      rightAngle: sendableNumber(pushup.rightAngle),
      avgAngle: sendableNumber(pushup.avgAngle),
      prox: sendableNumber(pushup.prox),
      mirrorOk: pushup.mirrorOk,
      handsBelow: pushup.handsBelow,
      armLength: sendableNumber(pushup.armLength),
      armed: pushup.armed,
    },
    dotCount: dots.length,
    dots,
  };
}

function sendDotEvent(event) {
  if (!isSendReady()) return;
  queueSendEvent(buildSendEvent(event));
  void flushPendingEvents();
}

function queueSendEvent(event) {
  const pending = state.sender.pending;
  pending.push(event);
  while (pending.length > SEND_PENDING_LIMIT) pending.shift();
  updateSendStatus();
}

async function postSendEvent(event) {
  if (!state.sender.endpoint) return { ok: false, reason: "no server URL" };

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
    return { ok: true };
  } catch (error) {
    const reason = error.name === "AbortError" ? "timed out" : error.message || String(error);
    console.warn("PoseTrack send failed:", error);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

async function flushPendingEvents() {
  const sender = state.sender;
  if (!isSendReady() || sender.sending || !sender.pending.length) return;

  sender.sending = true;
  updateSendStatus();

  try {
    // Strictly drain in FIFO order so server always receives push_down before push_up.
    while (sender.pending.length && isSendReady()) {
      const next = sender.pending[0];
      updateSendStatus(`Sending ${next.event}…`);
      const result = await postSendEvent(next);
      if (!result.ok) {
        updateSendStatus(`Send failed (${result.reason}). Event kept for retry.`, "error");
        break;
      }
      sender.pending.shift();
      updateSendStatus(`Sent ${next.event} = 1 · ${new Date().toLocaleTimeString()}`, "success");
    }
  } finally {
    sender.sending = false;
    updateSendStatus();
  }
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
  saveSendSettings({ strictToggle: true });
  queueSendEvent(buildSendEvent("test"));
  void flushPendingEvents();
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

  const queuedSuffix = sender.pending.length ? ` (${sender.pending.length} queued)` : "";
  els.sendStatus.textContent = `${sender.status.text}${queuedSuffix}`;
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

function getHeadAnchor(landmarks) {
  const earL = landmarks[7];
  const earR = landmarks[8];
  const nose = landmarks[0];
  const earLValid = isVisible(earL, AUX_VISIBILITY_MIN);
  const earRValid = isVisible(earR, AUX_VISIBILITY_MIN);

  if (earLValid && earRValid) return midpoint(earL, earR);
  if (earLValid) return earL;
  if (earRValid) return earR;
  if (isVisible(nose, AUX_VISIBILITY_MIN)) return nose;
  return null;
}

function drawThresholdGuides(landmarks, metrics) {
  const ctx = els.overlay.getContext("2d");
  const width = els.overlay.width;
  const height = els.overlay.height;
  const pushup = state.pushup;

  const head = getHeadAnchor(landmarks);
  const displayProx =
    metrics.inPushupPose && pushup.prox != null ? pushup.prox : metrics.prox;

  const angleColor = (a) => {
    if (!metrics.inPushupPose) return "#94a3b8";
    if (pushup.isDown || a <= DOWN_ANGLE_MAX) return "#a3e635";
    if (pushup.isUp || a >= UP_ANGLE_MIN) return "#22d3ee";
    return "#fbbf24";
  };

  const proxColor = !metrics.inPushupPose
    ? "#94a3b8"
    : pushup.isDown || (displayProx != null && displayProx <= PROX_DOWN_MAX)
      ? "#a3e635"
      : pushup.isUp || (displayProx != null && displayProx >= PROX_UP_MIN)
        ? "#22d3ee"
        : "#fbbf24";

  const arms = [
    {
      shoulder: landmarks[11],
      elbow: landmarks[13],
      wrist: landmarks[15],
      angle: metrics.leftAngle,
      label: "L",
    },
    {
      shoulder: landmarks[12],
      elbow: landmarks[14],
      wrist: landmarks[16],
      angle: metrics.rightAngle,
      label: "R",
    },
  ];

  for (const arm of arms) {
    if (arm.angle == null || !arm.shoulder || !arm.elbow || !arm.wrist) continue;

    const sx = arm.shoulder.x * width;
    const sy = arm.shoulder.y * height;
    const ex = arm.elbow.x * width;
    const ey = arm.elbow.y * height;
    const wx = arm.wrist.x * width;
    const wy = arm.wrist.y * height;
    const color = angleColor(arm.angle);

    // Head → wrist proximity line.
    if (head) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = proxColor;
      ctx.lineWidth = Math.max(2, width * 0.0025);
      ctx.setLineDash([Math.max(5, width * 0.005), Math.max(4, width * 0.004)]);
      ctx.beginPath();
      ctx.moveTo(head.x * width, head.y * height);
      ctx.lineTo(wx, wy);
      ctx.stroke();
      ctx.restore();
    }

    // Arm bones: shoulder→elbow (bright), elbow→wrist (dim).
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, width * 0.003);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    ctx.globalAlpha = 0.5;
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

    drawReadableText(
      ctx,
      `${arm.label} ${Math.round(arm.angle)}°`,
      ex,
      ey - Math.max(10, width * 0.012),
      width,
      color,
      0.9,
    );
  }

  // Proximity + tracking mode readout near the head.
  if (head) {
    const modeTag =
      metrics.trackedArms === "L+R"
        ? metrics.mirrorOk
          ? "L+R ✓"
          : "L+R –"
        : `${metrics.trackedArms} 1-arm`;
    const poseTag = metrics.inPushupPose ? modeTag : "not in pose";
    drawReadableText(
      ctx,
      `prox ${displayProx != null ? displayProx.toFixed(2) : "--"} · ${poseTag}`,
      head.x * width,
      head.y * height - Math.max(12, width * 0.014),
      width,
      proxColor,
      0.8,
    );
  }
}

function drawReadableText(ctx, text, x, y, width, color, scale = 1) {
  ctx.save();
  ctx.font = `700 ${Math.max(10, width * 0.013 * scale)}px Inter, system-ui, sans-serif`;
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

function updateCanvasSize(force = false) {
  const width = els.video.videoWidth || 1280;
  const height = els.video.videoHeight || 720;

  if (!force && width === state.videoWidth && height === state.videoHeight) {
    return;
  }

  state.videoWidth = width;
  state.videoHeight = height;

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

function resetPushupState(count = 0) {
  const pushup = state.pushup;
  pushup.phase = "counting";
  pushup.count = count;
  pushup.armed = false;
  pushup.downSince = 0;
  pushup.upSince = 0;
  pushup.lastRepAt = 0;
  pushup.invalidFrames = 0;
  pushup.invalidSince = 0;
  pushup.lastValidAt = 0;
  pushup.lastHipValidAt = 0;
  pushup.refScale = 0;
  pushup.smoothAngle = null;
  pushup.smoothProx = null;
  pushup.avgAngle = null;
  pushup.prox = null;
  pushup.isDown = false;
  pushup.isUp = false;
  pushup.mirrorOk = false;
  pushup.handsBelow = false;
  pushup.leftAngle = null;
  pushup.rightAngle = null;
  pushup.armLength = 0;
  pushup.trackedArms = "";
}

function resetPushup() {
  resetPushupState(0);

  state.lastLandmarks = [];
  state.landmarkHistory = [];
  state.landmarkFrame = 0;
  updateCaptureNote();

  updateCounterUI();
  els.armValues.textContent =
    `DOWN ≤${DOWN_ANGLE_MAX}° · UP ≥${UP_ANGLE_MIN}° · prox ≤${PROX_DOWN_MAX} / ≥${PROX_UP_MIN}`;
  setPosePrompt(null);
  setCounterStatus("Get into push-up pose and start counting.", "idle");
}

function formatAngle(value) {
  return value != null ? `${Math.round(value)}°` : "--";
}

function updatePushupCounter(metrics, now) {
  const pushup = state.pushup;

  if (pushup.phase !== "counting") return;

  // Time-based grace period: preserve armed rep state through brief occlusions/dropouts.
  if (!metrics || !metrics.inPushupPose) {
    pushup.invalidFrames += 1;
    pushup.isDown = false;
    pushup.isUp = false;
    if (!pushup.invalidSince) pushup.invalidSince = now;

    if (now - pushup.invalidSince > GRACE_MS) {
      pushup.armed = false;
      pushup.downSince = 0;
      pushup.upSince = 0;
      pushup.refScale = 0;
      pushup.smoothAngle = null;
      pushup.smoothProx = null;
      pushup.avgAngle = null;
      pushup.prox = null;
      pushup.leftAngle = null;
      pushup.rightAngle = null;
      pushup.trackedArms = "";

      if (metrics && metrics.reason) {
        els.armValues.textContent =
          `Elbow ${formatAngle(metrics.leftAngle)}/${formatAngle(metrics.rightAngle)} · prox ${metrics.prox.toFixed(2)}`;
        setCounterStatus(metrics.reason, "warn");
      } else {
        els.armValues.textContent = "Waiting for push-up pose…";
        setCounterStatus("Waiting for push-up pose — keep head, arms and hips in view.", "warn");
      }
    }
    return;
  }

  const dt = pushup.lastValidAt ? Math.min(250, Math.max(1, now - pushup.lastValidAt)) : 33;
  pushup.lastValidAt = now;
  pushup.invalidFrames = 0;
  pushup.invalidSince = 0;

  // FPS-independent EMA smoothing to filter landmark jitter without lagging on slower mobile cameras.
  const alpha = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
  pushup.smoothAngle =
    pushup.smoothAngle == null
      ? metrics.avgAngle
      : pushup.smoothAngle + alpha * (metrics.avgAngle - pushup.smoothAngle);
  pushup.smoothProx =
    pushup.smoothProx == null
      ? metrics.prox
      : pushup.smoothProx + alpha * (metrics.prox - pushup.smoothProx);

  const avgAngle = pushup.smoothAngle;
  const prox = pushup.smoothProx;

  pushup.armLength = metrics.armLength;
  pushup.leftAngle = metrics.leftAngle;
  pushup.rightAngle = metrics.rightAngle;
  pushup.avgAngle = avgAngle;
  pushup.prox = prox;
  pushup.mirrorOk = metrics.mirrorOk;
  pushup.handsBelow = metrics.handsBelow;
  pushup.trackedArms = metrics.trackedArms;

  // Mutually exclusive DOWN and UP conditions with clean hysteresis:
  // - Standard push-up: bent elbows + lowered body
  // - Unambiguous elbow bend (side / 45° / 70%-depth push-ups): elbow <= 118°
  // - Tucked-elbow front push-up: clear prox drop <= 0.92 + moderate 2D bend <= 145°
  const down =
    metrics.mirrorOk &&
    metrics.handsBelow &&
    ((avgAngle <= DOWN_ANGLE_MAX && prox <= PROX_DOWN_MAX) ||
      avgAngle <= DEEP_BEND_ANGLE_MAX ||
      (prox <= 0.92 && avgAngle <= 145));

  const up =
    metrics.mirrorOk &&
    metrics.handsBelow &&
    ((avgAngle >= UP_ANGLE_MIN && prox >= PROX_UP_MIN) ||
      (avgAngle >= 162 && prox >= 1.0));

  pushup.isDown = down;
  pushup.isUp = up;

  els.armValues.textContent =
    `Elbow ${formatAngle(metrics.leftAngle)}/${formatAngle(metrics.rightAngle)} (avg ${Math.round(avgAngle)}°) · ` +
    `prox ${prox.toFixed(2)} · ${metrics.trackedArms} · ${pushup.armed ? "armed ✓" : "armed –"}`;

  // Arm the rep at the bottom.
  if (down) {
    if (!pushup.downSince) pushup.downSince = now;

    if (!pushup.armed && now - pushup.downSince >= HOLD_MS) {
      pushup.armed = true;
      pushup.upSince = 0;
      sendDotEvent("push_down");
    }
  } else {
    pushup.downSince = 0;
  }

  // Count the rep when returning to the top.
  if (up && pushup.armed) {
    if (!pushup.upSince) pushup.upSince = now;

    if (now - pushup.upSince >= HOLD_MS && now - pushup.lastRepAt >= MIN_REP_GAP_MS) {
      pushup.count += 1;
      pushup.armed = false;
      pushup.downSince = 0;
      pushup.upSince = 0;
      pushup.lastRepAt = now;
      updateCounterUI();
      sendDotEvent("push_up");
      const reps = pushup.count;
      setCounterStatus(`${reps} rep${reps === 1 ? "" : "s"} counted. Go down again!`, "good");
      return;
    }
  } else {
    pushup.upSince = 0;
  }

  if (down) {
    setCounterStatus(
      pushup.armed ? "Bottom held. Push back up." : "Hold the bottom to arm the rep.",
      "good",
    );
  } else if (up && pushup.armed) {
    setCounterStatus("Hold the top to finish the rep.", "good");
  } else if (pushup.armed) {
    setCounterStatus("Armed — push up to the top.", "good");
  } else if (!metrics.mirrorOk) {
    setCounterStatus("Arms uneven — keep both elbows bending together.", "warn");
  } else if (pushup.count > 0 && pushup.lastRepAt > 0 && now - pushup.lastRepAt < REP_STATUS_HOLD_MS) {
    const reps = pushup.count;
    setCounterStatus(`${reps} rep${reps === 1 ? "" : "s"} counted. Go down again!`, "good");
  } else {
    setCounterStatus("Go down (bend elbows) then up (straighten).", "idle");
  }
}

function getPushupMetrics(landmarks, now) {
  const width = els.overlay.width || els.video.videoWidth || 1280;
  const height = els.overlay.height || els.video.videoHeight || 720;
  const minDim = Math.min(width, height);
  const maxDim = Math.max(width, height);

  const headRaw = getHeadAnchor(landmarks);
  if (!headRaw) return null;
  const head = toPixelPoint(headRaw, width, height);

  const lShoulderRaw = landmarks[11];
  const rShoulderRaw = landmarks[12];
  const lElbowRaw = landmarks[13];
  const rElbowRaw = landmarks[14];
  const lWristRaw = landmarks[15];
  const rWristRaw = landmarks[16];

  const leftArmValid =
    isVisible(lShoulderRaw, ARM_VISIBILITY_MIN) &&
    isVisible(lElbowRaw, ARM_VISIBILITY_MIN) &&
    isVisible(lWristRaw, ARM_VISIBILITY_MIN);
  const rightArmValid =
    isVisible(rShoulderRaw, ARM_VISIBILITY_MIN) &&
    isVisible(rElbowRaw, ARM_VISIBILITY_MIN) &&
    isVisible(rWristRaw, ARM_VISIBILITY_MIN);

  if (!leftArmValid && !rightArmValid) return null;

  const lShoulder = leftArmValid ? toPixelPoint(lShoulderRaw, width, height) : null;
  const lElbow = leftArmValid ? toPixelPoint(lElbowRaw, width, height) : null;
  const lWrist = leftArmValid ? toPixelPoint(lWristRaw, width, height) : null;

  const rShoulder = rightArmValid ? toPixelPoint(rShoulderRaw, width, height) : null;
  const rElbow = rightArmValid ? toPixelPoint(rElbowRaw, width, height) : null;
  const rWrist = rightArmValid ? toPixelPoint(rWristRaw, width, height) : null;

  const leftArmLengthPx = leftArmValid
    ? distance(lShoulder, lElbow) + distance(lElbow, lWrist)
    : 0;
  const rightArmLengthPx = rightArmValid
    ? distance(rShoulder, rElbow) + distance(rElbow, rWrist)
    : 0;

  const minArmPx = minDim * 0.04;
  const useLeft = leftArmValid && leftArmLengthPx >= minArmPx;
  const useRight = rightArmValid && rightArmLengthPx >= minArmPx;
  if (!useLeft && !useRight) return null;

  const armLengthPx =
    useLeft && useRight
      ? (leftArmLengthPx + rightArmLengthPx) / 2
      : useLeft
        ? leftArmLengthPx
        : rightArmLengthPx;

  const shoulderWidthPx =
    useLeft && useRight ? distance(lShoulder, rShoulder) : 0;

  const shoulder =
    useLeft && useRight ? midpoint(lShoulder, rShoulder) : useLeft ? lShoulder : rShoulder;

  // Check hips early so torso length can stabilize body scale in side view.
  const lHipRaw = landmarks[23];
  const rHipRaw = landmarks[24];
  const lHipValid = isVisible(lHipRaw, AUX_VISIBILITY_MIN);
  const rHipValid = isVisible(rHipRaw, AUX_VISIBILITY_MIN);
  const lHip = lHipValid ? toPixelPoint(lHipRaw, width, height) : null;
  const rHip = rHipValid ? toPixelPoint(rHipRaw, width, height) : null;
  const hip = lHip && rHip ? midpoint(lHip, rHip) : lHip || rHip;

  const torsoLengthPx = hip ? distance(shoulder, hip) : 0;

  // Stable body scale across front view (shoulderWidth), side view (torsoLength), and angled view (armLength).
  const baseScale = Math.max(shoulderWidthPx, torsoLengthPx * 0.85, armLengthPx * 0.72);
  if (baseScale < 12) return null;

  const pushup = state.pushup;
  // Use bounded preview scale for posture checks so standing close never pollutes refScale.
  const previewScale = pushup.refScale
    ? Math.min(baseScale * 1.45, Math.max(baseScale, pushup.refScale * 0.9))
    : baseScale;

  const leftAngle = useLeft ? jointAngle(lShoulder, lElbow, lWrist) : null;
  const rightAngle = useRight ? jointAngle(rShoulder, rElbow, rWrist) : null;
  const avgAngle =
    useLeft && useRight ? (leftAngle + rightAngle) / 2 : useLeft ? leftAngle : rightAngle;

  const headToWristPx =
    useLeft && useRight
      ? (distance(lWrist, head) + distance(rWrist, head)) / 2
      : useLeft
        ? distance(lWrist, head)
        : distance(rWrist, head);

  const mirrorOk =
    useLeft && useRight ? Math.abs(leftAngle - rightAngle) <= MIRROR_MAX_DIFF : true;

  const wristY = useLeft && useRight ? (lWrist.y + rWrist.y) / 2 : useLeft ? lWrist.y : rWrist.y;
  const handsNotOverhead = (wristY - shoulder.y) / previewScale >= -0.20;
  const headLevel = Math.abs(head.y - shoulder.y) / previewScale < 0.85;

  let handsBelow = false;
  let inPushupPose = false;
  let reason = "";

  if (hip) {
    const torsoVerticalRatio = (hip.y - shoulder.y) / previewScale;
    const notStanding = torsoVerticalRatio < MAX_TORSO_VERTICAL_RATIO;
    handsBelow = (wristY - hip.y) / previewScale >= HANDS_BELOW_HIP_MIN;

    if (!notStanding) {
      reason = "Standing detected — get down into push-up pose.";
    } else if (!handsBelow || !handsNotOverhead) {
      reason = "Place hands on the floor below shoulder/hip level.";
    } else if (!headLevel) {
      reason = "Keep your head aligned with your shoulders.";
    } else {
      inPushupPose = true;
      pushup.lastHipValidAt = now;
    }
  } else {
    // Hips temporarily occluded (common at bottom of front-view push-up): keep tracking briefly.
    const recentlyValid =
      pushup.armed ||
      (pushup.lastHipValidAt > 0 && now - pushup.lastHipValidAt <= HIP_OCCLUSION_MEMORY_MS);

    if (recentlyValid && handsNotOverhead && headLevel) {
      handsBelow = true;
      inPushupPose = true;
    } else {
      reason = "Step back slightly so your hips are visible in the frame.";
    }
  }

  // Only update refScale while in a valid push-up pose so standing/walking frames never skew scale.
  let scale = previewScale;
  if (inPushupPose) {
    const dt = pushup.lastValidAt ? Math.min(250, Math.max(1, now - pushup.lastValidAt)) : 33;
    if (!pushup.refScale) {
      pushup.refScale = baseScale;
    } else if (baseScale > pushup.refScale) {
      pushup.refScale = pushup.refScale * 0.65 + baseScale * 0.35;
    } else {
      const decay = 1 - Math.exp(-dt / SCALE_DECAY_TAU_MS);
      pushup.refScale += decay * (baseScale - pushup.refScale);
    }
    scale = Math.min(baseScale * 1.45, Math.max(baseScale, pushup.refScale * 0.9));
  }

  const prox = headToWristPx / scale;

  return {
    inPushupPose,
    reason,
    armLength: armLengthPx / maxDim,
    leftAngle,
    rightAngle,
    avgAngle,
    prox,
    mirrorOk,
    handsBelow,
    trackedArms: useLeft && useRight ? "L+R" : useLeft ? "L" : "R",
  };
}

function isVisible(point, minVisibility = ARM_VISIBILITY_MIN) {
  return Boolean(point && (point.visibility ?? 1) >= minVisibility);
}

function toPixelPoint(point, width, height) {
  return {
    x: point.x * width,
    y: point.y * height,
    z: (point.z ?? 0) * width,
    visibility: point.visibility ?? 1,
  };
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
      upAngleMin: UP_ANGLE_MIN,
      downAngleMax: DOWN_ANGLE_MAX,
      proxUpMin: PROX_UP_MIN,
      proxDownMax: PROX_DOWN_MAX,
      mirrorMaxDiff: MIRROR_MAX_DIFF,
      handsBelowHipMin: HANDS_BELOW_HIP_MIN,
    };
  }

  if (choice === "all" || choice === "counter") {
    data.counter = {
      count: pushup.count,
      armed: pushup.armed,
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

  const importedCount = Number.isFinite(data.counter?.count)
    ? Math.max(0, data.counter.count)
    : 0;
  resetPushupState(importedCount);

  els.armValues.textContent =
    `DOWN ≤${DOWN_ANGLE_MAX}° · UP ≥${UP_ANGLE_MIN}° · prox ≤${PROX_DOWN_MAX} / ≥${PROX_UP_MIN}`;
  setPosePrompt(null);
  setCounterStatus("Imported. Start push-ups!", "good");

  state.lastLandmarks = cleanFrame(data.latestDots) || [];
  state.landmarkHistory = Array.isArray(data.recentDots)
    ? data.recentDots.map(cleanFrame).filter(Boolean).slice(-LANDMARK_HISTORY_LIMIT)
    : [];
  const importedCaptures = Array.isArray(data.capturedDots)
    ? data.capturedDots
        .map((capture, index) => ({
          id: Number.isFinite(capture?.id) ? capture.id : index + 1,
          capturedAt:
            typeof capture?.capturedAt === "string" ? capture.capturedAt : new Date().toISOString(),
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

  els.repCount.textContent = String(pushup.count);
  els.hudReps.textContent = String(pushup.count);
  els.calibrationPill.hidden = true;
  setCalibrationProgress(100);
}

function schedulePoseOptions() {
  if (optionsTimer !== null) clearTimeout(optionsTimer);
  optionsTimer = setTimeout(() => {
    optionsTimer = null;
    if (state.running) {
      // Defer into detectFrame so setOptions never collides with an in-flight pose.send.
      state.optionsDirty = true;
    } else {
      applyPoseOptions().catch((error) => {
        setMessage(`Could not update tracker settings: ${error.message || error}`, "error");
      });
    }
  }, 160);
}

async function applyPoseOptions() {
  if (!state.pose) return;

  const confidence = Math.min(
    0.95,
    Math.max(0.1, (Number(els.confidence.value) || DEFAULT_CONFIDENCE_PCT) / 100),
  );
  // Use Full model (1) even on mobile for reliable prone/push-up tracking,
  // and keep tracking confidence lower than detection to avoid mid-rep dropouts.
  await state.pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: els.smooth.checked,
    minDetectionConfidence: confidence,
    minTrackingConfidence: Math.max(0.2, Math.round(confidence * 65) / 100),
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
