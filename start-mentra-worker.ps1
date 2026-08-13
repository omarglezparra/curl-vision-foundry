param(
    [int]$IntervalSeconds = 60,
    [int]$FrameStride = 3,
    [switch]$Once
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $repoRoot ".env"
$pythonPath = Join-Path $repoRoot ".venv\Scripts\python.exe"
$processorPath = Join-Path $repoRoot "src\process_azure_captures.py"

function Get-DotEnvValue {
    param([string]$Name)
    if (-not (Test-Path -LiteralPath $envPath)) { return "" }
    $line = Get-Content -LiteralPath $envPath | Where-Object {
        $_ -match "^\s*$([regex]::Escape($Name))\s*="
    } | Select-Object -Last 1
    if (-not $line) { return "" }
    return (($line -split "=", 2)[1].Trim()).Trim('"').Trim("'")
}

if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw "Project virtual environment is missing. Create .venv and install requirements.txt."
}
if ($IntervalSeconds -lt 15) { throw "IntervalSeconds must be at least 15." }
if ($FrameStride -lt 1) { throw "FrameStride must be at least 1." }

$apiBase = (Get-DotEnvValue "AZURE_CAPTURE_API_BASE").TrimEnd('/')
$processorApiToken = Get-DotEnvValue "AZURE_PROCESSOR_API_TOKEN"
if (-not $apiBase -or $processorApiToken.Length -lt 32) {
    throw "AZURE_CAPTURE_API_BASE and a 32-character AZURE_PROCESSOR_API_TOKEN must be set in .env."
}
$headers = @{ Authorization = "Bearer $processorApiToken" }

Push-Location $repoRoot
try {
    while ($true) {
        try {
            $dashboard = Invoke-RestMethod `
                -Uri "$apiBase/performance?limit=1&profile_id=all" `
                -Headers $headers `
                -Method Get
            $pendingCount = [int]$dashboard.pendingCaptures
            if ($pendingCount -gt 0) {
                Write-Host "Processing $pendingCount pending Mentra capture(s)..."
                & $pythonPath $processorPath --frame-stride $FrameStride
                if ($LASTEXITCODE -ne 0) {
                    Write-Warning "Processing failed with exit code $LASTEXITCODE; saved captures will be retried."
                }
                else {
                    Write-Host "Dashboard datasets saved to Azure."
                }
            }
            else {
                Write-Host "No pending Mentra captures."
            }
        }
        catch {
            Write-Warning "Worker check failed; saved captures remain in Azure. $($_.Exception.Message)"
        }

        if ($Once) { break }
        Start-Sleep -Seconds $IntervalSeconds
    }
}
finally {
    Pop-Location
}
