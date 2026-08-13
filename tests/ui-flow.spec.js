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

test("historical dashboard pages and next-session briefing", async ({ page }) => {
  const baseUrl = process.env.UI_BASE_URL || "http://127.0.0.1:8765/";
  await page.route("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35*", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        export const FilesetResolver = { forVisionTasks: async () => ({}) };
        export class PoseLandmarker {
          static async createFromOptions() {
            return { detectForVideo: () => ({ landmarks: [] }) };
          }
        }
      `,
    });
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    const session = {
      id: "gym_good_ui_test_1",
      sessionNumber: 1,
      completedAt: "2026-08-11T18:00:00.000Z",
      sets: 1,
      reps: 8,
      durationSeconds: 42,
      formScore: 92,
      goodReps: 7,
      warnings: 1,
      averageAngle: 108,
      setHistory: [{ set: 1, reps: 8, durationSeconds: 42, averageAngle: 108, warnings: 1 }],
    };
    const plan = {
      sessionNumber: 2,
      focus: "Bíceps y brazo · hipertrofia controlada",
      guidedExercise: "Curl estricto",
      guidedReps: 8,
      goal: "Hipertrofia con progresión controlada.",
      exercises: [
        { name: "Curl estricto", detail: "3 series · 8–12 reps · 90 s", cue: "RIR 1–2" },
        { name: "Curl martillo", detail: "3 series · 10 reps · 90 s", cue: "RIR 1–2" },
        { name: "Extensión de tríceps", detail: "2 series · 10 reps · 90 s", cue: "Técnica" },
      ],
      note: "Mantén una repetición en reserva y detente al perder la técnica.",
    };
    session.nextSessionPlan = plan;
    localStorage.setItem("curlVisionWorkoutHistory", JSON.stringify([session]));
    localStorage.setItem("curlVisionNextSessionPlan", JSON.stringify(plan));
    localStorage.removeItem("curlVisionWorkoutId");
  });
  await page.reload({ waitUntil: "networkidle" });

  await page.locator("#dashboard-open-history").click();
  await expect(page.locator("#results-dashboard")).toBeVisible();
  await expect(page.locator("#dashboard-title")).toContainText("Sesión 1");
  await expect(page.locator("#dashboard-page-progress")).toBeVisible();
  await expect(page.locator("#dashboard-history")).toContainText("8 válidas");
  await expect(page.locator("#dashboard-history")).toContainText("1 no contadas");

  await page.locator('[data-dashboard-page="body"]').click();
  await expect(page.locator("#dashboard-page-body")).toBeVisible();
  await expect(page.locator("#body-muscle-list")).toContainText("Bíceps braquial");
  await page.screenshot({ path: "outputs/dashboard-body.png", fullPage: true });

  await page.locator('[data-dashboard-page="recovery"]').click();
  await expect(page.locator("#dashboard-page-recovery")).toBeVisible();
  await expect(page.locator("#nutrition-plan .nutrition-item")).toHaveCount(4);

  await page.locator('[data-dashboard-page="summary"]').click();
  await expect(page.locator("#dashboard-new-session")).toHaveText("Empezar sesión 2");
  await page.locator("#dashboard-new-session").click();
  await expect(page.locator("#results-dashboard")).toBeHidden();
  await expect(page.locator("#live-coach")).toContainText("Sesión 2", { timeout: 15000 });
});

test("trained curl-quality artifact is deployable and exposed in the live UI", async ({ page }) => {
  const baseUrl = process.env.UI_BASE_URL || "http://127.0.0.1:8765/";
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35*", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        export const FilesetResolver = { forVisionTasks: async () => ({}) };
        export class PoseLandmarker {
          static async createFromOptions() {
            return { detectForVideo: () => ({ landmarks: [] }) };
          }
        }
      `,
    });
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });

  await expect(page.locator("#live-rejected")).toHaveText("0");
  const artifact = await page.evaluate(async () => {
    const response = await fetch("./models/curl-quality-v1.json", { cache: "no-store" });
    const model = await response.json();
    const runtime = await import("./curl-quality.js");
    runtime.validateCurlQualityModel(model);
    return {
      status: response.status,
      id: model.model_id,
      eligible: model.evaluation.deployment_gate.eligible,
      auc: model.evaluation.roc_auc,
    };
  });

  expect(artifact).toEqual({ status: 200, id: "curl-quality-v1", eligible: true, auc: 0.8815 });
  expect(pageErrors).toEqual([]);
});

test("start flow waits for briefing, countdown, and both tracking models", async ({ page }) => {
  const baseUrl = process.env.UI_BASE_URL || "http://127.0.0.1:8765/";
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35*", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        export const FilesetResolver = { forVisionTasks: async () => ({}) };
        export class PoseLandmarker {
          static async createFromOptions() {
            return { detectForVideo: () => ({ landmarks: [] }) };
          }
        }
      `,
    });
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const voiceButton = page.locator("#voice-toggle");
  if (await voiceButton.isEnabled()) await voiceButton.click();

  await page.locator("#live-start").click();
  await expect(page.locator("#live-status")).toHaveText("buscando", { timeout: 15000 });
  await expect(page.locator("#workout-progress")).toContainText("0/8");
  await expect(page.locator("#live-rejected")).toHaveText("0");
  expect(pageErrors).toEqual([]);
});
