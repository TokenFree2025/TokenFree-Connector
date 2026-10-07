import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createRelay } from "./server.js";
const relay = createRelay({
  port: Number(process.env.TF_RELAY_PORT ?? 4318),
  webRoot: resolve("web"),
  ...(process.env.TF_TLS_CERT && process.env.TF_TLS_KEY
    ? {
        tls: {
          cert: readFileSync(process.env.TF_TLS_CERT),
          key: readFileSync(process.env.TF_TLS_KEY),
        },
      }
    : {}),
});
const origin = await relay.listen();
console.log(
  `TokenFree development relay: ${origin} (loopback only; test identities; memory-only bindings)`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
