import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { musicDeps } from "../extensions/sidebar/music.ts";

// No test reaches the cliamp playing on the machine: no player answers unless a test says otherwise.
musicDeps.run = async () => undefined;

// Every test file runs in its own process: give it a fresh agent dir before the
// extension module computes its config path.
const agentDir = mkdtempSync(path.join(os.tmpdir(), "gentle-quiet-test-"));
process.env.GENTLE_QUIET_TEST_AGENT_DIR = agentDir;
// Tests run from inside Pi too, where the main session already set this for its subagents: start
// every test file as a main process (spend-child.test.mjs sets it again on purpose).
delete process.env.GENTLE_QUIET_SPEND_PARENT;
export const configFile = path.join(agentDir, "gentle-quiet.json");

export const readConfig = () => (existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : undefined);
export const writeConfig = (value) => writeFileSync(configFile, JSON.stringify(value));

export const plain = (text) => text.replace(/\x1b\[[0-9;:]*m/g, "");

// Each theme role gets its own 256-color code, so tests can tell roles apart
// while widths stay real (escape sequences take no columns).
const ROLES = ["accent", "border", "dim", "muted", "error", "warning", "success", "toolTitle", "toolDiffAdded", "toolDiffRemoved", "toolOutput"];
const code = (role) => 16 + Math.max(0, ROLES.indexOf(role));
export const role = (name) => `\x1b[38;5;${code(name)}m`;
/** True when `text` contains `snippet` painted in the theme role `name`. */
export const painted = (text, name, snippet = "") => text.includes(`${role(name)}${snippet}`);

export const theme = {
	fg: (name, text) => `${role(name)}${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

/**
 * Loads the extension against a fake Pi API and returns what it registered,
 * plus a UI that records status and widget writes after the extension's patch.
 */
export async function load({ mode = "rpc", select, input, custom, session = {}, thinking = "medium" } = {}) {
	const { default: extension } = await import("../extensions/gentle-quiet.ts");
	const handlers = {};
	const commands = {};
	const toolResolvers = [];
	const messageRenderers = {};
	const entryRenderers = {};
	const markdown = [];
	const shortcuts = {};
	const sent = [];
	// pi.events: the bus gentle-pi's extensions publish display snapshots on.
	const bus = {};
	const events = {
		on: (channel, handler) => {
			(bus[channel] ??= []).push(handler);
			return () => (bus[channel] = bus[channel].filter((other) => other !== handler));
		},
		emit: (channel, data) => (bus[channel] ?? []).forEach((handler) => handler(data)),
	};
	await extension({
		events,
		on: (event, handler) => ((handlers[event] ??= []).push(handler)),
		registerCommand: (name, command) => (commands[name] = command),
		registerShortcut: (key, shortcut) => (shortcuts[key] = shortcut),
		getCommands: () => session.commands ?? [],
		sendUserMessage: (text, options) => sent.push([text, options]),
		registerToolRenderer: (resolver) => toolResolvers.push(resolver),
		registerMessageRenderer: (type, renderer) => (messageRenderers[type] = renderer),
		registerEntryRenderer: (type, renderer) => (entryRenderers[type] = renderer),
		registerMarkdownTransformer: (transformer) => markdown.push(transformer),
		getThinkingLevel: () => thinking,
		// MCP: tools Pi has registered (mcp__<server>__<tool>) and servers extensions registered.
		getAllTools: () => (session.tools ?? []).map((tool) => (typeof tool === "string" ? { name: tool, exposure: "codemode", namespace: { name: tool.split("__").slice(0, 2).join("__") } } : tool)),
		getMcpServers: () => session.extensionServers ?? [],
	});

	const status = {};
	const widgets = {};
	const notices = [];
	let editorFactory;
	let footerFactory;
	const ui = {
		theme,
		setStatus: (key, text) => (status[key] = text),
		setWidget: (key, content) => (widgets[key] = content),
		notify: (...args) => notices.push(args),
		select: select ?? (async () => undefined),
		input: input ?? (async () => undefined),
		getEditorComponent: () => editorFactory,
		setEditorComponent: (factory) => (editorFactory = factory),
		setFooter: (factory) => (footerFactory = factory),
		...(custom ? { custom } : {}),
	};
	// Session data the status line reads; tests override what they need.
	const ctx = {
		ui,
		mode,
		hasUI: true,
		isProjectTrusted: () => session.projectTrusted ?? false,
		model: session.model,
		getContextUsage: () => session.usage,
		modelRegistry: {
			isUsingOAuth: () => session.subscription ?? false,
			find: (provider, id) => session.registry?.[`${provider}/${id}`],
		},
		sessionManager: {
			getCwd: () => session.cwd ?? "/tmp",
			getEntries: () => session.entries ?? [],
			getSessionId: () => session.id,
			getSessionName: () => session.name,
		},
	};
	// Returns what each handler answered, in order (Pi reads the answers of input handlers).
	const emit = async (event, payload = {}) => {
		const answers = [];
		for (const handler of handlers[event] ?? []) answers.push(await handler(payload, ctx));
		return answers;
	};
	await emit("session_start");

	/** The renderers Pi would use for a tool whose own renderers are `base`. */
	const tool = (name, base = {}) => toolResolvers.reduceRight((next, resolver) => () => resolver(name, next), () => base)();

	return { ctx, ui, status, widgets, notices, commands, shortcuts, sent, events, tool, messageRenderers, entryRenderers, markdown, emit, editor: () => editorFactory, footer: () => footerFactory };
}

/** Renders a component (or a tool row) to plain lines at `width`. */
export const lines = (component, width = 80) => component.render(width).map(plain);

/** Picks menu items in order: each entry is a RegExp matched against the item labels. */
export function picker(...patterns) {
	const seen = [];
	const select = async (title, items) => {
		seen.push({ title, items });
		const next = patterns.shift();
		return next ? items.find((item) => next.test(item)) : undefined;
	};
	return { select, seen };
}
