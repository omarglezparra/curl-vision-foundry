param(
    [switch]$ConfirmAzureSpend,
    [string]$SubscriptionId = "",
    [string]$ResourceGroup = "",
    [string]$Location = "",
    [string]$StorageAccountName = "",
    [string]$FunctionAppName = "",
    [string]$FoundryProjectEndpoint = "",
    [string]$MiniappApiToken = "",
    [string]$IngestApiToken = "",
    [string]$ProcessorApiToken = "",
    [int]$RawCaptureRetentionDays = 0,
    [int]$DerivedDataRetentionDays = 0,
    [decimal]$LogAnalyticsDailyQuotaGb = 0,
    [decimal]$MonthlyBudgetUsd = 0,
    [string]$BudgetAlertEmail = "",
    [switch]$SkipBudget,
    [switch]$SkipFunctionCode
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env"
$templatePath = Join-Path $PSScriptRoot "infra\main.bicep"
$functionsPath = Join-Path $PSScriptRoot "functions"

if (-not $ConfirmAzureSpend) {
    throw "No resources were created. Rerun with -ConfirmAzureSpend only after approving Function, Storage, and budget charges."
}

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

function New-RandomHexSecret {
    $tokenBytes = [byte[]]::new(32)
    $tokenGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $tokenGenerator.GetBytes($tokenBytes) }
    finally { $tokenGenerator.Dispose() }
    return -join ($tokenBytes | ForEach-Object { $_.ToString("x2") })
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI is missing. Install it, then run az login."
}

$accountJson = az account show --output json --only-show-errors 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI is signed out. Run 'az login', then rerun this command."
}
$account = $accountJson | ConvertFrom-Json
$expectedTenant = Get-DotEnvValue "AZURE_TENANT_ID"
$expectedAccount = Get-DotEnvValue "AZURE_ACCOUNT_EMAIL"
if ($expectedTenant -and $account.tenantId -ne $expectedTenant) {
    throw "Azure CLI is signed into tenant $($account.tenantId), but .env requires $expectedTenant."
}
if ($expectedAccount -and $account.user.name -ne $expectedAccount) {
    throw "Azure CLI is signed in as $($account.user.name), but .env requires $expectedAccount."
}

if (-not $SubscriptionId) { $SubscriptionId = Get-DotEnvValue "AZURE_SUBSCRIPTION_ID" }
if (-not $SubscriptionId) { $SubscriptionId = $account.id }
az account set --subscription $SubscriptionId --only-show-errors
Assert-AzSuccess "Could not select Azure subscription $SubscriptionId."

