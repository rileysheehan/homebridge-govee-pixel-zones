import { decodeBase64, encodeBase64 } from './protocol/packet.js';
import { encodeFingerSketch, frameToPixels, pixelsToFrame, type RgbColor } from './protocol/finger-sketch.js';
import { hsvToRgb, interpolateRgb, rgbToHsv, type HsvColor } from './color.js';
import type { SnapshotCatalog, SnapshotDefinition } from './catalog.js';

export interface ZoneDefinition {
  name: string;
  pixels: number[];
}

export interface ZoneState extends HsvColor {
  on: boolean;
}

export interface PixelTransport {
  sendPackets(packets: readonly string[]): Promise<void>;
  setBrightness(value: number): Promise<void>;
  setPower(on: boolean): Promise<void>;
}

export interface ControllerState {
  power: boolean;
  brightness: number;
  activeSnapshot?: string;
  zones: ReadonlyMap<string, ZoneState>;
}

export interface PersistedControllerState {
  schemaVersion: 1;
  power: boolean;
  brightness: number;
  activeSnapshot?: string;
  pixels?: RgbColor[];
  speed?: number;
  background?: RgbColor;
  activationPacket?: string;
}

type StateListener = (state: ControllerState) => void;

function sameColor(left: RgbColor, right: RgbColor): boolean {
  return left.red === right.red && left.green === right.green && left.blue === right.blue;
}

function scaleColorBrightness(color: RgbColor, factor: number): RgbColor {
  const hsv = rgbToHsv(color);
  return hsvToRgb({ ...hsv, brightness: hsv.brightness * factor });
}

export class PixelController {
  private readonly snapshots = new Map<string, SnapshotDefinition>();
  private readonly zones = new Map<string, ZoneDefinition>();
  private readonly zoneStates = new Map<string, ZoneState>();
  private readonly listeners = new Set<StateListener>();
  private pixels: RgbColor[];
  private renderedPixels: RgbColor[];
  private speed: number;
  private background: RgbColor;
  private renderedBackground: RgbColor;
  private activationPacket: string;
  private renderTimer?: NodeJS.Timeout;
  private renderWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  private pendingRenderBrightness?: number;
  private operation = Promise.resolve();
  private _power = true;
  private _brightness: number;
  private _activeSnapshot?: string;

  constructor(
    readonly catalog: SnapshotCatalog,
    zones: readonly ZoneDefinition[],
    private readonly transport: PixelTransport,
    baseSnapshotName: string,
    private readonly debounceMs = 80,
    private readonly transitionMs = 1500,
    private readonly frameIntervalMs = 200,
    initialState?: PersistedControllerState,
  ) {
    for (const snapshot of catalog.snapshots) {
      this.snapshots.set(snapshot.name, snapshot);
    }
    const base = this.requireSnapshot(baseSnapshotName);
    this.pixels = frameToPixels(base.frame, catalog.pixelCount);
    this.renderedPixels = this.pixels.map(color => ({ ...color }));
    this.speed = base.frame.speed;
    this.background = { ...base.frame.background };
    this.renderedBackground = { ...base.frame.background };
    this.activationPacket = this.activationFrom(base);
    this._brightness = base.brightness;
    this._activeSnapshot = base.name;
    this.restoreInitialState(initialState);
    this.validateZones(zones);
    for (const zone of zones) {
      this.zones.set(zone.name, { name: zone.name, pixels: [...zone.pixels] });
    }
    this.refreshZoneStates();
  }

  get state(): ControllerState {
    return {
      power: this._power,
      brightness: this._brightness,
      activeSnapshot: this._activeSnapshot,
      zones: new Map(this.zoneStates),
    };
  }

