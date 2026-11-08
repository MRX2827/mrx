import { useLayoutEffect, useRef, useState } from "react";
import { surfaceFrames } from "./spring.js";

function useSurfaceMotion(open, variant, onRest) {
  const elementRef = useRef(null);
  const active = useRef(null);
  const initialized = useRef(false);
  const rest = useRef(onRest);
  useLayoutEffect(() => { rest.current = onRest; });
  useLayoutEffect(() => () => active.current?.cancel(), []);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const first = !initialized.current;
    initialized.current = true;
    let current;
    // Reversals start at the visible frame, including a half-open menu.
    if (active.current) {
      const style = getComputedStyle(element);
      const matrix = new DOMMatrixReadOnly(style.transform);
      current = { x: matrix.m41, y: matrix.m42, scale: matrix.a, opacity: +style.opacity };
      active.current.cancel();
    }
    const { frames, duration } = surfaceFrames(variant, open, current);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let animation;
    const finish = () => {
      if (animation && active.current !== animation) return;
      Object.assign(element.style, frames.at(-1));
      // A settled surface must not stay a containing block for fixed children.
      if (open) element.style.transform = "none";
      animation?.cancel();
      active.current = null;
      rest.current?.();
    };
    if (!element.animate || reduced.matches || (first && !open)) finish();
    else {
      animation = element.animate(frames, { duration, fill: "both" });
      active.current = animation;
      animation.finished.then(finish, () => {});
    }
    const motionChanged = () => { if (reduced.matches) finish(); };
    reduced.addEventListener("change", motionChanged);
    return () => reduced.removeEventListener("change", motionChanged);
  }, [open, variant]);
  return elementRef;
}

export function MotionSurface({ open = true, variant = "detail", children, style, ...props }) {
  const ref = useSurfaceMotion(open, variant);
  return <div {...props} ref={ref} data-motion-surface={variant} inert={!open}
    style={{ ...style, pointerEvents: open ? style?.pointerEvents : "none" }}>{children}</div>;
}

export function MotionPresence({ open, variant = "detail", children, style, onExited, ...props }) {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  const ref = useSurfaceMotion(open, variant, () => {
    if (!open) { setPresent(false); onExited?.(); }
  });
  if (!present) return null;
  return <div {...props} ref={ref} data-motion-surface={variant} inert={!open}
    style={{ ...style, pointerEvents: open ? style?.pointerEvents : "none" }}>{children}</div>;
}
