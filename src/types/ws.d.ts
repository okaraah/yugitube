declare module "ws" {
  import { EventEmitter } from "node:events";

  type WebSocketOptions = {
    headers?: Record<string, string>;
    rejectUnauthorized?: boolean;
  };

  class WebSocket extends EventEmitter {
    constructor(url: string, options?: WebSocketOptions);
    send(data: string): void;
    close(): void;
    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  }

  export default WebSocket;
}
