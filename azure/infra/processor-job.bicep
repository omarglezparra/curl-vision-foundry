param location string = resourceGroup().location
param jobName string = 'ai-javier-processor'
param processorIdentityName string = 'ai-javier-processor'
param environmentName string
param registryName string
param pullIdentityName string
param storageAccountName string
param imageTag string
param scheduleCron string = '*/15 * * * *'
@minValue(1)
@maxValue(3650)
param derivedDataRetentionDays int = 365

var storageBlobDataContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: pullIdentityName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource processorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: processorIdentityName
  location: location
}

resource storageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, processorIdentity.id, storageBlobDataContributorRoleId)
  scope: storage
  properties: {
    principalId: processorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

resource processorJob 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pullIdentity.id}': {}
      '${processorIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      registries: [
        {
          identity: pullIdentity.id
          server: registry.properties.loginServer
        }
      ]
      replicaRetryLimit: 1
      replicaTimeout: 7200
      scheduleTriggerConfig: {
        cronExpression: scheduleCron
        parallelism: 1
        replicaCompletionCount: 1
      }
      triggerType: 'Schedule'
    }
    template: {
      containers: [
        {
          name: 'processor'
          image: '${registry.properties.loginServer}/ai-javier-processor:${imageTag}'
          env: [
            {
              name: 'AZURE_CLIENT_ID'
              value: processorIdentity.properties.clientId
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_NAME'
              value: storage.name
            }
            {
              name: 'AZURE_CAPTURE_CONTAINER'
              value: 'captures'
            }
            {
              name: 'AZURE_PROCESSED_CONTAINER'
              value: 'processed'
            }
            {
              name: 'AZURE_DERIVED_DATA_RETENTION_DAYS'
              value: string(derivedDataRetentionDays)
            }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
    }
  }
}

output jobName string = processorJob.name
output processorIdentityName string = processorIdentity.name
