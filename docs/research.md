# 调研记录（2026-10-07，Asia/Shanghai）

## 参考项目

来源：https://github.com/try2love/codex-mobile-bridge

固定 commit：`560fc434c248882f206a6ee16a20b5a824533080`。许可证 MIT，Copyright 2026 try2love。复制的 `ipc.py`、`transport.py`、`model.py` 保持原样，许可证和来源随应用分发。没有复制其账户切换、隧道、HTTP 网关或全局配置修改功能。

实际检查的源码与测试：

| 文件 | 得到的协议事实 | 本项目处理 |
| --- | --- | --- |
| `bridge/ipc.py` | LE uint32 长度前缀 JSON；initialize v0；请求含 source/targetClientId、requestId、timeoutMs；client-discovery-request 必须回应 canHandle:false | 直接复用，独立 Python 进程封装 |
| `bridge/transport.py` | Unix `~/.codex/ipc/ipc.sock`；Windows named pipe `\\.\pipe\codex-ipc` | 复用传输实现，Windows 不标已验证 |
| `bridge/service.py` 的 `_attach/_event/_dispatch/respond/interrupt` | follow 广播可以发现后台 owner；`thread-stream-state-changed` v11，snapshot + 带 baseRevision 的 patches；start-turn v2 与 inheritThreadSettings；interrupt v4 + expectedTurnId | 新适配器用同一 owner 发操作，revision 缺口重新订阅快照 |
| `bridge/model.py` | canonical turnHistory/entitiesByKey 的排序、状态规范化、pending requests、异步问题精确 questionItemId | 直接复用补丁与规范化，不复制整套网关 |
| `bridge/store.py` | SQLite 只读元数据发现、桌面 originator 过滤和排除 subagent | 本项目仅实现元数据查询，不读取 rollout 文件作为实时能力替代 |
| `bridge/create.py` | 参考实现先用短生命周期 App Server 创建空线程，再退出并由桌面接管；不会在该临时服务 turn/start | 第一版不采用此路径，create capability=false；用户在官方桌面创建会话 |
| `tests/test_bridge.py` | owner 路由、同线程幂等、revision 缺口、旧审批、异步问题 steer、停止、原 provider 保持等端点 fixture | 针对本项目约束重新建立可控 IPC 端点测试；不把 mock 当真实兼容性证明 |
| `tests/test_message_actions.py` | 变更原消息与分叉需要额外原生协议与新鲜状态判断 | 第一版禁用编辑、分叉、模型设置等额外能力 |

复用成本：核心 IPC/状态模块只依赖 Python 标准库。完整 upstream service 与账户、上传、远程主机、目标管理等交织，直接复用整个 service 会引入超出本产品的能力。故复用三个协议模块，加受限业务 wrapper；Electron 负责桌面与网络，PyInstaller 带 Python。没有为了统一语言重写 IPC。

## 官方文档核对

实际获取并检查：

- https://developers.openai.com/codex/app-server/
- https://developers.openai.com/codex/app/features/

App Server 文档描述了 initialize、thread/start、thread/resume、thread/read、turn/start，及 stdio、WebSocket 和 Unix control socket 等传输；其中 thread/resume 表示在相应 App Server 继续已存储线程。这一事实**不足以证明该独立服务与正在运行的桌面 owner 实时共享执行状态**。

本次未找到足以保证第三方通过公开稳定接口连接当前桌面同一活跃 owner、同步双端审批与执行的文档契约。因此采用经过本机验证的内部 IPC，且不将“官方没有任何可能接口”作为绝对结论。未来应继续核对公开 control socket/remote 能力能否满足同一 owner 的语义，再替换适配器。

## 本机发现

本机应用实际路径 `/Applications/ChatGPT.app`；`CFBundleShortVersionString=26.930.51102`，`CFBundleVersion=13100`。不能只假设 `/Applications/Codex.app`。

真实 socket 的 initialize 成功，专用会话 follow 得到 v11 snapshot；对该会话的浏览器写入得到桌面真实 turn 和回复。没有探测其他用户工作会话的内容或向其发消息；本地授权列表读取了元数据但没有对外公开全部历史。
