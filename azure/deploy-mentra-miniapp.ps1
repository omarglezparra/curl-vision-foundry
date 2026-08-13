param(
    [switch]$ConfirmAzureSpend,
    [switch]$SkipImageBuild,
    [string]$ResourceGroup = "",
    [string]$Location = "",
    [string]$RegistryName = "",
    [string]$EnvironmentName = "",
    [string]$PullIdentityName = "",
    [string]$ContainerAppName = "",
    [string]$ImageTag = ""
)

$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env"
$miniAppPath = Join-Path $repoRoot "mentra-miniapp"
$foundationTemplate = Join-Path $PSScriptRoot "infra\miniapp-foundation.bicep"
$appTemplate = Join-Path $PSScriptRoot "infra\miniapp-app.bicep"

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
    $lines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path -LiteralPath $envPath) {
        foreach ($existingLine in Get-Content -LiteralPath $envPath) { [void]$lines.Add([string]$existingLine) }
    }
    $found = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match "^\s*$([regex]::Escape($Name))\s*=") {
            $lines[$index] = $newLine
            $found = $true
            break
        }
    }
    if (-not $found) { $lines.Add($newLine) }
    [System.IO.File]::WriteAllLines($envPath, $lines, [System.Text.UTF8Encoding]::new($false))
}

function Assert-AzSuccess {
    param([string]$Message)
    if ($LASTEXITCODE -ne 0) { throw $Message }
}

function Wait-AcrRun {
    param([string]$RegistryName, [string]$RunId, [string]$Description)
    for ($attempt = 1; $attempt -le 90; $attempt++) {
        $status = az acr task show-run --registry $RegistryName --run-id $RunId --query status --output tsv --only-show-errors
        Assert-AzSuccess "Could not read the ACR build status for $Description."
        if ($status -eq "Succeeded") { return }
        if ($status -notin @("Queued", "Started", "Running")) {
            throw "$Description ACR build ended with status '$status' (run $RunId)."
        }
        Start-Sleep -Seconds 10
    }
    throw "$Description ACR build did not finish within 15 minutes (run $RunId)."
}

function Require-Value {
    param([string]$Name, [string]$Value)
    if (-not $Value -or $Value -match '(?i)(replace[-_ ]|your[-_ ]|example|<[^>]+>)') {
        throw "$Name must be configured with a real production value in .env."
    }
    return $Value
}

function Require-Secret {
    param([string]$Name)
    $value = Require-Value $Name (Get-DotEnvValue $Name)
    if ($value.Length -lt 32) { throw "$Name must contain at least 32 characters." }
    return $value
}

if (-not $ConfirmAzureSpend) {
    throw "No resources were created. Rerun with -ConfirmAzureSpend only after approving Azure charges."
}
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI is missing."
}

$accountJson = az account show --output json --only-show-errors 2>$null
Assert-AzSuccess "Azure CLI is signed out. Run az login first."
$account = $accountJson | ConvertFrom-Json
$subscriptionId = Get-DotEnvValue "AZURE_SUBSCRIPTION_ID"
if (-not $subscriptionId) { $subscriptionId = $account.id }
az account set --subscription $subscriptionId --only-show-errors
Assert-AzSuccess "Could not select Azure subscription $subscriptionId."

if (-not $ResourceGroup) { $ResourceGroup = Get-DotEnvValue "AZURE_RESOURCE_GROUP" }
if (-not $Location) { $Location = Get-DotEnvValue "AZURE_LOCATION" }
if (-not $ResourceGroup -or -not $Location) {
    throw "Run azure\deploy.ps1 first so the base resource group and Function API exist."
}
$groupExists = az group exists --name $ResourceGroup --output tsv --only-show-errors
Assert-AzSuccess "Could not check Azure resource group $ResourceGroup."
if ($groupExists -ne "true") {
    throw "Resource group $ResourceGroup does not exist. Run azure\deploy.ps1 first."
}

