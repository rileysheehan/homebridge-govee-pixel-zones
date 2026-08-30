import type { RgbColor } from './protocol/finger-sketch.js';

export interface HsvColor {
  hue: number;
  saturation: number;
  brightness: number;
}

function srgbToLinear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const channel = value <= 0.0031308 ? value * 12.92 : (1.055 * value ** (1 / 2.4)) - 0.055;
  return Math.round(Math.max(0, Math.min(1, channel)) * 255);
}

export function interpolateRgb(from: RgbColor, to: RgbColor, progress: number): RgbColor {
  const amount = Math.max(0, Math.min(1, progress));
  const channel = (start: number, end: number) => linearToSrgb(
    srgbToLinear(start) + ((srgbToLinear(end) - srgbToLinear(start)) * amount),
  );
  return {
    red: channel(from.red, to.red),
    green: channel(from.green, to.green),
    blue: channel(from.blue, to.blue),
  };
}

export function hsvToRgb(color: HsvColor): RgbColor {
  const hue = ((color.hue % 360) + 360) % 360;
  const saturation = Math.max(0, Math.min(100, color.saturation)) / 100;
  const value = Math.max(0, Math.min(100, color.brightness)) / 100;
  const chroma = value * saturation;
  const section = hue / 60;
  const intermediate = chroma * (1 - Math.abs((section % 2) - 1));
  const offset = value - chroma;
  const [red, green, blue] = section < 1 ? [chroma, intermediate, 0]
    : section < 2 ? [intermediate, chroma, 0]
      : section < 3 ? [0, chroma, intermediate]
        : section < 4 ? [0, intermediate, chroma]
          : section < 5 ? [intermediate, 0, chroma]
            : [chroma, 0, intermediate];
  return {
    red: Math.round((red + offset) * 255),
    green: Math.round((green + offset) * 255),
    blue: Math.round((blue + offset) * 255),
  };
}

export function rgbToHsv(color: RgbColor): HsvColor {
  const red = color.red / 255;
  const green = color.green / 255;
  const blue = color.blue / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta !== 0) {
    if (maximum === red) {
      hue = 60 * (((green - blue) / delta) % 6);
    } else if (maximum === green) {
      hue = 60 * (((blue - red) / delta) + 2);
    } else {
      hue = 60 * (((red - green) / delta) + 4);
    }
  }
  return {
    hue: Math.round((hue + 360) % 360),
    saturation: maximum === 0 ? 0 : Math.round((delta / maximum) * 100),
    brightness: Math.round(maximum * 100),
  };
}