if (-not $ResourceGroup) { $ResourceGroup = Get-DotEnvValue "AZURE_RESOURCE_GROUP" }
if (-not $ResourceGroup) { $ResourceGroup = "rg-curl-vision-trainer" }
if (-not $Location) { $Location = Get-DotEnvValue "AZURE_LOCATION" }
if (-not $Location) { $Location = "eastus" }
if (-not $StorageAccountName) { $StorageAccountName = Get-DotEnvValue "AZURE_STORAGE_ACCOUNT_NAME" }
if (-not $StorageAccountName) { $StorageAccountName = "curlvision$((Get-Random -Maximum 99999999).ToString('00000000'))" }
if (-not $FunctionAppName) { $FunctionAppName = Get-DotEnvValue "AZURE_FUNCTION_APP_NAME" }
if (-not $FunctionAppName) { $FunctionAppName = "curl-vision-capture-$((Get-Random -Maximum 999999).ToString('000000'))" }
if (-not $FoundryProjectEndpoint) { $FoundryProjectEndpoint = Get-DotEnvValue "FOUNDRY_PROJECT_ENDPOINT" }
if (-not $MiniappApiToken) { $MiniappApiToken = Get-DotEnvValue "AZURE_MINIAPP_API_TOKEN" }
if (-not $MiniappApiToken) {
    $MiniappApiToken = New-RandomHexSecret
    Set-DotEnvValue "AZURE_MINIAPP_API_TOKEN" $MiniappApiToken
}
if (-not $IngestApiToken) { $IngestApiToken = Get-DotEnvValue "AZURE_INGEST_API_TOKEN" }
if (-not $IngestApiToken) {
    $IngestApiToken = New-RandomHexSecret
    Set-DotEnvValue "AZURE_INGEST_API_TOKEN" $IngestApiToken
}
if (-not $ProcessorApiToken) { $ProcessorApiToken = Get-DotEnvValue "AZURE_PROCESSOR_API_TOKEN" }
if (-not $ProcessorApiToken) {
    $ProcessorApiToken = New-RandomHexSecret
    Set-DotEnvValue "AZURE_PROCESSOR_API_TOKEN" $ProcessorApiToken
}
if ($MiniappApiToken.Length -lt 32 -or $MiniappApiToken -match '(?i)(replace[-_ ]|your[-_ ]|example|<[^>]+>)') {
    throw "AZURE_MINIAPP_API_TOKEN must be a non-placeholder secret of at least 32 characters."
}
if ($IngestApiToken.Length -lt 32 -or $IngestApiToken -match '(?i)(replace[-_ ]|your[-_ ]|example|<[^>]+>)') {
    throw "AZURE_INGEST_API_TOKEN must be a non-placeholder secret of at least 32 characters."
}
if ($ProcessorApiToken.Length -lt 32 -or $ProcessorApiToken -match '(?i)(replace[-_ ]|your[-_ ]|example|<[^>]+>)') {
    throw "AZURE_PROCESSOR_API_TOKEN must be a non-placeholder secret of at least 32 characters."
}
$allowedOrigins = Get-DotEnvValue "AZURE_ALLOWED_ORIGINS"
if (-not $allowedOrigins) { $allowedOrigins = "https://omarglezparra.github.io,http://localhost:8080,http://127.0.0.1:8080" }
if ($RawCaptureRetentionDays -eq 0) {
    $configuredRawRetention = Get-DotEnvValue "AZURE_RAW_CAPTURE_RETENTION_DAYS"
    if ($configuredRawRetention) {
        try { $RawCaptureRetentionDays = [int]$configuredRawRetention }
        catch { throw "AZURE_RAW_CAPTURE_RETENTION_DAYS must be a whole number." }
    }
    else { $RawCaptureRetentionDays = 30 }
}
if ($DerivedDataRetentionDays -eq 0) {
    $configuredDerivedRetention = Get-DotEnvValue "AZURE_DERIVED_DATA_RETENTION_DAYS"
    if ($configuredDerivedRetention) {
        try { $DerivedDataRetentionDays = [int]$configuredDerivedRetention }
        catch { throw "AZURE_DERIVED_DATA_RETENTION_DAYS must be a whole number." }
    }
    else { $DerivedDataRetentionDays = 365 }
}
if ($RawCaptureRetentionDays -lt 1) { throw "Raw capture retention must be at least 1 day." }
if ($DerivedDataRetentionDays -lt 1) { throw "Derived-data retention must be at least 1 day." }
if ($LogAnalyticsDailyQuotaGb -eq 0) {
    $configuredLogQuota = Get-DotEnvValue "AZURE_LOG_ANALYTICS_DAILY_QUOTA_GB"
    if (-not $configuredLogQuota) { $configuredLogQuota = "0.05" }
    try { $LogAnalyticsDailyQuotaGb = [decimal]::Parse($configuredLogQuota, [Globalization.CultureInfo]::InvariantCulture) }
    catch { throw "AZURE_LOG_ANALYTICS_DAILY_QUOTA_GB must be a decimal number." }
}
if ($LogAnalyticsDailyQuotaGb -lt [decimal]0.023) {
    throw "LogAnalyticsDailyQuotaGb must be at least Azure's 0.023 GB/day minimum."
}

# Save stable planned names before provisioning so a retry reuses the same targets.
Set-DotEnvValue "AZURE_SUBSCRIPTION_ID" $SubscriptionId
Set-DotEnvValue "AZURE_RESOURCE_GROUP" $ResourceGroup
Set-DotEnvValue "AZURE_LOCATION" $Location
Set-DotEnvValue "AZURE_STORAGE_ACCOUNT_NAME" $StorageAccountName
Set-DotEnvValue "AZURE_FUNCTION_APP_NAME" $FunctionAppName
Set-DotEnvValue "AZURE_MINIAPP_API_TOKEN" $MiniappApiToken
Set-DotEnvValue "AZURE_INGEST_API_TOKEN" $IngestApiToken
Set-DotEnvValue "AZURE_PROCESSOR_API_TOKEN" $ProcessorApiToken
Set-DotEnvValue "AZURE_RAW_CAPTURE_RETENTION_DAYS" ([string]$RawCaptureRetentionDays)
Set-DotEnvValue "AZURE_DERIVED_DATA_RETENTION_DAYS" ([string]$DerivedDataRetentionDays)
Set-DotEnvValue "AZURE_LOG_ANALYTICS_DAILY_QUOTA_GB" $LogAnalyticsDailyQuotaGb.ToString([Globalization.CultureInfo]::InvariantCulture)

