import { Capacitor, registerPlugin } from "@capacitor/core";

export const updater = registerPlugin("MrxUpdate");
export const updateCheckEvent = "mrx-check-for-update";

export function hasAndroidUpdates() {
  return Capacitor.getPlatform() === "android";
}

export function checkForAppUpdate() {
  window.dispatchEvent(new Event(updateCheckEvent));
}
