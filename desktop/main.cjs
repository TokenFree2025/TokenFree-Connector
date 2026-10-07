const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Tray,
  Menu,
  nativeImage,
  safeStorage,
  dialog,
} = require("electron");
const { join, resolve } = require("node:path");
const {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  chmodSync,
  openSync,
  fsyncSync,
  closeSync,
} = require("node:fs");
const { randomUUID } = require("node:crypto");
const { hostname } = require("node:os");
const { pathToFileURL } = require("node:url");
let win,
  tray,
  adapter,
  core,
  connection,
  timer,
  quitting = false,
  initialized = false,
  health = {},
  catalog = [],
  pairing = null;
let settings,
  credential = null;
const root = resolve(__dirname, "..");
const events = [];
function record(code) {
  events.push({ time: new Date().toISOString(), code });
  if (events.length > 200) events.shift();
}
function atomic(file, value) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, value, { mode: 0o600 });
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
function saveSettings() {
  atomic(
    join(app.getPath("userData"), "settings.json"),
    JSON.stringify(settings),
  );
}
function credentials(value) {
  const file = join(app.getPath("userData"), "credential.bin");
  if (value) {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (safeStorage.getSelectedStorageBackend &&
        safeStorage.getSelectedStorageBackend() === "basic_text")
    )
      throw new Error("KEYCHAIN_UNAVAILABLE");
    atomic(file, safeStorage.encryptString(JSON.stringify(value)));
  } else atomic(file, Buffer.alloc(0));
  credential = value;
}
function state() {
  return {
    name: settings.name,
    deviceId: settings.deviceId,
    url: settings.url,
    dev: settings.dev,
    account: credential?.account ?? null,
    server: connection?.state ?? "stopped",
    health,
    scopes: core?.scopes ?? [],
    catalog,
    pairing: pairing
      ? {
          id: pairing.id,
          code: pairing.code,
          expires: pairing.expires,
          account: pairing.account ?? null,
        }
      : null,
    credentialStore: safeStorage.isEncryptionAvailable()
      ? "系统凭据保护"
      : "不可用",
    packaged: app.isPackaged,
  };
}
function update() {
  if (!quitting && win && !win.isDestroyed() && !win.webContents.isDestroyed())
    win.webContents.send("tf:state", state());
}
async function api(route, data, token) {
  const response = await fetch(
    settings.url +
      (settings.transport === "chat"
        ? "/api/desktop" + route.replace(/^\/api/, "")
        : route),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    },
  );
  const value = await response.json();
  if (!response.ok || value.error) {
    const e = new Error(value.error?.code ?? "OFFLINE");
    e.code = value.error?.code ?? "OFFLINE";
    throw e;
  }
  return value;
}
async function poll() {
  if (quitting) return;
  try {
    health = await adapter.call("status");
    connection.status(health);
  } catch {
    health = {
      appRunning: false,
      ipcConnected: false,
      code: "IPC_UNAVAILABLE",
    };
  }
  if (pairing) {
    if (pairing.expires <= Date.now()) {
      pairing = null;
      record("PAIR_EXPIRED");
    } else
      try {
        const p = await api("/api/pair/poll", {
          id: pairing.id,
          secret: pairing.secret,
        });
        pairing.account = p.account;
      } catch {
        /* transient relay failures are represented by server state */
      }
  }
  if (connection.state === "online") {
    try {
      await core.refreshDesktopCatalog();
    } catch (e) {
      health.code = e.code ?? "CATALOG_UNAVAILABLE";
      record(health.code);
    }
    // Only browser-opened sessions need live subscriptions, not every stored chat.
    if (health.ipcConnected)
      for (const sessionId of core.watched) {
        try {
          await adapter.call("read", { sessionId });
        } catch (e) {
          record(e.code ?? "OWNER_UNAVAILABLE");
        }
      }
  }
  update();
  if (!quitting) timer = setTimeout(poll, 5000);
}
function window() {
  if (win) {
    win.show();
    return;
  }
  win = new BrowserWindow({
    width: 640,
    height: 880,
    minWidth: 540,
    minHeight: 720,
    title: "TokenFree Connector",
    backgroundColor: "#f5f7fb",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.loadFile(join(__dirname, "index.html"));
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (initialized) window();
  });
  app
    .whenReady()
    .then(async () => {
      app.setName("TokenFree Connector");
      const data = app.getPath("userData");
      mkdirSync(data, { recursive: true, mode: 0o700 });
      try {
        settings = JSON.parse(
          readFileSync(join(data, "settings.json"), "utf8"),
        );
      } catch {
        settings = {
          deviceId: randomUUID(),
          name: hostname(),
          url: process.env.TF_CHAT_URL ?? "http://127.0.0.1:3080",
          transport: "chat",
          dev: true,
          scopes: [],
        };
        saveSettings();
      }
      try {
        const bytes = readFileSync(join(data, "credential.bin"));
        if (bytes.length)
          credential = JSON.parse(safeStorage.decryptString(bytes));
      } catch {
        record("CREDENTIAL_READ_FAILED");
      }
      // Test-relay bindings cannot authenticate to Chat. Migrate the default endpoint only.
      if (!settings.transport && settings.url === "http://127.0.0.1:4318") {
        settings.url = process.env.TF_CHAT_URL ?? "http://127.0.0.1:3080";
        settings.transport = "chat";
        credentials(null);
        saveSettings();
      }
      const { PythonAdapter } = await import(
        pathToFileURL(join(root, "dist/src/core/adapter.js")).href
      );
      const { ConnectorCore } = await import(
        pathToFileURL(join(root, "dist/src/core/core.js")).href
      );
      const { Connection } = await import(
        pathToFileURL(join(root, "dist/src/core/connection.js")).href
      );
      const { relayURL, safeError, Fault, Errors } = await import(
        pathToFileURL(join(root, "dist/src/protocol/index.js")).href
      );
      const bundled = join(process.resourcesPath, "adapter/tokenfree-adapter");
      adapter = new PythonAdapter(
        app.isPackaged
          ? bundled
          : existsSync(join(root, ".local/adapter/tokenfree-adapter"))
            ? join(root, ".local/adapter/tokenfree-adapter")
            : "python3",
        app.isPackaged ||
          existsSync(join(root, ".local/adapter/tokenfree-adapter"))
          ? []
          : [join(root, "adapter/main.py")],
        app.isPackaged ? data : root,
      );
      const ledgerFile = join(data, "ledger.json");
      core = new ConnectorCore(adapter, {
        getLedger() {
          try {
            return JSON.parse(readFileSync(ledgerFile, "utf8"));
          } catch (e) {
            if (e.code === "ENOENT") return {};
            throw new Error("LEDGER_CORRUPT");
          }
        },
        saveLedger(v) {
          atomic(ledgerFile, JSON.stringify(v));
        },
      });
      const { ChatConnection } = await import(
        pathToFileURL(join(root, "dist/src/core/chat.js")).href
      );
      connection =
        settings.transport === "chat"
          ? new ChatConnection(core)
          : new Connection(core);
      connection.on("state", (s) => {
        record(s);
        update();
      });
      adapter.on("event", (e) => {
        if (e.type === "status") {
          record(e.code ?? "IPC_STATE");
          if (e.code === "IPC_DISCONNECTED")
            health = { ...health, ipcConnected: false, code: e.code };
          update();
        }
      });
      // An old per-session grant is never silently widened at launch.
      // The next explicit Connect action uses the disclosed whole-desktop scope.
      ipcMain.handle("tf:action", async (event, action, payload) => {
        if (
          event.sender !== win?.webContents ||
          event.senderFrame !== win.webContents.mainFrame
        )
          return { error: { code: "FORBIDDEN", message: "无权访问" } };
        try {
          if (action === "state") return { value: state() };
          if (action === "refresh") {
            catalog = await adapter.call("catalog");
            health = await adapter.call("status");
          } else if (action === "configure") {
            if (credential || pairing || connection.state !== "stopped")
              throw new Fault("FORBIDDEN");
            if (
              typeof payload?.name !== "string" ||
              payload.name.length > 100 ||
              typeof payload.dev !== "boolean"
            )
              throw new Fault("INVALID_REQUEST");
            settings.url = relayURL(payload.url, payload.dev);
            settings.name = payload.name;
            settings.dev = payload.dev;
            saveSettings();
          } else if (action === "pair") {
            if (credential) throw new Fault("FORBIDDEN");
            pairing = await api("/api/pair/start", {
              deviceId: settings.deviceId,
              name: settings.name,
            });
            await shell.openExternal(
              settings.url +
                (settings.transport === "chat" ? "/desktop?pair=" : "/?pair=") +
                encodeURIComponent(pairing.id),
            );
          } else if (action === "confirm") {
            if (!pairing?.account) throw new Fault("PAIR_PENDING");
            if (!safeStorage.isEncryptionAvailable())
              throw new Fault("INTERNAL");
            const value = await api("/api/pair/confirm", {
              id: pairing.id,
              secret: pairing.secret,
            });
            try {
              credentials(value);
            } catch (e) {
              await api("/api/device/revoke", {}, value.token);
              throw e;
            }
            pairing = null;
            core.resetLedger();
            await core.grantDesktopAccess();
            settings.accessMode = "desktop";
            saveSettings();
            connection.start({
              url: settings.url,
              dev: settings.dev,
              token: credential.token,
              deviceId: settings.deviceId,
            });
          } else if (action === "revoke") {
            connection.stop();
            // Keep the revocation credential if offline, so the user can retry rather than orphan it.
            if (credential) {
              try {
                await api("/api/device/revoke", {}, credential.token);
              } catch (e) {
                if (e.code !== "UNAUTHORIZED") throw e;
              }
            }
            credentials(null);
            pairing = null;
            core.resetLedger();
            settings.scopes = [];
            await core.revokeDesktopAccess();
            saveSettings();
          } else if (action === "start") {
            if (!credential) throw new Fault("UNAUTHORIZED");
            await core.grantDesktopAccess();
            settings.accessMode = "desktop";
            saveSettings();
            connection.start({
              url: settings.url,
              dev: settings.dev,
              token: credential.token,
              deviceId: settings.deviceId,
            });
          } else if (action === "stop") {
            connection.stop();
          } else if (action === "browser") {
            await shell.openExternal(
              settings.url + (settings.transport === "chat" ? "/desktop" : "/"),
            );
          } else if (action === "diagnostics") {
            const picked = await dialog.showSaveDialog(win, {
              title: "导出脱敏诊断",
              defaultPath: "tokenfree-diagnostics.json",
            });
            if (!picked.canceled && picked.filePath)
              writeFileSync(
                picked.filePath,
                JSON.stringify(
                  {
                    appVersion: app.getVersion(),
                    platform: process.platform,
                    arch: process.arch,
                    codex: health.app,
                    ipcConnected: health.ipcConnected,
                    server: connection.state,
                    scopeCount: core.scopes.length,
                    events,
                  },
                  null,
                  2,
                ),
                { mode: 0o600 },
              );
          } else if (action === "quit") {
            quitting = true;
            app.quit();
          } else if (action !== "refresh") throw new Fault("UNSUPPORTED");
          update();
          return { value: state() };
        } catch (e) {
          const code = e.code ?? e.message;
          const error = safeError(code in Errors ? new Fault(code) : e);
          record(error.code);
          return { error };
        }
      });
      const pixels = Buffer.alloc(16 * 16 * 4);
      for (let y = 3; y < 13; y++)
        for (let x = 3; x < 13; x++) {
          const i = (y * 16 + x) * 4;
          pixels[i] = 25;
          pixels[i + 1] = 110;
          pixels[i + 2] = 100;
          pixels[i + 3] = 255;
        }
      const icon = nativeImage.createFromBitmap(pixels, {
        width: 16,
        height: 16,
        scaleFactor: 1,
      });
      tray = new Tray(icon);
      tray.setTitle("TF");
      tray.setToolTip("TokenFree Connector");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开连接器", click: window },
          { label: "停止远程连接", click: () => connection.stop() },
          { type: "separator" },
          {
            label: "退出 TokenFree Connector",
            click: () => {
              quitting = true;
              app.quit();
            },
          },
        ]),
      );
      initialized = true;
      window();
      void poll();
    })
    .catch((e) => {
      console.error(
        "STARTUP_FAILURE",
        e.name,
        e.code ?? "",
        String(e.stack).split("\n").slice(1, 4).join("\n"),
      );
      dialog.showErrorBox(
        "TokenFree Connector",
        "启动失败，可能是安全操作记录损坏或运行时缺失。请保留应用数据并检查构建文档，不要删除操作记录后重发消息。",
      );
      app.quit();
    });
  app.on("activate", () => {
    if (initialized) window();
  });
  app.on("before-quit", () => {
    quitting = true;
    clearTimeout(timer);
    connection?.stop();
    adapter?.close();
  });
}
