export const shareOrigin = "https://mrx-recovery.onrender.com";

const kinds = new Set(["u", "group", "channel", "chat", "stickers"]);
const sharedId = /^[a-z0-9_-]{1,180}$/i;

export function mrxLink(kind, id) {
  return `${shareOrigin}/${kind}/${encodeURIComponent(id)}`;
}

export function chatLink(chat) {
  const kind = chat.type === "group" || chat.type === "channel" ? chat.type : "chat";
  return mrxLink(kind, kind === "chat" ? chat.id : (chat.tag || chat.id).replace(/^@/, ""));
}

export function parseDeepLink(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port) return null;
    let kind, id;
    if (url.protocol === "mrx:") {
      kind = url.hostname;
      id = url.pathname.slice(1);
    } else {
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      if (url.hostname !== new URL(shareOrigin).hostname && url.hostname !== "redmrxgram.duckdns.org") return null;
      const parts = url.pathname.split("/");
      if (parts.length !== 3) return null;
      [, kind, id] = parts;
    }
    const tag = decodeURIComponent(id).replace(/^@/, "");
    if (!kinds.has(kind) || !sharedId.test(tag)) return null;
    if (kind === "stickers" && !/^[a-f0-9]{32}$/.test(tag)) return null;
    return { kind, tag };
  } catch {
    return null;
  }
}
