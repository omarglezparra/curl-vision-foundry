import 'dotenv/config';

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AppServer,
  AppSession,
  type AuthenticatedRequest,
  type RtmpStreamStatus,
} from '@mentra/sdk';
import express, {
  type Request,
  type RequestHandler,
  type Response as ExpressResponse,
} from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';

type RotationDegrees = 0 | 90 | 180 | 270;
type WorkoutStatus =
  | 'ready'
  | 'waiting_for_wifi'
  | 'starting'
  | 'streaming'
  | 'reconnecting'
  | 'stopping'
  | 'stopped'
  | 'error';

type GeometrySettings = {
  rotationDegrees: RotationDegrees;
  sceneReflected: boolean;
  sourcePixelsMirrored: boolean;
};

type WorkoutRuntime = {
  session: AppSession;
  mentraSessionId: string;
  userId: string;
  profileId: string;
  workoutId: string | null;
  streamId: string | null;
  status: WorkoutStatus;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  geometry: GeometrySettings;
  batteryLevel: number | null;
  wifiConnected: boolean;
  stats: RtmpStreamStatus['stats'] | null;
  cleanup: Array<() => void>;
  cancelWaiters: Set<(reason?: Error) => void>;
  statusWriteChain: Promise<void>;
  profileWriteChain: Promise<void>;
  streamOperationChain: Promise<void>;
  dataDeletionInProgress: boolean;
};

type StreamStatus = RtmpStreamStatus['status'];

type StreamWaiter = {
  promise: Promise<RtmpStreamStatus>;
  cancel: (reason?: Error) => void;
};

const ACTIVE_WORKOUT_STATUSES: ReadonlySet<WorkoutStatus> = new Set([
  'starting',
  'streaming',
  'reconnecting',
  'stopping',
]);
const START_SUCCESS_STATUSES: ReadonlySet<StreamStatus> = new Set([
  'streaming',
  'active',
  'reconnected',
]);
const STREAM_FAILURE_STATUSES: ReadonlySet<StreamStatus> = new Set([
  'error',
  'stopped',
  'disconnected',
  'timeout',
  'reconnect_failed',
]);
const STOP_TERMINAL_STATUSES: ReadonlySet<StreamStatus> = new Set([
  'stopped',
  'disconnected',
  'error',
  'timeout',
  'reconnect_failed',
]);
const STREAM_START_TIMEOUT_MS = 30_000;
const STREAM_STOP_TIMEOUT_MS = 15_000;
const AZURE_REQUEST_TIMEOUT_MS = 7_000;
const AZURE_RETRY_DELAYS_MS = [0, 300, 900] as const;
const MAX_STREAM_AUTH_TTL_SECONDS = 4 * 60 * 60;
const APP_VERSION = '0.1.0';
const POLICY_EFFECTIVE_DATE = 'July 30, 2026';
const DEFAULT_RAW_CAPTURE_RETENTION_DAYS = 30;
const DEFAULT_DERIVED_DATA_RETENTION_DAYS = 365;
const MAX_RETENTION_DAYS = 3_650;

const isProduction = process.env.NODE_ENV?.trim().toLowerCase() === 'production';

