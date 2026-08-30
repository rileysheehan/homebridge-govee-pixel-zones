import assert from 'node:assert/strict';
import test from 'node:test';

import { boundaryFrame, CALIBRATION_COLORS, identifyPixelFrame } from './calibration.js';
import { encodeFingerSketch, frameToPixels } from './protocol/finger-sketch.js';

test('builds a two-color boundary frame for phone-slider calibration', () => {
  const frame = boundaryFrame(50, 17);
  assert.deepEqual(frame.groups.map(group => group.pixels.length), [17, 33]);
  const pixels = frameToPixels(frame, 50);
  assert.deepEqual(pixels[16], CALIBRATION_COLORS.before);
  assert.deepEqual(pixels[17], CALIBRATION_COLORS.after);
  assert.doesNotThrow(() => encodeFingerSketch(frame));
});

test('builds an individual-puck identification frame', () => {
  const frame = identifyPixelFrame(50, 23);
  const pixels = frameToPixels(frame, 50);
  assert.deepEqual(pixels[22], CALIBRATION_COLORS.reference);
  assert.deepEqual(pixels[23], CALIBRATION_COLORS.selected);
  assert.deepEqual(pixels[24], CALIBRATION_COLORS.reference);
});
