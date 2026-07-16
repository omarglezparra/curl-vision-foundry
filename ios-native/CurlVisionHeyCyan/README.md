# Curl Vision HeyCyan Native iOS

Native SwiftUI app scaffold for controlling HeyCyan/BV100 glasses and feeding
Curl Vision Foundry.

## What This App Does

- Scans for nearby BLE devices and connects to the glasses.
- Discovers BLE services/characteristics and logs notifications.
- Provides native workout controls for Start/Stop/Transfer.
- Connects to the glasses WiFi transfer endpoint when available.
- Reads `manifest.json`, downloads the newest video, and stores it on-device.
- Uploads video plus Curl Vision metadata to Azure Blob using a container SAS.
- Probes likely live-stream URLs on the glasses hotspot.

## Important Limitation

HeyCyan/BV100 live camera streaming is not publicly documented. The public SDK
material shows BLE control plus WiFi file transfer, not a guaranteed live
RTSP/MJPEG/WebRTC stream. This app includes a stream probe, but if the glasses
do not expose a public endpoint, real-time camera preview is not possible
without the vendor SDK or reverse-engineered commands.

Start/stop video commands are also proprietary. The app includes the correct
native structure and a `HeyCyanCommandController` integration point, but the
actual Start/Stop implementation needs either:

- the HeyCyan/QCSDK iOS framework added on a Mac, or
- confirmed BLE command packets for BV100.

## Build On A Mac

Install Xcode and XcodeGen:

```bash
brew install xcodegen
```

Generate and open the Xcode project:

```bash
cd ios-native/CurlVisionHeyCyan
xcodegen generate
open CurlVisionHeyCyan.xcodeproj
```

In Xcode:

1. Select the `CurlVisionHeyCyan` target.
2. Set your Apple development team.
3. Change the bundle id if needed.
4. Build to a real iPhone.

Bluetooth, local network, and hotspot behavior should be tested on a physical
iPhone, not the simulator.

## TestFlight

See `TESTFLIGHT.md` for the Fastlane and GitHub Actions setup. The short path
from a Mac is:

```bash
cd ios-native/CurlVisionHeyCyan
cp .env.example .env
# edit .env and place the App Store Connect .p8 key in fastlane/
brew install xcodegen
bundle install
bundle exec fastlane ios beta
```

## Workout Flow

1. Open the app on iPhone.
2. Tap `Escanear BLE`.
3. Connect to the HeyCyan/BV100 device.
4. Use `Probe stream` while connected to the glasses hotspot to see if any live
   endpoint is exposed.
5. Use `Download newest` after the glasses are in WiFi transfer mode.
6. Paste your Azure container SAS URL.
7. Tap `Subir ultimo clip`.

The uploaded blobs use:

```text
good_form/mirror_bv100/<session_id>/<capture_id>/video.<extension>
good_form/mirror_bv100/<session_id>/<capture_id>/metadata.json
```

These are compatible with `src/process_azure_captures.py`.

## SDK Integration Point

The source file `Sources/HeyCyanCommandController.swift` is the place to wire
the vendor SDK. The expected behavior:

- `startRecording()` sends the HeyCyan video-start command.
- `stopRecording()` sends the HeyCyan video-stop command.
- `openTransferMode()` opens WiFi transfer and returns SSID/password.

Once those calls work, the rest of the pipeline is already connected.
