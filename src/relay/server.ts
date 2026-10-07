import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  Fault,
  MAX_BYTES,
  parseOperation,
  safeError,
  sendBounded,
  type Session,
} from "../protocol/index.js";
import { RelayState, type Device } from "./state.js";
const statusSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("status"),
    status: z.record(z.unknown()),
    scopes: z
      .array(
        z.object({
          sessionId: z.string().uuid(),
          projectId: z.string().regex(/^[a-f0-9]{24}$/),
          title: z.string().max(3000),
          cwd: z.string().max(8000),
          host: z.literal("local"),
        }),
      )
      .max(5000),
  })
  .strict();
const connectorMessage = z.discriminatedUnion("type", [
  statusSchema,
  z
    .object({
      v: z.literal(1),
      type: z.literal("result"),
      routeId: z.string().uuid(),
      result: z.unknown().optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal("event"),
      streamId: z.string().uuid(),
      sequence: z.number().int().nonnegative(),
      sessionId: z.string().uuid(),
      snapshot: z.record(z.unknown()),
    })
    .strict(),
]);
export function createRelay(options: {
  port: number;
  webRoot: string;
  tls?: { cert: Buffer; key: Buffer };
}) {
  const state = new RelayState();
  const logins = new Map<string, { account: string; expires: number }>();
  const devices = new Map<string, WebSocket>();
  const browsers = new Map<WebSocket, Device>();
  const pending = new Map<
    string,
    {
      browser: WebSocket;
      deviceId: string;
      requestId: string;
      timer: NodeJS.Timeout;
      mutation: boolean;
    }
  >();
  let origin = "";
  const send = (ws: WebSocket, data: unknown) => {
    try {
      sendBounded(ws, data);
    } catch {
      ws.close(1013, "BACKPRESSURE");
    }
  };
  const account = (req: http.IncomingMessage) => {
    const token = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("tfdev="))
      ?.slice(6);
    const login = logins.get(token ?? "");
    if (!login || login.expires < Date.now()) throw new Fault("UNAUTHORIZED");
    return login.account;
  };
  const credential = (req: http.IncomingMessage) =>
    state.auth((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  function broadcast(d: Device, message: unknown) {
    for (const [ws, dev] of browsers) if (dev.id === d.id) send(ws, message);
  }
  function revoke(d: Device) {
    state.revoke(d);
    devices.get(d.id)?.close(4001, "UNAUTHORIZED");
    devices.delete(d.id);
    for (const [ws, dev] of browsers)
      if (dev.id === d.id) {
        ws.close(4001, "UNAUTHORIZED");
        browsers.delete(ws);
      }
  }
  async function body(req: http.IncomingMessage) {
    let n = 0;
    const parts: Buffer[] = [];
    for await (const b of req) {
      n += b.length;
      if (n > 16384) throw new Fault("MESSAGE_TOO_LARGE");
      parts.push(b);
    }
    try {
      return JSON.parse(Buffer.concat(parts).toString());
    } catch {
      throw new Fault("INVALID_REQUEST");
    }
  }
  const handler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (data: unknown, code = 200) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.headers.host !== new URL(origin).host)
        throw new Fault("FORBIDDEN");
      if (req.headers.origin && req.headers.origin !== origin)
        throw new Fault("FORBIDDEN");
      const url = new URL(req.url ?? "/", origin);
      const route = url.pathname;
      if (
        req.method === "GET" &&
        ["/", "/app.js", "/style.css"].includes(route)
      ) {
        const file = route === "/" ? "index.html" : route.slice(1);
        res.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "text/html",
        );
        res.end(readFileSync(path.join(options.webRoot, file)));
        return;
      }
      if (req.method === "POST") {
        const b = await body(req);
        if (route === "/api/pair/start") {
          const p = z
            .object({
              deviceId: z.string().uuid(),
              name: z.string().min(1).max(100),
            })
            .strict()
            .parse(b);
          json(state.start(p.deviceId, p.name));
          return;
        }
        if (route === "/api/pair/poll" || route === "/api/pair/confirm") {
          const p = z
            .object({
              id: z.string().uuid(),
              secret: z.string().min(32).max(100),
            })
            .strict()
            .parse(b);
          json(
            route.endsWith("poll")
              ? state.poll(p.id, p.secret)
              : state.confirm(p.id, p.secret),
          );
          return;
        }
        if (route === "/api/device/revoke") {
          revoke(credential(req));
          json({ ok: true });
          return;
        }
        // Browser state changes require exact Origin; cookies never authorize connector routes.
        if (req.headers.origin !== origin) throw new Fault("FORBIDDEN");
        if (route === "/api/login") {
          const p = z
            .object({ account: z.enum(["alice", "bob"]) })
            .strict()
            .parse(b);
          for (const [k, v] of logins)
            if (v.expires < Date.now()) logins.delete(k);
          if (logins.size >= 200) throw new Fault("BACKPRESSURE");
          const token = randomBytes(32).toString("base64url");
          logins.set(token, {
            account: p.account,
            expires: Date.now() + 3600000,
          });
          res.setHeader(
            "Set-Cookie",
            `tfdev=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${options.tls ? "; Secure" : ""}`,
          );
          json({ account: p.account });
          return;
        }
        const user = account(req);
        if (route === "/api/pair/claim") {
          const p = z
            .object({
              id: z.string().uuid(),
              code: z.string().regex(/^\d{8}$/),
            })
            .strict()
            .parse(b);
          json(state.claim(p.id, p.code, user));
          return;
        }
        if (route === "/api/revoke") {
          const p = z.object({ deviceId: z.string().uuid() }).strict().parse(b);
          revoke(state.owned(p.deviceId, user));
          json({ ok: true });
          return;
        }
      }
      if (req.method === "GET" && route === "/api/devices") {
        const user = account(req);
        json({
          account: user,
          devices: [...state.devices.values()]
            .filter((d) => d.account === user && !d.revoked)
            .map((d) => ({
              deviceId: d.id,
              name: d.name,
              online: devices.has(d.id),
              status: d.status,
              scopes: d.scopes,
            })),
        });
        return;
      }
      json({ error: safeError(new Fault("INVALID_REQUEST")) }, 404);
    } catch (e) {
      json(
        {
          error: safeError(
            e instanceof z.ZodError ? new Fault("INVALID_REQUEST") : e,
          ),
        },
        e instanceof Fault && e.code === "UNAUTHORIZED" ? 401 : 400,
      );
    }
  };
  const server = options.tls
    ? https.createServer(options.tls, handler)
    : http.createServer(handler);
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BYTES,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      if (req.headers.host !== new URL(origin).host)
        throw new Fault("FORBIDDEN");
      const url = new URL(req.url ?? "/", origin);
      let d: Device,
        isDevice = false;
      if (url.pathname === "/connector") {
        if (req.headers.origin) throw new Fault("FORBIDDEN");
        d = credential(req);
        isDevice = true;
      } else if (url.pathname === "/browser") {
        if (req.headers.origin !== origin) throw new Fault("FORBIDDEN");
        d = state.owned(url.searchParams.get("deviceId") ?? "", account(req));
      } else throw new Fault("FORBIDDEN");
      wss.handleUpgrade(req, socket, head, (ws) => {
        let alive = true;
        let requestCount = 0;
        ws.on("pong", () => {
          alive = true;
        });
        const heartbeat = setInterval(() => {
          if (!alive) {
            ws.terminate();
            return;
          }
          alive = false;
          ws.ping();
          requestCount = 0;
        }, 15000);
        ws.on("error", () => {});
        if (isDevice) {
          devices.get(d.id)?.close(4002, "REPLACED");
          devices.set(d.id, ws);
          broadcast(d, {
            v: 1,
            type: "device",
            online: true,
            status: d.status,
            scopes: d.scopes,
          });
        } else {
          browsers.set(ws, d);
          send(ws, {
            v: 1,
            type: "device",
            online: devices.has(d.id),
            status: d.status,
            scopes: d.scopes,
          });
        }
        ws.on("message", (raw) => {
          let requestId: string | undefined;
          try {
            if (++requestCount > (isDevice ? 3000 : 180))
              throw new Fault("BACKPRESSURE");
            if (d.revoked) throw new Fault("UNAUTHORIZED");
            const message = JSON.parse(raw.toString());
            if (
              !isDevice &&
              typeof message.requestId === "string" &&
              z.string().uuid().safeParse(message.requestId).success
            )
              requestId = message.requestId;
            if (isDevice) {
              if (devices.get(d.id) !== ws) throw new Fault("UNAUTHORIZED");
              const m = connectorMessage.parse(message);
              if (m.type === "status") {
                d.status = m.status;
                d.scopes = m.scopes as Session[];
                broadcast(d, {
                  v: 1,
                  type: "device",
                  online: true,
                  status: d.status,
                  scopes: d.scopes,
                });
              }
              if (
                m.type === "event" &&
                d.scopes.some((s) => s.sessionId === m.sessionId)
              )
                broadcast(d, m);
              if (m.type === "result") {
                const p = pending.get(m.routeId);
                if (!p || p.deviceId !== d.id) return;
                clearTimeout(p.timer);
                pending.delete(m.routeId);
                send(p.browser, {
                  v: 1,
                  type: "result",
                  requestId: p.requestId,
                  result: m.result,
                  error: m.error,
                });
              }
            } else {
              const op = parseOperation(message);
              if (op.deviceId !== d.id) throw new Fault("FORBIDDEN");
              if (
                "sessionId" in op &&
                !d.scopes.some(
                  (s) =>
                    s.sessionId === op.sessionId &&
                    s.projectId === op.projectId,
                )
              )
                throw new Fault("FORBIDDEN");
              const device = devices.get(d.id);
              if (!device) throw new Fault("OFFLINE");
              if (
                [...pending.values()].filter((p) => p.deviceId === d.id)
                  .length >= 32
              )
                throw new Fault("BACKPRESSURE");
              const routeId = randomUUID();
              const mutation = !["read", "list", "sync"].includes(op.method);
              const timer = setTimeout(() => {
                pending.delete(routeId);
                send(ws, {
                  v: 1,
                  type: "result",
                  requestId: op.requestId,
                  error: safeError(
                    new Fault(mutation ? "OPERATION_UNCERTAIN" : "OFFLINE"),
                  ),
                });
              }, 45000);
              pending.set(routeId, {
                browser: ws,
                deviceId: d.id,
                requestId: op.requestId,
                timer,
                mutation,
              });
              send(device, { v: 1, type: "request", routeId, operation: op });
            }
          } catch (e) {
            send(ws, {
              v: 1,
              type: requestId ? "result" : "error",
              ...(requestId ? { requestId } : {}),
              error: safeError(
                e instanceof z.ZodError || e instanceof SyntaxError
                  ? new Fault("INVALID_REQUEST")
                  : e,
              ),
            });
          }
        });
        ws.on("close", () => {
          clearInterval(heartbeat);
          browsers.delete(ws);
          if (isDevice && devices.get(d.id) === ws) {
            devices.delete(d.id);
            broadcast(d, {
              v: 1,
              type: "device",
              online: false,
              status: d.status,
              scopes: d.scopes,
            });
          }
          for (const [key, p] of pending)
            if (
              p.browser === ws ||
              (isDevice && p.deviceId === d.id && devices.get(d.id) !== ws)
            ) {
              clearTimeout(p.timer);
              pending.delete(key);
              if (p.browser !== ws)
                send(p.browser, {
                  v: 1,
                  type: "result",
                  requestId: p.requestId,
                  error: safeError(
                    new Fault(p.mutation ? "OPERATION_UNCERTAIN" : "OFFLINE"),
                  ),
                });
            }
        });
      });
    } catch {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  });
  return {
    state,
    server,
    async listen() {
      await new Promise<void>((resolve) =>
        server.listen(options.port, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;
      origin = `${options.tls ? "https" : "http"}://127.0.0.1:${port}`;
      return origin;
    },
    async close() {
      for (const p of pending.values()) clearTimeout(p.timer);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
