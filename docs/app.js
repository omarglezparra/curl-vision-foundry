import {
  FilesetResolver,
  PoseLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
import {
  createCurlQualitySample,
  CurlAttemptTracker,
  validateCurlQualityModel,
} from "./curl-quality.js";
import {
  analyzeHistory,
  buildAdaptiveArmSession,
  DEFAULT_PROFILE,
  normalizeProfile,
  planTotals,
  trainingStreak,
} from "./workout-planner.js";

const drills = [
  {
    id: "good_curl_front",
    exercise: "biceps_curl",
    label: "good_form",
    angle: "front",
    captureType: "set",
    title: "Curl estricto",
    target: "Objetivo adaptativo de la serie",
    cues: ["Codo estable", "Torso quieto", "Rango completo", "Bajada controlada"],
  },
];

const WORKOUT_HISTORY_KEY = "curlVisionWorkoutHistory";
const NEXT_SESSION_PLAN_KEY = "curlVisionNextSessionPlan";
const PROFILE_ID_KEY = "curlVisionProfileId";
const USER_PROFILE_KEY = "javierUserProfileV3";
const ACTIVE_WORKOUT_KEY = "javierActiveWorkoutV3";
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
  { name: "Tríceps braquial", role: "Principal", level: "primary" },
  { name: "Deltoide anterior y core", role: "Estabilizador", level: "stabilizer" },
];

const initialWorkoutHistory = loadWorkoutHistory();
const initialProfile = loadUserProfile();
const initialActiveWorkout = loadActiveWorkoutSnapshot();
const savedSessionPlan = loadNextSessionPlan();
const initialSessionPlan = savedSessionPlan?.schemaVersion >= 3
  ? savedSessionPlan
  : buildAdaptiveArmSession({
    sessionNumber: highestSessionNumber(initialWorkoutHistory) + 1,
    history: initialWorkoutHistory,
    profile: initialProfile,
  });
const resumedSessionPlan = initialActiveWorkout?.status === "in_progress" && initialActiveWorkout.plan
  ? initialActiveWorkout.plan
  : initialSessionPlan;
const resumeAfterCompletedSet = Boolean(initialActiveWorkout?.pendingRoutinePosition);
const initialWorkoutId = initialActiveWorkout?.status === "in_progress" && initialActiveWorkout.workoutId
  ? initialActiveWorkout.workoutId
  : loadActiveWorkoutId(initialWorkoutHistory);

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
  currentSetReps: resumeAfterCompletedSet ? 0 : Number(initialActiveWorkout?.currentSetReps) || 0,
  totalReps: Number(initialActiveWorkout?.totalReps) || 0,
  targetReps: 0,
  selectedArm: "auto",
  voiceEnabled: true,
  lastSpokenRep: 0,
  lastSpokenCue: "",
  lastCueAt: 0,
  completedSets: Number(initialActiveWorkout?.completedSets) || 0,
  setRecorded: false,
  workoutStartedAt: Number(initialActiveWorkout?.workoutStartedAt) || 0,
  workoutCompleted: false,
  setStartedAt: 0,
  setAngles: [],
  setWarnings: 0,
  formWarnings: Number(initialActiveWorkout?.formWarnings) || 0,
  goodReps: Number(initialActiveWorkout?.goodReps) || 0,
  attemptedReps: Number(initialActiveWorkout?.attemptedReps) || 0,
  rejectedReps: Number(initialActiveWorkout?.rejectedReps) || 0,
  setAttemptedReps: resumeAfterCompletedSet ? 0 : Number(initialActiveWorkout?.setAttemptedReps) || 0,
  setRejectedReps: resumeAfterCompletedSet ? 0 : Number(initialActiveWorkout?.setRejectedReps) || 0,
  rejectionReasons: initialActiveWorkout?.rejectionReasons || {},
  qualityScores: initialActiveWorkout?.qualityScores || [],
  setQualityScores: resumeAfterCompletedSet ? [] : initialActiveWorkout?.setQualityScores || [],
  angleSamples: [],
  setHistory: initialActiveWorkout?.setHistory || [],
  exerciseLogs: initialActiveWorkout?.exerciseLogs || [],
  currentExerciseIndex: Number(initialActiveWorkout?.pendingRoutinePosition?.exerciseIndex
    ?? initialActiveWorkout?.currentExerciseIndex) || 0,
  currentRoutineSetIndex: Number(initialActiveWorkout?.pendingRoutinePosition?.setIndex
    ?? initialActiveWorkout?.currentRoutineSetIndex) || 0,
  pendingRoutinePosition: null,
  manualReps: Number(initialActiveWorkout?.manualReps) || 0,
  manualWeight: initialActiveWorkout?.manualWeight || "",
  manualRir: initialActiveWorkout?.manualRir ?? null,
  cameraWeight: initialActiveWorkout?.cameraWeight || "",
  resting: false,
  restTimer: 0,
  restRemaining: 0,
  restDuration: 0,
  activeCheckpointTimer: 0,
  workoutHistory: initialWorkoutHistory,
  profile: initialProfile,
  profileId: loadProfileId(),
  sessionNumber: resumedSessionPlan.sessionNumber,
  activeSessionPlan: resumedSessionPlan,
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
  countdownTimer: 0,
  voicePhase: "idle",
  trackingStarted: false,
  lastInferenceAt: 0,
  autoRecordAfterCountdown: true,
  smoothedAngle: null,
  currentDashboardSummary: null,
  currentView: "home",
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
  workoutPause: document.getElementById("workout-pause"),
  workoutBack: document.getElementById("workout-back"),
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
  consumerApp: document.getElementById("consumer-app"),
  homeView: document.getElementById("home-view"),
  profileView: document.getElementById("profile-view"),
  workoutView: document.getElementById("workout-view"),
  appNavigation: document.getElementById("app-navigation"),
  appNavButtons: Array.from(document.querySelectorAll("[data-app-view]")),
  homeGreeting: document.getElementById("home-greeting"),
  homeSyncStatus: document.getElementById("home-sync-status"),
  homeStreak: document.getElementById("home-streak"),
  homeWeek: document.getElementById("home-week"),
  homePlanTitle: document.getElementById("home-plan-title"),
  homePlanMeta: document.getElementById("home-plan-meta"),
  homePlanReason: document.getElementById("home-plan-reason"),
  homeSessionNumber: document.getElementById("home-session-number"),
  homeRoutine: document.getElementById("home-routine"),
  homeSessionCount: document.getElementById("home-session-count"),
  homeFormScore: document.getElementById("home-form-score"),
  homeTotalReps: document.getElementById("home-total-reps"),
  homeRecentSessions: document.getElementById("home-recent-sessions"),
  homeOpenHistory: document.getElementById("home-open-history"),
  profileForm: document.getElementById("profile-form"),
  profileName: document.getElementById("profile-name"),
  profileGoal: document.getElementById("profile-goal"),
  profileExperience: document.getElementById("profile-experience"),
  profileEquipment: document.getElementById("profile-equipment"),
  profileDays: document.getElementById("profile-days"),
  profileUnit: document.getElementById("profile-unit"),
  profileCardName: document.getElementById("profile-card-name"),
  profileCardGoal: document.getElementById("profile-card-goal"),
  profileSaveStatus: document.getElementById("profile-save-status"),
  activeExerciseName: document.getElementById("active-exercise-name"),
  activeExerciseMuscle: document.getElementById("active-exercise-muscle"),
  activeSetLabel: document.getElementById("active-set-label"),
  activeTarget: document.getElementById("active-target"),
  activeRir: document.getElementById("active-rir"),
  activeRest: document.getElementById("active-rest"),
  activeCue: document.getElementById("active-cue"),
  cameraWeightControl: document.getElementById("camera-weight-control"),
  cameraWeight: document.getElementById("camera-weight"),
  cameraWeightUnit: document.getElementById("camera-weight-unit"),
  routineProgressList: document.getElementById("routine-progress-list"),
  workoutPlanSheet: document.getElementById("workout-plan-sheet"),
  workoutSheetToggle: document.getElementById("workout-sheet-toggle"),
  manualSetControls: document.getElementById("manual-set-controls"),
  manualReps: document.getElementById("manual-reps"),
  manualRepsMinus: document.getElementById("manual-reps-minus"),
  manualRepsPlus: document.getElementById("manual-reps-plus"),
  manualWeight: document.getElementById("manual-weight"),
  manualWeightUnit: document.getElementById("manual-weight-unit"),
  manualRir: document.getElementById("manual-rir"),
  manualCompleteSet: document.getElementById("manual-complete-set"),
  restOverlay: document.getElementById("rest-overlay"),
  restTime: document.getElementById("rest-time"),
  restNext: document.getElementById("rest-next"),
  restProgressBar: document.getElementById("rest-progress-bar"),
  restSkip: document.getElementById("rest-skip"),
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

