// gentle-quiet: a quiet, Pi-native look for gentle-pi and gentle-engram, styled with Pi's theme.
// Configure it with /gentle-quiet; choices are saved to <Pi agent dir>/gentle-quiet.json.
//   footer  "🧠 project · ✓ 4 results"   -> "mem 4 results"   (dim, like Pi's footer)
//   footer  "Permissions: YOLO"          -> "Perm: Yolo"       (Yolo in warning color)
//   banner  "🚀 YOLO ON 🔥 — ..."         -> hidden (above the editor and in the footer)
//   tools   "🧠 search “x” …", "✿todo · write", "❀ agent run"
//                                         -> " 󰧑 search “x”", " ≡ todo · write", " ◈ agent run"
//           (Pi's one-column margin; memory rows drawn like Pi's own tool rows)
//   footer  Pi's footer -> " ~/app main ±2 +3 -1 · model · effort      ctx ▰▰▱▱▱▱▱▱ 28% · $1.75 sub"
//           plus the extension statuses row (Gentle Shell's bar, without the brand and usage)
//   agents  subagent results -> " ◈ gentle-ai-explore · done" + " └ first line of the answer"
//   blocks  Todos and Agents panels lose their background, accent bar and
//           padding rows, line up with that same margin and get a square
//           outline in the theme's border color
//   sidebar fullscreen terminals with 140+ columns: the status line becomes a bar on top and Agents and
//           Todos a column on the right (Gentle Shell's layout, drawn in this style); narrower ones keep them in place
//   quiet   read/bash/edit/write/grep/find/ls/codemode collapse to
//             " read ~/x.ts"
//             " └ ✓ 120 lines"
//           with ctrl+o expanding to Pi's own output (execution stays Pi's)
//   prompt  "❯ " flush with the margin before the input and sent user messages (from pi-pretty,
//           without its rounded borders, so the editor stays native)
// Neither package offers display options, so this rewrites their UI writes.
// @ts-nocheck

import { CustomEditor, getAgentDir, keyHint, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
	// memory: outline brain U+100000 from ~/.local/share/fonts/GentleBrain.ttf (an outlined
	// nf-fae-brain; the terminal falls back to it), drawn in the theme color like any text.
	icons: { memory: "\u{100000}", todo: "≡", agents: "◈", other: "›" },
	// restyle: gentle-pi and memory tool rows redrawn quietly (false leaves them as their packages draw them);
	// margin: Pi's one-column margin for those rows.
	// tones: "claude" paints tool call rows in Claude Code's fixed greys; "theme" uses Pi's toolTitle/accent colors;
	// "soft" uses the theme's toolTitle for the name and muted for the path, without bold.
	tools: { restyle: true, margin: true, tones: "claude" },
	// Pi's own tools collapsed to a call row and a one-line summary; ctrl+o expands to Pi's full output.
	// codemode: "summary" (one line), "failures" (plus each failed call) or "all" (every call).
	// hint: "ctrl+o to expand" on the most recent call ("last"), on every call ("all") or nowhere ("never").
	// codemodeOutput: lines of the script's own output shown under a codemode summary.
	quiet: { enabled: true, preview: 0, codemode: "failures", codemodeOutput: 3, hint: "last" },
	// Gentle-Shell-style status line in place of Pi's footer; enabled: false gives the footer back to Pi.
	// tokens: "cache" (R W CH%), "all" (↑ ↓ R W CH%) or "off".
	// subscriptionProviders: providers billed by a plan that Pi cannot detect (no OAuth), e.g. claude-bridge.
	// estimateCost: API-equivalent cost for zero-priced responses (claude-bridge), from Anthropic prices.
	// mcp: "MCP online/installed" among the statuses.
	// usage: plan windows (5h / week) from the provider's rate-limit response headers.
	statusLine: { enabled: true, changes: true, tokens: "cache", cost: true, estimateCost: true, mcp: true, usage: true, subscriptionProviders: [] },
	subagents: { minimal: true }, // subagent result messages as a row plus a summary line; applies after restart
	blocks: { minimal: true, border: true }, // flatten the Todos and Agents panels; square theme-colored outline
	// Status, Agents and Todos in a column beside the conversation once the fullscreen terminal
	// has at least minColumns columns; narrower terminals keep them above and below the input.
	sidebar: { enabled: true, minColumns: 140 },
	prompt: { icon: "❯", editor: true, userMessage: true },
};
const CARD_ICONS = ["◇", "◆", "◈", "○", "●", "≡", "∴", "›", "·"];
// Memory-specific choices: brain, history (recall) and database from the Nerd Font,
// plus a plain Unicode recall arrow for fonts without Nerd Font glyphs.
const MEMORY_ICONS = ["\u{100000}", "\u{E28C}", "\u{F09D1}", "\u{F02DA}", "\u{F01BC}", "⟲"];
const ICON_GROUPS = [["memory", "Memory icon"], ["todo", "Todo icon"], ["agents", "Agents icon"], ["other", "Other gentle tools icon"]];
const AGENT_TOOLS = /^(subagent_.*|orchestrator_.*)$/;
const iconGroup = (toolName) => (toolName.startsWith("mem_") ? "memory" : toolName === "todo" ? "todo" : AGENT_TOOLS.test(toolName) ? "agents" : "other");
const WIDGET_GROUP = { "gentle-todo": "todo", "gentle-agents": "agents" };
const PROMPT_ICONS = ["❯", "›", ">", "→", "▸", "λ"];

const KEYS = { memory: "engram", mode: "gentle:mode", yolo: "gentle:yolo" };
const BLOCK_WIDGETS = new Set(["gentle-todo", "gentle-agents"]);
// gentle-pi tools drawn without Pi's tool box (renderShell "self"); memory tools are handled apart.
const SELF_TOOLS = /^(todo|subagent_.*|orchestrator_.*|ask_user_.*|gentle_.*|codegraph|session_worktree_register)$/;
const GLYPHS = /(?:[✿❀]|🤖|🌹)\s?/gu; // gentle-pi's card petals (CARD_GLYPH, AGENTS_GLYPH), orchestrator robot and rdd rose
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
		tools: toneMode({ ...DEFAULTS.tools, ...user.tools }),
		quiet: { ...DEFAULTS.quiet, ...user.quiet },
		blocks: { ...DEFAULTS.blocks, ...user.blocks },
		sidebar: { ...DEFAULTS.sidebar, ...user.sidebar },
		subagents: { ...DEFAULTS.subagents, ...user.subagents },
		statusLine: tokensMode({ ...DEFAULTS.statusLine, ...user.statusLine }),
		prompt: { ...DEFAULTS.prompt, ...user.prompt },
	};
}

const TONE_MODES = ["claude", "theme", "soft"];
function toneMode(tools) {
	if (!TONE_MODES.includes(tools.tones)) tools.tones = DEFAULTS.tools.tones;
	return tools;
}

