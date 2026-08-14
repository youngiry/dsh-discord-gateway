/**
 * dsh-discord-gateway — Discord gateway for DeepSeek Harness.
 *
 * Server-side dsh bundle that composes directly over dsh-base (like
 * dsh-headless, but a long-lived daemon instead of a one-shot runner). It opens
 * a Discord bot, maps each channel/thread/DM to one persistent agent session,
 * forwards user messages with `agent.followup()`, and streams assistant output
 * back through typing indicators, progressive edits and code-block-aware
 * chunking (the Hermes Agent gateway pattern).
 *
 * @module dsh-discord-gateway
 */

import { randomUUID } from 'node:crypto'
import { Client, Events, GatewayIntentBits, type Message } from 'discord.js'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { DiscordGatewayConfigSchema, resolveConfig, type DiscordGatewayConfig } from './config.ts'
import { SessionManager, type ChatLocation } from './session.ts'
import { OutboundManager, asSendable, type SendableChannel } from './outbound.ts'
import { registerSlashCommands, handleInteraction } from './commands.ts'

export const name = 'discord-gateway'
/** Core services required before the gateway can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

export const Config = DiscordGatewayConfigSchema

// Pure helpers re-exported for tests and downstream consumers.
export { splitText, DISCORD_MAX_LENGTH } from './outbound.ts'
export { sessionKey, sessionIdFor } from './session.ts'

/** One turn in flight for a chat: the agent and its outbound key. */
interface TurnRecord {
  loc: ChatLocation
  outKey: string
}

