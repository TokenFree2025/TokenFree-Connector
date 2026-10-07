const $ = (id) => document.getElementById(id);
let ws,
  device,
  session,
  snapshot,
  account,
  attempt = 0,
  reconnectTimer,
  epoch = 0,
  scopeKey = "",
  restore = true;
const pending = new Map();
const text = (id, value) => {
  $(id).textContent = value;
};
const notice = (s) => text("notice", s);
async function api(route, data) {
  const r = await fetch(route, {
    method: data ? "POST" : "GET",
    headers: data ? { "Content-Type": "application/json" } : {},
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const v = await r.json();
  if (v.error) throw new Error(v.error.message);
  return v;
}
const protect = (fn) => async () => {
  try {
    await fn();
  } catch (e) {
    notice(e.message);
  }
};
async function loadDevices() {
  const v = await api("/api/devices");
  account = v.account;
  text("account", `当前身份：${account}`);
  $("devices").replaceChildren();
  for (const d of v.devices) {
    const b = document.createElement("button");
    b.textContent = `${d.name} · ${d.online ? "服务器在线" : "离线"}`;
    b.onclick = () => connect(d);
    $("devices").append(b);
  }
  if (restore) {
    restore = false;
    const remembered = JSON.parse(sessionStorage.getItem("tfView") ?? "null");
    const found = v.devices.find((d) => d.deviceId === remembered?.deviceId);
    if (found) {
      session = found.scopes.find((s) => s.sessionId === remembered.sessionId);
      connect(found, true);
    }
  }
  if (!v.devices.length) notice("暂无设备。在电脑连接器开始绑定。");
  if (device) {
    const fresh = v.devices.find((d) => d.deviceId === device.deviceId);
    if (fresh) {
      device = fresh;
      deviceStatus();
    } else {
      ws?.close();
      device = null;
      clearSession();
    }
  }
}
function clearSession() {
  session = null;
  snapshot = null;
  approvalsKey = "";
  text("title", "选择已授权会话");
  text("sessionId", "会话 ID 将在这里显示");
  text("runtime", "");
  if (!device) {
    text("deviceState", "未选择设备或绑定已撤销");
    $("sessions").replaceChildren();
    $("revoke").disabled = true;
    scopeKey = "";
  }
  $("history").replaceChildren();
  $("approvals").replaceChildren();
  $("message").disabled = true;
  $("send").disabled = true;
  $("stop").disabled = true;
  $("refresh").disabled = true;
}
function deviceStatus() {
  if (!device) return;
  const h = device.status ?? {};
  text(
    "deviceState",
    `服务器：${device.online ? "在线" : "离线"}\nCodex App：${h.appRunning ? "运行中" : "未运行"}\n本地 IPC：${h.ipcConnected ? "已连接" : "未连接"}\n${h.code ?? ""}`,
  );
  $("revoke").disabled = false;
  const nextScopeKey = JSON.stringify(device.scopes) + session?.sessionId;
  if (nextScopeKey !== scopeKey) {
    scopeKey = nextScopeKey;
    $("sessions").replaceChildren();
    for (const s of device.scopes ?? []) {
      const b = document.createElement("button");
      b.textContent = s.title;
      b.className = session?.sessionId === s.sessionId ? "selected" : "";
      b.title = s.cwd + "\n" + s.sessionId;
      b.onclick = protect(async () => {
        session = s;
        sessionStorage.setItem(
          "tfView",
          JSON.stringify({ deviceId: device.deviceId, sessionId: s.sessionId }),
        );
        text("title", s.title);
        text("sessionId", s.sessionId);
        $("refresh").disabled = false;
        await read();
      });
      $("sessions").append(b);
    }
  }
  if (
    session &&
    !device.scopes.some((s) => s.sessionId === session.sessionId)
  ) {
    clearSession();
    notice("该会话的授权已撤销。");
  }
  if (!device.online) {
    $("send").disabled = true;
    $("stop").disabled = true;
  }
}
function connect(d, retry = false) {
  clearTimeout(reconnectTimer);
  const localEpoch = ++epoch;
  ws?.close();
  device = d;
  if (!retry) clearSession();
  deviceStatus();
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/browser?deviceId=${encodeURIComponent(d.deviceId)}`,
  );
  const socket = ws;
  socket.onopen = () => {
    attempt = 0;
    notice("浏览器已连接 relay。选择会话读取实时桌面状态。");
    if (session) {
      text("title", session.title);
      text("sessionId", session.sessionId);
      $("refresh").disabled = false;
    }
    if (session) read().catch((e) => notice(e.message));
  };
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.v !== 1) return;
    if (m.type === "device") {
      device = { ...device, ...m };
      deviceStatus();
    }
    if (m.type === "event" && session?.sessionId === m.sessionId) {
      renderSnapshot(m.snapshot);
      sessionStorage.setItem(
        "tfCursor:" + session.sessionId,
        JSON.stringify({ cursor: m.sequence, streamId: m.streamId }),
      );
    }
    if (m.type === "result") {
      const p = pending.get(m.requestId);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(m.requestId);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      }
    }
    if (m.type === "error") notice(m.error.message);
  };
  socket.onclose = (e) => {
    if (localEpoch !== epoch) return;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        new Error(
          "连接断开。写入结果可能不确定，请读取原会话核对，不要盲目重发。",
        ),
      );
    }
    pending.clear();
    $("send").disabled = true;
    $("stop").disabled = true;
    notice(
      e.code === 4001
        ? "设备授权已撤销。"
        : "浏览器连接断开；桌面任务继续执行。正在重连并恢复原会话状态。",
    );
    if (e.code !== 4001)
      reconnectTimer = setTimeout(
        () => connect(device, true),
        Math.min(30000, 500 * 2 ** attempt++) * (0.5 + Math.random()),
      );
  };
}
function request(method, extra = {}) {
  if (ws?.readyState !== 1) throw new Error("浏览器未连接。");
  if (pending.size >= 16) throw new Error("请求过多，请等待。");
  const requestId = crypto.randomUUID();
  const message = {
    v: 1,
    requestId,
    deviceId: device.deviceId,
    method,
    ...(method === "list"
      ? {}
      : { sessionId: session.sessionId, projectId: session.projectId }),
    ...extra,
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("响应超时；请读取原会话核对。"));
    }, 50000);
    pending.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify(message));
  });
}
async function read() {
  let saved = { cursor: 0 };
  try {
    const parsed = JSON.parse(
      sessionStorage.getItem("tfCursor:" + session.sessionId) ?? "null",
    );
    if (parsed && typeof parsed.cursor === "number") saved = parsed;
  } catch {
    /* Old cursor format falls back to a fresh snapshot. */
  }
  const sync = await request("sync", saved);
  sessionStorage.setItem(
    "tfCursor:" + session.sessionId,
    JSON.stringify({ cursor: sync.cursor, streamId: sync.streamId }),
  );
  const v = sync.snapshot;
  renderSnapshot(v);
  if (sessionStorage.getItem("tfPending")) {
    notice(
      "上次操作结果尚不确定。已读取原会话，请核对消息和执行状态；不要盲目重发。",
    );
    return;
  }
  notice(
    "已读取桌面原会话。" +
      (v.historyTruncated || !v.historyComplete
        ? "当前显示最近历史窗口，完整历史请在桌面查看。"
        : ""),
  );
}
function renderSnapshot(v) {
  snapshot = v;
  text(
    "runtime",
    `状态：${v.status} · ${v.connected ? "实时桌面快照" : "连接已断开"} · revision ${v.revision ?? "—"} · ${v.provider ?? ""} / ${v.model ?? ""}`,
  );
  const atBottom =
    $("history").scrollHeight -
      $("history").scrollTop -
      $("history").clientHeight <
    60;
  $("history").replaceChildren();
  for (const t of v.turns ?? []) {
    const turn = document.createElement("div");
    turn.className = "turn";
    for (const m of t.messages ?? []) {
      const b = document.createElement("div");
      b.className = "bubble " + (m.role ?? "activity");
      const label = document.createElement("strong");
      label.textContent =
        m.role === "user"
          ? "YOU"
          : m.role === "assistant"
            ? "CODEX"
            : (m.title ?? m.kind);
      const content = document.createElement("span");
      content.textContent = m.text ?? "";
      b.append(label, content);
      turn.append(b);
    }
    const status = document.createElement("div");
    status.className = "turn-status";
    status.textContent = `${t.id} · ${t.status ?? ""}`;
    turn.append(status);
    $("history").append(turn);
  }
  if (atBottom) $("history").scrollTop = $("history").scrollHeight;
  $("message").disabled = !v.connected;
  $("send").disabled = !device.online || !v.connected || v.status !== "idle";
  $("stop").disabled =
    !device.online ||
    !v.connected ||
    !(v.turns ?? []).some((t) => t.status === "inProgress");
  renderApprovals(v.requests ?? []);
}
let approvalsKey = "";
function renderApprovals(requests) {
  const key = JSON.stringify(requests);
  if (key === approvalsKey) return;
  approvalsKey = key;
  $("approvals").replaceChildren();
  for (const a of requests) {
    const box = document.createElement("div");
    box.className = "approval";
    const heading = document.createElement("strong");
    heading.textContent = a.supported ? "需要你的确认" : "请在 Codex 桌面处理";
    box.append(heading);
    const details = document.createElement("pre");
    details.textContent = a.supported
      ? JSON.stringify(a.params, null, 2)
      : a.method;
    box.append(details);
    if (a.supported) {
      if (a.method.includes("requestUserInput")) {
        const inputs = [];
        for (const q of a.params.questions ?? []) {
          const label = document.createElement("label");
          label.textContent = q.question;
          const input = document.createElement("input");
          input.placeholder = (q.options ?? []).map((o) => o.label).join(" / ");
          label.append(input);
          box.append(label);
          inputs.push([q.id, input]);
        }
        const b = document.createElement("button");
        b.textContent = "提交补充信息";
        b.onclick = protect(() =>
          mutate("respond", {
            approvalId: a.id,
            answers: Object.fromEntries(
              inputs.map(([id, input]) => [id, [input.value]]),
            ),
          }),
        );
        box.append(b);
      } else {
        for (const [decision, label] of [
          ["accept", "仅批准本次"],
          ["decline", "拒绝"],
          ["cancel", "取消"],
        ]) {
          if (
            a.params.availableDecisions &&
            !a.params.availableDecisions.includes(decision)
          )
            continue;
          const b = document.createElement("button");
          b.textContent = label;
          b.onclick = protect(() =>
            mutate("respond", { approvalId: a.id, decision }),
          );
          box.append(b);
        }
      }
    } else {
      const p = document.createElement("p");
      p.textContent = "浏览器不会自动批准。请打开电脑上的该会话完成处理。";
      box.append(p);
    }
    $("approvals").append(box);
  }
}
async function mutate(method, extra) {
  const operationId = crypto.randomUUID();
  sessionStorage.setItem(
    "tfPending",
    JSON.stringify({ operationId, method, sessionId: session.sessionId }),
  );
  $("send").disabled = true;
  const r = await request(method, { operationId, ...extra });
  if (r.status === "accepted") {
    sessionStorage.removeItem("tfPending");
    notice(`桌面已接受操作 ${operationId}；等待该会话真实执行终态。`);
    if (method === "send") $("message").value = "";
  } else notice(r.error?.message ?? `操作状态：${r.status}。请核对原会话。`);
  await read();
}
$("login").onclick = protect(async () => {
  await api("/api/login", { account: $("identity").value });
  epoch++;
  clearTimeout(reconnectTimer);
  ws?.close();
  device = null;
  clearSession();
  await loadDevices();
});
$("reload").onclick = protect(loadDevices);
$("claim").onclick = protect(async () => {
  const r = await api("/api/pair/claim", {
    id: $("pairId").value,
    code: $("code").value,
  });
  notice(`账号 ${r.account} 已确认。请回到连接器，在本机确认绑定。`);
});
$("refresh").onclick = protect(read);
$("send").onclick = protect(() => mutate("send", { text: $("message").value }));
$("stop").onclick = protect(() => {
  const t = [...snapshot.turns]
    .reverse()
    .find((t) => t.status === "inProgress");
  if (!t) throw new Error("没有当前任务");
  return mutate("stop", { turnId: t.id });
});
$("revoke").onclick = protect(async () => {
  await api("/api/revoke", { deviceId: device.deviceId });
  epoch++;
  clearTimeout(reconnectTimer);
  ws?.close();
  device = null;
  sessionStorage.removeItem("tfView");
  clearSession();
  notice("设备凭据已撤销，已有远程连接已关闭。");
  await loadDevices();
});
const pair = new URLSearchParams(location.search).get("pair");
if (pair) {
  $("pairPanel").hidden = false;
  $("pairId").value = pair;
}
loadDevices().catch(() => notice("请选择开发测试身份登录。"));
if (sessionStorage.getItem("tfPending"))
  notice("上次有操作未收到确定结果。请读取原会话核对后再操作。");
