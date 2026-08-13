param location string = resourceGroup().location
param containerAppName string
param environmentName string
param registryName string
param pullIdentityName string
param imageTag string
param packageName string
param websocketAllowedHosts string
param azureCaptureApiBase string
param rtmpsStreamUrl string
param operatorName string
param supportEmail string
@minValue(1)
param rawCaptureRetentionDays int = 30
@minValue(1)
param derivedDataRetentionDays int = 365
@minValue(300)
@maxValue(14400)
param streamAuthTtlSeconds int = 14400

@secure()
param mentraApiKey string
@secure()
param cookieSecret string
@secure()
param miniappApiToken string
@secure()
param streamKeySecret string
@secure()
param profileIdSecret string

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: pullIdentityName
}

var publicUrl = 'https://${containerAppName}.${environment.properties.defaultDomain}'

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pullIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 3000
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        transport: 'auto'
      }
      registries: [
        {
          identity: pullIdentity.id
          server: registry.properties.loginServer
        }
      ]
      secrets: [
        {
          name: 'mentra-api-key'
          value: mentraApiKey
        }
        {
          name: 'cookie-secret'
          value: cookieSecret
        }
        {
          name: 'miniapp-api-token'
          value: miniappApiToken
        }
        {
          name: 'stream-key-secret'
          value: streamKeySecret
        }
        {
          name: 'profile-id-secret'
          value: profileIdSecret
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'miniapp'
          image: '${registry.properties.loginServer}/ai-javier-miniapp:${imageTag}'
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'PACKAGE_NAME'
              value: packageName
            }
            {
              name: 'MENTRA_MINIAPP_PUBLIC_URL'
              value: publicUrl
            }
            {
              name: 'MENTRA_WEBSOCKET_ALLOWED_HOSTS'
              value: websocketAllowedHosts
            }
            {
              name: 'AZURE_CAPTURE_API_BASE'
              value: azureCaptureApiBase
            }
            {
              name: 'MENTRA_STREAM_BASE_URL'
              value: rtmpsStreamUrl
            }
            {
              name: 'APP_OPERATOR_NAME'
              value: operatorName
            }
            {
              name: 'SUPPORT_EMAIL'
              value: supportEmail
            }
            {
              name: 'AZURE_RAW_CAPTURE_RETENTION_DAYS'
              value: string(rawCaptureRetentionDays)
            }
            {
              name: 'AZURE_DERIVED_DATA_RETENTION_DAYS'
              value: string(derivedDataRetentionDays)
            }
            {
              name: 'MENTRA_STREAM_AUTH_TTL_SECONDS'
              value: string(streamAuthTtlSeconds)
            }
            {
              name: 'MENTRA_DISABLE_UNUSED_ENDPOINTS'
              value: 'true'
            }
            {
              name: 'MENTRAOS_API_KEY'
              secretRef: 'mentra-api-key'
            }
            {
              name: 'COOKIE_SECRET'
              secretRef: 'cookie-secret'
            }
            {
              name: 'AZURE_MINIAPP_API_TOKEN'
              secretRef: 'miniapp-api-token'
            }
            {
              name: 'STREAM_KEY_SECRET'
              secretRef: 'stream-key-secret'
            }
            {
              name: 'PROFILE_ID_SECRET'
              secretRef: 'profile-id-secret'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
              successThreshold: 1
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        // Keep one small replica warm so Mentra's session webhook does not hit
        // a long Container Apps cold start. The minimum supported 0.25/0.5Gi
        // allocation controls idle cost while preserving launch reliability.
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output miniappUrl string = publicUrl
output latestRevisionName string = containerApp.properties.latestRevisionName
