import assert from 'node:assert/strict';
import test from 'node:test';

import type { SnapshotCatalog } from './catalog.js';
import { PixelController, type PixelTransport } from './controller.js';
import { encodeFingerSketch } from './protocol/finger-sketch.js';
import { encodeBase64, packet } from './protocol/packet.js';

class FakeTransport implements PixelTransport {
  readonly calls: Array<{ type: string; value: unknown }> = [];
  async sendPackets(value: readonly string[]) { this.calls.push({ type: 'packets', value }); }
  async setBrightness(value: number) { this.calls.push({ type: 'brightness', value }); }
  async setPower(value: boolean) { this.calls.push({ type: 'power', value }); }
}

function snapshot(name: string, brightness: number, color: { red: number; green: number; blue: number }, speed = 1) {
  const frame = {
    speed,
    background: { red: 1, green: 1, blue: 1 },
    groups: [{ color, pixels: [0, 1, 2, 3] }],
  };
  return {
    name,
    brightness,
    frame,
    packets: [
      ...encodeFingerSketch(frame),
      packet([0x33, 0x05, 0x0a, 0x25, 0x00, 0x03]),
    ].map(encodeBase64),
  };
}

const catalog: SnapshotCatalog = {
  schemaVersion: 1,
  sku: 'H706A',
  pixelCount: 4,
  snapshots: [
    snapshot('Default', 50, { red: 255, green: 152, blue: 41 }),
    snapshot('Christmas', 100, { red: 255, green: 0, blue: 0 }),
  ],
};

const lateNightCatalog: SnapshotCatalog = {
  ...catalog,
  snapshots: [
    catalog.snapshots[0],
    snapshot('Late Night', 5, { red: 255, green: 152, blue: 41 }),
  ],
};

// The live catalogue's Late Night differs from Default only in its speed byte.
const seasonalCatalog: SnapshotCatalog = {
  ...catalog,
  snapshots: [
    catalog.snapshots[0],
    snapshot('Halloween', 100, { red: 255, green: 60, blue: 0 }, 100),
    snapshot('Late Night', 5, { red: 255, green: 152, blue: 41 }, 30),
  ],
};

function halloweenController(transport: FakeTransport) {
  return new PixelController(seasonalCatalog, [], transport, 'Default', 0, 2, 1, {
    schemaVersion: 1,
    power: true,
    brightness: 100,
    activeSnapshot: 'Halloween',
  });
}

test('reaches late night from another layout through the base packets, then dims', async () => {
  const transport = new FakeTransport();
  const controller = halloweenController(transport);
  assert.equal(await controller.activateSnapshot('Late Night'), 'Default');
  const [base, , lateNight] = seasonalCatalog.snapshots;
  const frames = transport.calls.filter(call => call.type === 'packets');
  assert.deepEqual(frames.at(-1)?.value, base.packets);
  assert.equal(frames.some(call => JSON.stringify(call.value) === JSON.stringify(lateNight.packets)), false);
  // The final frame is the base's packets, sent at the base's own brightness
  // (never lower, never the 100% Halloween level); only then does it dim.
  const types = transport.calls.map(call => call.type);
  const lastPackets = types.lastIndexOf('packets');
  const atFinalFrame = transport.calls.slice(0, lastPackets).filter(call => call.type === 'brightness').at(-1)?.value;
  assert.equal(atFinalFrame, 50);
  const brightness = transport.calls.filter(call => call.type === 'brightness').map(call => call.value as number);
  assert.equal(brightness.at(-1), 5);
  assert.ok(brightness.every((value, index) => index === 0 || value <= brightness[index - 1]));
  assert.equal(controller.state.activeSnapshot, 'Late Night');
  assert.equal(controller.state.brightness, 5);
  assert.equal(controller.persistedState.activeSnapshot, 'Late Night');
});

test('late night after the base route then back to default only fades brightness', async () => {
  const transport = new FakeTransport();
  const controller = halloweenController(transport);
  await controller.activateSnapshot('Late Night');
  transport.calls.length = 0;
  assert.equal(await controller.activateSnapshot('Default'), undefined);
  assert.equal(transport.calls.some(call => call.type === 'packets'), false);
  assert.equal(controller.state.brightness, 50);
});

test('activating the base look itself from another layout is unchanged', async () => {
  const transport = new FakeTransport();
  const controller = halloweenController(transport);
  await controller.activateSnapshot('Default');
  const [base] = seasonalCatalog.snapshots;
  const types = transport.calls.map(call => call.type);
  // Brightness ramps alongside the crossfade, ending on Default's own packets.
  assert.deepEqual(types, ['brightness', 'packets', 'brightness', 'packets']);
  assert.deepEqual(transport.calls.at(-1)?.value, base.packets);
  assert.equal(controller.state.brightness, 50);
});

