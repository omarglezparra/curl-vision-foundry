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
    title: "Curl limpio - frente",
    target: "1 serie completa con tecnica buena",
    cues: ["Camara al frente", "Torso quieto", "Hombro estable", "Rango completo"],
  },
  {
    id: "good_curl_45",
    exercise: "biceps_curl",
    label: "good_form",
    angle: "45_degrees",
    captureType: "set",
    title: "Curl limpio - 45 grados",
    target: "1 serie completa con tecnica buena",
    cues: ["Camara a 45 grados", "Codo visible", "Muneca visible", "Tempo controlado"],
  },
  {
    id: "good_curl_side",
    exercise: "biceps_curl",
    label: "good_form",
    angle: "side",
    captureType: "set",
    title: "Curl limpio - lateral",
    target: "1 serie completa con tecnica buena",
    cues: ["Camara lateral", "Brazo completo visible", "Rango completo", "Sin balanceo"],
  },
  {
    id: "good_workout_full",
    exercise: "full_workout",
    label: "good_form",
    angle: "mixed",
    captureType: "full_session",
    title: "Sesion gym completa",
    target: "Graba tu entrenamiento limpio completo",
    cues: ["Solo reps buenas", "Cambia angulo si hace falta", "Mantente visible", "Pausa si hay dolor"],
  },
];

const heyCyanDrill = {
  id: "heycyan_bv100_mirror_import",
  exercise: "biceps_curl",
  label: "good_form",
  angle: "mirror_bv100",
  captureType: "set",
  title: "HeyCyan BV100",
  target: "Video importado desde Fotos",
  cues: ["HeyCyan", "Espejo", "Brazo completo visible", "Auto dataset"],
};

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
  targetReps: 12,
  curlPhase: "unknown",
  selectedArm: "auto",
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
  heycyanFile: document.getElementById("heycyan-file"),
  heycyanImport: document.getElementById("heycyan-import"),
  heycyanStatus: document.getElementById("heycyan-status"),
  azureSas: document.getElementById("azure-sas"),
  saveAzure: document.getElementById("save-azure"),
  newSession: document.getElementById("new-session"),
  liveStatus: document.getElementById("live-status"),
  liveReps: document.getElementById("live-reps"),
  liveAngle: document.getElementById("live-angle"),
  liveTime: document.getElementById("live-time"),
  liveProgressBar: document.getElementById("live-progress-bar"),
  liveCoach: document.getElementById("live-coach"),
  liveStart: document.getElementById("live-start"),
  liveReset: document.getElementById("live-reset"),
  switchCamera: document.getElementById("switch-camera"),
};

const poseModelUrl =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
const poseWasmUrl = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const armLandmarks = {
  left: { shoulder: 11, elbow: 13, wrist: 15 },
  right: { shoulder: 12, elbow: 14, wrist: 16 },
};

const apiBase = window.CURL_VISION_API_BASE || "";
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
  els.newSession.disabled = state.recording;

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
  } catch (error) {
    els.status.textContent = "No se pudo abrir la camara";
    updateLiveDashboard({
      coach: "No se pudo abrir la camara. En iPhone abre el link con HTTPS y permite acceso a la camara.",
      status: "sin camara",
      statusVariant: "warning",
    });
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
  els.liveProgressBar.style.width = `${clamp((state.currentSetReps / state.targetReps) * 100, 0, 100)}%`;
  if (coach) els.liveCoach.textContent = coach;
  if (status) setLiveStatus(status, statusVariant);
  updateLiveTime();
}