const TOKEN_MODES = ["cache", "all", "off"];
// Older versions saved tokens as true/false.
function tokensMode(statusLine) {
	if (!Array.isArray(statusLine.subscriptionProviders)) statusLine.subscriptionProviders = [];
	statusLine.subscriptionProviders = statusLine.subscriptionProviders.filter((id) => typeof id === "string");
	const value = statusLine.tokens;
	statusLine.tokens = value === true ? "all" : value === false ? "off" : TOKEN_MODES.includes(value) ? value : DEFAULTS.statusLine.tokens;
	return statusLine;
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
	const drawn = rows.map(({ toks, visible, boxed }) => {
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
	return dedentAll ? drawn : joinElapsed(drawn);
}

const ELAPSED_ROW = /^\s*\d+(?:\.\d+)?(?:ms|s|m|h)(?:\d+(?:ms|s|m))?\s*$/;
const SGR = /\x1b\[[0-9;:]*m/g;

/** gentle-pi closes a finished call with a row holding only its duration, far right and loose;
 * it joins the last row above it instead. */
function joinElapsed(rows) {
	const out = [];
	for (const row of rows) {
		const text = row.replace(SGR, "");
		const last = out.length - 1;
		if (ELAPSED_ROW.test(text) && last >= 0 && out[last].replace(SGR, "").trim() !== "") {
			out[last] = `${out[last].replace(/(?:\s|\x1b\[[0-9;:]*m)+$/u, (tail) => tail.replace(/\s+/gu, ""))} ${fg(theme, "dim", `· ${text.trim()}`)}`;
		} else out.push(row);
	}
	return out;
}

/** Wraps a rendered component so its rows go through flatten(); input and mouse pass through. */
const flattenedProxies = new WeakSet();
function flattened(component, options) {
	if (!component || typeof component.render !== "function") return component;
	// Pi hands a row's last component back to its renderer, which may return it again: wrapping it a
	// second time would flatten (and indent) its rows once more on every redraw.
	if (flattenedProxies.has(component)) return component;
	const proxy = new Proxy(component, {
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
	flattenedProxies.add(proxy);
	return proxy;
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

// A row too long for the box, split where its right-aligned details start: the left part keeps the
// row, the details (model, effort, tokens, time) go on a muted row of their own, under the name.
function stackRow(row, inner, t, title = false) {
	if (visibleWidth(row) <= inner) return [row];
	const toks = tokens(row);
	const text = toks.map((tok) => tok.ch ?? "").join("");
	const gap = [...text.matchAll(/ {3,}(?=\S)/g)].pop();
	if (!gap) return [row];
	let seen = 0;
	let left = "";
	for (const tok of toks) {
		if (tok.esc) left += tok.esc;
		else if (seen++ < gap.index) left += tok.ch;
	}
	const right = text.slice(gap.index + gap[0].length).trim();
	// The title's detail (the batch clock) stays on the title row, right-aligned.
	if (title) {
		const room = inner - visibleWidth(left) - 2;
		if (room >= visibleWidth(right)) return [`${left}${" ".repeat(inner - visibleWidth(left) - visibleWidth(right))}${fg(t, "muted", right)}`];
		return [truncateToWidth(left, inner, "…")];
	}
	// The details line up under the name, past the status icon and however many spaces follow it.
	const indent = Math.min(8, /^\s*\S+\s+/.exec(text.slice(0, gap.index))?.[0].length ?? 2);
	return [truncateToWidth(left, inner, "…"), `${" ".repeat(indent)}${fg(t, "muted", truncateToWidth(right, inner - indent, "…"))}`];
}

// The scroll indicator row ("↑↓ 1–10/13 · ctrl+shift+↑/↓", gentle-pi writes an en dash): the wheel scrolls the card anyway.
const SCROLL_ROW = /^\s*↑↓\s+\d+[-–]\d+\/\d+/u;
// Task rows reflowed so every line of a task lines up under the task's own text, past its status icon.
// gentle-pi may already have split a long title into rows without an icon; they belong to the task above,
// so they are joined back into its text before it is wrapped once to the box.
const TASK_GLYPH = /^((?:\x1b\[[0-9;:]*m)*[○◐⊘✓✕](?:\x1b\[[0-9;:]*m)*) (.*)$/su;
const LEADING_SPACE = /^((?:\x1b\[[0-9;:]*m)*)\s+/;
const STRIKE_OFF = "\x1b[29m"; // wrapping keeps a struck-through title's style open: close it on every line
function hangRows(rows, inner, t) {
	const out = [];
	let task; // { icon, text } of the task still collecting continuation rows
	const flush = () => {
		if (!task) return;
		const { icon, text } = task;
		task = undefined;
		const lines = typeof PiTui.wrapTextWithAnsi === "function" && visibleWidth(`${icon} ${text}`) > inner ? PiTui.wrapTextWithAnsi(text, inner - 2) : [text];
		lines.forEach((line, i) => out.push(`${i === 0 ? icon : " "} ${line}${text.includes("\x1b[9m") ? STRIKE_OFF : ""}`.replace(/^ {2}/, "  ")));
	};
	rows.forEach((row, index) => {
		if (index === 0) return out.push(...stackRow(row, inner, t, true));
		const text = row.replace(SGR, "");
		const start = TASK_GLYPH.exec(row);
		if (start) {
			flush();
			task = { icon: start[1], text: start[2] };
		} else if (task && text.trim() !== "" && !/^\s*…\s/u.test(text)) {
			task.text += ` ${row.replace(LEADING_SPACE, "$1")}`;
		} else {
			flush();
			out.push(row);
		}
	});
	flush();
	return out;
}

// A panel's rows drawn flattened, inside the outline when it fits and is enabled. In the side column
// (`rail`) a blank row separates the title from the list and, for `stack`, a long row's details
// move to their own row instead of being cut off.
function drawBlock(target, width, options, t, rail = {}) {
	const inner = width - BOX_CHROME;
	if (!config.blocks.border || inner < BOX_MIN_INNER) {
		return trimBlankEdges(flatten(target.render(Math.max(1, width - 1)), { ...options(), margin: true }));
	}
	// The panel keeps ~3 columns of margin and accent bar on the left, which
	// flatten() removes, and 2 on the right; render it wider to fill the box.
	// A stacked panel renders wide so it still lists everything before its rows are split.
	const render = () => target.render(rail.stack || rail.hang ? STACK_WIDTH : inner + 5);
	let rows = trimBlankEdges(flatten(rail.grow ? fullHeight(render) : render(), { ...options(), margin: false }));
	if (rail.stack) rows = rows.flatMap((row, index) => stackRow(row, inner, t ?? theme, index === 0));
	if (rail.hang) rows = hangRows(rows.filter((row) => !SCROLL_ROW.test(row.replace(SGR, ""))), inner, t ?? theme);
	if (rail.spaced && rows.length > 1) rows = [rows[0], "", ...rows.slice(1)];
	return rows.length ? boxed(rows, width, t ?? theme) : rows;
}
const STACK_WIDTH = 120;

// gentle-pi's Todos card keeps its list to a few rows with its own ScrollView, sized by the viewport
// it hands to updateLayout(). Drawn in the side column it gets a viewport as tall as its list, so the
// card grows with it and the column scrolls instead, once it reaches the bottom of the terminal.
function fullHeight(render) {
	const proto = PiTui.ScrollView?.prototype;
	const native = proto?.updateLayout;
	if (typeof native !== "function") return render();
	proto.updateLayout = function (contentHeight, viewportHeight, ...rest) {
		return native.call(this, contentHeight, Math.max(viewportHeight, contentHeight), ...rest);
	};
	try {
		return render();
	} finally {
		proto.updateLayout = native;
	}
}

// A panel component drawn flattened. While the side column is open the panel is
// drawn there instead (see railBlocks) and leaves its own place empty.
function blockComponent(component, options, t, key) {
	if (!component || typeof component.render !== "function") return component;
	if (key) railBlocks.set(key, { component, draw: (width) => drawBlock(component, width, options, t, { spaced: true, stack: key === "gentle-agents", hang: key === "gentle-todo", grow: key === "gentle-todo" }) });
	return new Proxy(component, {
		get(target, prop) {
			if (prop === "render") return (width) => (sidebar.active ? [] : drawBlock(target, width, options, t, { hang: key === "gentle-todo" }));
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
	});
}

function rewriteWidget(key, content) {
	if (key === KEYS.yolo) return config.yoloBanner ? content : undefined;
	if (!BLOCK_WIDGETS.has(key) || !config.blocks.minimal || content === undefined) return content;
	const options = blockOptions(WIDGET_GROUP[key]);
	if (Array.isArray(content)) return flatten(content, options());
	if (typeof content === "function") {
		return (tui, t, ...rest) => {
			openSidebar(tui);
			return blockComponent(content(tui, t, ...rest), options, t, key);
		};
	}
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
			if (content === undefined) railBlocks.delete(key);
			setWidget(key, rewriteWidget(key, content), ...rest);
		};
		// The /yolo toggle also announces itself with a notification; hide it with the banner.
		if (typeof ui.notify === "function") {
			const notify = ui.notify.bind(ui);
			ui.notify = (message, ...rest) => {
				if (!config.yoloBanner && typeof message === "string" && message.startsWith("🚀 YOLO ON")) return;
				return notify(message, ...rest);
			};
		}
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
// "❯ " flush with the margin: Collie (herdr phone bridge) only recognises the
// pi input box when the icon sits in column 0, as in oh-my-pi's layout.
const PROMPT_WIDTH = 2; // "❯ "
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
		lines[1] = `${first.slice(0, this.userPaddingX)}${colored} ${first.slice(padding)}`;
		return lines;
	}
}

const promptEditorFactory = (tui, editorTheme, keybindings) => new PromptEditor(tui, editorTheme, keybindings);

// Sent user messages: drop Pi's outputPad so the prompt icon sits flush with the
// margin, like the input. Patched once per process; the patch reads the config of
// the latest loaded copy of this module, so /reload and /gentle-quiet still apply.
const USER_PAD_PATCHED = Symbol.for("gentle-quiet.userMessagePad");
const CURRENT_CONFIG = Symbol.for("gentle-quiet.config");
globalThis[CURRENT_CONFIG] = () => config;
const userProto = UserMessageComponent?.prototype;
if (typeof userProto?.rebuild === "function" && !userProto[USER_PAD_PATCHED]) {
	const rebuild = userProto.rebuild;
	userProto.rebuild = function () {
		if (!globalThis[CURRENT_CONFIG]?.()?.prompt?.userMessage) return rebuild.call(this);
		const pad = this.outputPad;
		this.outputPad = 0;
		try {
			return rebuild.call(this);
		} finally {
			this.outputPad = pad;
		}
	};
	userProto[USER_PAD_PATCHED] = true;
}
// Sent user messages: one-row bar like Claude Code, without Pi's blank padded row
// above and below the text. Separate symbol so a running Pi picks it up on /reload.
const USER_ROWS_PATCHED = Symbol.for("gentle-quiet.userMessageRows");
if (typeof userProto?.rebuild === "function" && !userProto[USER_ROWS_PATCHED]) {
	const rebuild = userProto.rebuild;
	userProto.rebuild = function () {
		const result = rebuild.call(this);
		const body = this.children?.[0];
		if (globalThis[CURRENT_CONFIG]?.()?.prompt?.userMessage && typeof body?.paddingY === "number") {
			body.paddingY = 0;
			body.cachedText = undefined; // drop the render cache built with the old padding
		}
		return result;
	};
	userProto[USER_ROWS_PATCHED] = true;
}
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

/** The menu's sections, each a list of [label, action] items built from the current config. */
function menuSections(ctx) {
	return [
		["Status line", "Status", () => [
			[`Status line: ${config.statusLine.enabled ? "gentle" : "pi"}`, () => { config.statusLine.enabled = !config.statusLine.enabled; }],
			[`Status line changes: ${onOff(config.statusLine.changes)}`, () => { config.statusLine.changes = !config.statusLine.changes; }],
			[`Status line usage: ${onOff(config.statusLine.usage)}`, () => { config.statusLine.usage = !config.statusLine.usage; }],
			[`Status line MCP: ${onOff(config.statusLine.mcp)}`, () => { config.statusLine.mcp = !config.statusLine.mcp; }],
			[`Status line tokens: ${config.statusLine.tokens}`, () => { config.statusLine.tokens = TOKEN_MODES[(TOKEN_MODES.indexOf(config.statusLine.tokens) + 1) % TOKEN_MODES.length]; }],
			[`Status line cost: ${onOff(config.statusLine.cost)}`, () => { config.statusLine.cost = !config.statusLine.cost; }],
			[`Estimated cost (unpriced providers): ${onOff(config.statusLine.estimateCost)}`, () => { config.statusLine.estimateCost = !config.statusLine.estimateCost; }],
			...(ctx.model?.provider ? [[`Subscription (${ctx.model.provider}): ${onOff(config.statusLine.subscriptionProviders.includes(ctx.model.provider))}`, () => {
				const provider = ctx.model.provider;
				const list = config.statusLine.subscriptionProviders;
				config.statusLine.subscriptionProviders = list.includes(provider) ? list.filter((id) => id !== provider) : [...list, provider];
			}]] : []),
		]],
		["Footer statuses", "Footer", () => [
			[`Memory in footer: ${onOff(config.memory.show)}`, () => { config.memory.show = !config.memory.show; }],
			[`Memory label: ${shown(config.memory.label)}`, async () => { config.memory.label = await editLabel(ctx, "Memory label", config.memory.label); }],
			[`Memory project name: ${onOff(config.memory.showProject)}`, () => { config.memory.showProject = !config.memory.showProject; }],
			[`Permission in footer: ${onOff(config.permissions.show)}`, () => { config.permissions.show = !config.permissions.show; }],
			[`Permission label: ${shown(config.permissions.label)}`, async () => { config.permissions.label = await editLabel(ctx, "Permission label", config.permissions.label); }],
			[`Permission when normal: ${config.permissions.hideWhenNormal ? "hidden" : "shown"}`, () => { config.permissions.hideWhenNormal = !config.permissions.hideWhenNormal; }],
			[`YOLO banner: ${config.yoloBanner ? "shown" : "hidden"}`, () => { config.yoloBanner = !config.yoloBanner; }],
		]],
		["Tool rows", "Tools", () => [
			[`Tool rows: ${config.tools.restyle ? "quiet" : "original"} (new calls)`, () => { config.tools.restyle = !config.tools.restyle; }],
			[`Tool row margin: ${onOff(config.tools.margin)}`, () => { config.tools.margin = !config.tools.margin; }],
			[`Tool call tones: ${config.tools.tones}`, () => { config.tools.tones = TONE_MODES[(TONE_MODES.indexOf(config.tools.tones) + 1) % TONE_MODES.length]; }],
			[`Quiet tools (new calls): ${onOff(config.quiet.enabled)}`, () => { config.quiet.enabled = !config.quiet.enabled; }],
			[`Expand hint: ${config.quiet.hint}`, () => { config.quiet.hint = HINT_MODES[(HINT_MODES.indexOf(config.quiet.hint) + 1) % HINT_MODES.length]; }],
			[`Quiet preview lines: ${config.quiet.preview}`, () => { config.quiet.preview = QUIET_PREVIEWS[(QUIET_PREVIEWS.indexOf(config.quiet.preview) + 1) % QUIET_PREVIEWS.length]; }],
			[`Codemode output lines: ${config.quiet.codemodeOutput}`, () => { config.quiet.codemodeOutput = CODEMODE_OUTPUTS[(CODEMODE_OUTPUTS.indexOf(config.quiet.codemodeOutput) + 1) % CODEMODE_OUTPUTS.length]; }],
			[`Codemode detail: ${config.quiet.codemode}`, () => { config.quiet.codemode = CODEMODE_DETAILS[(CODEMODE_DETAILS.indexOf(config.quiet.codemode) + 1) % CODEMODE_DETAILS.length]; }],
		]],
		["Blocks and agents", "Blocks", () => [
			[`Todos/Agents blocks: ${config.blocks.minimal ? "minimal" : "original"}`, () => { config.blocks.minimal = !config.blocks.minimal; }],
			[`Todos/Agents border: ${onOff(config.blocks.border)}`, () => { config.blocks.border = !config.blocks.border; }],
			[`Side column: ${onOff(config.sidebar.enabled)}`, () => { config.sidebar.enabled = !config.sidebar.enabled; }],
			[`Side column from: ${config.sidebar.minColumns} columns`, () => { config.sidebar.minColumns = SIDEBAR_COLUMNS[(SIDEBAR_COLUMNS.indexOf(config.sidebar.minColumns) + 1) % SIDEBAR_COLUMNS.length]; }],
			[`Subagent results: ${config.subagents.minimal ? "minimal" : "original"} (restart to apply)`, () => { config.subagents.minimal = !config.subagents.minimal; }],
		]],
		["Icons", "Icons", () => ICON_GROUPS.map(([group, title]) => [`${title}: ${shown(config.icons[group])}`, async () => { config.icons[group] = await pickIcon(ctx, title, group === "memory" ? MEMORY_ICONS : CARD_ICONS, config.icons[group]); }])],
		["Prompt", "Prompt", () => [
			[`Prompt icon in input: ${onOff(config.prompt.editor)}`, () => { config.prompt.editor = !config.prompt.editor; }],
			[`Prompt icon in sent messages: ${onOff(config.prompt.userMessage)}`, () => { config.prompt.userMessage = !config.prompt.userMessage; }],
			[`Prompt icon: ${shown(config.prompt.icon)}`, async () => { config.prompt.icon = await pickIcon(ctx, "Prompt icon", PROMPT_ICONS, config.prompt.icon, false); }],
		]],
	];
}

const SECTION_MARK = " ›";
const BACK = "← Back";

async function applyChange(ctx, action) {
	await action();
	try {
		saveConfig();
	} catch (error) {
		ctx.ui.notify(`Could not save ${CONFIG_FILE}: ${error?.message ?? error}`, "error");
	}
	redraw();
	applyEditor(ctx);
	applyFooter(ctx);
}

/** One section's items; stays open after each change, Back or escape returns to the sections. */
async function configureSection(ctx, name) {
	while (true) {
		const section = menuSections(ctx).find(([title]) => title === name);
		const items = [...section[2](), [BACK, undefined]];
		const choice = await ctx.ui.select(`Gentle Quiet${SECTION_MARK} ${name}`, items.map(([label]) => label));
		const action = items.find(([label]) => label === choice)?.[1];
		if (!action) return;
		await applyChange(ctx, action);
	}
}

const isAsync = (fn) => fn?.constructor?.name === "AsyncFunction";
const RESET_TAB = ["Reset", "Reset", () => [["Reset to defaults", () => { config = structuredClone(DEFAULTS); }]]];

/**
 * The menu as one screen with horizontal tabs: ←/→ or tab switch sections, ↑/↓ pick an option,
 * enter changes it in place, escape closes. Options that open their own prompt (labels, icons)
 * close the screen, run, and reopen it on the same tab and row.
 */
async function configureTabs(ctx) {
	let tab = 0;
	let row = 0;
	while (true) {
		const picked = await ctx.ui.custom((tui, t, _keys, done) => {
			let cached;
			const tabs = () => [...menuSections(ctx), RESET_TAB];
			const items = () => tabs()[tab][2]();
			const refresh = () => { cached = undefined; tui.requestRender(); };
			const move = (step) => { tab = (tab + step + tabs().length) % tabs().length; row = 0; refresh(); };
			return {
				render(width) {
					if (cached) return cached;
					const w = Math.max(1, width);
					const fit = (line) => truncateToWidth(line, w);
					const bar = tabs().map(([, short], i) => (i === tab ? t.bg("selectedBg", fg(t, "text", bold(t, ` ${short} `))) : fg(t, "muted", ` ${short} `))).join(" ");
					const list = items();
					row = Math.min(row, list.length - 1);
					cached = [
						fg(t, "border", "─".repeat(w)),
						fit(` ${fg(t, "accent", bold(t, "Gentle Quiet"))}`),
						"",
						fit(` ${bar}`),
						"",
						...list.map(([label], i) => fit(i === row ? fg(t, "accent", ` → ${label}`) : `   ${fg(t, "text", label)}`)),
						"",
						fit(` ${fg(t, "dim", "←→ tabs  ↑↓ select  enter change  esc close")}`),
						fg(t, "border", "─".repeat(w)),
					];
					return cached;
				},
				invalidate() { cached = undefined; },
				handleInput(data) {
					const list = items();
					if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) return move(1);
					if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) return move(-1);
					if (matchesKey(data, Key.up)) { row = (row - 1 + list.length) % list.length; return refresh(); }
					if (matchesKey(data, Key.down)) { row = (row + 1) % list.length; return refresh(); }
					if (matchesKey(data, Key.escape)) return done(undefined);
					if (matchesKey(data, Key.enter)) {
						const action = list[row]?.[1];
						if (isAsync(action)) return done(action);
						if (action) void applyChange(ctx, action).then(refresh);
					}
				},
			};
		});
		if (!picked) return;
		await applyChange(ctx, picked);
	}
}

async function configure(ctx) {
	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") return configureTabs(ctx);
	while (true) {
		const sections = menuSections(ctx).map(([name]) => [`${name}${SECTION_MARK}`, () => configureSection(ctx, name)]);
		const items = [...sections, ["Reset to defaults", undefined], ["Done", undefined]];
		const choice = await ctx.ui.select("Gentle Quiet", items.map(([label]) => label));
		if (choice === "Reset to defaults") {
			await applyChange(ctx, () => { config = structuredClone(DEFAULTS); });
			continue;
		}
		const open = items.find(([label]) => label === choice)?.[1];
		if (!open) return;
		await open();
	}
}

// ---------------------------------------------------------------------------
// Quiet tools: Pi's own tools as a call row plus a one-line summary
// ---------------------------------------------------------------------------

// gentle-pi's background jobs (bash_background, monitor, job_stop, job_list) follow the same rows.
const QUIET_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "codemode", "bash_background", "monitor", "job_stop", "job_list"]);
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

// Claude Code's tool-call tones, measured from its UI: a light title, a softer grey for paths and commands.
// Fixed truecolor so monochrome palettes keep the two tones apart.
const CALL_TITLE = (text) => `\x1b[38;2;188;188;188m${text}\x1b[39m`;
const CALL_ARG = (text) => `\x1b[38;2;153;153;153m${text}\x1b[39m`;
/** Painters for a call row: tool name, its path or argument, and bash's "$ command". */
// "soft" is Claude Code's layout in the theme's own colors: toolTitle name, muted path and $ command, no bold.
const callTones = (t) => config.tools.tones === "theme"
	? { title: (text) => fg(t, "toolTitle", bold(t, text)), arg: (text) => fg(t, "accent", text), command: (text) => fg(t, "toolTitle", text) }
	: config.tools.tones === "soft"
		? { title: (text) => fg(t, "toolTitle", text), arg: (text) => fg(t, "muted", text), command: (text) => fg(t, "muted", text) }
		: { title: CALL_TITLE, arg: CALL_ARG, command: CALL_ARG };

function quietCall(toolName, args = {}, t) {
	const tones = callTones(t);
	const title = tones.title;
	const accent = tones.arg;
	const dim = (text) => fg(t, "dim", text);
	switch (toolName) {
		case "read": {
			const range = args.offset !== undefined || args.limit !== undefined
				? fg(t, "warning", `:${args.offset ?? 1}${args.limit !== undefined ? `-${(args.offset ?? 1) + args.limit - 1}` : ""}`)
				: "";
			return `${title("read")} ${accent(shortPath(args.path ?? args.file_path))}${range}`;
		}
		case "bash": // regular weight, like Claude Code's "$ command" row
			return tones.command(`$ ${firstLine(args.command)}`);
		case "bash_background":
			return join(tones.command(`$ ${firstLine(args.command)}`), dim("· background"));
		case "monitor":
			return join(title("monitor"), accent(firstLine(args.label ?? args.command ?? "")));
		case "job_stop":
			return join(title("job_stop"), accent(String(args.job_id ?? "")));
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
const CODEMODE_OUTPUTS = [3, 5, 10, 0];
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
	// The script's own output, without Pi's "Script completed / Wall time / Output:" header.
	// A thrown script already has its error as the summary.
	const limit = Number.isFinite(config.quiet.codemodeOutput) ? Math.max(0, config.quiet.codemodeOutput) : 0;
	if (limit > 0 && !isError) {
		const body = textOf(result).replace(/^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n?/, "");
		const output = body.split("\n").filter((line) => line.trim() !== "");
		for (const line of output.slice(0, limit)) rows.push(fg(t, "dim", firstLine(line, 200)));
		if (output.length > limit) rows.push(fg(t, "dim", `… ${output.length - limit} more lines`));
	}
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
			const counts = added || removed ? `${DIFF_STYLE["+"].paint(`+${added}`)} ${DIFF_STYLE["-"].paint(`-${removed}`)}` : "edited";
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
		case "bash_background": {
			const id = /\bStarted background job (\S+)\s/.exec(text)?.[1];
			return { summary: ok(id ? `${id} started` : firstLine(lines[0] ?? "started", 80)) };
		}
		case "monitor": {
			const started = /Started monitor (\S+) .*? for up to (\d+)s/.exec(text);
			return { summary: ok(started ? `${started[1]} watching · up to ${started[2]}s` : firstLine(lines[0] ?? "started", 80)) };
		}
		case "job_stop":
			return { summary: ok(firstLine(lines[0] ?? "stopped", 80)) };
		case "job_list":
			return { summary: ok(/^No background jobs/.test(text) ? "no jobs" : plural(lines.length, "job")) };
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
	const color = (line) => fg(t, info.color ?? "dim", line);
	// Something stays hidden: more output than the preview, or written content.
	const hidden = info.hidden ?? (source.length > shown.length || (toolName === "write" && String(context.args?.content ?? "") !== ""));
	return {
		summary: `${prefix} ${info.summary}`,
		hint: hidden ? expandHint(t) : "",
		// Fixed rows (codemode calls) arrive colored; the component truncates them to width.
		rest: info.fixed
			? shown.map((line) => `  ${line}`)
			: info.diff
				? shown.map((line) => ({ diff: line[0], text: firstLine(line, 200) }))
				: shown.map((line) => `  ${color(firstLine(line, 200))}`),
	};
}

// Minimal diff rows: no backgrounds, removed lines in soft red, added in soft green,
// changed words a brighter tone of the same color.
// Fixed truecolor on purpose: monochrome terminal palettes (Omarchy's grey themes)
// turn Pi's toolDiffAdded/toolDiffRemoved into the same grey as everything else.
const rgb = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`;
const diffStyle = (text, word) => ({
	text: rgb(text),
	word: rgb(word),
	paint: (value) => `${rgb(text)}${value}\x1b[39m`,
});
const DIFF_STYLE = {
	"+": diffStyle([125, 170, 130], [165, 215, 170]),
	"-": diffStyle([185, 135, 150], [215, 165, 180]), // soft rose
};

function diffRow({ diff, text }, width) {
	const plain = truncateToWidth(`  ${text}`, Math.max(1, width - 1), "…");
	const style = DIFF_STYLE[diff];
	return style ? ` ${style.paint(plain)}` : ` ${plain}`;
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
			for (const line of rest) lines.push(typeof line === "object" ? diffRow(line, width) : truncateToWidth(` ${line}`, width, "…"));
			return lines;
		},
		invalidate() {},
	};
}

/**
 * Recolors one native expanded diff line ("-12 text", "+12 text", wrapped tails):
 * the line in its soft tone, Pi's inverse word highlight in the brighter tone.
 */
function tintLine(line, style) {
	const out = [style.text];
	for (const tok of tokens(line)) {
		if (tok.ch !== undefined) {
			out.push(tok.ch);
			continue;
		}
		const m = /^\x1b\[([0-9;:]*)m$/.exec(tok.esc);
		if (!m) continue; // drop OSC and other sequences inside the row
		const params = m[1] === "" ? ["0"] : m[1].split(";");
		if (params.includes("7")) out.push(style.word);
		else if (params.includes("27") || params.includes("0")) out.push(style.text);
	}
	out.push("\x1b[0m");
	return out.join("");
}

const plainText = (line) => tokens(line).map((tok) => tok.ch ?? "").join("");

/** Tints every diff line of a native expanded edit/write result; context stays as is. */
function tintDiff(lines) {
	let current = null; // style of the diff line a wrapped tail belongs to
	return lines.map((line) => {
		const plain = plainText(line);
		const m = /^\s*([+-])\s*\d/.exec(plain); // "-2" or padded "- 882"
		if (m) current = DIFF_STYLE[m[1]];
		else if (/^\s*\d/.test(plain) || plain.trim() === "" || /^\s*\.\.\./.test(plain)) current = null;
		return current ? tintLine(line, current) : line;
	});
}

/** Shifts a component one column right (Pi's text margin) and drops its backgrounds. */
function padded(component, { diff = false } = {}) {
	if (!component || typeof component.render !== "function") return component;
	// Expanded outputs can be thousands of lines and redraw on every frame:
	// reuse the previous result while the native lines are unchanged.
	let lastIn;
	let lastOut;
	let lastWidth;
	return new Proxy(component, {
		get(target, key) {
			if (key === "render") {
				return (width) => {
					const lines = target.render(Math.max(1, width - 1));
					if (lastIn && lastWidth === width && lastIn.length === lines.length && lines.every((line, i) => line === lastIn[i])) return lastOut;
					lastIn = lines;
					lastWidth = width;
					// Lines without escape sequences have no background to drop.
					const shown = diff ? tintDiff(lines) : lines;
					lastOut = shown.map((line, i) => (diff && line !== lines[i] ? ` ${line}` : ` ${line.includes("\x1b[") ? tokens(line).map((tok) => (tok.esc ? stripBackground(tok.esc) : tok.ch)).join("") : line}`));
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
					if (native) return padded(native, { diff: toolName === "edit" || toolName === "write" });
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
			const tones = callTones(t);
			const title = tones.title(join(config.icons.memory, name));
			return flattened(new Text(join(title, arg && tones.arg(arg)), 0, 0), toolOptions("memory"));
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

// RDD review tools (gentle_review, capture, scope): gentle-pi's card text, redrawn like the quiet bash row:
// "› rdd start · risk · resilience" and, under it, "└ ✓ reviewing · medium · created · 9s". The text
// comes from gentle-pi's own renderers (so its real status and wording stay), only the frame goes.
const REVIEW_TOOLS = /^gentle_review(_.*)?$/;
const UNFRAMED_HINT = /\s{2,}\S.*$/; // the expand hint sits after a run of spaces

/** The visible text rows of a gentle-pi card, without its accent bars, rose and padding rows. */
function cardTextRows(component, width = 200) {
	let rows;
	try {
		rows = component.render(width);
	} catch {
		return [];
	}
	return rows
		.map((row) => row.replace(SGR, "").replace(/[▎]/gu, "").replace(GLYPHS, "").trim().replace(UNFRAMED_HINT, ""))
		.filter((row) => row !== "");
}

/** A component that redraws from `native` on every render, so a running call's status and clock stay live. */
const liveRows = (native, build) => ({
	render: (width) => build(cardTextRows(native), width).map((row) => (visibleWidth(row) <= width ? row : truncateToWidth(row, width, "…"))),
	invalidate: () => native.invalidate?.(),
});

function reviewRenderers(renderers) {
	return {
		...renderers,
		renderShell: "self",
		renderCall(args, t, context = {}) {
			const state = context.state && typeof context.state === "object" ? context.state : undefined;
			const native = renderers.renderCall(args, t, { ...context, lastComponent: state?.quietCall });
			if (state) state.quietCall = native;
			const tones = callTones(t);
			return liveRows(native, ([title = "rdd"]) => {
				const [name, ...rest] = title.split(" ");
				return [` ${tones.title(join(config.icons.other, name))} ${tones.arg(rest.join(" "))}`.trimEnd()];
			});
		},
		renderResult(result, options = {}, t, context = {}) {
			if (options.expanded && !options.isPartial) return flattened(renderers.renderResult(result, options, t, context), toolOptions("other"));
			const state = context.state && typeof context.state === "object" ? context.state : undefined;
			const native = renderers.renderResult(result, options, t, { ...context, lastComponent: state?.quietResult });
			if (state) state.quietResult = native;
			return liveRows(native, (rows) => {
				const clock = rows.find((row) => ELAPSED_ROW.test(row));
				const summary = rows.filter((row) => row !== clock)[0] ?? "";
				const failed = context.isError || /^(failed|error)\b/i.test(summary);
				const mark = failed ? fg(t, "error", "✗") : /^blocked\b/i.test(summary) ? fg(t, "warning", "●") : options.isPartial ? fg(t, "dim", "…") : fg(t, "success", "✓");
				const tone = failed ? "error" : "dim";
				return [` ${fg(t, "dim", "└")} ${mark} ${fg(t, tone, join(summary, clock && `· ${clock}`))}`];
			});
		},
	};
}

// ---------------------------------------------------------------------------
// Status line (Pi's footer)
// ---------------------------------------------------------------------------

const GAUGE_CELLS = 8;
let liveCtx; // latest context, so the footer reads the current session and model
let footerTui; // the TUI that renders our footer, to redraw after a git refresh
let footerInstalled = false;
const changesByCwd = new Map(); // cwd -> { files, added, deleted }
let changesTimer;
const totalsCache = { count: -1, entries: undefined, totals: undefined };

const run = (cwd, args) =>
	new Promise((resolve) => {
		execFile("git", ["-C", cwd, ...args], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout));
	});

/** Uncommitted changes against HEAD, untracked files included, like Gentle Shell's Changes. */
async function readChanges(cwd) {
	const tracked = await run(cwd, ["diff", "HEAD", "--numstat"]);
	if (tracked === undefined) return undefined; // not a repository, or no commit yet
	let files = 0;
	let added = 0;
	let deleted = 0;
	for (const line of tracked.split("\n")) {
		const [a, d] = line.split("\t");
		if (a === undefined || d === undefined) continue;
		files++;
		added += Number(a) || 0; // "-" for binary files
		deleted += Number(d) || 0;
	}
	const untracked = (await run(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])) ?? "";
	for (const file of untracked.split("\0").filter(Boolean)) {
		files++;
		try {
			const full = path.join(cwd, file);
			if (statSync(full).size > 1024 * 1024) continue;
			const text = readFileSync(full, "utf8");
			added += text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
		} catch {
			// unreadable: count the file, not its lines
		}
	}
	return { files, added, deleted };
}

let changesReading = false; // one git read at a time: a slow repository never piles them up

function refreshChanges(delay = 0) {
	clearTimeout(changesTimer);
	changesTimer = setTimeout(async () => {
		let cwd;
		try {
			cwd = liveCtx?.sessionManager?.getCwd?.();
		} catch {
			return; // ctx went stale after a session replacement or reload
		}
		if (!cwd || changesReading || !config.statusLine.enabled || !config.statusLine.changes) return;
		changesReading = true;
		try {
			const next = await readChanges(cwd);
			const previous = changesByCwd.get(cwd);
			changesByCwd.set(cwd, next);
			if (JSON.stringify(previous) !== JSON.stringify(next)) footerTui?.requestRender?.();
		} finally {
			changesReading = false;
		}
	}, delay);
	changesTimer.unref?.();
}

function gauge(percent, t) {
	const value = Math.max(0, Math.min(100, percent ?? 0));
	const filled = Math.round((value / 100) * GAUGE_CELLS);
	const tone = percent === null || percent === undefined ? "dim" : percent >= 95 ? "error" : percent >= 80 ? "warning" : "accent";
	return `${filled ? fg(t, tone, "▰".repeat(filled)) : ""}${fg(t, "border", "▱".repeat(GAUGE_CELLS - filled))}`;
}

/** Session usage totals counted the way Pi's own footer counts them. */
// Providers whose prices stand in for an unpriced provider serving the same model ids
// (claude-bridge registers Claude models at zero prices).
const REFERENCE_PROVIDERS = ["anthropic"];

/** Pi's calculateCost: per-million rates, the highest matching tier, 1h cache writes at 2× input. */
function priceUsage(cost, usage) {
	const promptTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
	let rates = cost;
	let matched = -1;
	for (const tier of cost.tiers ?? []) {
		if (promptTokens > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
			rates = tier;
			matched = tier.inputTokensAbove;
		}
	}
	const longWrite = usage.cacheWrite1h || 0;
	const shortWrite = (usage.cacheWrite || 0) - longWrite;
	return ((rates.input || 0) * (usage.input || 0)
		+ (rates.output || 0) * (usage.output || 0)
		+ (rates.cacheRead || 0) * (usage.cacheRead || 0)
		+ (rates.cacheWrite || 0) * shortWrite
		+ (rates.input || 0) * 2 * longWrite) / 1e6;
}

/** API-equivalent cost of a zero-priced response, from the same model at a reference provider. */
function estimatedCost(ctx, message) {
	if (!config.statusLine.estimateCost || typeof message?.model !== "string") return 0;
	for (const provider of REFERENCE_PROVIDERS) {
		if (provider === message.provider) continue;
		let model;
		try {
			model = ctx?.modelRegistry?.find?.(provider, message.model);
		} catch {
			model = undefined;
		}
		if (model?.cost) return priceUsage(model.cost, message.usage);
	}
	return 0;
}

function sessionTotals(ctx) {
	const entries = ctx?.sessionManager?.getEntries?.() ?? [];
	if (entries.length === totalsCache.count && totalsCache.entries === entries.at(-1) && totalsCache.estimate === config.statusLine.estimateCost) return totalsCache.totals;
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHit: undefined };
	const add = (usage) => {
		if (!usage) return;
		totals.input += usage.input || 0;
		totals.output += usage.output || 0;
		totals.cacheRead += usage.cacheRead || 0;
		totals.cacheWrite += usage.cacheWrite || 0;
		totals.cost += usage.cost?.total || 0;
	};
	for (const entry of entries) {
		const message = entry?.message;
		if (entry?.type === "usage") add(entry.usage);
		else if (entry?.type === "message" && message?.role === "assistant" && message.usage) {
			add(message.usage);
			if (!(message.usage.cost?.total > 0)) totals.cost += estimatedCost(ctx, message);
			const prompt = (message.usage.input || 0) + (message.usage.cacheRead || 0) + (message.usage.cacheWrite || 0);
			totals.cacheHit = prompt > 0 ? ((message.usage.cacheRead || 0) / prompt) * 100 : undefined;
		} else if (entry?.type === "message" && message?.role === "toolResult") add(message.usage);
		else if (entry?.type === "branch_summary" || entry?.type === "compaction") add(entry.usage);
	}
	totalsCache.count = entries.length;
	totalsCache.entries = entries.at(-1);
	totalsCache.estimate = config.statusLine.estimateCost;
	totalsCache.totals = totals;
	return totals;
}

// ---------------------------------------------------------------------------
// Subagent spend: each subagent is its own Pi process with its own session file, so its tokens and
// cost never reach the main session. The main process sets SPEND_ENV to its session id; Pi passes the
// environment on, so every subagent (and theirs) writes its own session totals, priced by its own
// model, to gentle-quiet-spend/<main session>/<subagent session>.json. One file per subagent: no
// two processes write the same file. The main footer adds them all to its own totals.
// ---------------------------------------------------------------------------

const SPEND_ENV = "GENTLE_QUIET_SPEND_PARENT";
const SPEND_DIR = path.join(AGENT_DIR, "gentle-quiet-spend");
const SPEND_KEEP_MS = 30 * 86400000; // a main session's folder outlives a restart for this long
const TOTAL_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cost"];
const spend = { parent: undefined, root: undefined, own: undefined, stamp: undefined, totals: undefined };

const spendKey = (ctx) => {
	let id;
	try {
		id = ctx?.sessionManager?.getSessionId?.();
	} catch {
		id = undefined;
	}
	return String(id || `pid-${process.pid}`).replace(/[^A-Za-z0-9_-]/g, "_");
};

/** Decides once whether this process is a subagent (the variable came from a parent) or the main one. */
function startSpend(ctx) {
	if (spend.parent === undefined && spend.root === undefined) {
		const inherited = process.env[SPEND_ENV];
		if (inherited) spend.parent = inherited.replace(/[^A-Za-z0-9_-]/g, "_");
	}
	if (spend.parent) {
		spend.own = spendKey(ctx);
		return;
	}
	spend.root = spendKey(ctx);
	process.env[SPEND_ENV] = spend.root;
	spend.stamp = undefined;
	spend.totals = undefined;
	pruneSpend();
}

function pruneSpend() {
	try {
		for (const name of readdirSync(SPEND_DIR)) {
			const dir = path.join(SPEND_DIR, name);
			if (name !== spend.root && Date.now() - statSync(dir).mtimeMs > SPEND_KEEP_MS) rmSync(dir, { recursive: true, force: true });
		}
	} catch {
		// no folder yet, or another process pruned it first
	}
}

/** In a subagent: its session totals, written where the main process looks. */
function shareSpend(ctx) {
	if (!spend.parent || !spend.own) return;
	try {
		const totals = sessionTotals(ctx);
		const dir = path.join(SPEND_DIR, spend.parent);
		mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${spend.own}.json`);
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ ...Object.fromEntries(TOTAL_KEYS.map((key) => [key, totals[key]])), at: Date.now() }));
		renameSync(tmp, file);
	} catch {
		// best effort: the main footer keeps the last totals it read
	}
}