test('a different layout still loads its own packets', async () => {
  const transport = new FakeTransport();
  const controller = new PixelController(seasonalCatalog, [], transport, 'Default', 0, 2, 1);
  assert.equal(await controller.activateSnapshot('Halloween'), 'Halloween');
  assert.deepEqual(transport.calls.filter(call => call.type === 'packets').at(-1)?.value,
    seasonalCatalog.snapshots[1].packets);
  assert.equal(controller.state.brightness, 100);
});

test('activates a snapshot locally and refreshes logical zone state', async () => {
  const transport = new FakeTransport();
  const controller = new PixelController(catalog, [
    { name: 'Left', pixels: [0, 1] },
    { name: 'Right', pixels: [2, 3] },
  ], transport, 'Default', 0, 0);
  await controller.activateSnapshot('Christmas');
  assert.deepEqual(transport.calls.map(call => call.type), ['brightness', 'packets']);
  assert.equal(controller.state.activeSnapshot, 'Christmas');
  assert.equal(controller.state.brightness, 100);
  assert.equal(controller.state.zones.get('Left')?.hue, 0);
  assert.equal(controller.state.zones.get('Left')?.brightness, 100);
});

test('reports snapshot brightness as each zone effective brightness', () => {
  const transport = new FakeTransport();
  const controller = new PixelController(lateNightCatalog, [
    { name: 'Left', pixels: [0, 1] },
    { name: 'Right', pixels: [2, 3] },
  ], transport, 'Late Night', 0, 0);
  assert.equal(controller.state.brightness, 5);
  assert.equal(controller.state.zones.get('Left')?.brightness, 5);
  assert.equal(controller.state.zones.get('Right')?.brightness, 5);
});

test('debounces HomeKit characteristic writes into one complete frame', async () => {
  const transport = new FakeTransport();
  const controller = new PixelController(catalog, [
    { name: 'Left', pixels: [0, 1] },
    { name: 'Right', pixels: [2, 3] },
  ], transport, 'Default', 5, 0);
  await Promise.all([
    controller.updateZone('Left', { hue: 300 }),
    controller.updateZone('Left', { saturation: 100 }),
    controller.updateZone('Left', { brightness: 75 }),
  ]);
  assert.equal(transport.calls.filter(call => call.type === 'packets').length, 1);
  assert.equal(controller.state.activeSnapshot, undefined);
  assert.equal(controller.state.zones.get('Left')?.hue, 300);
  assert.equal(controller.state.zones.get('Left')?.brightness, 75);
  assert.equal(controller.state.zones.get('Right')?.brightness, 50);
  assert.equal(controller.state.brightness, 100);
});

test('materializes snapshot master brightness before independent zone control', async () => {
  const transport = new FakeTransport();
  const controller = new PixelController(catalog, [
    { name: 'Left', pixels: [0, 1] },
    { name: 'Right', pixels: [2, 3] },
  ], transport, 'Default', 0, 0);
  await controller.updateZone('Left', { brightness: 75 });
  assert.deepEqual(transport.calls.map(call => call.type), ['brightness', 'packets']);
  assert.equal(transport.calls[0].value, 100);
  assert.equal(controller.state.zones.get('Left')?.brightness, 75);
  assert.equal(controller.state.zones.get('Right')?.brightness, 50);
});

test('turning every zone off fades all pucks and powers down the controller', async () => {
  const transport = new FakeTransport();
  const controller = new PixelController(catalog, [
    { name: 'Left', pixels: [0] },
    { name: 'Right', pixels: [1] },
  ], transport, 'Default', 5, 0);
  await Promise.all([
    controller.updateZone('Left', { on: false }),
    controller.updateZone('Right', { on: false }),
  ]);
  assert.equal(transport.calls.at(-1)?.type, 'power');
  assert.equal(transport.calls.at(-1)?.value, false);
  assert.equal(controller.state.power, false);
  assert.equal(controller.state.zones.get('Left')?.on, false);
  assert.equal(controller.state.zones.get('Right')?.on, false);
});