function loadUserProfile() {
  try {
    return normalizeProfile(JSON.parse(localStorage.getItem(USER_PROFILE_KEY) || "null") || DEFAULT_PROFILE);
  } catch (error) {
    return normalizeProfile(DEFAULT_PROFILE);
  }
}

function persistUserProfile(profile) {
  const normalized = normalizeProfile(profile);
  localStorage.setItem(USER_PROFILE_KEY, JSON.stringify(normalized));
  return normalized;
}

function loadActiveWorkoutSnapshot() {
  try {
    const snapshot = JSON.parse(localStorage.getItem(ACTIVE_WORKOUT_KEY) || "null");
    return snapshot && snapshot.schemaVersion === 3 ? snapshot : null;
  } catch (error) {
    return null;
  }
}

function clearActiveWorkoutSnapshot() {
  localStorage.removeItem(ACTIVE_WORKOUT_KEY);
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
  return buildAdaptiveArmSession({
    sessionNumber,
    history: state?.workoutHistory || initialWorkoutHistory,
    profile: state?.profile || initialProfile,
  });
}

function mergeWorkoutHistories(...historyGroups) {
  const byId = new Map();
  historyGroups.flat().forEach((item) => {
    if (!item || typeof item !== "object") return;
    const summary = item.statistics && typeof item.statistics === "object" ? item.statistics : item;
    if (summary.status === "in_progress") return;
    const id = String(summary.id || summary.session_id || "").trim();
    if (!id) return;
    byId.set(id, { ...byId.get(id), ...summary, id });
  });
  return Array.from(byId.values())
    .sort((left, right) => new Date(right.completedAt || 0) - new Date(left.completedAt || 0))
    .slice(0, MAX_HISTORY_SESSIONS);
}

function activeRoutineExercise() {
  return state.activeSessionPlan?.exercises?.[state.currentExerciseIndex] || null;
}

function activeRoutineSet() {
  return activeRoutineExercise()?.sets?.[state.currentRoutineSetIndex] || null;
}

function currentTargetReps() {
  return Number(activeRoutineSet()?.targetReps) || 10;
}

function plannedSetCount() {
  return Number(state.activeSessionPlan?.totalSets)
    || planTotals(state.activeSessionPlan).sets
    || 1;
}

function currentSetNumber() {
  return state.currentRoutineSetIndex + 1;
}

function currentExerciseLog(exercise = activeRoutineExercise()) {
  if (!exercise) return null;
  let log = state.exerciseLogs.find((item) => item.exerciseId === exercise.id);
  if (!log) {
    log = {
      exerciseId: exercise.id,
      name: exercise.name,
      muscle: exercise.muscle,
      tracking: exercise.tracking,
      sets: [],
    };
    state.exerciseLogs.push(log);
  }
  return log;
}

function isRoutineComplete() {
  return state.completedSets >= plannedSetCount();
}

function canFinishWorkout() {
  return isRoutineComplete();
}

function nextRoutinePosition() {
  const exercise = activeRoutineExercise();
  if (!exercise) return null;
  if (state.currentRoutineSetIndex + 1 < exercise.sets.length) {
    return {
      exerciseIndex: state.currentExerciseIndex,
      setIndex: state.currentRoutineSetIndex + 1,
    };
  }
  if (state.currentExerciseIndex + 1 < state.activeSessionPlan.exercises.length) {
    return {
      exerciseIndex: state.currentExerciseIndex + 1,
      setIndex: 0,
    };
  }
  return null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function formScore() {
  const attempts = Math.max(state.attemptedReps, state.goodReps, 1);
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
  const sessionNumber = Math.max(Number(summary.sessionNumber) || 0, highestSessionNumber(history)) + 1;
  return buildAdaptiveArmSession({
    sessionNumber,
    history,
    profile: state.profile,
  });
}

function plannedSessionDate(plan, completedAt) {
  if (!plan?.nextEligibleAt) return nextSessionDate(completedAt);
  try {
    return new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "2-digit", month: "short" })
      .format(new Date(plan.nextEligibleAt));
  } catch (error) {
    return nextSessionDate(completedAt);
  }
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function greetingForNow(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return "Buenos días";
  if (hour < 19) return "Buenas tardes";
  return "Buenas noches";
}

function completedWorkoutHistory() {
  return state.workoutHistory.filter((item) => item?.status !== "in_progress" && item?.completedAt);
}

function renderWeekStrip() {
  const historyDays = new Set(completedWorkoutHistory().map((item) => (
    new Date(item.completedAt).toLocaleDateString("en-CA")
  )));
  const today = new Date();
  const mondayOffset = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - mondayOffset);
  const formatter = new Intl.DateTimeFormat("es-MX", { weekday: "narrow" });
  els.homeWeek.innerHTML = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + index);
    const dayKey = day.toLocaleDateString("en-CA");
    const classes = ["week-day"];
    if (day.toDateString() === today.toDateString()) classes.push("today");
    if (historyDays.has(dayKey)) classes.push("completed");
    return `<div class="${classes.join(" ")}"><span>${formatter.format(day).toUpperCase()}</span><strong>${historyDays.has(dayKey) ? "✓" : day.getDate()}</strong></div>`;
  }).join("");
}

