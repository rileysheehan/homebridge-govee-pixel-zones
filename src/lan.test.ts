import assert from 'node:assert/strict';
import test from 'node:test';

import { GoveeLanClient, type GoveeLanMessage, type PowerConfirmOptions } from './lan.js';

/** A controller whose devStatus keeps reporting the old power state for a while. */
class LaggingClient extends GoveeLanClient {
  readonly sent: GoveeLanMessage[] = [];
  reads = 0;

  constructor(private readonly staleReads: number, private readonly physical: boolean, options: PowerConfirmOptions) {
    super('192.0.2.1', { close() {} } as never, options);
  }

  override async send(message: GoveeLanMessage): Promise<void> {
    this.sent.push(message);
  }

  override async readPower(): Promise<boolean> {
    this.reads += 1;
    return this.reads <= this.staleReads ? !this.physical : this.physical;
  }
}

test('waits out a controller that still reports on after off, resending as it goes', async () => {
  const confirmed: Array<[boolean, number]> = [];
  const client = new LaggingClient(6, false, {
    confirmMs: 1000,
    resendMs: 50,
    pollMs: 20,
    onConfirmed: (on, _elapsed, sends) => confirmed.push([on, sends]),
  });
  await client.setPower(false);
  assert.equal(client.reads, 7);
  assert.ok(client.sent.length >= 2, `expected a resend, got ${client.sent.length}`);
  assert.ok(client.sent.every(message => message.msg.cmd === 'turn' && message.msg.data.value === 0));
  assert.deepEqual(confirmed, [[false, client.sent.length]]);
});

test('confirms on the first readback without resending when the controller agrees', async () => {
  const client = new LaggingClient(0, true, { confirmMs: 1000, resendMs: 500, pollMs: 20 });
  await client.setPower(true);
  assert.equal(client.reads, 1);
  assert.equal(client.sent.length, 1);
});

test('reports failure only after the whole confirmation window', async () => {
  const client = new LaggingClient(Number.POSITIVE_INFINITY, false, { confirmMs: 200, resendMs: 60, pollMs: 20 });
  const started = Date.now();
  await assert.rejects(client.setPower(false), /power off not confirmed within 200 ms \(\d+ sends\)/);
  assert.ok(Date.now() - started >= 200);
  assert.ok(client.sent.length >= 2);
});
