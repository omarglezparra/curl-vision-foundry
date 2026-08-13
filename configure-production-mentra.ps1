param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $repoRoot ".env"

function Get-DotEnvValue {
    param([string]$Name)
    if (-not (Test-Path -LiteralPath $envPath)) { return "" }
    $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -Last 1
    if (-not $line) { return "" }
    return (($line -split "=", 2)[1].Trim()).Trim('"').Trim("'")
}

function Set-DotEnvValue {
    param([string]$Name, [string]$Value)
    $escaped = $Value.Replace("\", "\\").Replace('"', '\"')
    $newLine = "$Name=`"$escaped`""
    if (-not (Test-Path -LiteralPath $envPath)) {
        throw ".env is missing. Run setup-mentra-env.ps1 first."
    }
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($existingLine in Get-Content -LiteralPath $envPath) { [void]$lines.Add([string]$existingLine) }
    $updated = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match "^\s*$([regex]::Escape($Name))\s*=") {
            $lines[$index] = $newLine
            $updated = $true
            break
        }
    }
    if (-not $updated) { $lines.Add($newLine) }
    [System.IO.File]::WriteAllLines($envPath, $lines, [System.Text.UTF8Encoding]::new($false))
}

$operatorName = (Read-Host "Public legal operator/organization name shown to Mentra users").Trim()
if ($operatorName.Length -lt 2 -or $operatorName -match '[\r\n]') {
    throw "Enter the real public operator or organization name."
}

$supportEmail = (Read-Host "Monitored public support email").Trim()
if ($supportEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
    throw "Enter a valid monitored support email address."
}

$secureApiKey = Read-Host "Mentra Developer Console API key (input is hidden)" -AsSecureString
$apiKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureApiKey)
try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($apiKeyPointer)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($apiKeyPointer)
}
if ([string]::IsNullOrWhiteSpace($apiKey) -or $apiKey.Length -lt 32) {
    throw "The Mentra API key must be a real value of at least 32 characters."
}

$packageName = Get-DotEnvValue "MENTRAOS_PACKAGE_NAME"
if ($packageName -notmatch '^[a-z][a-z0-9]*(\.[a-z0-9]+)+$') {
    throw "MENTRAOS_PACKAGE_NAME must be configured before validating the API key."
}
try {
    $appResponse = Invoke-RestMethod -UseBasicParsing -Uri "https://api.mentra.glass/api/apps/$packageName" -Method Get -TimeoutSec 30
}
catch {
    $apiKey = $null
    throw "Could not verify the API key against the live Mentra app record. Check the connection and try again."
}
$liveApp = if ($appResponse.data) { $appResponse.data } else { $appResponse }
if (-not $liveApp.hashedApiKey -or ([string]$liveApp.hashedApiKey).Length -ne 64) {
    $apiKey = $null
    throw "The live Mentra app record did not expose a valid API-key hash for $packageName."
}
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $apiKeyHash = [BitConverter]::ToString(
        $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($apiKey))
    ).Replace('-', '').ToLowerInvariant()
}
finally {
    $sha256.Dispose()
}
if ($apiKeyHash -cne [string]$liveApp.hashedApiKey) {
    $apiKey = $null
    $apiKeyHash = $null
    throw "That API key does not belong to the live Mentra app $packageName. Generate or copy the key from that exact app and retry."
}
$apiKeyHash = $null

Set-DotEnvValue "MENTRAOS_API_KEY" $apiKey
Set-DotEnvValue "MENTRA_WEBSOCKET_ALLOWED_HOSTS" "api.mentra.glass"
Set-DotEnvValue "APP_OPERATOR_NAME" $operatorName
Set-DotEnvValue "SUPPORT_EMAIL" $supportEmail

& (Join-Path $repoRoot "setup-mentra-env.ps1")
if (-not $?) { throw "Mentra environment synchronization failed." }
$apiKey = $null

Write-Host "Production Mentra values were verified and saved locally; the API key was not printed."
