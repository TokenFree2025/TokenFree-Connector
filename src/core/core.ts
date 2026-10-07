import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import {
  Fault,
  parseOperation,
  safeError,
  type Operation,
  type Session,
} from "../protocol/index.js";
import type { DesktopAdapter } from "./adapter.js";
export type LedgerEntry = {
  hash: string;
  status: "uncertain" | "accepted" | "rejected";
  error?: ReturnType<typeof safeError>;
};
export interface Store {
  getLedger(): Record<string, LedgerEntry>;
  saveLedger(v: Record<string, LedgerEntry>): void;
}
export class ConnectorCore extends EventEmitter {
  scopes: Session[] = [];
  private busy = new Set<string>();
  readonly watched = new Set<string>();
  private desktopAccess = false;
  private ledger: Record<string, LedgerEntry>;
  private generation = 0;
  readonly streamId = randomUUID();
  private sequence = 0;
  private events: any[] = [];
  private eventBytes = 0;
  private active = true;
  constructor(
    readonly adapter: DesktopAdapter,
    readonly store: Store,
  ) {
    super();
    this.ledger = store.getLedger();
    adapter.on("event", (e) => {
      if (
        e.type === "session" &&
        (!this.active || !this.scopes.some((s) => s.sessionId === e.sessionId))
      )
        return;
      const event = {
        v: 1,
        type: "event",
        streamId: this.streamId,
        sequence: ++this.sequence,
        ...e,
      };
      const bytes = Buffer.byteLength(JSON.stringify(event));
      this.events.push(event);
      this.eventBytes += bytes;
      while (this.events.length > 100 || this.eventBytes > 4 * 1024 * 1024) {
        this.eventBytes -= Buffer.byteLength(
          JSON.stringify(this.events.shift()),
        );
      }
      this.emit("event", event);
    });
  }
  async setScopes(selected: Session[], expectedGeneration = this.generation) {
    if (selected.length > 5000) throw new Fault("INVALID_REQUEST");
    const catalog: Session[] = selected.length
      ? await this.adapter.call("catalog")
      : [];
    if (expectedGeneration !== this.generation) return;
    const exact = selected.map((s) => {
      const row = catalog.find(
        (r) => r.sessionId === s.sessionId && r.projectId === s.projectId,
      );
      if (!row) throw new Fault("FORBIDDEN");
      return row;
    });
    if (JSON.stringify(this.scopes) === JSON.stringify(exact)) return;
    this.scopes = exact;
    for (const sid of this.watched)
      if (!exact.some((s) => s.sessionId === sid)) this.watched.delete(sid);
    this.generation++;
    this.events = [];
    this.eventBytes = 0;
    await this.adapter.call("scope", {
      sessionIds: [...this.watched],
    });
    this.emit("scope");
  }
  async grantDesktopAccess() {
    // Explicit connection action grants this desktop, including future sessions.
    await this.refreshDesktopCatalog(true);
    this.desktopAccess = true;
  }
  async refreshDesktopCatalog(grant = false) {
    if (!grant && !this.desktopAccess) return;
    const generation = this.generation;
    const catalog: Session[] = await this.adapter.call("catalog");
    await this.setScopes(
      catalog.filter((s) => s.host === "local"),
      generation,
    );
  }
  async revokeDesktopAccess() {
    this.desktopAccess = false;
    this.watched.clear();
    await this.setScopes([]);
  }
  private watch(sessionId: string) {
    if (!this.watched.has(sessionId) && this.watched.size >= 32)
      throw new Fault("BACKPRESSURE");
    this.watched.add(sessionId);
  }
  setActive(value: boolean) {
    this.active = value;
    this.generation++;
  }
  replay(cursor: number) {
    const first = this.events[0]?.sequence ?? this.sequence + 1;
    return {
      resetRequired: cursor < first - 1 || cursor > this.sequence,
      cursor: this.sequence,
      events: this.events.filter((e) => e.sequence > cursor),
    };
  }
  private authorize(op: Operation) {
    if (!this.active) throw new Fault("OFFLINE");
    if (
      "sessionId" in op &&
      !this.scopes.some(
        (s) =>
          s.sessionId === op.sessionId &&
          s.projectId === op.projectId &&
          s.host === "local",
      )
    )
      throw new Fault("FORBIDDEN");
  }
  async execute(input: unknown) {
    const op = parseOperation(input);
    this.authorize(op);
    if (op.method === "list")
      return { sessions: this.scopes, cursor: this.sequence };
    this.watch(op.sessionId);
    const generation = this.generation;
    if (op.method === "read" || op.method === "sync") {
      const result = await this.adapter.call("read", {
        sessionId: op.sessionId,
      });
      this.authorize(op);
      if (generation !== this.generation) throw new Fault("FORBIDDEN");
      if (op.method === "sync") {
        const replay = this.replay(op.cursor);
        return {
          snapshot: result,
          streamId: this.streamId,
          cursor: replay.cursor,
          resetRequired: op.streamId !== this.streamId || replay.resetRequired,
          events:
            op.streamId === this.streamId
              ? replay.events.filter((e) => e.sessionId === op.sessionId)
              : [],
        };
      }
      return result;
    }
    const hash = createHash("sha256")
      .update(JSON.stringify({ ...op, requestId: undefined }))
      .digest("hex");
    const prior = this.ledger[op.operationId];
    if (prior) {
      if (prior.hash !== hash) throw new Fault("OPERATION_CONFLICT");
      return {
        operationId: op.operationId,
        status: prior.status,
        duplicate: true,
        ...(prior.error ? { error: prior.error } : {}),
      };
    }
    if (this.busy.has(op.sessionId)) throw new Fault("SESSION_BUSY");
    if (Object.keys(this.ledger).length >= 10000)
      throw new Fault("LEDGER_FULL");
    this.busy.add(op.sessionId);
    // Persist uncertainty BEFORE crossing IPC. A crash can never cause automatic resend.
    this.ledger[op.operationId] = { hash, status: "uncertain" };
    try {
      this.store.saveLedger(this.ledger);
      this.authorize(op);
      const result = await this.adapter.call(op.method, op);
      this.ledger[op.operationId] = { hash, status: "accepted" };
      this.store.saveLedger(this.ledger);
      return result;
    } catch (e) {
      const error = safeError(e);
      const definitelyRejected = [
        "SESSION_BUSY",
        "STALE_TURN",
        "STALE_APPROVAL",
        "INVALID_REQUEST",
        "FORBIDDEN",
        "OWNER_UNAVAILABLE",
        "IPC_INCOMPATIBLE",
        "IPC_UNAVAILABLE",
        "DESKTOP_ACTION_REQUIRED",
      ].includes(error.code);
      this.ledger[op.operationId] = {
        hash,
        status: definitelyRejected ? "rejected" : "uncertain",
        error: definitelyRejected
          ? error
          : safeError(new Fault("OPERATION_UNCERTAIN")),
      };
      this.store.saveLedger(this.ledger);
      return {
        operationId: op.operationId,
        ...this.ledger[op.operationId],
        hash: undefined,
      };
    } finally {
      this.busy.delete(op.sessionId);
    }
  }
  resetLedger() {
    this.ledger = {};
    this.store.saveLedger(this.ledger);
  }
}
