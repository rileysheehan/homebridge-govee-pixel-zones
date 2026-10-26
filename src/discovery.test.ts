import test from 'node:test';
import assert from 'node:assert/strict';

import { discoveryAddress, IdentityResolver, matchesIdentity, normalizeIdentity, subnetHosts } from './discovery.js';

test('fallback targets only bounded valid local subnets', () => {
  const hosts = subnetHosts('10.0.1.1', '255.255.252.0');
  assert.equal(hosts.length, 1021);
  assert.ok(hosts.includes('10.0.0.65'));
  assert.ok(!hosts.includes('10.0.1.1'));
  assert.ok(!hosts.includes('10.0.3.255'));
  assert.deepEqual(subnetHosts('10.0.1.1', '255.0.0.0'), []);
  assert.deepEqual(subnetHosts('100.64.1.1', '255.255.255.255'), []);
  assert.deepEqual(subnetHosts('10.0.1.1', '255.255.253.0'), []);
});

test('identity matching accepts full IDs and MAC suffixes, not partial identities', () => {
  assert.equal(normalizeIdentity('aa-bb-cc-dd-ee-ff'), 'AABBCCDDEEFF');
  assert.ok(matchesIdentity('AA:BB:CC:DD:EE:FF', '11:22:AA:BB:CC:DD:EE:FF'));
  assert.ok(!matchesIdentity('33:44:AA:BB:CC:DD:EE:FF', '11:22:AA:BB:CC:DD:EE:FF'));
  assert.ok(!matchesIdentity('DD:EE:FF', '11:22:AA:BB:CC:DD:EE:FF'));
  assert.throws(() => normalizeIdentity('invalid'));
});

test('discovery selects only matching model and identity and uses packet source', () => {
  const packet = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: {
    device: '11:22:AA:BB:CC:DD:EE:FF', sku: 'H706A', ip: '192.0.2.99',
  } } }));
  assert.equal(discoveryAddress(packet, '192.0.2.2', 'AABBCCDDEEFF', 'H706A'), '192.0.2.2');
  assert.equal(discoveryAddress(packet, '192.0.2.2', 'AABBCCDDEEFF', 'H0000'), undefined);
  assert.equal(discoveryAddress(packet, '192.0.2.2', 'AABBCCDDEE00', 'H706A'), undefined);
  assert.equal(discoveryAddress(Buffer.from('bad json'), '192.0.2.2', 'AABBCCDDEEFF', 'H706A'), undefined);
});

test('resolver validates hints, shares requests, caches, and follows IP changes', async () => {
  let now = 0;
  let calls = 0;
  const resolver = new IdentityResolver(async (hint) => {
    calls++;
    assert.equal(hint, calls === 1 ? '192.0.2.1' : '192.0.2.2');
    return calls === 1 ? '192.0.2.2' : '192.0.2.3';
  }, '192.0.2.1', () => now);
  assert.deepEqual(await Promise.all([resolver.resolve(), resolver.resolve()]), ['192.0.2.2', '192.0.2.2']);
  assert.equal(calls, 1);
  await resolver.resolve();
  assert.equal(calls, 1);
  now = 10000;
  assert.equal(await resolver.resolve(), '192.0.2.3');
  assert.equal(calls, 2);
});

test('failed discovery never falls back to an unverified hint and can recover', async () => {
  let fail = true;
  let now = 0;
  const resolver = new IdentityResolver(async () => {
    if (fail) throw new Error('offline');
    return '192.0.2.2';
  }, '192.0.2.1', () => now);
  await assert.rejects(resolver.resolve(), /offline/);
  fail = false;
  assert.equal(await resolver.resolve(), '192.0.2.2');
  now = 10001;
  fail = true;
  await assert.rejects(resolver.resolve(), /offline/);
});
