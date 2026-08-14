/**
 * Native Discord slash-command registration and handling: /help, /new, /status,
 * /clear. Commands share the SessionManager so they operate on the invoking
 * chat's agent exactly like plain messages.
 * @module dsh-discord-gateway/commands
 */

import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from 'discord.js'
import type { DiscordGatewayConfig } from './config.ts'
import type { SessionManager, ChatLocation } from './session.ts'

/** Location of the chat that invoked a slash command. */
export function interactionLocation(interaction: ChatInputCommandInteraction): ChatLocation {
  if (interaction.channel?.isDMBased()) {
    return { dmUserId: interaction.user.id }
  }
  const channel = interaction.channel
  if (channel?.isThread()) {
    return { guildId: channel.guildId, channelId: channel.parentId ?? channel.id, threadId: channel.id }
  }
  return { guildId: interaction.guildId ?? undefined, channelId: interaction.channelId }
}

/** Register guild-scoped slash commands on every guild the bot can see. */
export async function registerSlashCommands(
  client: Client,
  config: DiscordGatewayConfig,
  log: (line: string) => void,
): Promise<void> {
  void config
  const commands = [
    new SlashCommandBuilder().setName('help').setDescription('显示可用命令与当前会话状态'),
    new SlashCommandBuilder().setName('new').setDescription('开启全新会话（丢弃当前上下文）'),
    new SlashCommandBuilder().setName('clear').setDescription('同 /new：开启全新会话'),
    new SlashCommandBuilder().setName('status').setDescription('查看当前会话状态'),
  ]
  const payload = commands.map((c) => c.toJSON())
  // Guild-scoped registration keeps commands immediately available without
  // the global propagation delay, and fails gracefully per guild.
  let registered = 0
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set(payload)
      registered += 1
    } catch (error) {
      log(`slash commands failed on guild ${guild.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (registered > 0) log(`registered slash commands on ${registered} guild(s)`)
  else log('slash commands registered nowhere; plain-text fallback (/help, /new …) stays active')
}

/** Handle one chat-input interaction, delegating to the shared session manager. */
export async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  config: DiscordGatewayConfig,
  sessions: SessionManager,
  log: (line: string) => void,
): Promise<void> {
  void config
  const command = interaction.commandName
  const loc = interactionLocation(interaction)

  // Authorization: slash commands respect the same allowlists (fail-closed).
  const userId = interaction.user.id
  const memberRoles = interaction.member
    ? [...(interaction.member as { roles: { cache: Map<string, unknown> } }).roles.cache.keys()]
    : []
  const authorized = interaction.channel?.isDMBased()
    ? config.allowedUserIds?.includes(userId) === true || config.allowAllUsers === true
    : config.allowAllUsers === true
      || config.allowedUserIds?.includes(userId) === true
      || config.allowedRoleIds?.some((id) => memberRoles.includes(id)) === true
      || config.allowedChannelIds?.includes(interaction.channelId) === true
  if (!authorized) {
    await interaction.reply({ content: '⛔ 未授权：你的账号不在白名单中。', ephemeral: true }).catch(() => undefined)
    return
  }

  switch (command) {
    case 'help': {
      await interaction.reply({
        content: '🤖 dsh-discord-gateway 命令：\n/help — 帮助\n/new — 开启新会话\n/status — 会话状态\n/clear — 同 /new\n频道里 @bot 发送消息即可驱动 agent；长回复自动分片。',
        ephemeral: true,
      }).catch(() => undefined)
      break
    }
    case 'new':
    case 'clear': {
      await sessions.dispose(loc)
      await interaction.reply({ content: '✅ 已开启新会话。', ephemeral: true }).catch(() => undefined)
      break
    }
    case 'status': {
      const agent = sessions.get(loc)
      await interaction.reply({
        content: agent
          ? `📡 会话状态：**${agent.status}**\n会话 id：\`${agent.id}\`\n活跃会话总数：${sessions.size}`
          : `📡 当前没有活跃会话（共 ${sessions.size} 个）。发一条消息即可创建。`,
        ephemeral: true,
      }).catch(() => undefined)
      break
    }
    default: {
      await interaction.reply({ content: `未知命令 /${command}`, ephemeral: true }).catch(() => undefined)
      log(`unknown slash command: ${command}`)
    }
  }
}
