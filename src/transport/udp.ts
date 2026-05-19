import dgram from "node:dgram";

export interface UdpSendOptions {
  host: string;
  port: number;
  payload: Buffer;
  timeoutMs: number;
}

export class UdpClient {
  private readonly socket: dgram.Socket;
  private readonly timeoutMs: number;

  constructor(options: { localAddress?: string; timeoutMs?: number; broadcast?: boolean }) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    if (options.broadcast) {
      // setBroadcast must be called after the socket is bound.
      // For broadcast sockets we trigger an explicit bind and set the flag
      // inside the 'listening' event so it's always called after the OS
      // assigns the port (calling it on an unbound socket causes EBADF on Windows).
      this.socket.once("listening", () => this.socket.setBroadcast(true));
      this.socket.bind(0, options.localAddress ?? undefined);
    } else if (options.localAddress) {
      // Non-broadcast with a specific local address: bind to pin the source interface.
      this.socket.bind(0, options.localAddress);
    }
    // Otherwise: no explicit bind — Node.js auto-binds on first send(), which is
    // fine for unicast sockets and avoids the BINDING-state race with early sends.
  }

  onMessage(handler: (msg: Buffer, rinfo: dgram.RemoteInfo) => void): () => void {
    this.socket.on("message", handler);
    return () => this.socket.off("message", handler);
  }

  close(): void {
    this.socket.close();
  }

  send(payload: Buffer, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(payload, port, host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  waitFor(
    predicate: (msg: Buffer, rinfo: dgram.RemoteInfo) => boolean,
    timeoutMs = this.timeoutMs,
  ): Promise<{ payload: Buffer; rinfo: dgram.RemoteInfo }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off("message", onMessage);
        reject(new Error(`UDP receive timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const onMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        if (!predicate(msg, rinfo)) return;
        clearTimeout(timer);
        this.socket.off("message", onMessage);
        resolve({ payload: msg, rinfo });
      };

      this.socket.on("message", onMessage);
    });
  }

  async request(
    payload: Buffer,
    host: string,
    port: number,
    predicate: (msg: Buffer, rinfo: dgram.RemoteInfo) => boolean,
    timeoutMs?: number,
  ): Promise<Buffer> {
    // Set up the listener BEFORE sending — fast ACKs (e.g. 70 03 clock sync replying
    // within <1 ms) would be missed if we awaited send() first and only then attached
    // the message handler.
    const waitPromise = this.waitFor(predicate, timeoutMs ?? this.timeoutMs);
    await this.send(payload, host, port);
    const { payload: response } = await waitPromise;
    return response;
  }
}
