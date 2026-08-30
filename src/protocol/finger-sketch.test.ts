import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { decodeFingerSketch, encodeFingerSketch, frameToPixels, pixelsToFrame } from './finger-sketch.js';

const defaultCapture = [
  'a3000104030900010101010130ff9829000102d0',
  'a301030405060708090a0b0c0d0e0f10111213a1',
  'a3021415161718191a1b1c1d1e1f202122232485',
  'a3ff25262728292a2b2c2d2e3100000000000066',
].map(value => Buffer.from(value, 'hex'));

const christmasCapture = [
  'a300010503090064010101030eff000000010338',
  'a30104060723242627292a2c2d08ffd5a1020527',
  'a302082225282b2e1aff9829090a0b0c0d0e0fdf',
  'a303101112131415161718191a1b1c1d1e1f2080',
  'a3ff21310000000000000000000000000000004c',
].map(value => Buffer.from(value, 'hex'));

test('decodes the captured 50-puck default frame', () => {
  const frame = decodeFingerSketch(defaultCapture);
  assert.equal(frame.speed, 1);
  assert.deepEqual(frame.background, { red: 1, green: 1, blue: 1 });
  assert.equal(frame.groups.length, 1);
  assert.deepEqual(frame.groups[0].color, { red: 255, green: 152, blue: 41 });
  assert.equal(frame.groups[0].pixels.length, 48);
  assert.deepEqual(frame.groups[0].pixels.slice(-4), [44, 45, 46, 49]);

  const pixels = frameToPixels(frame, 50);
  assert.deepEqual(pixels[47], frame.background);
  assert.deepEqual(pixels[48], frame.background);
});

test('decodes three independently addressed Christmas color groups', () => {
  const frame = decodeFingerSketch(christmasCapture);
  assert.equal(frame.speed, 100);
  assert.equal(frame.groups.length, 3);
  assert.deepEqual(frame.groups.map(group => group.pixels.length), [14, 8, 26]);
  assert.deepEqual(frame.groups.map(group => group.color), [
    { red: 255, green: 0, blue: 0 },
    { red: 255, green: 213, blue: 161 },
    { red: 255, green: 152, blue: 41 },
  ]);
});

test('round-trips a captured frame through the encoder', () => {
  const decoded = decodeFingerSketch(christmasCapture);
  const encoded = encodeFingerSketch(decoded);
  assert.deepEqual(encoded, christmasCapture);
});

test('groups an arbitrary pixel buffer by exact RGB color', () => {
  const background = { red: 1, green: 1, blue: 1 };
  const pixels = [
    { red: 255, green: 0, blue: 0 },
    background,
    { red: 0, green: 0, blue: 255 },
    { red: 255, green: 0, blue: 0 },
  ];
  const frame = pixelsToFrame(pixels, { speed: 1, background });
  assert.deepEqual(frame.groups, [
    { color: { red: 255, green: 0, blue: 0 }, pixels: [0, 3] },
    { color: { red: 0, green: 0, blue: 255 }, pixels: [2] },
  ]);
  assert.deepEqual(frameToPixels(frame, 4), pixels);
});
