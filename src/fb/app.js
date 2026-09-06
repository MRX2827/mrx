// ────────────────────────────────────────────────────────────────────────────
// app.js — замена firebase/app. Никакой конфигурации не нужно —
// всё работает через собственный сервер (см. core.js).
// ────────────────────────────────────────────────────────────────────────────

const app = { name: "[DEFAULT]", options: {} };

export function initializeApp(_config) {
  return app;
}

export function getApp() {
  return app;
}

export function getApps() {
  return [app];
}
