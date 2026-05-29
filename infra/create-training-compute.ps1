param(
    [string]$SubscriptionId = "YOUR_SUBSCRIPTION_ID",
    [string]$ResourceGroup = "rg-curl-vision-trainer",
    [string]$WorkspaceName = "YOUR_AZURE_ML_WORKSPACE_NAME"
)

az account set --subscription $SubscriptionId

az ml compute create `
  --resource-group $ResourceGroup `
  --workspace-name $WorkspaceName `
  --file ./infra/compute-cpu.yml