/** The subagent files of the main session with a stamp that changes whenever any of them does. */
function spendFiles() {
	const dir = path.join(SPEND_DIR, spend.root);
	try {
		const names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
		const stamp = names.map((name) => {
			const stat = statSync(path.join(dir, name));
			return `${name}:${stat.mtimeMs}:${stat.size}`;
		}).join("|");
		return { dir, names, stamp };
	} catch {
		return undefined; // no subagent wrote yet, or a file was replaced while listing
	}
}

/** In the main process: the summed totals of its subagents, read again when one of them writes. */
function subagentSpend() {
	if (!spend.root) return undefined;
	const files = spendFiles();
	if (!files) return spend.totals;
	if (files.stamp === spend.stamp) return spend.totals;
	const { dir, names, stamp } = files;
	const sum = Object.fromEntries(TOTAL_KEYS.map((key) => [key, 0]));
	for (const name of names) {
		try {
			const totals = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
			for (const key of TOTAL_KEYS) if (Number.isFinite(totals?.[key])) sum[key] += totals[key];
		} catch {
			// a malformed file counts as nothing
		}
	}
	spend.stamp = stamp;
	spend.totals = sum;
	return sum;
}

/** True when a subagent wrote since the footer last read their totals. */
function spendChanged() {
	if (!spend.root) return false;
	const files = spendFiles();
	return Boolean(files) && files.stamp !== spend.stamp;
}

