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