function renderHome() {
  const history = completedWorkoutHistory();
  const plan = state.activeSessionPlan;
  const totals = planTotals(plan);
  const readiness = analyzeHistory(history);
  const totalReps = history.reduce((sum, item) => sum + (Number(item.reps) || 0), 0);
  els.homeGreeting.textContent = greetingForNow();
  els.homePlanTitle.textContent = plan.title || plan.focus;
  els.homePlanMeta.textContent = `${totals.exercises} ejercicios · ${totals.sets} series · ${plan.estimatedMinutes || 35} min`;
  els.homePlanReason.textContent = `${plan.adaptation || "Rutina ajustada a tu historial"} ${plan.evidenceNote || ""}`.trim();
  els.homeSessionNumber.textContent = `S${state.sessionNumber}`;
  els.homeRoutine.innerHTML = (plan.exercises || []).map((exercise, index) => `
    <div class="home-exercise-row">
      <span class="exercise-index">${index + 1}</span>
      <span><strong>${escapeHtml(exercise.name)}</strong><small>${exercise.sets.length} series · ${escapeHtml(exercise.repRange || exercise.sets.map((set) => set.targetReps).join("/"))} reps · ${exercise.sets[0]?.restSeconds || 90}s</small></span>
      <span class="exercise-tracking-badge ${exercise.tracking}">${exercise.tracking === "camera" ? "IA CÁMARA" : "REGISTRO"}</span>
    </div>
  `).join("");
  els.homeSessionCount.textContent = String(history.length);
  els.homeFormScore.textContent = readiness.averageForm === null ? "--" : `${Math.round(readiness.averageForm)}%`;
  els.homeTotalReps.textContent = String(totalReps);
  const streak = trainingStreak(history);
  els.homeStreak.textContent = `${streak} ${streak === 1 ? "día" : "días"}`;
  const isResume = Boolean(state.workoutStartedAt && !state.workoutCompleted);
  els.liveStart.querySelector("strong").textContent = isResume ? "Continuar entrenamiento" : "Empezar entrenamiento";
  els.liveStart.querySelector("small").textContent = isResume
    ? `${state.completedSets}/${plannedSetCount()} series registradas`
    : "Javier te guía de principio a fin";
  els.homeRecentSessions.innerHTML = history.length
    ? history.slice(0, 4).map((item) => {
      const sets = Number(item.sets) || item.setHistory?.length || 0;
      const exerciseCount = item.exerciseLogs?.length || item.sessionPlan?.exercises?.length || 1;
      return `
        <article class="recent-session-row">
          <span class="recent-session-icon">✓</span>
          <span><strong>Sesión ${item.sessionNumber || ""} · ${escapeHtml(item.sessionPlan?.title || item.sessionPlan?.focus || "Brazos")}</strong><small>${formatDate(item.completedAt)} · ${exerciseCount} ejercicios · ${sets} series · ${formatTime(item.durationSeconds || 0)}</small></span>
          <span class="recent-session-score">${Number.isFinite(Number(item.formScore)) ? `${item.formScore}%` : "Lista"}</span>
        </article>
      `;
    }).join("")
    : `<div class="empty-history">Tu primera sesión creará aquí un registro con ejercicios, series, repeticiones, carga, RIR, descansos y técnica con cámara.</div>`;
  renderWeekStrip();
}

function renderProfile() {
  const profile = state.profile;
  els.profileName.value = profile.name;
  els.profileGoal.value = profile.goal;
  els.profileExperience.value = profile.experience;
  els.profileEquipment.value = profile.equipment;
  els.profileDays.value = String(profile.sessionsPerWeek);
  els.profileUnit.value = profile.preferredUnit;
  els.profileCardName.textContent = profile.name;
  els.profileCardGoal.textContent = profile.goal;
  document.querySelector(".profile-summary h1").textContent = profile.name;
  document.querySelector(".profile-goal-copy").textContent = profile.goal;
}

