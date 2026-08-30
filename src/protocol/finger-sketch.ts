import { Buffer } from 'node:buffer';

import { decodeMultiPacket, encodeMultiPacket } from './packet.js';

export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

export interface PixelGroup {
  color: RgbColor;
  pixels: number[];
}

export interface FingerSketchFrame {
  speed: number;
  background: RgbColor;
  groups: PixelGroup[];
}

const FRAME_PREFIX = [0x03, 0x09, 0x00] as const;

function assertByte(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${label} must be an integer from 0 through 255`);
  }
}

function assertColor(color: RgbColor, label: string): void {
  assertByte(color.red, `${label}.red`);
  assertByte(color.green, `${label}.green`);
  assertByte(color.blue, `${label}.blue`);
}

export function encodeFingerSketch(frame: FingerSketchFrame): Buffer[] {
  assertByte(frame.speed, 'speed');
  assertColor(frame.background, 'background');
  assertByte(frame.groups.length, 'group count');

  const body: number[] = [
    ...FRAME_PREFIX,
    frame.speed,
    frame.background.red,
    frame.background.green,
    frame.background.blue,
    frame.groups.length,
  ];

  for (const [groupIndex, group] of frame.groups.entries()) {
    assertColor(group.color, `groups[${groupIndex}].color`);
    assertByte(group.pixels.length, `groups[${groupIndex}] pixel count`);
    const unique = new Set(group.pixels);
    if (unique.size !== group.pixels.length) {
      throw new Error(`groups[${groupIndex}] contains duplicate pixel IDs`);
    }
    for (const pixel of group.pixels) {
      assertByte(pixel, `groups[${groupIndex}] pixel ID`);
    }
    body.push(
      group.pixels.length,
      group.color.red,
      group.color.green,
      group.color.blue,
      ...group.pixels,
    );
  }

  return encodeMultiPacket(Buffer.from(body));
}

export function decodeFingerSketch(packets: readonly Uint8Array[]): FingerSketchFrame {
  const body = decodeMultiPacket(packets);
  if (!FRAME_PREFIX.every((value, index) => body[index] === value)) {
    throw new Error('Unsupported Govee Finger Sketch frame prefix');
  }

  const frame: FingerSketchFrame = {
    speed: body[3],
    background: { red: body[4], green: body[5], blue: body[6] },
    groups: [],
  };
  const groupCount = body[7];
  let cursor = 8;

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const pixelCount = body[cursor];
    const end = cursor + 4 + pixelCount;
    if (end > body.length) {
      throw new Error(`Truncated Govee Finger Sketch group ${groupIndex}`);
    }
    frame.groups.push({
      color: {
        red: body[cursor + 1],
        green: body[cursor + 2],
        blue: body[cursor + 3],
      },
      pixels: [...body.subarray(cursor + 4, end)],
    });
    cursor = end;
  }

  return frame;
}

export function frameToPixels(frame: FingerSketchFrame, pixelCount: number): RgbColor[] {
  const pixels = Array.from({ length: pixelCount }, () => ({ ...frame.background }));
  const assigned = new Set<number>();
  for (const group of frame.groups) {
    for (const pixel of group.pixels) {
      if (pixel >= pixelCount) {
        throw new RangeError(`Finger Sketch references pixel ${pixel}, but pixelCount is ${pixelCount}`);
      }
      if (assigned.has(pixel)) {
        throw new Error(`Finger Sketch assigns pixel ${pixel} to more than one color group`);
      }
      assigned.add(pixel);
      pixels[pixel] = { ...group.color };
    }
  }
  return pixels;
}

export function pixelsToFrame(
  pixels: readonly RgbColor[],
  options: Pick<FingerSketchFrame, 'speed' | 'background'>,
): FingerSketchFrame {
  const groups = new Map<string, PixelGroup>();
  pixels.forEach((color, pixel) => {
    if (color.red === options.background.red
      && color.green === options.background.green
      && color.blue === options.background.blue) {
      return;
    }
    const key = `${color.red},${color.green},${color.blue}`;
    const group = groups.get(key) ?? { color: { ...color }, pixels: [] };
    group.pixels.push(pixel);
    groups.set(key, group);
  });
  return { ...options, groups: [...groups.values()] };
}
