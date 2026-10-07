import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  Operation,
  relayURL,
  safeError,
  MAX_BYTES,
} from "../protocol/index.js";
import { ConnectorCore } from "./core.js";

/** Chat's authenticated HTTP relay; mutations cross the desktop boundary only once. */
export class ChatConnection extends EventEmitter {
  state = "stopped";
  private generation = 0;
  private timer?: NodeJS.Timeout;
  private abort?: AbortController;
  private disconnect?: () => void;
  private latestStatus: Record<string, unknown> = {};
  constructor(readonly core: ConnectorCore) {
    super();
  }
  private change(state: string) {
    this.state = state;
    this.emit("state", state);
  }
  status(value: Record<string, unknown>) {
    this.latestStatus = value;
  }
  start(config: {
    url: string;
    token: string;
    deviceId: string;
    dev: boolean;
  }) {
    this.stop();
    const origin = relayURL(config.url, config.dev);
    const generation = this.generation;
    const connectionId = randomUUID();
    this.disconnect = () => {
      void fetch(origin + "/api/desktop/device/offline", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({ connectionId }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    };
    const results: {
      routeId: string;
      result?: unknown;
      error?: ReturnType<typeof safeError>;
    }[] = [];
    this.core.setActive(true);
    this.change("connecting");
    let attempts = 0;
    const exchange = async () => {
      if (generation !== this.generation) return;
      this.abort = new AbortController();
      let delay = 1000;
      try {
        const count = Math.min(results.length, 1);
        const body = JSON.stringify({
          connectionId,
          status: this.latestStatus,
          scopes: this.core.scopes,
          results: results.slice(0, count),
        });
        if (Buffer.byteLength(body) > MAX_BYTES)
          throw new Error("MESSAGE_TOO_LARGE");
        const response = await fetch(origin + "/api/desktop/device/exchange", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.token}`,
          },
          body,
          signal: AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(10000),
          ]),
        });
        if (generation !== this.generation) return;
        if ([401, 403].includes(response.status)) {
          this.stop();
          this.change("credentials-invalid");
          return;
        }
        if (!response.ok) throw new Error("OFFLINE");
        const value = z
          .object({
            operations: z
              .array(
                z.object({ routeId: z.string().uuid(), operation: Operation }),
              )
              .max(32),
          })
          .parse(await response.json());
        if (generation !== this.generation) return;
        results.splice(0, count);
        attempts = 0;
        this.change("online");
        void Promise.all(
          value.operations.map(async ({ routeId, operation }) => {
            if (operation.deviceId !== config.deviceId) return;
            try {
              const result = await this.core.execute(operation);
              const reply = { routeId, result };
              if (Buffer.byteLength(JSON.stringify(reply)) > MAX_BYTES / 2)
                results.push({
                  routeId,
                  error: {
                    code: "MESSAGE_TOO_LARGE",
                    message: "消息超过大小限制，请在桌面查看完整内容。",
                  },
                });
              else results.push(reply);
            } catch (error) {
              results.push({ routeId, error: safeError(error) });
            }
          }),
        );
        if (results.length) delay = 0;
      } catch {
        if (generation !== this.generation) return;
        this.change("reconnecting");
        delay = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5));
      }
      if (generation === this.generation)
        this.timer = setTimeout(() => void exchange(), delay);
    };
    void exchange();
  }
  stop() {
    this.generation++;
    clearTimeout(this.timer);
    this.abort?.abort();
    this.disconnect?.();
    this.disconnect = undefined;
    this.core.setActive(false);
    this.change("stopped");
  }
}
