# Curl Vision HeyCyan Android

Native Android companion app for a simple gym workflow with Blackview BV100 /
HeyCyan glasses and the Curl Vision Foundry dataset pipeline.

## What works now

- Simple main screen: `Conectar lentes`, `Entrenar`, import video,
  and send to the model.
- Live workout dashboard after starting: total curls, elapsed time, current set
  progress, pace, and set controls.
- BLE scan/connect under one user-facing button.
- Manual video import from Android storage for HeyCyan-exported clips.
- Azure Blob container SAS upload for `video.*` plus compatible metadata.
- Advanced panel for BLE HEX commands, WiFi transfer probing, and diagnostics.
- Emulator demo mode to preview the gym flow without hardware.
- PC bridge mode for Android Emulator: pair the glasses to Windows, run the
  bridge, then tap `Conectar usando la PC`.

## Hardware truth

The emulator does not expose the PC Bluetooth radio, so real BV100 BLE testing
must normally be done on an Android phone. For emulator-only testing, use the
Windows bridge:

```powershell
.\.venv\Scripts\python.exe ..\..\src\windows_bv100_bridge.py
```

The bridge opens the Windows-paired BV100/HeyCyan device and exposes it to the
emulator through `http://10.0.2.2:8765`. The dashboard is ready for live data,
but automatic rep counting still needs a live video/sensor stream or the exact
HeyCyan/QCSDK command protocol. Until then, the dashboard supports manual rep
entry during real connection tests.

If the glasses expose a live stream or WiFi transfer endpoint, the app can probe
and download it. If not, use `Importar video` after exporting/saving the clip
from HeyCyan.

## Build

```powershell
cd android-native/CurlVisionHeyCyan
gradle :app:assembleDebug
```

Install on a connected device or emulator:

```powershell
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.curlvision.heycyan/.MainActivity
```
