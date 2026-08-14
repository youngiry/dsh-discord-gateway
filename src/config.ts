/**
 * Plugin config schema (schemastery) and environment-variable merging.
 * The bundle patch fills `token`/`cwd` from process env; every allowlist key
 * falls back to its dedicated environment variable when absent from config.
 * @module dsh-discord-gateway/config
 */

import z from '@deepseek-ai/schemastery'

/** Comma-separated env list → trimmed string array. */
function envList(name: string): string[] | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

export interface DiscordGatewayConfig {
  /** Bot token. Required; missing token fails loud at apply. */
  token: string
  /** Working directory for agent sessions. */
  cwd?: string
  /** Provider route for created agents; defaults to the agent default selection. */
  provider?: string
  /** Model id for created agents; defaults to the agent default selection. */
  model?: string
  /** Allowed channel/thread ids (fail-closed: empty = deny all when allowAllUsers is false). */
  allowedChannelIds?: string[]
  /** Allowed role ids; a member holding any listed role passes. */
  allowedRoleIds?: string[]
  /** Allowed user ids; a member whose id is listed passes. */
  allowedUserIds?: string[]
  /** Test-only: allow every user (logs a warning). */
  allowAllUsers?: boolean
  /** Channel messages require an @bot mention to trigger; DMs always trigger. */
  requireMention?: boolean
  /** Auto-create a thread under a guild channel message that triggers the bot. */
  autoThread?: boolean
  /** Guild channels: one session per user (Hermes default) vs channel-shared. */
  groupSessionsPerUser?: boolean
  /** Merge timeout (seconds) for multi-part mobile input (`..` continuation). */
  mergeTimeoutSecs?: number
}

export const DiscordGatewayConfigSchema = z.object({
  token: z.string().required(),
  cwd: z.string(),
  provider: z.string(),
  model: z.string(),
  allowedChannelIds: z.array(z.string()),
  allowedRoleIds: z.array(z.string()),
  allowedUserIds: z.array(z.string()),
  allowAllUsers: z.boolean(),
  requireMention: z.boolean(),
  autoThread: z.boolean(),
  groupSessionsPerUser: z.boolean(),
  mergeTimeoutSecs: z.number(),
})

/** Merge raw config with environment fallbacks and defaults. */
export function resolveConfig(raw: Partial<DiscordGatewayConfig>): DiscordGatewayConfig {
  return {
    token: raw.token ?? '',
    cwd: raw.cwd ?? process.cwd(),
    provider: raw.provider,
    model: raw.model,
    allowedChannelIds: raw.allowedChannelIds ?? envList('DISCORD_ALLOWED_CHANNEL_IDS'),
    allowedRoleIds: raw.allowedRoleIds ?? envList('DISCORD_ALLOWED_ROLE_IDS'),
    allowedUserIds: raw.allowedUserIds ?? envList('DISCORD_ALLOWED_USER_IDS'),
    allowAllUsers: raw.allowAllUsers ?? process.env.DISCORD_ALLOW_ALL === 'true',
    requireMention: raw.requireMention ?? process.env.DISCORD_REQUIRE_MENTION !== 'false',
    autoThread: raw.autoThread ?? process.env.DISCORD_AUTO_THREAD !== 'false',
    groupSessionsPerUser: raw.groupSessionsPerUser ?? process.env.DISCORD_GROUP_SESSIONS_PER_USER !== 'false',
    mergeTimeoutSecs: raw.mergeTimeoutSecs ?? 5,
  }
}