/** The session's own totals plus its subagents'; the cache hit rate stays the session's own. */
function footerTotals(ctx) {
	const own = sessionTotals(ctx);
	const others = subagentSpend();
	if (!others) return own;
	return { ...own, ...Object.fromEntries(TOTAL_KEYS.map((key) => [key, own[key] + others[key]])) };
}

// Pi's token format: 950, 1.2k, 50k, 2.0M, 33M.
function formatTokens(count) {
	if (count < 1000) return String(count);
	if (count < 1e4) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1e6) return `${Math.round(count / 1000)}k`;
	if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
	return `${Math.round(count / 1e6)}M`;
}

function statusLineRows(t, footerData, width) {
	const ctx = liveCtx;
	const sep = ` ${fg(t, "dim", "·")} `;
	const cwd = shortPath(ctx?.sessionManager?.getCwd?.() ?? "");
	const branch = footerData?.getGitBranch?.();
	const changes = config.statusLine.changes ? changesByCwd.get(ctx?.sessionManager?.getCwd?.()) : undefined;
	const model = ctx?.model;
	let effort;
	try {
		effort = model?.reasoning ? ctx?.thinkingLevel ?? piThinking?.() : undefined;
	} catch {
		effort = undefined;
	}
	const usage = ctx?.getContextUsage?.();
	const percent = typeof usage?.percent === "number" ? usage.percent : null;
	let subscription = false;
	try {
		subscription = Boolean(model && (ctx?.modelRegistry?.isUsingOAuth?.(model) || config.statusLine.subscriptionProviders.includes(model.provider)));
	} catch {
		subscription = false;
	}
	const totals = footerTotals(ctx);
	// Like Pi's footer: no cost for an unpriced, unknown plan; "sub" alone when a plan costs nothing per call.
	const amount = `$${totals.cost >= 1 ? totals.cost.toFixed(2) : totals.cost.toFixed(3)}`;
	const costText = !config.statusLine.cost ? "" : totals.cost > 0 ? join(amount, subscription && "sub") : subscription ? "sub" : "";

	const counts = changes?.files
		? join(fg(t, "toolDiffAdded", `+${changes.added}`), fg(t, "toolDiffRemoved", `-${changes.deleted}`))
		: "";
	const location = (withCounts) => join(
		cwd && fg(t, "muted", cwd),
		branch && fg(t, "text", branch),
		changes?.files ? fg(t, "warning", `±${changes.files}`) : "",
		withCounts && counts,
	);
	const modelText = (withEffort) => model?.id
		? join(fg(t, "text", model.id), withEffort && effort && `${fg(t, "dim", "·")} ${fg(t, "muted", effort)}`)
		: "";
	// ↑input ↓output, then Rcache-read Wcache-write CHhit% when caching happened.
	// "cache" mode keeps the hit rate when the terminal narrows; "all" keeps ↑ ↓ instead.
	const tokens = (withCache) => {
		const mode = config.statusLine.tokens;
		if (mode === "off") return "";
		const cached = totals.cacheRead || totals.cacheWrite;
		const parts = [];
		if (mode === "all") {
			if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
			if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
		}
		if (withCache) {
			if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
			if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
		}
		if ((withCache || mode === "cache") && cached && totals.cacheHit !== undefined) parts.push(`CH${totals.cacheHit.toFixed(1)}%`);
		return parts.length ? fg(t, "dim", parts.join(" ")) : "";
	};
	// Gentle Shell's usage bar: "claude 5h ▰▰▰▰▰▱▱▱ 62% · week 31%". The first window gets the
	// same meter as ctx; the others are text.
	const plan = config.statusLine.usage ? currentUsage(ctx) : { name: "", windows: [] };
	const usageText = (all) => {
		const [first, ...rest] = plan.windows;
		if (!first) return "";
		const head = [fg(t, "muted", plan.name), first.label && fg(t, "muted", first.label), gauge(first.percent, t), fg(t, "text", `${Math.round(first.percent)}%`)].filter(Boolean).join(" ");
		const tail = all ? rest.map((window) => `${fg(t, "muted", "·")} ${fg(t, "muted", window.label)} ${fg(t, "text", `${Math.round(window.percent)}%`)}`) : [];
		return [head, ...tail].join(" ");
	};
	const contextText = `${fg(t, "muted", "ctx")} ${gauge(percent, t)} ${fg(t, "text", percent === null ? "?%" : `${Math.round(percent)}%`)}`;

	const statuses = [...(footerData?.getExtensionStatuses?.() ?? new Map()).entries()]
		.filter(([, text]) => typeof text === "string" && text.trim() !== "")
		// Permission mode first, then the rest by key.
		.sort(([a], [b]) => (a === KEYS.mode ? -1 : b === KEYS.mode ? 1 : a.localeCompare(b)))
		.map(([, text]) => text.replace(/[\r\n\t]/g, " "));

	// Statuses sit on the left after the model, Perm first. Details give way in
	// this order: cache counters, tokens, change counts; then the statuses move
	// to their own row, then effort, model and location go. Context and cost stay.
	const stages = [
		{ inline: true, effort: true, counts: true, cache: true, tokens: true, usage: "all", model: true, location: true },
		{ inline: true, effort: true, counts: true, cache: false, tokens: true, usage: "all", model: true, location: true },
		{ inline: true, effort: true, counts: true, cache: false, tokens: false, usage: "all", model: true, location: true },
		{ inline: true, effort: true, counts: true, cache: false, tokens: false, usage: "first", model: true, location: true },
		{ inline: true, effort: true, counts: false, cache: false, tokens: false, usage: "first", model: true, location: true },
		{ inline: false, effort: true, counts: false, cache: false, tokens: false, usage: "first", model: true, location: true },
		{ inline: false, effort: false, counts: false, cache: false, tokens: false, usage: "first", model: true, location: true },
		{ inline: false, effort: false, counts: false, cache: false, tokens: false, usage: false, model: true, location: true },
		{ inline: false, effort: false, counts: false, cache: false, tokens: false, usage: false, model: false, location: true },
		{ inline: false, effort: false, counts: false, cache: false, tokens: false, usage: false, model: false, location: false },
	];
	const mcp = config.statusLine.mcp ? mcpCounts(ctx) : undefined;
	const mcpPlain = mcp ? `MCP ${mcp.online}/${mcp.total}` : "";
	const mcpPainted = mcp ? fg(t, mcp.online < mcp.total ? "warning" : "dim", mcpPlain) : "";
	const statusText = [...statuses.map((text) => fg(t, "dim", text)), mcpPainted].filter(Boolean).join(sep);
	const secondRow = [...statuses, mcpPlain].filter(Boolean);
	for (const stage of stages) {
		const left = [
			stage.location && location(stage.counts),
			stage.model && modelText(stage.effort),
			stage.inline && statusText,
		].filter(Boolean).join(sep);
		const right = [stage.tokens && tokens(stage.cache), contextText, costText && fg(t, "text", costText), stage.usage && usageText(stage.usage === "all")].filter(Boolean).join(sep);
		// Rows start at column 0: Collie (herdr phone bridge) only finds the pi input box
		// when the status lines under it do not start with a space.
		const gap = width - 1 - visibleWidth(left) - visibleWidth(right);
		if (gap < (left ? 2 : 0)) continue;
		const line = `${left}${" ".repeat(gap)}${right} `;
		if (stage.inline || !secondRow.length) return [line];
		return [line, truncateToWidth(secondRow.join("  "), width, "…")];
	}
	const right = [contextText, costText && fg(t, "text", costText)].filter(Boolean).join(sep);
	const line = truncateToWidth(right, width, "…");
	return secondRow.length ? [line, truncateToWidth(secondRow.join("  "), width, "…")] : [line];
}

