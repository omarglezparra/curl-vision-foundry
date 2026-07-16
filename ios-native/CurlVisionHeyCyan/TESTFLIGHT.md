# TestFlight Setup

This app can be distributed through TestFlight once it is signed and uploaded to
App Store Connect.

## What You Need

- Apple Developer Program membership.
- App Store Connect access with permission to create apps and upload builds.
- A unique bundle id, for example:

```text
com.yourname.curlvision.heycyan
```

- App Store Connect API key:
  - Key ID
  - Issuer ID
  - downloaded `.p8` private key
- Your Apple Team ID.

## App Store Connect Checklist

1. Open App Store Connect.
2. Create a new iOS app.
3. Use the same bundle id as `PRODUCT_BUNDLE_IDENTIFIER`.
4. Fill required app information.
5. Add TestFlight test information.
6. Create an internal tester group.
7. After upload, add the build to the tester group.
8. For external testers, create an external group and public link after beta
   review is approved.

## Local Mac Upload

On a Mac:

```bash
cd ios-native/CurlVisionHeyCyan
cp .env.example .env
```

Edit `.env`:

```text
PRODUCT_BUNDLE_IDENTIFIER=com.yourname.curlvision.heycyan
DEVELOPMENT_TEAM=ABCDE12345
APP_STORE_CONNECT_KEY_ID=ABC123DEFG
APP_STORE_CONNECT_ISSUER_ID=00000000-0000-0000-0000-000000000000
APP_STORE_CONNECT_KEY_FILE=./fastlane/AuthKey_ABC123DEFG.p8
```

Copy the downloaded `.p8` key into `fastlane/`.

Then run:

```bash
brew install xcodegen
bundle install
bundle exec fastlane ios beta
```

## GitHub Actions Upload

Add these repository secrets:

```text
IOS_BUNDLE_ID
APPLE_TEAM_ID
APP_STORE_CONNECT_KEY_ID
APP_STORE_CONNECT_ISSUER_ID
APP_STORE_CONNECT_API_KEY_P8_BASE64
TESTFLIGHT_GROUP
```

To encode the `.p8` key on macOS/Linux:

```bash
base64 -i AuthKey_ABC123DEFG.p8 | pbcopy
```

Paste the result into `APP_STORE_CONNECT_API_KEY_P8_BASE64`.

Then run the `iOS TestFlight` workflow manually from GitHub Actions.

## Important Signing Notes

The app uses Bluetooth, local network, and hotspot configuration. Make sure the
App ID in Apple Developer has any needed capabilities enabled before upload.
If signing fails, open the generated Xcode project once on a Mac, select your
team, and let Xcode repair signing.

## TestFlight Link

After App Store Connect processes the uploaded build:

1. Open the app in App Store Connect.
2. Go to TestFlight.
3. Add the build to an internal or external tester group.
4. For external testers, complete beta review if prompted.
5. Create or copy the public link from the tester group.
