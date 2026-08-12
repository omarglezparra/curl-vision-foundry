import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const engineSource = await readFile(new URL("../docs/curl-quality.js", import.meta.url), "utf8");
const engine = await import(`data:text/javascript;base64,${Buffer.from(engineSource).toString("base64")}`);
const model = JSON.parse(await readFile(new URL("../docs/models/curl-quality-v1.json", import.meta.url), "utf8"));

function landmark(x = 0.5, y = 0.5) {
  return { x, y, z: 0, visibility: 0.99, presence: 0.99 };
}

function landmarksFor(angle, progress, fault = "") {
  const landmarks = Array.from({ length: 33 }, () => landmark());
  const movement = Math.max(0, Math.min((145 - angle) / 90, 1));
  const torsoShift = fault === "torso" ? movement * 0.18 : 0;
  const hipShift = fault === "torso" ? movement * 0.02 : 0;
  const shrug = fault === "shoulder" ? movement * 0.08 : 0;
  const elbowForward = fault === "elbow" ? movement * 0.16 : 0;

  landmarks[11] = landmark(0.44 + torsoShift, 0.30 - shrug);
  landmarks[12] = landmark(0.56 + torsoShift, 0.30 - shrug);
  landmarks[23] = landmark(0.46 + hipShift, 0.65);
  landmarks[24] = landmark(0.54 + hipShift, 0.65);
  landmarks[7] = landmark(0.47 + torsoShift, 0.20);
  landmarks[8] = landmark(0.53 + torsoShift, 0.20);

  const shoulder = landmarks[12];
  const elbow = landmark(shoulder.x + elbowForward, shoulder.y + 0.16);
  const radians = ((-90 + angle) * Math.PI) / 180;
  const wrist = landmark(elbow.x + Math.cos(radians) * 0.16, elbow.y + Math.sin(radians) * 0.16);
  landmarks[14] = elbow;
  landmarks[16] = wrist;
  landmarks[13] = landmark(landmarks[11].x, landmarks[11].y + 0.16);
  landmarks[15] = landmark(landmarks[13].x + 0.1, landmarks[13].y + 0.12);
  return landmarks;
}

function runAttempt({ fault = "", partial = false } = {}) {
  const tracker = new engine.CurlAttemptTracker(model);
  const angles = partial
    ? [145, 145, 145, 125, 110, 105, 105, 115, 130, 145, 145, 145]
    : [145, 145, 145, 120, 95, 75, 55, 55, 55, 75, 95, 120, 145, 145, 145];
  const events = [];
  angles.forEach((angle, index) => {
    const progress = index / (angles.length - 1);
    const landmarks = landmarksFor(angle, progress, fault);
    const sample = engine.createCurlQualitySample(landmarks, "right", index * 0.12, angle);
    events.push(tracker.update(sample));
  });
  return events;
}

test("the exported model passed the grouped-video deployment gate", () => {
  assert.equal(engine.validateCurlQualityModel(model), model);
  assert.equal(model.evaluation.deployment_gate.eligible, true);
  assert.ok(model.evaluation.roc_auc >= 0.75);
  assert.ok(model.evaluation.bad_rejection_rate >= 0.65);
});

test("a full stable curl is accepted only after returning to extension", () => {
  const events = runAttempt();
  const acceptedIndexes = events
    .map((event, index) => event.type === "accepted" ? index : -1)
    .filter((index) => index >= 0);
  assert.deepEqual(acceptedIndexes, [14]);
  assert.equal(events[14].quality.valid, true);
  assert.ok(events[14].quality.rangeOfMotion >= model.counting.minimum_range_of_motion_deg);
});

test("an incomplete curl is rejected and never accepted", () => {
  const events = runAttempt({ partial: true });
  assert.equal(events.some((event) => event.type === "accepted"), false);
  const rejected = events.find((event) => event.type === "rejected");
  assert.equal(rejected?.quality.reason, "range");
});

test("elbow travel, torso sway, and shoulder shrug are rejected with specific cues", () => {
  for (const reason of ["elbow", "torso", "shoulder"]) {
    const events = runAttempt({ fault: reason });
    assert.equal(
      events.some((event) => event.type === "accepted"),
      false,
      JSON.stringify({ reason, terminal: events.filter((event) => ["accepted", "rejected"].includes(event.type)) }),
    );
    const rejected = events.find((event) => event.type === "rejected");
    assert.equal(rejected?.quality.reason, reason);
    assert.match(rejected?.message || "", /Intento no contado/);
  }
});