function setAppView(viewName) {
  const selected = ["home", "profile", "workout"].includes(viewName) ? viewName : "home";
  state.currentView = selected;
  els.homeView.hidden = selected !== "home";
  els.profileView.hidden = selected !== "profile";
  els.workoutView.hidden = selected !== "workout";
  document.body.classList.toggle("workout-mode", selected === "workout");
  document.body.classList.toggle("guided-workout", selected === "workout");
  els.appNavButtons.forEach((button) => {
    const active = button.dataset.appView === selected;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (selected === "workout") resizeOverlay();
  if (selected === "home") renderHome();
  if (selected === "profile") renderProfile();
}

function completedSetsForExercise(exerciseId) {
  return state.exerciseLogs.find((item) => item.exerciseId === exerciseId)?.sets?.length || 0;
}

function renderWorkoutPlan() {
  const exercise = activeRoutineExercise();
  const set = activeRoutineSet();
  if (!exercise || !set) return;
  state.targetReps = set.targetReps;
  els.drillTitle.textContent = exercise.name;
  els.activeExerciseName.textContent = exercise.name;
  els.activeExerciseMuscle.textContent = `${exercise.muscle} · ${exercise.tracking === "camera" ? "IA cámara" : "registro guiado"}`;
  els.activeSetLabel.textContent = `Ejercicio ${state.currentExerciseIndex + 1} de ${state.activeSessionPlan.exercises.length} · Serie ${state.currentRoutineSetIndex + 1} de ${exercise.sets.length}`;
  els.activeTarget.textContent = String(set.targetReps);
  els.activeRir.textContent = String(set.rirTarget);
  els.activeRest.textContent = String(set.restSeconds);
  els.activeCue.textContent = `${exercise.cue} Tempo ${exercise.tempo}. ${exercise.progression || ""}`;
  els.manualWeightUnit.textContent = state.profile.preferredUnit;
  els.cameraWeightUnit.textContent = state.profile.preferredUnit;
  els.cameraWeightControl.hidden = exercise.tracking !== "camera";
  els.manualSetControls.hidden = exercise.tracking === "camera" || state.resting;
  document.body.classList.toggle("manual-exercise", exercise.tracking !== "camera" && !state.resting);
  els.routineProgressList.innerHTML = state.activeSessionPlan.exercises.map((item, index) => {
    const completed = completedSetsForExercise(item.id);
    const classes = ["routine-progress-item"];
    if (index === state.currentExerciseIndex) classes.push("active");
    if (completed >= item.sets.length) classes.push("done");
    return `<div class="${classes.join(" ")}"><strong>${escapeHtml(item.name)}</strong><span>${completed}/${item.sets.length} series</span></div>`;
  }).join("");
  if (exercise.tracking !== "camera" && !state.manualReps) {
    state.manualReps = set.targetReps;
  }
  els.manualReps.textContent = String(state.manualReps || set.targetReps);
  if (!els.manualWeight.value && Number(exercise.suggestedLoad) > 0) {
    els.manualWeight.value = String(state.manualWeight || exercise.suggestedLoad);
  }
  if (!els.cameraWeight.value && exercise.tracking === "camera" && Number(exercise.suggestedLoad) > 0) {
    els.cameraWeight.value = String(state.cameraWeight || exercise.suggestedLoad);
  }
  els.manualRir.value = String(state.manualRir ?? set.rirTarget);
}

function activeWorkoutSnapshot() {
  return {
    schemaVersion: 3,
    status: "in_progress",
    updatedAt: new Date().toISOString(),
    workoutId: state.workoutId,
    workoutStartedAt: state.workoutStartedAt,
    sessionNumber: state.sessionNumber,
    plan: state.activeSessionPlan,
    currentExerciseIndex: state.currentExerciseIndex,
    currentRoutineSetIndex: state.currentRoutineSetIndex,
    pendingRoutinePosition: state.pendingRoutinePosition,
    currentSetReps: state.currentSetReps,
    manualReps: state.manualReps,
    totalReps: state.totalReps,
    completedSets: state.completedSets,
    formWarnings: state.formWarnings,
    goodReps: state.goodReps,
    attemptedReps: state.attemptedReps,
    rejectedReps: state.rejectedReps,
    setAttemptedReps: state.setAttemptedReps,
    setRejectedReps: state.setRejectedReps,
    rejectionReasons: state.rejectionReasons,
    qualityScores: state.qualityScores,
    setQualityScores: state.setQualityScores,
    setHistory: state.setHistory,
    exerciseLogs: state.exerciseLogs,
    manualWeight: state.manualWeight,
    manualRir: state.manualRir,
    cameraWeight: state.cameraWeight,
  };
}

function persistActiveWorkout({ cloud = false } = {}) {
  if (!state.workoutStartedAt || state.workoutCompleted) return;
  localStorage.setItem(ACTIVE_WORKOUT_KEY, JSON.stringify(activeWorkoutSnapshot()));
  if (!cloud || (!apiBase && !containerSasUrl())) return;
  window.clearTimeout(state.activeCheckpointTimer);
  state.activeCheckpointTimer = window.setTimeout(() => {
    saveWorkoutSummaryToAzure(workoutSummary({ status: "in_progress" }))
      .then(() => {
        els.homeSyncStatus.innerHTML = "<i></i> Guardado";
      })
      .catch((error) => console.warn("Active workout checkpoint failed", error));
  }, 1200);
}

function setProgressText() {
  const target = currentTargetReps();
  els.workoutProgress.textContent = `S${state.sessionNumber} · ${state.completedSets}/${plannedSetCount()} series · ${state.currentSetReps}/${target}`;
  els.stepStart.classList.toggle("active", !state.workoutStartedAt && !state.workoutCompleted);
  els.stepStart.classList.toggle("done", Boolean(state.workoutStartedAt));
  els.stepComplete.classList.toggle("active", Boolean(state.workoutStartedAt) && !state.workoutCompleted);
  els.stepComplete.classList.toggle("done", state.workoutCompleted);
}

function render() {
  const drill = activeDrill();
  const routineExercise = activeRoutineExercise();
  const routineSet = activeRoutineSet();
  els.drillTitle.textContent = routineExercise?.name || drill.title;
  els.panelTitle.textContent = drill.title;
  els.target.textContent = routineSet
    ? `${routineExercise.name} · ${routineSet.targetReps} reps · RIR ${routineSet.rirTarget}`
    : drill.target;
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
    || (isRoutineComplete() && !state.recording);
  els.newSession.disabled = state.workoutPreparing || state.recording || state.liveActive;
  els.cameraStart.hidden = Boolean(state.stream);
  els.liveStart.disabled = state.workoutPreparing;
  const startLabel = els.liveStart.querySelector("strong");
  if (startLabel && state.workoutPreparing) startLabel.textContent = "Preparando IA…";
  els.workoutPause.disabled = state.workoutPreparing || state.workoutCompleted;
  els.workoutPause.textContent = state.liveActive ? "Pausar" : "Continuar";
  els.switchCamera.disabled = state.workoutPreparing || !state.stream || state.recording;
  els.liveReset.disabled = state.workoutPreparing || state.recording || state.workoutCompleted || isRoutineComplete();
  els.finishWorkout.disabled = !canFinishWorkout() || state.recording || state.workoutCompleted;
  els.finishWorkout.textContent = state.workoutCompleted ? "Entrenamiento finalizado" : "Finalizar entrenamiento";
  setProgressText();
  renderWorkoutPlan();
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
  const setFraction = clamp(state.currentSetReps / Math.max(currentTargetReps(), 1), 0, 1);
  els.liveProgressBar.style.width = `${clamp(((state.completedSets + setFraction) / plannedSetCount()) * 100, 0, 100)}%`;
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
  const exerciseNames = plan.exercises.map((exercise) => exercise.name).join(", ");
  const firstExercise = activeRoutineExercise() || plan.exercises[0];
  const firstSet = activeRoutineSet() || firstExercise.sets?.[0];
  const speechParts = continuation
    ? [
      `Continuamos con la sesión ${state.sessionNumber}, ${plan.title}.`,
      `Retomamos ${firstExercise.name}, serie ${state.currentRoutineSetIndex + 1}, con ${firstSet.targetReps} repeticiones objetivo.`,
    ]
    : [
      `Hola ${state.profile.name}. Sesión ${state.sessionNumber}. Hoy es ${dateLabel} y vamos a hacer ${plan.title}.`,
      `La rutina tiene ${plan.totalSets} series: ${exerciseNames}. Durará aproximadamente ${plan.estimatedMinutes} minutos.`,
      `${plan.adaptation} Empezamos con ${firstExercise.name}, serie uno, objetivo ${firstSet.targetReps} repeticiones y RIR ${firstSet.rirTarget}.`,
      `${firstExercise.cue} Validaré por cámara este curl cuando vuelvas a extender el brazo. Si la técnica falla, no lo contaré y te diré qué corregir.`,
      "Ponte en posición. Enseguida contaré uno, dos, tres, y empezaremos.",
    ];
  const visiblePlan = speechParts.join(" ");
  els.liveCoach.textContent = visiblePlan;
  setLiveStatus(continuation ? "continuamos" : "briefing", "active");
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
  const isComplete = state.currentSetReps >= currentTargetReps();
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

  setAppView("workout");
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
    if (activeRoutineExercise()?.tracking !== "camera") {
      state.liveActive = true;
      if (!state.workoutStartedAt) state.workoutStartedAt = Date.now();
      if (!state.setStartedAt) state.setStartedAt = Date.now();
      state.liveStartedAt = Date.now();
      window.clearInterval(state.liveTimerInterval);
      state.liveTimerInterval = window.setInterval(updateLiveTime, 250);
      startManualExerciseGuidance({ continuation: wasAlreadyStarted });
      persistActiveWorkout({ cloud: true });
      return;
    }

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
    els.workoutPause.textContent = "Pausar";
    persistActiveWorkout({ cloud: true });
    if (wasAlreadyStarted) {
      announceSessionBriefing({ continuation: true });
    } else if (!state.sessionIntroSpoken) {
      announceSessionBriefing();
    }
  } finally {
    state.workoutPreparing = false;
    els.liveStart.disabled = false;
    render();
  }
}

function startManualExerciseGuidance({ continuation = false } = {}) {
  const exercise = activeRoutineExercise();
  const set = activeRoutineSet();
  if (!exercise || !set) return;
  window.cancelAnimationFrame(state.liveAnimationFrame);
  state.trackingStarted = false;
  state.countingEnabled = false;
  state.countdownActive = false;
  state.voicePhase = "workout";
  state.manualReps = state.manualReps || set.targetReps;
  state.setStartedAt = state.setStartedAt || Date.now();
  updateLiveDashboard({
    coach: `${exercise.name}, serie ${set.setNumber} de ${exercise.sets.length}. Objetivo ${set.targetReps} repeticiones, RIR ${set.rirTarget}. ${exercise.cue}`,
    status: "registro guiado",
    statusVariant: "active",
  });
  render();
  speak(
    `${continuation ? "Continuamos. " : "Siguiente ejercicio. "}${exercise.name}. Serie ${set.setNumber} de ${exercise.sets.length}. Haz ${set.targetReps} repeticiones y deja ${set.rirTarget} en reserva. ${exercise.cue} Cuando termines, registra carga, repeticiones y esfuerzo.`,
    { channel: "workout", rate: 1.04 },
  );
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
  if (state.resting) stopRestTimer({ advance: false });
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
  els.workoutPause.textContent = "Continuar";
  persistActiveWorkout({ cloud: true });
  updateLiveDashboard({
    coach: "Entrenamiento pausado. Toca Entrenar en vivo para continuar.",
    status: message,
    statusVariant: "warning",
  });
}

function recordCompletedSet() {
  if (state.setRecorded || state.currentSetReps < currentTargetReps()) return false;
  const exercise = activeRoutineExercise();
  const set = activeRoutineSet();
  const setRecord = {
    set: set.setNumber,
    globalSet: state.completedSets + 1,
    exerciseId: exercise.id,
    exerciseName: exercise.name,
    tracking: "camera",
    targetReps: set.targetReps,
    reps: state.currentSetReps,
    attempts: state.setAttemptedReps,
    rejectedReps: state.setRejectedReps,
    weight: Number(state.cameraWeight || els.cameraWeight?.value) || Number(exercise.suggestedLoad) || null,
    unit: state.profile.preferredUnit,
    rir: set.rirTarget,
    durationSeconds: Math.round((Date.now() - (state.setStartedAt || Date.now())) / 1000),
    averageAngle: Math.round(average(state.setAngles)),
    averageQuality: Math.round(average(state.setQualityScores)),
    warnings: state.setWarnings,
    completedAt: new Date().toISOString(),
  };
  commitRoutineSet(setRecord);
  const isWorkoutReady = isRoutineComplete();
  updateLiveDashboard({
    coach: isWorkoutReady
      ? "Rutina completada. Preparando tu resumen."
      : `Serie ${set.setNumber} completada. Javier iniciará tu descanso.`,
    status: isWorkoutReady ? "rutina completa" : "serie completa",
    statusVariant: isWorkoutReady ? "active" : "warning",
  });
  render();
  return true;
}

function commitRoutineSet(setRecord) {
  if (state.setRecorded) return false;
  const exercise = activeRoutineExercise();
  const log = currentExerciseLog(exercise);
  state.setRecorded = true;
  state.completedSets += 1;
  log.sets.push(setRecord);
  state.setHistory.push(setRecord);
  state.pendingRoutinePosition = nextRoutinePosition();
  persistActiveWorkout({ cloud: true });
  return true;
}

function completeManualSet() {
  if (state.setRecorded || state.resting || activeRoutineExercise()?.tracking === "camera") return;
  const exercise = activeRoutineExercise();
  const set = activeRoutineSet();
  const reps = clamp(Number(state.manualReps) || set.targetReps, 1, 100);
  const weight = Math.max(Number(state.manualWeight || els.manualWeight.value) || 0, 0);
  const rir = clamp(Number(state.manualRir ?? els.manualRir.value), 0, 4);
  state.currentSetReps = reps;
  state.totalReps += reps;
  const setRecord = {
    set: set.setNumber,
    globalSet: state.completedSets + 1,
    exerciseId: exercise.id,
    exerciseName: exercise.name,
    tracking: "manual",
    targetReps: set.targetReps,
    reps,
    attempts: reps,
    rejectedReps: 0,
    weight: weight || null,
    unit: state.profile.preferredUnit,
    rir,
    durationSeconds: Math.round((Date.now() - (state.setStartedAt || Date.now())) / 1000),
    averageQuality: null,
    warnings: 0,
    completedAt: new Date().toISOString(),
  };
  if (!commitRoutineSet(setRecord)) return;
  updateLiveDashboard({
    coach: `${exercise.name}, serie ${set.setNumber} guardada: ${reps} repeticiones${weight ? ` con ${weight} ${state.profile.preferredUnit}` : ""}, RIR ${rir}.`,
    status: "serie guardada",
    statusVariant: "active",
  });
  const afterVoice = () => {
    if (isRoutineComplete()) finishWorkout();
    else beginRest(set.restSeconds, state.pendingRoutinePosition);
  };
  speak(`Serie completada. Registré ${reps} repeticiones y RIR ${rir}.`, {
    channel: "workout",
    onend: afterVoice,
    onerror: afterVoice,
    pauseAfter: 40,
  });
  render();
}

function formatRestCountdown(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function describeRoutinePosition(position) {
  if (!position) return "Resumen de la sesión";
  const exercise = state.activeSessionPlan.exercises[position.exerciseIndex];
  const set = exercise.sets[position.setIndex];
  return `${exercise.name} · serie ${set.setNumber} · ${set.targetReps} reps`;
}

function beginRest(seconds, nextPosition) {
  if (!nextPosition) {
    finishWorkout();
    return;
  }
  if (state.recording) stopRecording();
  window.cancelAnimationFrame(state.liveAnimationFrame);
  state.trackingStarted = false;
  state.countingEnabled = false;
  state.resting = true;
  state.restDuration = Math.max(Number(seconds) || 60, 10);
  state.restRemaining = state.restDuration;
  state.pendingRoutinePosition = nextPosition;
  els.restOverlay.hidden = false;
  els.restNext.textContent = `Siguiente: ${describeRoutinePosition(nextPosition)}`;
  els.restTime.textContent = formatRestCountdown(state.restRemaining);
  els.restProgressBar.style.width = "100%";
  setLiveStatus("descanso", "warning");
  render();
  speak(`Descansa ${state.restDuration} segundos. Después haremos ${describeRoutinePosition(nextPosition)}.`, {
    channel: "workout",
    dedupeKey: "rest-start",
  });
  window.clearInterval(state.restTimer);
  state.restTimer = window.setInterval(() => {
    state.restRemaining = Math.max(state.restRemaining - 1, 0);
    els.restTime.textContent = formatRestCountdown(state.restRemaining);
    els.restProgressBar.style.width = `${(state.restRemaining / state.restDuration) * 100}%`;
    if (state.restRemaining === 10) speak("Diez segundos. Prepárate.", { channel: "workout", dedupeKey: "rest-ten" });
    if (state.restRemaining <= 0) stopRestTimer({ advance: true });
  }, 1000);
}

function stopRestTimer({ advance = true } = {}) {
  window.clearInterval(state.restTimer);
  state.restTimer = 0;
  state.resting = false;
  els.restOverlay.hidden = true;
  if (!state.pendingRoutinePosition) {
    render();
    return;
  }
  if (!advance) {
    const next = state.pendingRoutinePosition;
    state.pendingRoutinePosition = null;
    state.currentExerciseIndex = next.exerciseIndex;
    state.currentRoutineSetIndex = next.setIndex;
    state.currentSetReps = 0;
    state.setAttemptedReps = 0;
    state.setRejectedReps = 0;
    state.setAngles = [];
    state.setWarnings = 0;
    state.setQualityScores = [];
    state.setRecorded = false;
    state.manualReps = currentTargetReps();
    state.manualWeight = "";
    state.manualRir = null;
    state.setStartedAt = 0;
    render();
    return;
  }
  const next = state.pendingRoutinePosition;
  state.pendingRoutinePosition = null;
  activateRoutinePosition(next);
}

function activateRoutinePosition(position) {
  state.currentExerciseIndex = position.exerciseIndex;
  state.currentRoutineSetIndex = position.setIndex;
  state.currentSetReps = 0;
  state.setAttemptedReps = 0;
  state.setRejectedReps = 0;
  state.setAngles = [];
  state.setWarnings = 0;
  state.setQualityScores = [];
  state.setRecorded = false;
  state.completionScheduled = false;
  state.manualReps = currentTargetReps();
  state.manualWeight = "";
  state.manualRir = null;
  state.setStartedAt = Date.now();
  state.lastSpokenRep = 0;
  state.curlQualityTracker?.reset();
  els.manualWeight.value = "";
  render();
  persistActiveWorkout({ cloud: true });
  if (activeRoutineExercise().tracking === "camera") {
    state.voicePhase = "briefing";
    state.briefingFinished = false;
    clearSpeechQueue();
    speak(`Serie ${currentSetNumber()} de ${activeRoutineExercise().sets.length}. Objetivo ${currentTargetReps()} repeticiones. ${activeRoutineExercise().cue}`, {
      channel: "sequence",
      onend: () => {
        state.briefingFinished = true;
        startCountdown();
      },
      onerror: () => {
        state.briefingFinished = true;
        startCountdown();
      },
      pauseAfter: 60,
    });
  } else {
    startManualExerciseGuidance();
  }
}

function resetLiveWorkout() {
  state.currentSetReps = 0;
  state.trackingStarted = false;
  state.countingEnabled = false;
  state.countdownActive = false;
  state.briefingFinished = false;
  state.voicePhase = "idle";
  window.clearTimeout(state.countdownTimer);
  state.setRecorded = false;
  state.lastSpokenRep = 0;
  state.lastSpokenCue = "";
  state.lastCueAt = 0;
  state.setStartedAt = state.liveActive ? Date.now() : 0;
  state.setAngles = [];
  state.setWarnings = 0;
  state.setAttemptedReps = 0;
  state.setRejectedReps = 0;
  state.setQualityScores = [];
  state.smoothedAngle = null;
  state.curlQualityTracker?.reset();
  clearSpeechQueue();
  state.liveStartedAt = state.liveActive ? Date.now() : 0;
  clearOverlay();
  updateLiveDashboard({
    angle: null,
    coach: isRoutineComplete()
      ? "La rutina ya está completa. Puedes revisar el dashboard."
      : `Serie ${currentSetNumber()} lista. Objetivo ${currentTargetReps()} repeticiones.`,
    status: state.liveActive ? "en vivo" : "pose lista",
    statusVariant: state.liveActive ? "active" : "",
  });
}

function workoutSummary({ status = "completed" } = {}) {
  const completed = status === "completed";
  const volume = state.exerciseLogs.reduce((sum, exercise) => (
    sum + (exercise.sets || []).reduce((setSum, set) => (
      setSum + ((Number(set.weight) || 0) * (Number(set.reps) || 0))
    ), 0)
  ), 0);
  return {
    id: sessionId(),
    schemaVersion: 3,
    status,
    sessionNumber: state.sessionNumber,
    startedAt: state.workoutStartedAt ? new Date(state.workoutStartedAt).toISOString() : null,
    updatedAt: new Date().toISOString(),
    completedAt: completed ? new Date().toISOString() : null,
    sets: state.completedSets,
    plannedSets: plannedSetCount(),
    completionRate: Number((state.completedSets / plannedSetCount()).toFixed(3)),
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
    exerciseLogs: state.exerciseLogs,
    totalVolume: Number(volume.toFixed(1)),
    volumeUnit: `${state.profile.preferredUnit}·reps`,
    currentExerciseIndex: state.currentExerciseIndex,
    currentRoutineSetIndex: state.currentRoutineSetIndex,
    sessionPlan: state.activeSessionPlan,
    profileSnapshot: state.profile,
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
  const nextSession = summary.nextSessionPlan?.schemaVersion >= 3
    ? summary.nextSessionPlan
    : buildNextSession(summary, history);
  const rejectedReps = Number(summary.rejectedReps ?? summary.warnings ?? 0);
  const attempts = Number(summary.attempts) || Number(summary.goodReps || 0) + rejectedReps;
  const plannedSets = Number(summary.plannedSets) || planTotals(summary.sessionPlan).sets || summary.sets;
  const volume = Number(summary.totalVolume) || 0;
  state.currentDashboardSummary = summary;
  state.nextSessionPlan = nextSession;
  els.dashboardSyncStatus.classList.remove("ready", "warning");
  els.dashboardTitle.textContent = `Sesión ${summary.sessionNumber || history.length} completada`;
  els.dashboardSubtitle.textContent = `${summary.sessionPlan?.title || "Rutina de brazos"} · ${summary.sets}/${plannedSets} series · ${summary.reps} repeticiones · ${duration}. La técnica corresponde al bloque de curl validado por cámara.`;
  els.dashboardMetrics.innerHTML = [
    ["Series", `${summary.sets}/${plannedSets}`],
    ["Repeticiones", `${summary.reps}`],
    ["Volumen", volume ? `${Math.round(volume)} ${summary.profileSnapshot?.preferredUnit || state.profile.preferredUnit}` : "Sin carga"],
    ["Técnica", `${summary.formScore}%`],
  ].map(([label, value]) => `<div class="metric-card"><span class="metric-label">${label}</span><strong class="metric-value">${value}</strong></div>`).join("");

  els.dashboardSessionStatus.textContent = `${summary.sets}/${plannedSets} series · ${rejectedReps} curls no contados`;
  const setHistory = Array.isArray(summary.setHistory) && summary.setHistory.length
    ? summary.setHistory
    : [{ set: 1, reps: summary.reps, durationSeconds: summary.durationSeconds, averageAngle: summary.averageAngle, warnings: summary.warnings }];
  els.dashboardSetList.innerHTML = setHistory.map((set) => `
    <div class="set-row">
      <span><strong>${escapeHtml(set.exerciseName || `Serie ${set.set}`)} · S${set.set}</strong><small>${Number(set.durationSeconds) || 0}s · ${set.weight ? `${set.weight} ${set.unit || state.profile.preferredUnit} · ` : ""}RIR ${Number.isFinite(Number(set.rir)) ? set.rir : "--"}${set.tracking === "camera" ? ` · calidad ${set.averageQuality || summary.averageQuality || "--"}%` : " · registro guiado"}</small></span>
      <span>${set.reps}/${set.targetReps || set.reps} reps${Number(set.rejectedReps ?? set.warnings ?? 0) ? ` · ${Number(set.rejectedReps ?? set.warnings ?? 0)} no contadas` : ""}</span>
    </div>
  `).join("");

  els.nextSessionDate.textContent = `Recuperación estimada hasta ${plannedSessionDate(nextSession, summary.completedAt)}`;
  els.nextSessionGoal.textContent = nextSession.goal;
  els.nextRoutine.innerHTML = nextSession.exercises.map((item) => `
    <div class="routine-row">
      <span><strong>${escapeHtml(item.name)}</strong><small>${item.sets.length} series · ${escapeHtml(item.repRange)} reps · ${item.sets[0]?.restSeconds || 90}s</small></span>
      <em>RIR ${item.sets[0]?.rirTarget ?? 2}</em>
    </div>
  `).join("");
  els.nextSessionNote.textContent = `${nextSession.adaptation} ${nextSession.evidenceNote}`;
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
      <span><strong>Sesión ${item.sessionNumber || Math.max(history.length - index, 1)} · ${formatDate(item.completedAt)}</strong><small>${item.reps || 0} reps · ${item.sets || 0} series · ${formatTime(item.durationSeconds)} · ${Number(item.rejectedReps ?? item.warnings ?? 0)} curls no contados</small></span>
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
  const completed = summary.status !== "in_progress";
  const nextSession = completed
    ? (summary.nextSessionPlan?.schemaVersion >= 3
      ? summary.nextSessionPlan
      : buildNextSession(summary, historyFor(summary)))
    : null;
  const payload = {
    schema_version: 3,
    type: "adaptive_arm_workout_summary",
    status: summary.status || "completed",
    profile_id: state.profileId,
    session_id: summary.id,
    workout_id: summary.id,
    exercise: "adaptive_arm_training",
    completed_at: summary.completedAt,
    statistics: summary,
    next_session: nextSession,
    profile: state.profile,
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
    const nextPlan = latest.nextSessionPlan?.schemaVersion >= 3
      ? latest.nextSessionPlan
      : buildNextSession(latest, state.workoutHistory);
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
  renderHome();
  els.homeSyncStatus.innerHTML = "<i></i> Sincronizado";
  return state.workoutHistory;
}

function safeBlobSegment(value) {
  return String(value || "session").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 100) || "session";
}

function finishWorkout() {
  if (state.workoutCompleted) return;
  if (!canFinishWorkout()) {
    updateLiveDashboard({
      coach: `No puedes finalizar todavía: te faltan ${Math.max(plannedSetCount() - state.completedSets, 0)} series de la rutina.`,
      status: "objetivo pendiente",
      statusVariant: "warning",
    });
    speak(`Aún no puedes finalizar. Te faltan ${Math.max(plannedSetCount() - state.completedSets, 0)} series de tu rutina.`);
    return;
  }
  state.workoutCompleted = true;
  state.resting = false;
  window.clearInterval(state.restTimer);
  if (state.recording) stopRecording();
  const summary = workoutSummary();
  const historyWithCurrent = mergeWorkoutHistories([summary], state.workoutHistory);
  summary.nextSessionPlan = buildNextSession(summary, historyWithCurrent);
  state.nextSessionPlan = summary.nextSessionPlan;
  localStorage.setItem(NEXT_SESSION_PLAN_KEY, JSON.stringify(summary.nextSessionPlan));
  state.workoutHistory = mergeWorkoutHistories([summary], state.workoutHistory);
  persistHistory();
  clearActiveWorkoutSnapshot();
  stopLiveWorkout("completado");
  renderResultsDashboard(summary);
  els.resultsDashboard.hidden = false;
  document.body.classList.add("dashboard-mode");
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
  speak(`Excelente trabajo, ${state.profile.name}. Completaste ${summary.sets} series y ${summary.reps} repeticiones. Tu sesión quedó guardada y ya diseñé una rutina diferente para la próxima vez.`, { channel: "complete" });
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
  state.qualityScores.push(quality.qualityScore);
  state.setQualityScores.push(quality.qualityScore);
  persistActiveWorkout();
  return state.currentSetReps >= currentTargetReps() ? recordCompletedSet() : false;
}

function registerRejectedCurl(quality) {
  state.attemptedReps += 1;
  state.setAttemptedReps += 1;
  state.rejectedReps += 1;
  state.setRejectedReps += 1;
  state.formWarnings += 1;
  state.setWarnings += 1;
  state.rejectionReasons[quality.reason] = (state.rejectionReasons[quality.reason] || 0) + 1;
  state.qualityScores.push(quality.qualityScore);
  state.setQualityScores.push(quality.qualityScore);
  persistActiveWorkout();
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
      coach: `Serie de ${currentTargetReps()} repeticiones válida. Preparando el siguiente paso.`,
      status: "serie completada",
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
    const setComplete = registerAcceptedCurl(event.quality);
    coach = setComplete
      ? `Objetivo de ${currentTargetReps()} repeticiones completado.`
      : `Repetición ${state.currentSetReps} válida. Sigue con el mismo control.`;
    status = "repetición válida";
    if (setComplete && !state.completionScheduled) {
      state.completionScheduled = true;
      let transitionStarted = false;
      const continueAfterCount = () => {
        if (transitionStarted) return;
        transitionStarted = true;
        window.setTimeout(() => {
          state.completionScheduled = false;
          if (canFinishWorkout()) finishWorkout();
          else beginRest(activeRoutineSet().restSeconds, state.pendingRoutinePosition);
        }, 90);
      };
      announceRep({ onComplete: continueAfterCount });
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

async function startRecording() {
  if (state.recording) return;
  if (!state.liveActive || !state.countingEnabled) {
    state.autoRecordAfterCountdown = true;
    if (!state.liveActive) await startLiveWorkout({ autoRecord: true });
    return;
  }
  if (!state.setStartedAt) state.setStartedAt = Date.now();
  state.lastSpokenRep = state.currentSetReps;
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

  if (els.videoDownload.href) URL.revokeObjectURL(els.videoDownload.href);
  els.videoDownload.href = URL.createObjectURL(videoBlob);
  els.videoDownload.download = `${basename}.${extension}`;
  if (els.metadataDownload.href) URL.revokeObjectURL(els.metadataDownload.href);
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
  const candidate = plan || loadNextSessionPlan();
  const nextNumber = highestSessionNumber(completedWorkoutHistory()) + 1;
  const selectedPlan = candidate?.schemaVersion >= 3
    ? candidate
    : buildAdaptiveArmSession({
      sessionNumber: nextNumber,
      history: completedWorkoutHistory(),
      profile: state.profile,
    });
  clearSpeechQueue();
  stopRestTimer({ advance: false });
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
  state.exerciseLogs = [];
  state.currentExerciseIndex = 0;
  state.currentRoutineSetIndex = 0;
  state.pendingRoutinePosition = null;
  state.manualReps = state.activeSessionPlan.exercises[0].sets[0].targetReps;
  state.manualWeight = "";
  state.manualRir = null;
  state.cameraWeight = "";
  els.manualWeight.value = "";
  els.cameraWeight.value = "";
  state.resting = false;
  state.completionScheduled = false;
  state.sessionIntroSpoken = false;
  els.resultsDashboard.hidden = true;
  document.body.classList.remove("dashboard-mode");
  clearActiveWorkoutSnapshot();
  resetLiveWorkout();
  els.downloads.hidden = true;
  els.status.textContent = `Sesión ${state.sessionNumber} lista`;
  render();
  renderHome();
  return true;
}

async function startGeneratedNextSession() {
  const plan = state.nextSessionPlan
    || loadNextSessionPlan()
    || defaultSessionPlan(highestSessionNumber(state.workoutHistory) + 1);
  if (!prepareNewSession(plan)) return;
  updateLiveDashboard({
    coach: `Preparando tu sesión ${state.sessionNumber}: ${state.activeSessionPlan.title}.`,
    status: "preparando",
    statusVariant: "warning",
  });
  await startLiveWorkout({ autoRecord: true });
}

function openHistoricalDashboard() {
  const latest = completedWorkoutHistory()[0];
  if (!latest) {
    updateLiveDashboard({
      coach: "Todavía no hay sesiones guardadas. Completa tu primera rutina para crear el historial.",
      status: "sin historial",
      statusVariant: "warning",
    });
    speak("Todavía no hay sesiones guardadas. Completa tu primera sesión para ver el progreso.", { channel: "control" });
    return;
  }
  renderResultsDashboard(latest, { syncState: "saved", page: "progress" });
  els.resultsDashboard.hidden = false;
  document.body.classList.add("dashboard-mode");
  syncWorkoutHistoryFromAzure().catch((error) => console.warn("History sync failed", error));
}

function handleStartRequest() {
  if (state.workoutCompleted) {
    const next = state.nextSessionPlan
      || buildAdaptiveArmSession({
        sessionNumber: highestSessionNumber(completedWorkoutHistory()) + 1,
        history: completedWorkoutHistory(),
        profile: state.profile,
      });
    prepareNewSession(next);
  }
  startLiveWorkout().catch((error) => {
    console.error("Live workout failed", error);
    alert(`No pude iniciar entrenamiento en vivo: ${error.message || error}`);
    setAppView("home");
  });
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
  handleStartRequest();
});

els.workoutPause.addEventListener("click", () => {
  if (state.liveActive) stopLiveWorkout("pausado");
  else handleStartRequest();
});

els.workoutBack.addEventListener("click", () => {
  if (state.liveActive) stopLiveWorkout("pausado");
  setAppView("home");
});

els.liveReset.addEventListener("click", resetLiveWorkout);

els.finishWorkout.addEventListener("click", finishWorkout);

els.dashboardClose.addEventListener("click", () => {
  els.resultsDashboard.hidden = true;
  document.body.classList.remove("dashboard-mode");
  setAppView("home");
});

els.dashboardOpenHistory.addEventListener("click", openHistoricalDashboard);
els.homeOpenHistory.addEventListener("click", openHistoricalDashboard);

els.dashboardTabs.forEach((tab) => {
  tab.addEventListener("click", () => setDashboardPage(tab.dataset.dashboardPage));
});

els.dashboardNewSession.addEventListener("click", () => {
  document.body.classList.remove("dashboard-mode");
  startGeneratedNextSession().catch((error) => {
    console.error("Next session failed", error);
    alert(`No pude iniciar la siguiente sesión: ${error.message || error}`);
  });
});

els.appNavButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const destination = button.dataset.appView;
    if (destination === "progress") {
      openHistoricalDashboard();
      return;
    }
    if (destination === "workout") {
      handleStartRequest();
      return;
    }
    setAppView(destination);
  });
});

