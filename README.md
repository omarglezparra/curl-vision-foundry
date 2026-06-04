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
```

Use `--calibrate` before recording data. The camera view should show your torso,
shoulders, working elbow, and wrist with steady lighting and a fixed camera.

To capture your first training dataset:

```powershell
.\.venv\Scripts\python.exe .\src\webcam_curl_counter.py --session good_form_001 --label good_form --arm right
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

The Safari app uses the iPhone front camera, guides you through labeled drills,
and creates video plus metadata downloads for each clip:

- Curl perfecto - frente
- Curl perfecto - 45 grados
- Curl perfecto - lateral
- Torso swing - frente
- Torso swing - 45 grados
- Hombro adelante - lateral
- Codo abierto - frente
- Rep parcial abajo
- Rep parcial arriba
- Reps rapidas - frente
- Tempo lento - 45 grados
- Fatiga real - lateral

### Expo Capture

The `mobile/` folder contains an Expo app for the same capture flow.

```powershell
cd mobile
npm install
npm start
```

Open the QR code with Expo Go on your iPhone. These clips are for building a
personal ergonomics and fatigue dataset before training a custom model.

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

The processor reads `captures`, downloads each `video.webm`, runs MediaPipe Pose,
applies the deterministic curl rules, and writes:

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
