import {
  FilesetResolver,
  PoseLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
import {
  createCurlQualitySample,
  CurlAttemptTracker,
  validateCurlQualityModel,
} from "./curl-quality.js";

const drills = [
  {
    id: "good_curl_front",
    exercise: "biceps_curl",
    label: "good_form",
    angle: "front",
    captureType: "set",
    title: "Curl estricto",
    target: "Objetivo: 1 sesión de 8 repeticiones válidas",
    cues: ["Codo estable", "Torso quieto", "Rango completo", "Bajada controlada"],
  },
];

const WORKOUT_SETS = 1;
const REPS_PER_SET = 8;
const WORKOUT_HISTORY_KEY = "curlVisionWorkoutHistory";
const NEXT_SESSION_PLAN_KEY = "curlVisionNextSessionPlan";
const PROFILE_ID_KEY = "curlVisionProfileId";
const MAX_HISTORY_SESSIONS = 100;
const recoveryPlan = [
  { title: "Esta noche", text: "Busca al menos 7 horas de sueño y mantén un horario regular para favorecer la recuperación." },
  { title: "Antes de repetir bíceps", text: "Deja 24–48 h y empieza la sesión siguiente solo si el brazo se siente recuperado y no hay dolor agudo." },
  { title: "Durante la sesión 2", text: "Descansa 90–120 s entre series; conserva 1–2 repeticiones en reserva y detente al perder la técnica." },
];
const nutritionPlan = [
  { time: "Después de entrenar", meal: "Proteína + carbohidrato", example: "Yogur con avena y fruta, o pollo/tofu con arroz y verduras." },
  { time: "Comidas principales", meal: "20–40 g de proteína por comida", example: "Alterna huevos, lácteos, pescado, pollo, legumbres, tofu, nueces y semillas." },
  { time: "Antes de la sesión 2", meal: "Energía fácil de digerir", example: "1–3 h antes: avena con fruta y yogur, o arroz con una fuente de proteína." },
  { time: "Todo el día", meal: "Agua y alimentos variados", example: "Bebe con regularidad y combina fruta, verdura, granos, proteína y lácteos o soya fortificada." },
];
const trainedMuscles = [
  { name: "Bíceps braquial", role: "Principal", level: "primary" },
  { name: "Braquial", role: "Secundario", level: "secondary" },
  { name: "Braquiorradial y antebrazo", role: "Secundario", level: "secondary" },
  { name: "Deltoide anterior y core", role: "Estabilizador", level: "stabilizer" },
];

const initialWorkoutHistory = loadWorkoutHistory();
const initialSessionPlan = loadNextSessionPlan()
  || defaultSessionPlan(highestSessionNumber(initialWorkoutHistory) + 1);
const initialWorkoutId = loadActiveWorkoutId(initialWorkoutHistory);

const state = {
  selectedIndex: 0,
  stream: null,
  cameraStartPromise: null,
  facingMode: "user",
  recorder: null,
  recorderMimeType: "",
  chunks: [],
  recording: false,
  recordingStartedAt: null,
  startedAt: 0,
  timerInterval: 0,
  workoutId: initialWorkoutId,
  clipCount: 0,
  azureUploadCount: 0,
  poseLandmarker: null,
  poseLoading: false,
  poseLoadPromise: null,
  poseWarmupPromise: null,
  poseWarmed: false,
  trackingReadyPromise: null,
  curlQualityModel: null,
  curlQualityLoadPromise: null,
  curlQualityTracker: null,
  workoutPreparing: false,
  liveActive: false,
  liveStartedAt: 0,
  liveTimerInterval: 0,
  liveAnimationFrame: 0,
  lastVideoTime: -1,
  currentSetReps: 0,
  totalReps: 0,
  targetReps: REPS_PER_SET,
  curlPhase: "unknown",
  selectedArm: "auto",
  voiceEnabled: true,
  lastSpokenRep: 0,
  lastMotivationAt: 0,
  lastSpokenCue: "",
  lastCueAt: 0,
  briefingUntil: 0,
  torsoAnchorX: null,
  completedSets: 0,
  setRecorded: false,
  workoutStartedAt: 0,
  workoutCompleted: false,
  setStartedAt: 0,
  setAngles: [],
  setWarnings: 0,
  formWarnings: 0,
  goodReps: 0,
  attemptedReps: 0,
  rejectedReps: 0,
  setAttemptedReps: 0,
  setRejectedReps: 0,
  rejectionReasons: {},
  qualityScores: [],
  setQualityScores: [],
  lastFormWarning: "",
  angleSamples: [],
  setHistory: [],
  workoutHistory: initialWorkoutHistory,
  profileId: loadProfileId(),
  sessionNumber: initialSessionPlan.sessionNumber,
  activeSessionPlan: initialSessionPlan,
  nextSessionPlan: null,
  completionScheduled: false,
  sessionIntroSpoken: false,
  countingEnabled: false,
  countdownActive: false,
  speechRunId: 0,
  speechQueue: [],
  speechActive: false,
  speechGeneration: 0,
  speechWatchdog: 0,
  activeUtterance: null,
  activeSpeechItem: null,
  briefingFinished: false,
  briefingMinimumUntil: 0,
  countdownTimer: 0,
  voicePhase: "idle",
  trackingStarted: false,
  lastInferenceAt: 0,
  autoRecordAfterCountdown: true,
  smoothedAngle: null,
  phaseCandidate: "unknown",
  phaseCandidateFrames: 0,
  lastRepAt: 0,
  currentDashboardSummary: null,
};

const els = {
  preview: document.getElementById("preview"),
  overlay: document.getElementById("pose-overlay"),
  status: document.getElementById("camera-status"),
  timer: document.getElementById("timer"),
  dot: document.getElementById("record-dot"),
  steps: document.getElementById("steps"),
  drillTitle: document.getElementById("drill-title"),
  panelTitle: document.getElementById("panel-title"),
  target: document.getElementById("target"),
  counter: document.getElementById("counter"),
  cues: document.getElementById("cues"),
  sessionId: document.getElementById("session-id"),
  label: document.getElementById("label"),
  clipCount: document.getElementById("clip-count"),
  cloudStatus: document.getElementById("cloud-status"),
  previous: document.getElementById("previous"),
  next: document.getElementById("next"),
  record: document.getElementById("record"),
  downloads: document.getElementById("downloads"),
  videoDownload: document.getElementById("video-download"),
  metadataDownload: document.getElementById("metadata-download"),
  azureSas: document.getElementById("azure-sas"),
  saveAzure: document.getElementById("save-azure"),
  newSession: document.getElementById("new-session"),
  dashboardOpenHistory: document.getElementById("dashboard-open-history"),
  cameraStart: document.getElementById("camera-start"),
  liveStatus: document.getElementById("live-status"),
  liveReps: document.getElementById("live-reps"),
  liveRejected: document.getElementById("live-rejected"),
  liveAngle: document.getElementById("live-angle"),
  liveTime: document.getElementById("live-time"),
  liveProgressBar: document.getElementById("live-progress-bar"),
  liveCoach: document.getElementById("live-coach"),
  liveStart: document.getElementById("live-start"),
  liveReset: document.getElementById("live-reset"),
  switchCamera: document.getElementById("switch-camera"),
  voiceToggle: document.getElementById("voice-toggle"),
  workoutProgress: document.getElementById("workout-progress"),
  stepStart: document.getElementById("step-start"),
  stepComplete: document.getElementById("step-complete"),
  finishWorkout: document.getElementById("finish-workout"),
  resultsDashboard: document.getElementById("results-dashboard"),
  dashboardClose: document.getElementById("dashboard-close"),
  dashboardMetrics: document.getElementById("dashboard-metrics"),
  dashboardTitle: document.getElementById("dashboard-title"),
  dashboardSubtitle: document.getElementById("dashboard-subtitle"),
  dashboardSessionStatus: document.getElementById("dashboard-session-status"),
  dashboardSetList: document.getElementById("dashboard-set-list"),
  nextRoutine: document.getElementById("next-routine"),
  dashboardHistory: document.getElementById("dashboard-history"),
  dashboardHistoryCount: document.getElementById("dashboard-history-count"),
  dashboardNewSession: document.getElementById("dashboard-new-session"),
  dashboardSyncStatus: document.getElementById("dashboard-sync-status"),
  recoveryPlan: document.getElementById("recovery-plan"),
  dashboardSaveLog: document.getElementById("dashboard-save-log"),
  progressScore: document.getElementById("progress-score"),
  progressHighlights: document.getElementById("progress-highlights"),
  progressChart: document.getElementById("progress-chart"),
  progressPeriod: document.getElementById("progress-period"),
  nextSessionDate: document.getElementById("next-session-date"),
  nextSessionGoal: document.getElementById("next-session-goal"),
  nextSessionNote: document.getElementById("next-session-note"),
  dashboardTabs: Array.from(document.querySelectorAll("[data-dashboard-page]")),
  dashboardPages: Array.from(document.querySelectorAll("[data-dashboard-view]")),
  bodySessionLabel: document.getElementById("body-session-label"),
  bodyMuscleList: document.getElementById("body-muscle-list"),
  bodyHistoryStats: document.getElementById("body-history-stats"),
  nutritionPlan: document.getElementById("nutrition-plan"),
};

const poseModelUrl =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
const poseWasmUrl = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const curlQualityModelUrl = "./models/curl-quality-v1.json";
const POSE_INFERENCE_INTERVAL_MS = 66;
const armLandmarks = {
  left: { shoulder: 11, elbow: 13, wrist: 15 },
  right: { shoulder: 12, elbow: 14, wrist: 16 },
};

const apiBase = (window.CURL_VISION_API_BASE || "").trim().replace(/\/$/, "");
const configContainerSasUrl = window.CURL_VISION_CONTAINER_SAS_URL || "";

function containerSasUrl() {
  return (configContainerSasUrl || localStorage.getItem("curlVisionContainerSasUrl") || "").trim();
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

function workoutStamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replaceAll("-", "").replace("T", "_").replaceAll(":", "");
}

function createWorkoutId() {
  const suffix = window.crypto?.randomUUID
    ? window.crypto.randomUUID().split("-")[0]
    : Math.random().toString(16).slice(2, 10);
  return `gym_good_${workoutStamp()}_${suffix}`;
}

function loadWorkoutId() {
  const stored = localStorage.getItem("curlVisionWorkoutId");
  if (stored) return stored;
  const created = createWorkoutId();
  localStorage.setItem("curlVisionWorkoutId", created);
  return created;
}

function loadActiveWorkoutId(history) {
  const stored = loadWorkoutId();
  if (!history.some((item) => item?.id === stored)) return stored;
  const created = createWorkoutId();
  localStorage.setItem("curlVisionWorkoutId", created);
  return created;
}

function activeDrill() {
  return drills[state.selectedIndex];
}

function sessionId() {
  return state.workoutId || `gym_good_${todayStamp()}`;
}

function loadWorkoutHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(WORKOUT_HISTORY_KEY) || "[]");
    return Array.isArray(stored) ? stored.slice(0, MAX_HISTORY_SESSIONS) : [];
  } catch (error) {
    return [];
  }
}

