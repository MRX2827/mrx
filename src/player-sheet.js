import { useCallback, useLayoutEffect, useRef, useState } from "react";

const clamp = (value, max) => Math.min(Math.max(0, value), max);
const OPEN_SPRING = { duration: 820, frequency: 11, damping: 0.69 };
const SETTLE_SPRING = { duration: 580, frequency: 18, damping: 0.68 };

function smoothFade(value) {
  const progress = clamp(value, 1);
  return progress * progress * (3 - 2 * progress);
}

function playerFrame(offset, { top, height, miniHeight }) {
  const collapsed = clamp(offset / Math.max(1, top), 1);
  const clipped = (height - miniHeight) * collapsed;
  const stretch = 1 + Math.max(0, -offset) / height;
  const contentOpacity = smoothFade((0.9 - collapsed) / 0.8);
  return {
    sheet: {
      transform: `translate3d(0,${offset}px,0) scaleY(${stretch})`,
      opacity: smoothFade((1 - collapsed) / 0.24),
    },
    // Move the clip and counter-move its contents to keep the visible top fixed.
    window: { transform: `translate3d(0,${-clipped}px,0)` },
    surface: { transform: `translate3d(0,${clipped}px,0)` },
    content: { opacity: contentOpacity },
    preview: { opacity: 1 - contentOpacity },
  };
}

export function usePlayerSheet(anchor, onDismiss) {
  const sheetRef = useRef(null);
  const windowRef = useRef(null);
  const surfaceRef = useRef(null);
  const contentRef = useRef(null);
  const previewRef = useRef(null);
  const active = useRef([]);
  const gesture = useRef(null);
  const closing = useRef(false);
  const [settled, setSettled] = useState(false);

  const getBounds = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    const height = sheetRef.current?.clientHeight || window.innerHeight;
    if (rect?.height > 0 && rect.top >= 1 && rect.bottom <= height) {
      return { top: rect.top, height, miniHeight: rect.height };
    }
    return { top: height, height, miniHeight: 0 };
  }, [anchor]);

  const apply = useCallback((offset, bounds) => {
    const frame = playerFrame(offset, bounds);
    Object.assign(sheetRef.current.style, frame.sheet);
    sheetRef.current.style.transform = offset ? frame.sheet.transform : "none";
    windowRef.current.style.transform = offset ? frame.window.transform : "none";
    surfaceRef.current.style.transform = offset ? frame.surface.transform : "none";
    Object.assign(contentRef.current.style, frame.content);
    Object.assign(previewRef.current.style, frame.preview);
  }, []);

  const animate = useCallback((from, to, bounds, velocity, finished, spring = SETTLE_SPRING) => {
    active.current.forEach(animation => animation.cancel());
    const sheet = sheetRef.current;
    if (!sheet.animate || matchMedia("(prefers-reduced-motion: reduce)").matches || Math.abs(to - from) < 1) {
      apply(to, bounds);
      finished();
      return;
    }

    // Sample the spring once and let the browser play the keyframes without React renders.
    const { duration, frequency, damping } = spring;
    const decay = frequency * damping;
    const swing = frequency * Math.sqrt(1 - damping ** 2);
    const steps = Math.ceil(duration / (1000 / 60));
    const displacement = from - to;
    const momentum = (velocity + decay * displacement) / swing;
    const frames = Array.from({ length: steps + 1 }, (_, index) => {
      if (index === steps) return playerFrame(to, bounds);
      const time = index / steps * duration / 1000;
      const oscillation = displacement * Math.cos(swing * time) + momentum * Math.sin(swing * time);
      const offset = to + Math.exp(-decay * time) * oscillation;
      return playerFrame(offset < 0 ? offset / (1 - offset / 14) : offset, bounds);
    });
    const options = { duration, fill: "both" };
    apply(from, bounds);
    const animations = [
      sheet.animate(frames.map(frame => frame.sheet), options),
      windowRef.current.animate(frames.map(frame => frame.window), options),
      surfaceRef.current.animate(frames.map(frame => frame.surface), options),
      contentRef.current.animate(frames.map(frame => frame.content), options),
      previewRef.current.animate(frames.map(frame => frame.preview), options),
    ];
    active.current = animations;
    animations[0].finished.then(() => {
      apply(to, bounds);
      animations.forEach(animation => animation.cancel());
      active.current = [];
      finished();
    }, () => {});
  }, [apply]);

  useLayoutEffect(() => {
    const bounds = getBounds();
    animate(bounds.top, 0, bounds, 0, () => setSettled(true), OPEN_SPRING);
    return () => active.current.forEach(animation => animation.cancel());
  }, [animate, getBounds]);

  const dismiss = useCallback((velocity = 0) => {
    if (closing.current || !sheetRef.current) return;
    closing.current = true;
    gesture.current = null;
    setSettled(false);
    const bounds = getBounds();
    animate(sheetRef.current.getBoundingClientRect().top, bounds.top, bounds, velocity, onDismiss);
  }, [animate, getBounds, onDismiss]);
  const close = useCallback(() => dismiss(), [dismiss]);

  const dragHandlers = {
    onPointerDown(event) {
      if (!settled || closing.current || !event.isPrimary || event.button !== 0 ||
          event.target.closest("button, input, a")) return;
      const bounds = getBounds();
      setSettled(false);
      gesture.current = {
        id: event.pointerId, startY: event.clientY, lastY: event.clientY,
        lastAt: event.timeStamp, velocity: 0, offset: 0, bounds,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event) {
      const drag = gesture.current;
      if (drag?.id !== event.pointerId) return;
      drag.velocity = (event.clientY - drag.lastY) / Math.max(1, event.timeStamp - drag.lastAt);
      drag.lastY = event.clientY;
      drag.lastAt = event.timeStamp;
      drag.offset = clamp(event.clientY - drag.startY, drag.bounds.top);
      apply(drag.offset, drag.bounds);
    },
    onPointerUp(event) {
      const drag = gesture.current;
      if (drag?.id !== event.pointerId) return;
      gesture.current = null;
      const velocity = event.timeStamp - drag.lastAt < 90 ? Math.max(-2, Math.min(2, drag.velocity)) : 0;
      const flick = drag.offset > 12 && velocity > 0.9;
      if (drag.offset > Math.min(drag.bounds.top * 0.32, 110) || flick) dismiss(velocity * 1000);
      else animate(drag.offset, 0, drag.bounds, velocity * 1000, () => setSettled(true));
    },
    onLostPointerCapture(event) {
      const drag = gesture.current;
      if (drag?.id !== event.pointerId) return;
      gesture.current = null;
      animate(drag.offset, 0, drag.bounds, 0, () => setSettled(true));
    },
  };

  return { sheetRef, windowRef, surfaceRef, contentRef, previewRef, close, dragHandlers, settled };
}
