import { useLayoutEffect, useRef, useState } from "react";

export function useEmojiMotion(open, dockRef) {
  const panel = useRef(null);
  const shownHeight = useRef(0);
  const [mounted, setMounted] = useState(open);

  useLayoutEffect(() => {
    const dock = dockRef.current;
    return () => window.rmgSetEmojiInset(dock, 0);
  }, [dockRef]);

  useLayoutEffect(() => {
    const element = panel.current;
    const dock = dockRef.current;
    if (!element || !dock) return;
    if (open) setMounted(true);

    const from = shownHeight.current;
    const start = performance.now();
    const duration = open ? 340 : 250;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let panelHeight = element.offsetHeight;
    let frame;

    function apply(height, moving = false) {
      shownHeight.current = height;
      element.style.transform = `translate3d(0,${panelHeight - height}px,0)`;
      window.rmgSetEmojiInset(dock, height, moving ? Math.max(from, panelHeight) : 0);
    }

    const tick = now => {
      const progress = reduced ? 1 : Math.min(1, Math.max(0, (now - start) / duration));
      const eased = progress === 1 ? 1 : open
        ? (1 - (1 + 8 * progress) * Math.exp(-8 * progress)) / (1 - 9 * Math.exp(-8))
        : progress ** 2 * (3 - 2 * progress);
      const target = open ? panelHeight : 0;
      apply(from + (target - from) * eased, progress < 1);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else if (!open) setMounted(false);
    };

    if (!reduced) apply(from, true);
    if (reduced) tick(start);
    else frame = requestAnimationFrame(tick);

    const observer = new ResizeObserver(() => {
      panelHeight = element.offsetHeight;
      if (open && (reduced || performance.now() - start >= duration)) apply(panelHeight);
    });
    observer.observe(element);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [open, dockRef]);

  return { panel, present: open || mounted };
}