function loadNextSessionPlan() {
  try {
    const stored = JSON.parse(localStorage.getItem(NEXT_SESSION_PLAN_KEY) || "null");
    return stored && Array.isArray(stored.exercises) ? stored : null;
  } catch (error) {
    return null;
  }
}

function loadProfileId() {
  const stored = localStorage.getItem(PROFILE_ID_KEY) || "";
  if (/^web_[a-f0-9]{32}$/.test(stored)) return stored;
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const created = `web_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
  localStorage.setItem(PROFILE_ID_KEY, created);
  return created;
}

function highestSessionNumber(history) {
  const explicit = history.reduce((highest, item) => Math.max(highest, Number(item.sessionNumber) || 0), 0);
  return Math.max(explicit, history.length);
}

function defaultSessionPlan(sessionNumber = 1) {
  return {
    sessionNumber,
    focus: "Bíceps y control técnico",
    guidedExercise: "Curl estricto",
    guidedReps: REPS_PER_SET,
    goal: "Establecer una base limpia: ocho repeticiones controladas sin balancear el torso.",
    exercises: [
      { name: "Curl estricto", detail: "Bloque IA · 8 reps · 90 s", cue: "RIR 2" },
      { name: "Curl martillo", detail: "2 series · 10 reps · 90 s", cue: "Muñeca neutra" },
      { name: "Extensión de tríceps", detail: "2 series · 10 reps · 90 s", cue: "Sin impulso" },
    ],
    note: "Javier medirá primero el bloque de curl. Detén cualquier ejercicio si aparece dolor agudo o si pierdes el control.",
  };
}

function mergeWorkoutHistories(...historyGroups) {
  const byId = new Map();
  historyGroups.flat().forEach((item) => {
    if (!item || typeof item !== "object") return;
    const summary = item.statistics && typeof item.statistics === "object" ? item.statistics : item;
    const id = String(summary.id || summary.session_id || "").trim();
    if (!id) return;
    byId.set(id, { ...byId.get(id), ...summary, id });
  });
  return Array.from(byId.values())
    .sort((left, right) => new Date(right.completedAt || 0) - new Date(left.completedAt || 0))
    .slice(0, MAX_HISTORY_SESSIONS);
}

function canFinishWorkout() {
  return state.completedSets >= WORKOUT_SETS && state.currentSetReps >= REPS_PER_SET;
}

function currentSetNumber() {
  return Math.min(state.completedSets + 1, WORKOUT_SETS);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function formScore() {
  const attempts = Math.max(state.attemptedReps, state.totalReps, 1);
  return Math.round(clamp((state.goodReps / attempts) * 100, 0, 100));
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "short" }).format(new Date(value));
  } catch (error) {
    return "Hoy";
  }
}

function nextSessionDate(value) {
  const tomorrow = new Date(value || Date.now());
  tomorrow.setDate(tomorrow.getDate() + 1);
  try {
    return new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "2-digit", month: "short" }).format(tomorrow);
  } catch (error) {
    return "Mañana";
  }
}

function historyFor(summary) {
  return mergeWorkoutHistories([summary], state.workoutHistory);
}

function buildNextSession(summary, history) {
  const rejectedReps = Number(summary.rejectedReps ?? summary.warnings ?? 0);
  const techniqueReady = summary.formScore >= 88 && rejectedReps <= 1;
  const recentAverage = Math.round(average(history.map((item) => Number(item.formScore) || 0)));
  const sessionNumber = Math.max(Number(summary.sessionNumber) || 0, highestSessionNumber(history)) + 1;
  if (techniqueReady) {
    return {
      sessionNumber,
      focus: "Bíceps y brazo · hipertrofia controlada",
      guidedExercise: "Curl estricto",
      guidedReps: REPS_PER_SET,
      goal: "Hipertrofia con progresión controlada · termina la última serie cerca del fallo técnico.",
      exercises: [
        { name: "Curl estricto", detail: "3 series · 8–12 reps · 90 s", cue: "RIR 1–2" },
        { name: "Curl martillo", detail: "3 series · 10–12 reps · 75 s", cue: "RIR 1–2" },
        { name: "Curl inclinado", detail: "2 series · 10–12 reps · 90 s", cue: "Bajada 3 s" },
        { name: "Extensión de tríceps", detail: "3 series · 10–12 reps · 75 s", cue: "Técnica limpia" },
      ],
      note: `Tu técnica fue ${summary.formScore}%. Si completas el máximo de reps en todas las series sin perder forma, aumenta la carga un 2–5% en la siguiente sesión. Media reciente: ${recentAverage}%.`,
    };
  }
  return {
    sessionNumber,
    focus: "Bíceps y brazo · consolidación técnica",
    guidedExercise: "Curl estricto",
    guidedReps: REPS_PER_SET,
    goal: "Consolidar técnica antes de subir carga · no busques el fallo mientras haya avisos de postura.",
    exercises: [
      { name: "Curl estricto", detail: "3 series · 8–10 reps · 120 s", cue: "RIR 2–3" },
      { name: "Curl martillo", detail: "2 series · 10 reps · 90 s", cue: "Muñeca neutra" },
      { name: "Curl inclinado", detail: "2 series · 8–10 reps · 120 s", cue: "Rango completo" },
      { name: "Extensión de tríceps", detail: "2 series · 10 reps · 90 s", cue: "Sin balanceo" },
    ],
    note: `Javier no contó ${rejectedReps} intentos por técnica. Repite una carga cómoda y detén la serie cuando aparezca el primer fallo técnico. Media reciente: ${recentAverage}%.`,
  };
}

function renderProgress(summary, history) {
  const avgForm = Math.round(average(history.map((item) => Number(item.formScore) || 0)));
  const totalReps = history.reduce((sum, item) => sum + (Number(item.reps) || 0), 0);
  const bestForm = Math.max(...history.map((item) => Number(item.formScore) || 0), 0);
  const totalMinutes = Math.round(history.reduce((sum, item) => sum + (Number(item.durationSeconds) || 0), 0) / 60);
  const lastItems = history.slice(0, 10).reverse();
  els.progressScore.textContent = `${avgForm}%`;
  els.progressPeriod.textContent = `${history.length} ${history.length === 1 ? "sesión" : "sesiones"}`;
  els.progressHighlights.innerHTML = [
    ["Volumen acumulado", `${totalReps} reps`],
    ["Mejor técnica", `${bestForm}%`],
    ["Tiempo acumulado", `${totalMinutes} min`],
  ].map(([label, value]) => `<div class="progress-highlight"><span>${label}</span><strong>${value}</strong></div>`).join("");
  els.progressChart.innerHTML = lastItems.map((item, index) => {
    const height = Math.max(Number(item.formScore) || 0, 6);
    return `<div class="chart-column"><span class="chart-value">${item.formScore}%</span><div class="chart-bar" style="height:${height}%"></div><small>${formatDate(item.completedAt)}</small></div>`;
  }).join("");
}

function renderSaveLog(status, detail) {
  const icon = status === "saved" ? "✓" : status === "pending" ? "↻" : "•";
  els.dashboardSaveLog.innerHTML = `
    <div class="save-log-item"><span class="save-log-icon">✓</span><span><strong>Sesión capturada</strong><small>Estadísticas calculadas en este dispositivo</small></span></div>
    <div class="save-log-item ${status === "saved" ? "saved" : status === "pending" ? "pending" : ""}"><span class="save-log-icon">${icon}</span><span><strong>${status === "saved" ? "Guardada en Azure" : status === "pending" ? "Azure pendiente" : "Guardando en Azure…"}</strong><small>${detail || "Sincronizando el resumen de la sesión"}</small></span></div>
  `;
}

function persistHistory() {
  state.workoutHistory = mergeWorkoutHistories(state.workoutHistory).slice(0, MAX_HISTORY_SESSIONS);
  localStorage.setItem(WORKOUT_HISTORY_KEY, JSON.stringify(state.workoutHistory));
}

function setProgressText() {
  const setNumber = state.workoutCompleted
    ? WORKOUT_SETS
    : Math.min(state.currentSetReps >= REPS_PER_SET ? Math.max(state.completedSets, 1) : currentSetNumber(), WORKOUT_SETS);
  els.workoutProgress.textContent = `Sesión ${state.sessionNumber} · ${state.currentSetReps}/${REPS_PER_SET}`;
  els.stepStart.classList.toggle("active", !state.workoutStartedAt && !state.workoutCompleted);
  els.stepStart.classList.toggle("done", Boolean(state.workoutStartedAt));
  els.stepComplete.classList.toggle("active", Boolean(state.workoutStartedAt) && !state.workoutCompleted);
  els.stepComplete.classList.toggle("done", state.workoutCompleted);
}

function render() {
  const drill = activeDrill();
  els.drillTitle.textContent = drill.title;
  els.panelTitle.textContent = drill.title;
  els.target.textContent = drill.target;
  els.counter.textContent = `${state.selectedIndex + 1}/${drills.length}`;
  els.sessionId.textContent = sessionId();
  els.label.textContent = `${drill.exercise} / ${drill.label} / ${drill.angle}`;
  els.clipCount.textContent = String(state.clipCount);
  els.cloudStatus.textContent = apiBase || containerSasUrl() ? "azure ready" : "local";
  els.record.textContent = state.recording
    ? "Detener"
    : drill.captureType === "full_session"
      ? "Grabar sesion"
      : "Grabar set";
  els.record.classList.toggle("stop", state.recording);
  els.dot.classList.toggle("active", state.recording);
  els.record.disabled = state.workoutPreparing
    || state.workoutCompleted
    || (state.liveActive && !state.countingEnabled)
    || (state.completedSets >= WORKOUT_SETS && state.currentSetReps >= REPS_PER_SET && !state.recording);
  els.newSession.disabled = state.workoutPreparing || state.recording || state.liveActive;
  els.cameraStart.hidden = Boolean(state.stream);
  els.liveStart.disabled = state.workoutPreparing;
  if (state.workoutPreparing) {
    els.liveStart.textContent = "Preparando IA…";
  }
  els.switchCamera.disabled = state.workoutPreparing || !state.stream || state.recording;
  els.liveReset.disabled = state.workoutPreparing || state.recording || state.workoutCompleted || state.completedSets >= WORKOUT_SETS;
  els.finishWorkout.disabled = !canFinishWorkout() || state.recording || state.workoutCompleted;
  els.finishWorkout.textContent = state.workoutCompleted ? "Entrenamiento finalizado" : "Finalizar entrenamiento";
  setProgressText();
  if ("speechSynthesis" in window) {
    els.voiceToggle.textContent = state.voiceEnabled ? "Voz ON" : "Voz OFF";
    els.voiceToggle.disabled = false;
  } else {
    els.voiceToggle.textContent = "Voz no disponible";
    els.voiceToggle.disabled = true;
  }

  els.steps.innerHTML = "";
  drills.forEach((_, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `step ${index === state.selectedIndex ? "active" : ""}`;
    button.addEventListener("click", () => {
      if (!state.recording) {
        state.selectedIndex = index;
        render();
      }
    });
    els.steps.appendChild(button);
  });

  els.cues.innerHTML = "";
  drill.cues.forEach((cue) => {
    const pill = document.createElement("span");
    pill.className = "cue";
    pill.textContent = cue;
    els.cues.appendChild(pill);
  });
}

async function startCamera() {
  if (state.cameraStartPromise) return state.cameraStartPromise;
  state.cameraStartPromise = openCamera();
  try {
    return await state.cameraStartPromise;
  } finally {
    state.cameraStartPromise = null;
  }
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    els.status.textContent = "Cámara no compatible";
    updateLiveDashboard({
      coach: "Abre Javier AI en Safari con HTTPS para usar la cámara del iPhone.",
      status: "sin cámara",
      statusVariant: "warning",
    });
    return;
  }

  try {
    stopStream();
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: state.facingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    els.preview.srcObject = state.stream;
    await els.preview.play();
    state.poseWarmed = false;
    resizeOverlay();
    els.status.textContent = state.facingMode === "user" ? "Camara frontal lista" : "Camara trasera lista";
    render();
    prepareTrackingPipeline({ silent: true }).catch((error) => {
      console.warn("Background tracking preparation failed", error);
    });
  } catch (error) {
    els.status.textContent = "No se pudo abrir la camara";
    updateLiveDashboard({
      coach: "No se pudo abrir la cámara. En iPhone abre el enlace con HTTPS y permite el acceso a la cámara.",
      status: "sin camara",
      statusVariant: "warning",
    });
    render();
    console.warn("Camera failed", error);
  }
}

function stopStream() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
}

function formatTime(seconds) {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  const rest = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function startTimer() {
  state.startedAt = Date.now();
  state.timerInterval = window.setInterval(() => {
    els.timer.textContent = formatTime((Date.now() - state.startedAt) / 1000);
  }, 250);
}

function stopTimer() {
  window.clearInterval(state.timerInterval);
  els.timer.textContent = "00:00";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resizeOverlay() {
  if (!els.overlay || !els.preview) return;
  const rect = els.preview.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(Math.round(rect.width * dpr), 1);
  const height = Math.max(Math.round(rect.height * dpr), 1);
  if (els.overlay.width !== width || els.overlay.height !== height) {
    els.overlay.width = width;
    els.overlay.height = height;
  }
}

function clearOverlay() {
  if (!els.overlay) return;
  const ctx = els.overlay.getContext("2d");
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
}

function setLiveStatus(text, variant = "") {
  els.liveStatus.textContent = text;
  els.liveStatus.classList.toggle("active", variant === "active");
  els.liveStatus.classList.toggle("warning", variant === "warning");
}

function updateLiveTime() {
  if (!state.liveStartedAt) {
    els.liveTime.textContent = "00:00";
    return;
  }
  els.liveTime.textContent = formatTime((Date.now() - state.liveStartedAt) / 1000);
}

function updateLiveDashboard({ angle = null, coach = null, status = null, statusVariant = "" } = {}) {
  els.liveReps.textContent = String(state.totalReps);
  if (els.liveRejected) els.liveRejected.textContent = String(state.rejectedReps);
  els.liveAngle.textContent = angle === null ? "--" : `${Math.round(angle)}°`;
  els.liveProgressBar.style.width = `${clamp(((state.completedSets * REPS_PER_SET + state.currentSetReps) / (WORKOUT_SETS * REPS_PER_SET)) * 100, 0, 100)}%`;
  setProgressText();
  if (coach) els.liveCoach.textContent = coach;
  if (status) setLiveStatus(status, statusVariant);
  updateLiveTime();
}

function spanishVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  return voices.find((voice) => voice.lang.toLowerCase() === "es-mx")
    || voices.find((voice) => voice.lang.toLowerCase().startsWith("es"))
    || null;
}

function clearSpeechQueue({ cancel = true } = {}) {
  state.speechQueue.length = 0;
  state.speechGeneration += 1;
  state.speechActive = false;
  state.activeUtterance = null;
  state.activeSpeechItem = null;
  window.clearTimeout(state.speechWatchdog);
  if (cancel && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

function drainSpeechQueue() {
  if (state.speechActive || !state.speechQueue.length || !("speechSynthesis" in window)) return;
  const item = state.speechQueue.shift();
  if (!item || item.generation !== state.speechGeneration) {
    drainSpeechQueue();
    return;
  }

  const utterance = new SpeechSynthesisUtterance(item.text);
  utterance.lang = "es-MX";
  utterance.rate = item.rate || 1.06;
  utterance.pitch = 1.02;
  const voice = spanishVoice();
  if (voice) utterance.voice = voice;

  state.speechActive = true;
  state.activeUtterance = utterance;
  state.activeSpeechItem = item;
  const runId = ++state.speechRunId;
  let settled = false;
  const settle = (kind) => {
    if (settled || item.generation !== state.speechGeneration || runId !== state.speechRunId) return;
    settled = true;
    window.clearTimeout(state.speechWatchdog);
    state.speechActive = false;
    state.activeUtterance = null;
    state.activeSpeechItem = null;
    if (kind === "end" && item.onend) item.onend();
    if (kind === "error" && item.onerror) item.onerror();
    window.setTimeout(drainSpeechQueue, item.pauseAfter ?? 90);
  };
  utterance.onend = () => settle("end");
  utterance.onerror = () => settle("error");

  const words = item.text.trim().split(/\s+/).filter(Boolean).length;
  const watchdogMs = Math.max(3500, words * 650);
  state.speechWatchdog = window.setTimeout(() => {
    if (item.generation !== state.speechGeneration) return;
    window.speechSynthesis.cancel();
    settle("error");
  }, watchdogMs);

  try {
    window.speechSynthesis.speak(utterance);
  } catch (error) {
    settle("error");
  }
}

function speak(text, {
  force = false,
  onend = null,
  onerror = null,
  channel = "workout",
  priority = false,
  dedupeKey = "",
  pauseAfter = 90,
  rate = 1.06,
} = {}) {
  const sequenceLocked = state.voicePhase === "briefing" || state.voicePhase === "countdown";
  if (sequenceLocked && channel !== "sequence" && channel !== "control") return null;
  if (state.voicePhase === "complete" && !["complete", "control"].includes(channel)) return null;
  if ((!state.voiceEnabled && !force) || !("speechSynthesis" in window)) {
    if (onend) window.setTimeout(onend, 0);
    return null;
  }
  if (dedupeKey) {
    const duplicateActive = state.activeSpeechItem?.dedupeKey === dedupeKey;
    const duplicateQueued = state.speechQueue.some((item) => item.dedupeKey === dedupeKey);
    if (duplicateActive || duplicateQueued) return null;
  }
  const item = {
    text: String(text || "").trim(),
    force,
    onend,
    onerror,
    channel,
    dedupeKey,
    pauseAfter,
    rate,
    generation: state.speechGeneration,
  };
  if (!item.text) {
    if (onend) window.setTimeout(onend, 0);
    return null;
  }
  if (priority) state.speechQueue.unshift(item);
  else state.speechQueue.push(item);
  drainSpeechQueue();
  return item;
}

function capitalized(value) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function sessionDateLabel() {
  try {
    return new Intl.DateTimeFormat("es-MX", {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(new Date());
  } catch (error) {
    return "hoy";
  }
}

function announceSessionBriefing({ continuation = false } = {}) {
  const dateLabel = sessionDateLabel();
  const plan = state.activeSessionPlan || defaultSessionPlan(state.sessionNumber);
  const exerciseNames = plan.exercises.slice(0, 3).map((exercise) => exercise.name).join(", ");
  const speechParts = continuation
    ? [
      `Continuamos con la sesión ${state.sessionNumber}.`,
      "Completa las repeticiones pendientes de curl con el torso quieto y una bajada controlada.",
    ]
    : [
      `Hola Omar. Sesión ${state.sessionNumber}. Hoy es ${dateLabel} y vamos a trabajar ${plan.focus.toLowerCase()}.`,
      `Tu rutina incluye ${exerciseNames}. Primero te guiaré en un bloque de ${REPS_PER_SET} repeticiones válidas de curl estricto.`,
      "Mantén el codo estable, el torso quieto y controla la bajada.",
      "Validaré cada repetición cuando vuelvas a extender el brazo. Si la técnica falla, no la contaré y te diré qué corregir.",
      "Ponte en posición. Enseguida contaré uno, dos, tres, y empezaremos.",
    ];
  const visiblePlan = speechParts.join(" ");
  els.liveCoach.textContent = visiblePlan;
  setLiveStatus(continuation ? "continuamos" : "briefing", "active");
  state.briefingUntil = Number.POSITIVE_INFINITY;
  state.briefingMinimumUntil = 0;
  state.briefingFinished = false;
  state.voicePhase = "briefing";
  window.clearTimeout(state.countdownTimer);
  state.countingEnabled = false;
  state.countdownActive = false;
  clearSpeechQueue();
  speechParts.forEach((part, index) => {
    const isLast = index === speechParts.length - 1;
    speak(part, {
      onend: isLast ? queueCountdownAfterBriefing : null,
      onerror: isLast ? queueCountdownAfterBriefing : null,
      channel: "sequence",
      rate: 1.04,
      pauseAfter: isLast ? 80 : 35,
    });
  });
  state.sessionIntroSpoken = true;
}

async function queueCountdownAfterBriefing() {
  if (state.briefingFinished) return;
  state.briefingFinished = true;
  window.clearTimeout(state.countdownTimer);
  const readiness = state.trackingReadyPromise || prepareTrackingPipeline({ silent: false });
  const readinessNotice = window.setTimeout(() => {
    if (state.voicePhase === "briefing" && state.liveActive) {
      setLiveStatus("terminando IA", "warning");
    }
  }, 350);
  try {
    await readiness;
  } catch (error) {
    window.clearTimeout(readinessNotice);
    state.voicePhase = "idle";
    updateLiveDashboard({
      coach: "No pude preparar el seguimiento. Revisa internet y pulsa Continuar entrenamiento.",
      status: "error",
      statusVariant: "warning",
    });
    console.error("Tracking preparation failed", error);
    return;
  }
  window.clearTimeout(readinessNotice);
  if (!state.liveActive || state.workoutCompleted) return;
  state.countdownTimer = window.setTimeout(startCountdown, 80);
}

function startCountdown() {
  if (state.countdownActive || state.workoutCompleted || !state.briefingFinished) return;
  state.countdownActive = true;
  state.voicePhase = "countdown";
  state.countingEnabled = false;
  state.lastSpokenRep = 0;
  state.lastSpokenCue = "";
  let activated = false;
  const activateTracking = () => {
    if (activated || !state.liveActive || state.workoutCompleted) return;
    activated = true;
    state.countdownActive = false;
    state.voicePhase = "workout";
    state.briefingUntil = 0;
    startTrackingAfterCountdown()
      .then((started) => {
        if (!started) return;
        els.liveCoach.textContent = "Ahora sí. Empieza extendido; subir y volver a bajar completa una repetición válida.";
        setLiveStatus("en vivo", "active");
      })
      .catch((error) => {
        console.error("Tracking start failed", error);
        state.countingEnabled = false;
        updateLiveDashboard({
          coach: "No pude iniciar el seguimiento. Pulsa Continuar entrenamiento.",
          status: "error",
          statusVariant: "warning",
        });
      });
  };
  els.liveCoach.textContent = "Prepárate. La sesión comienza después de la cuenta atrás.";
  setLiveStatus("preparando", "warning");
  speak("Uno", { channel: "sequence", pauseAfter: 260, rate: 0.98 });
  speak("Dos", { channel: "sequence", pauseAfter: 260, rate: 0.98 });
  speak("Tres. Ahora empieza.", {
    channel: "sequence",
    onend: activateTracking,
    onerror: activateTracking,
    pauseAfter: 0,
    rate: 0.98,
  });
}

function announceRep({ onComplete = null } = {}) {
  if (state.currentSetReps <= state.lastSpokenRep) return;
  state.lastSpokenRep = state.currentSetReps;
  const numberWords = ["Cero", "Uno", "Dos", "Tres", "Cuatro", "Cinco", "Seis", "Siete", "Ocho"];
  const isComplete = state.currentSetReps >= state.targetReps;
  speak(isComplete
    ? `${numberWords[state.currentSetReps] || state.currentSetReps}. Serie completada.`
    : (numberWords[state.currentSetReps] || String(state.currentSetReps)), {
    channel: "rep",
    priority: true,
    pauseAfter: 35,
    rate: 1.08,
    onend: isComplete ? onComplete : null,
    onerror: isComplete ? onComplete : null,
  });
}

function motivate() {
  const now = Date.now();
  if (state.currentSetReps === 0 || now - state.lastMotivationAt < 22000) return;
  state.lastMotivationAt = now;
  speak(state.currentSetReps >= state.targetReps - 2
    ? "Muy bien. Las últimas cuentan; aprieta y controla la bajada."
    : "Buen ritmo. Mantén el torso quieto y sigue fuerte.", { channel: "coaching", dedupeKey: "motivation" });
}

function speakFormCue(message) {
  const now = Date.now();
  if (!state.countingEnabled) return;
  if (now < state.briefingUntil) return;
  if (now - state.lastCueAt < 8000 || message === state.lastSpokenCue) return;
  state.lastCueAt = now;
  state.lastSpokenCue = message;
  speak(message, { channel: "coaching", dedupeKey: `form:${message}` });
}

async function loadPoseModel({ silent = false } = {}) {
  if (state.poseLandmarker) return state.poseLandmarker;
  if (state.poseLoadPromise) return state.poseLoadPromise;

  state.poseLoading = true;
  if (!silent) {
    updateLiveDashboard({
      status: "cargando",
      statusVariant: "warning",
    });
  }

  state.poseLoadPromise = (async () => {
    const vision = await FilesetResolver.forVisionTasks(poseWasmUrl);
    state.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: poseModelUrl,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    state.poseLoading = false;
    return state.poseLandmarker;
  })();

  try {
    return await state.poseLoadPromise;
  } catch (error) {
    state.poseLoading = false;
    state.poseLoadPromise = null;
    if (!silent) {
      updateLiveDashboard({
        coach: "No pude cargar el detector de pose. Revisa internet y vuelve a intentar.",
        status: "sin pose",
        statusVariant: "warning",
      });
    }
    throw error;
  }
}

async function loadCurlQualityModel({ silent = false } = {}) {
  if (state.curlQualityModel && state.curlQualityTracker) return state.curlQualityModel;
  if (state.curlQualityLoadPromise) return state.curlQualityLoadPromise;

  state.curlQualityLoadPromise = (async () => {
    const response = await fetch(curlQualityModelUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`curl quality model ${response.status}`);
    const model = validateCurlQualityModel(await response.json());
    state.curlQualityModel = model;
    state.curlQualityTracker = new CurlAttemptTracker(model);
    return model;
  })();

  try {
    return await state.curlQualityLoadPromise;
  } catch (error) {
    state.curlQualityLoadPromise = null;
    state.curlQualityModel = null;
    state.curlQualityTracker = null;
    if (!silent) {
      updateLiveDashboard({
        coach: "No pude cargar el modelo de calidad de curl. Revisa la conexión y vuelve a intentar.",
        status: "sin modelo",
        statusVariant: "warning",
      });
    }
    throw error;
  }
}

function preloadTrackingModels({ silent = true } = {}) {
  return Promise.all([
    loadPoseModel({ silent }),
    loadCurlQualityModel({ silent }),
  ]);
}

function waitForVideoFrame(timeoutMs = 2500) {
  if (els.preview.readyState >= 2 && els.preview.videoWidth > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      els.preview.removeEventListener("loadeddata", onLoadedData);
      resolve(ready);
    };
    const onLoadedData = () => finish(true);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    els.preview.addEventListener("loadeddata", onLoadedData, { once: true });
  });
}

async function warmPosePipeline({ silent = true } = {}) {
  if (state.poseWarmed) return true;
  if (state.poseWarmupPromise) return state.poseWarmupPromise;

  state.poseWarmupPromise = (async () => {
    await preloadTrackingModels({ silent });
    if (!state.stream) return false;
    const frameReady = await waitForVideoFrame();
    if (!frameReady || !state.stream || !state.poseLandmarker) return false;
    const timestamp = performance.now();
    state.poseLandmarker.detectForVideo(els.preview, timestamp);
    state.poseWarmed = true;
    state.lastInferenceAt = timestamp;
    state.lastVideoTime = -1;
    return true;
  })();

  try {
    return await state.poseWarmupPromise;
  } finally {
    state.poseWarmupPromise = null;
  }
}

async function prepareTrackingPipeline({ silent = true } = {}) {
  await preloadTrackingModels({ silent });
  const warmed = await warmPosePipeline({ silent });
  if (!warmed) throw new Error("La cámara todavía no tiene un cuadro disponible para la IA.");
  return true;
}

async function startLiveWorkout({ autoRecord = true } = {}) {
  if (state.workoutCompleted) return;
  if (state.workoutPreparing) return;
  if (state.liveActive) {
    stopLiveWorkout("pausado");
    return;
  }

  const wasAlreadyStarted = Boolean(state.workoutStartedAt);
  state.autoRecordAfterCountdown = autoRecord;
  state.workoutPreparing = true;
  updateLiveDashboard({
    coach: "Preparando cámara e IA mientras Javier organiza tu rutina.",
    status: "preparando IA",
    statusVariant: "warning",
  });
  render();

  try {
    const modelsReady = preloadTrackingModels({ silent: true });
    if (!state.stream) await startCamera();
    if (!state.stream) return;

    state.trackingReadyPromise = modelsReady
      .catch(() => preloadTrackingModels({ silent: false }))
      .then(() => prepareTrackingPipeline({ silent: false }));
    await state.trackingReadyPromise;
    if (!state.stream || state.workoutCompleted) return;

    state.liveActive = true;
    if (!state.workoutStartedAt) state.workoutStartedAt = Date.now();
    if (!state.setStartedAt) state.setStartedAt = Date.now();
    state.lastVideoTime = -1;
    state.liveStartedAt = Date.now();
    window.clearInterval(state.liveTimerInterval);
    state.liveTimerInterval = window.setInterval(updateLiveTime, 250);
    els.liveStart.textContent = "Pausar";
    if (!state.sessionIntroSpoken) {
      announceSessionBriefing();
    } else if (wasAlreadyStarted) {
      announceSessionBriefing({ continuation: true });
    }
  } finally {
    state.workoutPreparing = false;
    els.liveStart.disabled = false;
    if (!state.liveActive) {
      els.liveStart.textContent = state.workoutStartedAt ? "Continuar entrenamiento" : "Empezar entrenamiento";
    }
    render();
  }
}

async function startTrackingAfterCountdown() {
  if (!state.liveActive || state.trackingStarted) return false;
  await (state.trackingReadyPromise || prepareTrackingPipeline({ silent: false }));
  if (
    !state.liveActive
    || !state.poseLandmarker
    || !state.curlQualityTracker
    || state.trackingStarted
  ) return false;
  state.countingEnabled = true;
  if (state.autoRecordAfterCountdown && !state.recording) {
    await startRecording();
  }
  if (!state.liveActive || !state.countingEnabled || state.trackingStarted) return false;
  state.trackingStarted = true;
  state.lastVideoTime = -1;
  state.lastInferenceAt = 0;
  predictPose();
  return true;
}

function stopLiveWorkout(message = "pausado") {
  state.liveActive = false;
  state.trackingStarted = false;
  state.countingEnabled = false;
  state.countdownActive = false;
  state.briefingFinished = false;
  state.voicePhase = "idle";
  state.smoothedAngle = null;
  state.curlQualityTracker?.reset();
  window.clearTimeout(state.countdownTimer);
  clearSpeechQueue();
  window.cancelAnimationFrame(state.liveAnimationFrame);
  window.clearInterval(state.liveTimerInterval);
  els.liveStart.textContent = state.workoutStartedAt && !state.workoutCompleted
    ? "Continuar entrenamiento"
    : "Empezar entrenamiento";
  updateLiveDashboard({
    coach: "Entrenamiento pausado. Toca Entrenar en vivo para continuar.",
    status: message,
    statusVariant: "warning",
  });
}

function recordCompletedSet() {
  if (state.setRecorded || state.currentSetReps < REPS_PER_SET) return;
  state.setRecorded = true;
  state.completedSets += 1;
  state.setHistory.push({
    set: state.completedSets,
    reps: state.currentSetReps,
    attempts: state.setAttemptedReps,
    rejectedReps: state.setRejectedReps,
    durationSeconds: Math.round((Date.now() - (state.setStartedAt || Date.now())) / 1000),
    averageAngle: Math.round(average(state.setAngles)),
    averageQuality: Math.round(average(state.setQualityScores)),
    warnings: state.setWarnings,
  });
  const isWorkoutReady = state.completedSets >= WORKOUT_SETS;
  updateLiveDashboard({
    coach: isWorkoutReady
      ? "Objetivo completado. Revisa tus estadísticas o finaliza el entrenamiento."
      : `Set ${state.completedSets} de ${WORKOUT_SETS} completo. Descansa antes del siguiente.`,
    status: isWorkoutReady ? "listo para finalizar" : "set completo",
    statusVariant: isWorkoutReady ? "active" : "warning",
  });
  render();
}

function resetLiveWorkout() {
  state.currentSetReps = 0;
  state.trackingStarted = false;
  state.countingEnabled = false;
  state.countdownActive = false;
  state.briefingFinished = false;
  state.voicePhase = "idle";
  window.clearTimeout(state.countdownTimer);
  state.curlPhase = "unknown";
  state.setRecorded = false;
  state.lastSpokenRep = 0;
  state.lastMotivationAt = 0;
  state.lastSpokenCue = "";
  state.lastCueAt = 0;
  state.briefingUntil = 0;
  state.torsoAnchorX = null;
  state.setStartedAt = state.liveActive ? Date.now() : 0;
  state.setAngles = [];
  state.setWarnings = 0;
  state.setAttemptedReps = 0;
  state.setRejectedReps = 0;
  state.setQualityScores = [];
  state.lastFormWarning = "";
  state.smoothedAngle = null;
  state.phaseCandidate = "unknown";
  state.phaseCandidateFrames = 0;
  state.lastRepAt = 0;
  state.curlQualityTracker?.reset();
  clearSpeechQueue();
  state.liveStartedAt = state.liveActive ? Date.now() : 0;
  clearOverlay();
  updateLiveDashboard({
    angle: null,
    coach: state.completedSets >= WORKOUT_SETS
      ? "Las 8 repeticiones ya están completas. Puedes revisar el dashboard."
      : `Set ${currentSetNumber()} listo. Empieza con el brazo extendido y visible.`,
    status: state.liveActive ? "en vivo" : "pose lista",
    statusVariant: state.liveActive ? "active" : "",
  });
}

function workoutSummary() {
  return {
    id: sessionId(),
    sessionNumber: state.sessionNumber,
    completedAt: new Date().toISOString(),
    sets: state.completedSets,
    reps: state.totalReps,
    attempts: state.attemptedReps,
    rejectedReps: state.rejectedReps,
    durationSeconds: Math.round((Date.now() - (state.workoutStartedAt || Date.now())) / 1000),
    formScore: formScore(),
    goodReps: state.goodReps,
    warnings: state.formWarnings,
    rejectionReasons: state.rejectionReasons,
    averageQuality: Math.round(average(state.qualityScores)),
    qualityModelId: state.curlQualityModel?.model_id || "curl-quality-v1",
    qualityModelMetrics: state.curlQualityModel ? {
      rocAuc: state.curlQualityModel.evaluation.roc_auc,
      goodRecall: state.curlQualityModel.evaluation.good_recall,
      badRejectionRate: state.curlQualityModel.evaluation.bad_rejection_rate,
    } : null,
    averageAngle: Math.round(average(state.angleSamples)),
    setHistory: state.setHistory,
    sessionPlan: state.activeSessionPlan,
    muscles: trainedMuscles,
  };
}

function renderBodyMap(summary, history) {
  const totalReps = history.reduce((sum, item) => sum + (Number(item.reps) || 0), 0);
  const totalMinutes = Math.round(history.reduce((sum, item) => sum + (Number(item.durationSeconds) || 0), 0) / 60);
  els.bodySessionLabel.textContent = `Sesión ${summary.sessionNumber || history.length}`;
  els.bodyMuscleList.innerHTML = trainedMuscles.map((muscle) => `
    <div class="muscle-row">
      <span class="muscle-dot ${muscle.level}"></span>
      <span><strong>${muscle.name}</strong><small>${muscle.role}</small></span>
    </div>
  `).join("");
  els.bodyHistoryStats.innerHTML = [
    ["Sesiones de brazo", history.length],
    ["Reps históricas", totalReps],
    ["Tiempo registrado", `${totalMinutes} min`],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function renderNutritionPlan() {
  els.nutritionPlan.innerHTML = nutritionPlan.map((item) => `
    <div class="nutrition-item">
      <span>${item.time}</span>
      <strong>${item.meal}</strong>
      <p>${item.example}</p>
    </div>
  `).join("");
}

function setDashboardPage(pageName) {
  const selected = ["summary", "progress", "body", "recovery"].includes(pageName) ? pageName : "summary";
  state.dashboardPage = selected;
  els.dashboardTabs.forEach((tab) => {
    const active = tab.dataset.dashboardPage === selected;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  els.dashboardPages.forEach((page) => {
    page.hidden = page.dataset.dashboardView !== selected;
  });
  els.resultsDashboard.scrollTo?.({ top: 0, behavior: "smooth" });
}

function renderResultsDashboard(summary, { syncState = "saving", page = "summary" } = {}) {
  const duration = formatTime(summary.durationSeconds);
  const history = historyFor(summary);
  const nextSession = summary.nextSessionPlan || buildNextSession(summary, history);
  const rejectedReps = Number(summary.rejectedReps ?? summary.warnings ?? 0);
  const attempts = Number(summary.attempts) || Number(summary.reps || 0) + rejectedReps;
  state.currentDashboardSummary = summary;
  state.nextSessionPlan = nextSession;
  els.dashboardSyncStatus.classList.remove("ready", "warning");
  els.dashboardTitle.textContent = `Sesión ${summary.sessionNumber || history.length} completada`;
  els.dashboardSubtitle.textContent = `Sesión ${summary.sessionNumber || history.length} · ${summary.reps} válidas de ${attempts} intentos · ${duration} · modelo ${summary.qualityModelId || "de calidad local"}.`;
  els.dashboardMetrics.innerHTML = [
    ["Reps válidas", `${summary.reps}`],
    ["Intentos", `${attempts}`],
    ["Técnica", `${summary.formScore}%`],
    ["No contadas", String(rejectedReps)],
  ].map(([label, value]) => `<div class="metric-card"><span class="metric-label">${label}</span><strong class="metric-value">${value}</strong></div>`).join("");

  els.dashboardSessionStatus.textContent = `${summary.reps}/${REPS_PER_SET} válidas · ${rejectedReps} no contadas`;
  const setHistory = Array.isArray(summary.setHistory) && summary.setHistory.length
    ? summary.setHistory
    : [{ set: 1, reps: summary.reps, durationSeconds: summary.durationSeconds, averageAngle: summary.averageAngle, warnings: summary.warnings }];
  els.dashboardSetList.innerHTML = setHistory.map((set) => `
    <div class="set-row">
      <span><strong>Set ${set.set}</strong><small>${set.durationSeconds}s · ángulo medio ${set.averageAngle || "--"}° · calidad ${set.averageQuality || summary.averageQuality || "--"}%</small></span>
      <span>${set.reps}/${REPS_PER_SET} válidas${Number(set.rejectedReps ?? set.warnings ?? 0) ? ` · ${Number(set.rejectedReps ?? set.warnings ?? 0)} no contadas` : " · sin rechazos"}</span>
    </div>
  `).join("");

  els.nextSessionDate.textContent = `Programada para ${nextSessionDate(summary.completedAt)}`;
  els.nextSessionGoal.textContent = nextSession.goal;
  els.nextRoutine.innerHTML = nextSession.exercises.map((item) => `
    <div class="routine-row">
      <span><strong>${item.name}</strong><small>${item.detail}</small></span>
      <em>${item.cue}</em>
    </div>
  `).join("");
  els.nextSessionNote.textContent = nextSession.note;
  els.dashboardNewSession.textContent = `Empezar sesión ${nextSession.sessionNumber}`;
  els.recoveryPlan.innerHTML = recoveryPlan.map((item) => `
    <div class="recovery-item"><strong>${item.title}</strong><span>${item.text}</span></div>
  `).join("");

  renderProgress(summary, history);
  renderBodyMap(summary, history);
  renderNutritionPlan();
  els.dashboardHistoryCount.textContent = `${history.length} sesiones guardadas`;
  els.dashboardHistory.innerHTML = history.length ? history.map((item, index) => `
    <div class="history-row">
      <span><strong>Sesión ${item.sessionNumber || Math.max(history.length - index, 1)} · ${formatDate(item.completedAt)}</strong><small>${item.reps || 0} válidas · ${formatTime(item.durationSeconds)} · ${Number(item.rejectedReps ?? item.warnings ?? 0)} no contadas</small></span>
      <span>${item.formScore || 0}% técnica</span>
    </div>
  `).join("") : `<div class="history-row"><span>Esta es tu primera sesión registrada.</span></div>`;
  if (syncState === "saving") {
    renderSaveLog("saving");
    els.dashboardSyncStatus.textContent = "Guardando en Azure…";
  } else {
    renderSaveLog("saved", "Historial disponible en este dispositivo");
    els.dashboardSyncStatus.textContent = "Historial disponible";
    els.dashboardSyncStatus.classList.add("ready");
  }
  setDashboardPage(page);
}

async function saveWorkoutSummaryToAzure(summary) {
  const nextSession = summary.nextSessionPlan || buildNextSession(summary, historyFor(summary));
  const payload = {
    schema_version: 2,
    type: "curl_workout_summary",
    profile_id: state.profileId,
    session_id: summary.id,
    workout_id: summary.id,
    exercise: "biceps_curl",
    completed_at: summary.completedAt,
    statistics: summary,
    next_session: nextSession,
    recovery_plan: recoveryPlan,
    source: "javier_ai_web",
  };
  const summaryBlob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });

  if (apiBase) {
    const response = await fetch(`${apiBase}/create-summary-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: summary.id, profile_id: state.profileId }),
    });
    if (!response.ok) throw new Error(`create-summary-upload ${response.status}`);
    const upload = await response.json();
    const uploadResponse = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/json" },
      body: summaryBlob,
    });
    if (!uploadResponse.ok) throw new Error(`summary upload ${uploadResponse.status}`);
    state.azureUploadCount += 1;
    return upload.blobName;
  }

  if (containerSasUrl()) {
    const blobName = `profiles/${safeBlobSegment(state.profileId)}/workout-summaries/${safeBlobSegment(summary.id)}/workout-summary.json`;
    await putBlob(blobName, summaryBlob, "application/json");
    state.azureUploadCount += 1;
    return blobName;
  }

  throw new Error("Azure no está configurado en docs/config.js");
}

