import {
  FilesetResolver,
  PoseLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";

const drills = [
  {
    id: "good_curl_front",
    exercise: "biceps_curl",
    label: "good_form",
    angle: "front",
    captureType: "set",
    title: "Curl estricto",
    target: "Objetivo: 1 sesión de 8 repeticiones",
    cues: ["Codo estable", "Torso quieto", "Rango completo", "Bajada controlada"],
  },
];

const WORKOUT_SETS = 1;
const REPS_PER_SET = 8;
const WORKOUT_HISTORY_KEY = "curlVisionWorkoutHistory";
const recoveryPlan = [
  { title: "Descanso", text: "Deja 24–48 h antes de volver a entrenar bíceps. Entre ejercicios: 60–90 s." },
  { title: "Comida", text: "Incluye proteína, carbohidrato, fruta o verdura y agua: huevos, pollo, yogur, arroz, avena o legumbres." },
  { title: "Mañana", text: "Haz movilidad suave de hombros y entrena solo si no hay dolor agudo, mareo o fatiga anormal." },
];

const state = {
  selectedIndex: 0,
  stream: null,
  facingMode: "user",
  recorder: null,
  recorderMimeType: "",
  chunks: [],
  recording: false,
  recordingStartedAt: null,
  startedAt: 0,
  timerInterval: 0,
  workoutId: loadWorkoutId(),
  clipCount: 0,
  azureUploadCount: 0,
  poseLandmarker: null,
  poseLoading: false,
  poseLoadPromise: null,
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
  lastFormWarning: "",
  angleSamples: [],
  setHistory: [],
  workoutHistory: loadWorkoutHistory(),
  completionScheduled: false,
  sessionIntroSpoken: false,
  countingEnabled: false,
  countdownActive: false,
  speechRunId: 0,
  briefingFinished: false,
  briefingMinimumUntil: 0,
  countdownTimer: 0,
  voicePhase: "idle",
  trackingStarted: false,
  autoRecordAfterCountdown: true,
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
  cameraStart: document.getElementById("camera-start"),
  liveStatus: document.getElementById("live-status"),
  liveReps: document.getElementById("live-reps"),
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
};

const poseModelUrl =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
const poseWasmUrl = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
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
  return `gym_good_${workoutStamp()}`;
}

function loadWorkoutId() {
  const stored = localStorage.getItem("curlVisionWorkoutId");
  if (stored) return stored;
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
    return Array.isArray(stored) ? stored : [];
  } catch (error) {
    return [];
  }
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
  const totalReps = Math.max(state.totalReps, 1);
  return Math.round(clamp(100 - (state.formWarnings / totalReps) * 100, 0, 100));
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
  return [summary, ...state.workoutHistory.filter((item) => item.id !== summary.id)].slice(0, 8);
}

