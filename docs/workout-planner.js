export const DEFAULT_PROFILE = Object.freeze({
  name: "Omar",
  goal: "Aumentar masa muscular en brazos",
  experience: "intermediate",
  equipment: "dumbbells",
  sessionsPerWeek: 2,
  preferredUnit: "lb",
  avatar: "./assets/omar.jpg",
});

const SESSION_TEMPLATES = [
  {
    id: "foundation",
    title: "Brazos · Base técnica",
    focus: "Tensión limpia y rango completo",
    accent: "mint",
    exercises: [
      {
        id: "strict_curl",
        name: "Curl estricto",
        muscle: "Bíceps",
        tracking: "camera",
        reps: [10, 10, 12],
        restSeconds: 90,
        rirTarget: 2,
        tempo: "2-1-3",
        cue: "Codo quieto; baja durante 3 segundos.",
      },
      {
        id: "hammer_curl",
        name: "Curl martillo",
        muscle: "Braquial · antebrazo",
        tracking: "manual",
        reps: [11, 12, 12],
        restSeconds: 75,
        rirTarget: 2,
        tempo: "2-0-2",
        cue: "Muñeca neutra y hombro relajado.",
      },
      {
        id: "overhead_triceps_extension",
        name: "Extensión de tríceps sobre cabeza",
        muscle: "Tríceps",
        tracking: "manual",
        reps: [10, 11, 12],
        restSeconds: 90,
        rirTarget: 2,
        tempo: "2-1-2",
        cue: "Costillas abajo y codos apuntando al frente.",
      },
    ],
  },
  {
    id: "strength",
    title: "Brazos · Fuerza controlada",
    focus: "Más tensión con repeticiones moderadas",
    accent: "blue",
    exercises: [
      {
        id: "tempo_curl",
        name: "Curl estricto con pausa",
        muscle: "Bíceps",
        tracking: "camera",
        reps: [7, 8, 9, 10],
        restSeconds: 120,
        rirTarget: 2,
        tempo: "2-1-3",
        cue: "Pausa arriba; no adelantes el codo.",
      },
      {
        id: "cross_body_hammer",
        name: "Curl martillo cruzado",
        muscle: "Braquial · antebrazo",
        tracking: "manual",
        reps: [9, 10, 11],
        restSeconds: 90,
        rirTarget: 2,
        tempo: "2-0-2",
        cue: "Lleva la mancuerna al hombro opuesto sin girar el torso.",
      },
      {
        id: "close_grip_pushup",
        name: "Flexión cerrada",
        muscle: "Tríceps",
        tracking: "manual",
        reps: [9, 10, 12],
        restSeconds: 105,
        rirTarget: 2,
        tempo: "2-1-1",
        cue: "Codos cerca del cuerpo; termina antes de perder la línea corporal.",
      },
    ],
  },
  {
    id: "volume",
    title: "Brazos · Volumen",
    focus: "Acumular repeticiones de calidad",
    accent: "violet",
    exercises: [
      {
        id: "strict_curl_volume",
        name: "Curl estricto continuo",
        muscle: "Bíceps",
        tracking: "camera",
        reps: [12, 13, 14],
        restSeconds: 75,
        rirTarget: 2,
        tempo: "2-0-2",
        cue: "Ritmo constante; extensión completa en cada repetición.",
      },
      {
        id: "incline_curl",
        name: "Curl inclinado",
        muscle: "Bíceps · cabeza larga",
        tracking: "manual",
        reps: [10, 11, 12],
        restSeconds: 90,
        rirTarget: 2,
        tempo: "2-1-3",
        cue: "Hombros atrás y bajada lenta.",
      },
      {
        id: "triceps_kickback",
        name: "Patada de tríceps",
        muscle: "Tríceps",
        tracking: "manual",
        reps: [13, 14, 15],
        restSeconds: 75,
        rirTarget: 2,
        tempo: "2-1-2",
        cue: "Brazo superior inmóvil; aprieta al extender.",
      },
      {
        id: "reverse_curl",
        name: "Curl inverso",
        muscle: "Antebrazo · braquiorradial",
        tracking: "manual",
        reps: [12, 14],
        restSeconds: 75,
        rirTarget: 2,
        tempo: "2-0-2",
        cue: "Agarre prono y muñeca alineada.",
      },
    ],
  },
  {
    id: "balance",
    title: "Brazos · Balance",
    focus: "Bíceps, tríceps y antebrazo equilibrados",
    accent: "amber",
    exercises: [
      {
        id: "strict_curl_balance",
        name: "Curl estricto alternado",
        muscle: "Bíceps",
        tracking: "camera",
        reps: [9, 10, 11],
        restSeconds: 90,
        rirTarget: 2,
        tempo: "2-1-2",
        cue: "Completa un lado visible sin elevar el hombro.",
      },
      {
        id: "concentration_curl",
        name: "Curl concentración",
        muscle: "Bíceps",
        tracking: "manual",
        reps: [10, 11, 12],
        restSeconds: 75,
        rirTarget: 2,
        tempo: "2-1-3",
        cue: "Apoya el brazo y evita despegar el codo.",
      },
      {
        id: "lying_triceps_extension",
        name: "Extensión de tríceps tumbado",
        muscle: "Tríceps",
        tracking: "manual",
        reps: [10, 11, 12],
        restSeconds: 90,
        rirTarget: 2,
        tempo: "2-1-2",
        cue: "Mueve solo el antebrazo y controla el fondo.",
      },
      {
        id: "reverse_curl_balance",
        name: "Curl inverso ligero",
        muscle: "Antebrazo",
        tracking: "manual",
        reps: [12, 13],
        restSeconds: 60,
        rirTarget: 2,
        tempo: "2-0-2",
        cue: "Sin impulso; detente si la muñeca se flexiona.",
      },
    ],
  },
];

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function completedHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => item && item.status !== "in_progress" && item.completedAt)
    .sort((left, right) => new Date(right.completedAt) - new Date(left.completedAt));
}

