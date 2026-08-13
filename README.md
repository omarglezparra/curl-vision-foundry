# AI Javier Coach + Curl Vision Foundry

Combined AI coaching project with curl detection, adaptive workout coaching,
mobile capture, Azure ingestion, and training workflows.

## Setup

The recommended product flow is now the Javier AI Coach web app on an iPhone.
It opens from a secure web link, uses the iPhone camera in real time, counts curls
with on-device pose detection, and records clips under one workout session. The
legacy glasses integrations remain in the repository for reference only:

- `docs/` is the active iPhone web app and PWA.
- `mobile/`, `mentra-miniapp/`, and `mentra-ingest/` are legacy glasses paths and
  are not required to record with Javier AI.

The Store MiniApp requires a `MENTRAOS_API_KEY` from the Mentra developer
console. The direct-Bluetooth companion does not. Keep secrets in `.env` or the
phone keychain; never put them in `EXPO_PUBLIC_*` variables.

### Current Store-readiness status

As of August 1, 2026, the Azure Function API, trusted RTMPS ingest VM, public
MiniApp, registry, and scheduled processor are deployed. Production health,
legal pages, webview framing policy, authorization boundaries, Function health,
RTMPS TLS, a synthetic RTMPS-to-dashboard round trip, profile deletion, and
consecutive processor executions have been verified. The prepared Store assets
and local configuration are ready.

