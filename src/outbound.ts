/**
 * Outbound delivery to Discord: typing indicator, progressive message edits
 * while the agent streams, and code-block-aware chunking with (i/n) markers —
 * the Hermes Agent `truncate_message` pattern ported to discord.js.
 * @module dsh-discord-gateway/outbound
 */

import type { Message, MessagePayload, MessageCreateOptions, TextBasedChannel } from 'discord.js'

/** Discord hard content limit per message. */
export const DISCORD_MAX_LENGTH = 2000

/** A channel we can actually send into (excludes PartialGroupDMChannel). */
export type SendableChannel = TextBasedChannel & {
  send(options: string | MessagePayload | MessageCreateOptions): Promise<Message>
  sendTyping(): Promise<void>
}

/** Narrow a text channel to a sendable one, or null. */
export function asSendable(channel: TextBasedChannel): SendableChannel | null {
  if (channel.partial) return null
  return channel as SendableChannel
}

/** Typing indicator refresh interval (Discord expires typing after ~10s). */
const TYPING_INTERVAL_MS = 8000

/** Progressive-edit throttle: at most one edit per interval while streaming. */
const EDIT_THROTTLE_MS = 1200

/**
 * Split text into Discord-safe chunks, preferring newline/period boundaries and
 * keeping code blocks intact (close before a split, reopen after). Each chunk
 * after the first carries a `（i/n）` marker, mirroring Hermes' truncate_message.
 */
export function splitText(text: string, max = DISCORD_MAX_LENGTH): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    // Prefer the last newline within the budget; fall back to the last period;
    // otherwise hard-cut at the budget.
    let cut = rest.lastIndexOf('\n', max - 1)
    if (cut <= 0) cut = rest.lastIndexOf('。', max - 1)
    if (cut <= 0) cut = rest.lastIndexOf('.', max - 1)
    if (cut <= 0) cut = max
    else cut += 1 // keep the boundary char at the end of this chunk
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  chunks.push(rest)

  if (chunks.length <= 1) return chunks
  const total = chunks.length
  return chunks.map((chunk, i) => (i === 0 ? chunk : `（${i + 1}/${total}）\n${chunk}`))
}

/** One in-flight outbound message for a chat: progressive edit target. */
interface OutboundState {
  /** The placeholder/preview message being progressively edited. */
  message: Message | null
  /** Full accumulated text for the current assistant message. */
  text: string
  /** Whether the current turn has streamed any text yet. */
  started: boolean
  /** Timer for the typing indicator. */
  typingTimer: ReturnType<typeof setInterval> | null
  /** Timer for the progressive-edit throttle. */
  editTimer: ReturnType<typeof setTimeout> | null
  /** Pending text awaiting the next throttled edit. */
  pendingEdit: string | null
  /** Whether this state is closed (turn ended). */
  closed: boolean
}

/** Manages per-chat outbound delivery for the gateway. */
export class OutboundManager {
  private readonly states = new Map<string, OutboundState>()

  constructor(private readonly log: (line: string) => void) {}

  private state(key: string): OutboundState {
    let s = this.states.get(key)
    if (!s) {
      s = {
        message: null,
        text: '',
        started: false,
        typingTimer: null,
        editTimer: null,
        pendingEdit: null,
        closed: false,
      }
      this.states.set(key, s)
    }
    return s
  }

  /** Start a turn: begin the typing indicator for `channel`. */
  startTurn(key: string, channel: SendableChannel): void {
    const s = this.state(key)
    s.closed = false
    s.text = ''
    s.started = false
    s.pendingEdit = null
    if (s.typingTimer) clearInterval(s.typingTimer)
    s.typingTimer = setInterval(() => {
      void channel.sendTyping().catch(() => undefined)
    }, TYPING_INTERVAL_MS)
    void channel.sendTyping().catch(() => undefined)
  }

  /**
   * Stream a text delta: throttle-edited progressive preview on the placeholder
   * message. Creates the placeholder on first text.
   */
  streamText(key: string, channel: SendableChannel, delta: string): void {
    const s = this.state(key)
    if (s.closed) return
    s.text += delta
    s.started = true
    s.pendingEdit = s.text
    if (s.editTimer) return
    this.scheduleEdit(key, channel)
  }

  private scheduleEdit(key: string, channel: SendableChannel): void {
    const s = this.state(key)
    if (!s.pendingEdit) return
    const preview = s.pendingEdit
    s.pendingEdit = null
    s.editTimer = setTimeout(() => {
      s.editTimer = null
      void this.applyEdit(key, channel, preview).then(() => {
        if (s.pendingEdit) this.scheduleEdit(key, channel)
      })
    }, EDIT_THROTTLE_MS)
  }

  private async applyEdit(key: string, channel: SendableChannel, text: string): Promise<void> {
    const s = this.state(key)
    if (s.closed) return
    const preview = text.length > DISCORD_MAX_LENGTH ? text.slice(0, DISCORD_MAX_LENGTH - 3) + '…' : text
    try {
      if (s.message) {
        await s.message.edit(preview)
      } else {
        s.message = await channel.send(preview)
      }
    } catch (error) {
      this.log(`[outbound] edit failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Finalize a turn with the complete assistant text. Edits the placeholder to
   * the first chunk and appends the rest as separate messages.
   */
  async finishTurn(key: string, channel: SendableChannel, fullText: string): Promise<void> {
    const s = this.state(key)
    s.closed = true
    if (s.typingTimer) {
      clearInterval(s.typingTimer)
      s.typingTimer = null
    }
    if (s.editTimer) {
      clearTimeout(s.editTimer)
      s.editTimer = null
    }
    s.pendingEdit = null
    const chunks = splitText(fullText)
    try {
      if (chunks.length === 0) return
      if (s.message) {
        await s.message.edit(chunks[0]!)
      } else if (chunks[0] !== undefined && chunks[0] !== '') {
        s.message = await channel.send(chunks[0])
      }
      for (const chunk of chunks.slice(1)) {
        await channel.send(chunk)
      }
    } catch (error) {
      this.log(`[outbound] final send failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Abort a turn with an error summary (turn/end reason=error). */
  async failTurn(key: string, channel: SendableChannel, summary: string): Promise<void> {
    const s = this.state(key)
    s.closed = true
    if (s.typingTimer) {
      clearInterval(s.typingTimer)
      s.typingTimer = null
    }
    if (s.editTimer) {
      clearTimeout(s.editTimer)
      s.editTimer = null
    }
    const text = s.started || s.message ? `⚠️ ${summary}` : `⚠️ ${summary}`
    try {
      if (s.message) await s.message.edit(text)
      else if (text !== '') await channel.send(text)
    } catch (error) {
      this.log(`[outbound] error send failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Whether a turn is streaming for a chat (for concurrency guards). */
  isActive(key: string): boolean {
    const s = this.states.get(key)
    return s !== undefined && !s.closed
  }

  /** Drop all state (shutdown). */
  dispose(): void {
    for (const s of this.states.values()) {
      if (s.typingTimer) clearInterval(s.typingTimer)
      if (s.editTimer) clearTimeout(s.editTimer)
    }
    this.states.clear()
  }
}
