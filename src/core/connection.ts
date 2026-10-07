import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  Fault,
  MAX_BYTES,
  Operation,
  relayURL,
  safeError,
  sendBounded,
  type Session,
} from "../protocol/index.js";
import { ConnectorCore } from "./core.js";
export class Connection extends EventEmitter {
  state = "stopped";
  private ws?: WebSocket;
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private attempts = 0;
  private stopped = true;
  private config?: {
    url: string;
    token: string;
    deviceId: string;
    dev: boolean;
  };
  private latestStatus: any = {};
  constructor(readonly core: ConnectorCore) {
    super();
    core.on("event", (e) => {
      if (e.type === "session") {
        this.send({
          v: 1,
          type: "event",
          sequence: e.sequence,
          streamId: e.streamId,
          sessionId: e.sessionId,
          snapshot: e.snapshot,
        });
      }
    });
    core.on("scope", () => this.status(this.latestStatus));
  }
  private change(s: string) {
    this.state = s;
    this.emit("state", s);
  }
  start(config: {
    url: string;
    token: string;
    deviceId: string;
    dev: boolean;
  }) {
    this.stop();
    this.config = config;
    relayURL(config.url, config.dev);
    this.stopped = false;
    this.core.setActive(true);
    this.attempts = 0;
    this.connect();
  }
  private connect() {
    if (this.stopped || !this.config) return;
    this.change("connecting");
    const c = this.config;
    const url = new URL("/connector", relayURL(c.url, c.dev));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${c.token}` },
      maxPayload: MAX_BYTES,
      handshakeTimeout: 10000,
      perMessageDeflate: false,
    });
    this.ws = ws;
    let lastPong = Date.now();
    ws.on("open", () => {
      this.attempts = 0;
      this.change("online");
      this.status(this.latestStatus);
      this.heartbeat = setInterval(() => {
        if (Date.now() - lastPong > 45000) {
          ws.terminate();
          return;
        }
        ws.ping();
      }, 15000);
    });
    ws.on("pong", () => {
      lastPong = Date.now();
    });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      ws.terminate();
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.stopped = true;
        this.core.setActive(false);
        this.change("credentials-invalid");
      }
    });
    ws.on("error", () => {});
    ws.on("message", async (raw) => {
      let routeId: string | undefined;
      try {
        const m = z
          .object({
            v: z.literal(1),
            type: z.literal("request"),
            routeId: z.string().uuid(),
            operation: Operation,
          })
          .strict()
          .parse(JSON.parse(raw.toString()));
        routeId = m.routeId;
        if (m.operation.deviceId !== c.deviceId) throw new Fault("FORBIDDEN");
        const result = await this.core.execute(m.operation);
        // Replies are never sent on a replacement socket. Relay reports uncertainty on disconnect.
        if (ws === this.ws && ws.readyState === 1)
          sendBounded(ws, { v: 1, type: "result", routeId, result });
      } catch (e) {
        if (routeId && ws === this.ws)
          this.send({ v: 1, type: "result", routeId, error: safeError(e) });
      }
    });
    ws.on("close", (code) => {
      if (ws !== this.ws) return;
      clearInterval(this.heartbeat);
      if (code === 4001 || code === 4002) {
        this.stopped = true;
        this.core.setActive(false);
        this.change(code === 4001 ? "credentials-invalid" : "replaced");
        return;
      }
      if (this.stopped) return;
      this.change("reconnecting");
      const delay =
        Math.min(30000, 500 * 2 ** Math.min(this.attempts++, 6)) *
        (0.5 + Math.random());
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }
  private send(data: unknown) {
    if (this.ws?.readyState === 1) {
      try {
        sendBounded(this.ws, data);
      } catch {
        this.ws.close(1013, "BACKPRESSURE");
      }
    }
  }
  status(status: unknown) {
    this.latestStatus = status;
    this.send({
      v: 1,
      type: "status",
      status,
      scopes: this.core.scopes as Session[],
    });
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000, "STOPPED");
    this.core.setActive(false);
    this.change("stopped");
  }
}
