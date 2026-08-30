#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { boundaryFrame, identifyPixelFrame } from '../calibration.js';
import { validateCatalog, type SnapshotDefinition } from '../catalog.js';
import { GoveeLanClient } from '../lan.js';
import { encodeFingerSketch } from '../protocol/finger-sketch.js';
import { decodeBase64, encodeBase64 } from '../protocol/packet.js';

type Mode = 'boundary' | 'identify' | 'restore';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function activationPacket(snapshot: SnapshotDefinition): string {
  const activation = snapshot.packets.find(value => {
    const packet = decodeBase64(value);
    return packet[0] === 0x33 && packet[1] === 0x05 && packet[2] === 0x0a;
  });
  if (!activation) {
    throw new Error(`Snapshot ${snapshot.name} has no Finger Sketch activation packet`);
  }
  return activation;
}

function integerArgument(name: string): number {
  const value = Number(argument(name));
  if (!Number.isInteger(value)) {
    throw new Error(`--${name} must be an integer`);
  }
  return value;
}

async function main(): Promise<void> {
  const mode = (argument('mode') ?? '') as Mode;
  if (!['boundary', 'identify', 'restore'].includes(mode)) {
    throw new Error('--mode must be boundary, identify, or restore');
  }
  const address = argument('device-ip');
  if (!address) {
    throw new Error('--device-ip is required');
  }
  const catalogPath = resolve(argument('catalog')
    ?? join(homedir(), '.homebridge', 'govee-pixel-zones', 'snapshots.json'));
  const catalog = validateCatalog(JSON.parse(await readFile(catalogPath, 'utf8')));
  const baseName = argument('base');
  if (!baseName) {
    throw new Error('--base is required and must name a snapshot to restore after calibration');
  }
  const base = catalog.snapshots.find(snapshot => snapshot.name === baseName);
  if (!base) {
    throw new Error(`Snapshot ${baseName} is not present in ${catalogPath}`);
  }

  const client = new GoveeLanClient(address);
  try {
    if (mode === 'restore') {
      await client.setBrightness(base.brightness);
      await client.sendPackets(base.packets);
      process.stdout.write(`Restored ${base.name} at ${base.brightness}%\n`);
      return;
    }

    const frame = mode === 'boundary'
      ? boundaryFrame(catalog.pixelCount, integerArgument('value'))
      : identifyPixelFrame(catalog.pixelCount, integerArgument('value') - 1);
    const brightnessText = argument('brightness');
    if (brightnessText !== undefined) {
      const brightness = Number(brightnessText);
      if (!Number.isInteger(brightness) || brightness < 1 || brightness > 100) {
        throw new Error('--brightness must be an integer from 1 through 100');
      }
      await client.setBrightness(brightness);
    }
    const packets = [
      ...encodeFingerSketch(frame).map(encodeBase64),
      activationPacket(base),
    ];
    await client.sendPackets(packets);
    if (mode === 'boundary') {
      process.stdout.write(`Rendered boundary after puck ${integerArgument('value')} of ${catalog.pixelCount}\n`);
    } else {
      process.stdout.write(`Highlighted puck ${integerArgument('value')} of ${catalog.pixelCount}\n`);
    }
  } finally {
    client.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
