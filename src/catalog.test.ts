import assert from 'node:assert/strict';
import test from 'node:test';

import { importAccountSnapshots } from './catalog.js';
import { brightnessMessage, powerMessage, ptRealMessage } from './lan.js';
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