const packageName = requiredEnv('PACKAGE_NAME');
const apiKey = credentialEnv('MENTRAOS_API_KEY', 24);
const cookieSecret = secretEnv('COOKIE_SECRET');
const profileIdSecret = secretEnv('PROFILE_ID_SECRET');
const streamBaseUrl = process.env.MENTRA_STREAM_BASE_URL?.trim() ?? '';
const streamKeySecret = secretEnv('STREAM_KEY_SECRET');
const azureApiBase = process.env.AZURE_CAPTURE_API_BASE?.trim().replace(/\/$/, '') ?? '';
const azureToken = optionalCredentialEnv('AZURE_MINIAPP_API_TOKEN', 32);
const port = numberEnv('PORT', 3000);
const streamAuthTtlSeconds = integerEnv(
  'MENTRA_STREAM_AUTH_TTL_SECONDS',
  MAX_STREAM_AUTH_TTL_SECONDS,
  300,
  MAX_STREAM_AUTH_TTL_SECONDS
);
const rawCaptureRetentionDays = integerEnv(
  'AZURE_RAW_CAPTURE_RETENTION_DAYS',
  DEFAULT_RAW_CAPTURE_RETENTION_DAYS,
  1,
  MAX_RETENTION_DAYS
);
const derivedDataRetentionDays = integerEnv(
  'AZURE_DERIVED_DATA_RETENTION_DAYS',
  DEFAULT_DERIVED_DATA_RETENTION_DAYS,
  1,
  MAX_RETENTION_DAYS
);
const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const publicUrl = process.env.MENTRA_MINIAPP_PUBLIC_URL?.trim().replace(/\/$/, '') ?? '';
const mentraWebsocketAllowedHosts = (process.env.MENTRA_WEBSOCKET_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const operatorName = productionContactEnv('APP_OPERATOR_NAME', 'AI Javier Coach development');
const supportEmail = productionEmailEnv('SUPPORT_EMAIL', 'support@example.invalid');

function requiredEnv(name: string) {
  const value = process.env[name]?.trim() ?? '';
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function isPlaceholderCredential(value: string) {
  return (
    /<[^>]+>/.test(value) ||
    /(?:^|[\s_.:/-])(?:change(?:-?me)?|replace(?:-?me)?|your|example|placeholder|dummy|sample|todo|insert)(?:$|[\s_.:/-])/i.test(
      value
    )
  );
}

function credentialEnv(name: string, productionMinimumCharacters = 1) {
  const value = requiredEnv(name);
  if (isPlaceholderCredential(value)) {
    throw new Error(`${name} is still a placeholder.`);
  }
  if (isProduction && Array.from(value).length < productionMinimumCharacters) {
    throw new Error(
      `${name} must contain at least ${productionMinimumCharacters} characters in production.`
    );
  }
  return value;
}

function optionalCredentialEnv(name: string, productionMinimumCharacters: number) {
  const value = process.env[name]?.trim() ?? '';
  if (!value) return '';
  if (isPlaceholderCredential(value)) throw new Error(`${name} is still a placeholder.`);
  if (isProduction && Array.from(value).length < productionMinimumCharacters) {
    throw new Error(
      `${name} must contain at least ${productionMinimumCharacters} characters in production.`
    );
  }
  return value;
}

function secretEnv(name: string) {
  const value = credentialEnv(name);
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error(`${name} must contain at least 32 bytes.`);
  }
  return value;
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric.`);
  return value;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const value = numberEnv(name, fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function productionContactEnv(name: string, developmentFallback: string) {
  const value = process.env[name]?.trim() ?? '';
  if (isProduction && (!value || /(?:replace[-_ ]|your[-_ ]|example|<[^>]+>)/i.test(value))) {
    throw new Error(`${name} must identify the app operator in production.`);
  }
  return value || developmentFallback;
}

function productionEmailEnv(name: string, developmentFallback: string) {
  const value = process.env[name]?.trim() ?? '';
  if (isProduction && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    throw new Error(`${name} must be a valid monitored email address in production.`);
  }
  return value || developmentFallback;
}

function assertProductionConfiguration() {
  if (!isProduction) return;
  if (profileIdSecret === streamKeySecret) {
    throw new Error('PROFILE_ID_SECRET and STREAM_KEY_SECRET must be different in production.');
  }
  if (!publicUrl) throw new Error('MENTRA_MINIAPP_PUBLIC_URL is required in production.');
  if (!mentraWebsocketAllowedHosts.length) {
    throw new Error('MENTRA_WEBSOCKET_ALLOWED_HOSTS is required in production.');
  }
  if (
    mentraWebsocketAllowedHosts.some(
      (host) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
    )
  ) {
    throw new Error('MENTRA_WEBSOCKET_ALLOWED_HOSTS must contain exact DNS hostnames.');
  }
  let appUrl: URL;
  let captureUrl: URL;
  let ingestUrl: URL;
  try {
    appUrl = new URL(publicUrl);
    captureUrl = new URL(azureApiBase);
    ingestUrl = new URL(streamBaseUrl);
  } catch {
    throw new Error('Production MiniApp, Azure, and stream URLs must all be configured.');
  }
  if (appUrl.protocol !== 'https:') {
    throw new Error('MENTRA_MINIAPP_PUBLIC_URL must use HTTPS in production.');
  }
  if (captureUrl.protocol !== 'https:') {
    throw new Error('AZURE_CAPTURE_API_BASE must use HTTPS in production.');
  }
  if (ingestUrl.protocol !== 'rtmps:') {
    throw new Error('MENTRA_STREAM_BASE_URL must use RTMPS in production.');
  }
  if (!azureToken) throw new Error('AZURE_MINIAPP_API_TOKEN is required in production.');
}

assertProductionConfiguration();

function boolEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function rotationEnv(): RotationDegrees {
  const value = numberEnv('DEFAULT_ROTATION_DEGREES', 0);
  if (![0, 90, 180, 270].includes(value)) {
    throw new Error('DEFAULT_ROTATION_DEGREES must be 0, 90, 180, or 270.');
  }
  return value as RotationDegrees;
}

function defaultGeometry(): GeometrySettings {
  return {
    rotationDegrees: rotationEnv(),
    sceneReflected: boolEnv('DEFAULT_SCENE_REFLECTED', true),
    sourcePixelsMirrored: boolEnv('DEFAULT_SOURCE_PIXELS_MIRRORED', false),
  };
}

function parseGeometry(body: unknown, fallback: GeometrySettings): GeometrySettings {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const rotation = Number(value.rotationDegrees ?? fallback.rotationDegrees);
  if (![0, 90, 180, 270].includes(rotation)) {
    throw new Error('rotationDegrees must be 0, 90, 180, or 270.');
  }
  return {
    rotationDegrees: rotation as RotationDegrees,
    sceneReflected:
      typeof value.sceneReflected === 'boolean' ? value.sceneReflected : fallback.sceneReflected,
    sourcePixelsMirrored:
      typeof value.sourcePixelsMirrored === 'boolean'
        ? value.sourcePixelsMirrored
        : fallback.sourcePixelsMirrored,
  };
}

function safeId(value: string) {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'session';
}

function workoutStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function pseudonymousProfileId(userId: string) {
  const digest = createHmac('sha256', profileIdSecret)
    .update(`ai-javier-profile\0${userId}`)
    .digest('hex')
    .slice(0, 24);
  return `mp_${digest}`;
}

function signedStreamId(profileId: string, workoutId: string, geometry: GeometrySettings) {
  const workout = safeId(workoutId).slice(0, 48);
  const expiresAt = Math.floor(Date.now() / 1000) + streamAuthTtlSeconds;
  const nonce = randomBytes(18).toString('base64url');
  const unsigned = [
    `ajc_${workout}`,
    `p_${profileId}`,
    `r_${geometry.rotationDegrees}`,
    `s_${geometry.sceneReflected ? 1 : 0}`,
    `m_${geometry.sourcePixelsMirrored ? 1 : 0}`,
    `e_${expiresAt}`,
    `n_${nonce}`,
  ].join('__');
  const signature = createHmac('sha256', streamKeySecret)
    .update(unsigned)
    .digest('hex')
    .slice(0, 32);
  const streamId = `${unsigned}__h_${signature}`;
  if (streamId.length > 220 || !/^[A-Za-z0-9_-]+$/.test(streamId)) {
    throw new Error('Generated stream ID is not safe for an RTMP path.');
  }
  return streamId;
}

function buildRtmpUrl(baseUrl: string, streamId: string) {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('MENTRA_STREAM_BASE_URL must be a valid RTMP or RTMPS URL.');
  }
  if (!['rtmp:', 'rtmps:'].includes(url.protocol) || !url.hostname) {
    throw new Error('MENTRA_STREAM_BASE_URL must start with rtmp:// or rtmps:// and include a host.');
  }
  if (url.hash) throw new Error('MENTRA_STREAM_BASE_URL cannot contain a URL fragment.');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${streamId}`;
  return url.toString();
}

function cameraAngle(geometry: GeometrySettings) {
  return geometry.sceneReflected ? 'head_worn_mirror' : 'head_worn_direct';
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    };
    return entities[character];
  });
}

