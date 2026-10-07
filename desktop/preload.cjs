const { contextBridge, ipcRenderer } = require("electron");
const allowed = new Set([
  "state",
  "refresh",
  "configure",
  "pair",
  "confirm",
  "revoke",
  "start",
  "stop",
  "browser",
  "diagnostics",
  "quit",
]);
contextBridge.exposeInMainWorld(
  "connector",
  Object.freeze({
    action: (name, payload) => {
      if (!allowed.has(name))
        return Promise.reject(new Error("Unsupported action"));
      return ipcRenderer.invoke("tf:action", name, payload);
    },
    onState: (cb) => {
      const listener = (_event, value) => cb(value);
      ipcRenderer.on("tf:state", listener);
      return () => ipcRenderer.removeListener("tf:state", listener);
    },
  }),
);