async function syncWorkoutHistoryFromAzure() {
  if (!apiBase || !state.profileId) return state.workoutHistory;
  const response = await fetch(`${apiBase}/workout-history`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile_id: state.profileId, limit: MAX_HISTORY_SESSIONS }),
  });
  if (!response.ok) throw new Error(`workout-history ${response.status}`);
  const payload = await response.json();
  const cloudHistory = Array.isArray(payload.sessions) ? payload.sessions : [];
  state.workoutHistory = mergeWorkoutHistories(state.workoutHistory, cloudHistory);
  persistHistory();

  const latest = state.workoutHistory[0];
  const latestNumber = highestSessionNumber(state.workoutHistory);
  if (!state.workoutStartedAt && latest && latestNumber >= state.sessionNumber) {
    const nextPlan = latest.nextSessionPlan || buildNextSession(latest, state.workoutHistory);
    state.activeSessionPlan = nextPlan;
    state.sessionNumber = nextPlan.sessionNumber;
    localStorage.setItem(NEXT_SESSION_PLAN_KEY, JSON.stringify(nextPlan));
  }
  if (!els.resultsDashboard.hidden && state.currentDashboardSummary) {
    const refreshed = state.workoutHistory.find((item) => item.id === state.currentDashboardSummary.id)
      || state.currentDashboardSummary;
    renderResultsDashboard(refreshed, { syncState: "saved", page: state.dashboardPage || "progress" });
    els.dashboardSyncStatus.textContent = "Sincronizado con Azure";
    renderSaveLog("saved", `${state.workoutHistory.length} sesiones históricas disponibles`);
  }
  render();
  return state.workoutHistory;
}

