const ARM_INDEXES = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24 },
};

const REQUIRED_FEATURES = [
  "upper_arm_tilt_p90_deg",
  "upper_arm_drift_p90_deg",
  "torso_tilt_p90_deg",
  "torso_lean_change_p90_deg",
  "body_shift_p90_ratio",
  "shoulder_shift_p90_ratio",
  "shoulder_lift_p90_ratio",
  "elbow_offset_p90_ratio",
  "elbow_offset_change_p90_ratio",
  "neck_shorten_p90_ratio",
];

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function point(landmark) {
  return { x: Number(landmark.x), y: Number(landmark.y) };
}

function midpoint(first, second) {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function averagePoint(points) {
  return {
    x: points.reduce((sum, item) => sum + item.x, 0) / points.length,
    y: points.reduce((sum, item) => sum + item.y, 0) / points.length,
  };
}

function distance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function subtract(first, second) {
  return { x: first.x - second.x, y: first.y - second.y };
}

function vectorAngleDegrees(first, second) {
  const firstLength = Math.hypot(first.x, first.y);
  const secondLength = Math.hypot(second.x, second.y);
  if (firstLength < 1e-8 || secondLength < 1e-8) return 0;
  const cosine = clamp(
    (first.x * second.x + first.y * second.y) / (firstLength * secondLength),
    -1,
    1,
  );
  return (Math.acos(cosine) * 180) / Math.PI;
}

function landmarkVisibility(landmark) {
  if (!landmark) return 0;
  if (typeof landmark.visibility === "number") return landmark.visibility;
  if (typeof landmark.presence === "number") return landmark.presence;
  return 1;
}

function elbowAngle(shoulder, elbow, wrist) {
  return vectorAngleDegrees(subtract(shoulder, elbow), subtract(wrist, elbow));
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function validateCurlQualityModel(model) {
  if (!model || model.schema_version !== 1 || model.model_id !== "curl-quality-v1") {
    throw new Error("Curl quality model schema is not supported");
  }
  if (model.evaluation?.deployment_gate?.eligible !== true) {
    throw new Error("Curl quality model did not pass its deployment gate");
  }
  if (JSON.stringify(model.features) !== JSON.stringify(REQUIRED_FEATURES)) {
    throw new Error("Curl quality feature order does not match the runtime");
  }
  const featureCount = REQUIRED_FEATURES.length;
  if (
    model.standard_scaler?.mean?.length !== featureCount
    || model.standard_scaler?.scale?.length !== featureCount
    || model.classifier?.coefficients?.length !== featureCount
  ) {
    throw new Error("Curl quality model coefficients are incomplete");
  }
  return model;
}

export function createCurlQualitySample(landmarks, arm, timestampSeconds, suppliedAngle = null) {
  const indexes = ARM_INDEXES[arm];
  if (!indexes || !Array.isArray(landmarks) || landmarks.length < 25) return null;

  const requiredIndexes = [11, 12, 23, 24, indexes.shoulder, indexes.elbow, indexes.wrist, indexes.hip];
  if (requiredIndexes.some((index) => !landmarks[index])) return null;
  const visibility = Math.min(...requiredIndexes.map((index) => landmarkVisibility(landmarks[index])));
  const leftShoulder = point(landmarks[11]);
  const rightShoulder = point(landmarks[12]);
  const leftHip = point(landmarks[23]);
  const rightHip = point(landmarks[24]);
  const shoulder = point(landmarks[indexes.shoulder]);
  const elbow = point(landmarks[indexes.elbow]);
  const wrist = point(landmarks[indexes.wrist]);
  const sameHip = point(landmarks[indexes.hip]);
  const shoulderCenter = midpoint(leftShoulder, rightShoulder);
  const hipCenter = midpoint(leftHip, rightHip);
  const torsoScale = Math.max(distance(shoulderCenter, hipCenter), distance(leftShoulder, rightShoulder), 0.05);

  let earCenter = null;
  if (
    landmarks[7]
    && landmarks[8]
    && Math.min(landmarkVisibility(landmarks[7]), landmarkVisibility(landmarks[8])) >= 0.35
  ) {
    earCenter = midpoint(point(landmarks[7]), point(landmarks[8]));
  }

  return {
    timestamp: Number(timestampSeconds),
    arm,
    angle: suppliedAngle === null ? elbowAngle(shoulder, elbow, wrist) : Number(suppliedAngle),
    shoulder,
    elbow,
    wrist,
    sameHip,
    shoulderCenter,
    hipCenter,
    bodyCenter: midpoint(shoulderCenter, hipCenter),
    earCenter,
    torsoScale,
    visibility,
  };
}

export function curlQualityFeatures(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new Error("At least two pose samples are required to score a curl");
  }
  const baselineSamples = samples.slice(0, Math.min(3, samples.length));
  const baselineShoulder = averagePoint(baselineSamples.map((item) => item.shoulder));
  const baselineBody = averagePoint(baselineSamples.map((item) => item.bodyCenter));
  const baselineUpper = averagePoint(baselineSamples.map((item) => subtract(item.elbow, item.shoulder)));
  const baselineTorso = averagePoint(baselineSamples.map((item) => subtract(item.shoulderCenter, item.hipCenter)));
  const baselineShoulderHip = mean(baselineSamples.map((item) => item.sameHip.y - item.shoulder.y));
  const baselineElbowOffset = mean(
    baselineSamples.map((item) => Math.abs(item.elbow.x - item.shoulder.x) / item.torsoScale),
  );
  const baselineNeckValues = baselineSamples
    .filter((item) => item.earCenter)
    .map((item) => distance(item.shoulderCenter, item.earCenter) / item.torsoScale);
  const baselineNeckRatio = baselineNeckValues.length ? mean(baselineNeckValues) : null;

  const verticalDown = { x: 0, y: 1 };
  const verticalUp = { x: 0, y: -1 };
  const metrics = {
    upperArmTilt: [],
    upperArmDrift: [],
    torsoTilt: [],
    torsoChange: [],
    bodyShift: [],
    shoulderShift: [],
    shoulderLift: [],
    elbowOffset: [],
    elbowOffsetChange: [],
    neckShorten: [],
  };

  samples.forEach((item) => {
    const scale = Math.max(item.torsoScale, 0.05);
    const upper = subtract(item.elbow, item.shoulder);
    const torso = subtract(item.shoulderCenter, item.hipCenter);
    const offset = Math.abs(item.elbow.x - item.shoulder.x) / scale;
    metrics.upperArmTilt.push(vectorAngleDegrees(upper, verticalDown));
    metrics.upperArmDrift.push(vectorAngleDegrees(upper, baselineUpper));
    metrics.torsoTilt.push(vectorAngleDegrees(torso, verticalUp));
    metrics.torsoChange.push(vectorAngleDegrees(torso, baselineTorso));
    metrics.bodyShift.push(distance(item.bodyCenter, baselineBody) / scale);
    metrics.shoulderShift.push(distance(item.shoulder, baselineShoulder) / scale);
    metrics.shoulderLift.push(Math.abs((item.sameHip.y - item.shoulder.y) - baselineShoulderHip) / scale);
    metrics.elbowOffset.push(offset);
    metrics.elbowOffsetChange.push(Math.abs(offset - baselineElbowOffset));
    if (baselineNeckRatio !== null && item.earCenter) {
      const neckRatio = distance(item.shoulderCenter, item.earCenter) / scale;
      metrics.neckShorten.push(Math.max(0, baselineNeckRatio - neckRatio));
    }
  });

  return {
    upper_arm_tilt_p90_deg: percentile(metrics.upperArmTilt, 0.90),
    upper_arm_drift_p90_deg: percentile(metrics.upperArmDrift, 0.90),
    torso_tilt_p90_deg: percentile(metrics.torsoTilt, 0.90),
    torso_lean_change_p90_deg: percentile(metrics.torsoChange, 0.90),
    body_shift_p90_ratio: percentile(metrics.bodyShift, 0.90),
    shoulder_shift_p90_ratio: percentile(metrics.shoulderShift, 0.90),
    shoulder_lift_p90_ratio: percentile(metrics.shoulderLift, 0.90),
    elbow_offset_p90_ratio: percentile(metrics.elbowOffset, 0.90),
    elbow_offset_change_p90_ratio: percentile(metrics.elbowOffsetChange, 0.90),
    neck_shorten_p90_ratio: percentile(metrics.neckShorten, 0.90),
  };
}

export function curlGoodProbability(features, model) {
  validateCurlQualityModel(model);
  let logit = Number(model.classifier.intercept);
  model.features.forEach((name, index) => {
    const scale = Math.max(Number(model.standard_scaler.scale[index]), 1e-8);
    const standardized = (Number(features[name]) - Number(model.standard_scaler.mean[index])) / scale;
    logit += Number(model.classifier.coefficients[index]) * standardized;
  });
  if (logit >= 0) return 1 / (1 + Math.exp(-logit));
  const exponential = Math.exp(logit);
  return exponential / (1 + exponential);
}

function likelyModelReason(features, counting) {
  const reasonScores = {
    elbow: Math.max(
      features.upper_arm_tilt_p90_deg / counting.maximum_upper_arm_tilt_p90_deg,
      features.upper_arm_drift_p90_deg / counting.maximum_upper_arm_drift_p90_deg,
      features.elbow_offset_p90_ratio / 0.34,
      features.elbow_offset_change_p90_ratio / 0.22,
    ),
    torso: Math.max(
      features.torso_lean_change_p90_deg / counting.maximum_torso_lean_change_p90_deg,
      features.body_shift_p90_ratio / counting.maximum_body_shift_p90_ratio,
    ),
    shoulder: Math.max(
      features.shoulder_lift_p90_ratio / counting.maximum_shoulder_lift_p90_ratio,
      features.neck_shorten_p90_ratio / 0.12,
    ),
  };
  const [reason, score] = Object.entries(reasonScores).sort((left, right) => right[1] - left[1])[0];
  return score >= 0.72 ? reason : "quality";
}

export function scoreCurlAttempt(samples, model, { visibilityLost = false } = {}) {
  validateCurlQualityModel(model);
  const counting = model.counting;
  const angles = samples.map((item) => item.angle);
  const minimumAngle = Math.min(...angles);
  const maximumAngle = Math.max(...angles);
  const rangeOfMotion = maximumAngle - minimumAngle;
  const durationSeconds = Math.max(samples.at(-1).timestamp - samples[0].timestamp, 0);
  const minimumVisibility = Math.min(...samples.map((item) => item.visibility));
  const features = curlQualityFeatures(samples);
  const goodProbability = curlGoodProbability(features, model);

  let reason = "";
  if (visibilityLost || minimumVisibility < counting.minimum_visibility) reason = "visibility";
  else if (
    maximumAngle < counting.down_angle_deg
    || minimumAngle > counting.up_angle_deg
    || rangeOfMotion < counting.minimum_range_of_motion_deg
  ) reason = "range";
  else if (
    features.upper_arm_tilt_p90_deg > counting.maximum_upper_arm_tilt_p90_deg
    || features.upper_arm_drift_p90_deg > counting.maximum_upper_arm_drift_p90_deg
  ) reason = "elbow";
  else if (
    features.torso_lean_change_p90_deg > counting.maximum_torso_lean_change_p90_deg
    || features.body_shift_p90_ratio > counting.maximum_body_shift_p90_ratio
  ) reason = "torso";
  else if (features.shoulder_lift_p90_ratio > counting.maximum_shoulder_lift_p90_ratio) reason = "shoulder";
  else if (
    durationSeconds < counting.minimum_rep_seconds
    || durationSeconds > counting.maximum_rep_seconds
  ) reason = "speed";
  else if (goodProbability < model.classifier.good_probability_threshold) {
    reason = likelyModelReason(features, counting);
  }

  return {
    valid: !reason,
    reason: reason || "good",
    message: reason ? model.coaching[reason] || model.coaching.quality : "Repetición válida.",
    goodProbability,
    qualityScore: Math.round(goodProbability * 100),
    minimumAngle,
    maximumAngle,
    rangeOfMotion,
    durationSeconds,
    minimumVisibility,
    features,
  };
}

function appendUniqueSample(attempt, sample) {
  if (!attempt.samples.length || attempt.samples.at(-1).timestamp !== sample.timestamp) {
    attempt.samples.push(sample);
  }
}

export class CurlAttemptTracker {
  constructor(model) {
    this.model = validateCurlQualityModel(model);
    this.reset();
  }

  reset() {
    this.readySample = null;
    this.activeAttempt = null;
    this.phase = "unknown";
    this.phaseCandidate = "unknown";
    this.phaseCandidateFrames = 0;
  }

  get activeArm() {
    return this.activeAttempt?.arm || this.readySample?.arm || null;
  }

  markVisibilityLost() {
    if (this.activeAttempt) this.activeAttempt.visibilityLost = true;
  }

  update(sample) {
    const counting = this.model.counting;
    const candidate = sample.angle >= counting.down_angle_deg
      ? "down"
      : sample.angle <= counting.up_angle_deg
        ? "up"
        : "middle";

    if (candidate === "middle") {
      this.phaseCandidate = "middle";
      this.phaseCandidateFrames = 0;
      if (this.activeAttempt) {
        appendUniqueSample(this.activeAttempt, sample);
      } else if (this.readySample && sample.angle <= this.readySample.angle - 5) {
        this.activeAttempt = {
          arm: this.readySample.arm,
          samples: [this.readySample, sample],
          reachedTop: false,
          visibilityLost: false,
        };
      }
      return {
        type: "progress",
        message: this.activeAttempt?.reachedTop
          ? "Baja controlado hasta extender el brazo."
          : this.activeAttempt
            ? "Sube con el codo estable."
            : "Extiende el brazo para iniciar.",
      };
    }

    if (this.phaseCandidate === candidate) this.phaseCandidateFrames += 1;
    else {
      this.phaseCandidate = candidate;
      this.phaseCandidateFrames = 1;
    }
    if (this.phaseCandidateFrames < 3) {
      if (this.activeAttempt) appendUniqueSample(this.activeAttempt, sample);
      return {
        type: "progress",
        message: candidate === "down" ? "Completa la extensión." : "Aprieta arriba sin mover el codo.",
      };
    }

    if (candidate === "up") {
      if (!this.activeAttempt && this.readySample) {
        this.activeAttempt = {
          arm: this.readySample.arm,
          samples: [this.readySample],
          reachedTop: false,
          visibilityLost: false,
        };
      }
      if (!this.activeAttempt) {
        return { type: "progress", message: "Primero extiende el brazo por completo." };
      }
      appendUniqueSample(this.activeAttempt, sample);
      this.activeAttempt.reachedTop = true;
      this.phase = "up";
      return { type: "top", message: "Arriba. Baja controlado para validar la repetición." };
    }

    if (this.activeAttempt) {
      appendUniqueSample(this.activeAttempt, sample);
      const attempt = this.activeAttempt;
      const angles = attempt.samples.map((item) => item.angle);
      const movement = Math.max(...angles) - Math.min(...angles);
      this.activeAttempt = null;
      this.readySample = sample;
      this.phase = "down";
      this.phaseCandidateFrames = 0;
      if (!attempt.reachedTop && movement < 25) {
        return { type: "ready", message: "Posición inicial lista. Sube controlado." };
      }
      const quality = scoreCurlAttempt(attempt.samples, this.model, {
        visibilityLost: attempt.visibilityLost,
      });
      return {
        type: quality.valid ? "accepted" : "rejected",
        message: quality.message,
        quality,
      };
    }

    this.readySample = sample;
    this.phase = "down";
    return { type: "ready", message: "Posición inicial lista. Sube controlado." };
  }
}

export const CURL_QUALITY_FEATURES = REQUIRED_FEATURES;
