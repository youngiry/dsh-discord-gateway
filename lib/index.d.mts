import "discord.js";
import z from "@deepseek-ai/schemastery";
import { SessionId } from "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-agent";
import { Context } from "@deepseek-ai/cordis";
//#region src/config.d.ts
interface DiscordGatewayConfig {
  /** Bot token. Required; missing token fails loud at apply. */
  token: string;
  /** Working directory for agent sessions. */
  cwd?: string;
  /** Provider route for created agents; defaults to the agent default selection. */
  provider?: string;
  /** Model id for created agents; defaults to the agent default selection. */
  model?: string;
  /** Allowed channel/thread ids (fail-closed: empty = deny all when allowAllUsers is false). */
  allowedChannelIds?: string[];
  /** Allowed role ids; a member holding any listed role passes. */
  allowedRoleIds?: string[];
  /** Allowed user ids; a member whose id is listed passes. */
  allowedUserIds?: string[];
  /** Test-only: allow every user (logs a warning). */
  allowAllUsers?: boolean;
  /** Channel messages require an @bot mention to trigger; DMs always trigger. */
  requireMention?: boolean;
  /** Auto-create a thread under a guild channel message that triggers the bot. */
  autoThread?: boolean;
  /** Guild channels: one session per user (Hermes default) vs channel-shared. */
  groupSessionsPerUser?: boolean;
  /** Merge timeout (seconds) for multi-part mobile input (`..` continuation). */
  mergeTimeoutSecs?: number;
}
//#endregion
//#region src/outbound.d.ts
/** Discord hard content limit per message. */
declare const DISCORD_MAX_LENGTH = 2000;
/**
 * Split text into Discord-safe chunks, preferring newline/period boundaries and
 * keeping code blocks intact (close before a split, reopen after). Each chunk
 * after the first carries a `（i/n）` marker, mirroring Hermes' truncate_message.
 */
declare function splitText(text: string, max?: number): string[];
//#endregion
//#region src/session.d.ts
/** One Discord chat location: a DM, or a guild channel/thread plus the actor. */
interface ChatLocation {
  guildId?: string;
  channelId?: string;
  threadId?: string;
  dmUserId?: string;
  /** The Discord user id of the actor (used for per-user guild sessions). */
  userId?: string;
}
/** Stable, collision-resistant session key derived from the location. */
declare function sessionKey(loc: ChatLocation, groupSessionsPerUser?: boolean): string;
/** The durable SessionId for one chat location. */
declare function sessionIdFor(loc: ChatLocation, groupSessionsPerUser?: boolean): SessionId;
//#endregion
//#region src/index.d.ts
declare const name = "discord-gateway";
/** Core services required before the gateway can start. */
declare const inject: string[];
declare const Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
  token: import("@deepseek-ai/schemastery").default<string, string>;
  cwd: import("@deepseek-ai/schemastery").default<string, string>;
  provider: import("@deepseek-ai/schemastery").default<string, string>;
  model: import("@deepseek-ai/schemastery").default<string, string>;
  allowedChannelIds: import("@deepseek-ai/schemastery").default<string[], string[]>;
  allowedRoleIds: import("@deepseek-ai/schemastery").default<string[], string[]>;
  allowedUserIds: import("@deepseek-ai/schemastery").default<string[], string[]>;
  allowAllUsers: import("@deepseek-ai/schemastery").default<boolean, boolean>;
  requireMention: import("@deepseek-ai/schemastery").default<boolean, boolean>;
  autoThread: import("@deepseek-ai/schemastery").default<boolean, boolean>;
  groupSessionsPerUser: import("@deepseek-ai/schemastery").default<boolean, boolean>;
  mergeTimeoutSecs: import("@deepseek-ai/schemastery").default<number, number>;
}>, Schemastery.ObjectT<{
  token: import("@deepseek-ai/schemastery").default<string, string>;
  cwd: import("@deepseek-ai/schemastery").default<string, string>;
  provider: import("@deepseek-ai/schemastery").default<string, string>;
  model: import("@deepseek-ai/schemastery").default<string, string>;
  allowedChannelIds: import("@deepseek-ai/schemastery").default<string[], string[]>;
  allowedRoleIds: import("@deepseek-ai/schemastery").default<string[], string[]>;
  allowedUserIds: import("@deepseek-ai/schemastery").default<string[], string[]>;
  allowAllUsers: import("@deepseek-ai/schemastery").default<boolean, boolean>;
  requireMention: import("@deepseek-ai/schemastery").default<boolean, boolean>;
  autoThread: import("@deepseek-ai/schemastery").default<boolean, boolean>;
  groupSessionsPerUser: import("@deepseek-ai/schemastery").default<boolean, boolean>;
  mergeTimeoutSecs: import("@deepseek-ai/schemastery").default<number, number>;
}>>;
declare function apply(ctx: Context, rawConfig: Partial<DiscordGatewayConfig>): void;
//#endregion
export { Config, DISCORD_MAX_LENGTH, apply, inject, name, sessionIdFor, sessionKey, splitText };