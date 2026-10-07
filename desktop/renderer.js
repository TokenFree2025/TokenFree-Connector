const $ = (id) => document.getElementById(id);
let current;
function render(s) {
  current = s;
  $("appState").textContent = s.health.appRunning ? "正在运行" : "未运行";
  $("appState").className = s.health.appRunning ? "good" : "";
  $("ipcState").textContent = s.health.ipcConnected ? "已连接" : "等待 Codex";
  $("ipcState").className = s.health.ipcConnected ? "good" : "";
  $("accountState").textContent = s.account ?? "未绑定";
  $("serverState").textContent =
    {
      stopped: "已停止",
      online: "在线",
      connecting: "正在连接",
      reconnecting: "正在重连",
      "credentials-invalid": "凭据已失效",
      replaced: "另一实例已连接",
    }[s.server] ?? s.server;
  $("serverState").className = s.server === "online" ? "good" : "";
  const online = ["online", "connecting", "reconnecting"].includes(s.server);
  $("connect").textContent = online
    ? "断开连接"
    : s.pairing?.account
      ? "确认账号并连接"
      : s.pairing
        ? "等待浏览器确认…"
        : s.account
          ? "连接 TokenFreeChat"
          : "连接 TokenFreeChat";
  $("connect").disabled = !!s.pairing && !s.pairing.account;
  $("hint").textContent = online
    ? "已连接，可以在 TokenFreeChat 中继续。"
    : s.pairing?.account
      ? `请确认绑定账号：${s.pairing.account}`
      : s.pairing
        ? "请在已打开的浏览器中完成登录。"
        : s.account
          ? "账号已绑定，点击即可连接。"
          : "首次连接时，在浏览器登录并确认账号即可。";
  $("revoke").disabled = !s.account;
  $("pairing").hidden = !s.pairing;
  if (s.pairing) {
    $("code").textContent = s.pairing.code;
    $("expiry").textContent =
      `有效至 ${new Date(s.pairing.expires).toLocaleTimeString()}`;
    $("pairAccount").textContent = s.pairing.account
      ? `待确认账号：${s.pairing.account}`
      : "等待浏览器选择账号";
  }
}
async function action(name, payload) {
  $("error").hidden = true;
  try {
    const r = await window.connector.action(name, payload);
    if (r.error) {
      $("error").textContent = `${r.error.message} (${r.error.code})`;
      $("error").hidden = false;
    } else {
      render(r.value);
      return true;
    }
  } catch {
    $("error").textContent = "操作未完成，请重试。";
    $("error").hidden = false;
  } finally {
    if (current)
      $("connect").disabled = !!current.pairing && !current.pairing.account;
  }
  return false;
}
for (const id of ["revoke", "browser", "diagnostics", "quit"])
  $(id).onclick = () => action(id);
$("connect").onclick = async () => {
  $("connect").disabled = true;
  if (["online", "connecting", "reconnecting"].includes(current.server))
    await action("stop");
  else if (current.pairing?.account) await action("confirm");
  else if (current.account && current.server !== "credentials-invalid")
    await action("start");
  else {
    if (current.account) {
      const ok = await action("revoke");
      if (!ok) return;
    }
    await action("pair");
  }
};
window.connector.onState(render);
action("state");
