// A small Capacitor-compatible facade used by App.jsx.  The native plugin is
// implemented in android/app/src/main/java and deliberately contains no FCM.
import { registerPlugin } from "@capacitor/core";

const UnifiedPush = registerPlugin("UnifiedPush");

export const PushNotifications = {
  configure: (options) => UnifiedPush.configure(options),
  checkPermissions: () => UnifiedPush.checkPermissions(),
  requestPermissions: () => UnifiedPush.requestPermissions(),
  register: () => UnifiedPush.register(),
  unregister: () => UnifiedPush.unregister(),
  getRegistration: () => UnifiedPush.getRegistration(),
  getLaunchData: () => UnifiedPush.getLaunchData(),
  createChannel: (options) => UnifiedPush.createChannel(options || {}),
  getDeliveredNotifications: () => UnifiedPush.getDeliveredNotifications(),
  removeDeliveredNotifications: (options) => UnifiedPush.removeDeliveredNotifications(options),
  removeAllDeliveredNotifications: () => UnifiedPush.removeAllDeliveredNotifications(),
  addListener: (eventName, listenerFunc) => UnifiedPush.addListener(eventName, listenerFunc),
  removeAllListeners: () => UnifiedPush.removeAllListeners(),
};

export default PushNotifications;
