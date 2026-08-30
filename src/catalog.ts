import { decodeBase64, encodeBase64 } from './protocol/packet.js';
import { decodeFingerSketch, type FingerSketchFrame } from './protocol/finger-sketch.js';

export interface SnapshotDefinition {
  name: string;
  snapshotId?: number;
  brightness: number;
  packets: string[];
  frame: FingerSketchFrame;
}

export interface SnapshotCatalog {
  schemaVersion: 1;
  sku: string;
  pixelCount: number;
  snapshots: SnapshotDefinition[];
}

interface AccountCommand {
  iotCmd?: string | Record<string, unknown>;
}

interface AccountSnapshot {
  name?: string;
  snapshotId?: number;
  cmds?: AccountCommand[];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function commandFrom(value: unknown): { cmd?: string; data?: Record<string, unknown> } {
  const parsed = parseJson(value) as { msg?: { cmd?: string; data?: Record<string, unknown> } } | undefined;
  return parsed?.msg ?? {};
}

export function importAccountSnapshots(
  response: unknown,
  options: { sku: string; pixelCount: number; names?: readonly string[] },
): SnapshotCatalog {
  const root = response as { data?: { snapshots?: AccountSnapshot[] } };
  const snapshots = root?.data?.snapshots;
  if (!Array.isArray(snapshots)) {
    throw new Error('Govee response does not contain data.snapshots[]');
  }
  const wanted = options.names ? new Set(options.names) : undefined;
  const imported: SnapshotDefinition[] = [];

  for (const snapshot of snapshots) {
    if (!snapshot.name || (wanted && !wanted.has(snapshot.name))) {
      continue;
    }
    let brightness: number | undefined;
    let packets: string[] | undefined;

    for (const entry of snapshot.cmds ?? []) {
      const command = commandFrom(entry.iotCmd);
      if (command.cmd === 'brightness') {
        // Govee's account snapshot endpoint currently calls this field `val`,
        // while LAN commands use `value`. Accept both so imports survive either
        // representation without copying the rest of the account response.
        const value = command.data?.val ?? command.data?.value;
        if (typeof value === 'number') {
          brightness = value;
        }
      }
      if (command.cmd === 'ptReal') {
        const value = command.data?.command;
        if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
          packets = value;
        }
      }
    }

    if (brightness === undefined || !packets) {
      throw new Error(`Snapshot ${snapshot.name} is missing brightness or ptReal commands`);
    }
    const decoded = packets.map(decodeBase64);
    const multiPackets = decoded.filter(packet => packet[0] === 0xa3);
    const activation = decoded.find(packet => packet[0] === 0x33 && packet[1] === 0x05 && packet[2] === 0x0a);
    if (multiPackets.length < 2 || !activation) {
      throw new Error(`Snapshot ${snapshot.name} is not a supported Finger Sketch snapshot`);
    }
    const frame = decodeFingerSketch(multiPackets);
    imported.push({
      name: snapshot.name,
      snapshotId: snapshot.snapshotId,
      brightness,
      packets: [...multiPackets, activation].map(encodeBase64),
      frame,
    });
  }

  if (wanted) {
    for (const name of wanted) {
      if (!imported.some(snapshot => snapshot.name === name)) {
        throw new Error(`Requested snapshot ${name} was not found`);
      }
    }
  }
  return {
    schemaVersion: 1,
    sku: options.sku,
    pixelCount: options.pixelCount,
    snapshots: imported,
  };
}

export function validateCatalog(value: unknown): SnapshotCatalog {
  const catalog = value as SnapshotCatalog;
  if (catalog?.schemaVersion !== 1 || typeof catalog.sku !== 'string' || !Number.isInteger(catalog.pixelCount)) {
    throw new Error('Invalid Govee Pixel Zones snapshot catalog');
  }
  if (!Array.isArray(catalog.snapshots) || catalog.snapshots.length === 0) {
    throw new Error('Snapshot catalog contains no snapshots');
  }
  for (const snapshot of catalog.snapshots) {
    if (typeof snapshot.name !== 'string' || !Array.isArray(snapshot.packets)) {
      throw new Error('Snapshot catalog contains an invalid snapshot');
    }
    const decoded = snapshot.packets.map(decodeBase64);
    decodeFingerSketch(decoded.filter(packet => packet[0] === 0xa3));
  }
  return catalog;
}