test('an unconfirmed power off still makes the next wake send an explicit power on', async () => {
  class UnconfirmedOff extends FakeTransport {
    override async setPower(value: boolean) {
      await super.setPower(value);
      if (!value) {
        throw new Error('Govee power off not confirmed');
      }
    }
  }
  const transport = new UnconfirmedOff();
  const controller = new PixelController(catalog, [
    { name: 'Left', pixels: [0, 1] },
    { name: 'Right', pixels: [2, 3] },
  ], transport, 'Default', 5, 0);
  const results = await Promise.allSettled([
    controller.updateZone('Left', { on: false }),
    controller.updateZone('Right', { on: false }),
  ]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(controller.state.power, false);
  assert.equal(controller.persistedState.power, false);
  transport.calls.length = 0;
  await controller.updateZone('Left', { on: true });
  assert.deepEqual(transport.calls.filter(call => call.type === 'power'), [{ type: 'power', value: true }]);
});

test('turning a grouped zone back on wakes and ramps the controller', async () => {
  const transport = new FakeTransport();
  const controller = new PixelController(catalog, [
    { name: 'Left', pixels: [0, 1] },
    { name: 'Right', pixels: [2, 3] },
  ], transport, 'Default', 5, 0);
  await Promise.all([
    controller.updateZone('Left', { on: false }),
    controller.updateZone('Right', { on: false }),
  ]);
  transport.calls.length = 0;
  await controller.updateZone('Left', { on: true });
  assert.deepEqual(transport.calls.map(call => call.type), [
    'brightness',
    'power',
    'brightness',
    'packets',
  ]);
  assert.equal(controller.state.power, true);
  assert.equal(controller.state.zones.get('Left')?.on, true);
  assert.equal(controller.state.zones.get('Left')?.brightness, 50);
});

test('fades an identical late-night layout without reloading Finger Sketch', async () => {
  const transport = new FakeTransport();
  const controller = new PixelController(lateNightCatalog, [], transport, 'Default', 0, 1);
  await controller.activateSnapshot('Late Night');
  assert.equal(transport.calls.some(call => call.type === 'packets'), false);
  assert.equal(transport.calls.at(-1)?.value, 5);
  assert.equal(controller.state.brightness, 5);
  assert.equal(controller.state.activeSnapshot, 'Late Night');
});

test('crossfades a different snapshot and finishes with its exact captured packets', async () => {
  const transport = new FakeTransport();
  const controller = new PixelController(catalog, [], transport, 'Default', 0, 2, 1);
  await controller.activateSnapshot('Christmas');
  const frames = transport.calls.filter(call => call.type === 'packets');
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.at(-1)?.value, catalog.snapshots[1].packets);
  assert.equal(controller.state.activeSnapshot, 'Christmas');
  assert.equal(controller.state.brightness, 100);
});

test('fades power off while retaining the requested brightness for the next wake', async () => {
  const transport = new FakeTransport();
  const controller = new PixelController(catalog, [
    { name: 'All', pixels: [0, 1, 2, 3] },
  ], transport, 'Default', 0, 0);
  await controller.setPower(false);
  assert.deepEqual(transport.calls, [
    { type: 'brightness', value: 1 },
    { type: 'power', value: false },
  ]);
  assert.equal(controller.state.power, false);
  assert.equal(controller.state.brightness, 50);
  assert.equal(controller.state.zones.get('All')?.on, false);
  assert.equal(controller.state.zones.get('All')?.brightness, 50);
});

test('powers on at minimum brightness and ramps to the retained level', async () => {
  const transport = new FakeTransport();
  const controller = new PixelController(catalog, [], transport, 'Default', 0, 0);
  await controller.setPower(false);
  transport.calls.length = 0;
  await controller.setPower(true);
  assert.deepEqual(transport.calls, [
    { type: 'brightness', value: 1 },
    { type: 'power', value: true },
    { type: 'brightness', value: 50 },
  ]);
  assert.equal(controller.state.power, true);
  assert.equal(controller.state.brightness, 50);
});

test('wakes before applying a snapshot while the controller is off', async () => {
  const transport = new FakeTransport();
  const controller = new PixelController(lateNightCatalog, [], transport, 'Default', 0, 0);
  await controller.setPower(false);
  transport.calls.length = 0;
  await controller.activateSnapshot('Late Night');
  assert.deepEqual(transport.calls, [
    { type: 'brightness', value: 1 },
    { type: 'power', value: true },
    { type: 'brightness', value: 5 },
  ]);
  assert.equal(controller.state.power, true);
  assert.equal(controller.state.activeSnapshot, 'Late Night');
});

test('restores a persisted snapshot and brightness after a bridge restart', () => {
  const transport = new FakeTransport();
  const controller = new PixelController(lateNightCatalog, [], transport, 'Default', 0, 0, 200, {
    schemaVersion: 1,
    power: true,
    brightness: 5,
    activeSnapshot: 'Late Night',
  });
  assert.equal(controller.state.power, true);
  assert.equal(controller.state.brightness, 5);
  assert.equal(controller.state.activeSnapshot, 'Late Night');
  assert.deepEqual(controller.persistedState, {
    schemaVersion: 1,
    power: true,
    brightness: 5,
    activeSnapshot: 'Late Night',
  });
});
