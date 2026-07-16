# Fastlane TestFlight

This folder contains the TestFlight automation for the native iOS app.

Do not commit real `.p8` App Store Connect keys.

Local upload:

```bash
cp .env.example .env
# edit .env
bundle install
bundle exec fastlane ios beta
```
