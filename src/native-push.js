// A small Capacitor-compatible facade used by App.jsx. The native plugin runs
// its own persistent connection to ntfy directly inside this APK — no
// UnifiedPush distributor app, no Firebase, no Google Play Services.
import { registerPlugin } from "@capacitor/core";

const NativePushPlugin = registerPlugin("NativePush");

export const NativePush = {
  checkPermissions: () => NativePushPlugin.checkPermissions(),
  requestPermissions: () => NativePushPlugin.requestPermissions(),
  createChannel: (options) => NativePushPlugin.createChannel(options || {}),
  // options: { topic }
  start: (options) => NativePushPlugin.start(options),
  stop: () => NativePushPlugin.stop(),
  getLaunchData: () => NativePushPlugin.getLaunchData(),
  getDeliveredNotifications: () => NativePushPlugin.getDeliveredNotifications(),
  removeDeliveredNotifications: (options) => NativePushPlugin.removeDeliveredNotifications(options),
  removeAllDeliveredNotifications: () => NativePushPlugin.removeAllDeliveredNotifications(),
  addListener: (eventName, listenerFunc) => NativePushPlugin.addListener(eventName, listenerFunc),
  removeAllListeners: () => NativePushPlugin.removeAllListeners(),
};

export default NativePush;
