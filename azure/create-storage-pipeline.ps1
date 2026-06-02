param(
    [string]$ResourceGroup = "rg-curl-vision-trainer",
    [string]$Location = "eastus",
    [string]$StorageAccountName = "curlvision$((Get-Random -Maximum 999999).ToString('000000'))",
    [int]$SasDays = 14
)

$ErrorActionPreference = "Stop"

az group create --name $ResourceGroup --location $Location | Out-Null

az storage account create `
    --resource-group $ResourceGroup `
    --name $StorageAccountName `
    --location $Location `
    --sku Standard_LRS `
    --kind StorageV2 `
    --https-only true `
    --allow-blob-public-access false | Out-Null

$accountKey = az storage account keys list `
    --resource-group $ResourceGroup `
    --account-name $StorageAccountName `
    --query "[0].value" `
    --output tsv

az storage container create `
    --account-name $StorageAccountName `
    --account-key $accountKey `
    --name captures `
    --public-access off | Out-Null

az storage container create `
    --account-name $StorageAccountName `
    --account-key $accountKey `
    --name processed `
    --public-access off | Out-Null

az storage cors clear `
    --account-name $StorageAccountName `
    --account-key $accountKey `
    --services b | Out-Null

az storage cors add `
    --account-name $StorageAccountName `
    --account-key $accountKey `
    --services b `
    --methods PUT OPTIONS `
    --origins "https://omarglezparra.github.io" "http://localhost:8080" "http://127.0.0.1:8080" `
    --allowed-headers "*" `
    --exposed-headers "*" `
    --max-age 86400 | Out-Null

$expiry = (Get-Date).ToUniversalTime().AddDays($SasDays).ToString("yyyy-MM-ddTHH:mmZ")
$sas = az storage container generate-sas `
    --account-name $StorageAccountName `
    --account-key $accountKey `
    --name captures `
    --permissions acw `
    --expiry $expiry `
    --https-only `
    --output tsv

$containerSasUrl = "https://$StorageAccountName.blob.core.windows.net/captures?$sas"

Write-Host "Storage account: $StorageAccountName"
Write-Host "Capture container SAS expires: $expiry"
Write-Host ""
Write-Host "Paste this into the iPhone app Azure Blob SAS field:"
Write-Host $containerSasUrl