function buildNextSession(summary, history) {
  const techniqueReady = summary.formScore >= 88 && summary.warnings <= 1;
  const recentAverage = Math.round(average(history.map((item) => Number(item.formScore) || 0)));
  if (techniqueReady) {
    return {
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
    goal: "Consolidar técnica antes de subir carga · no busques el fallo mientras haya avisos de postura.",
    exercises: [
      { name: "Curl estricto", detail: "3 series · 8–10 reps · 120 s", cue: "RIR 2–3" },
      { name: "Curl martillo", detail: "2 series · 10 reps · 90 s", cue: "Muñeca neutra" },
      { name: "Curl inclinado", detail: "2 series · 8–10 reps · 120 s", cue: "Rango completo" },
      { name: "Extensión de tríceps", detail: "2 series · 10 reps · 90 s", cue: "Sin balanceo" },
    ],
    note: `Javier detectó ${summary.warnings} avisos de técnica. Repite una carga cómoda y detén la serie cuando aparezca el primer fallo técnico. Media reciente: ${recentAverage}%.`,
  };
}

function renderProgress(summary, history) {
  const avgForm = Math.round(average(history.map((item) => Number(item.formScore) || 0)));
  const totalReps = history.reduce((sum, item) => sum + (Number(item.reps) || 0), 0);
  const bestForm = Math.max(...history.map((item) => Number(item.formScore) || 0), 0);
  const lastItems = history.slice(0, 6).reverse();
  els.progressScore.textContent = `${avgForm}%`;
  els.progressPeriod.textContent = `${history.length} ${history.length === 1 ? "sesión" : "sesiones"}`;
  els.progressHighlights.innerHTML = [
    ["Volumen acumulado", `${totalReps} reps`],
    ["Mejor técnica", `${bestForm}%`],
    ["Última sesión", `${summary.reps} reps`],
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
  state.workoutHistory = state.workoutHistory.slice(0, 7);
  localStorage.setItem(WORKOUT_HISTORY_KEY, JSON.stringify(state.workoutHistory));
}

function setProgressText() {
  const setNumber = state.workoutCompleted
    ? WORKOUT_SETS
    : Math.min(state.currentSetReps >= REPS_PER_SET ? Math.max(state.completedSets, 1) : currentSetNumber(), WORKOUT_SETS);
  els.workoutProgress.textContent = `Sesión · ${state.currentSetReps}/${REPS_PER_SET}`;
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
  els.record.disabled = state.workoutCompleted
    || (state.liveActive && !state.countingEnabled)
    || (state.completedSets >= WORKOUT_SETS && state.currentSetReps >= REPS_PER_SET && !state.recording);
  els.newSession.disabled = state.recording || state.liveActive;
  els.cameraStart.hidden = Boolean(state.stream);
  els.switchCamera.disabled = !state.stream || state.recording;
  els.liveReset.disabled = state.recording || state.workoutCompleted || state.completedSets >= WORKOUT_SETS;
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
    resizeOverlay();
    els.status.textContent = state.facingMode === "user" ? "Camara frontal lista" : "Camara trasera lista";
    render();
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

function speak(text, { force = false, onend = null, onerror = null, channel = "workout" } = {}) {
  const sequenceLocked = state.voicePhase === "briefing" || state.voicePhase === "countdown";
  if (sequenceLocked && channel !== "sequence" && channel !== "control") return null;
  if (state.voicePhase === "complete" && channel === "workout") return null;
  if ((!state.voiceEnabled && !force) || !("speechSynthesis" in window)) {
    if (onend) window.setTimeout(onend, 0);
    return null;
  }
  const runId = ++state.speechRunId;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "es-MX";
  utterance.rate = 1.04;
  utterance.pitch = 1.02;
  const voice = spanishVoice();
  if (voice) utterance.voice = voice;
  utterance.onend = () => {
    if (runId === state.speechRunId && onend) onend();
  };
  utterance.onerror = () => {
    if (runId === state.speechRunId && onerror) onerror();
  };
  window.speechSynthesis.speak(utterance);
  return utterance;
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
  const visiblePlan = continuation
    ? "Continuamos con tu sesión de curl. Te quedan las repeticiones necesarias para completar el objetivo."
    : `Hola Omar. Hoy es ${dateLabel}. Hoy te toca entrenar el bíceps. Empezamos con curl estricto: una sesión de ${REPS_PER_SET} repeticiones. Mantén el codo estable, el torso quieto y controla la bajada. Yo te iré guiando durante toda la sesión, contando cada repetición y avisándote de tu técnica. Al terminar te felicitaré y te mostraré tus estadísticas.`;
  els.liveCoach.textContent = visiblePlan;
  setLiveStatus(continuation ? "continuamos" : "briefing", "active");
  state.briefingUntil = Date.now() + (continuation ? 3500 : 9000);
  state.briefingMinimumUntil = Date.now() + (continuation ? 6000 : 14000);
  state.briefingFinished = false;
  state.voicePhase = "briefing";
  window.clearTimeout(state.countdownTimer);
  state.countingEnabled = false;
  state.countdownActive = false;
  speak(visiblePlan, {
    onend: queueCountdownAfterBriefing,
    onerror: queueCountdownAfterBriefing,
    channel: "sequence",
  });
  state.sessionIntroSpoken = true;
}

function queueCountdownAfterBriefing() {
  if (state.briefingFinished) return;
  state.briefingFinished = true;
  const wait = Math.max(0, state.briefingMinimumUntil - Date.now());
  window.clearTimeout(state.countdownTimer);
  state.countdownTimer = window.setTimeout(startCountdown, wait);
}

function startCountdown() {
  if (state.countdownActive || state.workoutCompleted || !state.briefingFinished) return;
  state.countdownActive = true;
  state.voicePhase = "countdown";
  state.countingEnabled = false;
  state.lastSpokenRep = 0;
  state.lastSpokenCue = "";
  let count = 1;
  const sayNext = () => {
    if (count > 3) {
      state.countdownActive = false;
      state.countingEnabled = true;
      state.voicePhase = "workout";
      state.briefingUntil = 0;
      els.liveCoach.textContent = "Ahora sí. Empieza con el brazo extendido.";
      setLiveStatus("en vivo", "active");
      startTrackingAfterCountdown().catch((error) => {
        console.error("Tracking start failed", error);
        updateLiveDashboard({
          coach: "No pude iniciar el seguimiento. Pulsa Continuar entrenamiento.",
          status: "error",
          statusVariant: "warning",
        });
      });
      return;
    }
    const phrase = count === 3 ? "Tres. Ahora empieza." : String(count);
    count += 1;
    speak(phrase, { onend: () => window.setTimeout(sayNext, 220), channel: "sequence" });
  };
  els.liveCoach.textContent = "Prepárate. La sesión comienza después de la cuenta atrás.";
  setLiveStatus("preparando", "warning");
  sayNext();
}

function announceRep() {
  if (state.currentSetReps <= state.lastSpokenRep) return;
  state.lastSpokenRep = state.currentSetReps;
  const remaining = Math.max(state.targetReps - state.currentSetReps, 0);
  if (remaining === 0) {
    return;
  }
  speak(`Llevas ${state.currentSetReps}. Te faltan ${remaining}. Mantén la técnica.`);
}

function motivate() {
  const now = Date.now();
  if (state.currentSetReps === 0 || now - state.lastMotivationAt < 22000) return;
  state.lastMotivationAt = now;
  speak(state.currentSetReps >= state.targetReps - 2
    ? "Muy bien. Las últimas cuentan; aprieta y controla la bajada."
    : "Buen ritmo. Mantén el torso quieto y sigue fuerte.");
}

function speakFormCue(message) {
  const now = Date.now();
  if (!state.countingEnabled) return;
  if (now < state.briefingUntil) return;
  if (now - state.lastCueAt < 8000 || message === state.lastSpokenCue) return;
  state.lastCueAt = now;
  state.lastSpokenCue = message;
  speak(message);
}

async function loadPoseModel() {
  if (state.poseLandmarker) return state.poseLandmarker;
  if (state.poseLoadPromise) return state.poseLoadPromise;

  state.poseLoading = true;
  updateLiveDashboard({
    status: "cargando",
    statusVariant: "warning",
  });

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
    updateLiveDashboard({
      coach: "No pude cargar el detector de pose. Revisa internet y vuelve a intentar.",
      status: "sin pose",
      statusVariant: "warning",
    });
    throw error;
  }
}

async function startLiveWorkout({ autoRecord = true } = {}) {
  if (state.workoutCompleted) return;
  if (state.liveActive) {
    stopLiveWorkout("pausado");
    return;
  }

  const wasAlreadyStarted = Boolean(state.workoutStartedAt);
  state.autoRecordAfterCountdown = autoRecord;

  if (!state.stream) {
    await startCamera();
  }
  if (!state.stream) return;

  await loadPoseModel();
  state.liveActive = true;
  if (!state.workoutStartedAt) state.workoutStartedAt = Date.now();
  if (!state.setStartedAt) state.setStartedAt = Date.now();
  state.lastVideoTime = -1;
  state.liveStartedAt = Date.now();
  window.clearInterval(state.liveTimerInterval);
  state.liveTimerInterval = window.setInterval(updateLiveTime, 250);
  els.liveStart.textContent = "Pausar";
  updateLiveDashboard({
    coach: "Cámara e IA listas. Escucha tu rutina antes de comenzar.",
    status: "preparando",
    statusVariant: "warning",
  });
  if (!state.sessionIntroSpoken) {
    announceSessionBriefing();
  } else if (wasAlreadyStarted) {
    announceSessionBriefing({ continuation: true });
  }
}

async function startTrackingAfterCountdown() {
  if (!state.liveActive || !state.countingEnabled || !state.poseLandmarker || state.trackingStarted) return;
  state.trackingStarted = true;
  state.lastVideoTime = -1;
  predictPose();
  if (state.autoRecordAfterCountdown && !state.recording) {
    await startRecording();
  }
}

function stopLiveWorkout(message = "pausado") {
  state.liveActive = false;
  state.trackingStarted = false;
  state.countingEnabled = false;
  state.countdownActive = false;
  state.briefingFinished = false;
  state.voicePhase = "idle";
  window.clearTimeout(state.countdownTimer);
  state.speechRunId += 1;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
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
    durationSeconds: Math.round((Date.now() - (state.setStartedAt || Date.now())) / 1000),
    averageAngle: Math.round(average(state.setAngles)),
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
  state.lastFormWarning = "";
  state.speechRunId += 1;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
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
    completedAt: new Date().toISOString(),
    sets: state.completedSets,
    reps: state.totalReps,
    durationSeconds: Math.round((Date.now() - (state.workoutStartedAt || Date.now())) / 1000),
    formScore: formScore(),
    goodReps: state.goodReps,
    warnings: state.formWarnings,
    averageAngle: Math.round(average(state.angleSamples)),
    setHistory: state.setHistory,
  };
}

function renderResultsDashboard(summary) {
  const duration = formatTime(summary.durationSeconds);
  const history = historyFor(summary);
  const nextSession = buildNextSession(summary, history);
  els.dashboardSubtitle.textContent = `${summary.reps} repeticiones registradas · ${duration} · técnica analizada en el dispositivo.`;
  els.dashboardMetrics.innerHTML = [
    ["Volumen", `${summary.reps} reps`],
    ["Sets", `${summary.sets}/${WORKOUT_SETS}`],
    ["Técnica", `${summary.formScore}%`],
    ["Avisos", String(summary.warnings)],
  ].map(([label, value]) => `<div class="metric-card"><span class="metric-label">${label}</span><strong class="metric-value">${value}</strong></div>`).join("");

  els.dashboardSessionStatus.textContent = `${summary.reps}/${REPS_PER_SET} reps · ${summary.goodReps} limpias`;
  els.dashboardSetList.innerHTML = summary.setHistory.map((set) => `
    <div class="set-row">
      <span><strong>Set ${set.set}</strong><small>${set.durationSeconds}s · ángulo medio ${set.averageAngle || "--"}°</small></span>
      <span>${set.reps}/${REPS_PER_SET} reps${set.warnings ? ` · ${set.warnings} avisos` : " · OK"}</span>
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
  els.recoveryPlan.innerHTML = recoveryPlan.map((item) => `
    <div class="recovery-item"><strong>${item.title}</strong><span>${item.text}</span></div>
  `).join("");

  renderProgress(summary, history);
  els.dashboardHistoryCount.textContent = `${history.length} sesiones guardadas`;
  els.dashboardHistory.innerHTML = history.length ? history.slice(0, 5).map((item) => `
    <div class="history-row">
      <span><strong>${formatDate(item.completedAt)}</strong><small>${item.sets}/${WORKOUT_SETS} sets · ${formatTime(item.durationSeconds)}</small></span>
      <span>${item.formScore}% técnica</span>
    </div>
  `).join("") : `<div class="history-row"><span>Esta es tu primera sesión registrada.</span></div>`;
  renderSaveLog("saving");
  els.dashboardSyncStatus.textContent = "Guardando en Azure…";
}

async function saveWorkoutSummaryToAzure(summary) {
  const nextSession = buildNextSession(summary, historyFor(summary));
  const payload = {
    schema_version: 1,
    type: "curl_workout_summary",
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
      body: JSON.stringify({ session_id: summary.id }),
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
    const blobName = `summaries/${safeBlobSegment(summary.id)}/workout-summary.json`;
    await putBlob(blobName, summaryBlob, "application/json");
    state.azureUploadCount += 1;
    return blobName;
  }

  throw new Error("Azure no está configurado en docs/config.js");
}

function safeBlobSegment(value) {
  return String(value || "session").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 100) || "session";
}

function finishWorkout() {
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
  state.workoutHistory = [summary, ...state.workoutHistory.filter((item) => item.id !== summary.id)];
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

function formWarning(landmarks, arm) {
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  if (!leftShoulder || !rightShoulder) return "";

  const shoulderCenter = (leftShoulder.x + rightShoulder.x) / 2;
  if (state.torsoAnchorX === null) state.torsoAnchorX = shoulderCenter;
  const torsoDrift = Math.abs(shoulderCenter - state.torsoAnchorX);
  state.torsoAnchorX = state.torsoAnchorX * 0.96 + shoulderCenter * 0.04;
  if (torsoDrift > 0.1) return "Mantén el torso quieto; no balancees el cuerpo.";

  const indexes = armLandmarks[arm];
  const shoulder = landmarks[indexes.shoulder];
  const elbow = landmarks[indexes.elbow];
  if (shoulder && elbow && Math.abs(elbow.x - shoulder.x) > 0.24) {
    return "Mantén el codo cerca del cuerpo y baja con control.";
  }
  return "";
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

function countCurl(angle) {
  const downAngle = 148;
  const upAngle = 78;

  if (angle > downAngle) {
    if (state.curlPhase === "unknown") {
      state.curlPhase = "down";
      return "Listo. Sube controlado hasta flexionar el codo.";
    }
    if (state.curlPhase === "up") {
      state.curlPhase = "down";
      return "Bajada completa. Siguiente rep lista.";
    }
    return "Brazo abajo. Sube sin balancear el torso.";
  }

  if (angle < upAngle) {
    if (state.curlPhase === "down") {
      if (state.currentSetReps >= REPS_PER_SET) {
        return state.completedSets >= WORKOUT_SETS
          ? "Los 4 sets están completos. Pulsa Finalizar entrenamiento."
          : "Set completo. Reinicia el set después de descansar.";
      }
      state.totalReps += 1;
      state.currentSetReps += 1;
      state.curlPhase = "up";
      if (state.currentSetReps >= REPS_PER_SET) {
        recordCompletedSet();
        return state.completedSets >= WORKOUT_SETS
          ? "Cuarto set completo. Ya puedes finalizar."
          : `Set ${state.completedSets} completo. Descansa y reinicia el set.`;
      }
      return `Curl ${state.totalReps} contada. Baja completo para la siguiente.`;
    }
    return "Arriba. Baja completo antes de contar otra.";
  }

  return state.curlPhase === "down"
    ? "Subiendo. Mantén el codo estable."
    : "Bajando controlado hasta extender el brazo.";
}

function handlePoseResult(result) {
  const landmarks = result.landmarks?.[0];
  if (!landmarks) {
    clearOverlay();
    updateLiveDashboard({
      angle: null,
      coach: "No veo tu cuerpo completo. Aleja el telefono o mejora la luz.",
      status: "buscando",
      statusVariant: "warning",
    });
    return;
  }

  const arm = pickArm(landmarks);
  const score = armScore(landmarks, arm);
  drawPose(landmarks, arm);

  if (score < 0.45) {
    updateLiveDashboard({
      angle: null,
      coach: "No veo bien hombro, codo y muneca. Ajusta distancia o angulo.",
      status: "ajusta",
      statusVariant: "warning",
    });
    return;
  }

  const indexes = armLandmarks[arm];
  const angle = elbowAngle(landmarks[indexes.shoulder], landmarks[indexes.elbow], landmarks[indexes.wrist]);
  if (angle === null) {
    updateLiveDashboard({
      angle: null,
      coach: "No puedo calcular el angulo del codo todavia.",
      status: "ajusta",
      statusVariant: "warning",
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

  const repsBefore = state.currentSetReps;
  const coachFromAngle = countCurl(angle);
  const warning = formWarning(landmarks, arm);
  state.angleSamples.push(angle);
  state.setAngles.push(angle);
  if (warning && warning !== state.lastFormWarning) {
    state.formWarnings += 1;
    state.setWarnings += 1;
  }
  state.lastFormWarning = warning;
  const coach = warning || coachFromAngle;
  if (state.currentSetReps > repsBefore) {
    if (!warning) state.goodReps += 1;
    announceRep();
  } else if (warning) {
    speakFormCue(warning);
  } else if (state.currentSetReps === 0) {
    speakFormCue(coachFromAngle);
  }
  updateLiveDashboard({
    angle,
    coach,
    status: "en vivo",
    statusVariant: "active",
  });
  if (state.currentSetReps > repsBefore && canFinishWorkout() && !state.completionScheduled) {
    state.completionScheduled = true;
    window.setTimeout(() => {
      state.completionScheduled = false;
      finishWorkout();
    }, 250);
  }
}

function predictPose() {
  if (!state.liveActive || !state.poseLandmarker) return;
  if (els.preview.readyState >= 2 && els.preview.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = els.preview.currentTime;
    const result = state.poseLandmarker.detectForVideo(els.preview, performance.now());
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
  state.lastSpokenRep = 0;
  state.curlPhase = "unknown";
  state.torsoAnchorX = null;
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
  state.voiceEnabled = !state.voiceEnabled;
  if (!state.voiceEnabled && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  } else {
    speak(state.liveActive ? "Voz activada. Estoy contigo." : "Voz activada. Pulsa Empezar entrenamiento para comenzar.", { force: true, channel: "control" });
  }
  render();
});

els.saveAzure.addEventListener("click", () => {
  localStorage.setItem("curlVisionContainerSasUrl", els.azureSas.value.trim());
  els.status.textContent = containerSasUrl() ? "Azure Blob configurado" : "Azure Blob apagado";
  render();
});

els.newSession.addEventListener("click", () => {
  if (state.recording) return;
  state.workoutId = createWorkoutId();
  localStorage.setItem("curlVisionWorkoutId", state.workoutId);
  state.clipCount = 0;
  state.azureUploadCount = 0;
  state.completedSets = 0;
  state.totalReps = 0;
  state.workoutStartedAt = 0;
  state.workoutCompleted = false;
  state.formWarnings = 0;
  state.goodReps = 0;
  state.angleSamples = [];
  state.setHistory = [];
  state.completionScheduled = false;
  state.sessionIntroSpoken = false;
  els.resultsDashboard.hidden = true;
  resetLiveWorkout();
  els.downloads.hidden = true;
  els.status.textContent = "Nueva sesión lista";
  render();
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

els.dashboardNewSession.addEventListener("click", () => {
  els.resultsDashboard.hidden = true;
  els.newSession.click();
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
