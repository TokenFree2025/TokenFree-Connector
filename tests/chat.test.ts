import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { ChatConnection } from "../src/core/chat.js";
import { ConnectorCore } from "../src/core/core.js";

const session = {
  sessionId: randomUUID(),
  projectId: "a".repeat(24),
  title: "test",
  cwd: "/test",
  host: "local" as const,
};
class Adapter extends EventEmitter {
  writes = 0;
  async call(method: string) {
    if (method === "catalog") return [session];
    if (method === "send") this.writes++;
    return { status: "accepted" };
  }
  close() {}
}
test("Chat transport authenticates, relays original sessions and does not repeat duplicated writes", async () => {
  const deviceId = randomUUID();
  const operation = {
    v: 1,
    method: "send",
    requestId: randomUUID(),
    operationId: randomUUID(),
    deviceId,
    sessionId: session.sessionId,
    projectId: session.projectId,
    text: "test",
  };
  const adapter = new Adapter();
  const core = new ConnectorCore(adapter, {
    getLedger: () => ({}),
    saveLedger: () => {},
  });
  await core.grantDesktopAccess();
  let calls = 0;
  let complete!: () => void;
  const finished = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const server = http.createServer(async (req, res) => {
    if (req.url === "/api/desktop/device/offline") {
      res.end("{}");
      return;
    }
    assert.equal(req.url, "/api/desktop/device/exchange");
    assert.equal(req.headers.authorization, "Bearer test-token");
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    assert.deepEqual(body.scopes, [session]);
    res.setHeader("Content-Type", "application/json");
    calls++;
    if (calls <= 2)
      res.end(
        JSON.stringify({ operations: [{ routeId: randomUUID(), operation }] }),
      );
    else {
      res.writeHead(401);
      res.end("{}");
      complete();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connection = new ChatConnection(core);
  try {
    connection.start({
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      dev: true,
      token: "test-token",
      deviceId,
    });
    await finished;
    await new Promise<void>((resolve) => {
      if (connection.state === "credentials-invalid") resolve();
      else
        connection.on("state", (state) => {
          if (state === "credentials-invalid") resolve();
        });
    });
    assert.equal(adapter.writes, 1);
    await assert.rejects(core.execute(operation), /离线/);
  } finally {
    connection.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
