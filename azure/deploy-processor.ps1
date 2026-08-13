param(
    [switch]$ConfirmAzureSpend,
    [switch]$SkipInitialRun,
    [switch]$SkipImageBuild,
    [string]$ResourceGroup = "",
    [string]$RegistryName = "",
    [string]$EnvironmentName = "",
    [string]$PullIdentityName = "",
    [string]$StorageAccountName = "",
    [string]$JobName = "ai-javier-processor",
    [string]$ProcessorIdentityName = "ai-javier-processor",
    [string]$ScheduleCron = "*/15 * * * *",
    [int]$DerivedDataRetentionDays = 0,
    [string]$ImageTag = ""
)

$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env"
$templatePath = Join-Path $PSScriptRoot "infra\processor-job.bicep"
$dockerfilePath = Join-Path $PSScriptRoot "processor\Dockerfile"

function Get-DotEnvValue {
    param([string]$Name)
    if (-not (Test-Path -LiteralPath $envPath)) { return "" }
    $line = Get-Content -LiteralPath $envPath | Where-Object {
        $_ -match "^\s*$([regex]::Escape($Name))\s*="
    } | Select-Object -Last 1
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

if (-not $ConfirmAzureSpend) {
    throw "No resources were changed. Rerun with -ConfirmAzureSpend only after approving Container Apps job and remote-build charges."
}
if ($ScheduleCron -notmatch '^[0-9*/,\-]+\s+[0-9*/,\-]+\s+[0-9*/,\-]+\s+[0-9*/,\-]+\s+[0-9*/,\-]+$') {
    throw "ScheduleCron must be a five-field cron expression."
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
if (-not $RegistryName) { $RegistryName = Get-DotEnvValue "AZURE_MINIAPP_REGISTRY_NAME" }
if (-not $EnvironmentName) { $EnvironmentName = Get-DotEnvValue "AZURE_MINIAPP_ENVIRONMENT_NAME" }
if (-not $PullIdentityName) { $PullIdentityName = Get-DotEnvValue "AZURE_MINIAPP_PULL_IDENTITY_NAME" }
if (-not $StorageAccountName) { $StorageAccountName = Get-DotEnvValue "AZURE_STORAGE_ACCOUNT_NAME" }
foreach ($required in @{
    AZURE_RESOURCE_GROUP = $ResourceGroup
    AZURE_MINIAPP_REGISTRY_NAME = $RegistryName
    AZURE_MINIAPP_ENVIRONMENT_NAME = $EnvironmentName
    AZURE_MINIAPP_PULL_IDENTITY_NAME = $PullIdentityName
    AZURE_STORAGE_ACCOUNT_NAME = $StorageAccountName
}.GetEnumerator()) {
    if (-not $required.Value) {
        throw "$($required.Key) is missing. Deploy the base API and MiniApp foundation first."
    }
}
if (-not $ImageTag) { $ImageTag = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss") }
if ($DerivedDataRetentionDays -eq 0) {
    $configuredRetention = Get-DotEnvValue "AZURE_DERIVED_DATA_RETENTION_DAYS"
    $DerivedDataRetentionDays = if ($configuredRetention) { [int]$configuredRetention } else { 365 }
}
if ($DerivedDataRetentionDays -lt 1 -or $DerivedDataRetentionDays -gt 3650) {
    throw "DerivedDataRetentionDays must be from 1 to 3650."
}

az extension add --name containerapp --upgrade --only-show-errors
Assert-AzSuccess "The Azure Container Apps CLI extension could not be installed or updated."
az provider register --namespace Microsoft.App --wait --only-show-errors
Assert-AzSuccess "Microsoft.App provider registration failed."

if ($SkipImageBuild) {
    az acr repository show --name $RegistryName --image "ai-javier-processor:$ImageTag" --output none --only-show-errors
    Assert-AzSuccess "The requested existing processor image was not found in ACR."
}
else {
    $runId = az acr build `
        --registry $RegistryName `
        --image "ai-javier-processor:$ImageTag" `
        --file $dockerfilePath `
        $repoRoot `
        --no-logs `
        --query runId `
        --output tsv `
        --only-show-errors
    Assert-AzSuccess "Remote processor container build could not be queued."
    if (-not $runId) { throw "Azure did not return a run ID for the processor build." }
    Wait-AcrRun -RegistryName $RegistryName -RunId $runId -Description "Processor"
}

$deploymentParameters = @(
    "jobName=$JobName",
    "processorIdentityName=$ProcessorIdentityName",
    "environmentName=$EnvironmentName",
    "registryName=$RegistryName",
    "pullIdentityName=$PullIdentityName",
    "storageAccountName=$StorageAccountName",
    "imageTag=$ImageTag",
    "scheduleCron=$ScheduleCron",
    "derivedDataRetentionDays=$DerivedDataRetentionDays"
)
az deployment group validate `
    --resource-group $ResourceGroup `
    --template-file $templatePath `
    --parameters @deploymentParameters `
    --output none `
    --only-show-errors
Assert-AzSuccess "Processor job validation failed."
az deployment group what-if `
    --resource-group $ResourceGroup `
    --template-file $templatePath `
    --parameters @deploymentParameters `
    --result-format ResourceIdOnly `
    --only-show-errors
Assert-AzSuccess "Processor job preview failed."
az deployment group create `
    --name "ai-javier-processor" `
    --resource-group $ResourceGroup `
    --template-file $templatePath `
    --parameters @deploymentParameters `
    --output none `
    --only-show-errors
Assert-AzSuccess "Processor job deployment failed."

Set-DotEnvValue "AZURE_PROCESSOR_JOB_NAME" $JobName
Set-DotEnvValue "AZURE_PROCESSOR_IDENTITY_NAME" $ProcessorIdentityName
Set-DotEnvValue "AZURE_PROCESSOR_SCHEDULE_CRON" $ScheduleCron
Set-DotEnvValue "AZURE_DERIVED_DATA_RETENTION_DAYS" ([string]$DerivedDataRetentionDays)

if (-not $SkipInitialRun) {
    $executionName = az containerapp job start `
        --name $JobName `
        --resource-group $ResourceGroup `
        --query name `
        --output tsv `
        --only-show-errors
    Assert-AzSuccess "The processor job was deployed but its initial run could not start."
    Write-Host "Processor job deployed; initial execution started: $executionName"
}
else {
    Write-Host "Processor job deployed. Initial execution was skipped."
}
Write-Host "Schedule: $ScheduleCron (UTC)"