function safeBlobSegment(value) {
  return String(value || "session").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 100) || "session";
}

function finishWorkout() {
  if (state.workoutCompleted) return;
  if (!canFinishWorkout()) {
    updateLiveDashboard({
      coach: `No puedes finalizar todavía: completa ${WORKOUT_SETS} sets de ${REPS_PER_SET} repeticiones.`,
      status: "objetivo pendiente",
      statusVariant: "warning",
    });
    speak(`Aún no puedes finalizar. Completa los ${WORKOUT_SETS} sets de ${REPS_PER_SET}.`);
    return;
  }
  state.workoutCompleted = true;
  if (state.recording) stopRecording();
  const summary = workoutSummary();
  const historyWithCurrent = mergeWorkoutHistories([summary], state.workoutHistory);
  summary.nextSessionPlan = buildNextSession(summary, historyWithCurrent);
  state.nextSessionPlan = summary.nextSessionPlan;
  localStorage.setItem(NEXT_SESSION_PLAN_KEY, JSON.stringify(summary.nextSessionPlan));
  state.workoutHistory = mergeWorkoutHistories([summary], state.workoutHistory);
  persistHistory();
  stopLiveWorkout("completado");
  renderResultsDashboard(summary);
  els.resultsDashboard.hidden = false;
  render();
  els.dashboardSyncStatus.textContent = "Guardando en Azure…";
  els.dashboardSyncStatus.classList.remove("ready", "warning");
  renderSaveLog("saving");
  saveWorkoutSummaryToAzure(summary)
    .then((blobName) => {
      els.dashboardSyncStatus.textContent = "Guardado en Azure";
      els.dashboardSyncStatus.classList.add("ready");
      renderSaveLog("saved", `Resumen sincronizado · ${blobName}`);
      els.status.textContent = `Resumen guardado en Azure: ${blobName}`;
    })
    .catch((error) => {
      console.error("Azure summary upload failed", error);
      els.dashboardSyncStatus.textContent = "Azure pendiente";
      els.dashboardSyncStatus.classList.add("warning");
      renderSaveLog("pending", "Se conserva localmente y se podrá sincronizar al recuperar conexión");
      els.status.textContent = "Dashboard listo; no se pudo guardar en Azure";
    });
  state.voicePhase = "complete";
  speak("Excelente trabajo, Omar. Has completado tu sesión de curl. Respira, hidrátate y descansa. Tu dashboard y la siguiente rutina ya están listos.", { channel: "complete" });
}