export function normalizeProfile(profile = {}) {
  const merged = { ...DEFAULT_PROFILE, ...(profile || {}) };
  return {
    ...merged,
    name: String(merged.name || DEFAULT_PROFILE.name).trim().slice(0, 40) || DEFAULT_PROFILE.name,
    sessionsPerWeek: clamp(Number(merged.sessionsPerWeek) || 2, 1, 4),
    experience: ["beginner", "intermediate", "advanced"].includes(merged.experience)
      ? merged.experience
      : DEFAULT_PROFILE.experience,
    equipment: ["dumbbells", "bodyweight", "gym"].includes(merged.equipment)
      ? merged.equipment
      : DEFAULT_PROFILE.equipment,
    preferredUnit: merged.preferredUnit === "kg" ? "kg" : "lb",
  };
}

export function analyzeHistory(history = []) {
  const completed = completedHistory(history);
  const recent = completed.slice(0, 3);
  const formValues = recent.map((item) => Number(item.formScore)).filter(Number.isFinite);
  const attempts = recent.reduce((sum, item) => sum + (Number(item.attempts) || 0), 0);
  const rejected = recent.reduce((sum, item) => sum + (Number(item.rejectedReps) || 0), 0);
  const completionValues = recent
    .map((item) => Number(item.completionRate))
    .filter(Number.isFinite);
  const averageForm = formValues.length ? average(formValues) : null;
  const rejectionRate = attempts ? rejected / attempts : 0;
  const completionRate = completionValues.length ? average(completionValues) : (completed.length ? 1 : 0);
  const techniqueNeedsWork = averageForm !== null && (averageForm < 82 || rejectionRate > 0.2);
  const readyToProgress = averageForm !== null
    && averageForm >= 88
    && rejectionRate <= 0.12
    && completionRate >= 0.9;
  return {
    completedSessions: completed.length,
    recent,
    averageForm,
    rejectionRate,
    completionRate,
    techniqueNeedsWork,
    readyToProgress,
    latest: completed[0] || null,
  };
}

function lastExerciseLog(history, exerciseId) {
  for (const session of completedHistory(history)) {
    const logs = Array.isArray(session.exerciseLogs) ? session.exerciseLogs : [];
    const match = logs.find((item) => item.exerciseId === exerciseId);
    if (match) return match;
  }
  return null;
}

function suggestedLoad(history, exercise, unit, readiness) {
  const last = lastExerciseLog(history, exercise.id);
  const sets = Array.isArray(last?.sets) ? last.sets : [];
  const weights = sets.map((set) => Number(set.weight)).filter((value) => value > 0);
  if (!weights.length) return { value: null, unit, change: "Registra tu carga inicial" };
  const previous = Math.max(...weights);
  const completedTargets = sets.length >= exercise.reps.length
    && sets.every((set, index) => Number(set.reps) >= Number(exercise.reps[Math.min(index, exercise.reps.length - 1)]));
  const cleanEffort = sets.every((set) => !Number.isFinite(Number(set.rir)) || Number(set.rir) >= 1);
  const step = unit === "kg" ? 1 : 2.5;
  if (readiness.readyToProgress && completedTargets && cleanEffort) {
    return { value: Math.round((previous + step) * 10) / 10, unit, change: `Sube ${step} ${unit}` };
  }
  if (readiness.techniqueNeedsWork && exercise.tracking === "camera") {
    const reduced = Math.max(previous - step, step);
    return { value: Math.round(reduced * 10) / 10, unit, change: `Baja ${step} ${unit} para recuperar técnica` };
  }
  return { value: previous, unit, change: "Mantén la última carga" };
}