  get persistedState(): PersistedControllerState {
    const state: PersistedControllerState = {
      schemaVersion: 1,
      power: this._power,
      brightness: this._brightness,
      activeSnapshot: this._activeSnapshot,
    };
    if (!this._activeSnapshot) {
      state.pixels = this.pixels.map(color => ({ ...color }));
      state.speed = this.speed;
      state.background = { ...this.background };
      state.activationPacket = this.activationPacket;
    }
    return state;
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async activateSnapshot(name: string): Promise<void> {
    const snapshot = this.requireSnapshot(name);
    await this.serial(async () => {
      const nextPixels = frameToPixels(snapshot.frame, this.catalog.pixelCount);
      const samePixelLayout = this.pixels.every((color, pixel) => sameColor(color, nextPixels[pixel]));
      await this.ensurePoweredForTransition();
      // Default and Late Night are visually identical Finger Sketch frames at
      // different master brightnesses. Avoid reloading the frame in that case:
      // the Govee scene reload is the source of the visible off/on flash.
      if (samePixelLayout) {
        await this.transitionBrightness(snapshot.brightness);
      } else {
        await this.transitionPixels(nextPixels, {
          brightness: snapshot.brightness,
          speed: snapshot.frame.speed,
          background: snapshot.frame.background,
          activationPacket: this.activationFrom(snapshot),
          finalPackets: snapshot.packets,
        });
      }
      this.pixels = nextPixels;
      this.speed = snapshot.frame.speed;
      this.background = { ...snapshot.frame.background };
      this.activationPacket = this.activationFrom(snapshot);
      this._brightness = snapshot.brightness;
      this._power = true;
      this._activeSnapshot = snapshot.name;
      this.refreshZoneStates();
      this.emit();
    });
  }

  async setPower(on: boolean): Promise<void> {
    await this.serial(async () => {
      if (on === this._power) {
        // Cached state is not proof that the physical controller obeyed.
        await this.transport.setPower(on);
        return;
      }
      if (on) {
        const targetBrightness = this._brightness;
        await this.ensurePoweredForTransition();
        await this.transitionBrightness(targetBrightness);
      } else {
        const targetBrightness = this._brightness;
        await this.transitionBrightness(1);
        await this.transport.setPower(false);
        this._power = false;
        // HomeKit lights retain their requested brightness while off. Keeping
        // it here also gives the next power-on operation a useful ramp target.
        this._brightness = targetBrightness;
        this.refreshZoneStates();
        this.emit();
      }
    });
  }

  async setBrightness(value: number): Promise<void> {
    const brightness = Math.max(1, Math.min(100, Math.round(value)));
    await this.serial(async () => {
      await this.ensurePoweredForTransition();
      await this.transitionBrightness(brightness);
    });
  }

  updateZone(name: string, patch: Partial<ZoneState>): Promise<void> {
    const current = this.zoneStates.get(name);
    const zone = this.zones.get(name);
    if (!current || !zone) {
      return Promise.reject(new Error(`Unknown pixel zone: ${name}`));
    }
    this.materializeGlobalBrightness();
    const next: ZoneState = {
      on: patch.on ?? current.on,
      hue: patch.hue ?? current.hue,
      saturation: patch.saturation ?? current.saturation,
      brightness: patch.brightness ?? current.brightness,
    };
    this.zoneStates.set(name, next);
    const color = next.on ? hsvToRgb(next) : this.background;
    for (const pixel of zone.pixels) {
      this.pixels[pixel] = { ...color };
    }
    if ([...this.zoneStates.values()].every(state => !state.on)) {
      // A HomeKit light group turns its members off one at a time. Once the
      // final zone is off, include unassigned pucks in the fade and then power
      // down the physical controller after the frame reaches darkness.
      this.pixels = this.pixels.map(() => ({ ...this.background }));
    }
    this._activeSnapshot = undefined;
    this.emit();
    return this.scheduleRender();
  }

  private scheduleRender(): Promise<void> {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    const promise = new Promise<void>((resolve, reject) => {
      this.renderWaiters.push({ resolve, reject });
    });
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      const waiters = this.renderWaiters;
      this.renderWaiters = [];
      this.serial(async () => {
        const target = this.pixels.map(color => ({ ...color }));
        const targetBrightness = this.pendingRenderBrightness ?? this._brightness;
        this.pendingRenderBrightness = undefined;
        await this.ensurePoweredForTransition();
        await this.transitionPixels(target, {
          brightness: targetBrightness,
          speed: this.speed,
          background: this.background,
          activationPacket: this.activationPacket,
        });
        this.refreshZoneStates();
        if ([...this.zoneStates.values()].every(state => !state.on)) {
          await this.transport.setPower(false);
          this._power = false;
        }
        this.emit();
      }).then(
        () => waiters.forEach(waiter => waiter.resolve()),
        error => waiters.forEach(waiter => waiter.reject(error)),
      );
    }, this.debounceMs);
    return promise;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async transitionBrightness(target: number): Promise<void> {
    const start = this._brightness;
    const difference = target - start;
    const steps = this.transitionMs <= 0 || difference === 0
      ? 1
      : Math.min(Math.abs(difference), Math.max(1, Math.ceil(this.transitionMs / 100)));
    const interval = steps > 1 ? this.transitionMs / steps : 0;
    let previous = start;
    for (let step = 1; step <= steps; step += 1) {
      const value = Math.round(start + (difference * step / steps));
      if (value !== previous || step === steps) {
        await this.transport.setBrightness(value);
        previous = value;
        this._brightness = value;
        this._power = true;
        this.refreshZoneStates();
        this.emit();
      }
      if (interval > 0 && step < steps) {
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
  }

  private async ensurePoweredForTransition(): Promise<void> {
    if (this._power) {
      return;
    }
    // Preload minimum brightness while the controller is still off, then
    // switch it on and perform the visible ramp from that near-dark state.
    await this.transport.setBrightness(1);
    this._brightness = 1;
    await this.transport.setPower(true);
    this._power = true;
    this.refreshZoneStates();
    this.emit();
  }

  private materializeGlobalBrightness(): void {
    if (this.pendingRenderBrightness === 100 || this._brightness === 100) {
      return;
    }
    const factor = this._brightness / 100;
    this.pixels = this.pixels.map(color => scaleColorBrightness(color, factor));
    this.background = scaleColorBrightness(this.background, factor);
    this.pendingRenderBrightness = 100;
  }

  private async transitionPixels(
    targetPixels: readonly RgbColor[],
    options: {
      brightness: number;
      speed: number;
      background: RgbColor;
      activationPacket: string;
      finalPackets?: readonly string[];
    },
  ): Promise<void> {
    const startPixels = this.renderedPixels.map(color => ({ ...color }));
    const startBackground = { ...this.renderedBackground };
    const startBrightness = this._brightness;
    const steps = this.transitionMs <= 0
      ? 1
      : Math.max(1, Math.ceil(this.transitionMs / Math.max(1, this.frameIntervalMs)));
    const interval = steps > 1 ? this.transitionMs / steps : 0;
    let previousBrightness = startBrightness;

    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      const final = step === steps;
      const framePixels = final
        ? targetPixels.map(color => ({ ...color }))
        : startPixels.map((color, pixel) => interpolateRgb(color, targetPixels[pixel], progress));
      const frameBackground = final
        ? { ...options.background }
        : interpolateRgb(startBackground, options.background, progress);
      const brightness = Math.round(startBrightness + ((options.brightness - startBrightness) * progress));

      if (brightness !== previousBrightness) {
        await this.transport.setBrightness(brightness);
        previousBrightness = brightness;
        this._brightness = brightness;
        this._power = true;
        this.emit();
      }
      if (final && options.finalPackets) {
        await this.transport.sendPackets(options.finalPackets);
      } else {
        const frame = pixelsToFrame(framePixels, { speed: options.speed, background: frameBackground });
        const packets = [...encodeFingerSketch(frame).map(encodeBase64), options.activationPacket];
        await this.transport.sendPackets(packets);
      }
      this.renderedPixels = framePixels;
      this.renderedBackground = frameBackground;

      if (interval > 0 && !final) {
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
  }

  private activationFrom(snapshot: SnapshotDefinition): string {
    const activation = snapshot.packets.find(value => {
      const decoded = decodeBase64(value);
      return decoded[0] === 0x33 && decoded[1] === 0x05 && decoded[2] === 0x0a;
    });
    if (!activation) {
      throw new Error(`Snapshot ${snapshot.name} has no Finger Sketch activation packet`);
    }
    return activation;
  }

  private restoreInitialState(initialState?: PersistedControllerState): void {
    if (!initialState) {
      return;
    }
    if (initialState.schemaVersion !== 1
      || typeof initialState.power !== 'boolean'
      || !Number.isInteger(initialState.brightness)
      || initialState.brightness < 1
      || initialState.brightness > 100) {
      throw new Error('Invalid persisted controller state');
    }
    if (initialState.activeSnapshot) {
      const snapshot = this.requireSnapshot(initialState.activeSnapshot);
      this.pixels = frameToPixels(snapshot.frame, this.catalog.pixelCount);
      this.renderedPixels = this.pixels.map(color => ({ ...color }));
      this.speed = snapshot.frame.speed;
      this.background = { ...snapshot.frame.background };
      this.renderedBackground = { ...snapshot.frame.background };
      this.activationPacket = this.activationFrom(snapshot);
      this._activeSnapshot = snapshot.name;
    } else if (initialState.pixels) {
      if (initialState.pixels.length !== this.catalog.pixelCount
        || !initialState.pixels.every(color => this.validColor(color))
        || !Number.isInteger(initialState.speed)
        || !initialState.background
        || !this.validColor(initialState.background)
        || typeof initialState.activationPacket !== 'string') {
        throw new Error('Invalid persisted custom pixel state');
      }
      this.pixels = initialState.pixels.map(color => ({ ...color }));
      this.renderedPixels = this.pixels.map(color => ({ ...color }));
      this.speed = initialState.speed!;
      this.background = { ...initialState.background };
      this.renderedBackground = { ...initialState.background };
      this.activationPacket = initialState.activationPacket;
      this._activeSnapshot = undefined;
    }
    this._power = initialState.power;
    this._brightness = initialState.brightness;
  }

  private validColor(value: RgbColor): boolean {
    return [value.red, value.green, value.blue]
      .every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255);
  }

  private requireSnapshot(name: string): SnapshotDefinition {
    const snapshot = this.snapshots.get(name);
    if (!snapshot) {
      throw new Error(`Snapshot ${name} is not present in the catalog`);
    }
    return snapshot;
  }

  private validateZones(zones: readonly ZoneDefinition[]): void {
    const names = new Set<string>();
    const assigned = new Set<number>();
    for (const zone of zones) {
      if (!zone.name || names.has(zone.name)) {
        throw new Error(`Pixel zone names must be non-empty and unique: ${zone.name}`);
      }
      names.add(zone.name);
      if (zone.pixels.length === 0) {
        throw new Error(`Pixel zone ${zone.name} has no pixels`);
      }
      for (const pixel of zone.pixels) {
        if (!Number.isInteger(pixel) || pixel < 0 || pixel >= this.catalog.pixelCount) {
          throw new RangeError(`Pixel zone ${zone.name} contains invalid pixel ${pixel}`);
        }
        if (assigned.has(pixel)) {
          throw new Error(`Pixel ${pixel} belongs to more than one zone`);
        }
        assigned.add(pixel);
      }
    }
  }

  private refreshZoneStates(): void {
    for (const zone of this.zones.values()) {
      const colors = zone.pixels.map(pixel => this.pixels[pixel]);
      const onColor = colors.find(color => !sameColor(color, this.background));
      if (!onColor) {
        const previous = this.zoneStates.get(zone.name);
        this.zoneStates.set(zone.name, {
          on: false,
          hue: previous?.hue ?? 0,
          saturation: previous?.saturation ?? 0,
          brightness: previous?.brightness ?? 100,
        });
        continue;
      }
      const color = rgbToHsv(onColor);
      this.zoneStates.set(zone.name, {
        // Pixel colors are retained while the physical controller is off so
        // HomeKit has a useful brightness to restore on the next group wake.
        // The On characteristic must still reflect physical power, otherwise
        // an off group incorrectly appears as a collection of lit zones.
        on: this._power,
        hue: color.hue,
        saturation: color.saturation,
        brightness: Math.round(color.brightness * this._brightness / 100),
      });
    }
  }

  private emit(): void {
    const state = this.state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
