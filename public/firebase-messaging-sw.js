// This Android/F-Droid build uses native UnifiedPush.  The file stays as a
// harmless no-op so an old browser cache cannot load a third-party push SDK.
self.addEventListener("install", () => self.skipWaiting());