async function switchCamera() {
  const wasLive = state.liveActive;
  if (wasLive) stopLiveWorkout("cambiando");
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  await startCamera();
  if (wasLive) {
    await startLiveWorkout();
  }
}

function visibility(landmark) {
  if (!landmark) return 0;
  if (typeof landmark.visibility === "number") return landmark.visibility;
  if (typeof landmark.presence === "number") return landmark.presence;
  return 1;
}

function armScore(landmarks, arm) {
  const indexes = armLandmarks[arm];
  const points = [landmarks[indexes.shoulder], landmarks[indexes.elbow], landmarks[indexes.wrist]];
  if (points.some((point) => !point)) return 0;
  const visibleScore = points.reduce((sum, point) => sum + visibility(point), 0) / points.length;
  const inFrameScore = points.every((point) => point.x > -0.15 && point.x < 1.15 && point.y > -0.15 && point.y < 1.15)
    ? 1
    : 0.35;
  return visibleScore * inFrameScore;
}

function pickArm(landmarks) {
  if (state.selectedArm !== "auto") {
    return state.selectedArm;
  }
  const leftScore = armScore(landmarks, "left");
  const rightScore = armScore(landmarks, "right");
  return leftScore >= rightScore ? "left" : "right";
}

function elbowAngle(shoulder, elbow, wrist) {
  const upper = { x: shoulder.x - elbow.x, y: shoulder.y - elbow.y };
  const lower = { x: wrist.x - elbow.x, y: wrist.y - elbow.y };
  const upperLength = Math.hypot(upper.x, upper.y);
  const lowerLength = Math.hypot(lower.x, lower.y);
  if (upperLength === 0 || lowerLength === 0) return null;
  const cosine = clamp((upper.x * lower.x + upper.y * lower.y) / (upperLength * lowerLength), -1, 1);
  return (Math.acos(cosine) * 180) / Math.PI;
}

