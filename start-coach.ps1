$ErrorActionPreference = "Stop"

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "The Python environment is missing. Run: python -m venv .venv; .\.venv\Scripts\python.exe -m pip install -r requirements.txt"
}

$utilityMode = $args -contains "--calibrate" -or $args -contains "--list-cameras"
$coachArgs = [System.Collections.Generic.List[string]]::new()
if (-not $utilityMode -and -not ($args -contains "--record-session")) {
    $coachArgs.Add("--record-session")
}
if (-not $utilityMode -and -not ($args -contains "--upload-azure") -and -not ($args -contains "--no-upload-azure")) {
    $coachArgs.Add("--upload-azure")
}

& $python (Join-Path $PSScriptRoot "src\foundry_check.py")
if ($LASTEXITCODE -ne 0) {
    throw "The local environment check failed."
}

& $python (Join-Path $PSScriptRoot "src\webcam_curl_counter.py") @coachArgs @args
exit $LASTEXITCODE
