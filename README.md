# dsh-discord-gateway

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 coding agent 接进 **Discord** 频道，充当 bot。规格对齐 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的 gateway 体验：@bot 触发、每频道持久会话、自动建 thread、DM 隔离、原生斜杠命令、渐进流式编辑、角色鉴权。

标准 `dsh.bundle` 插件，独立 profile 常驻运行（`dsh --profile discord`），不需要 Web GUI。

## 功能

| 能力 | 说明 |
|---|---|
| @bot 触发 | 频道内 `@bot` 提及触发；DM 中全部消息触发 |
| 每频道持久会话 | 每个 channel / thread / DM 一个独立 agent 会话，跨进程重启自动恢复（`session-persistence-jsonl`） |
| 自动建 thread | 频道内触发时自动在消息下建 thread，回复发进 thread（可关） |
| DM / 群组隔离 | DM 每人独立会话；群聊频道共享、thread 单独隔离 |
| 原生斜杠命令 | `/help` `/new` `/status` `/clear`，无权限注册时自动降级为文本命令 |
| 渐进流式编辑 | 打字指示器 + 流式增量编辑回复，最终代码块感知分片（`（i/n）` 序号） |
| 鉴权 | fail-closed：token 必配；频道 / 角色 / 用户 allowlist，默认拒绝一切 |
| 完整工具面 | 直接叠 `dsh-base`，agent 拥有 bash / fs / web / subagent 等全部工具 |

## 架构

```
Discord Gateway WS + REST (discord.js)
   │  入站: messageCreate / interactionCreate
   ▼
 discord-gateway 插件
   │  触发判定 → 鉴权(fail-closed) → 会话路由 → 命令
   │  ctx.agents.create/resume · agent.followup · whenIdle
   ▼
 DSH core (dsh-base): session-persistence-jsonl · 完整工具面
```

消息流：`messageCreate` → @bot/DM 判定 → 鉴权 → 会话键 `discord:<guild>:<channel>[:thread]` / `discord:dm:<user>` → `agents.resume`（优先恢复持久会话）/ `agents.create` → `agent.followup(userMessage)` → 订阅 `session/event` 把 `assistant/chunk`、`assistant/message`、`turn/end` 流式回写 Discord。

## 安装

前置：Node ≥ 22，pnpm，已安装 dsh。

### 1. 初始化 discord profile

```bash
dsh plugin --profile discord add /path/to/dsh-discord-gateway
```

这会初始化 profile（bundles = `dsh-base` + `dsh-discord-gateway`）并把插件 link 进去。

### 2. 配置（环境变量或 profile patch）

必配 `DISCORD_BOT_TOKEN`；其余按需：

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `DISCORD_BOT_TOKEN` | 必配 | bot token（[Discord Developer Portal](https://discord.com/developers/applications) 创建，勾选 Message Content Intent） |
| `DISCORD_ALLOWED_CHANNEL_IDS` | 空 = 全拒 | 允许的频道/thread id（逗号分隔） |
| `DISCORD_ALLOWED_ROLE_IDS` | 空 = 全拒 | 允许的角色 id（成员命中任一即放行） |
| `DISCORD_ALLOWED_USER_IDS` | 空 = 全拒 | 允许的用户 id |
| `DISCORD_ALLOW_ALL` | `false` | 测试用，全部放行（会打印警告） |
| `DISCORD_REQUIRE_MENTION` | `true` | 频道内必须 @bot；DM 恒触发 |
| `DISCORD_AUTO_THREAD` | `true` | 频道触发时自动建 thread |

也可以写在 `~/.dsh/profiles/discord/cordis.patch.yml` 覆盖（例如换模型 / 指定工作目录）：

```yaml
- id: discord-gateway
  config:
    token: !!js process.env.DISCORD_BOT_TOKEN
    cwd: !!js process.cwd()
    provider: deepseek-official
    model: deepseek-v4-flash
```

### 3. 启动

```bash
DISCORD_BOT_TOKEN=xxx DISCORD_ALLOWED_ROLE_IDS=111,222 dsh --profile discord
```

## 使用

- 频道里 `@bot 帮我看看这个仓库的 README` → 自动建 thread，agent 回复进 thread，后续消息继续同一会话
- DM bot → 每人独立会话
- `/new` 或 `/clear` → 丢弃当前上下文开新会话；`/status` → 查看会话状态；`/help` → 帮助

## 开发

```bash
cd packages/dsh-discord-gateway
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm run build       # tsdown → lib/
node --test tests/   # 单元测试（分片、会话键）
```

冒烟验证：

```bash
dsh --profile discord --dump-config          # 检查组装
DISCORD_BOT_TOKEN=fake dsh --profile discord # 应报 invalid token 并以退出码 1 退出
```

## License

MIT。设计借鉴声明见 [NOTICE.md](NOTICE.md)（Hermes Agent 的 gateway 模式，MIT）。
