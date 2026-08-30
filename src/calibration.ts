import type { FingerSketchFrame, RgbColor } from './protocol/finger-sketch.js';

export const CALIBRATION_COLORS = {
  before: { red: 255, green: 0, blue: 255 },
  after: { red: 255, green: 0, blue: 0 },
  selected: { red: 0, green: 255, blue: 255 },
  reference: { red: 32, green: 8, blue: 0 },
  background: { red: 1, green: 1, blue: 1 },
} satisfies Record<string, RgbColor>;

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
}

function assertPixelCount(pixelCount: number): void {
  if (!Number.isInteger(pixelCount) || pixelCount < 1 || pixelCount > 256) {
    throw new RangeError('pixelCount must be an integer from 1 through 256');
  }
}

export function boundaryFrame(pixelCount: number, beforeCount: number): FingerSketchFrame {
  assertPixelCount(pixelCount);
  if (!Number.isInteger(beforeCount) || beforeCount < 0 || beforeCount > pixelCount) {
    throw new RangeError(`beforeCount must be an integer from 0 through ${pixelCount}`);
  }
  const groups: FingerSketchFrame['groups'] = [];
  if (beforeCount > 0) {
    groups.push({ color: CALIBRATION_COLORS.before, pixels: range(0, beforeCount) });
  }
  if (beforeCount < pixelCount) {
    groups.push({ color: CALIBRATION_COLORS.after, pixels: range(beforeCount, pixelCount) });
  }
  return {
    speed: 1,
    background: CALIBRATION_COLORS.background,
    groups,
  };
}

export function identifyPixelFrame(pixelCount: number, selectedPixel: number): FingerSketchFrame {
  assertPixelCount(pixelCount);
  if (!Number.isInteger(selectedPixel) || selectedPixel < 0 || selectedPixel >= pixelCount) {
    throw new RangeError(`selectedPixel must be an integer from 0 through ${pixelCount - 1}`);
  }
  return {
    speed: 1,
    background: CALIBRATION_COLORS.background,
    groups: [
      { color: CALIBRATION_COLORS.reference, pixels: range(0, pixelCount).filter(pixel => pixel !== selectedPixel) },
      { color: CALIBRATION_COLORS.selected, pixels: [selectedPixel] },
    ],
  };
}
