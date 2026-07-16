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
};

const els = {
  preview: document.getElementById("preview"),
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
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    els.preview.srcObject = state.stream;
    els.status.textContent = "Camara frontal lista";
  } catch (error) {
    els.status.textContent = "No se pudo abrir la camara";
    alert(`No se pudo abrir la camara: ${error}`);
  }
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
startCamera();
