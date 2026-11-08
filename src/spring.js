// Sample once; Web Animations plays these frames without React renders or RAF work.
export function springProgress(seconds, frequency = 18, damping = .74) {
  const swing = frequency * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-frequency * damping * seconds) * (
    Math.cos(swing * seconds) + frequency * damping / swing * Math.sin(swing * seconds)
  );
}

const surfaces = {
  dialog: { y: 18, scale: .94 },
  menu: { y: -8, scale: .94 },
  attachment: { y: 24, scale: .98 },
  page: { y: 22, scale: 1 },
  detail: { y: 10, scale: .985 },
};

export function surfaceFrames(variant, open, current) {
  const closed = { x: 0, ...(surfaces[variant] || surfaces.detail), opacity: 0 };
  const shown = { x: 0, y: 0, scale: 1, opacity: 1 };
  const from = current || (open ? closed : shown);
  const to = open ? shown : closed;
  const duration = open ? 560 : 180;
  const steps = Math.ceil(duration / (1000 / 60));
  const frames = Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    const progress = index === steps ? 1 : open
      ? springProgress(t * duration / 1000)
      : t * t * (3 - 2 * t);
    const mix = key => from[key] + (to[key] - from[key]) * progress;
    return {
      transform: `translate3d(${mix('x')}px,${mix('y')}px,0) scale(${mix('scale')})`,
      opacity: Math.max(0, Math.min(1, mix('opacity'))),
    };
  });
  return { frames, duration };
}