els.profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.profile = persistUserProfile({
    name: els.profileName.value,
    goal: els.profileGoal.value,
    experience: els.profileExperience.value,
    equipment: els.profileEquipment.value,
    sessionsPerWeek: Number(els.profileDays.value),
    preferredUnit: els.profileUnit.value,
    avatar: DEFAULT_PROFILE.avatar,
  });
  if (!state.workoutStartedAt || state.workoutCompleted) {
    state.activeSessionPlan = buildAdaptiveArmSession({
      sessionNumber: highestSessionNumber(completedWorkoutHistory()) + 1,
      history: completedWorkoutHistory(),
      profile: state.profile,
    });
    state.sessionNumber = state.activeSessionPlan.sessionNumber;
    localStorage.setItem(NEXT_SESSION_PLAN_KEY, JSON.stringify(state.activeSessionPlan));
  }
  renderProfile();
  renderHome();
  els.profileSaveStatus.textContent = "Preferencias guardadas. La próxima rutina fue recalculada.";
  window.setTimeout(() => { els.profileSaveStatus.textContent = ""; }, 3500);
});

els.manualRepsMinus.addEventListener("click", () => {
  state.manualReps = Math.max((Number(state.manualReps) || currentTargetReps()) - 1, 1);
  els.manualReps.textContent = String(state.manualReps);
  persistActiveWorkout();
});