if (-not $RegistryName) { $RegistryName = Get-DotEnvValue "AZURE_MINIAPP_REGISTRY_NAME" }
if (-not $RegistryName) { $RegistryName = "ajcminiapp$((Get-Random -Maximum 99999999).ToString('00000000'))" }
if (-not $EnvironmentName) { $EnvironmentName = Get-DotEnvValue "AZURE_MINIAPP_ENVIRONMENT_NAME" }
if (-not $EnvironmentName) { $EnvironmentName = "ajc-miniapp-env" }
if (-not $PullIdentityName) { $PullIdentityName = Get-DotEnvValue "AZURE_MINIAPP_PULL_IDENTITY_NAME" }
if (-not $PullIdentityName) { $PullIdentityName = "ajc-miniapp-pull" }
if (-not $ContainerAppName) { $ContainerAppName = Get-DotEnvValue "AZURE_MINIAPP_APP_NAME" }
if (-not $ContainerAppName) { $ContainerAppName = "ai-javier-coach" }
if (-not $ImageTag) { $ImageTag = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss") }

if ($RegistryName -notmatch '^[a-zA-Z0-9]{5,50}$') { throw "RegistryName must be 5-50 alphanumeric characters." }
foreach ($name in @($EnvironmentName, $PullIdentityName, $ContainerAppName)) {
    if ($name -notmatch '^[a-z][a-z0-9-]{1,30}[a-z0-9]$') { throw "Azure app names must use lowercase letters, digits, and internal hyphens." }
}

$packageName = Require-Value "MENTRAOS_PACKAGE_NAME" (Get-DotEnvValue "MENTRAOS_PACKAGE_NAME")
$allowedHosts = Require-Value "MENTRA_WEBSOCKET_ALLOWED_HOSTS" (Get-DotEnvValue "MENTRA_WEBSOCKET_ALLOWED_HOSTS")
$captureApiBase = Require-Value "AZURE_CAPTURE_API_BASE" (Get-DotEnvValue "AZURE_CAPTURE_API_BASE")
$rtmpsUrl = Require-Value "MENTRA_STREAM_BASE_URL" (Get-DotEnvValue "MENTRA_STREAM_BASE_URL")
$operatorName = Require-Value "APP_OPERATOR_NAME" (Get-DotEnvValue "APP_OPERATOR_NAME")
$supportEmail = Require-Value "SUPPORT_EMAIL" (Get-DotEnvValue "SUPPORT_EMAIL")
if ($packageName -notmatch '^[a-z][a-z0-9]*(\.[a-z0-9]+)+$') { throw "MENTRAOS_PACKAGE_NAME must be lowercase reverse-DNS notation." }
if ($captureApiBase -notmatch '^https://') { throw "AZURE_CAPTURE_API_BASE must use HTTPS." }
if ($rtmpsUrl -notmatch '^rtmps://') { throw "MENTRA_STREAM_BASE_URL must use RTMPS." }
if ($supportEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw "SUPPORT_EMAIL must be valid." }

$mentraApiKey = Require-Secret "MENTRAOS_API_KEY"
$cookieSecret = Require-Secret "MENTRA_COOKIE_SECRET"
$miniappApiToken = Require-Secret "AZURE_MINIAPP_API_TOKEN"
$streamKeySecret = Require-Secret "MENTRA_STREAM_KEY_SECRET"
$profileIdSecret = Require-Secret "MENTRA_PROFILE_ID_SECRET"
$rawRetention = [int](Require-Value "AZURE_RAW_CAPTURE_RETENTION_DAYS" (Get-DotEnvValue "AZURE_RAW_CAPTURE_RETENTION_DAYS"))
$derivedRetention = [int](Require-Value "AZURE_DERIVED_DATA_RETENTION_DAYS" (Get-DotEnvValue "AZURE_DERIVED_DATA_RETENTION_DAYS"))
$streamTtl = [int](Get-DotEnvValue "MENTRA_STREAM_AUTH_TTL_SECONDS")
if (-not $streamTtl) { $streamTtl = 14400 }

Set-DotEnvValue "AZURE_MINIAPP_REGISTRY_NAME" $RegistryName
Set-DotEnvValue "AZURE_MINIAPP_ENVIRONMENT_NAME" $EnvironmentName
Set-DotEnvValue "AZURE_MINIAPP_PULL_IDENTITY_NAME" $PullIdentityName
Set-DotEnvValue "AZURE_MINIAPP_APP_NAME" $ContainerAppName

az provider register --namespace Microsoft.App --wait --only-show-errors
Assert-AzSuccess "Microsoft.App provider registration failed."
az provider register --namespace Microsoft.ContainerRegistry --wait --only-show-errors
Assert-AzSuccess "Microsoft.ContainerRegistry provider registration failed."
az provider register --namespace Microsoft.ManagedIdentity --wait --only-show-errors
Assert-AzSuccess "Microsoft.ManagedIdentity provider registration failed."

$foundationParameters = @(
    "registryName=$RegistryName",
    "environmentName=$EnvironmentName",
    "pullIdentityName=$PullIdentityName"
)
az deployment group validate --resource-group $ResourceGroup --template-file $foundationTemplate --parameters @foundationParameters --output none --only-show-errors
Assert-AzSuccess "MiniApp foundation validation failed."
az deployment group what-if --resource-group $ResourceGroup --template-file $foundationTemplate --parameters @foundationParameters --result-format ResourceIdOnly --only-show-errors
Assert-AzSuccess "MiniApp foundation preview failed."
az deployment group create --name "ai-javier-miniapp-foundation" --resource-group $ResourceGroup --template-file $foundationTemplate --parameters @foundationParameters --output none --only-show-errors
Assert-AzSuccess "MiniApp foundation deployment failed."

if ($SkipImageBuild) {
    az acr repository show --name $RegistryName --image "ai-javier-miniapp:$ImageTag" --output none --only-show-errors
    Assert-AzSuccess "The requested existing MiniApp image was not found in ACR."
}
else {
    $runId = az acr build --registry $RegistryName --image "ai-javier-miniapp:$ImageTag" $miniAppPath --no-logs --query runId --output tsv --only-show-errors
    Assert-AzSuccess "Remote MiniApp container build could not be queued."
    if (-not $runId) { throw "Azure did not return a run ID for the MiniApp build." }
    Wait-AcrRun -RegistryName $RegistryName -RunId $runId -Description "MiniApp"
}

$parameterFile = Join-Path ([System.IO.Path]::GetTempPath()) "ai-javier-miniapp-$([guid]::NewGuid().ToString('N')).parameters.json"
$parameters = @{
    '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
    contentVersion = '1.0.0.0'
    parameters = @{
        containerAppName = @{ value = $ContainerAppName }
        environmentName = @{ value = $EnvironmentName }
        registryName = @{ value = $RegistryName }
        pullIdentityName = @{ value = $PullIdentityName }
        imageTag = @{ value = $ImageTag }
        packageName = @{ value = $packageName }
        websocketAllowedHosts = @{ value = $allowedHosts }
        azureCaptureApiBase = @{ value = $captureApiBase }
        rtmpsStreamUrl = @{ value = $rtmpsUrl }
        operatorName = @{ value = $operatorName }
        supportEmail = @{ value = $supportEmail }
        rawCaptureRetentionDays = @{ value = $rawRetention }
        derivedDataRetentionDays = @{ value = $derivedRetention }
        streamAuthTtlSeconds = @{ value = $streamTtl }
        mentraApiKey = @{ value = $mentraApiKey }
        cookieSecret = @{ value = $cookieSecret }
        miniappApiToken = @{ value = $miniappApiToken }
        streamKeySecret = @{ value = $streamKeySecret }
        profileIdSecret = @{ value = $profileIdSecret }
    }
}

try {
    [System.IO.File]::WriteAllText($parameterFile, ($parameters | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
    az deployment group validate --resource-group $ResourceGroup --template-file $appTemplate --parameters "@$parameterFile" --output none --only-show-errors
    Assert-AzSuccess "MiniApp application validation failed."
    az deployment group what-if --resource-group $ResourceGroup --template-file $appTemplate --parameters "@$parameterFile" --result-format ResourceIdOnly --only-show-errors
    Assert-AzSuccess "MiniApp application preview failed."
    $deploymentJson = az deployment group create --name "ai-javier-miniapp" --resource-group $ResourceGroup --template-file $appTemplate --parameters "@$parameterFile" --output json --only-show-errors
    Assert-AzSuccess "MiniApp application deployment failed."
}
finally {
    if (Test-Path -LiteralPath $parameterFile) { Remove-Item -LiteralPath $parameterFile -Force }
}

$deployment = $deploymentJson | ConvertFrom-Json
$miniappUrl = [string]$deployment.properties.outputs.miniappUrl.value
$healthy = $false
for ($attempt = 1; $attempt -le 24; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri "$miniappUrl/health" -Method Get -TimeoutSec 15
        if ($health.status -eq "healthy") {
            $healthy = $true
            break
        }
    }
    catch {
        # The first Container Apps revision can need a short cold-start window.
    }
    if ($attempt -lt 24) { Start-Sleep -Seconds 5 }
}
if (-not $healthy) { throw "The deployed MiniApp did not become healthy within two minutes." }
Set-DotEnvValue "MENTRA_MINIAPP_PUBLIC_URL" $miniappUrl

& (Join-Path $miniAppPath "store\generate-app-config.ps1") -PublicUrl $miniappUrl
Write-Host "MiniApp deployed and healthy at $miniappUrl"
Write-Host "The generated Store config is ready; preview images still upload through the Mentra console."