# Create the group before the budget because resource-group budgets are scoped to
# an existing group. This is idempotent and does not create billable resources.
az group create --name $ResourceGroup --location $Location --output none --only-show-errors
Assert-AzSuccess "Resource group creation failed."

if (-not $SkipBudget) {
    if ($MonthlyBudgetUsd -eq 0) {
        $configuredBudget = Get-DotEnvValue "AZURE_MONTHLY_BUDGET_USD"
        if (-not $configuredBudget) { $configuredBudget = "40" }
        try { $MonthlyBudgetUsd = [decimal]$configuredBudget }
        catch { throw "AZURE_MONTHLY_BUDGET_USD must be a positive number." }
    }
    if ($MonthlyBudgetUsd -le 0) { throw "MonthlyBudgetUsd must be greater than zero." }
    Set-DotEnvValue "AZURE_MONTHLY_BUDGET_USD" ([string]$MonthlyBudgetUsd)
    if (-not $BudgetAlertEmail) { $BudgetAlertEmail = Get-DotEnvValue "AZURE_BUDGET_ALERT_EMAIL" }
    if (-not $BudgetAlertEmail) { $BudgetAlertEmail = Get-DotEnvValue "AZURE_ACCOUNT_EMAIL" }
    if (-not $BudgetAlertEmail -and [string]$account.user.name -match '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
        $BudgetAlertEmail = [string]$account.user.name
    }
    if ($BudgetAlertEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
        throw "A valid budget alert email is required. Pass -BudgetAlertEmail or set AZURE_BUDGET_ALERT_EMAIL in .env."
    }
    & (Join-Path $PSScriptRoot "create-budget.ps1") `
        -SubscriptionId $SubscriptionId `
        -AmountUsd $MonthlyBudgetUsd `
        -AlertEmail $BudgetAlertEmail `
        -ResourceGroup $ResourceGroup
}

az bicep version --only-show-errors 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    az bicep install
    Assert-AzSuccess "Azure Bicep CLI installation failed."
}

$deploymentParameters = @(
    "storageAccountName=$StorageAccountName",
    "functionAppName=$FunctionAppName",
    "allowedOrigins=$allowedOrigins",
    "rawCaptureRetentionDays=$RawCaptureRetentionDays",
    "derivedDataRetentionDays=$DerivedDataRetentionDays",
    "miniappApiToken=$MiniappApiToken",
    "ingestApiToken=$IngestApiToken",
    "processorApiToken=$ProcessorApiToken"
)

az deployment group validate `
    --resource-group $ResourceGroup `
    --template-file $templatePath `
    --parameters @deploymentParameters `
    --output none `
    --only-show-errors
Assert-AzSuccess "Azure deployment validation failed."

az deployment group what-if `
    --resource-group $ResourceGroup `
    --template-file $templatePath `
    --parameters @deploymentParameters `
    --result-format ResourceIdOnly `
    --only-show-errors
Assert-AzSuccess "Azure deployment preview failed."

$deploymentJson = az deployment group create `
    --name "curl-vision-platform" `
    --resource-group $ResourceGroup `
    --template-file $templatePath `
    --parameters @deploymentParameters `
    --output json `
    --only-show-errors
Assert-AzSuccess "Azure infrastructure deployment failed."
$deployment = $deploymentJson | ConvertFrom-Json
$functionUrl = $deployment.properties.outputs.functionUrl.value
$apiBase = "$functionUrl/api"

$workspaceResourceId = az resource show `
    --resource-group $ResourceGroup `
    --name "$FunctionAppName-ai" `
    --resource-type Microsoft.Insights/components `
    --api-version 2020-02-02 `
    --query properties.WorkspaceResourceId `
    --output tsv `
    --only-show-errors
Assert-AzSuccess "Could not resolve the Application Insights workspace."
if (-not $workspaceResourceId) { throw "Application Insights did not return a Log Analytics workspace resource ID." }
$quotaInvariant = $LogAnalyticsDailyQuotaGb.ToString([Globalization.CultureInfo]::InvariantCulture)
az resource update `
    --ids $workspaceResourceId `
    --api-version 2023-09-01 `
    --set "properties.workspaceCapping.dailyQuotaGb=$quotaInvariant" `
    --output none `
    --only-show-errors
