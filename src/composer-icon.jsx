import React from "react";

const shapes = {
  smile: <><circle cx="12" cy="12" r="8.5"/><path d="M8.5 13.5a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/></>,
  keyboard: <><rect x="3" y="6" width="18" height="12" rx="3"/><path d="M7 10h.01m3.3 0h.01m3.3 0h.01m3.3 0h.01M7 14h.01m3 0h4m3 0h.01"/></>,
  sticker: <path d="M20.5 12.5v-5A4 4 0 0 0 16.5 3.5h-9a4 4 0 0 0-4 4v9a4 4 0 0 0 4 4h5a3 3 0 0 0 2.1-.9l5-5a3 3 0 0 0 .9-2.1ZM13 20v-3a4 4 0 0 1 4-4h3M8.5 9h.01m6 0h.01M8.5 13a3.5 3.5 0 0 0 3.5 1.5"/>,
  send: <path d="M21 3 10.5 13.5M21 3l-6.7 18-3.8-7.5L3 9.7 21 3Z"/>,
  add: <path d="M12 5v14M5 12h14"/>,
  link: <path d="M10 14l4-4m-5.5 6.5-1.2 1.2a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m1.4 6.6a3.5 3.5 0 0 0 5 0l4-4a3.5 3.5 0 0 0-5-5l-1.2 1.2"/>,
  info: <><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5m0-8h.01"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
};

export function ComposerIcon({ name, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {shapes[name]}
    </svg>
  );
}
