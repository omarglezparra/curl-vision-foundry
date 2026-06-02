const drills = [
  {
    id: "perfect_curl",
    label: "good_form",
    title: "Curl perfecto",
    target: "10-12 reps limpias",
    cues: ["Torso quieto", "Hombro estable", "Rango completo", "Tempo controlado"],
  },
  {
    id: "torso_swing",
    label: "torso_swing",
    title: "Curl ladeado",
    target: "8-10 reps con torso swing",
    cues: ["Balancea el torso un poco", "Mantén el brazo visible", "No exageres"],
  },
  {
    id: "shoulder_move",
    label: "shoulder_move",
    title: "Hombro adelante",
    target: "8-10 reps moviendo hombro",
    cues: ["Lleva el codo adelante", "No uses tanto torso", "Muñeca visible"],
  },
  {
    id: "partial_rep",
    label: "partial_rep",
    title: "Rep parcial",
    target: "8-12 reps incompletas",
    cues: ["Sube a mitad", "Vuelve a extender", "No completes el curl"],
  },
  {
    id: "fatigue",
    label: "fatigue",
    title: "Fatiga real",
    target: "Serie hasta esfuerzo alto",
    cues: ["Empieza limpio", "Sigue hasta cansarte", "Para si hay dolor"],
  },
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
  previous: document.getElementById("previous"),
  next: document.getElementById("next"),
  record: document.getElementById("record"),
  downloads: document.getElementById("downloads"),
  videoDownload: document.getElementById("video-download"),
  metadataDownload: document.getElementById("metadata-download"),
};

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
  els.label.textContent = drill.label;
  els.clipCount.textContent = String(state.clipCount);
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
  const basename = `${sessionId()}_${drill.label}_${stamp}`;
  const videoBlob = new Blob(state.chunks, { type: "video/webm" });
  const metadata = {
    session_id: sessionId(),
    label: drill.label,
    drill_id: drill.id,
    drill_title: drill.title,
    target: drill.target,
    cues: drill.cues,
    created_at: new Date().toISOString(),
    source: "iphone_safari_capture",
  };
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

render();
startCamera();
