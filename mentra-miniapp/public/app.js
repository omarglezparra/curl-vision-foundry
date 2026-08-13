const GEOMETRY_DEBOUNCE_MS = 400;
const GEOMETRY_MAX_WAIT_MS = 1500;
const ROTATIONS = [0, 90, 180, 270];

const state = {
  runtime: null,
  rotationDegrees: 0,
  startedAt: 0,
  poll: 0,
  actionPending: false,
  geometryHydrated: false,
  geometryRevision: 0,
  geometrySavedRevision: 0,
  geometryDebounce: 0,
  geometryMaxWait: 0,
  geometrySaving: false,
  geometrySaveQueued: false,
  geometrySavePromise: null,
  errors: {
    runtime: '',
    action: '',
    preferences: '',
    performance: '',
    data: '',
  },
};

const els = {
  connection: document.querySelector('#connection'),
  timer: document.querySelector('#timer'),
  dot: document.querySelector('#status-dot'),
  record: document.querySelector('#record'),
  coach: document.querySelector('#coach-message'),
  mirror: document.querySelector('#mirror'),
  pixelsMirrored: document.querySelector('#pixels-mirrored'),
  rotation: document.querySelector('#rotation'),
  geometryStatus: document.querySelector('#geometry-status'),
  metrics: document.querySelector('#metrics'),
  sessions: document.querySelector('#sessions'),
  refresh: document.querySelector('#refresh'),
  error: document.querySelector('#error'),
  deleteData: document.querySelector('#delete-data'),
};

function active(status) {
  return ['starting', 'streaming', 'reconnecting', 'stopping'].includes(status);
}

function transition(status) {
  return status === 'starting' || status === 'stopping';
}

function formatTime(seconds) {
  const clean = Math.max(Math.floor(seconds), 0);
  return `${Math.floor(clean / 60)}:${String(clean % 60).padStart(2, '0')}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function setError(scope, error = '') {
  state.errors[scope] = error ? errorMessage(error) : '';
  els.error.textContent = Object.values(state.errors).filter(Boolean).join(' ');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${path} ${response.status}`);
  return body;
}

function geometryPayload() {
  return {
    rotationDegrees: state.rotationDegrees,
    sceneReflected: els.mirror.checked,
    sourcePixelsMirrored: els.pixelsMirrored.checked,
  };
}

function normalizeGeometry(value) {
  if (!value || typeof value !== 'object') return null;
  const rotationDegrees = Number(value.rotationDegrees);
  if (
    !ROTATIONS.includes(rotationDegrees)
    || typeof value.sceneReflected !== 'boolean'
    || typeof value.sourcePixelsMirrored !== 'boolean'
  ) {
    return null;
  }
  return {
    rotationDegrees,
    sceneReflected: value.sceneReflected,
    sourcePixelsMirrored: value.sourcePixelsMirrored,
  };
}

function updateRotationLabel() {
  els.rotation.querySelector('b').textContent = `${state.rotationDegrees}°`;
}

function updateGeometryControls() {
  const locked = !state.geometryHydrated || state.actionPending || active(state.runtime?.status);
  els.mirror.disabled = locked;
  els.pixelsMirrored.disabled = locked;
  els.rotation.disabled = locked;
}

function hydrateGeometry(value) {
  if (state.geometryHydrated) return;
  const geometry = normalizeGeometry(value);
  if (!geometry) {
    els.geometryStatus.textContent = 'No se pudieron cargar los ajustes de imagen.';
    els.geometryStatus.classList.add('error');
    setError('preferences', 'La sesión no devolvió ajustes válidos de espejo y rotación.');
    return;
  }

  state.rotationDegrees = geometry.rotationDegrees;
  els.mirror.checked = geometry.sceneReflected;
  els.pixelsMirrored.checked = geometry.sourcePixelsMirrored;
  updateRotationLabel();
  state.geometryHydrated = true;
  els.geometryStatus.textContent = 'Ajustes listos.';
  els.geometryStatus.classList.remove('error');
  setError('preferences');
  updateGeometryControls();
}

function updateRecordButton() {
  const runtime = state.runtime;
  if (!runtime) {
    els.record.disabled = true;
    return;
  }

  const isActive = active(runtime.status);
  const wifiBlocksStart = !isActive && !runtime.wifiConnected;
  els.record.disabled = state.actionPending || transition(runtime.status) || wifiBlocksStart;
  els.record.textContent = isActive ? 'Finalizar sesión' : 'Iniciar sesión';
  els.record.classList.toggle('stop', isActive);
}