els.manualRepsPlus.addEventListener("click", () => {
  state.manualReps = Math.min((Number(state.manualReps) || currentTargetReps()) + 1, 100);
  els.manualReps.textContent = String(state.manualReps);
  persistActiveWorkout();
});

els.manualCompleteSet.addEventListener("click", completeManualSet);
els.restSkip.addEventListener("click", () => stopRestTimer({ advance: true }));
els.workoutSheetToggle.addEventListener("click", () => {
  els.workoutPlanSheet.classList.toggle("collapsed");
});
[els.manualWeight, els.manualRir, els.cameraWeight].forEach((input) => {
  input.addEventListener("change", () => {
    if (input === els.manualWeight) state.manualWeight = input.value;
    if (input === els.manualRir) state.manualRir = Number(input.value);
    if (input === els.cameraWeight) state.cameraWeight = input.value;
    persistActiveWorkout();
  });
});

els.switchCamera.addEventListener("click", () => {
  switchCamera().catch((error) => {
    console.error("Camera switch failed", error);
    alert(`No pude cambiar camara: ${error.message || error}`);
  });
});

els.azureSas.value = containerSasUrl();
state.manualReps = state.manualReps || currentTargetReps();
render();
updateLiveDashboard();
renderProfile();
renderHome();
setAppView("home");
preloadTrackingModels({ silent: true }).catch((error) => {
  console.warn("Background model preload failed", error);
});
syncWorkoutHistoryFromAzure().catch((error) => {
  console.warn("Azure history is not available yet", error);
});
window.addEventListener("resize", resizeOverlay);
window.addEventListener("beforeunload", () => persistActiveWorkout());

window.__JAVIER_APP_DEBUG__ = {
  getState: () => ({
    sessionNumber: state.sessionNumber,
    currentExerciseIndex: state.currentExerciseIndex,
    currentRoutineSetIndex: state.currentRoutineSetIndex,
    completedSets: state.completedSets,
    targetReps: currentTargetReps(),
    plan: state.activeSessionPlan,
  }),
};

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
    .then((registration) => registration.update())
    .catch((error) => {
      console.warn("PWA registration failed", error);
    });
}
