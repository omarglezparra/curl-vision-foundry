param(
    [switch]$ConfirmAzureSpend,
    [Parameter(Mandatory = $true)]
    [string]$AdminSourceCidr,
    [string]$SshPublicKeyPath = "",
    [string]$SshPrivateKeyPath = "",
    [string]$ResourceGroup = "",
    [string]$Location = "",
    [string]$VmName = "ai-javier-ingest",
    [string]$DnsLabel = "",
    [string]$AdminUsername = "azurecoach",
    [string]$VmSize = "",
    [ValidateSet("", "1", "2", "3")]
    [string]$AvailabilityZone = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env"
$ingestSource = Join-Path $repoRoot "mentra-ingest"
$templatePath = Join-Path $PSScriptRoot "infra\ingest-vm.bicep"

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

function Require-Value {
    param([string]$Name)
    $value = Get-DotEnvValue $Name
    if (-not $value -or $value -match '(?i)(replace[-_ ]|your[-_ ]|example|<[^>]+>)') {
        throw "$Name must be configured with a real value in .env."
    }
    if ($value.Contains("`r") -or $value.Contains("`n")) { throw "$Name cannot contain line breaks." }
    return $value
}

if (-not $ConfirmAzureSpend) {
    throw "No resources were created. Rerun with -ConfirmAzureSpend only after approving VM, disk, and public-IP charges."
}
if ($AdminSourceCidr -in @('0.0.0.0/0', '::/0', '*')) {
    throw "AdminSourceCidr must restrict SSH to the operator's public IP, not the entire internet."
}
if ($AdminSourceCidr -notmatch '^\d{1,3}(?:\.\d{1,3}){3}/(?:[0-9]|[12][0-9]|3[0-2])$') {
    throw "AdminSourceCidr must be an IPv4 CIDR such as 203.0.113.10/32."
}
if ([int]($AdminSourceCidr -split '/')[1] -eq 0) {
    throw "AdminSourceCidr must restrict SSH to the operator's public IP, not the entire internet."
}

if (-not $SshPublicKeyPath) {
    $dedicatedPublicKey = Join-Path $env:USERPROFILE ".ssh\ai_javier_mentra_ed25519.pub"
    $SshPublicKeyPath = if (Test-Path -LiteralPath $dedicatedPublicKey) { $dedicatedPublicKey } else { Join-Path $env:USERPROFILE ".ssh\id_ed25519.pub" }
}
if (-not $SshPrivateKeyPath) {
    $dedicatedPrivateKey = Join-Path $env:USERPROFILE ".ssh\ai_javier_mentra_ed25519"
    $SshPrivateKeyPath = if (Test-Path -LiteralPath $dedicatedPrivateKey) { $dedicatedPrivateKey } else { Join-Path $env:USERPROFILE ".ssh\id_ed25519" }
}
if (-not (Test-Path -LiteralPath $SshPublicKeyPath) -or -not (Test-Path -LiteralPath $SshPrivateKeyPath)) {
    throw "An Ed25519 SSH key pair is required. Create one with ssh-keygen, then pass both key paths."
}
$sshPublicKey = (Get-Content -LiteralPath $SshPublicKeyPath -Raw).Trim()
if ($sshPublicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+(?:\s+.*)?$') {
    throw "SshPublicKeyPath must contain an Ed25519 public key."
}

$captureApiBase = Require-Value "AZURE_CAPTURE_API_BASE"
$ingestToken = Require-Value "AZURE_INGEST_API_TOKEN"
$streamSecret = Require-Value "MENTRA_STREAM_KEY_SECRET"
$supportEmail = Require-Value "SUPPORT_EMAIL"
if ($captureApiBase -notmatch '^https://') { throw "AZURE_CAPTURE_API_BASE must use HTTPS." }
if ($ingestToken.Length -lt 32 -or $streamSecret.Length -lt 32) { throw "Ingest and stream secrets must contain at least 32 characters." }
if ($supportEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw "SUPPORT_EMAIL must be valid for certificate notices." }

if (-not $ResourceGroup) { $ResourceGroup = Get-DotEnvValue "AZURE_RESOURCE_GROUP" }
if (-not $Location) { $Location = Get-DotEnvValue "AZURE_INGEST_LOCATION" }
if (-not $Location) { $Location = Get-DotEnvValue "AZURE_LOCATION" }
if (-not $VmSize) { $VmSize = Get-DotEnvValue "AZURE_INGEST_VM_SIZE" }
if (-not $VmSize) { $VmSize = "Standard_B2als_v2" }
if (-not $AvailabilityZone) { $AvailabilityZone = Get-DotEnvValue "AZURE_INGEST_AVAILABILITY_ZONE" }
if (-not $ResourceGroup -or -not $Location) { throw "Run azure\deploy.ps1 first." }
if ($Location -notmatch '^[a-z0-9]+$') { throw "Location must be an Azure region name such as westus3." }
if ($VmSize -notmatch '^Standard_[A-Za-z0-9_]+$|^Basic_[A-Za-z0-9_]+$') { throw "VmSize is not a valid Azure VM SKU name." }
if (-not $DnsLabel) { $DnsLabel = Get-DotEnvValue "AZURE_INGEST_DNS_LABEL" }
if (-not $DnsLabel) { $DnsLabel = "ai-javier-ingest-$((Get-Random -Maximum 999999).ToString('000000'))" }
if ($DnsLabel -notmatch '^[a-z][a-z0-9-]{2,61}[a-z0-9]$') { throw "DnsLabel is not a valid Azure DNS label." }

$accountJson = az account show --output json --only-show-errors 2>$null
Assert-AzSuccess "Azure CLI is signed out. Run az login first."
$account = $accountJson | ConvertFrom-Json
$subscriptionId = Get-DotEnvValue "AZURE_SUBSCRIPTION_ID"
if (-not $subscriptionId) { $subscriptionId = $account.id }
az account set --subscription $subscriptionId --only-show-errors
Assert-AzSuccess "Could not select Azure subscription $subscriptionId."
$groupExists = az group exists --name $ResourceGroup --output tsv --only-show-errors
Assert-AzSuccess "Could not check resource group $ResourceGroup."
if ($groupExists -ne 'true') { throw "Resource group $ResourceGroup does not exist. Run azure\deploy.ps1 first." }

$parameters = @(
    "location=$Location",
    "vmName=$VmName",
    "publicIpName=$VmName-ip",
    "networkSecurityGroupName=$VmName-nsg",
    "virtualNetworkName=$VmName-vnet",
    "networkInterfaceName=$VmName-nic",
    "dnsLabel=$DnsLabel",
    "adminUsername=$AdminUsername",
    "adminSshPublicKey=$sshPublicKey",
    "adminSourceCidr=$AdminSourceCidr",
    "vmSize=$VmSize"
)
if ($AvailabilityZone) { $parameters += "availabilityZone=$AvailabilityZone" }
az deployment group validate --resource-group $ResourceGroup --template-file $templatePath --parameters @parameters --output none --only-show-errors
Assert-AzSuccess "RTMPS VM validation failed."
az deployment group what-if --resource-group $ResourceGroup --template-file $templatePath --parameters @parameters --result-format ResourceIdOnly --only-show-errors
Assert-AzSuccess "RTMPS VM preview failed."
$deploymentJson = az deployment group create --name "ai-javier-ingest" --resource-group $ResourceGroup --template-file $templatePath --parameters @parameters --output json --only-show-errors
Assert-AzSuccess "RTMPS VM deployment failed."
$deployment = $deploymentJson | ConvertFrom-Json
$domain = [string]$deployment.properties.outputs.rtmpsDomain.value
$publicIpAddress = [string]$deployment.properties.outputs.publicIpAddress.value
if ($domain -notmatch '^[a-z0-9.-]+$' -or $publicIpAddress -notmatch '^\d{1,3}(?:\.\d{1,3}){3}$') {
    throw "Azure did not return a valid ingest DNS name and public IP address."
}

$dnsReady = $false
for ($attempt = 1; $attempt -le 36; $attempt++) {
    try {
        $resolvedAddresses = @(
            Resolve-DnsName -Name $domain -Type A -ErrorAction Stop |
                Where-Object { $_.IPAddress } |
                Select-Object -ExpandProperty IPAddress
        )
        if ($publicIpAddress -in $resolvedAddresses) {
            $dnsReady = $true
            break
        }
    }
    catch {
        # Azure DNS labels can take a short time to become globally resolvable.
    }
    Start-Sleep -Seconds 5
}
if (-not $dnsReady) { throw "The Azure ingest DNS name did not resolve to $publicIpAddress within three minutes." }

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ai-javier-ingest-$([guid]::NewGuid().ToString('N'))"
$remoteStage = "/tmp/$([System.IO.Path]::GetFileName($stagingRoot))"
if ($remoteStage -notmatch '^/tmp/ai-javier-ingest-[a-f0-9]{32}$') {
    throw "Refusing an unexpected remote staging path."
}
try {
    New-Item -ItemType Directory -Path $stagingRoot | Out-Null
    Get-ChildItem -LiteralPath $ingestSource -Force | Where-Object {
        $_.Name -notin @('.env', 'certs', 'recordings', '__pycache__')
    } | Copy-Item -Destination $stagingRoot -Recurse -Force
    $runtimeEnv = @(
        "AZURE_CAPTURE_API_BASE=$captureApiBase",
        "AZURE_INGEST_API_TOKEN=$ingestToken",
        "STREAM_KEY_SECRET=$streamSecret",
        "STREAM_AUTH_MAX_TTL_SECONDS=14400",
        "STREAM_AUTH_CLOCK_SKEW_SECONDS=60",
        "RETRY_INTERVAL_SECONDS=60",
        "STALE_CLAIM_SECONDS=300",
        "FAILED_SEGMENT_RETENTION_SECONDS=86400",
        "RETRY_WORKER_HEALTH_MAX_AGE_SECONDS=300",
        "RTMPS_DOMAIN=$domain",
        "RTMPS_CERT_DIR=/opt/ai-javier-ingest/certs"
    )
    $runtimeEnvText = ($runtimeEnv -join "`n") + "`n"
    [System.IO.File]::WriteAllText((Join-Path $stagingRoot '.env'), $runtimeEnvText, [System.Text.UTF8Encoding]::new($false))

    $sshOptions = @('-i', $SshPrivateKeyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15')
    $sshTarget = "$AdminUsername@$publicIpAddress"
    & ssh.exe @sshOptions $sshTarget "cloud-init status --wait"
    if ($LASTEXITCODE -ne 0) { throw "VM initialization or SSH failed." }
    & ssh.exe @sshOptions $sshTarget "mkdir -p '$remoteStage'"
    if ($LASTEXITCODE -ne 0) { throw "Could not create the remote staging directory." }
    & scp.exe @sshOptions -r "$stagingRoot\." "$sshTarget`:$remoteStage"
    if ($LASTEXITCODE -ne 0) { throw "Could not upload the ingest application." }

    $remoteSetup = "sudo cp -a '$remoteStage/.' /opt/ai-javier-ingest/app/ && sudo chown -R '$AdminUsername`:$AdminUsername' /opt/ai-javier-ingest/app && sudo chmod 0600 /opt/ai-javier-ingest/app/.env && sudo certbot certonly --standalone --non-interactive --agree-tos --email '$supportEmail' --domains '$domain' && sudo install -o root -g root -m 0755 /opt/ai-javier-ingest/app/deploy/refresh-certificate.sh /usr/local/sbin/ai-javier-refresh-certificate && sudo install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy && sudo ln -sfn /usr/local/sbin/ai-javier-refresh-certificate /etc/letsencrypt/renewal-hooks/deploy/ai-javier-ingest && sudo /usr/local/sbin/ai-javier-refresh-certificate && sudo docker compose -f /opt/ai-javier-ingest/app/compose.production.yml config --quiet && sudo docker compose -f /opt/ai-javier-ingest/app/compose.production.yml up --build -d && rm -rf -- '$remoteStage'"
    & ssh.exe @sshOptions $sshTarget $remoteSetup
    if ($LASTEXITCODE -ne 0) { throw "Remote certificate or ingest container setup failed." }
}
finally {
    if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
}

$tlsReady = $false
for ($attempt = 1; $attempt -le 24; $attempt++) {
    $tcp = [System.Net.Sockets.TcpClient]::new()
    try {
        $connectTask = $tcp.ConnectAsync($domain, 1936)
        if (-not $connectTask.Wait([TimeSpan]::FromSeconds(10))) { throw "RTMPS connection timed out." }
        $tls = [System.Net.Security.SslStream]::new($tcp.GetStream(), $false)
        try {
            $tls.AuthenticateAsClient($domain)
            $tlsReady = $true
            break
        }
        finally { $tls.Dispose() }
    }
    catch {
        if ($attempt -eq 24) { break }
        Start-Sleep -Seconds 5
    }
    finally { $tcp.Dispose() }
}
if (-not $tlsReady) { throw "RTMPS did not become TLS-ready at $domain`:1936 within two minutes." }

Set-DotEnvValue "AZURE_INGEST_DNS_LABEL" $DnsLabel
Set-DotEnvValue "AZURE_INGEST_LOCATION" $Location
Set-DotEnvValue "AZURE_INGEST_VM_SIZE" $VmSize
Set-DotEnvValue "AZURE_INGEST_AVAILABILITY_ZONE" $AvailabilityZone
Set-DotEnvValue "RTMPS_DOMAIN" $domain
Set-DotEnvValue "MENTRA_STREAM_BASE_URL" "rtmps://$domain`:1936/live"
Write-Host "RTMPS ingest is healthy at rtmps://$domain`:1936/live"
Write-Host "Run setup-mentra-env.ps1 again before deploying the MiniApp so it receives this URL."
