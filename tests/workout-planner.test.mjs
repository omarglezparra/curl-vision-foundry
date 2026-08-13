import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeHistory,
  ARM_SESSION_TEMPLATE_COUNT,
  buildAdaptiveArmSession,
  planTotals,
} from "../docs/workout-planner.js";

test("the first four sessions rotate through distinct arm routines with variable targets", () => {
  const sessions = Array.from({ length: ARM_SESSION_TEMPLATE_COUNT }, (_, index) => (
    buildAdaptiveArmSession({ sessionNumber: index + 1, now: new Date("2026-08-13T12:00:00Z") })
  ));
  assert.equal(new Set(sessions.map((session) => session.templateId)).size, 4);
  assert.equal(new Set(sessions.map((session) => session.targetReps)).size, 4);
  sessions.forEach((session) => {
    assert.ok(session.exercises.length >= 3);
    assert.ok(session.totalSets > 1);
    assert.notDeepEqual(session.exercises[0].sets.map((set) => set.targetReps), [8]);
    assert.equal(session.exercises[0].tracking, "camera");
  });
});

test("poor recent form lowers camera targets and increases recovery", () => {
  const history = [{
    id: "bad-session",
    status: "completed",
    completedAt: "2026-08-12T12:00:00Z",
    formScore: 70,
    attempts: 20,
    rejectedReps: 7,
    completionRate: 0.75,
  }];
  const baseline = buildAdaptiveArmSession({ sessionNumber: 2, now: new Date("2026-08-13T12:00:00Z") });
  const adapted = buildAdaptiveArmSession({ sessionNumber: 2, history, now: new Date("2026-08-13T12:00:00Z") });
  assert.equal(analyzeHistory(history).techniqueNeedsWork, true);
  assert.ok(adapted.exercises[0].sets[0].targetReps < baseline.exercises[0].sets[0].targetReps);
  assert.ok(adapted.exercises[0].sets[0].restSeconds > baseline.exercises[0].sets[0].restSeconds);
  assert.equal(adapted.exercises[0].sets[0].rirTarget, 3);
});

test("clean completed history recommends a small load progression", () => {
  const history = [{
    id: "clean-session",
    status: "completed",
    completedAt: "2026-08-12T12:00:00Z",
    formScore: 94,
    attempts: 34,
    rejectedReps: 1,
    completionRate: 1,
    exerciseLogs: [{
      exerciseId: "strict_curl",
      sets: [
        { reps: 10, weight: 20, rir: 2 },
        { reps: 10, weight: 20, rir: 2 },
        { reps: 12, weight: 20, rir: 1 },
      ],
    }],
  }];
  const plan = buildAdaptiveArmSession({
    sessionNumber: 1,
    history,
    profile: { preferredUnit: "lb" },
    now: new Date("2026-08-13T12:00:00Z"),
  });
  assert.equal(analyzeHistory(history).readyToProgress, true);
  assert.equal(plan.exercises[0].suggestedLoad, 22.5);
  assert.match(plan.exercises[0].progression, /Sube/);
  assert.equal(plan.exercises[0].sets.at(-1).rirTarget, 1);
});

test("plan totals reflect every exercise and set", () => {
  const plan = buildAdaptiveArmSession({ sessionNumber: 3, now: new Date("2026-08-13T12:00:00Z") });
  assert.deepEqual(planTotals(plan), {
    exercises: 4,
    sets: 11,
    reps: plan.targetReps,
  });
});
