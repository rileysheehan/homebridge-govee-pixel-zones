#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { importAccountSnapshots } from '../catalog.js';

interface Arguments {
  storage: string;
  sku: string;
  pixelCount: number;
  output: string;
  names?: string[];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function argumentsFromProcess(): Arguments {
  const storage = resolve(argument('storage') ?? join(homedir(), '.homebridge'));
  const pixelCount = Number(argument('pixel-count') ?? '50');
  if (!Number.isInteger(pixelCount) || pixelCount < 1 || pixelCount > 256) {
    throw new Error('--pixel-count must be an integer from 1 through 256');
  }
  const names = argument('names')?.split(',').map(value => value.trim()).filter(Boolean);
  return {
    storage,
    sku: argument('sku') ?? 'H706A',
    pixelCount,
    output: resolve(argument('output') ?? join(storage, 'govee-pixel-zones', 'snapshots.json')),
    names: names?.length ? names : undefined,
  };
}

function hapUuid(value: string): string {
  const hash = createHash('sha1').update(value).digest('hex');
  let index = -1;
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    index += 1;
    if (character === 'y') {
      return ((Number.parseInt(hash[index], 16) & 0x3) | 0x8).toString(16);
    }
    return hash[index];
  });
}

async function accountCache(storage: string): Promise<string> {
  const cacheDirectory = join(storage, 'bwp91_cache');
  for (const name of await readdir(cacheDirectory)) {
    try {
      const candidate = JSON.parse(await readFile(join(cacheDirectory, name), 'utf8')) as { key?: string; value?: string };
      if (candidate.key === 'Govee_All_Devices_temp' && typeof candidate.value === 'string') {
        return candidate.value;
      }
    } catch {
      // Ignore unrelated or non-JSON cache entries.
    }
  }
  throw new Error('Could not find the homebridge-govee account cache');
}

async function fetchJson(url: URL | string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Govee account request failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function main(): Promise<void> {
  const options = argumentsFromProcess();
  const config = JSON.parse(await readFile(join(options.storage, 'config.json'), 'utf8')) as {
    platforms?: Array<{ platform?: string; username?: string }>;
  };
  const username = config.platforms?.find(platform => platform.platform === 'Govee')?.username;
  if (!username) {
    throw new Error('Could not find the Govee username in Homebridge config');
  }
  const fields = (await accountCache(options.storage)).split(':::');
  if (fields.length !== 7 || !fields[1]) {
    throw new Error('The homebridge-govee account cache has an unsupported format');
  }
  const token = fields[1];
  const appVersion = '7.4.10';
  const clientId = `hb${hapUuid(username).replaceAll('-', '').slice(0, -2)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    appVersion,
    clientId,
    clientType: '1',
    iotVersion: '0',
    timestamp: String(Date.now()),
    'User-Agent': `GoveeHome/${appVersion} (com.ihoment.GoVeeSensor; build:8; iOS 26.5.0) Alamofire/5.11.0`,
  };

  const deviceResponse = await fetchJson('https://app2.govee.com/bff-app/v1/device/list', headers) as {
    data?: { devices?: Array<{ sku?: string; device?: string }> };
  };
  const device = deviceResponse.data?.devices?.find(candidate => candidate.sku === options.sku);
  if (!device?.device) {
    throw new Error(`No ${options.sku} device was found in the Govee account`);
  }
  const url = new URL('https://app2.govee.com/bff-app/v1/devices/snapshots');
  url.searchParams.set('sku', options.sku);
  url.searchParams.set('device', device.device);
  url.searchParams.set('snapshotId', '-1');
  const response = await fetchJson(url, headers);
  const catalog = importAccountSnapshots(response, {
    sku: options.sku,
    pixelCount: options.pixelCount,
    names: options.names,
  });

  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  await chmod(options.output, 0o600);
  process.stdout.write(`Imported ${catalog.snapshots.length} credential-free snapshots to ${options.output}\n`);
  for (const snapshot of catalog.snapshots) {
    process.stdout.write(`- ${snapshot.name}: ${snapshot.frame.groups.length} color groups, brightness ${snapshot.brightness}%\n`);
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