export function apply(ctx: Context, rawConfig: Partial<DiscordGatewayConfig>): void {
  const config = resolveConfig(rawConfig)
  if (!config.token) {
    throw new Error('discord-gateway: DISCORD_BOT_TOKEN is required (set the env var or the plugin token config)')
  }

  // Log to stderr directly (dsh-base mounts no console exporter; the headless
  // runner's streams are the precedent) and mirror to ctx.logger when present.
  const log = (line: string) => {
    process.stderr.write(`[discord-gateway] ${line}\n`)
    ctx.logger?.('discord-gateway').info(line)
  }
  const sessions = new SessionManager(ctx, config, log)
  const outbound = new OutboundManager(log)

  // Map sessionId → the turn that owns it, so session/event can route output
  // back to the originating Discord chat.
  const turns = new Map<string, TurnRecord>()

  // ── Discord client ────────────────────────────────────────────────────────

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  /** Location of the chat a message arrived in (carries the actor for
   *  per-user guild sessions, matching Hermes' group_sessions_per_user). */
  function locationOf(message: Message): ChatLocation {
    if (message.channel.isDMBased()) {
      return { dmUserId: message.author.id }
    }
    const channel = message.channel
    if (channel.isThread()) {
      return {
        guildId: channel.guildId,
        channelId: channel.parentId ?? channel.id,
        threadId: channel.id,
        userId: message.author.id,
      }
    }
    return {
      guildId: channel.guildId,
      channelId: channel.id,
      userId: message.author.id,
    }
  }

  /** Authorization gate (fail-closed). */
  function authorized(loc: ChatLocation, message: Message): boolean {
    if (config.allowAllUsers) return true
    if (config.allowedUserIds?.includes(message.author.id)) return true
    if (loc.dmUserId) return config.allowedUserIds?.includes(loc.dmUserId) === true
    // Guild message: check roles, then channels.
    if (!message.member) return false
    const memberRoles = [...message.member.roles.cache.keys()]
    if (config.allowedRoleIds?.some((id) => memberRoles.includes(id))) return true
    if (config.allowedChannelIds?.includes(message.channelId)) return true
    if (loc.channelId && config.allowedChannelIds?.includes(loc.channelId)) return true
    return false
  }

  /** Whether a guild-channel message is a trigger (mention or DM). */
  function isTrigger(message: Message, loc: ChatLocation): boolean {
    if (loc.dmUserId) return true
    if (!config.requireMention) return true
    return message.mentions.has(client.user!.id)
  }

  /** Build the reply channel: auto-thread for guild messages when configured. */
  async function resolveReplyChannel(message: Message, loc: ChatLocation): Promise<SendableChannel> {
    if (!loc.dmUserId && config.autoThread && !message.channel.isThread()) {
      try {
        const threadName = message.content.replace(/<@!?\d+>/g, '').trim().slice(0, 50) || 'dsh-agent'
        const thread = await message.startThread({ name: threadName })
        return asSendable(thread) ?? asSendable(message.channel)!
      } catch {
        // No permission or thread creation failed: reply in the channel.
        return asSendable(message.channel)!
      }
    }
    return asSendable(message.channel)!
  }

  /** Route one assistant-streaming event back to its Discord chat. */
  function handleSessionEvent(session: Session, event: SessionEvent): void {
    const turn = turns.get(session.id)
    if (!turn) return
    void (async () => {
      const channel = await resolveChannelFor(turn)
      if (!channel) return
      switch (event.type) {
        case 'assistant/chunk': {
          const chunk = (event.data as { chunk: StreamChunk }).chunk
          if (chunk.type === 'text-delta' && chunk.text) {
            outbound.streamText(turn.outKey, channel, chunk.text)
          }
          break
        }
        case 'assistant/message': {
          const message = (event.data as { message: { content: Array<{ type: string; text?: string }> } }).message
          const text = message.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('')
          if (text) {
            outbound.streamText(turn.outKey, channel, `\n${text}`)
          }
          break
        }
        case 'turn/end': {
          const reason = (event.data as { reason: { kind: string } }).reason
          if (reason.kind === 'error') {
            const err = (event.data as { reason: { error?: { message?: string; code?: string } } }).reason.error
            await outbound.failTurn(turn.outKey, channel, err?.message ?? err?.code ?? 'agent turn failed')
          } else if (reason.kind === 'completed') {
            const finalText = await sessionText(session)
            await outbound.finishTurn(turn.outKey, channel, finalText)
          } else {
            await outbound.finishTurn(turn.outKey, channel, await sessionText(session))
          }
          turns.delete(session.id)
          break
        }
      }
    })()
  }

  // Resolve a live channel for a turn record.
  async function resolveChannelFor(turn: TurnRecord): Promise<SendableChannel | null> {
    const targetId = turn.loc.threadId ?? turn.loc.channelId
    if (!targetId) return null
    try {
      const channel = await client.channels.fetch(targetId)
      if (!channel || !channel.isTextBased()) return null
      return asSendable(channel)
    } catch {
      return null
    }
  }

  // Aggregate the last assistant text in a session log (headless summarize).
  async function sessionText(session: Session): Promise<string> {
    const events = session.events
    let text = ''
    let started = false
    for (const event of events) {
      if (event.type === 'turn/start') started = true
      if (!started) continue
      if (event.type === 'assistant/message') {
        const message = (event.data as { message: { content: Array<{ type: string; text?: string }> } }).message
        const joined = message.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('')
        if (joined !== '') text = joined
      }
    }
    return text
  }

  /** Strip @mentions and trailing whitespace from a trigger message (Hermes
   *  strips the bot mention before feeding the agent; same for role/user
   *  mentions that are Discord syntax noise, not task content). */
  function stripMentions(text: string): string {
    return text.replace(/<@!?&?\d+>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  /** Drive one user message through the chat's agent. */
  async function handleUserMessage(message: Message): Promise<void> {
    const loc = locationOf(message)
    if (!authorized(loc, message)) {
      await message.reply('⛔ 未授权：你的账号不在白名单中。').catch(() => undefined)
      return
    }
    const channel = await resolveReplyChannel(message, loc)
    const outKey = `${channel.id}:${randomUUID()}`
    const prompt = stripMentions(message.content)
    if (prompt === '') return
    try {
      const agent = await sessions.getOrCreate({ ...loc, threadId: channel.isThread() ? channel.id : loc.threadId })
      turns.set(agent.session.id, { loc: { ...loc, channelId: channel.id, threadId: channel.isThread() ? channel.id : undefined }, outKey })
      outbound.startTurn(outKey, channel)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'dsh-discord-gateway', form: 'relay' },
      }))
    } catch (error) {
      await outbound.failTurn(outKey, channel, error instanceof Error ? error.message : String(error))
    }
  }

  // ── client wiring ─────────────────────────────────────────────────────────

  client.on(Events.ClientReady, async (readyClient) => {
    log(`logged in as ${readyClient.user.tag}`)
    await registerSlashCommands(readyClient, config, log).catch((error) => {
      log(`slash command registration failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return
    const loc = locationOf(message)
    if (!isTrigger(message, loc)) return
    // Slash-style text commands in plain chat (fallback when registration fails).
    const text = message.content.trim()
    if (text.startsWith('/') || text.startsWith('!')) {
      void handlePlainCommand(message, text, config, sessions, log).catch(() => undefined)
      return
    }
    void handleUserMessage(message).catch((error) => {
      log(`message handling failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return
    void handleInteraction(interaction, config, sessions, log).catch((error) => {
      log(`interaction failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  client.on(Events.Error, (error) => {
    log(`discord client error: ${error.message}`)
  })

  // ── lifecycle ─────────────────────────────────────────────────────────────

  ctx.effect(() => {
    // Session/event subscription: route assistant output to the originating chat.
    const disposer = ctx.on('session/event', (session, event) => {
      handleSessionEvent(session, event)
    }, { global: true })

    const exit = ctx.get('appExit')
    void client.login(config.token).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      log(`login failed: ${message}`)
      // Fail loud like the headless runner: a gateway that cannot reach Discord
      // is misconfigured, not "waiting". Request process exit via the launcher
      // when available, otherwise exit directly.
      if (exit) exit(1)
      else process.exitCode = 1
    })

    return () => {
      disposer()
      outbound.dispose()
      void client.destroy()
      void sessions.disposeAll()
    }
  }, 'discord-gateway: lifecycle')
}

/** Minimal plain-text command fallback (works even without slash registration). */
async function handlePlainCommand(
  message: Message,
  text: string,
  config: DiscordGatewayConfig,
  sessions: SessionManager,
  log: (line: string) => void,
): Promise<void> {
  const loc = message.channel.isDMBased()
    ? { dmUserId: message.author.id }
    : { guildId: message.guildId ?? undefined, channelId: message.channelId, threadId: message.channel.isThread() ? message.channelId : undefined, userId: message.author.id }
  const command = text.replace(/^[!/]/, '').split(/\s+/)[0]?.toLowerCase()
  switch (command) {
    case 'help': {
      await message.reply('🤖 dsh-discord-gateway 命令：\n/help — 帮助\n/new — 开启新会话\n/status — 会话状态\n/clear — 同 /new\n普通文本 @bot 直接发送给 agent。').catch(() => undefined)
      break
    }
    case 'new':
    case 'clear': {
      await sessions.dispose(loc)
      await message.reply('✅ 已开启新会话。').catch(() => undefined)
      break
    }
    case 'status': {
      const agent = sessions.get(loc)
      await message.reply(agent
        ? `📡 会话状态：**${agent.status}**\n会话 id：\`${agent.id}\``
        : '📡 当前没有活跃会话，发一条消息即可创建。').catch(() => undefined)
      break
    }
    default:
      await message.reply(`未知命令 \`${text}\`，试试 /help`).catch(() => undefined)
  }
}
