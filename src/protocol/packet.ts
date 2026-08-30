import { Buffer } from 'node:buffer';

export const PACKET_LENGTH = 20;
const DATA_LENGTH = PACKET_LENGTH - 1;

export function xorChecksum(bytes: Uint8Array): number {
  let checksum = 0;
  for (const byte of bytes) {
    checksum ^= byte;
  }
  return checksum;
}

export function packet(payload: Iterable<number>): Buffer {
  const bytes = Buffer.alloc(PACKET_LENGTH);
  const values = [...payload];
  if (values.length > DATA_LENGTH) {
    throw new RangeError(`Govee packet payload exceeds ${DATA_LENGTH} bytes`);
  }
  bytes.set(values, 0);
  bytes[DATA_LENGTH] = xorChecksum(bytes.subarray(0, DATA_LENGTH));
  return bytes;
}

export function assertPacket(value: Uint8Array): void {
  if (value.length !== PACKET_LENGTH) {
    throw new Error(`Expected a ${PACKET_LENGTH}-byte Govee packet, got ${value.length}`);
  }
  const expected = xorChecksum(value.subarray(0, DATA_LENGTH));
  if (value[DATA_LENGTH] !== expected) {
    throw new Error(`Invalid Govee packet checksum: expected 0x${expected.toString(16).padStart(2, '0')}`);
  }
}

export function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

export function decodeBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  assertPacket(decoded);
  return decoded;
}

export function encodeMultiPacket(payload: Uint8Array): Buffer[] {
  const firstCapacity = 15;
  const continuationCapacity = 17;
  const first = payload.subarray(0, firstCapacity);
  const remaining = payload.subarray(firstCapacity);
  const continuationCount = Math.max(1, Math.ceil(remaining.length / continuationCapacity));
  const packetCount = 1 + continuationCount;

  const output: Buffer[] = [packet([0xa3, 0x00, 0x01, packetCount, ...first])];
  for (let index = 0; index < continuationCount; index += 1) {
    const start = index * continuationCapacity;
    const chunk = remaining.subarray(start, start + continuationCapacity);
    const sequence = index === continuationCount - 1 ? 0xff : index + 1;
    output.push(packet([0xa3, sequence, ...chunk]));
  }
  return output;
}

export function decodeMultiPacket(packets: readonly Uint8Array[]): Buffer {
  if (packets.length < 2) {
    throw new Error('A Govee multi-packet command requires a start and final packet');
  }
  packets.forEach(assertPacket);

  const first = packets[0];
  if (first[0] !== 0xa3 || first[1] !== 0x00 || first[2] !== 0x01) {
    throw new Error('Invalid Govee multi-packet start frame');
  }
  if (first[3] !== packets.length) {
    throw new Error(`Multi-packet header declares ${first[3]} packets, received ${packets.length}`);
  }

  const final = packets.at(-1)!;
  if (final[0] !== 0xa3 || final[1] !== 0xff) {
    throw new Error('Invalid Govee multi-packet final frame');
  }

  for (let index = 1; index < packets.length - 1; index += 1) {
    if (packets[index][0] !== 0xa3 || packets[index][1] !== index) {
      throw new Error(`Invalid Govee continuation sequence at packet ${index}`);
    }
  }

  return Buffer.concat([
    Buffer.from(first.subarray(4, DATA_LENGTH)),
    ...packets.slice(1).map(value => Buffer.from(value.subarray(2, DATA_LENGTH))),
  ]);
}
