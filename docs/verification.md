# 验证记录与已知限制

验证日期：2026-10-07（Asia/Shanghai）。系统：macOS 26.5.2 / arm64。官方桌面：`/Applications/ChatGPT.app`，版本 `26.930.51102`，build `13100`。参考适配协议：`thread-stream-state-changed` v11。

## 交付与自动化

- Electron 44.6.0 桌面窗口、受限 preload、菜单栏、启动/停止/退出、系统浏览器配对、safeStorage 凭据保存均已实现。
- 生成 `release/TokenFree Connector-darwin-arm64/TokenFree Connector.app`，含 PyInstaller 冻结的 Python 3.9.6 arm64 运行时。实际启动并完成 UI 绑定/授权/连接。
- 首次打包发现 ASAR 不能作子进程 cwd，已修复为真实 app data 目录。退出时窗口销毁后的事件发送错误已修复；最终版防止初始化未完成时抢先打开窗口。
- `npm run check`：TypeScript、ESLint、14 个 Node 测试、12 个 Python 测试通过（共 26 项）。
- Node 覆盖配对成功/到期/重用/尝试限制、跨用户拒绝、跨项目/会话拒绝、持久幂等与冲突、断线 uncertainty、同会话并发拒绝、撤销与读竞态、事件边界/epoch/cursor、严格 schema、大小/背压、固定错误脱敏、真实 HTTP+WS relay 路由、撤销失效、WSS 信任证书成功/未知证书拒绝。
- Python 测试使用真实 Unix socket fixture，覆盖 initialize/owner-follow、start-turn 原设置继承、流式状态、忙拒绝、过期 turn、停止终态、审批 accept/decline/过期与桌面已处理、同步与异步问题、未知审批禁用、协议版本不兼容、断线重连、revision 缺口 resnapshot、IPC 不可用、工具实参/异常不泄露、scope unfollow。
- `npm audit` 在本次安装完成时报告 0 vulnerabilities。fixture 测试不等于真实桌面兼容性测试。

## 真实同会话验收

专门创建的官方桌面会话：`TokenFree Connector 独立验收会话`。

Session ID：`01a115e3-585e-7d70-9265-a56da0770169`。

目录：`/Users/chenbudiu/Documents/Codex/2026-10-07/tokenfree-connector-acceptance`。

测试只授权此会话，没有向用户已有工作会话注入消息。测试会话通过官方桌面宿主创建；连接器产品本身没有创建替代会话的代码。

| 验收项目 | 实际证据 / 结论 |
| --- | --- |
| 本地 IPC | 初始化成功；订阅原 session ID 得到 v11 snapshot、owner、revision、真实 turns |
| 配对 UI | 便携应用打开系统 Chrome → alice 开发登录 → 输入短码 → 本机确认账号 → Keychain 保护凭据 → 单会话授权 → relay 在线 |
| 浏览器 → 原桌面 | Chrome 实际网页发送 `TF-BROWSER-20261007-A`，要求计算 137×29；原 session 出现 userMessage，真实回复 `TF-BROWSER-20261007-A = 3973` |
| 同一 turn | 浏览器与桌面宿主读取得到相同 turn `01a115f0-3bab-78a1-a20e-c42d5ed69864`，completed，原 provider/model 保持 `custom / gpt-6-astra` |
| 实时状态与终态 | 浏览器自动显示 active、inProgress、回复、idle/completed，没有输入回显代替回复 |
| 桌面 → 浏览器 | 通过官方桌面宿主对同一会话发送 B；浏览器自动显示 `TF-DESKTOP-20261007-B: 23 的平方是 529`，turn `01a115f1-ae1a-7613-8f4c-9aaf454a5e2f` completed |
| 停止真实任务 | 浏览器发 C（纯文本计数任务）再点击停止；同一 turn `01a115f3-279c-75e3-947b-3af53b6ac7cb` 变 interrupted，按钮禁用；桌面宿主独立确认 interrupted |
| 刷新恢复 | Chrome 刷新后自动恢复同一设备/session，读到 A/B 回复和 C interrupted 终态 |
| 停止连接/退出 | 连接器退出，属于本应用的 adapter 子进程退出；专用桌面 D 任务继续并 completed，未被连接器取消 |
| 补充信息 | 已触发真实异步问题，IPC 中有 `bridge/requestUserInputAsync`、精确 questionItemId，显示 supported=true；最终浏览器回答结果见下面补记 |
| 权限审批 | 命令/文件审批允许、拒绝、旧审批只通过可控端点测试；真实桌面本轮未触发权限审批，**不标记真实验收通过** |
| 官方 App 重启 | 可控端点重启/重连测试通过；没有重启用户正在工作的官方 App，**真实重启未验证** |
| 视觉核对限制 | 连接器和 Chrome 使用真实 UI 验收。环境禁止 computer-use 直接操作 `com.openai.codex`，桌面侧通过官方宿主 read_thread 核对用户消息/回复/turn/终态；未声称取得桌面窗口视觉截图 |

