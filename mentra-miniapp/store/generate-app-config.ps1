param(
    [Parameter(Mandatory = $true)]
    [string]$PublicUrl,
    [string]$OutputPath = (Join-Path $PSScriptRoot "app_config.json")
)

$ErrorActionPreference = "Stop"
$normalizedUrl = $PublicUrl.Trim().TrimEnd('/')
$uri = $null
if (-not [Uri]::TryCreate($normalizedUrl, [UriKind]::Absolute, [ref]$uri) -or
    $uri.Scheme -ne "https" -or
    $uri.IsLoopback) {
    throw "PublicUrl must be a non-local HTTPS URL."
}

$config = [ordered]@{
    name = "AI Javier Coach"
    description = "Record a hands-free curl workout with Mentra Live, analyze repetitions and form in Azure, and review performance from the phone webview."
    publicUrl = $normalizedUrl
    logoURL = "$normalizedUrl/assets/app-icon.png"
    webviewURL = "$normalizedUrl/webview"
    appType = "standard"
    permissions = @(
        [ordered]@{
            type = "CAMERA"
            description = "Record the workout only after the user presses Start so AI Javier can analyze curl repetitions and form."
        }
    )
    settings = @()
    tools = @()
    version = "0.1.0"
}

$json = $config | ConvertTo-Json -Depth 10
$parent = Split-Path -Parent $OutputPath
if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent | Out-Null
}
[System.IO.File]::WriteAllText($OutputPath, "$json`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "Mentra app configuration written to $OutputPath"
Write-Host "Set hardware requirements manually in the console: CAMERA required; WIFI required."

