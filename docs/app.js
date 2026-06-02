const drills = [
  { id: "good_front", label: "good_form", angle: "front", title: "Curl perfecto - frente", target: "10-12 reps limpias", cues: ["Camara al frente", "Torso quieto", "Hombro estable", "Rango completo"] },
  { id: "good_45", label: "good_form", angle: "45_degrees", title: "Curl perfecto - 45 grados", target: "10-12 reps limpias", cues: ["Camara a 45 grados", "Codo visible", "Muneca visible", "Tempo controlado"] },
  { id: "good_side", label: "good_form", angle: "side", title: "Curl perfecto - lateral", target: "10-12 reps limpias", cues: ["Camara lateral", "Brazo completo visible", "Rango completo", "Sin balanceo"] },
  { id: "torso_swing_front", label: "torso_swing", angle: "front", title: "Torso swing - frente", target: "8-10 reps con torso swing", cues: ["Camara al frente", "Balancea un poco", "No pierdas el brazo", "No exageres"] },
  { id: "torso_swing_45", label: "torso_swing", angle: "45_degrees", title: "Torso swing - 45 grados", target: "8-10 reps con torso swing", cues: ["Camara a 45 grados", "Torso ayuda al curl", "Codo visible", "Control seguro"] },
  { id: "shoulder_move_side", label: "shoulder_move", angle: "side", title: "Hombro adelante - lateral", target: "8-10 reps moviendo hombro", cues: ["Camara lateral", "Lleva codo adelante", "No uses tanto torso", "Muneca visible"] },
  { id: "elbow_flare_front", label: "elbow_flare", angle: "front", title: "Codo abierto - frente", target: "8-10 reps abriendo codo", cues: ["Camara al frente", "Codo se abre hacia afuera", "Torso estable", "Movimiento claro"] },
  { id: "partial_bottom_side", label: "partial_rep", angle: "side", title: "Rep parcial abajo", target: "8-12 reps sin subir completo", cues: ["Camara lateral", "Sube a mitad", "Vuelve a extender", "No completes arriba"] },
  { id: "partial_top_side", label: "partial_rep", angle: "side", title: "Rep parcial arriba", target: "8-12 reps sin bajar completo", cues: ["Camara lateral", "Quedate arriba", "No extiendas abajo", "Rango corto"] },
  { id: "fast_reps_front", label: "fast_reps", angle: "front", title: "Reps rapidas - frente", target: "10-15 reps rapidas", cues: ["Camara al frente", "Rapido pero seguro", "Mantente visible", "Sin dolor"] },
  { id: "slow_control_45", label: "slow_control", angle: "45_degrees", title: "Tempo lento - 45 grados", target: "6-8 reps muy controladas", cues: ["Camara a 45 grados", "Sube lento", "Baja lento", "Forma limpia"] },
  { id: "fatigue_side", label: "fatigue", angle: "side", title: "Fatiga real - lateral", target: "Serie hasta esfuerzo alto", cues: ["Camara lateral", "Empieza limpio", "Sigue hasta cansarte", "Para si hay dolor"] },
];

const state = {
  selectedIndex: 0,
  stream: null,
  recorder: null,
  chunks: [],
  recording: false,
  startedAt: 0,
  timerInterval: 0,
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
  azureSas: document.getElementById("azure-sas"),
  saveAzure: document.getElementById("save-azure"),
};

const apiBase = window.CURL_VISION_API_BASE || "";
const configContainerSasUrl = window.CURL_VISION_CONTAINER_SAS_URL || "";

function containerSasUrl() {
  return (configContainerSasUrl || localStorage.getItem("curlVisionContainerSasUrl") || "").trim();
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

function activeDrill() {
  return drills[state.selectedIndex];
}

function sessionId() {
  return `${activeDrill().id}_${todayStamp()}`;
}

function render() {
  const drill = activeDrill();
  els.drillTitle.textContent = drill.title;
  els.panelTitle.textContent = drill.title;
  els.target.textContent = drill.target;
  els.counter.textContent = `${state.selectedIndex + 1}/${drills.length}`;
  els.sessionId.textContent = sessionId();
  els.label.textContent = `${drill.label} / ${drill.angle}`;
  els.clipCount.textContent = String(state.clipCount);
  els.cloudStatus.textContent = apiBase || containerSasUrl() ? "azure ready" : "local";
  els.record.textContent = state.recording ? "Detener" : "Grabar prueba";
  els.record.classList.toggle("stop", state.recording);
  els.dot.classList.toggle("active", state.recording);

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

function startRecording() {
  if (!state.stream || state.recording) return;
  state.chunks = [];
  state.recorder = new MediaRecorder(state.stream, { mimeType: "video/webm" });
  state.recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) state.chunks.push(event.data);
  });
  state.recorder.addEventListener("stop", makeDownloads);
  state.recorder.start();
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
  const basename = `${sessionId()}_${drill.label}_${drill.angle}_${stamp}`;
  const videoBlob = new Blob(state.chunks, { type: "video/webm" });
  const metadata = {
    capture_id: captureId,
    session_id: sessionId(),
    label: drill.label,
    camera_angle: drill.angle,
    drill_id: drill.id,
    drill_title: drill.title,
    target: drill.target,
    cues: drill.cues,
    created_at: new Date().toISOString(),
    source: "iphone_safari_capture",
  };
  const blobPrefix = `${drill.label}/${drill.angle}/${metadata.session_id}/${captureId}`;
  metadata.azure_blob_prefix = blobPrefix;
  const metadataBlob = new Blob([JSON.stringify(metadata, null, 2)], {
    type: "application/json",
  });

  els.videoDownload.href = URL.createObjectURL(videoBlob);
  els.videoDownload.download = `${basename}.webm`;
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
      "Content-Type": "video/webm",
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
  await putBlob(`${prefix}/video.webm`, videoBlob, "video/webm");
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
    startRecording();
  }
});

els.saveAzure.addEventListener("click", () => {
  localStorage.setItem("curlVisionContainerSasUrl", els.azureSas.value.trim());
  els.status.textContent = containerSasUrl() ? "Azure Blob configurado" : "Azure Blob apagado";
  render();
});

els.azureSas.value = containerSasUrl();
render();
startCamera();