let piThinking; // pi.getThinkingLevel, bound at load
let piApi; // the extension API, for the MCP tool and server lists

// ---------------------------------------------------------------------------
// Plan usage: 5h / week windows from rate-limit response headers
// ---------------------------------------------------------------------------

const usageByProvider = new Map(); // provider -> { name, windows: [{ label, percent, resetAt (ms) | null }] }
const ANTHROPIC_WINDOWS = [["5h", 18000], ["7d", 604800]];

function windowLabel(seconds) {
	if (seconds === 604800) return "week";
	if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
	return `${Math.round(seconds / 60)}m`;
}

/** Claude (also through claude-bridge): unified headers, utilization as a 0..1 fraction. Codex: percent plus window minutes. */
function parseUsageHeaders(headers) {
	const windows = [];
	let name = "claude";
	const number = (value) => Number.parseFloat(value ?? "");
	for (const [key, seconds] of ANTHROPIC_WINDOWS) {
		const fraction = number(headers[`anthropic-ratelimit-unified-${key}-utilization`]);
		if (!Number.isFinite(fraction)) continue;
		const reset = Number.parseInt(headers[`anthropic-ratelimit-unified-${key}-reset`] ?? "", 10);
		windows.push({ label: windowLabel(seconds), percent: fraction * 100, resetAt: Number.isFinite(reset) ? reset * 1000 : null });
	}
	for (const kind of ["primary", "secondary"]) {
		const used = number(headers[`x-codex-${kind}-used-percent`]);
		const minutes = number(headers[`x-codex-${kind}-window-minutes`]);
		if (!Number.isFinite(used) || !Number.isFinite(minutes) || minutes <= 0) continue;
		name = "codex";
		const reset = Number.parseInt(headers[`x-codex-${kind}-reset-at`] ?? "", 10);
		windows.push({ label: windowLabel(minutes * 60), percent: used, resetAt: Number.isFinite(reset) ? reset * 1000 : null });
	}
	return { name, windows };
}