function legalTemplate(fileName: string) {
  return readFileSync(join(publicDirectory, fileName), 'utf8');
}

const legalTemplates = {
  privacy: legalTemplate('privacy.html'),
  terms: legalTemplate('terms.html'),
  support: legalTemplate('support.html'),
  dataDeletion: legalTemplate('data-deletion.html'),
};

function renderLegalPage(template: string) {
  const replacements: Record<string, string> = {
    '{{APP_OPERATOR_NAME}}': escapeHtml(operatorName),
    '{{SUPPORT_EMAIL}}': escapeHtml(supportEmail),
    '{{SUPPORT_EMAIL_URL}}': encodeURIComponent(supportEmail),
    '{{POLICY_EFFECTIVE_DATE}}': POLICY_EFFECTIVE_DATE,
    '{{RAW_CAPTURE_RETENTION_DAYS}}': String(rawCaptureRetentionDays),
    '{{DERIVED_DATA_RETENTION_DAYS}}': String(derivedDataRetentionDays),
  };
  return Object.entries(replacements).reduce(
    (page, [placeholder, value]) => page.replaceAll(placeholder, value),
    template
  );
}

function sendLegalPage(res: ExpressResponse, template: string) {
  res.type('html').send(renderLegalPage(template));
}

class AzureRequestError extends Error {}
class DataDeletionSafetyError extends Error {}

class JavierCoachApp extends AppServer {
  private readonly runtimes = new Map<string, WorkoutRuntime>();
  private readonly geometryPreferences = new Map<string, GeometrySettings>();

  constructor() {
    super({
      packageName,
      apiKey,
      cookieSecret,
      port,
      publicDir: false,
      healthCheck: false,
      appInstructions:
        'Start and stop a continuous workout stream from the phone webview. AI Javier analyzes curl form and shows performance on the phone.',
    });
    this.configureHttp();
  }

