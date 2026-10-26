import { createSocket, type Socket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

export function normalizeIdentity(value: string): string {
  const normalized = value.replace(/[:-]/g, '').toUpperCase();
  if (!/^(?:[0-9A-F]{12}|[0-9A-F]{16})$/.test(normalized)) {
    throw new Error('deviceId must be a 6-byte MAC or an 8-byte Govee device ID');
  }
  return normalized;
}

export function matchesIdentity(expected: string, actual: string): boolean {
  try {
    const a = normalizeIdentity(expected);
    const b = normalizeIdentity(actual);
    return a.length === 12 ? b.endsWith(a) : a === b;
  } catch {
    return false;
  }
}

/** Use the packet source, never an unverified IP supplied inside the response. */
export function discoveryAddress(packet: Buffer, source: string, identity: string, sku: string): string | undefined {
  try {
    const { msg } = JSON.parse(packet.toString());
    if (msg?.cmd === 'scan' && msg.data?.sku === sku && isIPv4(source)
      && typeof msg.data.device === 'string' && matchesIdentity(identity, msg.data.device)) return source;
  } catch { /* Ignore unrelated or malformed LAN traffic. */ }
  return undefined;
}

/** Bound fallback discovery to small directly connected IPv4 subnets. */
export function subnetHosts(address: string, netmask: string): string[] {
  if (!isIPv4(address) || !isIPv4(netmask)) return [];
  const integer = (ip: string) => ip.split('.').reduce((n, octet) => (n * 256 + Number(octet)) >>> 0, 0);
  const mask = integer(netmask);
  const wildcard = (~mask) >>> 0;
  if (wildcard < 3 || wildcard > 1023 || (wildcard & (wildcard + 1)) !== 0) return [];
  const network = (integer(address) & mask) >>> 0;
  return Array.from({ length: wildcard - 1 }, (_, index) => {
    const ip = network + index + 1;
    return [24, 16, 8, 0].map(shift => (ip >>> shift) & 255).join('.');
  }).filter(ip => ip !== address);
}

export function discoverAddress(identity: string, sku: string, hint?: string): Promise<string> {
  normalizeIdentity(identity);
  return new Promise((resolve, reject) => {
    const interfaces = Object.values(networkInterfaces()).flat().filter(iface => iface && !iface.internal && iface.family === 'IPv4');
    const sockets: Socket[] = [];
    const timers: NodeJS.Timeout[] = [];
    let finished = false;
    const finish = (error?: Error, address?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const timer of timers) clearInterval(timer);
      for (const socket of sockets) {
        try { socket.close(); } catch { /* Binding may have failed. */ }
      }
      if (error) reject(error);
      else resolve(address!);
    };
    const timer = setTimeout(() => finish(new Error('Govee controller did not answer LAN discovery; check power, LAN Control, and network isolation')), 6000);
    const scanned = new Set<string>();
    for (const iface of interfaces) {
      if (!iface) continue;
      const socket = createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(socket);
      socket.on('error', () => {});
      socket.on('message', (packet, remote) => {
        const address = discoveryAddress(packet, remote.address, identity, sku);
        if (address) finish(undefined, address);
      });
      // Bind each source address explicitly. A wildcard receiver can lose unicast
      // replies to another Govee plugin already listening on the shared port.
      socket.bind(4002, iface.address, () => {
        if (finished) return;
        const packet = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } }));
        const send = (address: string) => socket.send(packet, 4001, address, () => {});
        if (hint && isIPv4(hint)) send(hint);
        const hosts: string[] = [];
        for (const host of subnetHosts(iface.address, iface.netmask)) {
          if (scanned.size < 1024 && !scanned.has(host)) {
            scanned.add(host);
            hosts.push(host);
          }
        }
        try { socket.addMembership('239.255.255.250', iface.address); } catch { /* Membership may already exist. */ }
        try {
          socket.setMulticastInterface(iface.address);
          send('239.255.255.250');
        } catch { /* Try remaining interfaces. */ }
        // Some Wi-Fi networks suppress multicast; use only the Govee scan command,
        // paced and capped at 1024 addresses, never a generic port scan.
        timers.push(setTimeout(() => {
          const targets = hosts;
          let index = 0;
          const sweep = setInterval(() => {
            for (let count = 0; count < 8 && index < targets.length; count++) send(targets[index++]);
            if (index >= targets.length) clearInterval(sweep);
          }, 20);
          timers.push(sweep);
        }, 600));
      });
    }
  });
}

export class IdentityResolver {
  private address?: string;
  private expires = 0;
  private pending?: Promise<string>;
  private readonly discover: (hint?: string) => Promise<string>;
  private readonly now: () => number;

  constructor(discover: (hint?: string) => Promise<string>, hint?: string, now: () => number = Date.now) { this.address = hint; this.discover = discover; this.now = now; }

  resolve(): Promise<string> {
    if (this.address && this.now() < this.expires) return Promise.resolve(this.address);
    if (!this.pending) {
      this.pending = this.discover(this.address).then(address => {
        this.address = address;
        this.expires = this.now() + 10000;
        return address;
      }).finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }
}
