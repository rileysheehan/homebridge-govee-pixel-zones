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

/**
 * Lights the controller's own white LEDs at a colour temperature. The colour is
 * all zero, as in the `colorwc` command tested on the H706A (MER-1652): a
 * nonzero `colorTemInKelvin` selects the white LEDs and leaves brightness as is.
 */
export function colorTemperatureMessage(kelvin: number): GoveeLanMessage {
  if (!Number.isInteger(kelvin) || kelvin < 2000 || kelvin > 9000) {
    throw new RangeError('Colour temperature must be a whole number of kelvin from 2000 through 9000');
  }
  return { msg: { cmd: 'colorwc', data: { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: kelvin } } };
}

export function powerMessage(on: boolean): GoveeLanMessage {
  return { msg: { cmd: 'turn', data: { value: on ? 1 : 0 } } };
}

export interface PowerConfirmOptions {
  /** How long to wait for devStatus to report the commanded power state. */
  confirmMs?: number;
  /** Resend `turn` this often while the controller still reports the old state. */
  resendMs?: number;
  /** Delay between devStatus readbacks after the first (150 ms) one. */
  pollMs?: number;
  /** Called once the controller reports the commanded state. */
  onConfirmed?: (on: boolean, elapsedMs: number, sends: number) => void;
}

export class GoveeLanClient {
  private readonly socket: Socket;

  constructor(
    private readonly address: string | (() => Promise<string>),
    socket?: Socket,
    private readonly power: PowerConfirmOptions = {},
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

  setColorTemperature(kelvin: number): Promise<void> {
    return this.send(colorTemperatureMessage(kelvin));
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
    // The controller can keep answering devStatus with its previous power state
    // for a while after `turn`, most of all straight after a fade has sent it a
    // stream of frames. Every sunrise off read back "on" three times within about
    // a second, yet the controller was found off minutes later (MER-1551). So
    // poll for the new state over a window, resending `turn` as we go, instead
    // of giving up after three back-to-back tries.
    const { confirmMs = 15000, resendMs = 3000, pollMs = 500 } = this.power;
    const started = Date.now();
    let nextSend = started;
    let sends = 0;
    let delay = 150;
    let lastError: unknown;
    for (;;) {
      if (Date.now() >= nextSend) {
        nextSend = Date.now() + resendMs;
        try {
          await this.send(powerMessage(on));
          sends += 1;
        } catch (error) {
          lastError = error;
        }
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = pollMs;
      try {
        if (await this.readPower() === on) {
          this.power.onConfirmed?.(on, Date.now() - started, sends);
          return;
        }
        lastError = new Error('Controller still reports the previous power state');
      } catch (error) {
        lastError = error;
      }
      if (Date.now() - started >= confirmMs) {
        break;
      }
    }
    throw new Error(`Govee power ${on ? 'on' : 'off'} not confirmed within ${confirmMs} ms (${sends} sends): ${String(lastError)}`);
  }

  close(): void {
    this.socket.close();
  }
}