## 已知限制

1. 仅 macOS arm64、本机桌面 owner 已实测。Windows named pipe 是复用的传输代码，但平台探测/安装包/凭据路径/兼容性尚未实测；Linux、Intel macOS 未验证。
2. 内部 IPC 不是官方稳定接口。未知 snapshot 协议版本禁用写入；仅初始化连接成功不能代表所有能力兼容。版本清单不能泛化到所有 Codex 发行版。
3. 第一版不提供创建、分叉、编辑消息、模型设置、远程 SSH 会话或任意文件浏览。create=false/remoteHosts=false。请先在官方桌面创建并打开会话；无法找到 owner 明确提示，不创建替代会话。
4. 只提供有界最近历史窗口，非全量分页浏览器历史。超限/不完整状态有明确标记，完整历史在官方桌面。未激活会话不冒充实时在线。
5. 未支持的权限请求、MCP elicitation/身份验证/计划实现请求须在桌面处理，不自动通过。同步/异步问题都有实现，具体版本能力按实测区分。
6. relay 是开发 fixture：仅回环、alice/bob、内存绑定，重启丢失。尚无生产 TokenFreeChat 登录、部署、跨设备公网演示或 HA 路由。
7. 原 owner 的多端竞争不能靠本地锁做到跨进程原子化。连接器先取得 fresh 状态并拒绝忙发送，最终由 owner 验证；不确定窗口要求核对，不提供 exactly-once 的虚假承诺。
8. 当前为整机桌面授权，目录最多 5,000 条匹配元数据，超出明确报错；最多同时跟随 32 个会话，journal 10,000 操作。新桌面会话自动加入授权。范围更改对已发送到 owner 的操作无法撤回，若需取消用对应 turn 的停止操作。
9. 无正式 Developer ID 签名、公证、自动启动、自动更新。不要关闭系统整体安全保护。

## 后续路线

- 第一阶段：生产身份/设备归属接入、持久配对/撤销、TLS 域名、租户测试、真实审批矩阵、更多桌面版本兼容测试、完整历史分页。
- 第二阶段：Windows 进程发现/安装包/凭据存储、named pipe 实机验证；macOS Intel CI 与实机；同 session 竞争和重启长时间压力测试。
- 第三阶段：Developer ID/Windows 签名、公证、校验和/可信下载、可选自启动、签名更新通道、回滚与迁移。自启动和更新保持独立模块，不扩大 renderer 权限。
- 将来公开接口若能证明同一活跃 owner 语义，优先替换内部 IPC 适配器；不以独立 App Server resume 偷换产品定位。

## 最终构建补记

最终构建重新启动后没有初始化错误；relay 重启导致旧凭据失效时，桌面清楚显示“凭据已失效”，成功解绑、重新配对并只授权同一测试会话。最终浏览器使用带 streamId/cursor 的 sync 读回原会话状态。

异步问题回答已由 Chrome 的“提交补充信息”按钮真实发出，原会话收到带精确 questionItemId 的“蓝色”回答，并开始 turn `01a11602-fa1f-7b80-8975-89c8f66e85e3`。此处未另建 session。

补充信息后续轮次在原 owner 中出现上游 error 事件且迟迟未返回最终回答；没有修改 provider/凭据进行规避。已从浏览器停止该专用轮次并核对 `interrupted`。因此异步问题的展示、回答关联及同 session 继续执行已验证，但“选择后得到最终模型答案”本次未通过完整验收。

最后通过 Chrome 撤销开发设备，已有远程连接断开，设备从账号列表消失；没有留下运行中的验收任务。relay 仍仅监听本机，应用可重新配对演示。


## 整机授权更新（2026-10-07）

根据后续用户要求，首页保留一个连接按钮，移除逐会话选择。连接即授权此电脑全部现有及未来桌面会话；连接期间定期刷新目录，只有网页实际打开的会话才订阅内容。原有单会话实机验收是历史记录，不代表当前授权 UI。新增自动测试验证超过 32 条目录、新增/移除会话、稳定目录保留事件、按需订阅与解绑撤销。未将整机真实目录绑定到测试 relay 进行新的全量验收。

整机授权不等于所有桌面功能已实现。当前支持列出、读取、同步、发送、停止、已支持类型的审批和问题回答；创建/分叉会话、文件管理、桌面设置与 SSH 主机控制不在当前协议内。原会话执行权限与审批设置保持继承，整机授权不会自动批准命令。