function statusText(runtime) {
  const labels = {
    ready: 'lista',
    waiting_for_wifi: 'Wi-Fi requerido',
    starting: 'iniciando',
    streaming: 'grabando',
    reconnecting: 'reconectando',
    stopping: 'finalizando',
    stopped: 'finalizada',
    error: 'error',
  };
  const label = labels[runtime.status] || String(runtime.status).replaceAll('_', ' ');
  return !runtime.wifiConnected && active(runtime.status) ? `${label} · Wi-Fi desconectado` : label;
}

function renderRuntime(runtime) {
  state.runtime = runtime;
  const isActive = active(runtime.status);
  hydrateGeometry(runtime.geometry);
  els.connection.textContent = statusText(runtime);
  els.dot.className = runtime.status === 'streaming' ? 'live' : runtime.status === 'error' ? 'error' : '';
  updateRecordButton();
  updateGeometryControls();

  if (runtime.error) {
    els.coach.textContent = runtime.error;
  } else if (runtime.status === 'streaming') {
    els.coach.textContent = 'Grabando tu sesión continua. Mantén tu cuerpo visible en el espejo.';
  } else if (runtime.status === 'reconnecting') {
    els.coach.textContent = 'Se perdió la conexión. Puedes finalizar la sesión mientras reconecta.';
  } else if (!runtime.wifiConnected) {
    els.coach.textContent = 'Conecta Mentra Live a Wi-Fi para iniciar una sesión.';
  } else {
    els.coach.textContent = 'Listo para comenzar una sesión continua de curls.';
  }

  if (runtime.startedAt) {
    const startedAt = new Date(runtime.startedAt).getTime();
    state.startedAt = Number.isFinite(startedAt) ? startedAt : 0;
  }
  if (!isActive) state.startedAt = 0;
}

async function loadRuntime() {
  try {
    renderRuntime(await api('/api/session'));
    setError('runtime');
  } catch (error) {
    setError('runtime', error);
  }
}

async function toggleWorkout() {
  if (!state.runtime || state.actionPending) return;
  const isActive = active(state.runtime.status);
  if (!isActive && !state.runtime.wifiConnected) return;

  state.actionPending = true;
  updateRecordButton();
  updateGeometryControls();
  setError('action');

  try {
    const path = isActive ? '/api/session/stop' : '/api/session/start';
    const body = isActive ? {} : geometryPayload();
    if (!isActive) await flushGeometryPreferences();
    renderRuntime(await api(path, { method: 'POST', body: JSON.stringify(body) }));
  } catch (error) {
    setError('action', error);
  } finally {
    state.actionPending = false;
    updateRecordButton();
    updateGeometryControls();
  }
}

function clearGeometryTimers() {
  window.clearTimeout(state.geometryDebounce);
  window.clearTimeout(state.geometryMaxWait);
  state.geometryDebounce = 0;
  state.geometryMaxWait = 0;
}

function armGeometrySave(delay = GEOMETRY_DEBOUNCE_MS) {
  window.clearTimeout(state.geometryDebounce);
  state.geometryDebounce = window.setTimeout(() => void flushGeometryPreferences(), delay);
  if (!state.geometryMaxWait) {
    state.geometryMaxWait = window.setTimeout(() => void flushGeometryPreferences(), GEOMETRY_MAX_WAIT_MS);
  }
}

function geometryChanged() {
  if (!state.geometryHydrated || active(state.runtime?.status)) return;
  state.geometryRevision += 1;
  els.geometryStatus.textContent = 'Guardando ajustes…';
  els.geometryStatus.classList.remove('error');
  armGeometrySave();
}