function adaptExercise(exercise, history, profile, readiness) {
  const experienceSetDelta = profile.experience === "beginner" ? -1 : profile.experience === "advanced" ? 1 : 0;
  let reps = [...exercise.reps];
  if (experienceSetDelta < 0 && reps.length > 2) reps = reps.slice(0, -1);
  if (experienceSetDelta > 0 && reps.length < 4 && exercise.tracking === "manual") reps.push(reps.at(-1));

  let rirTarget = exercise.rirTarget;
  let restSeconds = exercise.restSeconds;
  if (readiness.techniqueNeedsWork) {
    rirTarget = 3;
    if (exercise.tracking === "camera") {
      reps = reps.map((value) => Math.max(value - 2, 6));
      restSeconds += 30;
    }
  }

  const load = suggestedLoad(history, { ...exercise, reps }, profile.preferredUnit, readiness);
  const sets = reps.map((targetReps, index) => ({
    id: `${exercise.id}_set_${index + 1}`,
    setNumber: index + 1,
    targetReps,
    restSeconds,
    rirTarget: readiness.readyToProgress && index === reps.length - 1 ? 1 : rirTarget,
    nearTechnicalFailure: readiness.readyToProgress && index === reps.length - 1,
  }));
  return {
    ...exercise,
    sets,
    setCount: sets.length,
    repRange: `${Math.min(...reps)}–${Math.max(...reps)}`,
    suggestedLoad: load.value,
    loadUnit: load.unit,
    progression: load.change,
  };
}

function adaptationMessage(readiness) {
  if (!readiness.completedSessions) {
    return "Sesión inicial para establecer cargas, técnica y esfuerzo de referencia.";
  }
  if (readiness.techniqueNeedsWork) {
    return "Reducimos repeticiones del bloque con cámara y aumentamos el descanso para recuperar una ejecución limpia.";
  }
  if (readiness.readyToProgress) {
    return "Tu historial permite progresar: conserva la técnica y acerca solo la última serie al fallo técnico.";
  }
  return "Mantenemos una progresión conservadora hasta reunir otra sesión completa y consistente.";
}

export function buildAdaptiveArmSession({ sessionNumber = 1, history = [], profile = {}, now = new Date() } = {}) {
  const normalizedProfile = normalizeProfile(profile);
  const readiness = analyzeHistory(history);
  const number = Math.max(1, Number(sessionNumber) || readiness.completedSessions + 1);
  const template = SESSION_TEMPLATES[(number - 1) % SESSION_TEMPLATES.length];
  const exercises = template.exercises.map((exercise) => adaptExercise(
    exercise,
    history,
    normalizedProfile,
    readiness,
  ));
  const totalSets = exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0);
  const targetReps = exercises.reduce(
    (sum, exercise) => sum + exercise.sets.reduce((setSum, set) => setSum + set.targetReps, 0),
    0,
  );
  const restSeconds = exercises.reduce(
    (sum, exercise) => sum + exercise.sets.reduce((setSum, set, index) => (
      setSum + (index === exercise.sets.length - 1 && exercise === exercises.at(-1) ? 0 : set.restSeconds)
    ), 0),
    0,
  );
  const nextEligibleAt = new Date(now);
  nextEligibleAt.setHours(nextEligibleAt.getHours() + 48);
  const averageFormText = readiness.averageForm === null ? "sin historial" : `${Math.round(readiness.averageForm)}% de técnica`;
  return {
    schemaVersion: 3,
    sessionNumber: number,
    templateId: template.id,
    title: template.title,
    focus: template.focus,
    accent: template.accent,
    goal: normalizedProfile.goal,
    generatedAt: new Date(now).toISOString(),
    nextEligibleAt: nextEligibleAt.toISOString(),
    totalSets,
    targetReps,
    estimatedMinutes: Math.max(25, Math.round((targetReps * 3 + restSeconds) / 60)),
    exercises,
    adaptation: adaptationMessage(readiness),
    evidenceNote: "Trabaja normalmente con 1–2 repeticiones en reserva. El fallo momentáneo no es necesario en cada serie.",
    reason: `Plan ${number} · ${averageFormText} · ${Math.round(readiness.completionRate * 100)}% de adherencia reciente.`,
    profileSnapshot: normalizedProfile,
  };
}

export function planTotals(plan) {
  const exercises = Array.isArray(plan?.exercises) ? plan.exercises : [];
  return {
    exercises: exercises.length,
    sets: exercises.reduce((sum, exercise) => sum + (exercise.sets?.length || 0), 0),
    reps: exercises.reduce(
      (sum, exercise) => sum + (exercise.sets || []).reduce((setSum, set) => setSum + (Number(set.targetReps) || 0), 0),
      0,
    ),
  };
}

export function trainingStreak(history = []) {
  const days = new Set(completedHistory(history).map((item) => new Date(item.completedAt).toISOString().slice(0, 10)));
  if (!days.size) return 0;
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const todayKey = cursor.toISOString().slice(0, 10);
  if (!days.has(todayKey)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export const ARM_SESSION_TEMPLATE_COUNT = SESSION_TEMPLATES.length;