Infrastructure deployment is not Store acceptance. The live Mentra app record
still needs its production URLs, Standard app type, Camera reason, required
Camera/Wi-Fi hardware, 512x512 logo, and previews corrected. The configured API
key does not match the live app's stored key hash and must be regenerated or
copied for `com.aijaviercoach.ml1`, synchronized, and redeployed. A physical
Mentra Live end-to-end and signed-in deletion test must pass before review. See
[Production deployment status and remaining release gates](#production-deployment-status-and-remaining-release-gates).

The repository also lacks a committed source baseline. Establish and review a
secret-free commit and release tag before public submission so the deployed
version is reproducible and recoverable.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill in your workspace values before running
infrastructure scripts.

### Windows workstation status

This Windows PC currently has Python 3.11, Node.js/npm, Git, Azure CLI with
Bicep, Azure Functions Core Tools 4.12.1, FFmpeg 8.1.2, and VS Code available.
The current-user PowerShell execution policy is `RemoteSigned`.

The required Windows restart was completed. WSL 2, Virtual Machine Platform,
and Docker Desktop 4.84.0 are installed, and the production container paths
were built and health-checked locally. Docker Desktop may be stopped when not
needed; start it before repeating local Compose validation.

Generate and synchronize the three route-scoped Azure credentials, cookie,
stable profile-ID, and stream-signing secrets across the ignored app environment
files:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-mentra-env.ps1
```

The command never prints secret values. Run it again after Azure deployment or
after changing the API/stream URLs. Use `-ForceNewSecrets` only when
intentionally rotating the route, cookie, and stream credentials; the stable
profile-ID secret is deliberately preserved so existing users keep access to
their own history and deletion namespace.

Azure settings are optional for the local webcam coach. They are only required
for cloud uploads, dataset processing, and Foundry integration. The commands in
the next section create billable cloud resources; do not run them until the
operator explicitly approves deployment and its budget.

### Azure + Foundry setup

Sign in, copy your project endpoint from the Microsoft Foundry project home
page, and deploy the current Azure Function and private-storage layer:

```powershell
az login
.\azure\deploy.ps1 -ConfirmAzureSpend -FoundryProjectEndpoint "https://<foundry-account>.services.ai.azure.com/api/projects/<project>"
.\.venv\Scripts\python.exe .\src\foundry_check.py --azure
```

The deployment validates and previews the Bicep changes before applying them.
Before creating resources, it creates the configured resource-group Cost
Management budget (currently US$40/month) with actual-spend alerts at 50%, 80%,
and 100%. Production also has a subscription-wide budget with the same amount,
thresholds, and monitored recipient so the separately managed Application
Insights workspace is covered. That workspace also has a `0.05 GB/day` ingestion
safety cap; recent usage was about `0.000146 GB/day`. Reaching the cap pauses
billable log collection until its daily reset, so treat it as spike protection,
not routine filtering. Azure budgets notify but do not stop resources or
guarantee a hard spending cap.
The Linux Consumption plan also requires an App Service/Function regional quota;
new subscriptions may report `Total VMs: 0` during validation. Request at least
one Dynamic/Y1 (or Flex Consumption) App Service VM quota for the selected Azure
region before rerunning deployment.
It creates private `captures` and `processed` Blob containers, deploys the
Function App, grants the signed-in user passwordless Blob access, saves the
resource names in `.env`, and links the Foundry project to the capture container
through managed identity. No storage account key or SAS is saved in `.env`.

If the Azure resources already exist and only the Foundry link is missing:

```powershell
.\azure\connect-foundry-storage.ps1 -FoundryProjectEndpoint "https://<foundry-account>.services.ai.azure.com/api/projects/<project>"
```

## Project Layout

- `src/foundry_check.py` verifies local dependencies and basic environment setup.
- `src/video_geometry.py` normalizes recorded rotation and mirror reflection.
- `src/process_azure_captures.py` creates curl metrics from uploaded videos.
- `mobile/` contains the direct Mentra Live Bluetooth companion and dashboard.
- `mentra-miniapp/` contains the Mentra Store server and authenticated webview.
- `mentra-ingest/` records authenticated Store RTMP streams into Azure segments.
- `azure/functions/function_app.py` receives Mentra recordings and serves metrics.
- `src/train_curl_quality.py` trains and gates the deployed curl-form classifier.
- `docs/curl-quality-model.md` documents its dataset, evaluation, runtime behavior, and limitations.
- `src/train_placeholder.py` remains as the original Foundry workflow placeholder.
- `infra/compute-cpu.yml` defines a CPU training compute target.
- `infra/create-training-compute.ps1` creates or updates the compute target.

## Mentra Live App

### Direct Bluetooth companion

The direct path is the usable set-recording MVP. Use Mentra Bluetooth SDK
`0.1.20` with matching Mentra Live glasses software, and make a native
development build; Expo Go cannot load this native SDK.

```powershell
cd mobile
npm.cmd ci
npx.cmd expo run:android
```

For iOS, run `npx expo run:ios` on a Mac or create an EAS development build.
Open **Mentra Live (ml1)** in the app, connect the glasses, and enter the deployed
Azure API base, `AZURE_INGEST_API_TOKEN` for uploads, and
`AZURE_MINIAPP_API_TOKEN` for its private owner dashboard. Both credentials are
stored with `expo-secure-store`. A tap in the app or a long press on the glasses
records a set. Sets stop automatically before three minutes and upload as
multipart MP4.

### Mentra Store MiniApp

The Store version lives in `mentra-miniapp/` and uses `@mentra/sdk` `2.1.29`.
Mentra Live has no display, so workout controls and the dashboard appear in the
Mentra phone app webview.

```powershell
cd mentra-miniapp
Copy-Item .env.example .env
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run dev
```

Configure these values in the MiniApp host:

- `PACKAGE_NAME=com.aijaviercoach.ml1` (the Store package name is immutable).
- `MENTRAOS_API_KEY`, `COOKIE_SECRET`, and `STREAM_KEY_SECRET` as secrets.
- `MENTRA_STREAM_BASE_URL` as a private RTMP ingest base that records segments.
- `AZURE_CAPTURE_API_BASE` and the route-scoped `AZURE_MINIAPP_API_TOKEN`.
- `MENTRA_WEBSOCKET_ALLOWED_HOSTS=api.mentra.glass`, the exact production
  Mentra WebSocket DNS hostname. Schemes, paths, wildcards, and parent-domain
  suffixes are not accepted.
- `MENTRA_MINIAPP_PUBLIC_URL`, `APP_OPERATOR_NAME`, and `SUPPORT_EMAIL` as the
  public HTTPS URL and the real organization identity shown to users.

The pinned SDK is installed with a `patch-package` security patch documented in
[`mentra-miniapp/SECURITY.md`](mentra-miniapp/SECURITY.md). It prevents the
session webhook from sending the API key to arbitrary request-supplied sockets:
production accepts only `wss://` URLs on an exact configured hostname, expected
Mentra path, and default/443 port, with no URL credentials, query, or fragment.
It also validates freshness and shape, rate-limits the webhook, removes secret
logging, uses secure production cookies, and disables unused SDK endpoints.
Production refuses to start without the exact host allowlist. This containment
does not cryptographically prove who sent an otherwise valid webhook, so confirm
the production hostname(s) with Mentra and track upstream signed-webhook support
before public release.

Deploy the included Dockerfile behind public HTTPS. In the Mentra developer
console, set the app URL, webview URL (`/webview`), camera permission, compatible
hardware, logo, contact details, and privacy information. The SDK exposes the
public `/health` endpoint used for hosting checks. The server refuses recording
without Wi-Fi or below 15% battery and caps a stream at three hours.

Store-ready material is kept with the MiniApp:

- 512x512 icon: [`public/assets/app-icon.png`](mentra-miniapp/public/assets/app-icon.png)
- Portrait previews: [`workout.png`](mentra-miniapp/store/previews/workout.png)
  and [`performance.png`](mentra-miniapp/store/previews/performance.png)
- Public templates served at `/privacy`, `/terms`, `/support`, and
  `/data-deletion`
- Submission fields, reviewer instructions, and console-only declarations in
  [`store/SUBMISSION.md`](mentra-miniapp/store/SUBMISSION.md)
- Importable config generator:
  [`store/generate-app-config.ps1`](mentra-miniapp/store/generate-app-config.ps1)

The signed-in webview provides **Eliminar mis datos**. After explicit
`DELETE_MY_DATA` confirmation and only when no workout is active, it calls the
protected Azure `DELETE /api/profile-data?profile_id=mp_<24hex>` endpoint with
`AZURE_MINIAPP_API_TOKEN`. Azure removes that profile's capture blobs, manifests,
session-status records, and rows in both aggregate CSV datasets. Storage
lifecycle defaults separately make raw capture blobs eligible for deletion 30
days after their last modification. The scheduled processor removes individual
derived rows after 365 days, with lifecycle deletion as an inactive-file
backstop. Both windows are controlled by `AZURE_RAW_CAPTURE_RETENTION_DAYS` and
`AZURE_DERIVED_DATA_RETENTION_DAYS`.

The included `mentra-ingest/` service implements `MENTRA_STREAM_BASE_URL` with
MediaMTX. It verifies the MiniApp's one-session HMAC stream path, denies readers,
records two-minute fMP4 segments, POSTs each completed segment to
`/api/mentra-video`, and keeps failed uploads on a persistent volume for retry:

```powershell
cd mentra-ingest
Copy-Item .env.example .env
docker compose -f compose.yml up --build
```

Plain `rtmp://` is only for private-network development. Production must use
`compose.production.yml`, a dedicated public DNS name, a publicly trusted
full-chain certificate and matching unencrypted private key, persistent
recording storage, and strict `rtmps://<domain>:1936/live`. Open inbound TCP 1936
only; do not expose plaintext 1935 or a playback/read endpoint. The MiniApp and
ingest service must share `STREAM_KEY_SECRET` and compatible 300-14400 second
stream-credential TTL settings. See [`mentra-ingest/README.md`](mentra-ingest/README.md).
The direct-Bluetooth companion does not need this service because the glasses
upload the stopped set directly to Azure.

### Production deployment status and remaining release gates

1. Completed: public operator/support values, exact WebSocket host, Azure budget,
   production HTTPS/RTMPS DNS, Azure API, MiniApp, ingest, and processor.
2. Correct the app-bound Mentra API key and redeploy the MiniApp.
3. Correct and verify the live Developer Console metadata and upload both previews.
4. Use Share App for a real Mentra Live start/stop/upload/process/dashboard test.
5. Verify signed-in deletion and adverse Wi-Fi, battery, and reconnect behavior.
6. Establish a reviewed, secret-free Git baseline, then submit for Mentra review.

The MiniApp keeps one minimum-size `0.25` vCPU / `0.5Gi` replica warm. A real
scale-to-zero test took about 35 seconds to wake, which is too risky for Mentra's
session webhook. The smaller warm allocation reduces idle cost while preserving
sub-second warm health responses. Azure's US$40 monthly budgets are alerts
rather than hard caps.

Use this sequence for redeployment or disaster recovery. Every resource-creation
script refuses to run without `-ConfirmAzureSpend`:

```powershell
# 1. Private Storage + Function API + budget alerts
.\azure\deploy.ps1 -ConfirmAzureSpend

# 2. Public RTMPS ingest VM; replace the example with the operator's exact CIDR.
# This subscription currently uses B1ms in East US availability zone 3.
.\azure\deploy-mentra-ingest.ps1 -ConfirmAzureSpend -AdminSourceCidr "203.0.113.10/32" -Location eastus -VmSize Standard_B1ms -AvailabilityZone 3

# 3. Copy the generated RTMPS URL into the app-specific ignored environments
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-mentra-env.ps1

# 4. Public HTTPS MiniApp and its managed-identity container foundation
.\azure\deploy-mentra-miniapp.ps1 -ConfirmAzureSpend

# 5. Scheduled processing job (starts one initial execution unless skipped)
.\azure\deploy-processor.ps1 -ConfirmAzureSpend

# 6. Subscription-wide alert coverage, including the managed telemetry workspace
.\azure\create-budget.ps1 -Scope Subscription -BudgetName ai-javier-coach-subscription-monthly -AmountUsd 40
```

The scripts validate and preview the Bicep changes before applying them, use
remote container builds, and save only resource names/URLs plus locally generated
secrets in the ignored root `.env`.

Official references: [Mentra Live camera streaming](https://docs.mentraglass.com/mentra-live/camera-streaming),
[MiniApp lifecycle](https://docs.mentraglass.com/app-devs/core-concepts/app-lifecycle-overview),
and [webviews](https://docs.mentraglass.com/app-devs/core-concepts/webviews/react-webviews).

### Mirror and camera rotation

Use these three independent settings; changing the preview is not the same as
changing recorded pixels:

- `scene_reflected=true` when the glasses point at your physical mirror.
- `source_pixels_mirrored=true` only when the saved video file is already
  horizontally flipped. This is normally `false` for Mentra Live.
- `rotation_degrees` is the clockwise rotation needed to make the saved frame
  upright: `0`, `90`, `180`, or `270`.

The cloud processor rotates first, then flips horizontally only when exactly one
of the physical scene and encoded pixels is mirrored. This prevents a mirror
workout from being flipped twice and keeps left/right landmark selection
deterministic.

Record only where gym policy permits it. Mentra Live's camera light remains on
while recording; avoid bystanders and obtain consent where required.

## Smoke Check

Run the Python unit suites with the standard-library test runner (pytest is not
required by this repository):

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m unittest discover -s mentra-ingest\tests -v
```

Run the end-to-end local capture smoke test with:

```powershell
.\.venv\Scripts\python.exe .\tests\smoke_capture.py
```

```powershell
python src/foundry_check.py
```

To additionally validate the Azure client configuration after filling in
`.env`, run:

```powershell
python src/foundry_check.py --azure
```

Run the lightweight AI Javier Coach starter flow with:

```powershell
python run.py
```

## Webcam Curl Prototype

Run the first local prototype with your laptop webcam:

```powershell
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py
```

For the normal record-and-upload workflow, use:

```powershell
.\start-coach.ps1
```

Press `q` to finish the workout. The command saves after every recording:

- `video.mp4` with the complete session
- `metadata.json` with session, device, exercise, rep, and upload fields
- `reps.csv` with only that session's curl attempts and coach metrics
- a Blob manifest under `processed/manifests/`

The default label is `unlabeled`. For a deliberately supervised good-form set,
use `--label good_form --log-good-only`; only then is the recording marked for
training:

```powershell
.\start-coach.ps1 --label good_form --log-good-only
```

Any exercise can be archived by changing `--exercise`, but automatic rep/form
metrics currently apply only to `biceps_curl`. Other exercises are retained as
video, metadata, and pose-detection summaries instead of being mislabeled as
curls.

The prototype detects your pose with MediaPipe, draws the tracked shoulder,
elbow, and wrist, calculates elbow angle, and counts curls.

The first version uses deterministic curl rules before custom ML:

- Rep starts when elbow angle is near extended: 150-170 degrees.
- Rep peaks when elbow angle is flexed: 40-70 degrees.
- Full rep requires at least 80 degrees of range of motion.
- Bad form is flagged when shoulder movement, torso swing, or wrist path
  inconsistency crosses the rule thresholds in `src/curl_rules.py`.

Useful options:

```powershell
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --calibrate
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --arm right
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --camera 1
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --source 1
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --source .\captures\bv100_mirror.mp4 --no-flip
```

Use `--calibrate` before recording data. The camera view should show your torso,
shoulders, working elbow, and wrist with steady lighting and a fixed camera.

### BV100 / External Camera Capture

For Blackview BV100 glasses or any external camera, first check whether OpenCV
can see the device as a live camera:

```powershell
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --list-cameras
```

If the glasses, phone bridge, or virtual camera appears as an index, run a
mirror calibration with that index:

```powershell
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --source 1 --calibrate --arm auto --camera-angle mirror_bv100
```

Then capture good-form mirror reps for training:

```powershell
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --source 1 --session bv100_mirror_good_001 --label good_form --arm auto --record-session --log-good-only --camera-angle mirror_bv100
```

If the BV100 app only exports recorded clips, process the exported video file
directly. Use `--no-flip` when the recorded clip already has the orientation you
want to analyze:

```powershell
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --source "C:\path\to\bv100_mirror.mp4" --session bv100_clip_good_001 --label good_form --arm auto --log-good-only --camera-angle mirror_bv100 --no-flip
```

To remove the manual PC transfer step, point the phone/app at a cloud-synced or
download folder and let the auto ingestor watch it. The script processes every
new video with the same BV100 curl pipeline:

```powershell
.\.venv\Scripts\python.exe .\src\auto_bv100_ingest.py --watch-dir "$env:USERPROFILE\OneDrive\Pictures\Álbum de cámara"
```

For a dedicated folder:

```powershell
mkdir .\captures\bv100_inbox
.\.venv\Scripts\python.exe .\src\auto_bv100_ingest.py --watch-dir .\captures\bv100_inbox
```

Use `--process-existing --once` if you want to process videos already in that
folder and then exit.

To capture your first training dataset:

```powershell
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --session good_form_001 --label good_form --arm right
```

To record a full local webcam gym session and keep only reps scored as good form
in the CSV:

```powershell
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --session gym_good_001 --label good_form --arm right --record-session --log-good-only --camera-angle front
```

This writes clean rep metrics to `outputs/curl_reps.csv` and saves the session
video plus metadata under:

```text
outputs/session_videos/good_form/<camera_angle>/<session_id>/<capture_id>/
```

To use the live voice coach with headphones:

```powershell
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --session live_coach_left_001 --label workout --arm left --voice-coach
```

Each completed curl attempt is appended to `outputs/curl_reps.csv` with rep
metrics such as range of motion, duration, speed, shoulder shift, torso shift,
wrist path consistency, form warnings, label, effort score, fatigue level,
failure risk, and coach recommendation.

Press `q` to quit and `r` to reset the rep counter.

## Adaptive Coach

Generate a personal baseline and coach report from captured reps:

```powershell
.\.venv\Scripts\python.exe .\src\coach_engine.py --session fatigue_left_002
```

The coach compares the current set against your own baseline and writes:

- `outputs/user_profile.json`
- `outputs/coach_report_<session>.json`

The report includes effort score, fatigue level, failure risk, estimated reps in
reserve, and recommended reps remaining.

## iPhone Capture App

The active capture path is the static Safari/PWA app in `docs/`. It does not
require Expo Go, a native build, or any glasses account.

### Safari Capture

Enable GitHub Pages for this repository using the `main` branch and `/docs`
folder. Then open this link on the iPhone in Safari:

```text
https://omarglezparra.github.io/curl-vision-foundry/
```

The app requests the iPhone camera only after you tap `Activar cámara`. Press
`Nueva sesion` at the start of a workout so every clip shares one `session_id`,
then record sets or a full-session archive. `Entrenamiento en vivo` runs pose
feedback in the browser while the camera preview remains active. Each capture
creates a video plus metadata download and uploads to Azure when configured:

The interface is camera-first: the controls float over the live preview. `Voz
ON` enables Spanish speech feedback for reps completed, reps remaining to the
estimated failure target, form reminders, and short motivation. The coaching
reference list is in [`docs/curl-coaching-sources.md`](docs/curl-coaching-sources.md).

- Curl limpio - frente
- Curl limpio - 45 grados
- Curl limpio - lateral
- Sesion gym completa

To install it like an app, open the link in Safari, tap Share, choose `Añadir a
pantalla de inicio`, and launch `Javier AI` from the new icon. Camera access
requires HTTPS; GitHub Pages provides that automatically. If the camera does
not open, check iPhone Settings > Safari > Camera and choose Allow.

The old native and glasses capture folders are retained as historical code. They
are not part of the Javier AI iPhone web workflow above.

It scans/connects over BLE, probes possible live-stream endpoints, downloads
videos from the glasses WiFi transfer endpoint, and uploads video plus metadata
to Azure. Start/stop camera commands need the HeyCyan/QCSDK framework or known
BV100 BLE command bytes because those commands are proprietary.

TestFlight automation is prepared with Fastlane and GitHub Actions in
`ios-native/CurlVisionHeyCyan`. See `TESTFLIGHT.md` in that folder.

## Azure Capture Pipeline

The `azure/` folder contains a starter cloud pipeline:

- `azure/infra/main.bicep` provisions Blob Storage and an Azure Function App.
- `azure/functions/function_app.py` exposes:
  - `POST /api/create-upload` to create temporary upload URLs.
  - `POST /api/register-capture` to register uploaded video and metadata.
  - `POST /api/mentra-video` to receive a Mentra multipart MP4.
  - `POST /api/mentra-session` to save Store stream lifecycle and geometry.
  - `GET /api/performance` to return dashboard-ready session metrics.
  - `DELETE /api/profile-data?profile_id=mp_<24hex>` to delete one authenticated
    MiniApp profile's raw captures and derived records.
- Blob containers:
  - `captures` stores uploaded videos and metadata.
  - `processed` stores capture manifests and future processed datasets.

The infrastructure defaults make `captures` blobs eligible for lifecycle
deletion 30 days after last modification. The processor prunes individual
derived rows after 365 days; the `processed` blob lifecycle is an additional
backstop for files that stop being updated. Override those windows with
`AZURE_RAW_CAPTURE_RETENTION_DAYS` and `AZURE_DERIVED_DATA_RETENTION_DAYS`
before deployment when the public policy requires different values.

### Option A: Azure Function Upload API

Deploy infrastructure:

```powershell
.\azure\deploy.ps1 -ConfirmAzureSpend -ResourceGroup rg-curl-vision-trainer -Location eastus
```

The deployment script also publishes the Function App code. Azure Functions
Core Tools are optional; the script falls back to a remote zip build.

After deployment, copy `docs/config.example.js` to `docs/config.js` and set:

```javascript
window.CURL_VISION_API_BASE = "https://<function-app-name>.azurewebsites.net/api";
```

The legacy upload routes remain Function-key protected. Mentra routes are
anonymous at the Functions host layer but use constant-time checked, independent
Bearer credentials: `AZURE_MINIAPP_API_TOKEN` for profile status, preferences,
dashboard, and deletion; `AZURE_INGEST_API_TOKEN` for video ingestion; and
`AZURE_PROCESSOR_API_TOKEN` for the all-profile processor query. The deploy
script creates each credential once, saves it only in the ignored root `.env`,
and configures the Function App. Do not commit them or place them in
`docs/config.js`. The desktop recorder uses passwordless Blob access; for the
static Safari prototype, use a short-lived container SAS entered at runtime
until user authentication is added.

### Option B: Blob Storage Prototype

If Azure Functions is blocked by subscription quota, create only Blob Storage
and a temporary upload SAS:

```powershell
.\azure\create-storage-pipeline.ps1 -ConfirmAzureSpend -ResourceGroup rg-curl-vision-trainer -Location eastus
```

Open the Safari capture app, paste the printed SAS URL into `Azure Blob SAS`,
and tap `Guardar Azure`. Each new recording uploads:

- `video.webm`
- `metadata.json`

The blobs are stored under:

```text
captures/<label>/<camera_angle>/<session_id>/<capture_id>/
```

This gives us cloud capture immediately. The later processing step can read
these metadata files, extract pose landmarks, and feed Azure ML or Foundry
training jobs.

## Cloud Dataset Processing

Process uploaded iPhone captures into local CSV datasets:

```powershell
.\.venv\Scripts\python.exe .\src\process_azure_captures.py --frame-stride 3
```

The processor reads `captures`, downloads each video referenced by
`metadata.json`, normalizes mirror/rotation metadata, runs MediaPipe Pose,
applies the deterministic curl rules, and writes:

- `outputs/cloud_dataset/cloud_capture_summary.csv`
- `outputs/cloud_dataset/cloud_curl_dataset.csv`

It also uploads both CSV files to Azure Blob:

```text
processed/datasets/cloud_capture_summary.csv
processed/datasets/cloud_curl_dataset.csv
```

New Mentra uploads appear in the dashboard as pending until this processor is
run. After the CSV files upload, refresh either dashboard to see sessions, reps,
good-form percentage, average range of motion, speed, and warnings. For local
development, processing remains explicit unless the protected worker is left
running on a signed-in machine:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-mentra-worker.ps1
```

The worker saves refreshed datasets after every successful action. The public
Store deployment uses the scheduled Container Apps job in
`azure/infra/processor-job.bicep`; deploy it only after the base API and MiniApp
foundation exist and spending is approved:

```powershell
.\azure\deploy-processor.ps1 -ConfirmAzureSpend
```

It runs every 15 minutes by default and can be changed with `-ScheduleCron`.
A renewable Blob lease makes overlapping schedules exit cleanly instead of
duplicating pose-processing compute. Scheduled runs merge only captures not
already present in the uploaded summary, and row-level pruning enforces
`AZURE_DERIVED_DATA_RETENTION_DAYS` even though both datasets are shared CSV
blobs. The laptop process remains a local fallback, not an always-available
production worker.

Use a smaller test run with:

```powershell
.\.venv\Scripts\python.exe .\src\process_azure_captures.py --limit 1 --frame-stride 3 --no-upload-results
```

By default the processor only turns `exercise=biceps_curl` captures into the
curl dataset. Full gym session archives stay stored for future models unless
you explicitly process everything:

```powershell
.\.venv\Scripts\python.exe .\src\process_azure_captures.py --exercise-filter all --frame-stride 3
```
