import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

export const GOVEE_CONTROL_PORT = 4003;

export interface GoveeLanMessage {
  msg: {
    cmd: string;
    data: Record<string, unknown>;
  };
}

export function ptRealMessage(packets: readonly string[]): GoveeLanMessage {
  return { msg: { cmd: 'ptReal', data: { command: [...packets] } } };
}

export function brightnessMessage(value: number): GoveeLanMessage {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new RangeError('Brightness must be an integer from 0 through 100');
  }
  return { msg: { cmd: 'brightness', data: { value } } };
}

export function powerMessage(on: boolean): GoveeLanMessage {
  return { msg: { cmd: 'turn', data: { value: on ? 1 : 0 } } };
}

export class GoveeLanClient {
  private readonly socket: Socket;

  constructor(
    private readonly address: string | (() => Promise<string>),
    socket?: Socket,
  ) {
    this.socket = socket ?? createSocket('udp4');
  }

  async send(message: GoveeLanMessage): Promise<void> {
    const address = typeof this.address === 'string' ? this.address : await this.address();
    const payload = Buffer.from(JSON.stringify(message));
    await new Promise<void>((resolve, reject) => {
      this.socket.send(payload, GOVEE_CONTROL_PORT, address, error => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  sendPackets(packets: readonly string[]): Promise<void> {
    return this.send(ptRealMessage(packets));
  }

  setBrightness(value: number): Promise<void> {
    return this.send(brightnessMessage(value));
  }

  async readPower(): Promise<boolean> {
    const address = typeof this.address === 'string' ? this.address : await this.address();
    return new Promise((resolve, reject) => {
      const sockets: Socket[] = [];
      let done = false;
      const finish = (error?: Error, power?: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const socket of sockets) {
          try { socket.close(); } catch { /* unbound */ }
        }
        if (error) reject(error);
        else resolve(power!);
      };
      const timer = setTimeout(() => finish(new Error('Govee power readback timed out')), 900);
      for (const iface of Object.values(networkInterfaces()).flat()) {
        if (!iface || iface.internal || iface.family !== 'IPv4') continue;
        const receiver = createSocket({ type: 'udp4', reuseAddr: true });
        sockets.push(receiver);
        receiver.on('error', () => {});
        receiver.on('message', (packet, remote) => {
          if (remote.address !== address) return;
          try {
            const message = JSON.parse(packet.toString()).msg;
            if (message?.cmd === 'devStatus' && [0, 1].includes(message.data?.onOff)) {
              finish(undefined, message.data.onOff === 1);
            }
          } catch { /* Ignore unrelated or malformed responses. */ }
        });
        receiver.bind(4002, iface.address, () => {
          if (done) return;
          receiver.send(Buffer.from(JSON.stringify({ msg: { cmd: 'devStatus', data: {} } })), GOVEE_CONTROL_PORT, address, () => {});
        });
      }
    });
  }

  async setPower(on: boolean): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.send(powerMessage(on));
        await new Promise(resolve => setTimeout(resolve, 150));
        if (await this.readPower() === on) return;
        lastError = new Error('Controller reported the opposite power state');
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Govee power ${on ? 'on' : 'off'} not confirmed after 3 attempts: ${String(lastError)}`);
  }

  close(): void {
    this.socket.close();
  }
}
