import { useLayoutEffect, useRef } from "react";

const centered = { transform: "translate3d(0,0,0)", opacity: 1 };
const tucked = { transform: "translate3d(-18%,0,0)", opacity: 0.82 };
const offscreen = { transform: "translate3d(100%,0,0)", opacity: 1 };
const easing = "cubic-bezier(.32,.08,.20,1)";

function currentFrame(element) {
  const { transform, opacity } = getComputedStyle(element);
  return { transform, opacity };
}

export function useChatMotion(phase, list, chat, onFinish, chatId, available) {
  const active = useRef(null);

  useLayoutEffect(() => () => active.current?.animations.forEach(animation => animation.cancel()), []);

  useLayoutEffect(() => {
    const previous = active.current;
    const listLayer = list.current;
    const chatLayer = chat.current;
    const interrupted = previous && previous.listLayer === listLayer && previous.chatLayer === chatLayer;
    const listFrom = interrupted && currentFrame(listLayer);
    const chatFrom = interrupted && currentFrame(chatLayer);
    previous?.animations.forEach(animation => animation.cancel());
    active.current = null;
    if (!available || phase === "none" || !listLayer || !chatLayer) return;

    if (!chatLayer.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onFinish(phase);
      return;
    }

    const entering = phase === "toChat";
    const options = { duration: entering ? 390 : 350, easing, fill: "both" };
    const animations = [
      listLayer.animate([listFrom || (entering ? centered : tucked), entering ? tucked : centered], options),
      chatLayer.animate([chatFrom || (entering ? offscreen : centered), entering ? centered : offscreen], options),
    ];
    active.current = { listLayer, chatLayer, animations };
    animations[1].finished.then(() => {
      if (active.current?.animations === animations) onFinish(phase);
    }, () => {});
  }, [phase, list, chat, onFinish, chatId, available]);
}
