# pi-wecom-envoy

本地网关：把企业微信"智能机器人"的长连接消息，转发给内嵌的 [pi](https://pi.dev) coding agent，并把回复（支持流式）发回企微。

单 Node 进程；不需要启动 `pi --mode rpc` 子进程；用户已经装好的 `~/.pi/agent/*`（settings、auth、AGENTS.md、skills、extensions）全部复用。

## 架构

```
┌─────────────────────────────────────────┐
│ 企微智能机器人长连接 SDK（占位，需替换）  │
└──────────────┬──────────────────────────┘
               │ onMessage(msg)
               ▼
┌─────────────────────────────────────────┐
│ Envoy (src/index.ts)                    │
│  ├─ SessionRegistry                     │
│  │   key = (chatType, chatId, userId)   │
│  │   cwd  = workspace/<subdir>/         │
│  ├─ ModelRuntime ← ~/.pi/agent/auth.json│
│  └─ AgentSession（createAgentSession）  │
│     session.subscribe → 流式 text_delta │
│     → wecom.reply() 实时回写             │
└─────────────────────────────────────────┘
```

## 安装

```bash
pnpm install
# 复制并修改配置
cp config.yaml config.local.yaml
# 在 config.local.yaml 里填 botId / secret
```

## 配置

`config.yaml` 关键字段：

| 字段 | 说明 |
|---|---|
| `wecom.botId` `wecom.secret` | 企微管理后台 → 智能机器人 → 详情 |
| `wecom.endpoint` | 长连接入口，按官方 SDK 默认值 |
| `pi.workspaceRoot` | pi 工作区根目录；每个 chat/user 在此建子目录 |
| `pi.perChatWorkspace` | 是否按会话隔离子目录（推荐 `true`） |
| `pi.provider` / `pi.model` | 留空 = 用 `~/.pi/agent/settings.json` 的默认；填了则强制指定 |
| `pi.thinkingLevel` | `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` |
| `pi.agentDir` | 留空 = 用 `~/.pi/agent`；可指向自定义目录 |
| `pi.tools` / `pi.excludeTools` | 工具白/黑名单，留空 = SDK 默认 |
| `runtime.streamingReply` | 是否每收到 `text_delta` 就调一次 `reply` |
| `runtime.streamingMinIntervalMs` | 流式回写最小间隔，避免触发企微频率限制 |
| `runtime.maxReplyChars` | 单条消息字符上限（企微单条 ~4096 字节） |

**已装好的 pi 配置完全复用**：不需要重新 `/login`、不需要重设 `ANTHROPIC_API_KEY`。`ModelRuntime.create()` 不传参时自动读 `~/.pi/agent/settings.json` 和 `auth.json`。

## 接入企微 SDK（必做，一次性）

`src/wecom/client.ts` 当前是占位实现（启动会 throw）。真实接入步骤：

1. 装包（包名以企业微信开发者中心官方文档为准）：
   ```bash
   pnpm add @wecom/aibot-rpc-sdk   # 或官方给出的实际包名
   ```
2. 打开 `src/wecom/client.ts`，按 SDK 的 `*.d.ts` 替换 `createWecomClient()`：
   - import 的 Client 类
   - 构造参数（`botId` / `secret` / `endpoint` 等）
   - "message" 事件 payload 字段 → 映射成 `WecomIncomingMessage`
   - `reply()` / `send()` 方法名与入参
3. 跑 `pnpm typecheck`，**应只剩这一个文件的类型错误**。修完即可启动。

## 启动

```bash
ENVOY_CONFIG=config.local.yaml pnpm dev   # tsx watch，热重载
ENVOY_CONFIG=config.local.yaml pnpm start # 单次运行
```

## Session 隔离策略

| 场景 | 隔离 key | 工作区子目录 |
|---|---|---|
| 单聊 | `s:<userId>` | `workspace/single-<userId>/` |
| 群聊 | `g:<chatId>` | `workspace/group-<chatId>/` |

群聊内多人的消息**共享同一个 pi session**（因为他们是一个上下文）。如果你想按发言人再细分，改 `sessionKey()`。

每个子目录里都能放自己的 `AGENTS.md`、`.pi/settings.json`、`skills/`，pi SDK 会自动加载——意味着**每个群可以有自己的"人格/约定"**，放进子目录的 `AGENTS.md` 即可。

## 流式回写

- 监听 `session.subscribe` 的 `message_update.text_delta`，按 `streamingMinIntervalMs` 节流后调 `wecom.reply()`
- 最终回复保证发一次（即流式没赶上也会补发）
- 企微 `reply_message` 必须在收到消息后 N 秒内调用；超时未发的部分会走 `send_message`（TODO：当前实现只 reply，不主动降级；如果你看到 "消息超时" 报错，请扩展 `runPrompt` 在 settled 后判断 `reply` 时效）

## 已知限制 / TODO

- [ ] `src/wecom/client.ts` 是占位，未接真实 SDK
- [ ] reply 超时降级到 `send_message`（企微被动回复 5 分钟时效）
- [ ] 图片/文件/卡片消息类型（当前只处理 text）
- [ ] `AgentSession` 错误重试 / 上下文超限自动 compact 后的提示
- [ ] LRU 淘汰当前只 dispose，未保留 session 文件（已自动落盘，重新 acquire 仍可继续）

## 文件结构

```
src/
├── index.ts          # 入口：装配 + 事件循环
├── config.ts         # YAML 配置加载与校验
├── log.ts            # 极简日志
├── pi/               # （空；后续如需自定义 ResourceLoader / Tool 放这里）
├── session/
│   └── manager.ts    # (chatType, chatId, userId) → AgentSession
└── wecom/
    ├── client.ts     # ★ 占位，需替换为真实 SDK
    └── types.ts
workspace/            # pi 工作区根；每个会话一个子目录
config.yaml           # 配置模板
```