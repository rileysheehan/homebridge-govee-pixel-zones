import assert from 'node:assert/strict';
import test from 'node:test';

import { interpolateRgb } from './color.js';

test('interpolates RGB in linear light and preserves exact endpoints', () => {
  const black = { red: 0, green: 0, blue: 0 };
  const white = { red: 255, green: 255, blue: 255 };
  assert.deepEqual(interpolateRgb(black, white, 0), black);
  assert.deepEqual(interpolateRgb(black, white, 1), white);
  assert.deepEqual(interpolateRgb(black, white, 0.5), { red: 188, green: 188, blue: 188 });
});
