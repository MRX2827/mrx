import publicKey from "./routing-key.json";

const fallback = { apiBase: "https://redmrxgram.duckdns.org", wsAuth: "query" };
const cacheKey = "rmg_signed_routes_v1";
const configUrls = [
  "https://raw.githubusercontent.com/MRX2827/mrx/mrx-routing/config.json",
  "https://mrx2827.github.io/mrx/config.json",
];
const routeListeners = new Set();
let current = { revision: 0, endpoints: [fallback] };
let rawConfig;
let refreshing;
let lastRefresh = -Infinity;
let initialized;
export let route = fallback;

function decode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url");
  }
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
}

async function verifyConfig(raw, key) {
  if (raw.length > 16384) throw new Error("Config too large");
  const { payload, signature } = JSON.parse(raw);
  const bytes = decode(payload);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decode(signature), bytes)) {
    throw new Error("Invalid route signature");
  }
  const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const { revision, endpoints } = config;
  if (config.schemaVersion !== 1 || !Number.isSafeInteger(revision) || revision < 1 ||
      !Array.isArray(endpoints) || endpoints.length < 1 || endpoints.length > 3) {
    throw new Error("Unsupported routing config");
  }
  return {
    revision,
    endpoints: endpoints.map(({ apiBase, wsAuth }) => {
      const url = new URL(apiBase);
      if (url.protocol !== "https:" || url.href !== url.origin + "/" || !["message", "query"].includes(wsAuth)) {
        throw new Error("Invalid API endpoint");
      }
      return { apiBase: url.origin, wsAuth };
    }),
  };
}

function setRoute(next) {
  if (next.apiBase === route.apiBase && next.wsAuth === route.wsAuth) return;
  route = next;
  for (const listener of routeListeners) listener();
}

export function onRouteChange(listener) {
  routeListeners.add(listener);
  return () => routeListeners.delete(listener);
}

function fetchWithoutCredentials(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return { response: fetch(url, {
    cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
  }), done: () => clearTimeout(timer) };
}

async function fetchConfig(url, key) {
  const request = fetchWithoutCredentials(url, 3500);
  try {
    const res = await request.response;
    if (!res.ok) throw new Error("Config unavailable");
    const raw = await res.text();
    return { config: await verifyConfig(raw, key), raw };
  } finally {
    request.done();
  }
}

async function healthy(endpoint) {
  const request = fetchWithoutCredentials(endpoint.apiBase + "/health", 4500);
  try {
    const res = await request.response;
    if (!res.ok) return false;
    return (await res.json()).status === "ok";
  } catch {
    return false;
  } finally {
    request.done();
  }
}

export function refreshRoutes(force = false) {
  if (refreshing) return refreshing;
  if (!force && Date.now() - lastRefresh < 30000) return Promise.resolve();
  lastRefresh = Date.now();
  refreshing = (async () => {
    if (!globalThis.crypto?.subtle) return;
    const key = await crypto.subtle.importKey("jwk", publicKey,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!rawConfig) {
      try {
        const raw = localStorage.getItem(cacheKey);
        if (raw) {
          current = await verifyConfig(raw, key);
          rawConfig = raw;
          setRoute(current.endpoints[0]);
        }
      } catch { /* continue with the built-in address */ }
    }
    const results = await Promise.allSettled(configUrls.map(url => fetchConfig(url, key)));
    for (const result of results) {
      if (result.status !== "fulfilled" || result.value.config.revision <= current.revision) continue;
      current = result.value.config;
      rawConfig = result.value.raw;
      try { localStorage.setItem(cacheKey, rawConfig); } catch { /* optional cache */ }
    }
    const candidates = current.endpoints;
    if (candidates.length === 1) setRoute(candidates[0]);
    else {
      const status = await Promise.all(candidates.map(healthy));
      const index = status.indexOf(true);
      if (index >= 0) setRoute(candidates[index]);
      else if (!candidates.some(candidate => candidate.apiBase === route.apiBase && candidate.wsAuth === route.wsAuth)) {
        setRoute(candidates[0]);
      }
    }
  })().finally(() => { refreshing = undefined; });
  return refreshing;
}

export function initializeRoutes() {
  initialized ||= refreshRoutes().catch(() => {});
  return initialized;
}
