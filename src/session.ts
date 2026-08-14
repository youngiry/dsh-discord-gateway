/**
 * Session-key mapping and per-chat agent lifecycle.
 *
 * Mirrors Hermes Agent's `build_session_key` (ns:platform:chat_type:chat_id:
 * thread_id:user_id) for DeepSeek Harness, with Hermes' default isolation
 * semantics:
 * - DMs: one session per user (`discord:dm:<userId>`).
 * - Guild channels: one session PER USER by default (`group_sessions_per_user`,
 *   so each participant in a shared channel gets an isolated conversation),
 *   unless `groupSessionsPerUser: false` is configured (channel-shared).
 * - Threads: one session shared by all participants (`discord:guild:...:thread`)
 *   — the expected UX for threaded conversations.
 * Sessions survive process restarts through dsh-base's
 * session-persistence-jsonl via `agents.resume`.
 * @module dsh-discord-gateway/session
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { installModelSelection, type Agent, type AgentHandle, type AgentSetup } from '@deepseek-ai/dsh-agent'
// Import the module augmentation that installs ctx.agentDefaultModel.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { DiscordGatewayConfig } from './config.ts'

/** One Discord chat location: a DM, or a guild channel/thread plus the actor. */
export interface ChatLocation {
  guildId?: string
  channelId?: string
  threadId?: string
  dmUserId?: string
  /** The Discord user id of the actor (used for per-user guild sessions). */
  userId?: string
}

/** Stable, collision-resistant session key derived from the location. */
export function sessionKey(loc: ChatLocation, groupSessionsPerUser = true): string {
  // DM: per-user always.
  if (loc.dmUserId) return `discord:dm:${loc.dmUserId}`
  // Thread: shared by all participants (Hermes' thread_sessions_per_user=false).
  if (loc.threadId) return `discord:guild:${loc.guildId ?? '?'}:${loc.channelId ?? '?'}:thread:${loc.threadId}`
  // Guild channel: per-user by default, channel-shared when configured off.
  const actor = groupSessionsPerUser && loc.userId ? `:user:${loc.userId}` : ''
  return `discord:guild:${loc.guildId ?? '?'}:${loc.channelId ?? '?'}${actor}`
}

/** The durable SessionId for one chat location. */
export function sessionIdFor(loc: ChatLocation, groupSessionsPerUser = true): SessionIdType {
  const key = sessionKey(loc, groupSessionsPerUser)
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24)
  return SessionId(`discord-${digest}`)
}

/** Resolve provider/model for a newly created agent. */
export function resolveModelSelection(ctx: Context, config: DiscordGatewayConfig): { provider: string; model: string } {
  const selection = ctx.agentDefaultModel?.currentSelection()
  return {
    provider: config.provider ?? selection?.provider ?? 'deepseek-official',
    model: config.model ?? selection?.model ?? 'deepseek-v4-flash',
  }
}

/** Options for the agent creation/resume setup hook (shared by both paths). */
export interface AgentSetupOptions {
  provider: string
  model: string
}

/** Per-chat agent registry: owns handles, resumes persistence, disposes on /new. */
export class SessionManager {
  private readonly handles = new Map<string, AgentHandle>()

  constructor(
    private readonly ctx: Context,
    private readonly config: DiscordGatewayConfig,
    private readonly log: (line: string) => void,
  ) {}

  /** The live agent for a location, or undefined when none exists. */
  get(loc: ChatLocation): Agent | undefined {
    return this.handles.get(sessionKey(loc, this.config.groupSessionsPerUser))?.agent
  }

  /** Create or resume the agent for a location, returning the live agent. */
  async getOrCreate(loc: ChatLocation): Promise<Agent> {
    const key = sessionKey(loc, this.config.groupSessionsPerUser)
    const existing = this.handles.get(key)
    if (existing && existing.agent.status !== 'running') {
      // Already live and idle: reuse it (conversation continuity).
      return existing.agent
    }
    if (existing) return existing.agent // live but busy: this turn queues anyway

    const id = sessionIdFor(loc, this.config.groupSessionsPerUser)
    const selection = resolveModelSelection(this.ctx, this.config)
    const agentOptions = { provider: selection.provider, model: selection.model }
    const setup: AgentSetup = (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    }

    // Resume first (persisted conversation survives restarts); create on miss.
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.resume({
        resumeSessionId: id,
        agentOptions,
        setup,
      })
      this.log(`[session] resumed ${key} (${id})`)
    } catch (error) {
      const resumeErr = error instanceof Error ? error.message : String(error)
      handle = await this.ctx.agents.create({
        sessionId: id,
        meta: { cwd: this.config.cwd },
        agentOptions,
        setup,
      })
      this.log(`[session] created ${key} (${id}); resume miss: ${resumeErr}`)
    }

    this.handles.set(key, handle)
    // Deregister when the owner context disposes.
    this.ctx.effect(() => () => {
      if (this.handles.get(key) === handle) this.handles.delete(key)
    }, `discord-session:${key}`)
    return handle.agent
  }

  /** Dispose the agent for a location (used by /new). */
  async dispose(loc: ChatLocation): Promise<void> {
    const key = sessionKey(loc, this.config.groupSessionsPerUser)
    const handle = this.handles.get(key)
    if (!handle) return
    this.handles.delete(key)
    await handle.dispose()
    this.log(`[session] disposed ${key}`)
  }

  /** Total live agent count (for /status). */
  get size(): number {
    return this.handles.size
  }

  /** Disposed all agents (plugin shutdown). */
  async disposeAll(): Promise<void> {
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map((h) => h.dispose()))
  }
}
