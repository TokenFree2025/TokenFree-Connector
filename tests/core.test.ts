import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { ConnectorCore, type LedgerEntry } from "../src/core/core.js";
import {
  Fault,
  parseOperation,
  relayURL,
  safeError,
  sendBounded,
  MAX_BYTES,
} from "../src/protocol/index.js";
import { RelayState } from "../src/relay/state.js";
const session = {
  sessionId: randomUUID(),
  projectId: "a".repeat(24),
  title: "Test",
  cwd: "/test",
  host: "local" as const,
};
const deviceId = randomUUID();
class Fake extends EventEmitter {
  calls: any[] = [];
  catalog = [session];
  subscriptions: string[] = [];
  failure?: Fault;
  wait?: () => Promise<void>;
  async call(method: string, p: any = {}) {
    if (method === "catalog") return this.catalog;
    if (method === "scope") {
      this.subscriptions = p.sessionIds;
      return {};
    }
    this.calls.push({ method, p });
    await this.wait?.();
    if (this.failure) throw this.failure;
    return { status: "accepted", id: p.sessionId };
  }
  close() {}
}
const op = (method = "send", extra = {}) => ({
  v: 1,
  deviceId,
  requestId: randomUUID(),
  operationId: randomUUID(),
  sessionId: session.sessionId,
  projectId: session.projectId,
  method,
  text: "hello",
  ...extra,
});
async function setup() {
  const adapter = new Fake();
  let ledger: Record<string, LedgerEntry> = {};
  const store = {
    getLedger: () => structuredClone(ledger),
    saveLedger: (v: Record<string, LedgerEntry>) => {
      ledger = structuredClone(v);
    },
  };
  const core = new ConnectorCore(adapter, store);
  await core.setScopes([session]);
  return { adapter, core, store };
}
test("pair: success, one use, secret separation and credential revoke", () => {
  const s = new RelayState();
  const p = s.start(deviceId, "test");
  assert.throws(() => s.poll(p.id, "bad"));
  s.claim(p.id, p.code, "alice");
  assert.equal(s.poll(p.id, p.secret).account, "alice");
  const d = s.confirm(p.id, p.secret);
  assert.equal(s.auth(d.token).account, "alice");
  assert.throws(() => s.confirm(p.id, p.secret), /已使用/);
  assert.throws(() => s.owned(deviceId, "bob"));
  s.revoke(s.auth(d.token));
  assert.throws(() => s.auth(d.token));
});
test("pair expiry and attempt limit", () => {
  let now = 1;
  const s = new RelayState(() => now);
  const p = s.start(deviceId, "test");
  now += 300001;
  assert.throws(() => s.claim(p.id, p.code, "alice"), /过期/);
  const q = s.start(deviceId, "test");
  for (let i = 0; i < 5; i++)
    assert.throws(() =>
      s.claim(q.id, q.code === "00000000" ? "11111111" : "00000000", "bob"),
    );
  assert.throws(() => s.claim(q.id, q.code, "bob"), /次数/);
});
test("default deny, cross-project and session scopes", async () => {
  const { core } = await setup();
  await assert.rejects(
    core.execute(op("send", { projectId: "b".repeat(24) })),
    /授权/,
  );
  await assert.rejects(
    core.execute(op("send", { sessionId: randomUUID() })),
    /授权/,
  );
  await core.setScopes([]);
  await assert.rejects(core.execute(op()), /授权/);
});
test("duplicates survive restart; conflicting payload fails", async () => {
  const { core, adapter, store } = await setup();
  const request = op();
  await core.execute(request);
  const result = await core.execute({ ...request, requestId: randomUUID() });
  assert.equal(result.duplicate, true);
  assert.equal(adapter.calls.length, 1);
  const restarted = new ConnectorCore(adapter, store);
  await restarted.setScopes([session]);
  await restarted.execute(request);
  assert.equal(adapter.calls.length, 1);
  await assert.rejects(
    core.execute({ ...request, text: "different" }),
    /其他内容/,
  );
});
test("uncertain IPC write never automatically repeats", async () => {
  const { core, adapter } = await setup();
  adapter.failure = new Fault("OPERATION_UNCERTAIN");
  const request = op();
  assert.equal((await core.execute(request)).status, "uncertain");
  assert.equal((await core.execute(request)).status, "uncertain");
  assert.equal(adapter.calls.length, 1);
});
test("same-session concurrent sends reject; no queue", async () => {
  const { core, adapter } = await setup();
  let release!: () => void;
  adapter.wait = () =>
    new Promise((r) => {
      release = r;
    });
  const first = core.execute(op());
  await assert.rejects(core.execute(op()), /任务/);
  release();
  await first;
});
test("revoked scope during read cannot leak response", async () => {
  const { core, adapter } = await setup();
  let release!: () => void;
  adapter.wait = () =>
    new Promise((r) => {
      release = r;
    });
  const read = core.execute({
    v: 1,
    deviceId,
    requestId: randomUUID(),
    method: "read",
    sessionId: session.sessionId,
    projectId: session.projectId,
  });
  await core.setScopes([]);
  release();
  await assert.rejects(read, /授权/);
});
test("events are bounded, cursor gap requests resnapshot and unscoped events dropped", async () => {
  const { core, adapter } = await setup();
  for (let i = 0; i < 110; i++)
    adapter.emit("event", {
      type: "session",
      sessionId: session.sessionId,
      snapshot: { i },
    });
  assert.equal(core.replay(0).resetRequired, true);
  assert.equal(core.replay(109).events.length, 1);
  adapter.emit("event", {
    type: "session",
    sessionId: randomUUID(),
    snapshot: { secret: true },
  });
  assert.equal(core.replay(109).events.length, 1);
  await core.setScopes([]);
  assert.equal(core.replay(0).events.length, 0);
});
test("strict protocol denies arbitrary RPC and unsafe relay schemes", () => {
  assert.throws(() => parseOperation({ ...op(), shell: "rm" }));
  assert.throws(() => parseOperation({ ...op(), v: 2 }));
  assert.throws(() => relayURL("http://example.com", true));
  assert.throws(() => relayURL("http://127.0.0.1:4318", false));
  assert.equal(relayURL("https://example.com", false), "https://example.com");
  assert.throws(() => relayURL("https://token@example.com", false));
});
test("limits and errors redact raw exceptions", () => {
  assert.equal(
    safeError(new Error("token=secret chat=private")).code,
    "INTERNAL",
  );
  assert.ok(!JSON.stringify(safeError(new Error("secret"))).includes("secret"));
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: () => {},
    close: () => {},
  };
  assert.throws(() => sendBounded(ws, "x".repeat(MAX_BYTES)), /大小/);
  ws.bufferedAmount = MAX_BYTES * 3;
  assert.throws(() => sendBounded(ws, {}), /过多/);
});