function flushGeometryPreferences() {
  clearGeometryTimers();
  if (state.geometrySaving) {
    state.geometrySaveQueued = true;
    return state.geometrySavePromise || Promise.resolve();
  }
  if (state.geometrySavedRevision === state.geometryRevision) return Promise.resolve();

  const revision = state.geometryRevision;
  state.geometrySaving = true;
  state.geometrySaveQueued = false;
  const save = (async () => {
    try {
      const result = await api('/api/preferences/geometry', {
        method: 'POST',
        body: JSON.stringify(geometryPayload()),
      });
      if (!normalizeGeometry(result.geometry)) {
        throw new Error('El servidor no confirmó los ajustes de imagen.');
      }
      state.geometrySavedRevision = Math.max(state.geometrySavedRevision, revision);
      setError('preferences');
      if (revision === state.geometryRevision) {
        els.geometryStatus.textContent = 'Ajustes guardados.';
        els.geometryStatus.classList.remove('error');
      }
    } catch (error) {
      els.geometryStatus.textContent = 'No se pudieron guardar los ajustes.';
      els.geometryStatus.classList.add('error');
      setError('preferences', error);
    } finally {
      state.geometrySaving = false;
      state.geometrySavePromise = null;
      if (state.geometrySaveQueued || revision !== state.geometryRevision) {
        await flushGeometryPreferences();
      }
    }
  })();
  state.geometrySavePromise = save;
  return save;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function appendMetric(label, value) {
  const article = document.createElement('article');
  const strong = document.createElement('strong');
  const span = document.createElement('span');
  strong.textContent = String(value);
  span.textContent = label;
  article.append(strong, span);
  els.metrics.append(article);
}

function appendSession(session) {
  const value = session && typeof session === 'object' ? session : {};
  const article = document.createElement('article');
  const heading = document.createElement('div');
  const id = document.createElement('strong');
  const score = document.createElement('b');
  const details = document.createElement('p');

  article.className = 'session';
  id.textContent = String(value.sessionId ?? 'Sesión');
  score.textContent = `${Math.round(safeNumber(value.goodFormPercent))}%`;
  details.textContent = `${Math.round(safeNumber(value.reps))} reps · ${Math.round(safeNumber(value.goodReps))} limpias · ROM ${Math.round(safeNumber(value.avgRangeOfMotion))}°`;
  heading.append(id, score);
  article.append(heading, details);
  els.sessions.append(article);
}

async function loadPerformance() {
  els.refresh.disabled = true;
  try {
    const data = await api('/api/performance');
    const overall = data?.overall && typeof data.overall === 'object' ? data.overall : {};
    const recentSessions = Array.isArray(data?.recentSessions) ? data.recentSessions : [];

    els.metrics.replaceChildren();
    appendMetric('Sesiones', Math.round(safeNumber(overall.sessions)));
    appendMetric('Reps', Math.round(safeNumber(overall.reps)));
    appendMetric('Buena forma', `${Math.round(safeNumber(overall.goodFormPercent))}%`);
    appendMetric('ROM promedio', `${Math.round(safeNumber(overall.avgRangeOfMotion))}°`);

    els.sessions.replaceChildren();
    if (recentSessions.length) {
      recentSessions.forEach(appendSession);
    } else {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Aún no hay sesiones procesadas.';
      els.sessions.append(empty);
    }
    setError('performance');
  } catch (error) {
    setError('performance', error);
  } finally {
    els.refresh.disabled = false;
  }
}

async function deleteMyData() {
  if (active(state.runtime?.status)) {
    setError('data', 'Finaliza la sesión antes de eliminar tus datos.');
    return;
  }
  const confirmed = window.confirm(
    'Esto eliminará permanentemente tus videos, métricas y preferencias de AI Javier Coach. ¿Continuar?'
  );
  if (!confirmed) return;

  els.deleteData.disabled = true;
  setError('data');
  try {
    await api('/api/data', {
      method: 'DELETE',
      body: JSON.stringify({ confirmation: 'DELETE_MY_DATA' }),
    });
    state.geometryHydrated = false;
    state.geometryRevision = 0;
    state.geometrySavedRevision = 0;
    els.metrics.replaceChildren();
    els.sessions.replaceChildren();
    window.alert('Tus datos de AI Javier Coach fueron eliminados.');
    await loadRuntime();
  } catch (error) {
    setError('data', error);
  } finally {
    els.deleteData.disabled = false;
  }
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === button.dataset.tab));
    if (button.dataset.tab === 'performance') loadPerformance();
  });
});

els.record.addEventListener('click', toggleWorkout);
els.refresh.addEventListener('click', loadPerformance);
els.deleteData.addEventListener('click', deleteMyData);
els.mirror.addEventListener('change', geometryChanged);
els.pixelsMirrored.addEventListener('change', geometryChanged);
els.rotation.addEventListener('click', () => {
  if (els.rotation.disabled) return;
  state.rotationDegrees = (state.rotationDegrees + 90) % 360;
  updateRotationLabel();
  geometryChanged();
});

window.addEventListener('pagehide', () => {
  if (!state.geometryHydrated || state.geometrySavedRevision === state.geometryRevision) return;
  void fetch('/api/preferences/geometry', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geometryPayload()),
  });
});

setInterval(() => {
  els.timer.textContent = state.startedAt ? formatTime((Date.now() - state.startedAt) / 1000) : '0:00';
}, 500);
state.poll = window.setInterval(loadRuntime, 2500);
loadRuntime();
