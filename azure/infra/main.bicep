param location string = resourceGroup().location
param storageAccountName string
param functionAppName string
param allowedOrigins string = 'https://omarglezparra.github.io,http://localhost:8080,http://127.0.0.1:8080'
@description('Delete raw capture blobs after this many days without modification.')
@minValue(1)
param rawCaptureRetentionDays int = 30
@description('Delete derived-data blobs after this many days without modification.')
@minValue(1)
param derivedDataRetentionDays int = 365
@secure()
param miniappApiToken string
@secure()
param ingestApiToken string
@secure()
param processorApiToken string

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    cors: {
      corsRules: [
        {
          allowedOrigins: split(allowedOrigins, ',')
          allowedMethods: [
            'PUT'
            'OPTIONS'
          ]
          maxAgeInSeconds: 86400
          exposedHeaders: [
            '*'
          ]
          allowedHeaders: [
            '*'
          ]
        }
      ]
    }
  }
}

resource captures 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'captures'
  properties: {
    publicAccess: 'None'
  }
}

resource processed 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'processed'
  properties: {
    publicAccess: 'None'
  }
}

resource storageManagementPolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          enabled: true
          name: 'delete-raw-captures'
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: rawCaptureRetentionDays
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'captures/'
              ]
            }
          }
        }
        {
          enabled: true
          name: 'delete-derived-data'
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: derivedDataRetentionDays
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'processed/'
              ]
            }
          }
        }
      ]
    }
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${functionAppName}-plan'
  location: location
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true
  }
  kind: 'linux'
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${functionAppName}-ai'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    reserved: true
    siteConfig: {
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=core.windows.net'
        }
        {
          name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=core.windows.net'
        }
        {
          name: 'WEBSITE_CONTENTSHARE'
          value: toLower(functionAppName)
        }
        {
          name: 'CAPTURE_STORAGE_CONNECTION_STRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=core.windows.net'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'python'
        }
        {
          name: 'CAPTURE_CONTAINER'
          value: 'captures'
        }
        {
          name: 'PROCESSED_CONTAINER'
          value: 'processed'
        }
        {
          name: 'AZURE_MINIAPP_API_TOKEN'
          value: miniappApiToken
        }
        {
          name: 'AZURE_INGEST_API_TOKEN'
          value: ingestApiToken
        }
        {
          name: 'AZURE_PROCESSOR_API_TOKEN'
          value: processorApiToken
        }
        {
          name: 'ALLOWED_ORIGINS'
          value: allowedOrigins
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsights.properties.ConnectionString
        }
      ]
      cors: {
        allowedOrigins: split(allowedOrigins, ',')
        supportCredentials: false
      }
      linuxFxVersion: 'Python|3.11'
    }
  }
}

output functionUrl string = 'https://${functionApp.properties.defaultHostName}'
output storageName string = storage.name
output rawCaptureRetentionDays int = rawCaptureRetentionDays
output derivedDataRetentionDays int = derivedDataRetentionDays
