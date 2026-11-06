# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Обновления MRX для Android

MRX проверяет последний стабильный релиз в [GitHub Releases](https://github.com/MRX2827/mrx/releases) при открытии приложения. Проверку также можно запустить из настроек. После скачивания MRX проверяет хеш, пакет, версию и подпись APK. Установку подтверждает пользователь в Android.

Чтобы выпустить следующую версию:

1. Увеличьте `versionName` и `versionCode` в `android/app/build.gradle`.
2. Выполните `npm ci`, `npm run build`, `npx cap sync android` и `(cd android && ./gradlew :app:assembleRelease)`.
3. Выровняйте APK через `zipalign`, подпишите его тем же ключом, что и предыдущий релиз, и проверьте подпись через `apksigner verify --print-certs`.
4. Опубликуйте стабильный релиз из коммита сборки. Для версии `1.1.0` тег называется `v1.1.0`, а вложение должно называться `MRX-1.1.0-githubRelease.apk`. Отметьте релиз как **Latest**.
