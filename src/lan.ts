import { createSocket, type Socket } from 'node:dgram';

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
    private readonly address: string,
    socket?: Socket,
  ) {
    this.socket = socket ?? createSocket('udp4');
  }

  async send(message: GoveeLanMessage): Promise<void> {
    const payload = Buffer.from(JSON.stringify(message));
    await new Promise<void>((resolve, reject) => {
      this.socket.send(payload, GOVEE_CONTROL_PORT, this.address, error => {
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

  setPower(on: boolean): Promise<void> {
    return this.send(powerMessage(on));
  }

  close(): void {
    this.socket.close();
  }
}
