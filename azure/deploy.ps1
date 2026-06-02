param(
    [string]$ResourceGroup = "rg-curl-vision-trainer",
    [string]$Location = "eastus",
    [string]$StorageAccountName = "curlvision$((Get-Random -Maximum 999999).ToString('000000'))",
    [string]$FunctionAppName = "curl-vision-capture-$((Get-Random -Maximum 999999).ToString('000000'))"
)

$ErrorActionPreference = "Stop"

az group create --name $ResourceGroup --location $Location

$deploymentOutput = az deployment group create `
    --resource-group $ResourceGroup `
    --template-file "$PSScriptRoot/infra/main.bicep" `
    --parameters storageAccountName=$StorageAccountName functionAppName=$FunctionAppName `
    --output json

if ($LASTEXITCODE -ne 0) {
    throw "Azure infrastructure deployment failed. Check quota, region, and subscription permissions."
}

$deployment = $deploymentOutput | ConvertFrom-Json
$functionUrl = $deployment.properties.outputs.functionUrl.value

Write-Host "Function URL: $functionUrl"
Write-Host "Deploy functions with:"
Write-Host "cd azure/functions"
Write-Host "func azure functionapp publish $FunctionAppName"
