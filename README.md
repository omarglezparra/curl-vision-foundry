# Curl Vision Foundry

Starter scaffold for experimenting with curl detection and training workflows.

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill in your workspace values before running
infrastructure scripts.

## Project Layout

- `src/foundry_check.py` verifies local dependencies and basic environment setup.
- `src/train_placeholder.py` is a minimal training entry point placeholder.
- `infra/compute-cpu.yml` defines a CPU training compute target.
- `infra/create-training-compute.ps1` creates or updates the compute target.

## Smoke Check

```powershell
python src/foundry_check.py
```

## Webcam Curl Prototype

Run the first local prototype with your laptop webcam:

```powershell
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py
```

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

The repo includes two mobile capture paths. The recommended fallback is the
static Safari capture app in `docs/`, because it does not require Expo Go.

### Safari Capture

Enable GitHub Pages for this repository using the `main` branch and `/docs`
folder. Then open:

```text
https://omarglezparra.github.io/curl-vision-foundry/
```

The Safari app uses the iPhone camera for live curl testing and good-form gym
capture. Open the link on iPhone, allow camera access, then tap
`Entrenar en vivo`. The page loads MediaPipe Pose in the browser, draws the
tracked body landmarks, calculates elbow angle, and counts curls with a simple
down/up/down rule. Use `Cambiar camara` if you want to aim the rear camera at a
mirror.

For dataset capture, press `Nueva sesion` at the start of a workout so every
clip shares one `session_id`, then record sets or a full-session archive. Each
capture creates video plus metadata downloads and uploads to Azure when
configured:

- Curl limpio - frente
- Curl limpio - 45 grados
- Curl limpio - lateral
- Sesion gym completa

For BV100/HeyCyan clips, use the `Importar HeyCyan` button in the Safari app.
Record with the glasses, import/sync the clip in HeyCyan, save it to iPhone
Photos, then select that video from the web app. It is uploaded as
`biceps_curl/good_form/mirror_bv100`.

### Expo Capture

The `mobile/` folder contains an Expo app for the same capture flow.

```powershell
cd mobile
npm install
npm start
```

Open the QR code with Expo Go on your iPhone. These clips are for building a
personal ergonomics and fatigue dataset before training a custom model.

### HeyCyan / BV100 iPhone Auto Import

The iPhone app can also act as a HeyCyan/BV100 import hub. iOS does not let a
Safari web page or another app silently read videos from HeyCyan in the
background. The supported automatic path is:

1. Record with the BV100 glasses.
2. In HeyCyan, import/sync the clip from the glasses and save it into iPhone
   Photos.
3. Keep Curl Vision Foundry open and tap `Auto HeyCyan`.
4. New videos in Photos are imported as `biceps_curl/good_form/mirror_bv100`.
5. Paste an Azure container SAS URL and enable `Auto upload ON` to send video
   plus metadata to the existing Azure capture pipeline.

Use `Importar recientes` for clips that were already in Photos before you
enabled auto import.

### Native HeyCyan iOS App

The native iOS scaffold lives in `ios-native/CurlVisionHeyCyan`. It is built
with SwiftUI and is meant for a Mac/Xcode workflow:

```bash
cd ios-native/CurlVisionHeyCyan
xcodegen generate
open CurlVisionHeyCyan.xcodeproj
```

It scans/connects over BLE, probes possible live-stream endpoints, downloads
videos from the glasses WiFi transfer endpoint, and uploads video plus metadata
to Azure. Start/stop camera commands need the HeyCyan/QCSDK framework or known
BV100 BLE command bytes because those commands are proprietary.

TestFlight automation is prepared with Fastlane and GitHub Actions in
`ios-native/CurlVisionHeyCyan`. See `TESTFLIGHT.md` in that folder.

### Native HeyCyan Android App

The native Android app lives in `android-native/CurlVisionHeyCyan`. It now opens
as a simple gym flow: connect the Blackview/HeyCyan glasses, start the workout,
import the glasses video, and upload it to the model. Advanced BLE command,
WiFi transfer, and diagnostic tools stay hidden behind `Opciones avanzadas`.

```powershell
cd android-native/CurlVisionHeyCyan
gradle :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.curlvision.heycyan/.MainActivity
```

Use the emulator for UI preview only. Real BV100/HeyCyan BLE and glasses WiFi
testing require a physical Android phone because Android Emulator does not
expose the PC Bluetooth radio as the phone's BLE hardware.

For emulator testing with glasses paired to Windows, run the PC Bluetooth bridge
and use `Conectar usando la PC` in the Android app:

```powershell
.\.venv\Scripts\python.exe .\src\windows_bv100_bridge.py
```

The bridge exposes Windows BLE status at `http://127.0.0.1:8765`; Android
Emulator reaches that same host as `http://10.0.2.2:8765`.

## Azure Capture Pipeline

The `azure/` folder contains a starter cloud pipeline:

- `azure/infra/main.bicep` provisions Blob Storage and an Azure Function App.
- `azure/functions/function_app.py` exposes:
  - `POST /api/create-upload` to create temporary upload URLs.
  - `POST /api/register-capture` to register uploaded video and metadata.
- Blob containers:
  - `captures` stores uploaded videos and metadata.
  - `processed` stores capture manifests and future processed datasets.

### Option A: Azure Function Upload API

Deploy infrastructure:

```powershell
.\azure\deploy.ps1 -ResourceGroup rg-curl-vision-trainer -Location eastus
```

Then deploy the Function App code:

```powershell
cd azure/functions
func azure functionapp publish <function-app-name>
```

After deployment, copy `docs/config.example.js` to `docs/config.js` and set:

```javascript
window.CURL_VISION_API_BASE = "https://<function-app-name>.azurewebsites.net/api";
```

Commit and push `docs/config.js`. The Safari capture app will then upload video
and metadata to Azure automatically after each recording, while still offering
local downloads as a fallback.

### Option B: Blob Storage Prototype

If Azure Functions is blocked by subscription quota, create only Blob Storage
and a temporary upload SAS:

```powershell
.\azure\create-storage-pipeline.ps1 -ResourceGroup rg-curl-vision-trainer -Location eastus
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
`metadata.json`, runs MediaPipe Pose, applies the deterministic curl rules, and
writes:

- `outputs/cloud_dataset/cloud_capture_summary.csv`
- `outputs/cloud_dataset/cloud_curl_dataset.csv`

It also uploads both CSV files to Azure Blob:

```text
processed/datasets/cloud_capture_summary.csv
processed/datasets/cloud_curl_dataset.csv
```

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