// Every subagent is its own Pi process, so its readings never reach this one's events. Each process
// shares its readings through this file and takes the newer ones it finds there (`at`, ms).
const USAGE_FILE = path.join(AGENT_DIR, "gentle-quiet-usage.json");
const USAGE_POLL_MS = 2000;
let usageFileStamp; // mtime of the file as last read
let usageTimer;

function readUsageFile() {
	try {
		const value = JSON.parse(readFileSync(USAGE_FILE, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {}; // missing or malformed: nothing shared yet
	}
}

/** Takes the readings other processes wrote since the last look; true when one is newer than ours. */
function syncUsage() {
	let stamp;
	try {
		stamp = statSync(USAGE_FILE).mtimeMs;
	} catch {
		return false;
	}
	if (stamp === usageFileStamp) return false;
	usageFileStamp = stamp;
	let changed = false;
	for (const [provider, usage] of Object.entries(readUsageFile())) {
		if (!Array.isArray(usage?.windows) || !Number.isFinite(usage.at)) continue;
		if ((usageByProvider.get(provider)?.at ?? -Infinity) >= usage.at) continue;
		usageByProvider.set(provider, { name: String(usage.name ?? ""), windows: usage.windows, at: usage.at });
		changed = true;
	}
	return changed;
}

function shareUsage(provider, usage) {
	try {
		mkdirSync(AGENT_DIR, { recursive: true });
		const tmp = `${USAGE_FILE}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ ...readUsageFile(), [provider]: usage }));
		renameSync(tmp, USAGE_FILE);
	} catch {
		// sharing is best effort: this process still shows its own reading
	}
}

// While a subagent works the main process gets no responses or tool events of its own: look at the
// shared files and at git now and then, so usage, cost and the changed lines follow the subagent.
function watchUsage(tui) {
	clearInterval(usageTimer);
	usageTimer = setInterval(() => {
		if (syncUsage() | spendChanged()) tui?.requestRender?.();
		if (!changesReading) refreshChanges();
	}, USAGE_POLL_MS);
	usageTimer.unref?.();
}

function recordUsage(headers) {
	const provider = liveCtx?.model?.provider;
	if (!provider || !headers || typeof headers !== "object") return;
	const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
	const usage = { ...parseUsageHeaders(lower), at: Date.now() };
	if (!usage.windows.length) return;
	usageByProvider.set(provider, usage);
	shareUsage(provider, usage);
	footerTui?.requestRender?.();
}

/** The active provider's plan name and windows that have not reset yet. */
function currentUsage(ctx) {
	syncUsage();
	const usage = usageByProvider.get(ctx?.model?.provider);
	if (!usage) return { name: "", windows: [] };
	return { name: usage.name, windows: usage.windows.filter((window) => window.resetAt === null || window.resetAt > Date.now()) };
}

// ---------------------------------------------------------------------------
// MCP servers: online / installed
// ---------------------------------------------------------------------------

// Pi's tool namespace for a server (mcpNamespace in Pi's MCP support).
const mcpNamespace = (server) => `mcp__${String(server).replace(/-/g, "_")}`;
const MCP_TTL_MS = 1000;
let mcpCache = { at: 0, cwd: undefined, value: undefined };

function readMcpFile(file) {
	try {
		const servers = JSON.parse(readFileSync(file, "utf8"))?.mcpServers;
		return servers && typeof servers === "object" && !Array.isArray(servers) ? servers : {};
	} catch {
		return {}; // missing or malformed: the same as no servers
	}
}

/** Installed = enabled servers from the global file, the trusted project file and extensions. */
function installedMcpServers(ctx) {
	const found = new Map();
	const add = (name, config) => {
		if (config?.enabled === false) found.delete(name);
		else if (config && typeof config === "object") found.set(name, config);
	};
	for (const [name, config] of Object.entries(readMcpFile(path.join(AGENT_DIR, "mcp.json")))) add(name, config);
	let trusted = false;
	try {
		trusted = Boolean(ctx?.isProjectTrusted?.());
	} catch {
		trusted = false;
	}
	const cwd = ctx?.sessionManager?.getCwd?.();
	if (trusted && cwd) for (const [name, config] of Object.entries(readMcpFile(path.join(cwd, ".pi", "mcp.json")))) add(name, config);
	try {
		for (const server of piApi?.getMcpServers?.() ?? []) if (!found.has(server.name)) add(server.name, server.config ?? {});
	} catch {
		// servers registered by extensions are optional
	}
	return [...found.keys()];
}

/** { online, total } or undefined when no MCP servers are installed; cached briefly because the footer renders often. */
function mcpCounts(ctx) {
	const cwd = ctx?.sessionManager?.getCwd?.();
	if (Date.now() - mcpCache.at < MCP_TTL_MS && mcpCache.cwd === cwd) return mcpCache.value;
	const installed = installedMcpServers(ctx);
	let value;
	if (installed.length) {
		// Pi hides a server's tools when it disconnects, so a server is online while it has a visible tool.
		const live = new Set();
		try {
			for (const tool of piApi?.getAllTools?.() ?? []) {
				if (tool?.exposure !== "hidden" && typeof tool?.namespace?.name === "string") live.add(tool.namespace.name);
			}
		} catch {
			// no tool list: treat every server as offline rather than guess
		}
		value = { online: installed.filter((name) => live.has(mcpNamespace(name))).length, total: installed.length };
	}
	mcpCache = { at: Date.now(), cwd, value };
	return value;
}

/** Re-reads the counts now and redraws the footer when they changed (servers connect after startup). */
let mcpTimers = [];
function refreshMcp(ctx) {
	const before = JSON.stringify(mcpCache.value);
	mcpCache.at = 0;
	mcpCounts(ctx);
	if (JSON.stringify(mcpCache.value) !== before) footerTui?.requestRender?.();
}

function footerFactory(tui, t, footerData) {
	footerTui = tui;
	watchUsage(tui);
	const unsubscribe = footerData?.onBranchChange?.(() => tui?.requestRender?.());
	refreshChanges();
	openSidebar(tui);
	// On wide terminals the status line is the bar on top of the side-column layout: a blank row
	// keeps it off whatever the terminal draws above Pi (herdr's tabs), one column of margin, a rule below.
	const bar = (width) => ["", ...statusLineRows(t, footerData, width - 1).map((row) => ` ${row}`), fg(t, "border", "─".repeat(width))];
	railStatus = bar;
	return {
		// While the side column is open the status line is the bar on top, so nothing is drawn under the
		// editor. Collie 1.21.3 then cannot find Pi's input box (AltanS/collie#445).
		render: (width) => (sidebar.active ? [] : statusLineRows(t, footerData, width)),
		invalidate() {},
		dispose() {
			if (typeof unsubscribe === "function") unsubscribe();
			if (footerTui === tui) {
				footerTui = undefined;
				clearInterval(usageTimer);
			}
			if (railStatus === bar) railStatus = undefined;
		},
	};
}

// Pi resets the footer with the rest of the extension UI on session changes, so
// session_start installs it again; /gentle-quiet installs or removes it on demand.
function applyFooter(ctx, force = false) {
	const ui = ctx?.ui;
	if (ctx?.mode !== "tui" || typeof ui?.setFooter !== "function") return;
	if (config.statusLine.enabled && (force || !footerInstalled)) {
		ui.setFooter(footerFactory);
		footerInstalled = true;
	} else if (!config.statusLine.enabled && footerInstalled) {
		ui.setFooter(undefined);
		footerInstalled = false;
	} else if (footerInstalled) {
		footerTui?.requestRender?.();
	}
}

// ---------------------------------------------------------------------------
// Side column: Agents and Todos beside the conversation, the status line on top, on wide terminals
// ---------------------------------------------------------------------------

// Gentle Shell's sidebar layout, kept when Gentle Shell is disabled: in a fullscreen Pi the layout
// root is a tree whose node can be swapped for [status bar / [conversation | column]]. Pi's own
// internals (layout-node, ScrollView), so every step is guarded and falls back to the native layout.
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const GENTLE_SIDEBAR = Symbol.for("gentle-pi.experimental-sidebar.state");
const SIDEBAR_COLUMNS = [120, 140, 160, 180]; // terminal widths the column can open at
const RAIL_WIDTH = 60;
const RAIL_GAP = 2;

// active: the wide layout is painting; the status line and the panels it holds paint nothing in their usual places.
const sidebar = { tui: undefined, active: false, dispose: undefined };
const railBlocks = new Map(); // widget key -> (width) => rows, registered by blockComponent
let railStatus; // (width) => rows of the status bar, registered by the footer

/** Agents and Todos as outlined cards, one right under the other, with where each one sits. */
function railRows(width) {
	const rows = [];
	const hits = [];
	for (const key of ["gentle-agents", "gentle-todo"]) {
		const block = railBlocks.get(key);
		const section = block?.draw(width);
		if (!section?.length) continue;
		hits.push({ component: block.component, start: rows.length, height: section.length });
		rows.push(...section);
	}
	return { rows, hits };
}

// The cards are drawn here, so their mouse handling is too: a click on a card's title row (Todos'
// collapse toggle) and the wheel over a card reach the card as if it were drawn in its usual place.
// The title sits on the row under the top border; the card counts it from its own first row, which
// is 0 or 1 depending on the theme's card style, so only the matching row answers.
const TITLE_ROWS = [0, 1];
function railMouse(event, hits, scrollTop) {
	const y = scrollTop + event.y;
	const hit = hits.find((candidate) => y >= candidate.start && y < candidate.start + candidate.height);
	if (!hit || typeof hit.component?.handleMouse !== "function") return undefined;
	const local = { ...event, x: Math.max(0, event.x - 2), height: hit.height, width: Math.max(1, event.width - 4) };
	if (event.type === "wheel") return hit.component.handleMouse({ ...local, y: y - hit.start });
	if (event.type !== "click" || y - hit.start !== 1) return undefined;
	for (const row of TITLE_ROWS) {
		const result = hit.component.handleMouse({ ...local, y: row });
		if (result?.handled) return result;
	}
	return undefined;
}

function installSidebar(tui) {
	const host = tui;
	const roots = new Set();
	const cleanups = [];
	let failed = false;
	let barLines = [];
	let lines = [];
	let hits = [];
	const wanted = () =>
		!failed &&
		config.sidebar.enabled &&
		host.mode === "fullscreen" &&
		tui.terminal.columns >= config.sidebar.minColumns &&
		// Gentle Shell paints its own sidebar when it is enabled.
		typeof tui.terminal[GENTLE_SIDEBAR]?.ownsHost !== "function";
	const column = new PiTui.ScrollView({ render: () => lines, invalidate() {} }, {
		follow: "none",
		primary: false,
		overscroll: "contain",
		scrollbar: "auto",
		scrollbarTrackStyle: (text) => fg(theme, "border", text),
		scrollbarThumbStyle: (text) => fg(theme, "accent", text),
	});
	const nativeMouse = column.handleMouse?.bind(column);
	column.handleMouse = (event) => {
		let result;
		try {
			result = railMouse(event, hits, column.scrollTop ?? 0);
		} catch {
			result = undefined;
		}
		return result?.handled ? result : nativeMouse?.(event);
	};
	const bar = { render: () => barLines, invalidate() {} };
	const attach = () => {
		if (failed) return;
		try {
			const root = host.layoutRoot;
			if (!root || typeof root[LAYOUT_NODE] !== "function" || roots.has(root)) return;
			const nativeNode = root[LAYOUT_NODE];
			const descriptor = Object.getOwnPropertyDescriptor(root, LAYOUT_NODE);
			const conversation = { render: () => [], invalidate() {}, [LAYOUT_NODE]: () => nativeNode.call(root) };
			const withColumn = {
				render: () => [],
				invalidate() {},
				[LAYOUT_NODE]: () => ({
					type: "hstack",
					gap: RAIL_GAP,
					align: "stretch",
					entries: [
						{ component: conversation, basis: 0, grow: 1, shrink: 1, minSize: 1 },
						{ component: column, basis: RAIL_WIDTH, grow: 0, shrink: 0, minSize: RAIL_WIDTH },
					],
				}),
			};
			const replacement = () => {
				sidebar.active = false;
				if (!wanted()) return nativeNode.call(root);
				try {
					const width = column.getContentWidth(RAIL_WIDTH);
					barLines = (config.statusLine.enabled ? railStatus?.(tui.terminal.columns) : undefined) ?? [];
					const drawn = railRows(width);
					hits = drawn.hits;
					lines = drawn.rows.map((row) => (visibleWidth(row) <= width ? row : truncateToWidth(row, width, "…")));
				} catch {
					failed = true;
					return nativeNode.call(root);
				}
				if (!barLines.length && !lines.length) return nativeNode.call(root);
				sidebar.active = true;
				const body = lines.length ? withColumn : conversation;
				if (!barLines.length) return body[LAYOUT_NODE]();
				return {
					type: "vstack",
					gap: 0,
					align: "stretch",
					entries: [
						{ component: bar, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
						{ component: body, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					],
				};
			};
			root[LAYOUT_NODE] = replacement;
			roots.add(root);
			cleanups.push(() => {
				if (root[LAYOUT_NODE] !== replacement) return;
				if (descriptor) Object.defineProperty(root, LAYOUT_NODE, descriptor);
				else Reflect.deleteProperty(root, LAYOUT_NODE);
			});
			tui.requestRender?.();
		} catch {
			failed = true;
			sidebar.active = false;
		}
	};
	attach();
	// Pi replaces the layout root without a session event; bind again when it does.
	const timer = setInterval(attach, 100);
	timer.unref?.();
	return () => {
		failed = true;
		sidebar.active = false;
		clearInterval(timer);
		for (const cleanup of cleanups.reverse()) cleanup();
		tui.requestRender?.();
	};
}

// One layout per terminal; installed by the first footer or panel that Pi builds on it.
function openSidebar(tui) {
	if (!tui?.terminal || typeof PiTui.ScrollView !== "function" || sidebar.tui === tui) return;
	try {
		sidebar.dispose?.();
		sidebar.tui = tui;
		sidebar.dispose = installSidebar(tui);
	} catch {
		sidebar.dispose = undefined;
	}
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

// Stale results: a subagent finished while the orchestrator was busy, so
// gentle-agents keeps it out of the conversation and leaves a transcript entry.
const AGENTS_STALE_RESULT_TYPE = "gentle-agents.stale-result";

function staleResultRenderer(entry, options = {}, t) {
	const data = entry?.data ?? {};
	const agent = clean(String(data.agent ?? "subagent")) || "subagent";
	const status = clean(String(data.status ?? "finished").replace(/_/g, " "));
	const seconds = Number.isFinite(data.ageSeconds) ? Math.max(0, Math.round(data.ageSeconds)) : 0;
	const age = seconds < 90 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
	const taskId = clean(String(data.taskId ?? ""));
	const label = clean(String(data.label ?? ""));
	const head = join(fg(t, "toolTitle", bold(t, join(config.icons.agents, agent))), fg(t, "dim", "·"), fg(t, "warning", "stale"));
	const summary = `${fg(t, "dim", "└")} ${fg(t, "dim", `${status} ${age} ago while the orchestrator was busy`)}`;
	const detail = `Not replayed here; read it with subagent_result ${taskId}${label ? ` (${label})` : ""}.`;
	return {
		render(width) {
			if (options.expanded) {
				return [` ${head}`, ` ${summary}`, truncateToWidth(`   ${fg(t, "toolOutput", detail)}`, width, "…")].map((line) => truncateToWidth(line, width, "…"));
			}
			const hint = expandHint(t);
			const left = ` ${head}`;
			const gap = width - visibleWidth(left) - visibleWidth(hint) - 1;
			const top = gap >= 2 ? `${left}${" ".repeat(gap)}${hint} ` : truncateToWidth(left, width, "…");
			return [top, truncateToWidth(` ${summary}`, width, "…")];
		},
		invalidate() {},
	};
}

// ---------------------------------------------------------------------------
// Background job notices (gentle-jobs.notice messages)
// ---------------------------------------------------------------------------

const JOB_NOTICE_TYPE = "gentle-jobs.notice";
const JOB_ICON = "⧗"; // gentle-pi's JOB_GLYPH
// "Monitor job-2 ("label") reported 2 new lines:" -> "reported 2 new lines:"
const JOB_SUBJECT = /^(?:Monitor|Background job) \S+ \(".*?"\) /;

/** A job notice as a row plus a summary line; its lines appear on expand. */
function jobNoticeRenderer(message, options = {}, t) {
	const details = message?.details?.gentleJobs ?? {};
	const content = message?.content;
	const text = typeof content === "string" ? content : (content ?? []).filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n");
	const [first = "", ...body] = text.replace(/\s+$/, "").split("\n");
	const outcome = first.replace(JOB_SUBJECT, "").replace(/[.:]$/, "");
	const label = clean(String(details.label ?? ""));
	const head = join(fg(t, "toolTitle", bold(t, `${JOB_ICON} ${details.kind === "monitor" ? "monitor" : "bash_background"}`)), label && fg(t, "dim", `· ${label}`));
	let summary;
	if (details.event === "events") summary = fg(t, "dim", outcome.replace(/^reported /, ""));
	else if (details.status === "exited" && details.exitCode === 0) summary = fg(t, "success", `✓ ${outcome}`);
	else if (details.status === "stopped" || details.event === "timeout") summary = fg(t, "warning", outcome);
	else summary = fg(t, "error", `✗ ${outcome}`);
	const prefix = `${fg(t, "dim", "└")} ${summary}`;
	const rows = body.filter((line) => line.trim() !== "");
	return {
		render(width) {
			const top = ` ${head}`;
			if (options.expanded) {
				return [top, ` ${prefix}`, ...rows.map((line) => `   ${fg(t, "toolOutput", line)}`)].map((line) => truncateToWidth(line, width, "…"));
			}
			const hint = rows.length ? expandHint(t) : "";
			const gap = width - visibleWidth(top) - visibleWidth(hint) - 1;
			return [hint && gap >= 2 ? `${top}${" ".repeat(gap)}${hint} ` : truncateToWidth(top, width, "…"), truncateToWidth(` ${prefix}`, width, "…")];
		},
		invalidate() {},
	};
}

export default async function (pi) {
	config = loadConfig();
	const chrome = await loadEngramChrome();

	piThinking = typeof pi.getThinkingLevel === "function" ? () => pi.getThinkingLevel() : undefined;
	piApi = pi;
	// Rate-limit headers arrive with each provider response (claude-bridge rebuilds Claude Code's
	// rate_limit_event as the unified headers), so no credentials or extra requests are needed.
	pi.on("after_provider_response", (event) => recordUsage(event?.headers));
	pi.on("session_start", (_event, ctx) => {
		config = loadConfig();
		liveCtx = ctx;
		totalsCache.count = -1;
		startSpend(ctx);
		mcpCache = { at: 0, cwd: undefined, value: undefined };
		applyFooter(ctx, true);
		refreshChanges();
		// MCP servers connect after startup (Pi waits up to ~10s): look again as they come up.
		for (const timer of mcpTimers) clearTimeout(timer);
		mcpTimers = [1500, 4000, 11000].map((delay) => {
			const timer = setTimeout(() => {
				try {
					refreshMcp(ctx);
				} catch {
					// ctx went stale after a session replacement or reload
				}
			}, delay);
			timer.unref?.();
			return timer;
		});
		callOrder.clear(); // a new or resumed session redraws its calls from the start
		latestFinished = -1;
		patch(ctx);
		applyEditor(ctx);
	});
	// A subagent shares its totals after every response, so the main footer follows it while it works.
	for (const event of ["turn_end", "agent_end"]) pi.on(event, (_event, ctx) => shareSpend(ctx ?? liveCtx));
	for (const event of ["before_agent_start", "tool_execution_end", "turn_end"]) {
		pi.on(event, (_event, ctx) => {
			liveCtx = ctx ?? liveCtx;
			patch(ctx);
			applyEditor(ctx);
			// Files change through tools and turns; a short delay batches bursts of calls.
			if (event !== "before_agent_start") refreshChanges(500);
			try {
				refreshMcp(ctx);
			} catch {
				// ctx went stale after a session replacement or reload
			}
		});
	}
	// Pi resets extension UI after shutdown; forget the editor so the next start reinstalls it.
	pi.on("session_shutdown", () => {
		clearInterval(usageTimer);
		for (const timer of mcpTimers) clearTimeout(timer);
		mcpTimers = [];
		installedOn = undefined;
	});

	// Pi uses the first extension that registered a message type; local extensions load
	// before packages, and a package must be listed before gentle-pi to take over.
	if (config.subagents.minimal && typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer(AGENTS_RESULT_TYPE, agentResultRenderer);
	}
	if (config.quiet.enabled && typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer(JOB_NOTICE_TYPE, jobNoticeRenderer);
	}
	if (config.subagents.minimal && typeof pi.registerEntryRenderer === "function") {
		pi.registerEntryRenderer(AGENTS_STALE_RESULT_TYPE, staleResultRenderer);
	}

	pi.registerMarkdownTransformer?.((markdown, context) => {
		if (!config.prompt.userMessage || context?.messageType !== "user" || markdown.trim() === "") return markdown;
		return `${config.prompt.icon || "❯"} ${markdown}`;
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
			if (!config.tools.restyle && (toolName.startsWith("mem_") || SELF_TOOLS.test(toolName))) return renderers;
			if (toolName.startsWith("mem_") && chrome?.humanToolName && chrome?.renderResultText) {
				return memoryRenderers(chrome, toolName, renderers);
			}
			if (REVIEW_TOOLS.test(toolName)) return reviewRenderers(renderers);
			if (SELF_TOOLS.test(toolName)) return gentleRenderers(renderers, iconGroup(toolName));
			if (QUIET_TOOLS.has(toolName) && config.quiet.enabled) return quietRenderers(toolName, renderers);
			return renderers;
		});
	}
}
