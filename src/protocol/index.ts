import { z } from "zod";
export const VERSION = 1;
export const MAX_BYTES = 1024 * 1024;
export const MAX_BUFFER = 2 * MAX_BYTES;
export const id = z.string().uuid();
const base = { v: z.literal(VERSION), requestId: id, deviceId: id };
const session = {
  sessionId: id,
  projectId: z.string().regex(/^[a-f0-9]{24}$/),
};
export const Operation = z.discriminatedUnion("method", [
  z.object({ ...base, method: z.literal("list") }).strict(),
  z.object({ ...base, ...session, method: z.literal("read") }).strict(),
  z
    .object({
      ...base,
      ...session,
      method: z.literal("sync"),
      cursor: z.number().int().nonnegative(),
      streamId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      ...session,
      method: z.literal("send"),
      operationId: id,
      text: z.string().trim().min(1).max(20000),
    })
    .strict(),
  z
    .object({
      ...base,
      ...session,
      method: z.literal("stop"),
      operationId: id,
      turnId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      ...base,
      ...session,
      method: z.literal("respond"),
      operationId: id,
      approvalId: z.string().min(1).max(200),
      decision: z.enum(["accept", "decline", "cancel"]).optional(),
      answers: z
        .record(z.array(z.string().min(1).max(20000)).min(1).max(10))
        .optional(),
    })
    .strict(),
]);
export type Operation = z.infer<typeof Operation>;
export const Errors = {
  INVALID_REQUEST: "请求格式不正确或协议版本不支持。",
  UNAUTHORIZED: "身份已失效，请重新登录或绑定。",
  FORBIDDEN: "此设备、项目或会话未获授权。",
  OFFLINE: "设备离线，请在电脑上启动连接器。",
  CODEX_NOT_RUNNING: "请先打开官方 Codex 桌面 App。",
  IPC_UNAVAILABLE: "本地 IPC 不可用，请打开或重启 Codex 后重试。",
  IPC_DISCONNECTED: "桌面 IPC 已断开，正在等待重新连接。",
  IPC_INCOMPATIBLE: "桌面 IPC 版本不兼容；请停止远程操作并检查兼容性文档。",
  OWNER_UNAVAILABLE:
    "未找到活跃的本机会话 owner，请在 Codex 桌面打开该会话后重试。",
  CATALOG_UNAVAILABLE: "暂时无法读取桌面会话列表，请启动 Codex 并刷新。",
  SESSION_BUSY: "会话已有执行中的任务，请等它结束后发送。",
  STALE_TURN: "该任务已结束或不再是当前任务，请刷新。",
  STALE_APPROVAL: "该审批已由另一端处理或已过期，请刷新。",
  DESKTOP_ACTION_REQUIRED: "此类请求需在 Codex 桌面处理。",
  OPERATION_UNCERTAIN:
    "操作可能已提交。请读取原会话核对；不要使用新操作 ID 盲目重发。",
  OPERATION_CONFLICT: "同一操作 ID 已用于其他内容。",
  LEDGER_FULL: "安全操作记录已满，请停止连接并重新绑定设备。",
  MESSAGE_TOO_LARGE: "消息超过大小限制，请在桌面查看完整内容。",
  BACKPRESSURE: "消息过多，请稍后刷新状态。",
  PAIR_EXPIRED: "配对已过期，请在连接器重新开始。",
  PAIR_USED: "配对信息已使用。",
  PAIR_LOCKED: "配对尝试次数过多，请重新开始。",
  PAIR_PENDING: "等待浏览器确认账号。",
  UNSUPPORTED: "当前版本不支持该操作。",
  INTERNAL: "操作未完成，请重试或查看诊断。",
} as const;
export type Code = keyof typeof Errors;
export class Fault extends Error {
  constructor(public code: Code) {
    super(Errors[code]);
  }
}
export function safeError(e: unknown) {
  const code = e instanceof Fault ? e.code : "INTERNAL";
  return { code, message: Errors[code] };
}
export function parseOperation(input: unknown): Operation {
  const r = Operation.safeParse(input);
  if (!r.success) throw new Fault("INVALID_REQUEST");
  return r.data;
}
export function relayURL(value: string, dev: boolean) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Fault("INVALID_REQUEST");
  }
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
    throw new Fault("INVALID_REQUEST");
  if (
    u.protocol !== "https:" &&
    !(
      dev &&
      u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
    )
  )
    throw new Fault("INVALID_REQUEST");
  return u.origin;
}
export function sendBounded(
  ws: {
    readyState: number;
    bufferedAmount: number;
    send: (s: string) => void;
    close: (n: number, s: string) => void;
  },
  message: unknown,
) {
  if (ws.readyState !== 1) throw new Fault("OFFLINE");
  const data = JSON.stringify(message);
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Fault("MESSAGE_TOO_LARGE");
  if (ws.bufferedAmount > MAX_BUFFER) {
    ws.close(1013, "BACKPRESSURE");
    throw new Fault("BACKPRESSURE");
  }
  ws.send(data);
}
export type Session = {
  sessionId: string;
  projectId: string;
  title: string;
  cwd: string;
  host: "local";
};
