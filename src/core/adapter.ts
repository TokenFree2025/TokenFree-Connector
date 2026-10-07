import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { Fault, Errors, MAX_BYTES, type Code } from "../protocol/index.js";
export interface DesktopAdapter {
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: "event", cb: (value: any) => void): this;
  close(): void;
}
export class PythonAdapter extends EventEmitter implements DesktopAdapter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(command: string, args: string[], cwd: string) {
    super();
    this.child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    // Never forward sidecar stderr, which might contain upstream exception details.
    this.child.stderr.resume();
    let bytes = 0;
    this.child.stdout.on("data", (b: Buffer) => {
      bytes += b.length;
      if (bytes > MAX_BYTES * 2) this.child.kill();
      if (b.includes(10)) bytes = 0;
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        if (Buffer.byteLength(line) > MAX_BYTES) throw new Error();
        const m = JSON.parse(line);
        if (m.event) {
          this.emit("event", m.event);
          return;
        }
        const p = this.pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        if (m.error)
          p.reject(
            new Fault(m.error in Errors ? (m.error as Code) : "INTERNAL"),
          );
        else p.resolve(m.result);
      } catch {
        this.fail();
      }
    });
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
  }
  private fail() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Fault("OPERATION_UNCERTAIN"));
    }
    this.pending.clear();
    this.emit("event", { type: "status", code: "IPC_DISCONNECTED" });
  }
  call(method: string, params: Record<string, unknown> = {}) {
    if (this.pending.size >= 32)
      return Promise.reject(new Fault("BACKPRESSURE"));
    const id = randomUUID();
    const data = JSON.stringify({ id, method, params }) + "\n";
    if (Buffer.byteLength(data) > MAX_BYTES)
      return Promise.reject(new Fault("MESSAGE_TOO_LARGE"));
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Fault(
            ["send", "stop", "respond"].includes(method)
              ? "OPERATION_UNCERTAIN"
              : "IPC_UNAVAILABLE",
          ),
        );
      }, 40000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(data, (e) => {
        if (e) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Fault("OPERATION_UNCERTAIN"));
        }
      });
    });
  }
  close() {
    this.child.stdin.end();
    setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill();
    }, 1500).unref();
  }
}
