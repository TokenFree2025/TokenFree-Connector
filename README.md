# TokenFree Connector

用户可安装的桌面连接器，把**正在运行的官方 Codex 桌面 App 的同一会话**连接到浏览器。任务继续使用桌面会话的 owner、模型配置、执行目录与权限。此仓库包含 Electron 桌面应用、复用的 Python IPC 适配核心、TokenFreeChat HTTP 连接、独立开发 relay 和测试网页。

**当前为 macOS Apple Silicon 开发预览。已对接本地 TokenFreeChat 的真实登录与数据库，尚未部署公网生产服务。** 本机验证版本为 Codex `26.930.51102 (13100)`，实际安装路径是 `/Applications/ChatGPT.app`。其他桌面版本和 Windows 尚未认证。

## 直接打开桌面应用

构建产物：

```text
release/TokenFree Connector-darwin-arm64/TokenFree Connector.app
```

便携压缩包为 `release/TokenFree-Connector-0.1.0-mac-arm64.zip`，校验和在 `release/SHA256SUMS.txt`。这些产物仅在本地生成，未发布。

双击打开，或从仓库目录执行：

```sh
open "release/TokenFree Connector-darwin-arm64/TokenFree Connector.app"
```

应用已内置 Electron、Node 与冻结的 Python 运行时；**终端不是用户日常界面，普通用户不需要另装 Python**。目前是本地便携 `.app`，无 Developer ID 签名或 Apple 公证。不要关闭系统整体安全保护；正式分发前应完成签名、公证与可信下载渠道。开发者可在本机构建运行。

## 连接 TokenFreeChat

1. 启动 `../tokenfreeChat`，在它的 `librechat.yaml` 中设置 `desktopConnector.enabled: true`。当前本机配置已开启，Chat 默认地址为 `http://127.0.0.1:3080`。
2. 打开官方 Codex 桌面 App，再打开 TokenFree Connector（开发启动为 `npm start`）。
3. 点击 **连接 TokenFreeChat**。浏览器打开 Chat 的 `/desktop?pair=…` 页面；未登录时使用 Chat 原有的 TokenFree 登录。
4. 在网页输入连接器显示的 8 位码，确认绑定当前真实账号，再回到连接器点击 **确认账号并连接**。
5. Chat 侧边栏的 **Desktop connections** 页面会显示你的设备。选择设备和原会话，即可读取消息、发送消息、停止任务及处理支持的审批/问题。
6. 断开连接或退出连接器不会取消桌面任务。Chat 页面可撤销设备；已撤销凭据在下一次请求时失效。Chat 服务重启保留数据库中的绑定，连接器自动重连。

连接器默认不再依赖 `npm run relay`，不再显示 alice/bob 测试身份。旧默认开发 relay 的设置会迁移到本机 Chat 地址，旧测试凭据会清除，需要用真实账号重新配对。自定义旧 relay 配置不会被自动迁移。

首次运行时可用 `TF_CHAT_URL=https://你的Chat域名 npm start` 指定 Chat 地址。正式部署应使用 HTTPS。连接器只发起出站 HTTPS 请求，不要求电脑开放端口。当前 Chat relay 是单 API 进程实现，尚不支持多副本请求路由；完整部署边界见 [Chat 集成说明](docs/tokenfreechat-integration.md)。

首次连接会授权当前账号访问这台电脑现有及后续新增的本地 Codex 会话，不需要逐个勾选。聊天内容经过 Chat 服务中转，Codex 登录凭据保留在本机。

## 开发与构建

```sh
npm ci
npm run check       # TypeScript、ESLint、Node 与 Python 协议测试
npm start           # 开发桌面窗口
npm run relay       # 开发 relay 和网页
npm run package     # 编译 TS + 冻结 Python + 生成当前平台便携应用
```

开发构建需要 Node 24、Python 3.9+ 和平台编译/签名工具。构建脚本在 `.local/build-venv` 安装固定版本 PyInstaller，产物带运行时，不要求最终用户安装开发依赖。`npm run test:real` 只进行只读探测，要求显式指定专用测试会话 ID；不会创建会话或自动发送消息。

```sh
TF_TEST_SESSION_ID=<专用桌面会话ID> npm run test:real
```

WSS 开发测试可通过 `TF_TLS_CERT`、`TF_TLS_KEY` 指定受信任证书/私钥；不要禁用证书验证。默认测试套件使用临时 CA/证书验证 WSS 传输，同时确认不受信任证书被拒绝。

## 实现边界

- 无独立 Codex CLI / App Server 执行进程，没有新建替代会话的路径。
- 本地 SQLite **只读会话元数据**，用于自动发现本机桌面会话。执行状态、历史窗口、回复、审批来自活跃 owner 的 IPC 快照/补丁。
- 不读取/上传 Codex 认证文件，不修改 Codex 配置、数据库、模型 provider、沙箱或审批策略。
- 发送继承原会话设置。会话忙时拒绝普通发送，不隐式排队；异步问题回答使用桌面既有的 steer/reply 协议。
- 写入前持久化操作摘要；重试相同 operation ID 不重复执行。写入后超时/断线标为不确定，必须核对原会话，不自动补发。
- 停止携带 `expectedTurnId`；审批在发送前重新读取 pending requests。未知审批要求回到桌面处理，绝不自动通过。
- IPC 是内部接口，协议变化时明确禁用写入。查看 [兼容性和验收记录](docs/verification.md)。
- relay 可读取经它中转的聊天内容。TLS **不是端到端加密**。开发 relay 不将聊天落盘。

## 文档

- [架构及安全边界](docs/architecture-security.md)
- [协议 v1](docs/protocol-v1.md)
- [参考源码与官方文档研究](docs/research.md)
- [验证结果、已知限制和路线图](docs/verification.md)
- [TokenFreeChat 对接清单](docs/tokenfreechat-integration.md)
- [第三方来源与许可证](vendor/NOTICE.md)