function registerAcceptedCurl(quality) {
  state.attemptedReps += 1;
  state.setAttemptedReps += 1;
  state.totalReps += 1;
  state.currentSetReps += 1;
  state.goodReps += 1;
  state.lastRepAt = Date.now();
  state.lastFormWarning = "";
  state.qualityScores.push(quality.qualityScore);
  state.setQualityScores.push(quality.qualityScore);
  if (state.currentSetReps >= REPS_PER_SET) recordCompletedSet();
}

function registerRejectedCurl(quality) {
  state.attemptedReps += 1;
  state.setAttemptedReps += 1;
  state.rejectedReps += 1;
  state.setRejectedReps += 1;
  state.formWarnings += 1;
  state.setWarnings += 1;
  state.lastFormWarning = quality.message;
  state.rejectionReasons[quality.reason] = (state.rejectionReasons[quality.reason] || 0) + 1;
  state.qualityScores.push(quality.qualityScore);
  state.setQualityScores.push(quality.qualityScore);
}

function announceRejectedCurl(quality) {
  state.speechQueue = state.speechQueue.filter((item) => item.channel !== "coaching");
  state.lastSpokenCue = quality.message;
  state.lastCueAt = Date.now();
  speak(quality.message, {
    channel: "coaching",
    priority: true,
    dedupeKey: `rejected:${quality.reason}`,
    pauseAfter: 100,
    rate: 1.04,
  });
}

