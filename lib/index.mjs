import { createHash, randomUUID } from "node:crypto";
import { Client, Events, GatewayIntentBits, SlashCommandBuilder } from "discord.js";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
//#region src/config.ts
/**
* Plugin config schema (schemastery) and environment-variable merging.
* The bundle patch fills `token`/`cwd` from process env; every allowlist key
* falls back to its dedicated environment variable when absent from config.
* @module dsh-discord-gateway/config
*/
/** Comma-separated env list → trimmed string array. */
function envList(name) {
	const raw = process.env[name];
	if (!raw) return void 0;
	const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
	return items.length > 0 ? items : void 0;
}
const DiscordGatewayConfigSchema = z.object({
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
	mergeTimeoutSecs: z.number()
});
/** Merge raw config with environment fallbacks and defaults. */
function resolveConfig(raw) {
	return {
		token: raw.token ?? "",
		cwd: raw.cwd ?? process.cwd(),
		provider: raw.provider,
		model: raw.model,
		allowedChannelIds: raw.allowedChannelIds ?? envList("DISCORD_ALLOWED_CHANNEL_IDS"),
		allowedRoleIds: raw.allowedRoleIds ?? envList("DISCORD_ALLOWED_ROLE_IDS"),
		allowedUserIds: raw.allowedUserIds ?? envList("DISCORD_ALLOWED_USER_IDS"),
		allowAllUsers: raw.allowAllUsers ?? process.env.DISCORD_ALLOW_ALL === "true",
		requireMention: raw.requireMention ?? process.env.DISCORD_REQUIRE_MENTION !== "false",
		autoThread: raw.autoThread ?? process.env.DISCORD_AUTO_THREAD !== "false",
		mergeTimeoutSecs: raw.mergeTimeoutSecs ?? 5
	};
}
//#endregion
//#region src/session.ts
/**
* Session-key mapping and per-chat agent lifecycle.
*
* Mirrors Hermes Agent's `build_session_key` (ns:platform:chat_type:chat_id:
* thread_id:user_id) for DeepSeek Harness: each Discord channel/thread owns one
* persistent agent session; DMs are isolated per user. Sessions survive process
* restarts through dsh-base's session-persistence-jsonl via `agents.resume`.
* @module dsh-discord-gateway/session
*/
/** Stable, collision-resistant session id derived from the location. */
function sessionKey(loc) {
	if (loc.dmUserId) return `discord:dm:${loc.dmUserId}`;
	const thread = loc.threadId ? `:thread:${loc.threadId}` : "";
	return `discord:guild:${loc.guildId ?? "?"}:${loc.channelId ?? "?"}${thread}`;
}
/** The durable SessionId for one chat location. */
function sessionIdFor(loc) {
	const key = sessionKey(loc);
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 24);
	return SessionId(`discord-${digest}`);
}
/** Resolve provider/model for a newly created agent. */
function resolveModelSelection(ctx, config) {
	const selection = ctx.agentDefaultModel?.currentSelection();
	return {
		provider: config.provider ?? selection?.provider ?? "deepseek-official",
		model: config.model ?? selection?.model ?? "deepseek-v4-flash"
	};
}
/** Per-chat agent registry: owns handles, resumes persistence, disposes on /new. */
var SessionManager = class {
	ctx;
	config;
	log;
	handles = /* @__PURE__ */ new Map();
	constructor(ctx, config, log) {
		this.ctx = ctx;
		this.config = config;
		this.log = log;
	}
	/** The live agent for a location, or undefined when none exists. */
	get(loc) {
		return this.handles.get(sessionKey(loc))?.agent;
	}
	/** Create or resume the agent for a location, returning the live agent. */
	async getOrCreate(loc) {
		const key = sessionKey(loc);
		const existing = this.handles.get(key);
		if (existing && existing.agent.status !== "running") return existing.agent;
		if (existing) return existing.agent;
		const id = sessionIdFor(loc);
		const selection = resolveModelSelection(this.ctx, this.config);
		const agentOptions = {
			provider: selection.provider,
			model: selection.model
		};
		const setup = (agentCtx) => {
			installModelSelection(agentCtx, {
				current: selection,
				assembled: void 0
			});
		};
		let handle;
		try {
			handle = await this.ctx.agents.resume({
				resumeSessionId: id,
				agentOptions,
				setup
			});
			this.log(`[session] resumed ${key} (${id})`);
		} catch (error) {
			const resumeErr = error instanceof Error ? error.message : String(error);
			handle = await this.ctx.agents.create({
				sessionId: id,
				meta: { cwd: this.config.cwd },
				agentOptions,
				setup
			});
			this.log(`[session] created ${key} (${id}); resume miss: ${resumeErr}`);
		}
		this.handles.set(key, handle);
		this.ctx.effect(() => () => {
			if (this.handles.get(key) === handle) this.handles.delete(key);
		}, `discord-session:${key}`);
		return handle.agent;
	}
	/** Dispose the agent for a location (used by /new). */
	async dispose(loc) {
		const key = sessionKey(loc);
		const handle = this.handles.get(key);
		if (!handle) return;
		this.handles.delete(key);
		await handle.dispose();
		this.log(`[session] disposed ${key}`);
	}
	/** Total live agent count (for /status). */
	get size() {
		return this.handles.size;
	}
	/** Disposed all agents (plugin shutdown). */
	async disposeAll() {
		const handles = [...this.handles.values()];
		this.handles.clear();
		await Promise.allSettled(handles.map((h) => h.dispose()));
	}
};
//#endregion
//#region src/outbound.ts
/** Discord hard content limit per message. */
const DISCORD_MAX_LENGTH = 2e3;
/** Narrow a text channel to a sendable one, or null. */
function asSendable(channel) {
	if (channel.partial) return null;
	return channel;
}
/** Typing indicator refresh interval (Discord expires typing after ~10s). */
const TYPING_INTERVAL_MS = 8e3;
/** Progressive-edit throttle: at most one edit per interval while streaming. */
const EDIT_THROTTLE_MS = 1200;
/**
* Split text into Discord-safe chunks, preferring newline/period boundaries and
* keeping code blocks intact (close before a split, reopen after). Each chunk
* after the first carries a `（i/n）` marker, mirroring Hermes' truncate_message.
*/
function splitText(text, max = DISCORD_MAX_LENGTH) {
	const chunks = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max - 1);
		if (cut <= 0) cut = rest.lastIndexOf("。", max - 1);
		if (cut <= 0) cut = rest.lastIndexOf(".", max - 1);
		if (cut <= 0) cut = max;
		else cut += 1;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	chunks.push(rest);
	if (chunks.length <= 1) return chunks;
	const total = chunks.length;
	return chunks.map((chunk, i) => i === 0 ? chunk : `（${i + 1}/${total}）\n${chunk}`);
}
/** Manages per-chat outbound delivery for the gateway. */
var OutboundManager = class {
	log;
	states = /* @__PURE__ */ new Map();
	constructor(log) {
		this.log = log;
	}
	state(key) {
		let s = this.states.get(key);
		if (!s) {
			s = {
				message: null,
				text: "",
				started: false,
				typingTimer: null,
				editTimer: null,
				pendingEdit: null,
				closed: false
			};
			this.states.set(key, s);
		}
		return s;
	}
	/** Start a turn: begin the typing indicator for `channel`. */
	startTurn(key, channel) {
		const s = this.state(key);
		s.closed = false;
		s.text = "";
		s.started = false;
		s.pendingEdit = null;
		if (s.typingTimer) clearInterval(s.typingTimer);
		s.typingTimer = setInterval(() => {
			channel.sendTyping().catch(() => void 0);
		}, TYPING_INTERVAL_MS);
		channel.sendTyping().catch(() => void 0);
	}
	/**
	* Stream a text delta: throttle-edited progressive preview on the placeholder
	* message. Creates the placeholder on first text.
	*/
	streamText(key, channel, delta) {
		const s = this.state(key);
		if (s.closed) return;
		s.text += delta;
		s.started = true;
		s.pendingEdit = s.text;
		if (s.editTimer) return;
		this.scheduleEdit(key, channel);
	}
	scheduleEdit(key, channel) {
		const s = this.state(key);
		if (!s.pendingEdit) return;
		const preview = s.pendingEdit;
		s.pendingEdit = null;
		s.editTimer = setTimeout(() => {
			s.editTimer = null;
			this.applyEdit(key, channel, preview).then(() => {
				if (s.pendingEdit) this.scheduleEdit(key, channel);
			});
		}, EDIT_THROTTLE_MS);
	}
	async applyEdit(key, channel, text) {
		const s = this.state(key);
		if (s.closed) return;
		const preview = text.length > 2e3 ? text.slice(0, 1997) + "…" : text;
		try {
			if (s.message) await s.message.edit(preview);
			else s.message = await channel.send(preview);
		} catch (error) {
			this.log(`[outbound] edit failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Finalize a turn with the complete assistant text. Edits the placeholder to
	* the first chunk and appends the rest as separate messages.
	*/
	async finishTurn(key, channel, fullText) {
		const s = this.state(key);
		s.closed = true;
		if (s.typingTimer) {
			clearInterval(s.typingTimer);
			s.typingTimer = null;
		}
		if (s.editTimer) {
			clearTimeout(s.editTimer);
			s.editTimer = null;
		}
		s.pendingEdit = null;
		const chunks = splitText(fullText);
		try {
			if (chunks.length === 0) return;
			if (s.message) await s.message.edit(chunks[0]);
			else if (chunks[0] !== void 0 && chunks[0] !== "") s.message = await channel.send(chunks[0]);
			for (const chunk of chunks.slice(1)) await channel.send(chunk);
		} catch (error) {
			this.log(`[outbound] final send failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/** Abort a turn with an error summary (turn/end reason=error). */
	async failTurn(key, channel, summary) {
		const s = this.state(key);
		s.closed = true;
		if (s.typingTimer) {
			clearInterval(s.typingTimer);
			s.typingTimer = null;
		}
		if (s.editTimer) {
			clearTimeout(s.editTimer);
			s.editTimer = null;
		}
		const text = s.started || s.message ? `⚠️ ${summary}` : `⚠️ ${summary}`;
		try {
			if (s.message) await s.message.edit(text);
			else if (text !== "") await channel.send(text);
		} catch (error) {
			this.log(`[outbound] error send failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/** Whether a turn is streaming for a chat (for concurrency guards). */
	isActive(key) {
		const s = this.states.get(key);
		return s !== void 0 && !s.closed;
	}
	/** Drop all state (shutdown). */
	dispose() {
		for (const s of this.states.values()) {
			if (s.typingTimer) clearInterval(s.typingTimer);
			if (s.editTimer) clearTimeout(s.editTimer);
		}
		this.states.clear();
	}
};
//#endregion
//#region src/commands.ts
/**
* Native Discord slash-command registration and handling: /help, /new, /status,
* /clear. Commands share the SessionManager so they operate on the invoking
* chat's agent exactly like plain messages.
* @module dsh-discord-gateway/commands
*/
/** Location of the chat that invoked a slash command. */
function interactionLocation(interaction) {
	if (interaction.channel?.isDMBased()) return { dmUserId: interaction.user.id };
	const channel = interaction.channel;
	if (channel?.isThread()) return {
		guildId: channel.guildId,
		channelId: channel.parentId ?? channel.id,
		threadId: channel.id
	};
	return {
		guildId: interaction.guildId ?? void 0,
		channelId: interaction.channelId
	};
}
/** Register guild-scoped slash commands on every guild the bot can see. */
async function registerSlashCommands(client, config, log) {
	const payload = [
		new SlashCommandBuilder().setName("help").setDescription("显示可用命令与当前会话状态"),
		new SlashCommandBuilder().setName("new").setDescription("开启全新会话（丢弃当前上下文）"),
		new SlashCommandBuilder().setName("clear").setDescription("同 /new：开启全新会话"),
		new SlashCommandBuilder().setName("status").setDescription("查看当前会话状态")
	].map((c) => c.toJSON());
	let registered = 0;
	for (const guild of client.guilds.cache.values()) try {
		await guild.commands.set(payload);
		registered += 1;
	} catch (error) {
		log(`slash commands failed on guild ${guild.id}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (registered > 0) log(`registered slash commands on ${registered} guild(s)`);
	else log("slash commands registered nowhere; plain-text fallback (/help, /new …) stays active");
}
/** Handle one chat-input interaction, delegating to the shared session manager. */
async function handleInteraction(interaction, config, sessions, log) {
	const command = interaction.commandName;
	const loc = interactionLocation(interaction);
	const userId = interaction.user.id;
	const memberRoles = interaction.member ? [...interaction.member.roles.cache.keys()] : [];
	if (!(interaction.channel?.isDMBased() ? config.allowedUserIds?.includes(userId) === true || config.allowAllUsers === true : config.allowAllUsers === true || config.allowedUserIds?.includes(userId) === true || config.allowedRoleIds?.some((id) => memberRoles.includes(id)) === true || config.allowedChannelIds?.includes(interaction.channelId) === true)) {
		await interaction.reply({
			content: "⛔ 未授权：你的账号不在白名单中。",
			ephemeral: true
		}).catch(() => void 0);
		return;
	}
	switch (command) {
		case "help":
			await interaction.reply({
				content: "🤖 dsh-discord-gateway 命令：\n/help — 帮助\n/new — 开启新会话\n/status — 会话状态\n/clear — 同 /new\n频道里 @bot 发送消息即可驱动 agent；长回复自动分片。",
				ephemeral: true
			}).catch(() => void 0);
			break;
		case "new":
		case "clear":
			await sessions.dispose(loc);
			await interaction.reply({
				content: "✅ 已开启新会话。",
				ephemeral: true
			}).catch(() => void 0);
			break;
		case "status": {
			const agent = sessions.get(loc);
			await interaction.reply({
				content: agent ? `📡 会话状态：**${agent.status}**\n会话 id：\`${agent.id}\`\n活跃会话总数：${sessions.size}` : `📡 当前没有活跃会话（共 ${sessions.size} 个）。发一条消息即可创建。`,
				ephemeral: true
			}).catch(() => void 0);
			break;
		}
		default:
			await interaction.reply({
				content: `未知命令 /${command}`,
				ephemeral: true
			}).catch(() => void 0);
			log(`unknown slash command: ${command}`);
	}
}
//#endregion
//#region src/index.ts
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
const name = "discord-gateway";
/** Core services required before the gateway can start. */
const inject = [
	"agentDefaultModel",
	"agents",
	"sessions"
];
const Config = DiscordGatewayConfigSchema;
function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig);
	if (!config.token) throw new Error("discord-gateway: DISCORD_BOT_TOKEN is required (set the env var or the plugin token config)");
	const log = (line) => {
		process.stderr.write(`[discord-gateway] ${line}\n`);
		ctx.logger?.("discord-gateway").info(line);
	};
	const sessions = new SessionManager(ctx, config, log);
	const outbound = new OutboundManager(log);
	const turns = /* @__PURE__ */ new Map();
	const client = new Client({ intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.MessageContent
	] });
	/** Location of the chat a message arrived in. */
	function locationOf(message) {
		if (message.channel.isDMBased()) return { dmUserId: message.author.id };
		const channel = message.channel;
		if (channel.isThread()) return {
			guildId: channel.guildId,
			channelId: channel.parentId ?? channel.id,
			threadId: channel.id
		};
		return {
			guildId: channel.guildId,
			channelId: channel.id
		};
	}
	/** Authorization gate (fail-closed). */
	function authorized(loc, message) {
		if (config.allowAllUsers) return true;
		if (config.allowedUserIds?.includes(message.author.id)) return true;
		if (loc.dmUserId) return config.allowedUserIds?.includes(loc.dmUserId) === true;
		if (!message.member) return false;
		const memberRoles = [...message.member.roles.cache.keys()];
		if (config.allowedRoleIds?.some((id) => memberRoles.includes(id))) return true;
		if (config.allowedChannelIds?.includes(message.channelId)) return true;
		if (loc.channelId && config.allowedChannelIds?.includes(loc.channelId)) return true;
		return false;
	}
	/** Whether a guild-channel message is a trigger (mention or DM). */
	function isTrigger(message, loc) {
		if (loc.dmUserId) return true;
		if (!config.requireMention) return true;
		return message.mentions.has(client.user.id);
	}
	/** Build the reply channel: auto-thread for guild messages when configured. */
	async function resolveReplyChannel(message, loc) {
		if (!loc.dmUserId && config.autoThread && !message.channel.isThread()) try {
			const threadName = message.content.replace(/<@!?\d+>/g, "").trim().slice(0, 50) || "dsh-agent";
			return asSendable(await message.startThread({ name: threadName })) ?? asSendable(message.channel);
		} catch {
			return asSendable(message.channel);
		}
		return asSendable(message.channel);
	}
	/** Route one assistant-streaming event back to its Discord chat. */
	function handleSessionEvent(session, event) {
		const turn = turns.get(session.id);
		if (!turn) return;
		(async () => {
			const channel = await resolveChannelFor(turn);
			if (!channel) return;
			switch (event.type) {
				case "assistant/chunk": {
					const chunk = event.data.chunk;
					if (chunk.type === "text-delta" && chunk.text) outbound.streamText(turn.outKey, channel, chunk.text);
					break;
				}
				case "assistant/message": {
					const text = event.data.message.content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
					if (text) outbound.streamText(turn.outKey, channel, `\n${text}`);
					break;
				}
				case "turn/end": {
					const reason = event.data.reason;
					if (reason.kind === "error") {
						const err = event.data.reason.error;
						await outbound.failTurn(turn.outKey, channel, err?.message ?? err?.code ?? "agent turn failed");
					} else if (reason.kind === "completed") {
						const finalText = await sessionText(session);
						await outbound.finishTurn(turn.outKey, channel, finalText);
					} else await outbound.finishTurn(turn.outKey, channel, await sessionText(session));
					turns.delete(session.id);
					break;
				}
			}
		})();
	}
	async function resolveChannelFor(turn) {
		const targetId = turn.loc.threadId ?? turn.loc.channelId;
		if (!targetId) return null;
		try {
			const channel = await client.channels.fetch(targetId);
			if (!channel || !channel.isTextBased()) return null;
			return asSendable(channel);
		} catch {
			return null;
		}
	}
	async function sessionText(session) {
		const events = session.events;
		let text = "";
		let started = false;
		for (const event of events) {
			if (event.type === "turn/start") started = true;
			if (!started) continue;
			if (event.type === "assistant/message") {
				const joined = event.data.message.content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
				if (joined !== "") text = joined;
			}
		}
		return text;
	}
	/** Drive one user message through the chat's agent. */
	async function handleUserMessage(message) {
		const loc = locationOf(message);
		if (!authorized(loc, message)) {
			await message.reply("⛔ 未授权：你的账号不在白名单中。").catch(() => void 0);
			return;
		}
		const channel = await resolveReplyChannel(message, loc);
		const outKey = `${channel.id}:${randomUUID()}`;
		try {
			const agent = await sessions.getOrCreate({
				...loc,
				threadId: channel.isThread() ? channel.id : loc.threadId
			});
			turns.set(agent.session.id, {
				loc: {
					...loc,
					channelId: channel.id,
					threadId: channel.isThread() ? channel.id : void 0
				},
				outKey
			});
			outbound.startTurn(outKey, channel);
			agent.followup(createUserMessage({
				content: [{
					type: "text",
					text: message.content
				}],
				source: {
					kind: "plugin",
					plugin: "dsh-discord-gateway",
					form: "relay"
				}
			}));
		} catch (error) {
			await outbound.failTurn(outKey, channel, error instanceof Error ? error.message : String(error));
		}
	}
	client.on(Events.ClientReady, async (readyClient) => {
		log(`logged in as ${readyClient.user.tag}`);
		await registerSlashCommands(readyClient, config, log).catch((error) => {
			log(`slash command registration failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	});
	client.on(Events.MessageCreate, (message) => {
		if (message.author.bot) return;
		if (!isTrigger(message, locationOf(message))) return;
		const text = message.content.trim();
		if (text.startsWith("/") || text.startsWith("!")) {
			handlePlainCommand(message, text, config, sessions, log).catch(() => void 0);
			return;
		}
		handleUserMessage(message).catch((error) => {
			log(`message handling failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	});
	client.on(Events.InteractionCreate, (interaction) => {
		if (!interaction.isChatInputCommand()) return;
		handleInteraction(interaction, config, sessions, log).catch((error) => {
			log(`interaction failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	});
	client.on(Events.Error, (error) => {
		log(`discord client error: ${error.message}`);
	});
	ctx.effect(() => {
		const disposer = ctx.on("session/event", (session, event) => {
			handleSessionEvent(session, event);
		}, { global: true });
		const exit = ctx.get("appExit");
		client.login(config.token).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			log(`login failed: ${message}`);
			if (exit) exit(1);
			else process.exitCode = 1;
		});
		return () => {
			disposer();
			outbound.dispose();
			client.destroy();
			sessions.disposeAll();
		};
	}, "discord-gateway: lifecycle");
}
/** Minimal plain-text command fallback (works even without slash registration). */
async function handlePlainCommand(message, text, config, sessions, log) {
	const loc = message.channel.isDMBased() ? { dmUserId: message.author.id } : {
		guildId: message.guildId ?? void 0,
		channelId: message.channelId,
		threadId: message.channel.isThread() ? message.channelId : void 0
	};
	switch (text.replace(/^[!/]/, "").split(/\s+/)[0]?.toLowerCase()) {
		case "help":
			await message.reply("🤖 dsh-discord-gateway 命令：\n/help — 帮助\n/new — 开启新会话\n/status — 会话状态\n/clear — 同 /new\n普通文本 @bot 直接发送给 agent。").catch(() => void 0);
			break;
		case "new":
		case "clear":
			await sessions.dispose(loc);
			await message.reply("✅ 已开启新会话。").catch(() => void 0);
			break;
		case "status": {
			const agent = sessions.get(loc);
			await message.reply(agent ? `📡 会话状态：**${agent.status}**\n会话 id：\`${agent.id}\`` : "📡 当前没有活跃会话，发一条消息即可创建。").catch(() => void 0);
			break;
		}
		default: await message.reply(`未知命令 \`${text}\`，试试 /help`).catch(() => void 0);
	}
}
//#endregion
export { Config, DISCORD_MAX_LENGTH, apply, inject, name, sessionIdFor, sessionKey, splitText };
