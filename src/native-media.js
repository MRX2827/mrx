// Мост к нативному RedMrxMediaPlugin (Java): MediaStyle-плеер в шторке
// уведомлений + MediaSession. Сам звук играет <audio> в WebView (AUDIO_ENGINE
// в App.jsx) — нативная часть только зеркало: показывает уведомление с
// кнопками prev/play-pause/next (на Android 13+ система рисует и seekbar) и
// присылает нажатия обратно событием "mediaCommand".
import { registerPlugin } from "@capacitor/core";

const NativeMediaPlugin = registerPlugin("NativeMedia");

export const NativeMedia = {
  // options: { title, author, playing, duration, position, speed }
  update: (options) => NativeMediaPlugin.update(options || {}),
  clear: () => NativeMediaPlugin.clear(),
  addListener: (eventName, listenerFunc) => NativeMediaPlugin.addListener(eventName, listenerFunc),
  removeAllListeners: () => NativeMediaPlugin.removeAllListeners(),
};

export default NativeMedia;