function drawPose(landmarks, activeArm) {
  resizeOverlay();
  const ctx = els.overlay.getContext("2d");
  const width = els.overlay.width;
  const height = els.overlay.height;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, width, height);

  const segments = [
    [11, 12],
    [11, 13],
    [13, 15],
    [12, 14],
    [14, 16],
    [11, 23],
    [12, 24],
    [23, 24],
  ];
  segments.forEach(([from, to]) => {
    drawSegment(ctx, landmarks[from], landmarks[to], "rgba(255,255,255,0.72)", 4 * dpr);
  });

  if (activeArm) {
    const indexes = armLandmarks[activeArm];
    drawSegment(ctx, landmarks[indexes.shoulder], landmarks[indexes.elbow], "#2ce6a1", 7 * dpr);
    drawSegment(ctx, landmarks[indexes.elbow], landmarks[indexes.wrist], "#2ce6a1", 7 * dpr);
    [indexes.shoulder, indexes.elbow, indexes.wrist].forEach((index) => {
      drawPoint(ctx, landmarks[index], "#ffffff", 7 * dpr);
      drawPoint(ctx, landmarks[index], "#18866b", 4 * dpr);
    });
  }
}

function drawSegment(ctx, start, end, color, lineWidth) {
  if (!start || !end || visibility(start) < 0.25 || visibility(end) < 0.25) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(start.x * els.overlay.width, start.y * els.overlay.height);
  ctx.lineTo(end.x * els.overlay.width, end.y * els.overlay.height);
  ctx.stroke();
}

function drawPoint(ctx, point, color, radius) {
  if (!point || visibility(point) < 0.25) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(point.x * els.overlay.width, point.y * els.overlay.height, radius, 0, Math.PI * 2);
  ctx.fill();
}

function handlePoseResult(result) {
  const landmarks = result.landmarks?.[0];
  if (!landmarks) {
    state.curlQualityTracker?.markVisibilityLost();
    clearOverlay();
    updateLiveDashboard({
      angle: null,
      coach: "No veo tu cuerpo completo. Aléjate un poco o mejora la luz.",
      status: "buscando",
      statusVariant: "warning",
    });
    return;
  }

  if (!state.curlQualityTracker || !state.curlQualityModel) {
    updateLiveDashboard({
      angle: null,
      coach: "El modelo de calidad todavía se está cargando.",
      status: "cargando",
      statusVariant: "warning",
    });
    return;
  }

  const arm = state.curlQualityTracker.activeArm || pickArm(landmarks);
  const score = armScore(landmarks, arm);
  drawPose(landmarks, arm);

  if (score < 0.45) {
    state.curlQualityTracker.markVisibilityLost();
    updateLiveDashboard({
      angle: null,
      coach: "No veo bien hombro, codo y muñeca. Ajusta la distancia o el ángulo.",
      status: "ajusta",
      statusVariant: "warning",
    });
    return;
  }

  const indexes = armLandmarks[arm];
  const measuredAngle = elbowAngle(landmarks[indexes.shoulder], landmarks[indexes.elbow], landmarks[indexes.wrist]);
  if (measuredAngle === null) {
    updateLiveDashboard({
      angle: null,
      coach: "No puedo calcular el ángulo del codo todavía.",
      status: "ajusta",
      statusVariant: "warning",
    });
    return;
  }
  state.smoothedAngle = state.smoothedAngle === null
    ? measuredAngle
    : state.smoothedAngle * 0.68 + measuredAngle * 0.32;
  const angle = state.smoothedAngle;

  if (state.completionScheduled) {
    updateLiveDashboard({
      angle,
      coach: "Ocho repeticiones válidas. Preparando tu dashboard.",
      status: "completado",
      statusVariant: "active",
    });
    return;
  }

  if (!state.countingEnabled) {
    updateLiveDashboard({
      angle,
      coach: state.countdownActive
        ? "Prepárate. Escucha la cuenta atrás antes de empezar."
        : "Escucha el briefing; todavía no cuento repeticiones.",
      status: state.countdownActive ? "preparando" : "briefing",
      statusVariant: "warning",
    });
    return;
  }

  const sample = createCurlQualitySample(landmarks, arm, performance.now() / 1000, angle);
  if (!sample || sample.visibility < state.curlQualityModel.counting.minimum_visibility) {
    state.curlQualityTracker.markVisibilityLost();
    updateLiveDashboard({
      angle,
      coach: "Necesito ver hombros, codo, muñeca y cadera durante toda la repetición.",
      status: "ajusta encuadre",
      statusVariant: "warning",
    });
    return;
  }

  state.angleSamples.push(angle);
  state.setAngles.push(angle);
  const event = state.curlQualityTracker.update(sample);
  let coach = event.message;
  let status = event.type === "top" ? "validando" : "en vivo";
  let statusVariant = "active";

  if (event.type === "accepted") {
    registerAcceptedCurl(event.quality);
    coach = state.currentSetReps >= REPS_PER_SET
      ? "Ocho repeticiones válidas. Preparando tu dashboard."
      : `Repetición ${state.currentSetReps} válida. Sigue con el mismo control.`;
    status = "repetición válida";
    if (canFinishWorkout() && !state.completionScheduled) {
      state.completionScheduled = true;
      let completionStarted = false;
      const completeAfterCount = () => {
        if (completionStarted) return;
        completionStarted = true;
        window.setTimeout(() => {
          state.completionScheduled = false;
          finishWorkout();
        }, 120);
      };
      announceRep({ onComplete: completeAfterCount });
    } else {
      announceRep();
    }
  } else if (event.type === "rejected") {
    registerRejectedCurl(event.quality);
    coach = event.quality.message;
    status = "intento no contado";
    statusVariant = "warning";
    announceRejectedCurl(event.quality);
  }

  updateLiveDashboard({
    angle,
    coach,
    status,
    statusVariant,
  });
}

function predictPose() {
  if (!state.liveActive || !state.poseLandmarker) return;
  const now = performance.now();
  const inferenceDue = now - state.lastInferenceAt >= POSE_INFERENCE_INTERVAL_MS;
  if (inferenceDue && els.preview.readyState >= 2 && els.preview.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = els.preview.currentTime;
    state.lastInferenceAt = now;
    const result = state.poseLandmarker.detectForVideo(els.preview, now);
    handlePoseResult(result);
  }
  state.liveAnimationFrame = window.requestAnimationFrame(predictPose);
}

function preferredMimeType() {
  const options = ["video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  if (!window.MediaRecorder) return "";
  return options.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function extensionForMimeType(mimeType) {
  return mimeType.includes("mp4") ? "mp4" : "webm";
}

function extensionForFilename(filename) {
  const extension = filename.split(".").pop()?.toLowerCase();
  return extension && extension !== filename.toLowerCase() ? extension : "";
}

function mimeTypeForFile(file) {
  if (file.type) return file.type;
  const extension = extensionForFilename(file.name);
  return {
    avi: "video/x-msvideo",
    m4v: "video/x-m4v",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    mp4: "video/mp4",
    webm: "video/webm",
    wmv: "video/x-ms-wmv",
  }[extension] || "video/mp4";
}

function videoExtensionForFile(file) {
  return extensionForFilename(file.name) || extensionForMimeType(mimeTypeForFile(file));
}

function videoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    video.src = url;
  });
}

async function startRecording() {
  if (state.recording) return;
  if (!state.liveActive || !state.countingEnabled) {
    state.autoRecordAfterCountdown = true;
    if (!state.liveActive) await startLiveWorkout({ autoRecord: true });
    return;
  }
  state.currentSetReps = 0;
  state.setRecorded = false;
  state.setStartedAt = Date.now();
  state.setAngles = [];
  state.setWarnings = 0;
  state.setAttemptedReps = 0;
  state.setRejectedReps = 0;
  state.setQualityScores = [];
  state.lastSpokenRep = 0;
  state.curlPhase = "unknown";
  state.torsoAnchorX = null;
  state.curlQualityTracker?.reset();
  if (!state.stream) {
    await startCamera();
  }
  if (!state.stream || !window.MediaRecorder) {
    els.status.textContent = "Grabación no disponible";
    return;
  }
  state.chunks = [];
  state.recorderMimeType = preferredMimeType();
  const recorderOptions = state.recorderMimeType ? { mimeType: state.recorderMimeType } : undefined;
  state.recorder = new MediaRecorder(state.stream, recorderOptions);
  state.recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) state.chunks.push(event.data);
  });
  state.recorder.addEventListener("stop", makeDownloads);
  state.recordingStartedAt = new Date();
  state.recorder.start(1000);
  state.recording = true;
  els.downloads.hidden = true;
  startTimer();
  render();
}

function stopRecording() {
  if (!state.recorder || !state.recording) return;
  state.recorder.stop();
  state.recording = false;
  stopTimer();
  render();
}

function makeDownloads() {
  const drill = activeDrill();
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const captureId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const mimeType = state.recorderMimeType || state.recorder?.mimeType || "video/webm";
  const extension = extensionForMimeType(mimeType);
  const basename = `${sessionId()}_${drill.exercise}_${drill.label}_${drill.angle}_${stamp}`;
  const videoBlob = new Blob(state.chunks, { type: mimeType });
  const startedAt = state.recordingStartedAt || new Date();
  const durationSeconds = Math.max((Date.now() - startedAt.getTime()) / 1000, 0);
  const metadata = {
    capture_id: captureId,
    session_id: sessionId(),
    workout_id: sessionId(),
    label: drill.label,
    exercise: drill.exercise,
    camera_angle: drill.angle,
    capture_type: drill.captureType,
    drill_id: drill.id,
    drill_title: drill.title,
    target: drill.target,
    cues: drill.cues,
    duration_seconds: Number(durationSeconds.toFixed(2)),
    recording_started_at: startedAt.toISOString(),
    created_at: new Date().toISOString(),
    source: "iphone_safari_camera",
    training_intent: "unreviewed",
    use_for_training: false,
    accepted_reps: state.currentSetReps,
    attempted_reps: state.setAttemptedReps,
    rejected_reps: state.setRejectedReps,
    rejection_reasons: state.rejectionReasons,
    quality_model_id: state.curlQualityModel?.model_id || "curl-quality-v1",
    video_file: `video.${extension}`,
    video_mime_type: mimeType,
  };
  const blobPrefix = `${drill.label}/${drill.angle}/${metadata.session_id}/${captureId}`;
  metadata.azure_blob_prefix = blobPrefix;
  metadata.video_blob = `${blobPrefix}/${metadata.video_file}`;
  metadata.metadata_blob = `${blobPrefix}/metadata.json`;
  const metadataBlob = new Blob([JSON.stringify(metadata, null, 2)], {
    type: "application/json",
  });

  els.videoDownload.href = URL.createObjectURL(videoBlob);
  els.videoDownload.download = `${basename}.${extension}`;
  els.metadataDownload.href = URL.createObjectURL(metadataBlob);
  els.metadataDownload.download = `${basename}.json`;
  els.downloads.hidden = false;
  state.clipCount += 1;
  els.status.textContent = apiBase || containerSasUrl()
    ? "Clip listo; subiendo a Azure..."
    : "Clip listo; descarga el video para guardarlo en tu iPhone";
  if (!state.workoutCompleted) {
    speak(`Sesión guardada. Llevas ${state.currentSetReps} repeticiones en este set.`);
  }
  render();
  uploadToAzure(videoBlob, metadataBlob, metadata).catch((error) => {
    console.error("Azure upload failed", error);
    alert(`Azure upload failed: ${error.message || error}`);
  });
}

