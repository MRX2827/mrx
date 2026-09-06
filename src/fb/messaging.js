// ────────────────────────────────────────────────────────────────────────────
// messaging.js — совместимая заглушка для старого web-кода. Уведомления в
// Android приходят через нативный UnifiedPush, а не через браузерный SDK.
// ────────────────────────────────────────────────────────────────────────────

export function getMessaging() {
  return null;
}

export async function getToken(_messaging, _opts) {
  return null;
}

export function onMessage(_messaging, _cb) {
  // Фоновые пуши доставляются через ntfy, а в открытом приложении
  // сообщения приходят по WebSocket — этот коллбэк не нужен.
  return () => {};
}

export async function isSupported() {
  return false;
}
