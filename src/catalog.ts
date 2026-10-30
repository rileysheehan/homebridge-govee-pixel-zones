import { decodeBase64, encodeBase64 } from './protocol/packet.js';
import { decodeFingerSketch, type FingerSketchFrame } from './protocol/finger-sketch.js';

export interface SnapshotDefinition {
  name: string;
  snapshotId?: number;
  brightness: number;
  packets: string[];
  frame: FingerSketchFrame;
  /**
   * When set, the snapshot is shown with the controller's own white LEDs at
   * this colour temperature (LAN `colorwc`) instead of its RGB frame. The frame
   * is kept as the snapshot's logical pixel model for HomeKit zone state.
   */
  kelvin?: number;
}

/** A Homebridge config entry that shows a snapshot with the white LEDs. */
export interface WhiteSnapshotConfig {
  snapshot: string;
  kelvin: number;
  brightness?: number;
}

export const MIN_KELVIN = 2000;
export const MAX_KELVIN = 9000;

function validKelvin(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= MIN_KELVIN && (value as number) <= MAX_KELVIN;
}

function validBrightness(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100;
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
    if (snapshot.kelvin !== undefined && !validKelvin(snapshot.kelvin)) {
      throw new Error(`Snapshot ${snapshot.name} has an invalid kelvin value`);
    }
  }
  return catalog;
}

/**
 * Applies `whiteSnapshots` from the Homebridge config to a catalog. Kept in the
 * config, not the catalog, so re-importing snapshots from the Govee account
 * never drops them.
 */
export function applyWhiteSnapshots(
  catalog: SnapshotCatalog,
  entries: readonly WhiteSnapshotConfig[] | undefined,
): SnapshotCatalog {
  if (entries === undefined) {
    return catalog;
  }
  if (!Array.isArray(entries)) {
    throw new Error('whiteSnapshots must be a list');
  }
  const byName = new Map<string, WhiteSnapshotConfig>();
  for (const entry of entries) {
    if (typeof entry?.snapshot !== 'string' || !catalog.snapshots.some(snapshot => snapshot.name === entry.snapshot)) {
      throw new Error(`whiteSnapshots names a snapshot that is not in the catalog: ${String(entry?.snapshot)}`);
    }
    if (byName.has(entry.snapshot)) {
      throw new Error(`whiteSnapshots lists ${entry.snapshot} more than once`);
    }
    if (!validKelvin(entry.kelvin)) {
      throw new Error(`whiteSnapshots ${entry.snapshot}: kelvin must be a whole number from ${MIN_KELVIN} to ${MAX_KELVIN}`);
    }
    if (entry.brightness !== undefined && !validBrightness(entry.brightness)) {
      throw new Error(`whiteSnapshots ${entry.snapshot}: brightness must be a whole number from 1 to 100`);
    }
    byName.set(entry.snapshot, entry);
  }
  return {
    ...catalog,
    snapshots: catalog.snapshots.map(snapshot => {
      const entry = byName.get(snapshot.name);
      return entry
        ? { ...snapshot, kelvin: entry.kelvin, brightness: entry.brightness ?? snapshot.brightness }
        : snapshot;
    }),
  };
}
