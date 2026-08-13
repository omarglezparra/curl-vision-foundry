param(
    [switch]$ForceNewSecrets
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootEnvPath = Join-Path $repoRoot ".env"
$miniAppEnvPath = Join-Path $repoRoot "mentra-miniapp\.env"
$ingestEnvPath = Join-Path $repoRoot "mentra-ingest\.env"
$mobileEnvPath = Join-Path $repoRoot "mobile\.env"

function Get-DotEnvValue {
    param([string]$Path, [string]$Name)
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    $line = Get-Content -LiteralPath $Path | Where-Object {
        $_ -match "^\s*$([regex]::Escape($Name))\s*="
    } | Select-Object -Last 1
    if (-not $line) { return "" }
    return (($line -split "=", 2)[1].Trim()).Trim('"').Trim("'")
}

function Set-DotEnvValue {
    param([string]$Path, [string]$Name, [string]$Value)
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent | Out-Null
    }
    $escaped = $Value.Replace("\", "\\").Replace('"', '\"')
    $newLine = "$Name=`"$escaped`""
    $lines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path -LiteralPath $Path) {
        foreach ($existingLine in Get-Content -LiteralPath $Path) {
            $lines.Add([string]$existingLine)
        }
    }
    $updated = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match "^\s*$([regex]::Escape($Name))\s*=") {
            $lines[$index] = $newLine
            $updated = $true
            break
        }
    }
    if (-not $updated) { $lines.Add($newLine) }
    [System.IO.File]::WriteAllLines($Path, $lines, [System.Text.UTF8Encoding]::new($false))
}

function Remove-DotEnvValue {
    param([string]$Path, [string]$Name)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $lines = Get-Content -LiteralPath $Path | Where-Object {
        $_ -notmatch "^\s*$([regex]::Escape($Name))\s*="
    }
    [System.IO.File]::WriteAllLines($Path, $lines, [System.Text.UTF8Encoding]::new($false))
}

function New-RandomSecret {
    $bytes = [byte[]]::new(32)
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) }
    finally { $generator.Dispose() }
    return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Test-ConfiguredValue {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    return $Value -notmatch '(?i)(replace[-_ ]|your[-_ ]|example|<[^>]+>)'
}

function Get-ExternalSetting {
    param([string]$Name)
    $value = Get-DotEnvValue $rootEnvPath $Name
    if (-not (Test-ConfiguredValue $value)) {
        Set-DotEnvValue $rootEnvPath $Name ""
        return ""
    }
    return $value
}

function Get-OrCreateSecret {
    param([string]$Name)
    $value = if ($ForceNewSecrets) { "" } else { Get-DotEnvValue $rootEnvPath $Name }
    if ($value -notmatch '^[A-Fa-f0-9]{64}$') {
        $value = New-RandomSecret
        Set-DotEnvValue $rootEnvPath $Name $value
    }
    return $value
}

function Get-OrCreateStableProfileSecret {
    param([string[]]$MigrationCandidates)
    $value = Get-DotEnvValue $rootEnvPath "MENTRA_PROFILE_ID_SECRET"
    if ($value -match '^[A-Fa-f0-9]{64}$') { return $value }
    foreach ($candidate in $MigrationCandidates) {
        if ($candidate -match '^[A-Fa-f0-9]{64}$') {
            Set-DotEnvValue $rootEnvPath "MENTRA_PROFILE_ID_SECRET" $candidate
            return $candidate
        }
    }
    $value = New-RandomSecret
    Set-DotEnvValue $rootEnvPath "MENTRA_PROFILE_ID_SECRET" $value
    return $value
}

function Get-RetentionDays {
    param([string]$Name, [int]$DefaultValue)
    $rawValue = Get-DotEnvValue $rootEnvPath $Name
    $parsedValue = 0
    if (-not [int]::TryParse($rawValue, [ref]$parsedValue) -or $parsedValue -lt 1 -or $parsedValue -gt 3650) {
        $parsedValue = $DefaultValue
        Set-DotEnvValue $rootEnvPath $Name ([string]$parsedValue)
    }
    return [string]$parsedValue
}

if (-not (Test-Path -LiteralPath $rootEnvPath)) {
    Copy-Item -LiteralPath (Join-Path $repoRoot ".env.example") -Destination $rootEnvPath
}

$legacyRootStreamSecret = Get-DotEnvValue $rootEnvPath "MENTRA_STREAM_KEY_SECRET"
$legacyMiniAppStreamSecret = Get-DotEnvValue $miniAppEnvPath "STREAM_KEY_SECRET"
$profileSecret = Get-OrCreateStableProfileSecret @(
    (Get-DotEnvValue $miniAppEnvPath "PROFILE_ID_SECRET"),
    $legacyRootStreamSecret,
    $legacyMiniAppStreamSecret
)
$miniAppApiToken = Get-OrCreateSecret "AZURE_MINIAPP_API_TOKEN"
$ingestApiToken = Get-OrCreateSecret "AZURE_INGEST_API_TOKEN"
$processorApiToken = Get-OrCreateSecret "AZURE_PROCESSOR_API_TOKEN"
$cookieSecret = Get-OrCreateSecret "MENTRA_COOKIE_SECRET"
$streamSecret = Get-OrCreateSecret "MENTRA_STREAM_KEY_SECRET"
if ($streamSecret -eq $profileSecret) {
    $streamSecret = New-RandomSecret
    Set-DotEnvValue $rootEnvPath "MENTRA_STREAM_KEY_SECRET" $streamSecret
}
$rawCaptureRetentionDays = Get-RetentionDays "AZURE_RAW_CAPTURE_RETENTION_DAYS" 30
$derivedDataRetentionDays = Get-RetentionDays "AZURE_DERIVED_DATA_RETENTION_DAYS" 365
$packageName = Get-DotEnvValue $rootEnvPath "MENTRAOS_PACKAGE_NAME"
if (-not $packageName) { $packageName = "com.aijaviercoach.ml1" }
$apiKey = Get-ExternalSetting "MENTRAOS_API_KEY"
$streamBase = Get-ExternalSetting "MENTRA_STREAM_BASE_URL"
$azureApiBase = Get-ExternalSetting "AZURE_CAPTURE_API_BASE"
$miniAppPublicUrl = Get-ExternalSetting "MENTRA_MINIAPP_PUBLIC_URL"
$websocketAllowedHosts = Get-ExternalSetting "MENTRA_WEBSOCKET_ALLOWED_HOSTS"
$operatorName = Get-ExternalSetting "APP_OPERATOR_NAME"
$supportEmail = Get-ExternalSetting "SUPPORT_EMAIL"

Set-DotEnvValue $miniAppEnvPath "PORT" "3000"
Set-DotEnvValue $miniAppEnvPath "NODE_ENV" "development"
Set-DotEnvValue $miniAppEnvPath "PACKAGE_NAME" $packageName
Set-DotEnvValue $miniAppEnvPath "MENTRAOS_API_KEY" $apiKey
Set-DotEnvValue $miniAppEnvPath "COOKIE_SECRET" $cookieSecret
Set-DotEnvValue $miniAppEnvPath "PROFILE_ID_SECRET" $profileSecret
Set-DotEnvValue $miniAppEnvPath "STREAM_KEY_SECRET" $streamSecret
Set-DotEnvValue $miniAppEnvPath "MENTRA_MINIAPP_PUBLIC_URL" $miniAppPublicUrl
Set-DotEnvValue $miniAppEnvPath "MENTRA_WEBSOCKET_ALLOWED_HOSTS" $websocketAllowedHosts
Set-DotEnvValue $miniAppEnvPath "MENTRA_DISABLE_UNUSED_ENDPOINTS" "true"
Set-DotEnvValue $miniAppEnvPath "MENTRA_STREAM_BASE_URL" $streamBase
Set-DotEnvValue $miniAppEnvPath "MENTRA_STREAM_AUTH_TTL_SECONDS" "14400"
Set-DotEnvValue $miniAppEnvPath "AZURE_CAPTURE_API_BASE" $azureApiBase
Set-DotEnvValue $miniAppEnvPath "AZURE_RAW_CAPTURE_RETENTION_DAYS" $rawCaptureRetentionDays
Set-DotEnvValue $miniAppEnvPath "AZURE_DERIVED_DATA_RETENTION_DAYS" $derivedDataRetentionDays
Set-DotEnvValue $miniAppEnvPath "AZURE_MINIAPP_API_TOKEN" $miniAppApiToken
Set-DotEnvValue $miniAppEnvPath "APP_OPERATOR_NAME" $operatorName
Set-DotEnvValue $miniAppEnvPath "SUPPORT_EMAIL" $supportEmail
Set-DotEnvValue $miniAppEnvPath "DEFAULT_SCENE_REFLECTED" "true"
Set-DotEnvValue $miniAppEnvPath "DEFAULT_SOURCE_PIXELS_MIRRORED" "false"
Set-DotEnvValue $miniAppEnvPath "DEFAULT_ROTATION_DEGREES" "0"

Set-DotEnvValue $ingestEnvPath "AZURE_CAPTURE_API_BASE" $azureApiBase
Set-DotEnvValue $ingestEnvPath "AZURE_INGEST_API_TOKEN" $ingestApiToken
Set-DotEnvValue $ingestEnvPath "STREAM_KEY_SECRET" $streamSecret
Set-DotEnvValue $ingestEnvPath "STREAM_AUTH_MAX_TTL_SECONDS" "14400"
Set-DotEnvValue $ingestEnvPath "RETRY_INTERVAL_SECONDS" "60"
Set-DotEnvValue $ingestEnvPath "STALE_CLAIM_SECONDS" "300"
Set-DotEnvValue $ingestEnvPath "FAILED_SEGMENT_RETENTION_SECONDS" "86400"
Set-DotEnvValue $ingestEnvPath "RETRY_WORKER_HEALTH_MAX_AGE_SECONDS" "300"

Set-DotEnvValue $mobileEnvPath "EXPO_PUBLIC_CAPTURE_API_BASE" $azureApiBase

Remove-DotEnvValue $rootEnvPath "MENTRA_WEBHOOK_TOKEN"
Remove-DotEnvValue $miniAppEnvPath "MENTRA_WEBHOOK_TOKEN"
Remove-DotEnvValue $ingestEnvPath "MENTRA_WEBHOOK_TOKEN"

Write-Host "Mentra environment files saved. Secret values were not printed."
Write-Host "MiniApp API key: $(if ($apiKey) { 'set' } else { 'missing' })"
Write-Host "Azure capture API: $(if ($azureApiBase) { 'set' } else { 'missing' })"
Write-Host "RTMP/RTMPS ingest URL: $(if ($streamBase) { 'set' } else { 'missing' })"
