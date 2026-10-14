// gentle-quiet: a quiet, Pi-native look for gentle-pi and gentle-engram, styled with Pi's theme.
// Configure it with /gentle-quiet; choices are saved to <Pi agent dir>/gentle-quiet.json.
//   footer  "🧠 project · ✓ 4 results"   -> "mem 4 results"   (dim, like Pi's footer)
//   footer  "Permissions: YOLO"          -> "Perm: Yolo"       (Yolo in warning color)
//   banner  "🚀 YOLO ON 🔥 — ..."         -> hidden (above the editor and in the footer)
//   tools   "🧠 search “x” …", "✿todo · write", "❀ agent run"
//                                         -> " 󰧑 search “x”", " ≡ todo · write", " ◈ agent run"
//           (Pi's one-column margin; memory rows drawn like Pi's own tool rows)
//   agents  subagent results -> " ◈ gentle-ai-explore · done" + " └ first line of the answer"
//   blocks  Todos and Agents panels lose their background, accent bar and
//           padding rows, line up with that same margin and get a square
//           outline in the theme's border color
//   quiet   read/bash/edit/write/grep/find/ls/codemode collapse to
//             " read ~/x.ts"
//             " └ ✓ 120 lines"
//           with ctrl+o expanding to Pi's own output (execution stays Pi's)
//   prompt  " ❯ " before the input and before sent user messages (from pi-pretty,
//           without its rounded borders, so the editor stays native)
// Neither package offers display options, so this rewrites their UI writes.
// @ts-nocheck