async function loadPoseModel() {
  if (state.poseLandmarker) return state.poseLandmarker;
  if (state.poseLoadPromise) return state.poseLoadPromise;

  state.poseLoading = true;
  updateLiveDashboard({
    coach: "Cargando detector de pose. La primera vez puede tardar unos segundos.",
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

async function startLiveWorkout() {
  if (state.liveActive) {
    stopLiveWorkout("pausado");
    return;
  }

  if (!state.stream) {
    await startCamera();
  }
  if (!state.stream) return;

  await loadPoseModel();
  state.liveActive = true;
  state.lastVideoTime = -1;
  state.liveStartedAt = Date.now();
  window.clearInterval(state.liveTimerInterval);
  state.liveTimerInterval = window.setInterval(updateLiveTime, 250);
  els.liveStart.textContent = "Pausar";
  updateLiveDashboard({
    coach: "Entrenamiento activo. Ponte completo en cuadro y empieza con el brazo abajo.",
    status: "en vivo",
    statusVariant: "active",
  });
  predictPose();
}

function stopLiveWorkout(message = "pausado") {
  state.liveActive = false;
  window.cancelAnimationFrame(state.liveAnimationFrame);
  window.clearInterval(state.liveTimerInterval);
  els.liveStart.textContent = "Entrenar en vivo";
  updateLiveDashboard({
    coach: "Entrenamiento pausado. Toca Entrenar en vivo para continuar.",
    status: message,
    statusVariant: "warning",
  });
}

function resetLiveWorkout() {
  state.currentSetReps = 0;
  state.totalReps = 0;
  state.curlPhase = "unknown";
  state.liveStartedAt = state.liveActive ? Date.now() : 0;
  clearOverlay();
  updateLiveDashboard({
    angle: null,
    coach: "Reiniciado. Empieza con el brazo extendido y visible.",
    status: state.liveActive ? "en vivo" : "pose lista",
    statusVariant: state.liveActive ? "active" : "",
  });
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
      state.totalReps += 1;
      state.currentSetReps += 1;
      state.curlPhase = "up";
      if (state.currentSetReps >= state.targetReps) {
        return "Serie completa. Puedes pausar o reiniciar.";
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

  const coach = countCurl(angle);
  updateLiveDashboard({
    angle,
    coach,
    status: "en vivo",
    statusVariant: "active",
  });
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
  const options = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
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

function startRecording() {
  if (!state.stream || state.recording) return;
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
    source: "iphone_safari_gym_capture",
    training_intent: "good_form_only",
    use_for_training: drill.exercise === "biceps_curl",
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
    body: metadataBlob,
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

async function importHeyCyanFile(file) {
  if (!file) return;

  els.heycyanStatus.textContent = "Preparando video...";
  const drill = heyCyanDrill;
  const startedAt = file.lastModified ? new Date(file.lastModified) : new Date();
  const createdAt = new Date();
  const durationSeconds = await videoDuration(file);
  const captureId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const mimeType = mimeTypeForFile(file);
  const extension = videoExtensionForFile(file);
  const basename = `${sessionId()}_${drill.exercise}_${drill.label}_${drill.angle}_${workoutStamp(createdAt)}`;
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
    created_at: createdAt.toISOString(),
    source: "heycyan_bv100_safari_file_import",
    source_filename: file.name,
    training_intent: "good_form_only",
    use_for_training: true,
    video_file: `video.${extension}`,
    video_file_extension: extension,
    video_mime_type: mimeType,
  };
  const blobPrefix = `${drill.label}/${drill.angle}/${metadata.session_id}/${captureId}`;
  metadata.azure_blob_prefix = blobPrefix;
  metadata.video_blob = `${blobPrefix}/${metadata.video_file}`;
  metadata.metadata_blob = `${blobPrefix}/metadata.json`;

  const metadataBlob = new Blob([JSON.stringify(metadata, null, 2)], {
    type: "application/json",
  });

  els.videoDownload.href = URL.createObjectURL(file);
  els.videoDownload.download = `${basename}.${extension}`;
  els.metadataDownload.href = URL.createObjectURL(metadataBlob);
  els.metadataDownload.download = `${basename}.json`;
  els.downloads.hidden = false;
  state.clipCount += 1;
  render();

  try {
    els.heycyanStatus.textContent = containerSasUrl() || apiBase ? "Subiendo a Azure..." : "Importado local";
    await uploadToAzure(file, metadataBlob, metadata);
    els.heycyanStatus.textContent = containerSasUrl() || apiBase ? "HeyCyan subido" : "HeyCyan importado";
  } catch (error) {
    console.error("HeyCyan upload failed", error);
    els.heycyanStatus.textContent = "Fallo subida";
    alert(`HeyCyan upload failed: ${error.message || error}`);
  }
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
    startRecording();
  }
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
  els.downloads.hidden = true;
  els.status.textContent = "Nueva sesion lista";
  render();
});

els.liveStart.addEventListener("click", () => {
  startLiveWorkout().catch((error) => {
    console.error("Live workout failed", error);
    alert(`No pude iniciar entrenamiento en vivo: ${error.message || error}`);
  });
});

els.liveReset.addEventListener("click", resetLiveWorkout);

els.switchCamera.addEventListener("click", () => {
  switchCamera().catch((error) => {
    console.error("Camera switch failed", error);
    alert(`No pude cambiar camara: ${error.message || error}`);
  });
});

els.heycyanImport.addEventListener("click", () => {
  els.heycyanFile.click();
});

els.heycyanFile.addEventListener("change", () => {
  const file = els.heycyanFile.files?.[0];
  importHeyCyanFile(file).finally(() => {
    els.heycyanFile.value = "";
  });
});

els.azureSas.value = containerSasUrl();
render();
updateLiveDashboard();
window.addEventListener("resize", resizeOverlay);
startCamera();