test("sync returns scoped replay, fresh snapshot and epoch reset", async () => {
  const { core, adapter } = await setup();
  adapter.emit("event", {
    type: "session",
    sessionId: session.sessionId,
    snapshot: { id: session.sessionId },
  });
  const request = {
    v: 1,
    deviceId,
    requestId: randomUUID(),
    sessionId: session.sessionId,
    projectId: session.projectId,
    method: "sync",
    cursor: 0,
    streamId: core.streamId,
  };
  const result = await core.execute(request);
  assert.equal(result.resetRequired, false);
  assert.equal(result.events.length, 1);
  assert.equal(result.snapshot.id, session.sessionId);
  const stale = await core.execute({ ...request, streamId: randomUUID() });
  assert.equal(stale.resetRequired, true);
  assert.deepEqual(stale.events, []);
});

test("desktop grant includes existing and future sessions without eagerly following them", async () => {
  const { core, adapter } = await setup();
  await core.setScopes([]);
  adapter.catalog = Array.from({ length: 40 }, () => ({
    ...session,
    sessionId: randomUUID(),
  }));
  await core.refreshDesktopCatalog();
  assert.equal(core.scopes.length, 0);
  await core.grantDesktopAccess();
  assert.equal(core.scopes.length, 40);
  assert.equal(core.watched.size, 0);
  assert.deepEqual(adapter.subscriptions, []);
  const first = adapter.catalog[0]!;
  await core.execute({
    v: 1,
    deviceId,
    requestId: randomUUID(),
    method: "read",
    sessionId: first.sessionId,
    projectId: first.projectId,
  });
  assert.deepEqual([...core.watched], [first.sessionId]);
  adapter.emit("event", { type: "session", sessionId: first.sessionId });
  await core.refreshDesktopCatalog();
  assert.equal(core.replay(0).events.length, 1);
  adapter.catalog.push(session);
  await core.refreshDesktopCatalog();
  assert.equal(core.scopes.length, 41);
  assert.deepEqual(adapter.subscriptions, [first.sessionId]);
  adapter.catalog = [session];
  await core.refreshDesktopCatalog();
  assert.equal(core.watched.size, 0);
  await assert.rejects(
    core.execute({
      v: 1,
      deviceId,
      requestId: randomUUID(),
      method: "read",
      sessionId: first.sessionId,
      projectId: first.projectId,
    }),
    /授权/,
  );
  await core.revokeDesktopAccess();
  await core.refreshDesktopCatalog();
  assert.equal(core.scopes.length, 0);
  await assert.rejects(core.execute(op()), /授权/);
});
