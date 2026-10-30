import assert from 'node:assert/strict';
import test from 'node:test';

import { applyWhiteSnapshots, importAccountSnapshots, validateCatalog, type SnapshotCatalog } from './catalog.js';
import { brightnessMessage, colorTemperatureMessage, powerMessage, ptRealMessage } from './lan.js';
import { encodeFingerSketch } from './protocol/finger-sketch.js';
import { encodeBase64, packet } from './protocol/packet.js';

const frames = [
  ...encodeFingerSketch({
    speed: 1,
    background: { red: 1, green: 1, blue: 1 },
    groups: [{ color: { red: 255, green: 0, blue: 0 }, pixels: [0, 1] }],
  }),
  packet([0x33, 0x05, 0x0a, 0x25, 0x00, 0x03]),
].map(encodeBase64);

test('imports a credential-free snapshot catalog from the account response', () => {
  const response = {
    data: {
      snapshots: [{
        name: 'Example Default',
        snapshotId: 123,
        cmds: [
          { iotCmd: JSON.stringify({ msg: { cmd: 'brightness', data: { val: 50 } } }) },
          { iotCmd: JSON.stringify({ msg: { cmd: 'ptReal', data: { command: frames } } }) },
        ],
      }],
    },
  };
  const catalog = importAccountSnapshots(response, {
    sku: 'H706A',
    pixelCount: 2,
    names: ['Example Default'],
  });
  assert.equal(catalog.snapshots[0].brightness, 50);
  assert.equal(catalog.snapshots[0].packets.length, 3);
  assert.equal(catalog.snapshots[0].frame.groups.length, 1);
  assert.equal(JSON.stringify(catalog).includes('iotCmd'), false);
  assert.equal(JSON.stringify(catalog).includes('Authorization'), false);
});

test('builds LAN-only Govee command envelopes', () => {
  assert.deepEqual(ptRealMessage(['packet']), {
    msg: { cmd: 'ptReal', data: { command: ['packet'] } },
  });
  assert.deepEqual(brightnessMessage(5), {
    msg: { cmd: 'brightness', data: { value: 5 } },
  });
  assert.deepEqual(powerMessage(true), {
    msg: { cmd: 'turn', data: { value: 1 } },
  });
});

const decodedFrame = {
  speed: 1,
  background: { red: 1, green: 1, blue: 1 },
  groups: [{ color: { red: 255, green: 0, blue: 0 }, pixels: [0, 1] }],
};
const plainCatalog: SnapshotCatalog = {
  schemaVersion: 1,
  sku: 'H706A',
  pixelCount: 2,
  snapshots: [
    { name: 'Default', brightness: 50, packets: frames, frame: decodedFrame },
    { name: 'Late Night', brightness: 5, packets: frames, frame: decodedFrame },
  ],
};

test('whiteSnapshots sets kelvin and an optional brightness on the named snapshot only', () => {
  const applied = applyWhiteSnapshots(plainCatalog, [{ snapshot: 'Late Night', kelvin: 2700, brightness: 2 }]);
  assert.deepEqual(applied.snapshots.map(entry => [entry.name, entry.kelvin, entry.brightness]),
    [['Default', undefined, 50], ['Late Night', 2700, 2]]);
  assert.equal(applyWhiteSnapshots(plainCatalog, [{ snapshot: 'Late Night', kelvin: 3000 }]).snapshots[1].brightness, 5);
  assert.equal(applyWhiteSnapshots(plainCatalog, undefined), plainCatalog);
  assert.equal(plainCatalog.snapshots[1].kelvin, undefined);
});

test('whiteSnapshots refuses unknown snapshots, duplicates and out-of-range values', () => {
  assert.throws(() => applyWhiteSnapshots(plainCatalog, [{ snapshot: 'Nope', kelvin: 2700 }]), /not in the catalog/);
  assert.throws(() => applyWhiteSnapshots(plainCatalog, [
    { snapshot: 'Late Night', kelvin: 2700 }, { snapshot: 'Late Night', kelvin: 3000 },
  ]), /more than once/);
  assert.throws(() => applyWhiteSnapshots(plainCatalog, [{ snapshot: 'Late Night', kelvin: 1500 }]), /kelvin/);
  assert.throws(() => applyWhiteSnapshots(plainCatalog, [{ snapshot: 'Late Night', kelvin: 2700, brightness: 0 }]), /brightness/);
  assert.throws(() => applyWhiteSnapshots(plainCatalog, [{ snapshot: 'Late Night', kelvin: 2700, brightness: 2.5 }]), /brightness/);
});

test('a catalog snapshot with an invalid kelvin is rejected', () => {
  assert.throws(() => validateCatalog({ ...plainCatalog, snapshots: [{ ...plainCatalog.snapshots[0], kelvin: 100 }] }), /kelvin/);
  assert.equal(validateCatalog({ ...plainCatalog, snapshots: [{ ...plainCatalog.snapshots[0], kelvin: 2700 }] }).snapshots[0].kelvin, 2700);
});

test('colorwc lights the white LEDs with an all-zero colour', () => {
  assert.deepEqual(colorTemperatureMessage(2700),
    { msg: { cmd: 'colorwc', data: { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 2700 } } });
  assert.throws(() => colorTemperatureMessage(0), RangeError);
  assert.throws(() => colorTemperatureMessage(2700.5), RangeError);
});