  protected async onSession(session: AppSession, mentraSessionId: string, userId: string) {
    const prior = this.runtimes.get(userId);
    if (prior) {
      try {
        await this.stopWorkoutRuntime(prior, 'session_replaced');
      } catch (error) {
        prior.session.logger.warn(`Could not stop replaced workout cleanly: ${String(error)}`);
      } finally {
        this.geometryPreferences.set(userId, prior.geometry);
        this.cleanupRuntime(prior, new Error('Mentra session was replaced.'));
        if (this.runtimes.get(userId) === prior) this.runtimes.delete(userId);
      }
    }

    const runtime: WorkoutRuntime = {
      session,
      mentraSessionId,
      userId,
      profileId: pseudonymousProfileId(userId),
      workoutId: null,
      streamId: null,
      status: session.device.state.wifiConnected.value ? 'ready' : 'waiting_for_wifi',
      error: null,
      startedAt: null,
      endedAt: null,
      geometry: prior?.geometry ?? this.geometryPreferences.get(userId) ?? defaultGeometry(),
      batteryLevel: session.device.state.batteryLevel.value,
      wifiConnected: session.device.state.wifiConnected.value,
      stats: null,
      cleanup: [],
      cancelWaiters: new Set(),
      statusWriteChain: Promise.resolve(),
      profileWriteChain: Promise.resolve(),
      streamOperationChain: Promise.resolve(),
      dataDeletionInProgress: false,
    };

    this.runtimes.set(userId, runtime);
    if (!prior && !this.geometryPreferences.has(userId)) {
      runtime.profileWriteChain = this.loadGeometryPreference(userId)
        .then((savedGeometry) => {
          if (!savedGeometry || this.runtimes.get(userId) !== runtime || runtime.workoutId) return;
          runtime.geometry = savedGeometry;
          this.geometryPreferences.set(userId, savedGeometry);
        })
        .catch((error) => {
          session.logger.warn(`Could not restore saved camera geometry: ${String(error)}`);
        });
    }
    runtime.cleanup.push(
      session.device.state.wifiConnected.onChange((connected) => {
        runtime.wifiConnected = connected;
        if (!connected && runtime.status === 'ready') runtime.status = 'waiting_for_wifi';
        if (connected && runtime.status === 'waiting_for_wifi') runtime.status = 'ready';
      }),
      session.device.state.batteryLevel.onChange((level) => {
        runtime.batteryLevel = level;
      }),
      session.camera.onStreamStatus((event) => {
        this.applyStreamStatus(runtime, event);
      })
    );
    session.logger.info(`AI Javier ready for user ${userId}`);
  }

  protected async onStop(sessionId: string, userId: string, reason: string) {
    const runtime = this.runtimes.get(userId);
    if (!runtime || runtime.mentraSessionId !== sessionId) {
      this.logger.info(
        { sessionId, userId },
        'Ignoring stop for a stale Mentra session; the replacement session remains active.'
      );
      return;
    }

    try {
      await this.stopWorkoutRuntime(runtime, reason);
    } catch (error) {
      runtime.session.logger.warn(`Workout cleanup did not complete cleanly: ${String(error)}`);
    } finally {
      this.geometryPreferences.set(userId, runtime.geometry);
      this.cleanupRuntime(runtime, new Error(`Mentra session stopped: ${reason}`));
      if (this.runtimes.get(userId) === runtime) this.runtimes.delete(userId);
    }
  }

