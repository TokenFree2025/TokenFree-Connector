# TokenFree Connector protocol v1

生产承载 HTTPS + WSS。开发 relay 的本机例外是 HTTP + WS。所有操作严格按 Zod discriminated union 校验；未知字段、未知 method、错误版本拒绝，不进行通用 RPC 透传。具体 schema 见 `src/protocol/index.ts`。

## 配对与身份

| HTTP endpoint | 调用者 | 请求与结果 |
| --- | --- | --- |
| POST `/api/pair/start` | 连接器 | `{deviceId,name}` → `{id,secret,code,expires}` |
| POST `/api/pair/claim` | 已登录浏览器，同源 | `{id,code}` → 待本机确认的 account |
| POST `/api/pair/poll` | 连接器 | `{id,secret}` → `{account,expires}` |
| POST `/api/pair/confirm` | 连接器，本机按钮触发 | `{id,secret}` → `{deviceId,account,token}`，单次消费 |
| POST `/api/device/revoke` | Bearer 设备凭据 | 撤销本设备 |
| POST `/api/revoke` | 账号 cookie | `{deviceId}`，必须属于该账号 |
| GET `/api/devices` | 账号 cookie | 本账号设备、在线状态、已授权会话 |
| POST `/api/login` | 开发模拟身份 | `{account:alice或bob}` → HttpOnly cookie；生产必须替换 |

HTTP body ≤16 KiB。pair TTL=300 秒。凭据和 secret 不放 URL。pair 链接只含随机 pair ID，用户输入连接器上显示的码。

## 连接与 envelope

连接器主动连接 `/connector`，HTTP Upgrade 使用 `Authorization: Bearer <device-token>`。浏览器连接 `/browser?deviceId=<id>`，使用 HttpOnly 账号 cookie + Origin 校验。握手必须确认账号设备归属。设备被替换 close 4002，撤销 close 4001。

```json
{"v":1,"requestId":"UUID","deviceId":"UUID","method":"send","projectId":"24位hex","sessionId":"原桌面UUID","operationId":"UUID","text":"你好"}
```

允许操作：

| method | 其他字段 | 语义 |
| --- | --- | --- |
| list | 无 | 返回整机授权后的本地桌面会话目录，包括后续新建会话 |
| read | projectId, sessionId | 强制订阅新鲜原 owner 快照 |
| sync | projectId, sessionId, cursor, 可选 streamId | 有界事件重放 + 原 owner 最新 snapshot；重启/缺口时 resetRequired |
| send | 上述范围 + operationId, text | 普通发送，最多 20,000 字符，忙时拒绝 |
| stop | 上述范围 + operationId, turnId | 只停止这个预期当前 turn |
| respond | 上述范围 + operationId, approvalId, decision 或 answers | 重新核对待审批；decision=accept/decline/cancel；answers 为题目 ID 到字符串数组 |

relay 包装 `{v:1,type:request,routeId,operation}`，routeId 用于区分并发客户端；连接器回答 `{v:1,type:result,routeId,result|error}`。浏览器得到以原 requestId 关联的 result。requestId 是单次传输 ID，**operationId 是跨重试稳定的写入 ID**。

接受写入返回 `status:accepted`，不代表任务执行完毕。事件 `snapshot.turns[].status` 才描述真实 inProgress/completed/interrupted 等终态。写入有不确定窗口时返回 `status:uncertain` 或 `OPERATION_UNCERTAIN`；相同 operationId 重试返回保存状态，不重发 IPC。相同 ID 换 payload 报 OPERATION_CONFLICT。浏览器保留 pending 提示，刷新只读原会话核对。

## 状态与事件

连接器发 `{v:1,type:status,status,scopes}`。status 分开 appRunning、ipcConnected、app.version/build、compatibility；scopes 是用户连接时授权的整机桌面会话目录（最多 5,000 条）；按需跟随最多 32 个会话。relay 生成 `{v:1,type:device,online,status,scopes}`。`online` 只表示设备 relay 连接存在。

```json
{"v":1,"type":"event","streamId":"连接器启动epoch UUID","sequence":12,"sessionId":"原桌面UUID","snapshot":{"id":"原桌面UUID","connected":true,"status":"active","revision":42,"turns":[],"requests":[]}}
```

sequence 为连接器内存 epoch 内单调序号，不是原桌面 revision。最多保留 100 条 / 4 MiB；sync 按会话过滤，不泄露其他范围。streamId 不同、cursor 超出窗口或核心重启，resetRequired=true；无论是否能 replay，sync 都读取原 owner 最新状态恢复。网页保存 cursor/epoch，刷新后重新验证授权和同步，不把旧缓存当作权威。

快照带能力声明。create=false、remoteHosts=false。command/file approval 和同步 userInput 可响应；异步问题通过原生 questionItemId reply 协议送入同一会话；其他审批 supported=false，提示桌面处理。最近窗口最多 30 turns、每 turn 100 items，文本单项最多 16,000 字符，整体约 700 KiB；更早/超大的历史留在桌面，historyTruncated/historyComplete 明示边界。

## 稳定错误

错误统一 `{code,message}`，message 为本地固定文案，禁止直接透传上游异常。常见 code：UNAUTHORIZED、FORBIDDEN、OFFLINE、CODEX_NOT_RUNNING、IPC_UNAVAILABLE、IPC_INCOMPATIBLE、OWNER_UNAVAILABLE、SESSION_BUSY、STALE_TURN、STALE_APPROVAL、DESKTOP_ACTION_REQUIRED、OPERATION_UNCERTAIN、OPERATION_CONFLICT、BACKPRESSURE、MESSAGE_TOO_LARGE。完整列表在 schema 文件。

relay 45 秒等待超时对写入返回 uncertain，对读取返回 offline。浏览器关闭不发送 stop；网络断线不自动取消 turn 或自动重放 mutation。
