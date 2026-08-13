param(
    [string]$SubscriptionId = "",
    [decimal]$AmountUsd = 40,
    [string]$AlertEmail = "",
    [string]$BudgetName = "ai-javier-coach-monthly",
    [string]$ResourceGroup = "",
    [ValidateSet("ResourceGroup", "Subscription")]
    [string]$Scope = "ResourceGroup"
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

function Test-StringArrayEqual {
    param(
        [AllowNull()][object[]]$Actual,
        [AllowNull()][object[]]$Expected
    )

    $actualValues = @($Actual | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Sort-Object -Unique)
    $expectedValues = @($Expected | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Sort-Object -Unique)
    if ($actualValues.Count -ne $expectedValues.Count) { return $false }
    for ($index = 0; $index -lt $actualValues.Count; $index++) {
        if ($actualValues[$index] -cne $expectedValues[$index]) { return $false }
    }
    return $true
}

function Test-BudgetConfiguration {
    param(
        [AllowNull()][object]$Budget,
        [decimal]$ExpectedAmount,
        [hashtable]$ExpectedNotifications
    )

    if (-not $Budget) { return $false }
    if ([decimal]$Budget.amount -ne $ExpectedAmount) { return $false }
    if (-not ([string]$Budget.timeGrain).Equals("Monthly", [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    if (-not ([string]$Budget.category).Equals("Cost", [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    if (-not $Budget.notifications) { return $false }

    $actualNotificationProperties = @($Budget.notifications.PSObject.Properties)
    if ($actualNotificationProperties.Count -ne $ExpectedNotifications.Count) { return $false }

    foreach ($notificationName in $ExpectedNotifications.Keys) {
        $actualProperty = $Budget.notifications.PSObject.Properties[$notificationName]
        if (-not $actualProperty) { return $false }

        $actual = $actualProperty.Value
        $expected = $ExpectedNotifications[$notificationName]
        if ([bool]$actual.enabled -ne [bool]$expected.enabled) { return $false }
        if (-not ([string]$actual.operator).Equals([string]$expected.operator, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
        if ([decimal]$actual.threshold -ne [decimal]$expected.threshold) { return $false }
        # This Azure CLI budget API only creates actual-spend notifications and
        # normally omits thresholdType. Reject an explicit non-Actual value if
        # a newer API returns one, without sending an unsupported input field.
        if ($actual.PSObject.Properties["thresholdType"] -and
            -not ([string]$actual.thresholdType).Equals("Actual", [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
        if (-not (Test-StringArrayEqual -Actual @($actual.contactEmails) -Expected @($expected.contactEmails))) { return $false }
        if (-not (Test-StringArrayEqual -Actual @($actual.contactRoles) -Expected @($expected.contactRoles))) { return $false }
        if (-not (Test-StringArrayEqual -Actual @($actual.contactGroups) -Expected @($expected.contactGroups))) { return $false }
    }

    return $true
}

function Save-BudgetWithRest {
    param(
        [ValidateSet("ResourceGroup", "Subscription")]
        [string]$BudgetScope,
        [string]$Subscription,
        [string]$GroupName,
        [string]$Name,
        [decimal]$Amount,
        [hashtable]$DesiredNotifications,
        [AllowNull()][object]$ExistingBudget,
        [string]$NewStartDate = "",
        [string]$NewEndDate = ""
    )

    if ($ExistingBudget -and (-not $ExistingBudget.eTag -or -not $ExistingBudget.timePeriod)) {
        throw "The existing budget did not return an eTag and time period, so it cannot be updated safely."
    }
    if (-not $ExistingBudget -and (-not $NewStartDate -or -not $NewEndDate)) {
        throw "A new budget requires a start and end date."
    }

    $restNotifications = @{}
    foreach ($notificationName in $DesiredNotifications.Keys) {
        $notification = $DesiredNotifications[$notificationName]
        $restNotifications[$notificationName] = @{
            enabled = [bool]$notification.enabled
            operator = [string]$notification.operator
            threshold = [decimal]$notification.threshold
            thresholdType = "Actual"
            contactEmails = @($notification.contactEmails)
            contactRoles = @($notification.contactRoles)
            contactGroups = @($notification.contactGroups)
        }
    }
    $budgetStartDate = if ($ExistingBudget) { [string]$ExistingBudget.timePeriod.startDate } else { $NewStartDate }
    $budgetEndDate = if ($ExistingBudget) { [string]$ExistingBudget.timePeriod.endDate } else { $NewEndDate }
    $properties = @{
        category = "Cost"
        amount = $Amount
        timeGrain = "Monthly"
        timePeriod = @{
            # Azure budget start dates are immutable, so preserve the exact
            # existing period while changing amount/grain/notifications.
            startDate = $budgetStartDate
            endDate = $budgetEndDate
        }
        notifications = $restNotifications
    }
    if ($ExistingBudget -and $ExistingBudget.filter) { $properties.filter = $ExistingBudget.filter }
    $payload = @{ properties = $properties }
    if ($ExistingBudget) { $payload.eTag = [string]$ExistingBudget.eTag }
    $body = $payload | ConvertTo-Json -Depth 10 -Compress

    $tokenJson = az account get-access-token --resource https://management.azure.com/ --output json --only-show-errors 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $tokenJson) { throw "Could not acquire an Azure management token for the budget update." }
    $accessToken = [string](($tokenJson | ConvertFrom-Json).accessToken)
    if (-not $accessToken) { throw "Azure returned an empty management token for the budget update." }
    $scopePath = "/subscriptions/$Subscription"
    if ($BudgetScope -eq "ResourceGroup") {
        $scopePath += "/resourceGroups/$([uri]::EscapeDataString($GroupName))"
    }
    $encodedName = [uri]::EscapeDataString($Name)
    $uri = "https://management.azure.com$scopePath/providers/Microsoft.Consumption/budgets/${encodedName}?api-version=2023-11-01"
    $headers = @{ Authorization = "Bearer $accessToken" }
    if ($ExistingBudget) { $headers["If-Match"] = [string]$ExistingBudget.eTag }
    try {
        $null = Invoke-RestMethod -UseBasicParsing -Uri $uri -Method Put -Headers $headers -ContentType "application/json" -Body $body
    }
    catch {
        $operation = if ($ExistingBudget) { "eTag-protected update" } else { "creation" }
        throw "Azure rejected the $BudgetScope budget $operation`: $($_.Exception.Message)"
    }
    finally {
        $accessToken = $null
        $headers = $null
    }
}

if ($AmountUsd -le 0) { throw "AmountUsd must be greater than zero." }
if (-not $SubscriptionId) { $SubscriptionId = Get-DotEnvValue "AZURE_SUBSCRIPTION_ID" }
if (-not $ResourceGroup) { $ResourceGroup = Get-DotEnvValue "AZURE_RESOURCE_GROUP" }
if (-not $AlertEmail) { $AlertEmail = Get-DotEnvValue "AZURE_BUDGET_ALERT_EMAIL" }
if (-not $AlertEmail) { $AlertEmail = Get-DotEnvValue "AZURE_ACCOUNT_EMAIL" }
if (-not $SubscriptionId) { throw "A real AZURE_SUBSCRIPTION_ID is required before creating a budget." }
if ($Scope -eq "ResourceGroup" -and -not $ResourceGroup) { throw "A real AZURE_RESOURCE_GROUP is required for a resource-group budget." }
if ($AlertEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw "A valid alert email is required." }

az account set --subscription $SubscriptionId --only-show-errors
if ($LASTEXITCODE -ne 0) { throw "The signed-in account cannot access subscription $SubscriptionId." }

$now = (Get-Date).ToUniversalTime()
$startDate = Get-Date -Date $now -Day 1 -Hour 0 -Minute 0 -Second 0 -Millisecond 0
$endDate = $startDate.AddYears(10).AddDays(-1)
$timePeriod = @{
    startDate = $startDate.ToString("yyyy-MM-ddTHH:mm:ssZ")
    endDate = $endDate.ToString("yyyy-MM-ddTHH:mm:ssZ")
} | ConvertTo-Json -Compress
$expectedNotifications = @{
    Actual_50_Percent = @{ enabled = $true; operator = "GreaterThan"; threshold = 50; contactEmails = @($AlertEmail); contactRoles = @(); contactGroups = @() }
    Actual_80_Percent = @{ enabled = $true; operator = "GreaterThan"; threshold = 80; contactEmails = @($AlertEmail); contactRoles = @(); contactGroups = @() }
    Actual_100_Percent = @{ enabled = $true; operator = "GreaterThan"; threshold = 100; contactEmails = @($AlertEmail); contactRoles = @(); contactGroups = @() }
}
$notifications = $expectedNotifications | ConvertTo-Json -Depth 8 -Compress

$timePath = [System.IO.Path]::GetTempFileName()
$notificationsPath = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllText($timePath, $timePeriod, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($notificationsPath, $notifications, [System.Text.UTF8Encoding]::new($false))
    # A missing budget is the normal create path. Windows PowerShell converts
    # Azure CLI stderr into a terminating NativeCommandError under Stop, so
    # suppress it only around this existence probe and inspect the exit code.
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        if ($Scope -eq "ResourceGroup") {
            $existingJson = az consumption budget show-with-rg --budget-name $BudgetName --resource-group $ResourceGroup --subscription $SubscriptionId --output json --only-show-errors 2>$null
        }
        else {
            $existingJson = az consumption budget show --budget-name $BudgetName --subscription $SubscriptionId --output json --only-show-errors 2>$null
        }
        $existingExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    $existing = $null
    if ($existingExitCode -eq 0 -and $existingJson) { $existing = $existingJson | ConvertFrom-Json }
    if (Test-BudgetConfiguration -Budget $existing -ExpectedAmount $AmountUsd -ExpectedNotifications $expectedNotifications) {
        # An already-correct budget is the safest idempotent outcome. Azure's
        # Cost Management API can rotate eTags between read and update calls.
        $saved = $existing
    }
    else {
        if ($existing) {
            Save-BudgetWithRest -BudgetScope $Scope -Subscription $SubscriptionId `
                -GroupName $ResourceGroup -Name $BudgetName -Amount $AmountUsd `
                -DesiredNotifications $expectedNotifications -ExistingBudget $existing
            if ($Scope -eq "ResourceGroup") {
                $savedJson = az consumption budget show-with-rg --budget-name $BudgetName --resource-group $ResourceGroup --subscription $SubscriptionId --output json --only-show-errors
            }
            else {
                $savedJson = az consumption budget show --budget-name $BudgetName --subscription $SubscriptionId --output json --only-show-errors
            }
            if ($LASTEXITCODE -ne 0 -or -not $savedJson) { throw "The updated $Scope budget could not be verified." }
            $saved = $savedJson | ConvertFrom-Json
        }
        elseif ($Scope -eq "ResourceGroup") {
            $args = @(
                "consumption", "budget", "create-with-rg", "--name", $BudgetName,
                "--resource-group", $ResourceGroup, "--subscription", $SubscriptionId
            )
            $args += @(
                "--amount", ([string]$AmountUsd), "--category", "Cost", "--time-grain", "Monthly",
                "--time-period", "@$timePath", "--notifications", "@$notificationsPath",
                "--output", "json", "--only-show-errors"
            )
            $savedJson = & az @args
            if ($LASTEXITCODE -ne 0) { throw "Azure rejected the $Scope budget. Cost Management may not be ready for this subscription." }
            $saved = $savedJson | ConvertFrom-Json
        }
        else {
            Save-BudgetWithRest -BudgetScope $Scope -Subscription $SubscriptionId `
                -GroupName $ResourceGroup -Name $BudgetName -Amount $AmountUsd `
                -DesiredNotifications $expectedNotifications -ExistingBudget $null `
                -NewStartDate $startDate.ToString("yyyy-MM-ddTHH:mm:ssZ") `
                -NewEndDate $endDate.ToString("yyyy-MM-ddTHH:mm:ssZ")
            $savedJson = az consumption budget show --budget-name $BudgetName --subscription $SubscriptionId --output json --only-show-errors
            if ($LASTEXITCODE -ne 0 -or -not $savedJson) { throw "The created $Scope budget could not be verified." }
            $saved = $savedJson | ConvertFrom-Json
        }
    }
    if (-not (Test-BudgetConfiguration -Budget $saved -ExpectedAmount $AmountUsd -ExpectedNotifications $expectedNotifications)) {
        throw "Budget verification failed: amount, time grain, or notifications differ from the requested guardrail."
    }
}
finally {
    foreach ($tempPath in @($timePath, $notificationsPath)) {
        if ($tempPath -and (Test-Path -LiteralPath $tempPath)) { Remove-Item -LiteralPath $tempPath -Force }
    }
}

Set-DotEnvValue "AZURE_MONTHLY_BUDGET_USD" ([string]$AmountUsd)
Set-DotEnvValue "AZURE_BUDGET_ALERT_EMAIL" $AlertEmail
Set-DotEnvValue "AZURE_BUDGET_NAME" $BudgetName
Set-DotEnvValue "AZURE_BUDGET_TIME_GRAIN" "Monthly"
Set-DotEnvValue "AZURE_BUDGET_SCOPE" $Scope
if ($Scope -eq "ResourceGroup") {
    Set-DotEnvValue "AZURE_BUDGET_SCOPE_ID" "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup"
}
else {
    Set-DotEnvValue "AZURE_BUDGET_SCOPE_ID" "/subscriptions/$SubscriptionId"
}

Write-Host "Azure $Scope monthly budget saved: USD $AmountUsd"
Write-Host "Actual-spend alerts: 50%, 80%, 100% -> $AlertEmail"
Write-Warning "Azure budgets send alerts but do not stop resources or guarantee a hard spending cap."
