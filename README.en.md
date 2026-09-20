# MrX (RedMrxGram)

**RedMrxGram is currently in BETA.** Features are still being actively developed and things may change, break or improve with every update. More is coming — feedback and bug reports are very welcome.

MrX (project name RedMrxGram) is a free, Google-free Android messenger.

- **No Google.** No Play Services, no Firebase, no FCM — nothing proprietary in the APK. Push notifications work through a built-in foreground service that keeps its own WebSocket connection, so messages arrive even when the app is fully closed.
- **Self-hosted backend.** A small open Go server (with a SQLite-backed document store) powers accounts, chats and file storage. The client is a React + Capacitor WebView app; all UI code is in this repository.
- **Features:** text messages, voice messages, video circles, photos, videos, files, an inline audio player with a shared queue, stories, reactions, replies, pinned messages, favorites, profile achievements, themes, QR profile codes, and end-to-end UX for battery-friendly background push.
- **Local-first:** messages and media are cached in SQLite on-device for offline access.

## News

News and updates: https://t.me/redmrxgram

## Building from source

Requirements: Node.js 22+, pnpm, JDK 21, Android SDK (target SDK 36).

```bash
pnpm install
pnpm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

The debug APK is built to `android/app/build/outputs/apk/debug/app-debug.apk`.

## License

MIT — see [LICENSE](LICENSE).