async function uploadToAzure(videoBlob, metadataBlob, metadata) {
  if (apiBase) {
    return uploadWithFunction(videoBlob, metadataBlob, metadata);
  }
  if (containerSasUrl()) {
    return uploadWithContainerSas(videoBlob, metadataBlob, metadata);
  }
}

async function uploadWithFunction(videoBlob, metadataBlob, metadata) {
  els.status.textContent = "Subiendo a Azure...";
  const createResponse = await fetch(`${apiBase}/create-upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capture_id: metadata.capture_id,
      session_id: metadata.session_id,
      label: metadata.label,
      camera_angle: metadata.camera_angle,
      video_mime_type: metadata.video_mime_type,
      video_file_extension: metadata.video_file_extension || extensionForMimeType(metadata.video_mime_type),
    }),
  });
  if (!createResponse.ok) {
    throw new Error(`create-upload ${createResponse.status}`);
  }
  const upload = await createResponse.json();
  metadata.capture_id = upload.captureId;
  metadata.video_blob = upload.video.blobName;
  metadata.metadata_blob = upload.metadata.blobName;
  metadata.azure_blob_prefix = upload.video.blobName.split("/").slice(0, -1).join("/");
  metadata.video_file = upload.video.blobName.split("/").pop();
  const canonicalMetadataBlob = new Blob([JSON.stringify(metadata, null, 2)], {
    type: "application/json",
  });

  const videoResponse = await fetch(upload.video.uploadUrl, {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": videoBlob.type || "application/octet-stream",
    },
    body: videoBlob,
  });
  if (!videoResponse.ok) {
    throw new Error(`video upload ${videoResponse.status}`);
  }

  const metadataResponse = await fetch(upload.metadata.uploadUrl, {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": "application/json",
    },
    body: canonicalMetadataBlob,
  });
  if (!metadataResponse.ok) {
    throw new Error(`metadata upload ${metadataResponse.status}`);
  }

  const registerResponse = await fetch(`${apiBase}/register-capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capture_id: upload.captureId,
      session_id: metadata.session_id,
      label: metadata.label,
      camera_angle: metadata.camera_angle,
      video_blob: upload.video.blobName,
      metadata_blob: upload.metadata.blobName,
    }),
  });
  if (!registerResponse.ok) {
    throw new Error(`register-capture ${registerResponse.status}`);
  }

  state.azureUploadCount += 1;
  els.status.textContent = `Azure upload listo (${state.azureUploadCount})`;
  render();
}

function blobUrl(blobName) {
  const sasUrl = containerSasUrl();
  const [baseUrl, query] = sasUrl.split("?");
  const cleanBase = baseUrl.replace(/\/$/, "");
  const encodedPath = blobName.split("/").map(encodeURIComponent).join("/");
  return `${cleanBase}/${encodedPath}?${query}`;
}

async function putBlob(blobName, blob, contentType) {
  const response = await fetch(blobUrl(blobName), {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": contentType,
    },
    body: blob,
  });
  if (!response.ok) {
    throw new Error(`${blobName} upload ${response.status}`);
  }
}

async function uploadWithContainerSas(videoBlob, metadataBlob, metadata) {
  els.status.textContent = "Subiendo a Azure Blob...";
  const prefix = metadata.azure_blob_prefix;
  await putBlob(`${prefix}/${metadata.video_file}`, videoBlob, videoBlob.type || "application/octet-stream");
  await putBlob(`${prefix}/metadata.json`, metadataBlob, "application/json");
  state.azureUploadCount += 1;
  els.status.textContent = `Azure Blob listo (${state.azureUploadCount})`;
  render();
}

function prepareNewSession(plan = null) {
  if (state.recording) return false;
  const selectedPlan = plan
    || loadNextSessionPlan()
    || defaultSessionPlan(highestSessionNumber(state.workoutHistory) + 1);
  clearSpeechQueue();
  state.workoutId = createWorkoutId();
  localStorage.setItem("curlVisionWorkoutId", state.workoutId);
  state.sessionNumber = Number(selectedPlan.sessionNumber)
    || highestSessionNumber(state.workoutHistory) + 1;
  state.activeSessionPlan = { ...selectedPlan, sessionNumber: state.sessionNumber };
  state.nextSessionPlan = null;
  state.clipCount = 0;
  state.azureUploadCount = 0;
  state.completedSets = 0;
  state.totalReps = 0;
  state.workoutStartedAt = 0;
  state.workoutCompleted = false;
  state.formWarnings = 0;
  state.goodReps = 0;
  state.attemptedReps = 0;
  state.rejectedReps = 0;
  state.setAttemptedReps = 0;
  state.setRejectedReps = 0;
  state.rejectionReasons = {};
  state.qualityScores = [];
  state.setQualityScores = [];
  state.angleSamples = [];
  state.setHistory = [];
  state.completionScheduled = false;
  state.sessionIntroSpoken = false;
  els.resultsDashboard.hidden = true;
  resetLiveWorkout();
  els.downloads.hidden = true;
  els.status.textContent = `Sesión ${state.sessionNumber} lista`;
  render();
  return true;
}

async function startGeneratedNextSession() {
  const plan = state.nextSessionPlan
    || loadNextSessionPlan()
    || defaultSessionPlan(highestSessionNumber(state.workoutHistory) + 1);
  if (!prepareNewSession(plan)) return;
  updateLiveDashboard({
    coach: `Preparando el resumen de tu sesión ${state.sessionNumber}.`,
    status: "preparando",
    statusVariant: "warning",
  });
  await startLiveWorkout({ autoRecord: true });
}

function openHistoricalDashboard() {
  const latest = state.workoutHistory[0];
  if (!latest) {
    updateLiveDashboard({
      coach: "Todavía no hay sesiones guardadas. Completa ocho repeticiones para crear tu primer registro.",
      status: "sin historial",
      statusVariant: "warning",
    });
    speak("Todavía no hay sesiones guardadas. Completa tu primera sesión para ver el progreso.", { channel: "control" });
    return;
  }
  renderResultsDashboard(latest, { syncState: "saved", page: "progress" });
  els.resultsDashboard.hidden = false;
  syncWorkoutHistoryFromAzure().catch((error) => console.warn("History sync failed", error));
}

els.previous.addEventListener("click", () => {
  if (state.recording) return;
  state.selectedIndex = state.selectedIndex === 0 ? drills.length - 1 : state.selectedIndex - 1;
  render();
});

els.next.addEventListener("click", () => {
  if (state.recording) return;
  state.selectedIndex = (state.selectedIndex + 1) % drills.length;
  render();
});

els.record.addEventListener("click", () => {
  if (state.recording) {
    stopRecording();
  } else {
    startRecording().catch((error) => {
      console.error("Recording failed", error);
      els.status.textContent = "No se pudo iniciar la grabación";
    });
  }
});

els.cameraStart.addEventListener("click", () => {
  startCamera().catch((error) => {
    console.error("Camera failed", error);
  });
});

els.voiceToggle.addEventListener("click", () => {
  const phaseBeforeToggle = state.voicePhase;
  state.voiceEnabled = !state.voiceEnabled;
  if (!state.voiceEnabled && "speechSynthesis" in window) {
    clearSpeechQueue();
    if (phaseBeforeToggle === "briefing") queueCountdownAfterBriefing();
    if (phaseBeforeToggle === "countdown") {
      state.countdownActive = false;
      startCountdown();
    }
  } else {
    speak(state.liveActive ? "Voz activada. Estoy contigo." : "Voz activada. Pulsa Empezar entrenamiento para comenzar.", { force: true, channel: "control", priority: true });
  }
  render();
});

els.saveAzure.addEventListener("click", () => {
  localStorage.setItem("curlVisionContainerSasUrl", els.azureSas.value.trim());
  els.status.textContent = containerSasUrl() ? "Azure Blob configurado" : "Azure Blob apagado";
  render();
});

els.newSession.addEventListener("click", () => {
  prepareNewSession();
});

els.liveStart.addEventListener("click", () => {
  startLiveWorkout().catch((error) => {
    console.error("Live workout failed", error);
    alert(`No pude iniciar entrenamiento en vivo: ${error.message || error}`);
  });
});

els.liveReset.addEventListener("click", resetLiveWorkout);

els.finishWorkout.addEventListener("click", finishWorkout);

els.dashboardClose.addEventListener("click", () => {
  els.resultsDashboard.hidden = true;
});

els.dashboardOpenHistory.addEventListener("click", openHistoricalDashboard);

els.dashboardTabs.forEach((tab) => {
  tab.addEventListener("click", () => setDashboardPage(tab.dataset.dashboardPage));
});

els.dashboardNewSession.addEventListener("click", () => {
  startGeneratedNextSession().catch((error) => {
    console.error("Next session failed", error);
    alert(`No pude iniciar la siguiente sesión: ${error.message || error}`);
  });
});

els.switchCamera.addEventListener("click", () => {
  switchCamera().catch((error) => {
    console.error("Camera switch failed", error);
    alert(`No pude cambiar camara: ${error.message || error}`);
  });
});

els.azureSas.value = containerSasUrl();
render();
updateLiveDashboard();
preloadTrackingModels({ silent: true }).catch((error) => {
  console.warn("Background model preload failed", error);
});
syncWorkoutHistoryFromAzure().catch((error) => {
  console.warn("Azure history is not available yet", error);
});
window.addEventListener("resize", resizeOverlay);

if (window.isSecureContext || ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
  startCamera();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
    .then((registration) => registration.update())
    .catch((error) => {
      console.warn("PWA registration failed", error);
    });
}
