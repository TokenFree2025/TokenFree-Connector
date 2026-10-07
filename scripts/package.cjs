const packager = (options) =>
  import("@electron/packager").then((m) => m.packager(options));
const { resolve } = require("node:path");
packager({
  dir: resolve("."),
  out: resolve("release"),
  name: "TokenFree Connector",
  appBundleId: "chat.tokenfree.connector",
  appVersion: "0.1.0",
  platform: process.platform,
  arch: process.arch,
  overwrite: true,
  asar: true,
  ignore: [
    /^\/\.git($|\/)/,
    /^\/\.local($|\/)/,
    /^\/release($|\/)/,
    /^\/tests($|\/)/,
    /^\/src($|\/)/,
    /^\/scripts($|\/)/,
    /^\/adapter($|\/)/,
  ],
  extraResource: [resolve(".local/adapter"), resolve("vendor")],
})
  .then((paths) => console.log("Portable application:", paths.join("\n")))
  .catch(() => {
    console.error("Packaging failed");
    process.exitCode = 1;
  });
