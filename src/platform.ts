import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import type {
  API,
  Characteristic,
  CharacteristicValue,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { validateCatalog, type SnapshotCatalog } from './catalog.js';
import {
  PixelController,
  type ControllerState,
  type PersistedControllerState,
  type ZoneDefinition,
} from './controller.js';
import { GoveeLanClient } from './lan.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

interface PixelZonesConfig extends PlatformConfig {
  deviceIp?: string;
  catalogPath?: string;
  baseSnapshot?: string;
  zones?: ZoneDefinition[];
  debounceMs?: number;
  transitionMs?: number;
}

type AccessoryKind = 'snapshot' | 'zone';

interface PixelAccessoryContext {
  kind: AccessoryKind;
  key: string;
  name: string;
}

export class GoveePixelZonesPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly configured = new Set<string>();
  private controller?: PixelController;
  private catalog?: SnapshotCatalog;
  private lanClient?: GoveeLanClient;
  private statePath?: string;
  private stateWriteTimer?: NodeJS.Timeout;
  private stateWrite = Promise.resolve();

  constructor(
    readonly log: Logging,
    readonly config: PixelZonesConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.api.on('didFinishLaunching', () => {
      this.start().catch(error => this.log.error('Unable to start Govee Pixel Zones:', String(error)));
    });
    this.api.on('shutdown', () => {
      if (this.stateWriteTimer) {
        clearTimeout(this.stateWriteTimer);
        this.stateWriteTimer = undefined;
        this.queueStateWrite();
      }
      this.lanClient?.close();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    const deviceIp = this.requireConfigString('deviceIp');
    const catalogPath = this.requireConfigString('catalogPath');
    const baseSnapshot = this.requireConfigString('baseSnapshot');
    const path = isAbsolute(catalogPath) ? catalogPath : resolve(this.api.user.storagePath(), catalogPath);
    this.catalog = validateCatalog(JSON.parse(await readFile(path, 'utf8')));
    this.statePath = resolve(this.api.user.storagePath(), 'govee-pixel-zones', `${this.catalog.sku}.state.json`);
    const initialState = await this.readPersistedState();
    this.lanClient = new GoveeLanClient(deviceIp);
    this.controller = new PixelController(
      this.catalog,
      this.config.zones ?? [],
      this.lanClient,
      baseSnapshot,
      this.config.debounceMs ?? 80,
      this.config.transitionMs ?? 1500,
      200,
      initialState,
    );
    this.discoverAccessories();
    this.controller.onState(state => {
      this.updateCharacteristics(state);
      this.scheduleStateWrite();
    });
    this.updateCharacteristics(this.controller.state);
    this.scheduleStateWrite();
    this.log.info(
      'Ready for %s at %s with %d pucks, %d zones, and %d snapshots.',
      this.catalog.sku,
      deviceIp,
      this.catalog.pixelCount,
      this.config.zones?.length ?? 0,
      this.catalog.snapshots.length,
    );
  }

  private discoverAccessories(): void {
    for (const snapshot of this.catalog!.snapshots) {
      this.configureSnapshot(this.accessory('snapshot', snapshot.name, snapshot.name), snapshot.name);
    }
    for (const zone of this.config.zones ?? []) {
      this.configureZone(this.accessory('zone', zone.name, zone.name), zone.name);
    }

    const stale = [...this.accessories.values()].filter(accessory => !this.configured.has(accessory.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach(accessory => this.accessories.delete(accessory.UUID));
    }
  }

  private accessory(kind: AccessoryKind, key: string, name: string): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(`govee-pixel-zones:${this.catalog!.sku}:${kind}:${key}`);
    this.configured.add(uuid);
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
      this.log.info('Added HomeKit accessory: %s', name);
    }
    accessory.context.pixelZones = { kind, key, name } satisfies PixelAccessoryContext;
    accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, 'Govee (unofficial local control)')
      .setCharacteristic(this.Characteristic.Model, this.catalog!.sku)
      .setCharacteristic(this.Characteristic.SerialNumber, `${this.catalog!.sku}-${kind}-${key}`);
    return accessory;
  }

  private configureSnapshot(accessory: PlatformAccessory, name: string): void {
    const service = accessory.getService(this.Service.Switch)
      ?? accessory.addService(this.Service.Switch, accessory.displayName);
    service.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.controller!.state.activeSnapshot === name)
      .onSet(async value => {
        if (Boolean(value)) {
          await this.controller!.activateSnapshot(name);
        }
      });
  }

  private configureZone(accessory: PlatformAccessory, name: string): void {
    const service = accessory.getService(this.Service.Lightbulb)
      ?? accessory.addService(this.Service.Lightbulb, accessory.displayName);
    const state = () => this.controller!.state.zones.get(name)!;
    service.getCharacteristic(this.Characteristic.On)
      .onGet(() => state().on)
      .onSet(value => this.controller!.updateZone(name, { on: Boolean(value) }));
    service.getCharacteristic(this.Characteristic.Brightness)
      .onGet(() => state().brightness)
      .onSet(value => this.controller!.updateZone(name, { brightness: Number(value), on: Number(value) > 0 }));
    service.getCharacteristic(this.Characteristic.Hue)
      .onGet(() => state().hue)
      .onSet(value => this.controller!.updateZone(name, { hue: Number(value), on: true }));
    service.getCharacteristic(this.Characteristic.Saturation)
      .onGet(() => state().saturation)
      .onSet(value => this.controller!.updateZone(name, { saturation: Number(value), on: true }));
  }

  private updateCharacteristics(state: ControllerState): void {
    for (const accessory of this.accessories.values()) {
      const context = accessory.context.pixelZones as PixelAccessoryContext | undefined;
      if (!context) {
        continue;
      }
      if (context.kind === 'snapshot') {
        accessory.getService(this.Service.Switch)
          ?.updateCharacteristic(this.Characteristic.On, state.activeSnapshot === context.key);
      } else {
        const zone = state.zones.get(context.key);
        if (zone) {
          accessory.getService(this.Service.Lightbulb)
            ?.updateCharacteristic(this.Characteristic.On, zone.on)
            .updateCharacteristic(this.Characteristic.Brightness, zone.brightness as CharacteristicValue)
            .updateCharacteristic(this.Characteristic.Hue, zone.hue as CharacteristicValue)
            .updateCharacteristic(this.Characteristic.Saturation, zone.saturation as CharacteristicValue);
        }
      }
    }
  }

  private requireConfigString(key: 'deviceIp' | 'catalogPath' | 'baseSnapshot'): string {
    const value = this.config[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Missing required configuration: ${key}`);
    }
    return value;
  }

  private async readPersistedState(): Promise<PersistedControllerState | undefined> {
    try {
      return JSON.parse(await readFile(this.statePath!, 'utf8')) as PersistedControllerState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn('Ignoring unreadable saved pixel state: %s', String(error));
      }
      return undefined;
    }
  }

  private scheduleStateWrite(): void {
    if (this.stateWriteTimer) {
      clearTimeout(this.stateWriteTimer);
    }
    this.stateWriteTimer = setTimeout(() => {
      this.stateWriteTimer = undefined;
      this.queueStateWrite();
    }, 300);
  }

  private queueStateWrite(): void {
    if (!this.controller || !this.statePath) {
      return;
    }
    const state = this.controller.persistedState;
    const statePath = this.statePath;
    this.stateWrite = this.stateWrite.then(async () => {
      await mkdir(dirname(statePath), { recursive: true });
      const temporaryPath = `${statePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, statePath);
    }).catch(error => this.log.warn('Unable to save pixel state: %s', String(error)));
  }
}