  private configureHttp() {
    const app = this.getExpressApp();
    app.disable('x-powered-by');
    if (isProduction) app.set('trust proxy', 1);
    app.use(
      helmet({
        crossOriginEmbedderPolicy: false,
        xFrameOptions: false,
        strictTransportSecurity: isProduction
          ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
          : false,
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'none'"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'self'", 'https://mentra.glass', 'https://*.mentra.glass'],
            imgSrc: ["'self'", 'data:'],
            objectSrc: ["'none'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'"],
            upgradeInsecureRequests: isProduction ? [] : null,
          },
        },
      })
    );
    app.use((_req, res, next) => {
      res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
      );
      next();
    });
    app.use(express.json({ limit: '64kb' }));

    const apiLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 600,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => req.method === 'OPTIONS',
      message: { error: 'Too many requests. Try again shortly.' },
    });
    const mutationLimiter = rateLimit({
      windowMs: 60 * 1000,
      limit: 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many changes. Wait a moment and try again.' },
    });
    app.use('/api', apiLimiter);
    app.use(
      ['/api/preferences/geometry', '/api/session/start', '/api/session/stop', '/api/data'],
      mutationLimiter
    );

    const requireAuth: RequestHandler = (req, res, next) => {
      if (!(req as AuthenticatedRequest).authUserId) {
        res.status(401).json({ error: 'Mentra authentication is required.' });
        return;
      }
      next();
    };

    const requireSameSite: RequestHandler = (req, res, next) => {
      const fetchSite = req.get('sec-fetch-site');
      if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
        res.status(403).json({ error: 'Cross-site requests are not allowed.' });
        return;
      }
      next();
    };

    app.get('/', (_req, res) => res.redirect('/webview'));
    app.get('/health', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        status: 'healthy',
        app: packageName,
        version: APP_VERSION,
        activeSessions: this.runtimes.size,
      });
    });
    app.get('/webview', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(join(publicDirectory, 'index.html'));
    });
    app.get('/app.js', (_req, res) => res.sendFile(join(publicDirectory, 'app.js')));
    app.get('/styles.css', (_req, res) => res.sendFile(join(publicDirectory, 'styles.css')));
    app.get('/legal.css', (_req, res) => res.sendFile(join(publicDirectory, 'legal.css')));
    app.get('/assets/app-icon.png', (_req, res) =>
      res.sendFile(join(publicDirectory, 'assets', 'app-icon.png'))
    );
    app.get('/privacy', (_req, res) => sendLegalPage(res, legalTemplates.privacy));
    app.get('/privacy-policy', (_req, res) => res.redirect(308, '/privacy'));
    app.get('/terms', (_req, res) => sendLegalPage(res, legalTemplates.terms));
    app.get('/support', (_req, res) => sendLegalPage(res, legalTemplates.support));
    app.get('/data-deletion', (_req, res) => sendLegalPage(res, legalTemplates.dataDeletion));

    app.get('/api/session', requireAuth, (req, res) => {
      const runtime = this.runtimeForRequest(req);
      if (!runtime) return res.status(404).json({ error: 'No active Mentra session.' });
      return res.json(this.publicRuntime(runtime));
    });

    app.post('/api/preferences/geometry', requireSameSite, requireAuth, async (req, res) => {
      const userId = this.userIdForRequest(req);
      const runtime = this.runtimes.get(userId);
      if (runtime && ACTIVE_WORKOUT_STATUSES.has(runtime.status)) {
        return res.status(409).json({ error: 'Stop recording before changing mirror or rotation settings.' });
      }
      try {
        if (runtime) await runtime.profileWriteChain;
        const geometry = parseGeometry(
          req.body,
          runtime?.geometry ?? this.geometryPreferences.get(userId) ?? defaultGeometry()
        );
        await this.saveGeometryPreference(userId, geometry);
        if (runtime) runtime.geometry = geometry;
        this.geometryPreferences.set(userId, geometry);
        return res.json({ geometry });
      } catch (error) {
        const status = error instanceof AzureRequestError ? 502 : 400;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.post('/api/session/start', requireSameSite, requireAuth, async (req, res) => {
      try {
        const runtime = this.runtimeForRequest(req);
        if (!runtime) return res.status(404).json({ error: 'No active Mentra session.' });
        if (ACTIVE_WORKOUT_STATUSES.has(runtime.status)) {
          return res.status(409).json({ error: `Workout is already ${runtime.status}.` });
        }
        await runtime.profileWriteChain;
        const geometry = parseGeometry(req.body, runtime.geometry);
        await this.saveGeometryPreference(runtime.userId, geometry);
        runtime.geometry = geometry;
        this.geometryPreferences.set(runtime.userId, geometry);
        await this.startWorkout(runtime.userId);
        return res.status(202).json(this.publicRuntime(runtime));
      } catch (error) {
        const status = error instanceof AzureRequestError ? 502 : 409;
        return res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.post('/api/session/stop', requireSameSite, requireAuth, async (req, res) => {
      const runtime = this.runtimeForRequest(req);
      if (!runtime) return res.status(404).json({ error: 'No active Mentra session.' });
      try {
        await this.stopWorkoutRuntime(runtime, 'user_stopped');
        return res.json(this.publicRuntime(runtime));
      } catch (error) {
        return res
          .status(error instanceof AzureRequestError ? 502 : 409)
          .json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.get('/api/performance', requireAuth, async (req, res) => {
      try {
        const profileId = pseudonymousProfileId(this.userIdForRequest(req));
        const url = this.azureEndpoint('performance');
        url.searchParams.set('limit', '12');
        url.searchParams.set('profile_id', profileId);
        const response = await this.azureFetch(url, { method: 'GET' });
        return res.json(await response.json());
      } catch (error) {
        return res.status(502).json({ error: `Azure performance request failed: ${String(error)}` });
      }
    });

    app.delete('/api/data', requireSameSite, requireAuth, async (req, res) => {
      const runtime = this.runtimeForRequest(req);
      const confirmation =
        typeof req.body === 'object' && req.body !== null
          ? String((req.body as Record<string, unknown>).confirmation ?? '')
          : '';
      if (confirmation !== 'DELETE_MY_DATA') {
        return res.status(400).json({ error: 'Data-deletion confirmation is required.' });
      }
      if (runtime?.dataDeletionInProgress) {
        return res.status(409).json({ error: 'Data deletion is already in progress.' });
      }
      if (runtime) runtime.dataDeletionInProgress = true;
      try {
        if (runtime) await this.prepareRuntimeForDataDeletion(runtime);
        const userId = this.userIdForRequest(req);
        const profileId = pseudonymousProfileId(userId);
        const url = this.azureEndpoint('profile-data');
        url.searchParams.set('profile_id', profileId);
        const response = await this.azureFetch(url, { method: 'DELETE' });
        this.geometryPreferences.delete(userId);
        if (runtime) this.resetRuntimeAfterDataDeletion(runtime);
        const result = (await response.json()) as Record<string, unknown>;
        return res.json({ status: 'deleted', deleted: result.deleted ?? {} });
      } catch (error) {
        const status = error instanceof DataDeletionSafetyError ? 409 : 502;
        return res.status(status).json({
          error:
            error instanceof DataDeletionSafetyError
              ? error.message
              : `Data deletion failed: ${String(error)}`,
        });
      } finally {
        if (runtime) runtime.dataDeletionInProgress = false;
      }
    });
  }

  private userIdForRequest(req: Request) {
    return (req as AuthenticatedRequest).authUserId as string;
  }

  private runtimeForRequest(req: Request) {
    const userId = this.userIdForRequest(req);
    return userId ? this.runtimes.get(userId) : undefined;
  }

  private async withStreamOperation<T>(runtime: WorkoutRuntime, operation: () => Promise<T>) {
    const result = runtime.streamOperationChain.catch(() => {}).then(operation);
    runtime.streamOperationChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async prepareRuntimeForDataDeletion(runtime: WorkoutRuntime) {
    return this.withStreamOperation(runtime, async () => {
      const needsStop =
        runtime.dataDeletionInProgress &&
        (ACTIVE_WORKOUT_STATUSES.has(runtime.status) ||
          runtime.status === 'error' ||
          runtime.session.camera.isCurrentlyStreaming());

      if (needsStop) {
        try {
          await this.stopCameraAndWait(runtime);
        } catch (error) {
          if (runtime.session.camera.isCurrentlyStreaming()) {
            throw new DataDeletionSafetyError(
              'Recording shutdown could not be confirmed. Data was not deleted; reconnect the glasses and try again.',
              { cause: error }
            );
          }
          runtime.session.logger.warn(
            `Stream shutdown confirmation ended with an error, but the camera reports stopped: ${String(error)}`
          );
        }
      }

      if (runtime.session.camera.isCurrentlyStreaming()) {
        throw new DataDeletionSafetyError(
          'Recording is still active. Data was not deleted; stop the recording and try again.'
        );
      }

      runtime.status = 'stopped';
      runtime.error = null;
      runtime.endedAt = runtime.endedAt ?? new Date().toISOString();
      await runtime.statusWriteChain.catch((error) => {
        runtime.session.logger.warn(
          `A prior workout status write failed before data deletion: ${String(error)}`
        );
      });
      await runtime.profileWriteChain.catch((error) => {
        runtime.session.logger.warn(
          `A prior profile write failed before data deletion: ${String(error)}`
        );
      });
    });
  }

  private resetRuntimeAfterDataDeletion(runtime: WorkoutRuntime) {
    runtime.workoutId = null;
    runtime.streamId = null;
    runtime.startedAt = null;
    runtime.endedAt = null;
    runtime.error = null;
    runtime.stats = null;
    runtime.geometry = defaultGeometry();
    runtime.status = runtime.wifiConnected ? 'ready' : 'waiting_for_wifi';
  }

  private async startWorkout(userId: string) {
    const runtime = this.runtimes.get(userId);
    if (!runtime) throw new Error('Mentra session is not active.');
    return this.withStreamOperation(runtime, () => this.startWorkoutLocked(runtime));
  }

  private async startWorkoutLocked(runtime: WorkoutRuntime) {
    if (runtime.dataDeletionInProgress) {
      throw new Error('Data deletion is in progress. Wait for it to finish before recording.');
    }
    if (!streamBaseUrl) throw new Error('MENTRA_STREAM_BASE_URL is not configured.');
    if (ACTIVE_WORKOUT_STATUSES.has(runtime.status)) {
      throw new Error(`Workout is already ${runtime.status}.`);
    }
    if (!runtime.wifiConnected) throw new Error('Connect Mentra Live to Wi-Fi before recording.');
    if (runtime.batteryLevel !== null && runtime.batteryLevel < 15) {
      throw new Error('Mentra Live battery must be at least 15%.');
    }
    if (runtime.session.capabilities && !runtime.session.capabilities.hasCamera) {
      throw new Error('The connected glasses do not expose a camera.');
    }
    if (runtime.session.camera.isCurrentlyStreaming()) {
      if (runtime.workoutId) {
        await this.stopWorkoutRuntimeLocked(runtime, 'restart_cleanup');
      } else {
        await this.stopCameraAndWait(runtime);
      }
    }

    runtime.workoutId = `mentra_${workoutStamp()}_${randomUUID().slice(0, 8)}`;
    runtime.streamId = signedStreamId(runtime.profileId, runtime.workoutId, runtime.geometry);
    const rtmpUrl = buildRtmpUrl(streamBaseUrl, runtime.streamId);
    runtime.startedAt = new Date().toISOString();
    runtime.endedAt = null;
    runtime.error = null;
    runtime.stats = null;
    runtime.status = 'starting';
    let startWaiter: StreamWaiter | undefined;

    try {
      await this.postSessionStatus(runtime, 'starting');
      startWaiter = this.createStreamWaiter(
        runtime,
        new Set([...START_SUCCESS_STATUSES, ...STREAM_FAILURE_STATUSES]),
        STREAM_START_TIMEOUT_MS,
        'Mentra Live did not confirm stream startup in time.'
      );
      await runtime.session.camera.startStream({
        rtmpUrl,
        video: {
          width: 854,
          height: 480,
          frameRate: 15,
          bitrate: 1_000_000,
        },
        stream: { durationLimit: 3 * 60 * 60 },
      });
      const event = await startWaiter.promise;
      if (!START_SUCCESS_STATUSES.has(event.status)) {
        throw new Error(event.errorDetails || `Mentra Live stream startup ended with ${event.status}.`);
      }
      runtime.status = 'streaming';
      runtime.error = null;
      await this.postSessionStatus(runtime, 'streaming');
    } catch (error) {
      startWaiter?.cancel();
      if (runtime.session.camera.isCurrentlyStreaming()) {
        try {
          await this.stopCameraAndWait(runtime);
        } catch (stopError) {
          runtime.session.logger.warn(`Could not stop a failed stream startup cleanly: ${String(stopError)}`);
        }
      }
      runtime.status = 'error';
      runtime.error = error instanceof Error ? error.message : String(error);
      runtime.endedAt = new Date().toISOString();
      if (!(error instanceof AzureRequestError)) {
        await this.postSessionStatusSafely(runtime, 'error', 'start_failed');
      }
      throw error;
    } finally {
      startWaiter?.cancel();
    }
  }

  private async stopWorkoutRuntime(runtime: WorkoutRuntime, reason: string) {
    return this.withStreamOperation(runtime, () => this.stopWorkoutRuntimeLocked(runtime, reason));
  }

  private async stopWorkoutRuntimeLocked(runtime: WorkoutRuntime, reason: string) {
    if (!runtime.workoutId) return;
    if (runtime.status === 'stopped' && !runtime.session.camera.isCurrentlyStreaming()) return;

    runtime.status = 'stopping';
    try {
      await this.stopCameraAndWait(runtime);
    } catch (error) {
      runtime.status = 'error';
      runtime.error = error instanceof Error ? error.message : String(error);
      runtime.endedAt = new Date().toISOString();
      await this.postSessionStatusSafely(runtime, 'error', `stop_failed:${reason}`);
      throw error;
    }

    runtime.status = 'stopped';
    runtime.error = null;
    runtime.endedAt = new Date().toISOString();
    try {
      await this.postSessionStatus(runtime, 'stopped', reason);
    } catch (error) {
      runtime.error = 'Recording stopped, but its final Azure status could not be saved.';
      throw error;
    }
  }

  private async stopCameraAndWait(runtime: WorkoutRuntime) {
    if (!runtime.session.camera.isCurrentlyStreaming()) return;
    const stopWaiter = this.createStreamWaiter(
      runtime,
      STOP_TERMINAL_STATUSES,
      STREAM_STOP_TIMEOUT_MS,
      'Mentra Live did not confirm stream shutdown in time.'
    );
    try {
      await runtime.session.camera.stopStream();
      const event = await stopWaiter.promise;
      const alreadyStopped = event.errorDetails?.toLowerCase().includes('not_streaming');
      if (!['stopped', 'disconnected'].includes(event.status) && !alreadyStopped) {
        throw new Error(event.errorDetails || `Mentra Live stream shutdown ended with ${event.status}.`);
      }
    } finally {
      stopWaiter.cancel();
    }
  }

  private applyStreamStatus(runtime: WorkoutRuntime, event: RtmpStreamStatus) {
    if (this.runtimes.get(runtime.userId) !== runtime) return;
    runtime.stats = event.stats ?? runtime.stats;
    if (event.status === 'streaming' || event.status === 'active' || event.status === 'reconnected') {
      runtime.status = 'streaming';
      runtime.error = null;
      void this.postSessionStatusSafely(runtime, 'streaming', event.status);
    } else if (event.status === 'initializing' || event.status === 'connecting') {
      if (runtime.status !== 'stopping') runtime.status = 'starting';
    } else if (event.status === 'reconnecting') {
      if (runtime.status !== 'stopping') runtime.status = 'reconnecting';
    } else if (event.status === 'stopping') {
      runtime.status = 'stopping';
    } else if (event.status === 'stopped' || event.status === 'disconnected') {
      runtime.status = 'stopped';
      runtime.endedAt = new Date().toISOString();
      void this.postSessionStatusSafely(runtime, 'stopped', event.status);
    } else if (event.status === 'error' || event.status === 'timeout' || event.status === 'reconnect_failed') {
      runtime.status = 'error';
      runtime.error = event.errorDetails ?? event.status;
      runtime.endedAt = new Date().toISOString();
      void this.postSessionStatusSafely(runtime, 'error', event.status);
    }
  }

  private createStreamWaiter(
    runtime: WorkoutRuntime,
    terminalStatuses: ReadonlySet<StreamStatus>,
    timeoutMs: number,
    timeoutMessage: string
  ): StreamWaiter {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let cleanupListener = () => {};
    let cancel: (reason?: Error) => void = () => {};

    const promise = new Promise<RtmpStreamStatus>((resolve, reject) => {
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cleanupListener();
        runtime.cancelWaiters.delete(cancel);
        complete();
      };

      cancel = (reason = new Error('Stream status wait was cancelled.')) => {
        finish(() => reject(reason));
      };
      cleanupListener = runtime.session.camera.onStreamStatus((event) => {
        if (terminalStatuses.has(event.status)) finish(() => resolve(event));
      });
      timer = setTimeout(() => cancel(new Error(timeoutMessage)), timeoutMs);
    });

    // A waiter may be cancelled before its caller reaches `await waiter.promise`.
    // Attach a rejection handler now while preserving the original promise for the caller.
    void promise.catch(() => {});
    if (!settled) runtime.cancelWaiters.add(cancel);
    return { promise, cancel };
  }

  private cleanupRuntime(runtime: WorkoutRuntime, reason: Error) {
    for (const cancel of [...runtime.cancelWaiters]) cancel(reason);
    runtime.cancelWaiters.clear();
    for (const cleanup of runtime.cleanup.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        runtime.session.logger.warn(`Mentra listener cleanup failed: ${String(error)}`);
      }
    }
  }

  private publicRuntime(runtime: WorkoutRuntime) {
    return {
      status: runtime.status,
      error: runtime.error,
      sessionId: runtime.workoutId,
      startedAt: runtime.startedAt,
      endedAt: runtime.endedAt,
      batteryLevel: runtime.batteryLevel,
      wifiConnected: runtime.wifiConnected,
      geometry: runtime.geometry,
      stats: runtime.stats,
      cameraAngle: cameraAngle(runtime.geometry),
    };
  }

  private async saveGeometryPreference(userId: string, geometry: GeometrySettings) {
    const profileId = pseudonymousProfileId(userId);
    const runtime = this.runtimes.get(userId);
    const writePreference = () => {
      if (runtime?.dataDeletionInProgress) {
        throw new Error('Data deletion is in progress. Wait for it to finish before saving settings.');
      }
      return this.postAzureSession({
        session_id: `preferences_${profileId}`,
        profile_id: profileId,
        status: 'preferences_updated',
        source: 'mentra_store_preferences',
        stream_id: '',
        camera_angle: cameraAngle(geometry),
        rotation_degrees: geometry.rotationDegrees,
        scene_reflected: geometry.sceneReflected,
        source_pixels_mirrored: geometry.sourcePixelsMirrored,
        updated_at: new Date().toISOString(),
      });
    };
    if (!runtime) {
      await writePreference();
      return;
    }
    const write = runtime.profileWriteChain.catch(() => {}).then(writePreference);
    runtime.profileWriteChain = write.then(
      () => undefined,
      () => undefined
    );
    await write;
  }

  private async loadGeometryPreference(userId: string) {
    const url = this.azureEndpoint('profile-preferences');
    url.searchParams.set('profile_id', pseudonymousProfileId(userId));
    const response = await this.azureFetch(url, { method: 'GET' });
    const payload = (await response.json()) as Record<string, unknown>;
    if (payload.status === 'missing' || payload.geometry == null) return undefined;
    return parseGeometry(payload.geometry, defaultGeometry());
  }

  private async postSessionStatus(runtime: WorkoutRuntime, status: WorkoutStatus, reason = '') {
    if (!runtime.workoutId || runtime.dataDeletionInProgress) return;
    const document = {
      session_id: runtime.workoutId,
      profile_id: runtime.profileId,
      status,
      reason,
      source: 'mentra_store_stream',
      stream_id: runtime.streamId,
      camera_angle: cameraAngle(runtime.geometry),
      rotation_degrees: runtime.geometry.rotationDegrees,
      scene_reflected: runtime.geometry.sceneReflected,
      source_pixels_mirrored: runtime.geometry.sourcePixelsMirrored,
      started_at: runtime.startedAt,
      ended_at: runtime.endedAt,
      updated_at: new Date().toISOString(),
    };
    const write = runtime.statusWriteChain
      .catch(() => {})
      .then(() => this.postAzureSession(document));
    runtime.statusWriteChain = write;
    await write;
  }

  private async postSessionStatusSafely(
    runtime: WorkoutRuntime,
    status: WorkoutStatus,
    reason = ''
  ) {
    try {
      await this.postSessionStatus(runtime, status, reason);
    } catch (error) {
      runtime.session.logger.warn(`Could not persist workout status: ${String(error)}`);
    }
  }

  private async postAzureSession(document: Record<string, unknown>) {
    const url = this.azureEndpoint('mentra-session');
    await this.azureFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(document),
    });
  }

  private azureEndpoint(path: string) {
    if (!azureApiBase || !azureToken) {
      throw new AzureRequestError('Azure capture API is not configured.');
    }
    try {
      const base = new URL(`${azureApiBase.replace(/\/+$/, '')}/`);
      if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Unsupported protocol.');
      return new URL(path.replace(/^\/+/, ''), base);
    } catch (error) {
      throw new AzureRequestError('AZURE_CAPTURE_API_BASE must be a valid HTTP or HTTPS URL.', {
        cause: error,
      });
    }
  }

  private async azureFetch(url: URL, init: RequestInit) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${azureToken}`);
    let lastError: AzureRequestError | undefined;

    for (const retryDelay of AZURE_RETRY_DELAYS_MS) {
      if (retryDelay) await delay(retryDelay);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AZURE_REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, { ...init, headers, signal: controller.signal });
      } catch (error) {
        lastError = new AzureRequestError('Azure capture API is unavailable.', { cause: error });
        clearTimeout(timeout);
        continue;
      }
      clearTimeout(timeout);

      if (response.ok) return response;
      await response.text().catch(() => '');
      lastError = new AzureRequestError(`Azure capture API returned HTTP ${response.status}.`);
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      if (!retryable) throw lastError;
    }

    throw lastError ?? new AzureRequestError('Azure capture API request failed.');
  }
}

const server = new JavierCoachApp();
await server.start();
