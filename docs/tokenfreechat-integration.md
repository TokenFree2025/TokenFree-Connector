# TokenFreeChat 集成

连接器现在默认直接连接 TokenFreeChat（本机 `http://127.0.0.1:3080`），不依赖独立测试 relay。

## 连接流程

- 桌面向 `/api/desktop/pair/start` 请求 5 分钟有效的一次性配对码及仅本机持有的 secret。
- 系统浏览器打开 `/desktop?pair=<id>`，使用 Chat 原有登录。网页通过受 JWT 保护的 `/api/desktop/pair/claim` 将配对绑定到当前用户与租户。
- 桌面轮询认领状态，显示真实账号，在本机确认后请求 `/api/desktop/pair/confirm` 换取设备令牌。
- Chat 的 MongoDB 保存哈希后的 secret、code、token 和用户/租户归属；配对确认原子消费，原始令牌保存在桌面系统加密凭据存储中。
- `/api/desktop/device/exchange` 用设备 Bearer 令牌交换状态、原会话范围、请求和响应。连接器约每秒交换一次，网页约每 3 秒读取原会话快照。
- Chat 的 `/api/desktop/devices`、`operation`、`revoke` 使用现有 `requireJwtAuth`，每次核验用户、租户、设备和会话归属。

## 启用

Chat 的 `librechat.yaml`：

```yaml
desktopConnector:
  enabled: true
```

默认关闭；本机配置已开启。更新 Chat 后需重新构建包与前端，并重启后端。连接器开发运行 `npm start`；新安装可以通过 `TF_CHAT_URL` 指定 HTTPS Chat 地址。

Chat 页面位于 `/desktop`，侧边栏有 Desktop connections 入口。设备与会话选择保存在浏览器当前标签页，刷新后重新读取桌面原会话。写操作超时不会自动重试；未确认操作会提示先核对原会话。

## 数据与边界

- 绑定保存在 MongoDB，服务重启不会丢失。配对 5 次错误后锁定，配对过期后自动清理。
- 聊天快照仅在请求转发中使用，状态/会话目录仅保存在当前 Chat 进程内存，不创建替代 LibreChat 对话。
- 桌面操作仍经过原 ConnectorCore 的授权、持久化操作去重和 IPC 校验。浏览器关闭不取消桌面任务。
- 当前支持单个 Chat API 进程。多实例部署需增加共享连接路由/租约后再启用；不会把它宣称为已完成多实例生产 relay。
- 服务重启或网络故障可能使已派发操作的结果不确定，必须检查原会话。消息不会在新连接上自动重复派发。
- 独立的 `npm run relay`、alice/bob 页面和 WebSocket 协议仍只供开发测试，默认桌面连接不再走这条路径。
- 目前未部署公网域名、证书或发布应用。HTTP 仅允许本机回环地址，远程地址要求 HTTPS。
