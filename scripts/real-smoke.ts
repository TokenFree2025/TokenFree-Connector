/** Read-only real desktop probe. Use a dedicated, already-open acceptance session. */
import { resolve } from "node:path";
import { PythonAdapter } from "../src/core/adapter.js";
import { id } from "../src/protocol/index.js";
const sessionId = id.parse(process.env.TF_TEST_SESSION_ID);
const adapter = new PythonAdapter(
  "python3",
  [resolve("adapter/main.py")],
  process.cwd(),
);
try {
  const status = await adapter.call("status");
  const view = await adapter.call("read", { sessionId });
  if (view.id !== sessionId || !view.connected)
    throw new Error("Same-session live snapshot not established");
  console.log(
    JSON.stringify(
      {
        status,
        sessionId: view.id,
        revision: view.revision,
        runtime: view.status,
        turnCount: view.turns.length,
        turns: view.turns.map((t: any) => ({ id: t.id, status: t.status })),
        capabilities: view.capabilities,
      },
      null,
      2,
    ),
  );
} finally {
  adapter.close();
}
