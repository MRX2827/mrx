// ────────────────────────────────────────────────────────────────────────────
// push-notifications.js — замена @capacitor/push-notifications (без Google Play
// Services). Вместо FCM-регистрации сразу отдаёт ntfy-топик устройства.
// Приложение сохраняет его в профиль как fcmToken — сервер шлёт туда пуши.
// ────────────────────────────────────────────────────────────────────────────

import { pushTopic } from "./core.js";

const listeners = {};

function fire(event, data) {
  (listeners[event] || []).forEach((cb) => {
    try {
      cb(data);
    } catch (e) {}
  });
}

export const PushNotifications = {
  async requestPermissions() {
    return { receive: "granted" };
  },
  async checkPermissions() {
    return { receive: "granted" };
  },
  async register() {
    // имитируем успешную регистрацию: токен = ntfy-топик устройства
    setTimeout(() => fire("registration", { value: pushTopic() }), 0);
  },
  async addListener(event, cb) {
    (listeners[event] = listeners[event] || []).push(cb);
    return {
      remove: async () => {
        listeners[event] = (listeners[event] || []).filter((f) => f !== cb);
      },
    };
  },
  async removeAllListeners() {
    Object.keys(listeners).forEach((k) => delete listeners[k]);
  },
  async createChannel(_ch) {},
  async listChannels() {
    return { channels: [] };
  },
  async getDeliveredNotifications() {
    return { notifications: [] };
  },
  async removeDeliveredNotifications(_arg) {},
  async removeAllDeliveredNotifications() {},
};

export default PushNotifications;