Assert-AzSuccess "Could not set the Log Analytics daily ingestion safety cap."
$savedLogQuota = az resource show `
    --ids $workspaceResourceId `
    --api-version 2023-09-01 `
    --query properties.workspaceCapping.dailyQuotaGb `
    --output tsv `
    --only-show-errors
Assert-AzSuccess "Could not verify the Log Analytics daily ingestion safety cap."
if ([decimal]::Parse($savedLogQuota, [Globalization.CultureInfo]::InvariantCulture) -ne $LogAnalyticsDailyQuotaGb) {
    throw "Log Analytics daily ingestion safety cap verification failed."
}

# Save infrastructure output immediately after a successful deployment.
Set-DotEnvValue "AZURE_STORAGE_ACCOUNT_NAME" $StorageAccountName
Set-DotEnvValue "AZURE_CAPTURE_CONTAINER" "captures"
Set-DotEnvValue "AZURE_PROCESSED_CONTAINER" "processed"
Set-DotEnvValue "AZURE_FUNCTION_APP_NAME" $FunctionAppName
Set-DotEnvValue "AZURE_CAPTURE_API_BASE" $apiBase
Set-DotEnvValue "AZURE_AUTO_UPLOAD" "true"
if ($FoundryProjectEndpoint) {
    Set-DotEnvValue "FOUNDRY_PROJECT_ENDPOINT" $FoundryProjectEndpoint
    Set-DotEnvValue "AZURE_AI_PROJECT_ENDPOINT" $FoundryProjectEndpoint
}

$storageScope = az storage account show `
    --resource-group $ResourceGroup `
    --name $StorageAccountName `
    --query id `
    --output tsv `
    --only-show-errors
Assert-AzSuccess "Could not resolve the storage account resource ID."
$principalId = az ad signed-in-user show --query id --output tsv --only-show-errors
Assert-AzSuccess "Could not resolve the signed-in Azure user for Blob role assignment."
az role assignment create `
    --assignee-object-id $principalId `
    --assignee-principal-type User `
    --role "Storage Blob Data Contributor" `
    --scope $storageScope `
    --output none `
    --only-show-errors
Assert-AzSuccess "Could not grant passwordless Blob access. You may need User Access Administrator rights."

if (-not $SkipFunctionCode) {
    if (Get-Command func -ErrorAction SilentlyContinue) {
        Push-Location $functionsPath
        try {
            # Core Tools 4.12 does not reliably infer the Python v2 model from
            # function_app.py alone; make the runtime and remote build explicit.
            func azure functionapp publish $FunctionAppName --python --build remote --nozip
            Assert-AzSuccess "Azure Function code deployment failed."
        }
        finally {
            Pop-Location
        }
    }
    else {
        $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) "curl-vision-functions-$([guid]::NewGuid().ToString('N')).zip"
        try {
            Compress-Archive -Path (Join-Path $functionsPath "*") -DestinationPath $zipPath -Force
            az functionapp config appsettings set `
                --resource-group $ResourceGroup `
                --name $FunctionAppName `
                --settings SCM_DO_BUILD_DURING_DEPLOYMENT=true ENABLE_ORYX_BUILD=true `
                --output none `
                --only-show-errors
            Assert-AzSuccess "Could not enable remote Function build."
            az functionapp deployment source config-zip `
                --resource-group $ResourceGroup `
                --name $FunctionAppName `
                --src $zipPath `
                --build-remote true `
                --output none `
                --only-show-errors
            Assert-AzSuccess "Azure Function zip deployment failed."
        }
        finally {
            if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
        }
    }

    $health = Invoke-RestMethod -Uri "$apiBase/health" -Method Get
    if ($health.status -ne "ok") { throw "Azure Function health check failed." }
}

if ($FoundryProjectEndpoint) {
    & (Join-Path $PSScriptRoot "connect-foundry-storage.ps1") `
        -FoundryProjectEndpoint $FoundryProjectEndpoint
    if ($LASTEXITCODE -ne 0) { throw "Foundry-to-storage connection failed." }
}
else {
    Write-Host "Foundry storage link pending: set FOUNDRY_PROJECT_ENDPOINT, then run azure\connect-foundry-storage.ps1."
}

Write-Host "Azure capture platform is deployed and saved to .env."
Write-Host "Storage: $StorageAccountName"
Write-Host "Function API: $apiBase (Mentra routes require the saved Bearer token)"
Write-Host "Log Analytics daily ingestion safety cap: $quotaInvariant GB"
Write-Host "Desktop recording uses passwordless Blob upload through your Azure CLI identity."
