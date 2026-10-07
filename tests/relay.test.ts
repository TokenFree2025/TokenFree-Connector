import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { createRelay } from "../src/relay/server.js";
import { Connection } from "../src/core/connection.js";
import { ConnectorCore } from "../src/core/core.js";
import { EventEmitter } from "node:events";
const session = {
  sessionId: randomUUID(),
  projectId: "a".repeat(24),
  title: "Fixture",
  cwd: "/fixture",
  host: "local" as const,
};
function inbox(ws: WebSocket) {
  const q: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    const w = waiters.shift();
    if (w) w(m);
    else q.push(m);
  });
  return async () =>
    q.length
      ? q.shift()
      : await new Promise<any>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("message timeout")),
            3000,
          );
          waiters.push((m) => {
            clearTimeout(timer);
            resolve(m);
          });
        });
}
test("HTTP + WS: pairing, owner isolation, scope validation, relay routing, revoke", async () => {
  const relay = createRelay({ port: 0, webRoot: resolve("web") });
  const origin = await relay.listen();
  const sockets: WebSocket[] = [];
  try {
    const post = async (
      route: string,
      data: any,
      headers: Record<string, string> = {},
    ) => {
      const r = await fetch(origin + route, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(data),
      });
      return { r, v: (await r.json()) as any };
    };
    const alice = await post("/api/login", { account: "alice" });
    const aliceCookie = alice.r.headers.get("set-cookie")!.split(";")[0]!;
    const bob = await post("/api/login", { account: "bob" });
    const bobCookie = bob.r.headers.get("set-cookie")!.split(";")[0]!;
    const deviceId = randomUUID();
    const p = (await post("/api/pair/start", { deviceId, name: "test" })).v;
    await post(
      "/api/pair/claim",
      { id: p.id, code: p.code },
      { Cookie: aliceCookie },
    );
    const c = (await post("/api/pair/confirm", { id: p.id, secret: p.secret }))
      .v;
    const owned = await fetch(origin + "/api/devices", {
      headers: { Cookie: bobCookie },
    });
    assert.deepEqual(((await owned.json()) as any).devices, []);
    assert.equal(
      (await post("/api/revoke", { deviceId }, { Cookie: bobCookie })).v.error
        .code,
      "FORBIDDEN",
    );
    const wrongOrigin = await fetch(origin + "/api/login", {
      method: "POST",
      headers: {
        Origin: "https://evil.test",
        "Content-Type": "application/json",
      },
      body: '{"account":"alice"}',
    });
    assert.equal(((await wrongOrigin.json()) as any).error.code, "FORBIDDEN");
    const device = new WebSocket(
      origin.replace("http:", "ws:") + "/connector",
      { headers: { Authorization: `Bearer ${c.token}` } },
    );
    sockets.push(device);
    const fromBrowser = inbox(device);
    await once(device, "open");
    device.send(
      JSON.stringify({
        v: 1,
        type: "status",
        status: { ipcConnected: true },
        scopes: [session],
      }),
    );
    const browser = new WebSocket(
      origin.replace("http:", "ws:") + `/browser?deviceId=${deviceId}`,
      { headers: { Cookie: aliceCookie, Origin: origin } },
    );
    sockets.push(browser);
    const recv = inbox(browser);
    await once(browser, "open");
    assert.equal((await recv()).type, "device");
    const op = {
      v: 1,
      requestId: randomUUID(),
      deviceId,
      sessionId: session.sessionId,
      projectId: session.projectId,
      method: "send",
      operationId: randomUUID(),
      text: "hello",
    };
    browser.send(JSON.stringify({ ...op, projectId: "b".repeat(24) }));
    assert.equal((await recv()).error.code, "FORBIDDEN");
    browser.send(JSON.stringify(op));
    const routed = await fromBrowser();
    assert.equal(routed.operation.sessionId, session.sessionId);
    device.send(
      JSON.stringify({
        v: 1,
        type: "result",
        routeId: routed.routeId,
        result: { status: "accepted" },
      }),
    );
    assert.equal((await recv()).result.status, "accepted");
    device.send(
      JSON.stringify({
        v: 1,
        type: "event",
        streamId: randomUUID(),
        sequence: 1,
        sessionId: session.sessionId,
        snapshot: { id: session.sessionId, status: "active" },
      }),
    );
    assert.equal((await recv()).snapshot.status, "active");
    // A pending mutation becomes uncertain when the connector disappears.
    browser.send(
      JSON.stringify({
        ...op,
        requestId: randomUUID(),
        operationId: randomUUID(),
      }),
    );
    await fromBrowser();
    device.close();
    let uncertain = await recv();
    if (uncertain.type === "device") uncertain = await recv();
    assert.equal(uncertain.error.code, "OPERATION_UNCERTAIN");
    const closed = once(browser, "close");
    await post("/api/revoke", { deviceId }, { Cookie: aliceCookie });
    assert.equal((await closed)[0], 4001);
    assert.throws(() => relay.state.auth(c.token));
  } finally {
    for (const s of sockets) s.terminate();
    await relay.close();
  }
});
test("connector actively dials relay and distinguishes revoked credentials", async () => {
  class Fixture extends EventEmitter {
    async call(m: string) {
      return m === "catalog" ? [session] : {};
    }
    close() {}
  }
  const relay = createRelay({ port: 0, webRoot: resolve("web") });
  const origin = await relay.listen();
  const deviceId = randomUUID();
  const p = relay.state.start(deviceId, "test");
  relay.state.claim(p.id, p.code, "alice");
  const c = relay.state.confirm(p.id, p.secret);
  const core = new ConnectorCore(new Fixture(), {
    getLedger: () => ({}),
    saveLedger: () => {},
  });
  await core.setScopes([session]);
  const connection = new Connection(core);
  try {
    connection.start({ url: origin, dev: true, deviceId, token: c.token });
    while (connection.state !== "online") await once(connection, "state");
    assert.equal(connection.state, "online");
    connection.stop();
    relay.state.revoke(relay.state.auth(c.token));
    connection.start({ url: origin, dev: true, deviceId, token: c.token });
    while (String(connection.state) !== "credentials-invalid")
      await once(connection, "state");
    assert.equal(connection.state, "credentials-invalid");
  } finally {
    connection.stop();
    await relay.close();
  }
});

test("WSS with trusted certificate succeeds; unknown certificate rejected", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "tf-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(join(dir, "cert.pem"));
  const relay = createRelay({
    port: 0,
    webRoot: resolve("web"),
    tls: { cert, key: readFileSync(join(dir, "key.pem")) },
  });
  const origin = await relay.listen();
  const id = randomUUID(),
    p = relay.state.start(id, "TLS fixture");
  relay.state.claim(p.id, p.code, "alice");
  const c = relay.state.confirm(p.id, p.secret);
  try {
    const ws = new WebSocket(origin.replace("https:", "wss:") + "/connector", {
      ca: cert,
      headers: { Authorization: `Bearer ${c.token}` },
    });
    await once(ws, "open");
    assert.equal(ws.readyState, 1);
    ws.close();
    await once(ws, "close");
    const untrusted = new WebSocket(
      origin.replace("https:", "wss:") + "/connector",
      { headers: { Authorization: `Bearer ${c.token}` } },
    );
    const [err] = await once(untrusted, "error");
    assert.match(err.code, /SELF_SIGNED|CERT/);
    untrusted.terminate();
  } finally {
    await relay.close();
    rmSync(dir, { recursive: true });
  }
});
