# Mentra Store submission sheet

## Listing

- Package name: `com.aijaviercoach.ml1` (create once; the console does not import it)
- Display name: AI Javier Coach
- Version: 0.1.0
- App type: Standard
- Description: Record a hands-free curl workout with Mentra Live, analyze repetitions and form in Azure, and review performance from the phone webview.
- Server URL: `https://ai-javier-coach.yellowmoss-ace59a4f.eastus.azurecontainerapps.io`
- Webview URL: `https://ai-javier-coach.yellowmoss-ace59a4f.eastus.azurecontainerapps.io/webview`
- Logo: `https://ai-javier-coach.yellowmoss-ace59a4f.eastus.azurecontainerapps.io/assets/app-icon.png`
  or `public/assets/app-icon.png` (512×512 PNG)

Generate an importable config after deployment:

```powershell
./generate-app-config.ps1 -PublicUrl "https://ai-javier-coach.yellowmoss-ace59a4f.eastus.azurecontainerapps.io"
```

## Console-only declarations

The current config importer does not apply hardware requirements or external preview images. Set these manually:

- Permission: `CAMERA` — “Record the workout only after the user presses Start so AI Javier can analyze curl repetitions and form.”
- Hardware: `CAMERA`, level `REQUIRED` — “Records the workout from the user's point of view.”
- Hardware: `WIFI`, level `REQUIRED` — “Uploads the workout stream for analysis while the user records.”
- Do not request Microphone, Display, Location, Calendar, or Notification permissions.
- Upload both prepared portrait previews: `store/previews/workout.png` and
  `store/previews/performance.png` (1080×1920 each).

## Live console remediation

The current live record for `com.aijaviercoach.ml1` is still private and in
Development. Before physical testing, import `app_config.json`, click **Save
Changes**, and confirm that the live record no longer has any of these stale
values:

- Azure Function URL as the Server URL or Webview URL
- `Background` app type
- A Camera reason that describes microphone access
- Camera-only hardware with no required Wi-Fi
- The old 1536×1024 landscape logo
- Zero preview images

The API key must belong to the exact package `com.aijaviercoach.ml1`. After
generating or copying the correct key, rerun `configure-production-mentra.ps1`
and redeploy the MiniApp; changing the console record alone does not update the
secret already deployed to Azure.

## Public reviewer links

- Health: `https://ai-javier-coach.yellowmoss-ace59a4f.eastus.azurecontainerapps.io/health`
- Privacy: `https://ai-javier-coach.yellowmoss-ace59a4f.eastus.azurecontainerapps.io/privacy`
- Terms: `https://ai-javier-coach.yellowmoss-ace59a4f.eastus.azurecontainerapps.io/terms`
- Support: `https://ai-javier-coach.yellowmoss-ace59a4f.eastus.azurecontainerapps.io/support`
- Data deletion: `https://ai-javier-coach.yellowmoss-ace59a4f.eastus.azurecontainerapps.io/data-deletion`

## Reviewer instructions

1. Install AI Javier Coach and grant Camera permission.
2. Connect Mentra Live to the phone and to Wi-Fi; charge it above 15%.
3. Open the phone webview. Choose the mirror and rotation settings before recording.
4. Press **Iniciar sesión**, perform visible biceps curls, and confirm that the capture light remains on.
5. Press **Finalizar sesión**. Processing is asynchronous; use **Rendimiento → Actualizar** to review results.
6. Confirm that recording cannot start without Wi-Fi and that an active session can still be stopped after a disconnect.
7. Confirm the legal/support pages and the signed-in **Eliminar mis datos** flow.

## Remaining console and physical release gates

- Confirm the organization name is a legally accurate public operator identity
  and the organization contact email is monitored.
- Replace the mismatched app-bound API key, synchronize it, and redeploy the MiniApp.
- Import/save the production config, correct hardware requirements, upload the
  square icon and both previews, and add these reviewer instructions.
- A physical Mentra Live test covering start, stop, reconnect, processing, and deletion.

## Redeployment/disaster-recovery order — initial deployment completed

Run these only after explicit Azure spending approval. Each command has a hard
`-ConfirmAzureSpend` guard.

1. `azure/deploy.ps1 -ConfirmAzureSpend` — private Storage and Function API.
2. `azure/deploy-mentra-ingest.ps1 -ConfirmAzureSpend -AdminSourceCidr "<operator-ip>/32"` — RTMPS ingest and trusted certificate.
3. `setup-mentra-env.ps1` — synchronize the generated RTMPS URL.
4. `azure/deploy-mentra-miniapp.ps1 -ConfirmAzureSpend` — public HTTPS MiniApp.
5. `azure/deploy-processor.ps1 -ConfirmAzureSpend` — scheduled pose-processing job.

Keep the three Azure credentials independent:

- `AZURE_MINIAPP_API_TOKEN`: signed-in profile status, preferences, dashboard, and deletion.
- `AZURE_INGEST_API_TOKEN`: RTMPS segment/direct-companion video upload only.
- `AZURE_PROCESSOR_API_TOKEN`: all-profile pending-work query for the trusted processor only.
