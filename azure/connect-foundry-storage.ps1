param(
    [string]$FoundryProjectEndpoint = "",
    [string]$FoundryResourceGroup = "",
    [string]$ConnectionName = "curl-vision-captures"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
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

$accountJson = az account show --output json --only-show-errors 2>$null
if ($LASTEXITCODE -ne 0) { throw "Azure CLI is signed out. Run 'az login' first." }
$account = $accountJson | ConvertFrom-Json
$subscriptionId = Get-DotEnvValue "AZURE_SUBSCRIPTION_ID"
if (-not $subscriptionId) { $subscriptionId = $account.id }
$storageAccountName = Get-DotEnvValue "AZURE_STORAGE_ACCOUNT_NAME"
$captureContainer = Get-DotEnvValue "AZURE_CAPTURE_CONTAINER"
if (-not $captureContainer) { $captureContainer = "captures" }
if (-not $FoundryProjectEndpoint) { $FoundryProjectEndpoint = Get-DotEnvValue "FOUNDRY_PROJECT_ENDPOINT" }

if (-not $storageAccountName) { throw "AZURE_STORAGE_ACCOUNT_NAME is missing from .env." }
if ($FoundryProjectEndpoint -notmatch '^https://([A-Za-z0-9-]+)\.services\.ai\.azure\.com/api/projects/([A-Za-z0-9_.-]+)/?$') {
    throw "FOUNDRY_PROJECT_ENDPOINT is missing or invalid. Copy it from your Foundry project home page."
}
$foundryAccountName = $Matches[1]
$foundryProjectName = $Matches[2]

if (-not $FoundryResourceGroup) {
    $FoundryResourceGroup = az resource list `
        --name $foundryAccountName `
        --resource-type Microsoft.CognitiveServices/accounts `
        --query "[0].resourceGroup" `
        --output tsv `
        --only-show-errors
    Assert-AzSuccess "Could not find the Foundry account named $foundryAccountName."
}
if (-not $FoundryResourceGroup) { throw "The Foundry resource group could not be resolved." }

$projectResourceUri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$FoundryResourceGroup/providers/Microsoft.CognitiveServices/accounts/$foundryAccountName/projects/$foundryProjectName?api-version=2025-06-01"
$projectJson = az rest --method get --uri $projectResourceUri --output json --only-show-errors
Assert-AzSuccess "Could not read the Foundry project resource."
$project = $projectJson | ConvertFrom-Json
$projectPrincipalId = $project.identity.principalId
if (-not $projectPrincipalId) {
    throw "The Foundry project has no managed identity. Enable its system-assigned identity, then retry."
}

$storageScope = az storage account show `
    --name $storageAccountName `
    --query id `
    --output tsv `
    --only-show-errors
Assert-AzSuccess "Could not resolve storage account $storageAccountName."
az role assignment create `
    --assignee-object-id $projectPrincipalId `
    --assignee-principal-type ServicePrincipal `
    --role "Storage Blob Data Contributor" `
    --scope $storageScope `
    --output none `
    --only-show-errors
Assert-AzSuccess "Could not grant the Foundry project access to Blob Storage."

$storageTarget = "https://$storageAccountName.blob.core.windows.net/$captureContainer"
$body = @{
    properties = @{
        authType = "AAD"
        category = "AzureBlob"
        target = $storageTarget
        useWorkspaceManagedIdentity = $true
        metadata = @{
            container = $captureContainer
            purpose = "AI Javier Coach exercise captures"
        }
    }
} | ConvertTo-Json -Depth 8 -Compress
$connectionUri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$FoundryResourceGroup/providers/Microsoft.CognitiveServices/accounts/$foundryAccountName/projects/$foundryProjectName/connections/$ConnectionName`?api-version=2025-06-01"
az rest --method put --uri $connectionUri --headers "Content-Type=application/json" --body $body --output none --only-show-errors
Assert-AzSuccess "Foundry storage connection creation failed."

# Save only after the connection has been accepted by Azure.
Set-DotEnvValue "FOUNDRY_PROJECT_ENDPOINT" $FoundryProjectEndpoint
Set-DotEnvValue "AZURE_AI_PROJECT_ENDPOINT" $FoundryProjectEndpoint
Set-DotEnvValue "FOUNDRY_STORAGE_CONNECTION_NAME" $ConnectionName

Write-Host "Foundry connection '$ConnectionName' now targets $storageTarget using managed identity."
