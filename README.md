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

The `mobile/` folder contains a simple Expo app for collecting labeled workout
clips with the iPhone front camera.

```powershell
cd mobile
npm install
npm start
```

Open the QR code with Expo Go on your iPhone. The app guides you through:

- Curl perfecto
- Curl ladeado
- Hombro adelante
- Rep parcial
- Fatiga real

Each drill uses the front camera and saves labeled clips to the iPhone Photos
album `Curl Vision Foundry`. These clips are for building a personal ergonomics
and fatigue dataset before training a custom model.