import { CustomEditor, getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Pi's agent dir (honors PI_CODING_AGENT_DIR); ~/.pi/agent on hosts without the export.
const AGENT_DIR = (() => {
	try {
		return typeof getAgentDir === "function" ? getAgentDir() : path.join(os.homedir(), ".pi/agent");
	} catch {
		return path.join(os.homedir(), ".pi/agent");
	}
})();
const CONFIG_FILE = path.join(AGENT_DIR, "gentle-quiet.json");
const ENGRAM_CHROME = path.join(AGENT_DIR, "npm/node_modules/gentle-engram/memory-tool-chrome.js");

const DEFAULTS = {
	memory: { show: true, label: "mem", showProject: false },
	permissions: { show: true, label: "Perm", hideWhenNormal: false },
	yoloBanner: false,
	// Icons of the rewritten tool rows and blocks, one per group; "" for none.
	// memory: Nerd Font brain outline (nf-md-brain), drawn in the theme color like any text.
	icons: { memory: "\u{F09D1}", todo: "≡", agents: "◈", other: "›" },
	tools: { margin: true }, // Pi's one-column margin for gentle and memory tool rows
	// Pi's own tools collapsed to a call row and a one-line summary; ctrl+o expands to Pi's full output.
	// codemode: "summary" (one line), "failures" (plus each failed call) or "all" (every call).
	// hint: "ctrl+o to expand" on the most recent call ("last"), on every call ("all") or nowhere ("never").
	quiet: { enabled: true, preview: 0, codemode: "failures", hint: "last" },
	subagents: { minimal: true }, // subagent result messages as a row plus a summary line; applies after restart
	blocks: { minimal: true, border: true }, // flatten the Todos and Agents panels; square theme-colored outline
	prompt: { icon: "❯", editor: true, userMessage: true },
};
const CARD_ICONS = ["◇", "◆", "◈", "○", "●", "≡", "∴", "›", "·"];
// Memory-specific choices: brain, history (recall) and database from the Nerd Font,
// plus a plain Unicode recall arrow for fonts without Nerd Font glyphs.
const MEMORY_ICONS = ["\u{F09D1}", "\u{F02DA}", "\u{F01BC}", "⟲"];
const ICON_GROUPS = [["memory", "Memory icon"], ["todo", "Todo icon"], ["agents", "Agents icon"], ["other", "Other gentle tools icon"]];
const AGENT_TOOLS = /^(subagent_.*|orchestrator_.*)$/;
const iconGroup = (toolName) => (toolName.startsWith("mem_") ? "memory" : toolName === "todo" ? "todo" : AGENT_TOOLS.test(toolName) ? "agents" : "other");
const WIDGET_GROUP = { "gentle-todo": "todo", "gentle-agents": "agents" };
const PROMPT_ICONS = ["❯", "›", ">", "→", "▸", "λ"];

const KEYS = { memory: "engram", mode: "gentle:mode", yolo: "gentle:yolo" };
const BLOCK_WIDGETS = new Set(["gentle-todo", "gentle-agents"]);
// gentle-pi tools drawn without Pi's tool box (renderShell "self"); memory tools are handled apart.
const SELF_TOOLS = /^(todo|subagent_.*|orchestrator_.*|ask_user_.*|gentle_.*|codegraph|session_worktree_register)$/;
const GLYPHS = /[✿❀]\s?/g; // gentle-pi's card petals (CARD_GLYPH, AGENTS_GLYPH)
const BARS = new Set(["▎", "▌", "▍", "┃"]); // float panel accent bars
const PATCHED = Symbol.for("gentle-quiet.patched");
const SYMBOLS = /[\p{Extended_Pictographic}☀-➿️‍]/gu;
const ANSI = /\x1b\[[0-9;:]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;

let config = structuredClone(DEFAULTS);
let theme; // Pi's active theme, read from ctx.ui
// Last unmodified values written by the packages, so a /gentle-quiet change can
// redraw the footer without waiting for their next update.
const rawStatus = new Map();
const rawWidget = new Map();
let original; // { setStatus, setWidget } of the patched UI

function merge(user = {}) {
	return {
		memory: { ...DEFAULTS.memory, ...user.memory },
		permissions: { ...DEFAULTS.permissions, ...user.permissions },
		yoloBanner: user.yoloBanner ?? DEFAULTS.yoloBanner,
		// memoryCards.icon was the single shared icon of earlier versions; it now seeds the memory icon.
		icons: { ...DEFAULTS.icons, ...(typeof user.memoryCards?.icon === "string" ? { memory: user.memoryCards.icon } : {}), ...user.icons },
		tools: { ...DEFAULTS.tools, ...user.tools },
		quiet: { ...DEFAULTS.quiet, ...user.quiet },
		blocks: { ...DEFAULTS.blocks, ...user.blocks },
		subagents: { ...DEFAULTS.subagents, ...user.subagents },
		prompt: { ...DEFAULTS.prompt, ...user.prompt },
	};
}

function loadConfig() {
	if (!existsSync(CONFIG_FILE)) return structuredClone(DEFAULTS);
	try {
		return merge(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
	} catch {
		return structuredClone(DEFAULTS); // malformed file: keep the defaults rather than break the footer
	}
}

function saveConfig() {
	mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
	const tmp = `${CONFIG_FILE}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
	renameSync(tmp, CONFIG_FILE);
}

// Theme helpers that degrade to plain text when no theme is available.
const fg = (t, color, text) => {
	try { return t?.fg ? t.fg(color, text) : text; } catch { return text; }
};
const bold = (t, text) => {
	try { return t?.bold ? t.bold(text) : text; } catch { return text; }
};

const join = (...parts) => parts.filter(Boolean).join(" ");
const clean = (text) => text.replace(SYMBOLS, "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Line rewriting for tool rows and panels
// ---------------------------------------------------------------------------

/** Splits a rendered line into escape sequences and visible characters. */
function tokens(line) {
	const out = [];
	let i = 0;
	while (i < line.length) {
		ANSI.lastIndex = i;
		const esc = ANSI.exec(line);
		if (esc) {
			out.push({ esc: esc[0] });
			i += esc[0].length;
			continue;
		}
		const ch = String.fromCodePoint(line.codePointAt(i));
		out.push({ ch });
		i += ch.length;
	}
	return out;
}

/** Drops background colors from SGR sequences, keeping every other attribute. */
function stripBackground(seq) {
	const m = /^\x1b\[([0-9;:]*)m$/.exec(seq);
	if (!m || m[1] === "") return seq;
	const parts = m[1].split(";");
	const kept = [];
	for (let i = 0; i < parts.length; i++) {
		const n = Number(parts[i]);
		const extra = (mode) => (mode === 2 ? 4 : mode === 5 ? 2 : 0);
		if (n === 38 || n === 58) { // extended foreground/underline color: keep with its arguments
			const len = extra(Number(parts[i + 1]));
			kept.push(...parts.slice(i, i + 1 + len));
			i += len;
		} else if (n === 48) { // extended background: drop with its arguments
			i += extra(Number(parts[i + 1]));
		} else if (!((n >= 40 && n <= 47) || (n >= 100 && n <= 107) || n === 49)) {
			kept.push(parts[i]);
		}
	}
	return kept.length ? `\x1b[${kept.join(";")}m` : "";
}

/**
 * Flattens rendered rows: no backgrounds, no accent bar, no padding-only rows,
 * the shared indent removed and Pi's one-column margin added. gentle-pi's
 * petals become the configured icon. Rows without boxing only get the margin.
 */
function flatten(lines, { margin, group, dedentAll = false }) {
	const rows = [];
	for (const line of lines) {
		let boxed = false;
		let leading = true;
		const toks = [];
		for (const tok of tokens(line)) {
			if (tok.esc) {
				const stripped = stripBackground(tok.esc);
				if (stripped !== tok.esc) boxed = true;
				if (stripped) toks.push({ esc: stripped });
			} else if (leading && BARS.has(tok.ch)) {
				boxed = true; // accent bar: drop it, keep scanning the indent
			} else {
				if (tok.ch !== " ") leading = false;
				toks.push(tok);
			}
		}
		const visible = toks.filter((t) => t.ch).map((t) => t.ch).join("");
		if (boxed && visible.trim() === "") continue; // panel padding row
		rows.push({ toks, visible, boxed });
	}
	// Panels drop their shared indent on every row; tool rows only on rows that were boxed.
	const indents = rows.filter((r) => (dedentAll || r.boxed) && r.visible.trim()).map((r) => r.visible.length - r.visible.trimStart().length);
	const dedent = indents.length ? Math.min(...indents) : 0;
	return rows.map(({ toks, visible, boxed }) => {
		let skip = dedentAll || boxed ? Math.min(dedent, visible.length - visible.trimStart().length) : 0;
		let text = "";
		for (const tok of toks) {
			if (tok.esc) text += tok.esc;
			else if (skip > 0) skip--;
			else text += tok.ch;
		}
		const icon = config.icons[group] ?? "";
		text = text.replace(GLYPHS, icon ? `${icon} ` : "").replace(/(?:\s|\x1b\[[0-9;:]*m)+$/u, (tail) => tail.replace(/\s+/gu, "")); // trailing padding, colors kept
		return (margin ? " " : "") + text;
	});
}

/** Wraps a rendered component so its rows go through flatten(); input and mouse pass through. */
function flattened(component, options) {
	if (!component || typeof component.render !== "function") return component;
	return new Proxy(component, {
		get(target, key) {
			if (key === "render") {
				return (width) => {
					const reserve = options().margin ? 1 : 0;
					return flatten(target.render(Math.max(1, width - reserve)), options());
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, key, value) {
			return Reflect.set(target, key, value, target);
		},
	});
}

const toolOptions = (group) => () => ({ margin: config.tools.margin, group });
const blockOptions = (group) => () => ({ margin: true, group, dedentAll: true });

// ---------------------------------------------------------------------------
// Footer statuses and widgets
// ---------------------------------------------------------------------------

function memoryStatus(text) {
	if (!config.memory.show) return undefined;
	// "🧠 <project> · <state>"; an error state starts with ✗.
	const [project, ...rest] = text.replace(/^\S*🧠\S*\s*/u, "").split(" · ");
	const raw = rest.join(" · ").trim();
	const error = raw.startsWith("✗");
	const state = clean(raw);
	const plain = join(config.memory.label, config.memory.showProject && clean(project));
	if (!plain && !state) return undefined;
	if (error) return join(fg(theme, "dim", plain), fg(theme, "error", join("error", state)));
	if (state === "offline") return join(fg(theme, "dim", plain), fg(theme, "warning", state));
	return fg(theme, "dim", join(plain, state));
}

function permissionStatus(text) {
	if (!config.permissions.show) return undefined;
	const mode = text.replace(/^Permissions:\s*/i, "").trim().toLowerCase();
	if (!mode || (config.permissions.hideWhenNormal && mode === "normal")) return undefined;
	// "Perm: Normal"; the mode keeps its color, the label stays dim.
	const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
	const shownMode = capitalize(mode);
	const value = mode === "yolo" ? fg(theme, "warning", shownMode) : mode === "normal" ? fg(theme, "dim", shownMode) : fg(theme, "accent", shownMode);
	const label = capitalize(config.permissions.label.trim());
	return join(label && fg(theme, "dim", `${label}:`), value);
}

function rewriteStatus(key, text) {
	if (typeof text !== "string") return text;
	if (key === KEYS.memory) return memoryStatus(text);
	if (key === KEYS.mode) return permissionStatus(text);
	if (key === KEYS.yolo) return config.yoloBanner ? text : undefined;
	return text;
}

// Square outline spanning the full width, like the editor's rules, with one
// column of padding inside:
// ┌──────┐
// │ text │
// └──────┘
const BOX_CHROME = 4; // border and padding on both sides
const BOX_MIN_INNER = 10;

function boxed(rows, width, t) {
	const inner = width - BOX_CHROME;
	const line = (text) => fg(t, "border", text);
	const fit = (row) => {
		const clipped = visibleWidth(row) <= inner ? row : truncateToWidth(row, inner, "…");
		return clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
	};
	return [
		line(`┌${"─".repeat(inner + 2)}┐`),
		...rows.map((row) => `${line("│")} ${fit(row)} ${line("│")}`),
		line(`└${"─".repeat(inner + 2)}┘`),
	];
}

// Blank rows at the top and bottom of a panel are its padding, whether or not the
// theme paints them with a background; rows between content stay.
function trimBlankEdges(rows) {
	const blank = (row) => row.replace(/\x1b\[[0-9;:]*m/g, "").trim() === "";
	let start = 0;
	let end = rows.length;
	while (start < end && blank(rows[start])) start++;
	while (end > start && blank(rows[end - 1])) end--;
	return rows.slice(start, end);
}

// A panel component drawn flattened, inside the outline when it fits and is enabled.
function blockComponent(component, options, t) {
	if (!component || typeof component.render !== "function") return component;
	return new Proxy(component, {
		get(target, key) {
			if (key === "render") {
				return (width) => {
					const inner = width - BOX_CHROME;
					if (!config.blocks.border || inner < BOX_MIN_INNER) {
						return trimBlankEdges(flatten(target.render(Math.max(1, width - 1)), { ...options(), margin: true }));
					}
					// The panel keeps ~3 columns of margin and accent bar on the left, which
					// flatten() removes, and 2 on the right; render it wider to fill the box.
					const rows = trimBlankEdges(flatten(target.render(inner + 5), { ...options(), margin: false }));
					return rows.length ? boxed(rows, width, t ?? theme) : rows;
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, key, value) {
			return Reflect.set(target, key, value, target);
		},
	});
}

function rewriteWidget(key, content) {
	if (key === KEYS.yolo) return config.yoloBanner ? content : undefined;
	if (!BLOCK_WIDGETS.has(key) || !config.blocks.minimal || content === undefined) return content;
	const options = blockOptions(WIDGET_GROUP[key]);
	if (Array.isArray(content)) return flatten(content, options());
	if (typeof content === "function") return (tui, t, ...rest) => blockComponent(content(tui, t, ...rest), options, t);
	return content;
}

const trackedWidget = (key) => key === KEYS.yolo || BLOCK_WIDGETS.has(key);

function patch(ctx) {
	const ui = ctx?.ui;
	if (!ui) return;
	if (ui.theme) theme = ui.theme;
	if (ui[PATCHED]) return;
	try {
		const setStatus = ui.setStatus.bind(ui);
		const setWidget = ui.setWidget.bind(ui);
		ui.setStatus = (key, text) => {
			if (ui.theme) theme = ui.theme;
			if (Object.values(KEYS).includes(key)) rawStatus.set(key, text);
			setStatus(key, rewriteStatus(key, text));
		};
		ui.setWidget = (key, content, ...rest) => {
			if (trackedWidget(key)) rawWidget.set(key, [content, rest]);
			setWidget(key, rewriteWidget(key, content), ...rest);
		};
		ui[PATCHED] = true;
		original = { setStatus, setWidget };
	} catch {
		// Read-only UI object: only the clearing below applies.
	}
	// Entries written before the patch: drop the banner now; memory and mode
	// are rewritten on their next update (first memory call or tool call).
	if (!config.yoloBanner) {
		try { ui.setStatus?.(KEYS.yolo, undefined); } catch {}
		try { ui.setWidget?.(KEYS.yolo, undefined); } catch {}
	}
}

function redraw() {
	if (!original) return;
	for (const [key, text] of rawStatus) original.setStatus(key, rewriteStatus(key, text));
	for (const [key, [content, rest]] of rawWidget) original.setWidget(key, rewriteWidget(key, content), ...rest);
}

// ---------------------------------------------------------------------------
// Prompt editor
// ---------------------------------------------------------------------------

// Native editor plus a prompt icon in front of the first input line, copied
// from pi-pretty's PromptEditor without its rounded corners and side borders.
const PROMPT_WIDTH = 3; // " ❯ "
class PromptEditor extends CustomEditor {
	constructor(tui, editorTheme, keybindings, options) {
		super(tui, editorTheme, keybindings, options);
		this.userPaddingX = super.getPaddingX();
		super.setPaddingX(this.userPaddingX + PROMPT_WIDTH);
	}

	getPaddingX() {
		return this.userPaddingX;
	}

	setPaddingX(padding) {
		this.userPaddingX = Math.max(0, padding);
		super.setPaddingX(this.userPaddingX + PROMPT_WIDTH);
	}

	render(width) {
		const lines = super.render(width);
		const first = lines[1];
		const padding = this.userPaddingX + PROMPT_WIDTH;
		if (!first || padding > Math.floor((width - 1) / 2) || !first.startsWith(" ".repeat(padding))) return lines;
		const icon = [...(config.prompt.icon || "❯")][0];
		const colored = typeof this.borderColor === "function" ? this.borderColor(icon) : icon;
		lines[1] = `${first.slice(0, this.userPaddingX)} ${colored} ${first.slice(padding)}`;
		return lines;
	}
}

const promptEditorFactory = (tui, editorTheme, keybindings) => new PromptEditor(tui, editorTheme, keybindings);
let previousEditor;
let installedOn; // the UI our editor was last installed on, for hosts without getEditorComponent

// Pi drops custom editors when it resets extension UI (session switch, resume,
// fork, /reload), so this checks the editor actually in place every time.
function applyEditor(ctx) {
	const ui = ctx?.ui;
	if (ctx?.mode !== "tui" || typeof ui?.setEditorComponent !== "function") return;
	const current = typeof ui.getEditorComponent === "function" ? ui.getEditorComponent() : installedOn === ui ? promptEditorFactory : undefined;
	if (config.prompt.editor && current !== promptEditorFactory) {
		previousEditor = current;
		ui.setEditorComponent(promptEditorFactory);
		installedOn = ui;
	} else if (!config.prompt.editor && current === promptEditorFactory) {
		ui.setEditorComponent(previousEditor); // undefined restores Pi's default editor
		installedOn = undefined;
	}
}

// ---------------------------------------------------------------------------
// /gentle-quiet
// ---------------------------------------------------------------------------

const onOff = (value) => (value ? "on" : "off");
const shown = (label) => (label ? `"${label}"` : "none");

async function editLabel(ctx, title, current) {
	const value = await ctx.ui.input(`${title} (empty for none)`, current);
	return value === undefined ? current : value.trim();
}

async function pickIcon(ctx, title, icons, current, allowNone = true) {
	const options = [...icons, ...(allowNone ? ["none"] : []), "custom…"];
	const choice = await ctx.ui.select(`${title} (now: ${current || "none"})`, options);
	if (choice === undefined) return current;
	if (choice === "none") return "";
	if (choice === "custom…") return (await editLabel(ctx, title, current)) || current;
	return choice;
}

async function configure(ctx) {
	while (true) {
		const items = [
			[`Memory in footer: ${onOff(config.memory.show)}`, () => { config.memory.show = !config.memory.show; }],
			[`Memory label: ${shown(config.memory.label)}`, async () => { config.memory.label = await editLabel(ctx, "Memory label", config.memory.label); }],
			[`Memory project name: ${onOff(config.memory.showProject)}`, () => { config.memory.showProject = !config.memory.showProject; }],
			[`Permission in footer: ${onOff(config.permissions.show)}`, () => { config.permissions.show = !config.permissions.show; }],
			[`Permission label: ${shown(config.permissions.label)}`, async () => { config.permissions.label = await editLabel(ctx, "Permission label", config.permissions.label); }],
			[`Permission when normal: ${config.permissions.hideWhenNormal ? "hidden" : "shown"}`, () => { config.permissions.hideWhenNormal = !config.permissions.hideWhenNormal; }],
			[`YOLO banner: ${config.yoloBanner ? "shown" : "hidden"}`, () => { config.yoloBanner = !config.yoloBanner; }],
			...ICON_GROUPS.map(([group, title]) => [`${title}: ${shown(config.icons[group])}`, async () => { config.icons[group] = await pickIcon(ctx, title, group === "memory" ? MEMORY_ICONS : CARD_ICONS, config.icons[group]); }]),
			[`Tool row margin: ${onOff(config.tools.margin)}`, () => { config.tools.margin = !config.tools.margin; }],
			[`Quiet tools (new calls): ${onOff(config.quiet.enabled)}`, () => { config.quiet.enabled = !config.quiet.enabled; }],
			[`Expand hint: ${config.quiet.hint}`, () => { config.quiet.hint = HINT_MODES[(HINT_MODES.indexOf(config.quiet.hint) + 1) % HINT_MODES.length]; }],
			[`Codemode detail: ${config.quiet.codemode}`, () => { config.quiet.codemode = CODEMODE_DETAILS[(CODEMODE_DETAILS.indexOf(config.quiet.codemode) + 1) % CODEMODE_DETAILS.length]; }],
			[`Quiet preview lines: ${config.quiet.preview}`, () => { config.quiet.preview = QUIET_PREVIEWS[(QUIET_PREVIEWS.indexOf(config.quiet.preview) + 1) % QUIET_PREVIEWS.length]; }],
			[`Todos/Agents blocks: ${config.blocks.minimal ? "minimal" : "original"}`, () => { config.blocks.minimal = !config.blocks.minimal; }],
			[`Todos/Agents border: ${onOff(config.blocks.border)}`, () => { config.blocks.border = !config.blocks.border; }],
			[`Subagent results: ${config.subagents.minimal ? "minimal" : "original"} (restart to apply)`, () => { config.subagents.minimal = !config.subagents.minimal; }],
			[`Prompt icon in input: ${onOff(config.prompt.editor)}`, () => { config.prompt.editor = !config.prompt.editor; }],
			[`Prompt icon in sent messages: ${onOff(config.prompt.userMessage)}`, () => { config.prompt.userMessage = !config.prompt.userMessage; }],
			[`Prompt icon: ${shown(config.prompt.icon)}`, async () => { config.prompt.icon = await pickIcon(ctx, "Prompt icon", PROMPT_ICONS, config.prompt.icon, false); }],
			["Reset to defaults", () => { config = structuredClone(DEFAULTS); }],
			["Done", undefined],
		];
		const choice = await ctx.ui.select("Gentle Quiet", items.map(([label]) => label));
		const action = items.find(([label]) => label === choice)?.[1];
		if (!action) return;
		await action();
		try {
			saveConfig();
		} catch (error) {
			ctx.ui.notify(`Could not save ${CONFIG_FILE}: ${error?.message ?? error}`, "error");
		}
		redraw();
		applyEditor(ctx);
	}
}

// ---------------------------------------------------------------------------
// Quiet tools: Pi's own tools as a call row plus a one-line summary
// ---------------------------------------------------------------------------

const QUIET_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "codemode"]);
const QUIET_PREVIEWS = [0, 1, 3, 5];
const HOME = os.homedir();

const shortPath = (value) => {
	const text = typeof value === "string" ? value : "";
	return text.startsWith(HOME) ? `~${text.slice(HOME.length)}` : text;
};
const firstLine = (value, max = 100) => {
	const lines = String(value ?? "").split("\n");
	const head = lines[0].length > max ? `${lines[0].slice(0, max - 1)}…` : lines[0];
	return lines.length > 1 && head === lines[0] ? `${head} …` : head;
};
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const textOf = (result) => (result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
// Output lines without Pi's bracketed footers ("[Truncated: …]", "[Showing lines …]").
const outputLines = (text) => text.replace(/\s+$/, "").split("\n").filter((line, i, all) => line !== "" && !(i >= all.length - 2 && /^\[.*\]$/.test(line)));

function quietCall(toolName, args = {}, t) {
	const title = (name) => fg(t, "toolTitle", bold(t, name));
	const accent = (text) => fg(t, "accent", text);
	const dim = (text) => fg(t, "dim", text);
	switch (toolName) {
		case "read": {
			const range = args.offset !== undefined || args.limit !== undefined
				? fg(t, "warning", `:${args.offset ?? 1}${args.limit !== undefined ? `-${(args.offset ?? 1) + args.limit - 1}` : ""}`)
				: "";
			return `${title("read")} ${accent(shortPath(args.path ?? args.file_path))}${range}`;
		}
		case "bash":
			return title(`$ ${firstLine(args.command)}`);
		case "edit":
		case "write":
			return `${title(toolName)} ${accent(shortPath(args.path ?? args.file_path))}`;
		case "grep":
			return join(title("grep"), accent(`/${args.pattern ?? ""}/`), dim(`in ${shortPath(args.path) || "."}`), args.glob && dim(`(${args.glob})`));
		case "find":
			return join(title("find"), accent(args.pattern ?? ""), dim(`in ${shortPath(args.path) || "."}`));
		case "ls":
			return join(title("ls"), accent(shortPath(args.path) || "."));
		case "codemode": {
			const code = String(args.code ?? "");
			const lines = code.split("\n").filter((line) => line.trim() !== "").length;
			return join(title("codemode"), dim(plural(lines, "line")));
		}
		default:
			return title(toolName);
	}
}

function diffCounts(diff) {
	let added = 0;
	let removed = 0;
	for (const line of String(diff ?? "").split("\n")) {
		if (/^\+\s*\d/.test(line)) added++;
		else if (/^-\s*\d/.test(line)) removed++;
	}
	return { added, removed };
}

const seconds = (ms) => (typeof ms === "number" && ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : "");

/** One summary line plus up to `preview` dim output lines. */
const CODEMODE_DETAILS = ["summary", "failures", "all"];
const CODEMODE_CALL_LIMIT = 8;

/** Child calls Pi recorded for a codemode run (details.calls). */
function codemodeCalls(result) {
	const calls = result?.details?.calls;
	if (!Array.isArray(calls)) return [];
	return calls.filter((call) => call && typeof call === "object").map((call) => ({
		name: typeof call.name === "string" ? call.name.replace(/[\x00-\x1f\x7f]/g, "") : "?",
		status: call.status,
		durationMs: typeof call.durationMs === "number" ? call.durationMs : undefined,
		error: typeof call.error === "string" ? call.error : undefined,
	}));
}

// "mcp__context7__query-docs" -> "context7/query-docs"; Pi tools keep their name.
const callName = (name) => {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
	return mcp ? `${mcp[1]}/${mcp[2]}` : name;
};
const callSource = (name) => /^mcp__(.+?)__/.exec(name)?.[1] ?? name;
const callFailed = (call) => call.status === "error" || call.status === "cancelled" || Boolean(call.error);

function codemodeSummary(result, context, t, isError) {
	const calls = codemodeCalls(result);
	const failed = calls.filter(callFailed);
	const time = seconds(context.durationMs);
	const sources = [...new Set(calls.map((call) => callSource(call.name)))];
	const sourceText = sources.length > 3 ? `${sources.slice(0, 3).join(", ")} +${sources.length - 3}` : sources.join(", ");
	let summary;
	if (failed.length) {
		summary = fg(t, "error", `✗ ${failed.length} of ${plural(calls.length, "call")} failed`);
	} else if (isError) {
		summary = fg(t, "error", `✗ ${firstLine(outputLines(textOf(result))[0] ?? "error", 80)}`);
	} else {
		const what = calls.length ? join(plural(calls.length, "call"), sourceText && `· ${sourceText}`) : "no calls";
		summary = join(fg(t, "success", "✓"), fg(t, "dim", join(what, time && `· ${time}`)));
	}
	const listed = config.quiet.codemode === "all" ? calls : config.quiet.codemode === "failures" ? failed : [];
	const rows = listed.slice(0, CODEMODE_CALL_LIMIT).map((call) => {
		const mark = callFailed(call) ? fg(t, "error", "✗") : call.status === "running" ? fg(t, "warning", "…") : fg(t, "success", "✓");
		const reason = callFailed(call) && call.error ? fg(t, "error", firstLine(call.error, 80)) : "";
		const duration = !callFailed(call) && call.durationMs !== undefined ? fg(t, "dim", seconds(call.durationMs) || `${Math.round(call.durationMs)}ms`) : "";
		return join(mark, fg(t, "toolTitle", callName(call.name)), reason, duration);
	});
	if (listed.length > CODEMODE_CALL_LIMIT) rows.push(fg(t, "dim", `… ${listed.length - CODEMODE_CALL_LIMIT} more`));
	// The script itself is always hidden, so the expand hint always applies.
	return { summary, fixed: rows, hidden: true };
}

function quietSummary(toolName, result, args = {}, context = {}, t) {
	const text = textOf(result);
	const lines = outputLines(text);
	const isError = context.isError || result?.isError;
	const ok = (summary) => join(fg(t, "success", "✓"), fg(t, "dim", join(summary, seconds(context.durationMs) && `· ${seconds(context.durationMs)}`)));
	if (toolName === "codemode") return codemodeSummary(result, context, t, isError);
	if (isError) {
		const code = /Command exited with code (\d+)/.exec(text)?.[1];
		const message = lines.find((line) => !/^Command exited with code/.test(line)) ?? "error";
		const head = code ? `exit ${code}` : firstLine(message, 80);
		return { summary: fg(t, "error", `✗ ${head}`), preview: lines.filter((line) => !/^Command exited with code/.test(line)), keepEnd: true, minPreview: code ? 1 : 0, color: "error" };
	}
	switch (toolName) {
		case "read": {
			if ((result?.content ?? []).some((c) => c?.type === "image")) return { summary: ok("image") };
			return { summary: ok(plural(lines.length, "line")), preview: lines };
		}
		case "bash":
			return { summary: ok(lines.length ? plural(lines.length, "line") : "no output"), preview: lines, keepEnd: true };
		case "edit": {
			const { added, removed } = diffCounts(result?.details?.diff);
			const counts = added || removed ? `${fg(t, "toolDiffAdded", `+${added}`)} ${fg(t, "toolDiffRemoved", `-${removed}`)}` : "edited";
			return { summary: join(fg(t, "success", "✓"), counts, seconds(context.durationMs) && fg(t, "dim", `· ${seconds(context.durationMs)}`)), preview: String(result?.details?.diff ?? "").split("\n").filter((line) => /^[+-]\s*\d/.test(line)), diff: true, minPreview: 2 };
		}
		case "write": {
			const written = String(args.content ?? "").split("\n").length;
			return { summary: ok(`${plural(written, "line")} written`) };
		}
		case "grep":
			return { summary: ok(lines.length ? plural(lines.length, "match", "matches") : "no matches"), preview: lines };
		case "find":
			return { summary: ok(lines.length ? plural(lines.length, "file") : "no files"), preview: lines };
		case "ls":
			return { summary: ok(lines.length ? plural(lines.length, "entry", "entries") : "empty"), preview: lines };
		default:
			return { summary: ok(lines.length ? plural(lines.length, "line") : "done"), preview: lines, keepEnd: true };
	}
}

function quietResultText(toolName, result, options, context, t) {
	const prefix = fg(t, "dim", "└");
	if (options.isPartial) {
		const runningCalls = toolName === "codemode" ? codemodeCalls(result).length : 0;
		const running = fg(t, "dim", runningCalls ? `running… ${plural(runningCalls, "call")}` : "running…");
		const tail = config.quiet.preview > 0 ? outputLines(textOf(result)).slice(-config.quiet.preview) : [];
		return { summary: `${prefix} ${running}`, hint: "", rest: tail.map((line) => `  ${fg(t, "dim", firstLine(line, 200))}`) };
	}
	const info = quietSummary(toolName, result, context.args ?? {}, context, t);
	const count = Math.max(config.quiet.preview, info.minPreview ?? 0);
	const source = info.preview ?? [];
	const shown = info.fixed ?? (count > 0 ? (info.keepEnd ? source.slice(-count) : source.slice(0, count)) : []);
	const color = (line) => (info.diff ? fg(t, line.startsWith("+") ? "toolDiffAdded" : "toolDiffRemoved", line) : fg(t, info.color ?? "dim", line));
	// Something stays hidden: more output than the preview, or written content.
	const hidden = info.hidden ?? (source.length > shown.length || (toolName === "write" && String(context.args?.content ?? "") !== ""));
	return {
		summary: `${prefix} ${info.summary}`,
		hint: hidden ? expandHint(t) : "",
		// Fixed rows (codemode calls) arrive colored; the component truncates them to width.
		rest: info.fixed ? shown.map((line) => `  ${line}`) : shown.map((line) => `  ${color(firstLine(line, 200))}`),
	};
}

// Pi's own hint, so a rebound expand key shows its actual binding.
function expandHint(t) {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return fg(t, "dim", "ctrl+o to expand");
	}
}

/** Summary row with the expand hint right-aligned; the hint is dropped when it does not fit. */
const HINT_MODES = ["last", "all", "never"];
// Calls in the order they first rendered; the hint follows the newest finished one.
// Pi's ctrl+o expands every call at once, so one visible hint is enough.
const callOrder = new Map();
let latestFinished = -1;

function orderOf(toolCallId, finished) {
	let order = toolCallId === undefined ? undefined : callOrder.get(toolCallId);
	if (order === undefined) {
		order = callOrder.size;
		if (toolCallId !== undefined) callOrder.set(toolCallId, order);
		else callOrder.set(Symbol("call"), order);
	}
	if (finished) latestFinished = Math.max(latestFinished, order);
	return order;
}

const hintVisible = (order) => config.quiet.hint === "all" || (config.quiet.hint === "last" && order === latestFinished);

function quietResultComponent({ summary, hint: available, rest }, order) {
	return {
		render(width) {
			const hint = available && hintVisible(order) ? available : "";
			const lines = [];
			const left = ` ${summary}`;
			const gap = width - visibleWidth(left) - visibleWidth(hint) - 1;
			lines.push(hint && gap >= 2 ? `${left}${" ".repeat(gap)}${hint} ` : truncateToWidth(left, width, "…"));
			for (const line of rest) lines.push(truncateToWidth(` ${line}`, width, "…"));
			return lines;
		},
		invalidate() {},
	};
}

/** Shifts a component one column right (Pi's text margin) and drops its backgrounds. */
function padded(component) {
	if (!component || typeof component.render !== "function") return component;
	// Expanded outputs can be thousands of lines and redraw on every frame:
	// reuse the previous result while the native lines are unchanged.
	let lastIn;
	let lastOut;
	return new Proxy(component, {
		get(target, key) {
			if (key === "render") {
				return (width) => {
					const lines = target.render(Math.max(1, width - 1));
					if (lastIn && lastIn.length === lines.length && lines.every((line, i) => line === lastIn[i])) return lastOut;
					lastIn = lines;
					// Lines without escape sequences have no background to drop.
					lastOut = lines.map((line) => ` ${line.includes("\x1b[") ? tokens(line).map((tok) => (tok.esc ? stripBackground(tok.esc) : tok.ch)).join("") : line}`);
					return lastOut;
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, key, value) {
			return Reflect.set(target, key, value, target);
		},
	});
}

function quietRenderers(toolName, renderers) {
	return {
		...renderers,
		renderShell: "self", // no tool background box; the rows carry Pi's margin themselves
		renderCall(args, t) {
			return new Text(quietCall(toolName, args, t), 1, 0);
		},
		renderResult(result, options = {}, t, context = {}) {
			const state = context.state && typeof context.state === "object" ? context.state : undefined;
			if (options.expanded && !options.isPartial && typeof renderers.renderResult === "function") {
				try {
					// Pi's renderer reuses its own previous component only, never ours.
					const native = renderers.renderResult(result, options, t, { ...context, lastComponent: state?.quietNative });
					if (state) state.quietNative = native;
					if (native) return padded(native);
				} catch {
					// fall back to the summary below
				}
			}
			const order = orderOf(context.toolCallId, !options.isPartial);
			return quietResultComponent(quietResultText(toolName, result, options, context, t), order);
		},
	};
}

// ---------------------------------------------------------------------------
// Tool renderers
// ---------------------------------------------------------------------------

async function loadEngramChrome() {
	try {
		return await import(pathToFileURL(ENGRAM_CHROME).href);
	} catch {
		return undefined; // engram moved or changed: keep its own cards
	}
}

// Memory tool rows drawn like Pi's own: bold tool title, accent argument,
// and a colored status mark on the result line.
function memoryRenderers(chrome, toolName, renderers) {
	return {
		...renderers,
		renderCall(args, t) {
			const name = chrome.humanToolName(toolName);
			const arg = chrome.compactToolArg?.(toolName, args) ?? "";
			const title = fg(t, "toolTitle", bold(t, join(config.icons.memory, name)));
			return flattened(new Text(join(title, arg && fg(t, "accent", arg)), 0, 0), toolOptions("memory"));
		},
		renderResult(result, options = {}, t, context = {}) {
			const text = chrome.renderResultText(toolName, result, {
				expanded: options.expanded,
				isPartial: options.isPartial,
				isError: context?.isError,
			});
			const [first, ...body] = text.split("\n");
			const status = first.replace(/^↳\s*/, "");
			let line;
			if (options.isPartial) line = fg(t, "dim", status);
			else if (status.startsWith("✗")) line = fg(t, "error", status);
			else line = join(fg(t, "success", "✓"), fg(t, "dim", status.replace(/^✓\s*/, "")));
			return flattened(new Text([`${fg(t, "dim", "└")} ${line}`, ...body].join("\n"), 0, 0), toolOptions("memory"));
		},
	};
}

// gentle-pi's self-drawn tool rows: same content, Pi's margin and the group's icon.
function gentleRenderers(renderers, group) {
	const options = toolOptions(group);
	const wrap = (render) =>
		typeof render === "function" ? (...args) => flattened(render(...args), options) : render;
	return { ...renderers, renderCall: wrap(renderers.renderCall), renderResult: wrap(renderers.renderResult) };
}

// ---------------------------------------------------------------------------
// Subagent results (gentle-agents.result messages)
// ---------------------------------------------------------------------------

const AGENTS_RESULT_TYPE = "gentle-agents.result";
// gentle-agents prefixes the answer with "Subagent <agent> (task <id>) <status>." and a blank line.
const COMPLETION_HEADER = /^Subagent [^\n]+ \(task [^\n]*\) [^\n]+\.$/;

function agentAnswer(message) {
	const content = message?.content;
	const text = typeof content === "string" ? content : (content ?? []).filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n");
	const split = text.indexOf("\n\n");
	if (split >= 0 && COMPLETION_HEADER.test(text.slice(0, split)) && text.slice(split + 2).trim()) return text.slice(split + 2);
	return text;
}

function agentResultRenderer(message, options = {}, t) {
	const details = message?.details?.gentleAgents ?? {};
	const agent = clean(String(details.agent ?? "subagent")) || "subagent";
	const completed = details.status === "completed";
	const status = completed ? "done" : String(details.status ?? "finished").replace(/_/g, " ");
	const answer = agentAnswer(message).replace(/\s+$/, "").split("\n");
	const summary = answer.find((line) => line.trim() !== "")?.trim() ?? "";
	const head = join(fg(t, "toolTitle", bold(t, join(config.icons.agents, agent))), fg(t, "dim", "·"), fg(t, completed ? "success" : "error", status));
	const hidden = answer.filter((line) => line.trim() !== "").length > 1;
	return {
		render(width) {
			if (options.expanded) {
				return [` ${head}`, ...answer.map((line) => (line.trim() ? truncateToWidth(`   ${fg(t, "toolOutput", line)}`, width, "…") : ""))];
			}
			const hint = hidden ? expandHint(t) : "";
			const left = ` ${head}`;
			const gap = width - visibleWidth(left) - visibleWidth(hint) - 1;
			const top = hint && gap >= 2 ? `${left}${" ".repeat(gap)}${hint} ` : truncateToWidth(left, width, "…");
			return summary ? [top, truncateToWidth(` ${fg(t, "dim", "└")} ${fg(t, "dim", summary)}`, width, "…")] : [top];
		},
		invalidate() {},
	};
}

export default async function (pi) {
	config = loadConfig();
	const chrome = await loadEngramChrome();

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig();
		callOrder.clear(); // a new or resumed session redraws its calls from the start
		latestFinished = -1;
		patch(ctx);
		applyEditor(ctx);
	});
	for (const event of ["before_agent_start", "tool_execution_end", "turn_end"]) {
		pi.on(event, (_event, ctx) => {
			patch(ctx);
			applyEditor(ctx);
		});
	}
	// Pi resets extension UI after shutdown; forget the editor so the next start reinstalls it.
	pi.on("session_shutdown", () => {
		installedOn = undefined;
	});

	// Pi uses the first extension that registered a message type; local extensions load
	// before packages, and a package must be listed before gentle-pi to take over.
	if (config.subagents.minimal && typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer(AGENTS_RESULT_TYPE, agentResultRenderer);
	}

	pi.registerMarkdownTransformer?.((markdown, context) => {
		if (!config.prompt.userMessage || context?.messageType !== "user" || markdown.trim() === "") return markdown;
		return ` ${config.prompt.icon || "❯"} ${markdown}`;
	});

	pi.registerCommand("gentle-quiet", {
		description: "Configure the minimal footer, tool rows, blocks and prompt",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			patch(ctx);
			await configure(ctx);
		},
	});

	if (typeof pi.registerToolRenderer === "function") {
		pi.registerToolRenderer((toolName, next) => {
			const renderers = next();
			if (!renderers) return renderers;
			if (toolName.startsWith("mem_") && chrome?.humanToolName && chrome?.renderResultText) {
				return memoryRenderers(chrome, toolName, renderers);
			}
			if (SELF_TOOLS.test(toolName)) return gentleRenderers(renderers, iconGroup(toolName));
			if (QUIET_TOOLS.has(toolName) && config.quiet.enabled) return quietRenderers(toolName, renderers);
			return renderers;
		});
	}
}
