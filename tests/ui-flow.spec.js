const { test, expect } = require("@playwright/test");

test.use({
  browserName: "chromium",
  channel: "chrome",
  headless: true,
  viewport: { width: 390, height: 844 },
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

const baseUrl = () => process.env.UI_BASE_URL || "http://127.0.0.1:8767/";

async function mockAzure(page) {
  await page.route("https://curl-vision-capture-389230.azurewebsites.net/api/**", async (route) => {
    if (route.request().url().includes("workout-history")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ready", sessions: [] }) });
      return;
    }
    if (route.request().url().includes("create-summary-upload")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ blobName: "test/workout-summary.json", uploadUrl: "https://upload.javier.test/summary" }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("https://upload.javier.test/**", (route) => route.fulfill({ status: 201, body: "" }));
}

async function mockPose(page, { loadDelay = 0 } = {}) {
  await page.route("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35*", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        export const FilesetResolver = { forVisionTasks: async () => ({}) };
        export class PoseLandmarker {
          static async createFromOptions() {
            if (${loadDelay}) await new Promise((resolve) => setTimeout(resolve, ${loadDelay}));
            return { detectForVideo: () => ({ landmarks: [] }) };
          }
        }
      `,
    });
  });
}

async function disableVoice(page) {
  await page.evaluate(() => {
    const button = document.querySelector("#voice-toggle");
    if (button?.textContent.includes("ON")) button.click();
  });
}

test("consumer home shows Omar, an adaptive routine, history, and editable profile", async ({ page }) => {
  await mockAzure(page);
  await mockPose(page);
  await page.addInitScript(() => {
    localStorage.setItem("curlVisionWorkoutHistory", JSON.stringify([{
      id: "session-history-1",
      schemaVersion: 3,
      status: "completed",
      sessionNumber: 1,
      completedAt: "2026-08-12T18:00:00.000Z",
      sets: 9,
      plannedSets: 9,
      reps: 96,
      attempts: 34,
      rejectedReps: 2,
      formScore: 91,
      durationSeconds: 2140,
      completionRate: 1,
      exerciseLogs: [{ exerciseId: "strict_curl", sets: [{ reps: 10, weight: 20, rir: 2 }] }],
      sessionPlan: { title: "Brazos · Base técnica", exercises: [{ name: "Curl estricto" }] },
    }]));
    localStorage.removeItem("javierActiveWorkoutV3");
    localStorage.removeItem("curlVisionNextSessionPlan");
  });

  await page.goto(baseUrl(), { waitUntil: "networkidle" });
  await expect(page.locator("#home-view")).toBeVisible();
  await expect(page.locator('#home-view .profile-avatar[alt="Foto de perfil de Omar"]')).toBeVisible();
  await expect(page.locator("#home-plan-title")).toContainText("Brazos");
  await expect(page.locator("#home-routine .home-exercise-row")).toHaveCount(3);
  await expect(page.locator("#home-session-count")).toHaveText("1");
  await expect(page.locator("#home-form-score")).toHaveText("91%");
  const plan = await page.evaluate(() => window.__JAVIER_APP_DEBUG__.getState().plan);
  expect(plan.schemaVersion).toBe(3);
  expect(plan.sessionNumber).toBe(2);
  expect(plan.exercises[0].sets.length).toBeGreaterThan(1);
  expect(plan.exercises[0].sets.map((set) => set.targetReps)).not.toEqual([8]);
  await page.screenshot({ path: "outputs/adaptive-home.png", fullPage: true });

  await page.locator('[data-app-view="profile"]').click();
  await expect(page.locator("#profile-view")).toBeVisible();
  await page.locator("#profile-name").fill("Omar");
  await page.locator("#profile-days").selectOption("3");
  await page.locator("#profile-unit").selectOption("kg");
  await page.locator("#profile-form button[type=submit]").click();
  await expect(page.locator("#profile-save-status")).toContainText("guardadas");
  const savedProfile = await page.evaluate(() => JSON.parse(localStorage.getItem("javierUserProfileV3")));
  expect(savedProfile.sessionsPerWeek).toBe(3);
  expect(savedProfile.preferredUnit).toBe("kg");
});

test("trained curl-quality artifact remains deployable", async ({ page }) => {
  await mockAzure(page);
  await mockPose(page);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl(), { waitUntil: "networkidle" });
  const artifact = await page.evaluate(async () => {
    const response = await fetch("./models/curl-quality-v1.json", { cache: "no-store" });
    const model = await response.json();
    const runtime = await import("./curl-quality.js");
    runtime.validateCurlQualityModel(model);
    return { status: response.status, id: model.model_id, eligible: model.evaluation.deployment_gate.eligible, auc: model.evaluation.roc_auc };
  });
  expect(artifact).toEqual({ status: 200, id: "curl-quality-v1", eligible: true, auc: 0.8815 });
  expect(pageErrors).toEqual([]);
});

test("start prepares both models before briefing and uses the variable first-set target", async ({ page }) => {
  await mockAzure(page);
  await mockPose(page, { loadDelay: 900 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl(), { waitUntil: "domcontentloaded" });
  await disableVoice(page);
  await page.locator("#live-start").click();
  await expect(page.locator("#workout-view")).toBeVisible();
  await expect(page.locator("#live-status")).toHaveText("buscando", { timeout: 15000 });
  await expect(page.locator("#active-target")).toHaveText("10");
  await expect(page.locator("#active-set-label")).toContainText("Serie 1 de 3");
  await page.screenshot({ path: "outputs/adaptive-workout.png" });
  const state = await page.evaluate(() => window.__JAVIER_APP_DEBUG__.getState());
  expect(state.completedSets).toBe(0);
  expect(state.targetReps).toBe(10);
  expect(pageErrors).toEqual([]);
});

test("a resumed workout logs every manual set, finishes, and creates a different next session", async ({ page }) => {
  await mockAzure(page);
  await mockPose(page);
  await page.goto(baseUrl(), { waitUntil: "networkidle" });
  const plan = await page.evaluate(() => window.__JAVIER_APP_DEBUG__.getState().plan);
  const cameraExercise = plan.exercises[0];
  const cameraSets = cameraExercise.sets.map((set) => ({
    set: set.setNumber,
    globalSet: set.setNumber,
    exerciseId: cameraExercise.id,
    exerciseName: cameraExercise.name,
    tracking: "camera",
    targetReps: set.targetReps,
    reps: set.targetReps,
    attempts: set.targetReps,
    rejectedReps: 0,
    weight: 20,
    unit: "lb",
    rir: set.rirTarget,
    averageQuality: 93,
    completedAt: new Date().toISOString(),
  }));
  await page.evaluate(({ plan, cameraSets }) => {
    const cameraExercise = plan.exercises[0];
    localStorage.setItem("javierActiveWorkoutV3", JSON.stringify({
      schemaVersion: 3,
      status: "in_progress",
      workoutId: "adaptive-flow-test",
      workoutStartedAt: Date.now() - 300000,
      sessionNumber: plan.sessionNumber,
      plan,
      currentExerciseIndex: 1,
      currentRoutineSetIndex: 0,
      currentSetReps: 0,
      totalReps: cameraSets.reduce((sum, set) => sum + set.reps, 0),
      completedSets: cameraSets.length,
      goodReps: cameraSets.reduce((sum, set) => sum + set.reps, 0),
      attemptedReps: cameraSets.reduce((sum, set) => sum + set.reps, 0),
      rejectedReps: 0,
      rejectionReasons: {},
      qualityScores: [93, 93, 93],
      setHistory: cameraSets,
      exerciseLogs: [{
        exerciseId: cameraExercise.id,
        name: cameraExercise.name,
        muscle: cameraExercise.muscle,
        tracking: "camera",
        sets: cameraSets,
      }],
    }));
  }, { plan, cameraSets });
  await page.reload({ waitUntil: "networkidle" });
  await disableVoice(page);
  await page.locator("#live-start").click();

  for (let index = 0; index < 12; index += 1) {
    if (await page.locator("#results-dashboard").isVisible()) break;
    await expect(page.locator("#manual-set-controls")).toBeVisible({ timeout: 8000 });
    await page.locator("#manual-weight").fill("15");
    await page.locator("#manual-complete-set").click();
    if (await page.locator("#results-dashboard").isVisible()) break;
    await expect(page.locator("#rest-overlay")).toBeVisible({ timeout: 5000 });
    await page.locator("#rest-skip").click();
  }

  await expect(page.locator("#results-dashboard")).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#dashboard-title")).toContainText("completada");
  await expect(page.locator("#dashboard-session-status")).toContainText("series");
  await page.screenshot({ path: "outputs/adaptive-dashboard.png", fullPage: true });
  const result = await page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem("curlVisionWorkoutHistory"));
    const next = JSON.parse(localStorage.getItem("curlVisionNextSessionPlan"));
    return { latest: history[0], next, active: localStorage.getItem("javierActiveWorkoutV3") };
  });
  expect(result.latest.status).toBe("completed");
  expect(result.latest.sets).toBe(result.latest.plannedSets);
  expect(result.latest.exerciseLogs).toHaveLength(plan.exercises.length);
  expect(result.latest.totalVolume).toBeGreaterThan(0);
  expect(result.latest.formScore).toBe(100);
  expect(result.next.templateId).not.toBe(plan.templateId);
  expect(result.active).toBeNull();
});
