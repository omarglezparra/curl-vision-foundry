import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 32_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const secret = 'a'.repeat(64);
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    PACKAGE_NAME: 'com.aijaviercoach.ml1',
    MENTRAOS_API_KEY: 'smoke-test-api-key-'.padEnd(32, 'x'),
    COOKIE_SECRET: secret,
    PROFILE_ID_SECRET: 'd'.repeat(64),
    STREAM_KEY_SECRET: 'b'.repeat(64),
    MENTRA_MINIAPP_PUBLIC_URL: 'https://miniapp.example.test',
    MENTRA_WEBSOCKET_ALLOWED_HOSTS: 'api.mentra.glass',
    MENTRA_DISABLE_UNUSED_ENDPOINTS: 'true',
    MENTRA_STREAM_BASE_URL: 'rtmps://ingest.example.test:1936/live',
    MENTRA_STREAM_AUTH_TTL_SECONDS: '14400',
    AZURE_CAPTURE_API_BASE: 'https://capture.example.test/api',
    AZURE_MINIAPP_API_TOKEN: 'c'.repeat(64),
    AZURE_RAW_CAPTURE_RETENTION_DAYS: '30',
    AZURE_DERIVED_DATA_RETENTION_DAYS: '365',
    APP_OPERATOR_NAME: 'Smoke Test Operator',
    SUPPORT_EMAIL: 'support@example.test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early.\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy.\n${output}`);
}

async function postWebhook(websocketUrl) {
  return fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'session_request',
      sessionId: 'security-smoke-session',
      userId: 'security-smoke-user',
      timestamp: new Date().toISOString(),
      websocketUrl: 'wss://api.mentra.glass/ws/miniapp',
      mentraOSWebsocketUrl: websocketUrl,
      augmentOSWebsocketUrl: websocketUrl,
    }),
  });
}

try {
  const health = await waitForServer();
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'healthy');
  assert.equal(healthBody.app, 'com.aijaviercoach.ml1');
  assert.equal(health.headers.get('x-powered-by'), null);
  assert.match(health.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(
    health.headers.get('content-security-policy') ?? '',
    /frame-ancestors 'self' https:\/\/mentra\.glass https:\/\/\*\.mentra\.glass/
  );
  assert.equal(health.headers.get('x-frame-options'), null);
  assert.match(health.headers.get('permissions-policy') ?? '', /camera=\(\)/);

  const attacker = await postWebhook('wss://attacker.example/app-ws');
  assert.equal(attacker.status, 400);
  const insecure = await postWebhook('ws://api.mentra.glass/app-ws');
  assert.equal(insecure.status, 400);
  const wrongPath = await postWebhook('wss://api.mentra.glass/not-app-ws');
  assert.equal(wrongPath.status, 400);

  for (const path of ['/tool', '/settings', '/photo-upload']) {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST' });
    assert.equal(response.status, 404, `${path} must be disabled in production`);
  }

  const session = await fetch(`${baseUrl}/api/session`);
  assert.equal(session.status, 401);
  const privacy = await fetch(`${baseUrl}/privacy`);
  assert.equal(privacy.status, 200);
  const privacyBody = await privacy.text();
  assert.match(privacyBody, /support@example\.test/);
  assert.doesNotMatch(privacyBody, /\{\{[A-Z_]+\}\}/);

  console.log('MiniApp security and HTTP smoke tests passed.');
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}
