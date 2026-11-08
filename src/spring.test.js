import test from "node:test";
import assert from "node:assert/strict";
import { springProgress, surfaceFrames } from "./spring.js";

test("spring starts at rest, has a restrained rebound and settles", () => {
  const values = Array.from({ length: 121 }, (_, i) => springProgress(i / 120));
  assert.equal(values[0], 0);
  assert(values.every(Number.isFinite));
  assert(Math.max(...values) > 1.01);
  assert(Math.max(...values) < 1.04);
  assert(Math.abs(values.at(-1) - 1) < .0001);
});

test("all surfaces finish exactly, with bounded opacity and a shorter exit", () => {
  for (const variant of ["dialog", "menu", "attachment", "page", "detail"]) {
    const enter = surfaceFrames(variant, true);
    const exit = surfaceFrames(variant, false);
    assert(enter.duration > exit.duration);
    assert.deepEqual(enter.frames.at(-1), { transform: "translate3d(0px,0px,0) scale(1)", opacity: 1 });
    assert.deepEqual(exit.frames[0], enter.frames.at(-1));
    assert.deepEqual(exit.frames.at(-1), enter.frames[0]);
    assert([...enter.frames, ...exit.frames].every(frame => frame.opacity >= 0 && frame.opacity <= 1));
  }
});

test("reversing a half-open surface preserves the visible starting frame", () => {
  const current = { x: 0, y: 9, scale: .97, opacity: .5 };
  for (const open of [true, false]) {
    const { frames } = surfaceFrames("dialog", open, current);
    assert.deepEqual(frames[0], { transform: "translate3d(0px,9px,0) scale(0.97)", opacity: .5 });
  }
});
