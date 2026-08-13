param()

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot
$statusDirectory = Join-Path $repoRoot ".azure-validation"
$statusPath = Join-Path $statusDirectory "container-tools-status.json"

function Write-InstallStatus {
    param(
        [string]$Status,
        [bool]$RebootRequired,
        [string]$Message
    )
    if (-not (Test-Path -LiteralPath $statusDirectory)) {
        New-Item -ItemType Directory -Path $statusDirectory | Out-Null
    }
    $document = [ordered]@{
        status = $Status
        rebootRequired = $RebootRequired
        message = $Message
        updatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    }
    [System.IO.File]::WriteAllText(
        $statusPath,
        ($document | ConvertTo-Json),
        [System.Text.UTF8Encoding]::new($false)
    )
}

$isAdministrator = (
    [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdministrator) {
    throw "Run this script from an elevated PowerShell window."
}

$rebootRequired = $false
try {
    foreach ($feature in @("Microsoft-Windows-Subsystem-Linux", "VirtualMachinePlatform")) {
        & dism.exe /Online /Enable-Feature /FeatureName:$feature /All /NoRestart
        if ($LASTEXITCODE -notin @(0, 3010)) {
            throw "Windows feature $feature failed with exit code $LASTEXITCODE."
        }
        if ($LASTEXITCODE -eq 3010) { $rebootRequired = $true }
    }

    $dockerListing = & winget.exe list `
        --id Docker.DockerDesktop `
        --exact `
        --accept-source-agreements 2>&1
    if ($LASTEXITCODE -ne 0 -or ($dockerListing -join "`n") -match "No installed package") {
        & winget.exe install `
            --id Docker.DockerDesktop `
            --exact `
            --source winget `
            --accept-package-agreements `
            --accept-source-agreements `
            --silent `
            --disable-interactivity
        if ($LASTEXITCODE -ne 0) {
            throw "Docker Desktop installation failed with exit code $LASTEXITCODE."
        }
    }

    $message = if ($rebootRequired) {
        "WSL features and Docker Desktop are installed. Restart Windows before validation."
    }
    else {
        "WSL features and Docker Desktop are installed. Open Docker Desktop and validate the WSL 2 engine."
    }
    Write-InstallStatus -Status "installed" -RebootRequired $rebootRequired -Message $message
    Write-Host $message
}
catch {
    Write-InstallStatus -Status "failed" -RebootRequired $rebootRequired -Message $_.Exception.Message
    throw
}
