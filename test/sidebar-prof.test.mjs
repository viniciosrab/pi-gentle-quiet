import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configFile, load, painted, plain, role, theme, writeConfig } from "./helpers.mjs";
import { createTab, PROF_TIMEOUTS, thinkingSupport } from "../extensions/sidebar/prof.ts";

// gentle-pi's profile readers, as plain JavaScript stand-ins with the same exports and the same files
// (the test loader runs .ts files under node_modules of a "gentle-quiet-test-" dir as modules).
const LIB = {
	"agent-home.ts": `
import os from "node:os";
import path from "node:path";
export function gentlePiConfigHome(env = process.env) { return env.GENTLE_PI_CONFIG_HOME || path.join(os.homedir(), ".pi", "gentle-ai"); }
`,
	"agent-profiles.ts": `
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export const PROFILE_ORCHESTRATOR_KEY = "orchestrator";
export function profilesFilePath(home) { return join(home, "profiles.json"); }
export function readProfilesFileResult(path) {
	if (!existsSync(path)) return { status: "missing" };
	let value;
	try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return { status: "invalid" }; }
	if (value?.kind !== "gentle-pi.agent_model_profiles" || typeof value.profiles !== "object") return { status: "invalid" };
	const active = Object.prototype.hasOwnProperty.call(value.profiles, value.active) ? value.active : undefined;
	return { status: "valid", file: { kind: value.kind, version: 1, active, profiles: value.profiles }, drops: {} };
}
export function readProfileOrchestrator(config) {
	const entry = config.orchestrator;
	return entry && Object.keys(entry).length > 0 ? entry : undefined;
}
export function profileRoutingRows(config) {
	return Object.entries(config).filter(([agent]) => agent !== "orchestrator")
		.map(([agent, entry]) => ({ agent, model: entry?.model ?? "inherit", thinking: entry?.thinking ?? "inherit" }))
		.sort((a, b) => a.agent.localeCompare(b.agent));
}
`,
	"agent-profile-pin.ts": `
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export function localProfilePinPath(commonDir) { return join(commonDir, "gentle-ai", "profile-pin.json"); }
export function repoProfileDeclarationPath(root) { return join(root, ".pi", "gentle-ai", "profile.json"); }
export function readProfilePinResult(path) {
	if (!existsSync(path)) return { status: "missing" };
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value?.kind === "gentle-pi.agent_model_profile_pin" && typeof value.profile === "string" ? { status: "valid", profile: value.profile } : { status: "invalid" };
	} catch { return { status: "invalid" }; }
}
export function evaluateProfilePin(status, profiles) {
	const evaluation = { invalid: [], stale: [] };
	if (!status) return evaluation;
	for (const [source, path, read] of [["local", status.localPath, status.local], ["repo", status.repoPath, status.repo]]) {
		if (read.status !== "valid") continue;
		if (!evaluation.winner && Object.prototype.hasOwnProperty.call(profiles, read.profile)) evaluation.winner = { source, profile: read.profile, path };
	}
	return evaluation;
}
`,
	"session-profile-binding.ts": `
const key = Symbol.for("gentle-pi:session-profile-bindings");
export function readSessionProfileBinding(sessionId) {
	if (sessionId === undefined) return undefined;
	const binding = globalThis[key]?.get(sessionId);
	return binding && { name: binding.name, modelProfiles: { ...binding.modelProfiles } };
}
`,
};

// gentle-pi's writers, as stand-ins with the same exports: what the in-column editing needs on top of the readers.
const WRITERS = {
	"model-routing-authority.ts": `
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function isThinkingLevel(value) { return THINKING_LEVELS.includes(value); }
export function normalizeModelId(value) { return typeof value === "string" && /^[A-Za-z0-9._~:@/+%-]+$/.test(value.trim()) ? value.trim() : undefined; }
export function normalizeModelConfig(value) {
	if (!value || typeof value !== "object") return undefined;
	return Object.fromEntries(Object.entries(value).map(([agent, entry]) => [agent, { ...entry }]));
}
`,
	"profiles-orchestrator.ts": `
export function parseOrchestratorModelRef(id) {
	const at = typeof id === "string" ? id.indexOf("/") : -1;
	return at > 0 ? { provider: id.slice(0, at), model: id.slice(at + 1) } : undefined;
}
`,
	"session-profile-binding.ts": `${LIB["session-profile-binding.ts"]}
export function bindSessionProfile(sessionId, name, modelProfiles) {
	(globalThis[key] ??= new Map()).set(sessionId, { name, modelProfiles: JSON.parse(JSON.stringify(modelProfiles)) });
}
`,
	"agent-profiles.ts": `${LIB["agent-profiles.ts"]}
import { writeFileSync } from "node:fs";
export function updateProfile(file, name, config) {
	if (!Object.prototype.hasOwnProperty.call(file.profiles, name)) throw new Error("Profile does not exist: " + name + ".");
	return { ...file, profiles: { ...file.profiles, [name]: JSON.parse(JSON.stringify(config)) } };
}
export function writeProfilesFileSync(path, file) {
	globalThis.profileWrites = (globalThis.profileWrites ?? 0) + 1;
	writeFileSync(path, JSON.stringify({ kind: file.kind, version: file.version, active: file.active, profiles: file.profiles }, null, 2) + "\\n");
}
`,
};
const EDIT_LIB = { ...LIB, ...WRITERS };

const bindings = () => (globalThis[Symbol.for("gentle-pi:session-profile-bindings")] ??= new Map());

const MAX = {
	orchestrator: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
	"jd-judge-a": { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
	"gentle-ai-explore": { model: "claude-bridge/claude-sonnet-5-5", thinking: "medium" },
	"review-risk": { model: "xai/grok-4.7" },
	custom: {},
};
const STORE = {
	kind: "gentle-pi.agent_model_profiles",
	version: 1,
	active: "Max",
	profiles: { Balanced: { "gentle-ai-worker": { model: "openai/gpt-5.5", thinking: "medium" } }, Max: MAX, Low: {} },
};

let dirs = 0;
/** A fresh agent dir with gentle-pi's lib (or the given files instead), a config home (no profiles.json for store: null), and a repository. */
function install({ lib = LIB, store = STORE, gentlePi = true } = {}) {
	const root = mkdtempSync(path.join(os.tmpdir(), `gentle-quiet-test-prof-${dirs++}-`));
	const agentDir = path.join(root, "agent");
	const libDir = path.join(agentDir, "npm/node_modules/gentle-pi/lib");
	if (gentlePi) {
		mkdirSync(libDir, { recursive: true });
		for (const [name, source] of Object.entries(lib)) writeFileSync(path.join(libDir, name), source);
	} else mkdirSync(agentDir, { recursive: true });
	const configHome = path.join(root, "config");
	mkdirSync(configHome, { recursive: true });
	if (store !== null) writeFileSync(path.join(configHome, "profiles.json"), typeof store === "string" ? store : JSON.stringify(store));
	const repo = path.join(root, "repo");
	const commonDir = path.join(repo, ".git");
	mkdirSync(path.join(commonDir, "gentle-ai"), { recursive: true });
	mkdirSync(path.join(repo, ".pi", "gentle-ai"), { recursive: true });
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	const pin = (layer, profile) =>
		writeFileSync(
			layer === "local" ? path.join(commonDir, "gentle-ai", "profile-pin.json") : path.join(repo, ".pi", "gentle-ai", "profile.json"),
			JSON.stringify({ kind: "gentle-pi.agent_model_profile_pin", version: 1, profile }),
		);
	const writeStore = (value) => writeFileSync(path.join(configHome, "profiles.json"), JSON.stringify(value));
	return { root, agentDir, configHome, repo, commonDir, pin, writeStore };
}

// gentle-quiet's card, as railCard draws it with the outline on: square outline, bold toolTitle title, a blank row.
const fit = (row, inner) => {
	const text = plain(row);
	return [...text].length <= inner ? row + " ".repeat(inner - [...text].length) : `${[...text].slice(0, inner - 1).join("")}…`;
};
const boxed = (rows, width) => {
	const inner = width - 4;
	return [theme.fg("border", `┌${"─".repeat(inner + 2)}┐`), ...rows.map((row) => `${theme.fg("border", "│")} ${fit(row, inner)} ${theme.fg("border", "│")}`), theme.fg("border", `└${"─".repeat(inner + 2)}┘`)];
};

/** A stand-in for gentle-quiet's tab host. */
function host(env, { git, usage = { name: "", windows: [] }, sessionId = "s1", noPi = false, shellOff = true, models = MODELS, columns = 180, rows = 40, selectedBg = true } = {}) {
	const calls = { git: [], sent: [], renders: 0, usage: 0, custom: [], done: [], notices: [], setModel: [], thinking: [], focuses: [], focused: undefined };
	// Pi's overlay UI, recording what it is asked to show; component() builds it like Pi does.
	const tui = {
		terminal: { columns, rows },
		requestRender() {},
		// Pi's overlay mouse routing: a press here lands on no overlay.
		dispatchMouseToOverlay: () => ({ hit: false }),
		getTopmostVisibleOverlay: () => calls.top,
	};
	calls.tui = tui;
	const ui = {
		custom: (factory, options) => {
			calls.custom.push({ factory, options });
			return new Promise(() => {});
		},
		notify: (...args) => calls.notices.push(args),
	};
	const ctx = {
		hasUI: true,
		ui,
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: {
			getAvailable: async () => models,
			find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
		},
	};
	calls.component = () => calls.custom.at(-1).factory(tui, theme, {}, (value) => calls.done.push(value));
	const h = {
		// Pi's theme, with its selection background unless a test takes it away (Pi's bg() throws on an unknown color).
		theme: selectedBg ? { ...theme, bg: (name, text) => (name === "selectedBg" ? `${SELECTED}${text}\x1b[49m` : assert.fail(`no bg ${name}`)) } : theme,
		fg: (name, text) => theme.fg(name, text),
		bold: (text) => theme.bold(text),
		card: (title, rows, width) => boxed([theme.fg("toolTitle", theme.bold(title)), ...(rows.length ? ["", ...rows] : [])], width),
		box: (rows, width) => boxed(rows, width),
		inner: (width) => width - 4,
		cwd: () => env?.repo,
		ctx: () => ctx,
		pi: noPi
			? undefined
			: {
					sendUserMessage: (text, options) => calls.sent.push([text, options]),
					setModel: async (model) => (calls.setModel.push(model), true),
					setThinkingLevel: (level) => calls.thinking.push(level),
				},
		gentleShellOff: () => shellOff,
		agentDir: env?.agentDir ?? "/nonexistent/agent",
		requestRender: () => calls.renders++,
		git: async (args, cwd) => {
			calls.git.push(args);
			if (git) return git(args, cwd);
			if (args.includes("--show-toplevel")) return `${env.repo}\n`;
			if (args.includes("--git-common-dir")) return `${env.commonDir}\n`;
			return undefined;
		},
		changes: () => undefined,
		usage: () => {
			calls.usage++;
			return usage;
		},
		gauge: (percent) => theme.fg("accent", `◔${percent}`),
		icons: {},
		// The column's keyboard, as gentle-quiet hands it to a tab.
		// Recorded; held only when a test grants it (calls.keyboard), so the other tests see the card unfocused.
		focus: (id) => {
			calls.focuses.push(id);
			if (calls.keyboard) calls.focused = id;
		},
		blur: () => {
			calls.focused = undefined;
		},
		focused: () => calls.focused,
	};
	return { host: h, calls };
}

// Pi's model catalog, unsorted.
const MODELS = [
	{ provider: "xai", id: "grok-4.7", reasoning: true },
	{ provider: "claude-bridge", id: "claude-sonnet-5-5", reasoning: true },
	{ provider: "claude-bridge", id: "claude-opus-5-5", reasoning: true },
	{ provider: "openai", id: "gpt-5.5", reasoning: false },
];

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Opens the tab as gentle-quiet does (onShow, then render) and waits for its data. */
async function opened(env, options = {}, width = 59, height = 40) {
	const { host: h, calls } = host(env, options);
	const tab = createTab(h);
	tab.onShow?.();
	tab.render(width, height);
	await settle();
	const draw = () => tab.render(width, height);
	return { tab, calls, h, draw, rows: () => draw().map(plain).map((row) => row.replace(/ +│$/, "")) };
}

const rowIndex = (rows, pattern) => rows.findIndex((row) => pattern.test(row));

test("createTab does no I/O: no git, no files, no usage read until the tab is shown", async () => {
	const { host: h, calls } = host(undefined, { git: () => { throw new Error("no git"); } });
	const tab = createTab(h);
	assert.equal(tab.id, "prof");
	await settle();
	assert.deepEqual(calls.git, []);
	assert.equal(calls.usage, 0);
	assert.equal(calls.renders, 0);
});

test("before its data arrives the Profiles card says it is loading", () => {
	const env = install();
	const { host: h } = host(env);
	const tab = createTab(h);
	const out = tab.render(59, 40).map(plain);
	assert.ok(out[0].startsWith("┌"));
	assert.match(out[1], /^│ Profiles/);
	assert.ok(out.some((row) => row.includes("Loading gentle-pi's profiles…")));
});

test("the Profiles card: one button per profile with gentle-pi's marks, the shown one in accent bold", async () => {
	const env = install();
	env.pin("local", "Low");
	bindings().set("s1", { name: "Balanced", modelProfiles: {} });
	try {
		const { draw, rows, calls } = await opened(env);
		assert.ok(calls.renders >= 1, "a redraw once the data is in");
		const out = rows();
		assert.equal(out[1], "│ Profiles");
		assert.equal(out[2], "│");
		assert.equal(out[3], "│ [◉ 1: Balanced] [● 2: Max] [⌂ 3: Low]");
		const raw = draw();
		assert.ok(raw[3].includes(role("accent")) && raw[3].includes(theme.bold("[◉ 1: Balanced]")), "the session's profile is the one shown");
		assert.ok(painted(raw[3], "muted", "Max") && painted(raw[3], "accent", "●"), "others muted, marks in their tones");
		assert.ok(painted(raw[3], "warning", "⌂"));
		assert.match(out[4], /^│ ─+$/, "a rule under the profiles");
		assert.ok(painted(raw[4], "border"));
	} finally {
		bindings().delete("s1");
	}
});

test("the roster of the shown profile: the orchestrator first, then each subagent with its model and effort", async () => {
	const env = install();
	const { rows, draw } = await opened(env);
	const out = rows();
	assert.equal(out[3], "│ [○ 1: Balanced] [● 2: Max] [○ 3: Low]", "no session, no pin: the default is shown");
	const orchestrator = rowIndex(out, /orchestrator/);
	assert.match(out[orchestrator], /^│ orchestrator +claude-opus-5-5 \(high\)$/);
	assert.equal(out[orchestrator + 1], "│");
	const roster = out.slice(orchestrator + 2, orchestrator + 6);
	[/^│ custom +inherit \(inherit\)$/, /^│ gentle-ai-explore +claude-sonnet-5-5 \(medium\)$/, /^│ jd-judge-a +claude-opus-5-5 \(high\)$/, /^│ review-risk +grok-4\.7 \(inherit\)$/].forEach((pattern, i) =>
		assert.match(roster[i], pattern),
	);
	assert.ok(roster.every((row) => [...row].length === 57), "the model and effort flush with the card's edge");
	const raw = draw();
	assert.ok(raw[orchestrator].includes(theme.bold("orchestrator")), "the orchestrator bold");
	assert.ok(painted(raw[orchestrator + 3], "accent", "gentle-ai-explore"), "gentle-ai- agents in accent");
	assert.ok(painted(raw[orchestrator + 4], "warning", "jd-judge-a"), "jd- agents in warning");
	assert.ok(painted(raw[orchestrator + 5], "success", "review-risk"), "review- agents in success");
	assert.ok(!raw.some((row) => /[◆•▸]/.test(row)), "no glyph before the names");
	assert.ok(painted(raw[orchestrator + 3], "dim", "(medium)"), "the effort dim");
	assert.ok(out.every((row) => [...row].length <= 59));
});

test("a roster row too long for the card puts the model on its own row", async () => {
	const env = install({ store: { ...STORE, profiles: { Max: { "gentle-ai-a-very-long-agent-name-here": { model: "provider/a-very-long-model-name-for-sure", thinking: "xhigh" } } } } });
	const { rows } = await opened(env, {}, 50);
	const out = rows();
	const at = rowIndex(out, /gentle-ai-a-very-long/);
	assert.match(out[at], /^│ gentle-ai-a-very-long-agent-name-here$/);
	assert.match(out[at + 1], /^│ {3}a-very-long-model-name-for-sure \(xhigh\)$/);
});

test("a profile with no subagents and no orchestrator says so", async () => {
	const env = install({ store: { ...STORE, active: "Low" } });
	const out = (await opened(env)).rows();
	assert.ok(out.some((row) => /^│ orchestrator +leave untouched/.test(row)));
	assert.ok(out.some((row) => row === "│ no subagents routed"));
});

test("the Plan usage card draws each window as cute's quota gauge: label, percent, reset, a bar across", async () => {
	const env = install();
	const reset = Date.now() + (2 * 60 + 5) * 60_000 + 30_000;
	const usage = { name: "Claude Max", windows: [{ label: "5h", percent: 28, resetAt: reset }, { label: "week", percent: 85, resetAt: null }, { label: "opus", percent: 97, resetAt: Date.now() + 3 * 86_400_000 + 4 * 3_600_000 + 60_000 }] };
	const { rows, draw } = await opened(env, { usage });
	const out = rows();
	const title = rowIndex(out, /^│ Plan usage$/);
	assert.ok(title > 0);
	assert.ok(out[title - 1].startsWith("┌"), "a card of its own");
	assert.match(out[title + 2], /^│ Claude Max · 5h +28% \(in 2h 5m\)$/);
	assert.equal(out[title + 3], `│ ${"■".repeat(Math.round(0.28 * 55))}${"□".repeat(55 - Math.round(0.28 * 55))}`);
	assert.match(out[title + 4], /^│ week +85%$/);
	assert.match(out[title + 6], /^│ opus +97% \(in 3d 4h\)$/);
	const raw = draw();
	assert.ok(painted(raw[title + 3], "accent", "■") && painted(raw[title + 3], "dim", "□"));
	assert.ok(painted(raw[title + 4], "warning") && raw[title + 5].includes(role("warning")), "80% and over: warning");
	assert.ok(raw[title + 7].includes(role("error")), "95% and over: error");
});

test("with no plan usage the Plan usage card says so in one line", async () => {
	const env = install();
	const out = (await opened(env)).rows();
	const title = rowIndex(out, /^│ Plan usage$/);
	assert.equal(out[title + 2], "│ No plan usage yet");
});

test("gentle-pi not installed: the Profiles card says so in one line, and the usage still shows", async () => {
	const env = install({ gentlePi: false });
	const { rows, calls } = await opened(env, { usage: { name: "Pro", windows: [{ label: "5h", percent: 10, resetAt: null }] } });
	const out = rows();
	assert.equal(out[1], "│ Profiles");
	assert.equal(out[3], "│ gentle-pi's profiles not found");
	assert.equal(out[4], "└" + "─".repeat(57) + "┘");
	assert.ok(out.some((row) => /^│ Pro · 5h +10%$/.test(row)));
	assert.deepEqual(calls.git, [], "no repository lookup without profiles");
});

test("no profiles saved yet, or an unreadable profiles.json: one line each", async () => {
	assert.equal((await opened(install({ store: null }))).rows()[3], "│ No profiles yet · /gentle:profiles creates them");
	assert.equal((await opened(install({ store: "{ not json" }))).rows()[3], "│ gentle-pi's profiles.json is unreadable");
});

test("gentle-pi without the reader exports: the same files are read directly", async () => {
	const env = install({ lib: { "agent-profiles.ts": "export const nothing = 1;\n" } });
	env.pin("repo", "Low");
	const out = (await opened(env)).rows();
	assert.equal(out[3], "│ [○ 1: Balanced] [● 2: Max] [⌂ 3: Low]");
	assert.ok(out.some((row) => /^│ orchestrator +leave untouched$/.test(row)), "the pinned profile is shown");
});

test("a reader that throws degrades to a one-line message", async () => {
	const env = install({ lib: { ...LIB, "agent-profiles.ts": `${LIB["agent-profiles.ts"]}\nexport function profilesFilePath() { throw new Error("disk on fire"); }\n`.replace(/export function profilesFilePath\(home\)[^\n]*\n/, "") } });
	const out = (await opened(env)).rows();
	assert.equal(out[3], "│ Profiles unavailable: disk on fire");
});

test("no repository, a missing git binary or a git that throws: no ⌂, the rest as usual", async () => {
	for (const git of [() => undefined, () => { throw new Error("spawn git ENOENT"); }, () => Promise.reject(new Error("timeout"))]) {
		const env = install();
		env.pin("local", "Low");
		const out = (await opened(env, { git })).rows();
		assert.equal(out[3], "│ [○ 1: Balanced] [● 2: Max] [○ 3: Low]");
	}
});

test("a git that never answers times out: the profiles show without the repository mark", async () => {
	const saved = { ...PROF_TIMEOUTS };
	PROF_TIMEOUTS.git = 10;
	try {
		const env = install();
		env.pin("local", "Low");
		const out = (await opened(env, { git: () => new Promise(() => {}) })).rows();
		assert.equal(out[3], "│ [○ 1: Balanced] [● 2: Max] [○ 3: Low]");
	} finally {
		Object.assign(PROF_TIMEOUTS, saved);
	}
});

test("a load that never finishes times out to a short message", async () => {
	const saved = { ...PROF_TIMEOUTS };
	PROF_TIMEOUTS.load = 10;
	PROF_TIMEOUTS.git = 1000;
	try {
		const env = install();
		const out = (await opened(env, { git: () => new Promise(() => {}) })).rows();
		assert.equal(out[3], "│ Profiles did not load in time");
	} finally {
		Object.assign(PROF_TIMEOUTS, saved);
	}
});

test("onShow reloads: a profile made default elsewhere shows on the next visit", async () => {
	const env = install();
	const { tab, rows, calls } = await opened(env);
	assert.equal(rows()[3], "│ [○ 1: Balanced] [● 2: Max] [○ 3: Low]");
	env.writeStore({ ...STORE, active: "Balanced" });
	const before = calls.renders;
	tab.onShow();
	await settle();
	assert.equal(rows()[3], "│ [● 1: Balanced] [○ 2: Max] [○ 3: Low]");
	assert.ok(calls.renders > before);
});

test("clicking a profile button or the card's title runs /gentle:profiles; other rows are left to the column", async () => {
	const env = install();
	const { tab, rows, calls } = await opened(env);
	const out = rows();
	const x = (label) => out[3].indexOf(label);
	assert.equal(tab.handleClick(3, "left", x("Max")), true);
	assert.equal(tab.handleClick(1, "left", 4), true, "the title");
	assert.deepEqual(calls.sent, [["/gentle:profiles", { expandPromptTemplates: true }], ["/gentle:profiles", { expandPromptTemplates: true }]]);
	assert.equal(tab.handleClick(3, "left", out[3].length + 2), false, "past the last button");
	assert.equal(tab.handleClick(3, "right", x("Max")), false, "only the left button");
	assert.equal(tab.handleClick(rowIndex(out, /orchestrator/), "left", 4), false, "a roster row");
	assert.equal(tab.handleClick(rowIndex(out, /Plan usage/) + 2, "left", 4), false, "a usage row");
	assert.equal(tab.handleClick(999, "left", 0), false);
	assert.equal(calls.sent.length, 2);
});

test("without Pi's API a click is still taken and does nothing", async () => {
	const env = install();
	const { tab } = await opened(env, { noPi: true });
	assert.equal(tab.handleClick(1, "left", 4), true);
});

test("the wheel is left to the column, which scrolls the tab", async () => {
	const env = install();
	const { tab } = await opened(env);
	assert.equal(tab.handleWheel(3, 5, 4), false);
	assert.equal(tab.handleWheel(-3, 5, 4), false);
});

test("more profiles than three rows hold: cute's [▼] toggle shows the rest, [▲] folds them", async () => {
	const profiles = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`profile-${String(i + 1).padStart(2, "0")}`, {}]));
	const env = install({ store: { ...STORE, active: "profile-01", profiles } });
	const { tab, rows, calls } = await opened(env, {}, 45);
	let out = rows();
	assert.match(out[5], /\[▼\]$/);
	assert.match(out[6], /^│ ─+$/, "three rows of buttons");
	const before = calls.renders;
	assert.equal(tab.handleClick(5, "left", out[5].indexOf("[▼]") + 1), true);
	assert.equal(calls.sent.length, 0, "the toggle is not a profile");
	assert.ok(calls.renders > before);
	out = rows();
	assert.ok(out.some((row) => row.includes("14: profile-14")));
	const toggle = rowIndex(out, /\[▲\]/);
	assert.ok(toggle > 5);
	tab.handleClick(toggle, "left", out[toggle].indexOf("[▲]"));
	assert.match(rows()[5], /\[▼\]$/);
});

test("render never throws and keeps every row within the width, down to a narrow column", async () => {
	const env = install();
	const { tab } = await opened(env, { usage: { name: "Claude Max", windows: [{ label: "5h", percent: 50, resetAt: Date.now() + 60_000 }] } });
	for (const width of [59, 40, 30, 20]) {
		const out = tab.render(width, 30).map(plain);
		assert.ok(out.every((row) => [...row].length <= width), `width ${width}`);
	}
	tab.invalidate?.();
	tab.dispose?.();
});

test("in gentle-quiet's column: a click on a profile selects it, Use binds it; the title still runs /gentle:profiles", async () => {
	const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
	const agentDir = path.dirname(configFile);
	const libDir = path.join(agentDir, "npm/node_modules/gentle-pi/lib");
	mkdirSync(libDir, { recursive: true });
	for (const [name, source] of Object.entries(EDIT_LIB)) writeFileSync(path.join(libDir, name), source);
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:gentle-pi", extensions: ["-extensions/gentle-shell.ts"] }] }));
	const configHome = mkdtempSync(path.join(os.tmpdir(), "gentle-quiet-test-prof-home-"));
	writeFileSync(path.join(configHome, "profiles.json"), JSON.stringify(STORE));
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writeConfig({});
	const loaded = await load({ mode: "tui", session: { id: "column-1", cwd: "/srv/app", model: { id: "claude-opus-5-5" } } });
	const native = { type: "vstack", entries: [] };
	const root = { render: () => [], [NODE]: () => native };
	const tui = { terminal: { columns: 180, rows: 40 }, mode: "fullscreen", layoutRoot: root, requestRender() {} };
	loaded.footer()?.(tui, theme, { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} });
	const side = () => root[NODE]().entries?.[1]?.component?.[NODE]?.();
	const bar = side().entries[0].component;
	const x = plain(bar.render(60)[0]).indexOf("3:PROF") + 1;
	bar.handleMouse({ type: "click", button: "left", x, y: 0, width: 60, height: 2, screenX: 120, screenY: 0 });
	const content = () => side().entries.at(-1).component;
	content().render(60);
	await settle();
	let out = content().render(60).map(plain);
	assert.match(out[1], /^│ Profiles/);
	const at = rowIndex(out, /\[● 2: Max\]/);
	assert.ok(at > 0, out.join("\n"));
	const click = (y, x) => content().handleMouse({ type: "click", button: "left", x, y, width: 60, height: 38, screenX: 120 + x, screenY: y + 2 });
	assert.equal(click(at, out[at].indexOf("Balanced"))?.handled, true);
	await settle();
	assert.equal(bindings().get("column-1"), undefined, "a chip only selects");
	out = content().render(60).map(plain);
	const buttons = rowIndex(out, /\[ Use in this session \]/);
	assert.ok(buttons > 0, out.join("\n"));
	assert.equal(click(buttons, out[buttons].indexOf("Use in this session"))?.handled, true);
	await settle();
	assert.equal(bindings().get("column-1")?.name, "Balanced");
	assert.deepEqual(loaded.sent, [], "gentle-pi's screen stays closed");
	assert.equal(click(1, 4)?.handled, true, "the title");
	assert.deepEqual(loaded.sent.at(-1), ["/gentle:profiles", { expandPromptTemplates: true }]);
	bindings().delete("column-1");
});

// ---- Editing in the column, through gentle-pi's own writers (T24), staged until Save as in its screen (T25) ----

const stored = (env) => JSON.parse(readFileSync(path.join(env.configHome, "profiles.json"), "utf8"));
const storeText = (env) => readFileSync(path.join(env.configHome, "profiles.json"), "utf8");
const writes = () => globalThis.profileWrites ?? 0;
const KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", backspace: "\x7f" };
/** The picker's rows, plain, at `width`. */
const pickerRows = (picker, width = 55) => picker.render(width).map(plain);
/** A click inside the picker on the row reading `label`. */
const pickRow = (picker, label, width = 55) => {
	const y = pickerRows(picker, width).findIndex((row) => row.includes(label));
	assert.ok(y > 0, `${label} in the picker`);
	return picker.handleMouse({ type: "click", button: "left", x: 6, y, width, height: 20 });
};
/** A left click on the first row reading `label` (a button, a chip), in its middle. */
const press = (tab, rows, label) => {
	const out = rows();
	const y = out.findIndex((row) => row.includes(label));
	assert.ok(y >= 0, `${label} on the card:\n${out.join("\n")}`);
	return tab.handleClick(y, "left", out[y].indexOf(label) + Math.floor(label.length / 2));
};
/** Opens the picker on `agent`'s model and picks `model` (staged). */
async function pickModel(tab, rows, calls, agent, current, model) {
	const out = rows();
	const at = rowIndex(out, new RegExp(`${agent} `));
	assert.equal(tab.handleClick(at, "left", out[at].indexOf(current)), true);
	await settle();
	assert.equal(pickRow(calls.component(), model)?.handled, true);
	await settle();
}

test("a click on a profile selects the one shown in the card: nothing is bound or written", async () => {
	bindings().delete("s1");
	const env = install({ lib: EDIT_LIB });
	const before = storeText(env);
	const { tab, rows, draw, calls } = await opened(env);
	assert.equal(tab.handleClick(3, "left", rows()[3].indexOf("Balanced")), true);
	await settle();
	assert.equal(bindings().get("s1"), undefined, "not bound: Use in this session does that");
	assert.deepEqual(calls.sent, [], "gentle-pi's screen is not opened");
	assert.deepEqual(calls.setModel, []);
	const out = rows();
	assert.equal(out[3], "│ [○ 1: Balanced] [● 2: Max] [○ 3: Low]", "the marks stay where they are");
	const raw = draw();
	assert.ok(raw[3].includes(theme.bold("[○ 1: Balanced]")) && painted(raw[3], "muted", "Max"), "the selected chip in accent bold");
	assert.ok(out.some((row) => /gentle-ai-worker +gpt-5\.5 \(medium\)/.test(row)), "the roster is the selected profile's");
	assert.ok(!out.some((row) => /jd-judge-a/.test(row)));
	assert.equal(storeText(env), before);
});

test("the button row under the routing, as gentle-pi's screen: Use in this session, Make default, Save dim until an edit", async () => {
	const env = install({ lib: EDIT_LIB });
	const { rows, draw } = await opened(env);
	const out = rows();
	const at = rowIndex(out, /\[ Use in this session \]/);
	assert.ok(at > rowIndex(out, /review-risk/), "under the routing");
	assert.equal(out[at], "│ [ Use in this session ]  [ Make default ]  [ Save ]");
	assert.equal(out[at - 1], "│", "a blank row above it");
	const raw = draw();
	assert.ok(painted(raw[at], "accent", "[ Use in this session ]") && painted(raw[at], "accent", "[ Make default ]"));
	assert.ok(painted(raw[at], "dim", "[ Save ]"), "nothing to save: dim");
	assert.ok(!out.some((row) => /unsaved/.test(row)));
});

test("the button row wraps to two rows when the column is too narrow", async () => {
	const env = install({ lib: EDIT_LIB });
	const { tab, rows, calls } = await opened(env, {}, 40);
	const out = rows();
	const at = rowIndex(out, /\[ Use in this session \]/);
	assert.equal(out[at], "│ [ Use in this session ]");
	assert.equal(out[at + 1], "│ [ Make default ]  [ Save ]");
	assert.ok(out.every((row) => [...row].length <= 40));
	// The second row's buttons are where they are drawn.
	await pickModel(tab, rows, calls, "custom", "inherit", "xai/grok-4.7");
	const startWrites = writes();
	assert.equal(tab.handleClick(at + 1, "left", out[at + 1].indexOf("[ Save ]") + 2), true);
	await settle();
	assert.equal(writes(), startWrites + 1);
	assert.deepEqual(stored(env).profiles.Max.custom, { model: "xai/grok-4.7" });
});

test("model and effort edits are staged: nothing is written until Save, which writes once and clears the unsaved state", async () => {
	const env = install({ lib: EDIT_LIB });
	const before = storeText(env);
	const { tab, rows, draw, calls } = await opened(env);
	const startWrites = writes();
	await pickModel(tab, rows, calls, "gentle-ai-explore", "claude-sonnet-5-5", "xai/grok-4.7");
	assert.equal(calls.done.length, 1, "the picker closed");
	let out = rows();
	assert.ok(out.some((row) => /gentle-ai-explore +grok-4\.7 \(medium\)/.test(row)), "the card shows the edit");
	assert.equal(storeText(env), before, "nothing written yet");
	// An effort click is staged as well.
	const saved = { ...thinkingSupport };
	thinkingSupport.load = async () => ({ getSupportedThinkingLevels: () => ["off", "low", "medium", "high"] });
	try {
		const judge = rowIndex(rows(), /jd-judge-a/);
		assert.equal(tab.handleClick(judge, "left", rows()[judge].lastIndexOf("(high)") + 1), true);
		await settle();
	} finally {
		Object.assign(thinkingSupport, saved);
	}
	out = rows();
	assert.ok(out.some((row) => /jd-judge-a +claude-opus-5-5 \(inherit\)$/.test(row)), out.join("\n"));
	assert.equal(storeText(env), before, "still nothing written");
	assert.equal(writes(), startWrites);
	assert.equal(out[3], "│ [○ 1: Balanced] [● 2: Max •] [○ 3: Low]", "the chip says it has unsaved edits");
	assert.ok(out.some((row) => /● 2 unsaved/.test(row)), "the count, as gentle-pi's footer");
	let raw = draw();
	const explore = rowIndex(out, /gentle-ai-explore/);
	assert.ok(painted(raw[explore], "warning", "grok-4.7"), "a changed value in warning");
	assert.ok(painted(raw[3], "warning", "•"));
	const buttons = rowIndex(out, /\[ Save \]/);
	assert.ok(!painted(raw[buttons], "dim", "[ Save ]"), "Save is live");
	assert.equal(press(tab, rows, "[ Save ]"), true);
	await settle();
	assert.equal(writes(), startWrites + 1, "written once");
	const file = stored(env);
	assert.deepEqual(file.profiles.Max["gentle-ai-explore"], { model: "xai/grok-4.7", thinking: "medium" });
	assert.deepEqual(file.profiles.Max["jd-judge-a"], { model: "claude-bridge/claude-opus-5-5" });
	assert.deepEqual(file.profiles.Balanced, STORE.profiles.Balanced, "the other profiles untouched");
	assert.equal(file.active, "Max");
	out = rows();
	assert.equal(out[3], "│ [○ 1: Balanced] [● 2: Max] [○ 3: Low]", "no unsaved mark");
	assert.ok(!out.some((row) => /unsaved/.test(row)));
	raw = draw();
	assert.ok(painted(raw[rowIndex(out, /\[ Save \]/)], "dim", "[ Save ]"), "dim again");
	assert.ok(out.some((row) => /gentle-ai-explore +grok-4\.7 \(medium\)/.test(row)), "read back from gentle-pi");
	assert.ok(calls.notices.some(([text]) => /Saved "Max"/.test(text)));
});

test("Save with nothing staged writes nothing and says so", async () => {
	const env = install({ lib: EDIT_LIB });
	const before = storeText(env);
	const { tab, rows, calls } = await opened(env);
	const startWrites = writes();
	assert.equal(press(tab, rows, "[ Save ]"), true);
	await settle();
	assert.equal(writes(), startWrites);
	assert.equal(storeText(env), before);
	assert.ok(calls.notices.some(([text]) => text === "Nothing to save."));
});

test("Use in this session binds the selected profile and moves the session to its orchestrator", async () => {
	bindings().delete("s1");
	const env = install({ lib: EDIT_LIB });
	const before = storeText(env);
	const { tab, rows, calls } = await opened(env);
	tab.handleClick(3, "left", rows()[3].indexOf("Balanced"));
	await settle();
	assert.equal(press(tab, rows, "[ Use in this session ]"), true);
	await settle();
	assert.equal(bindings().get("s1")?.name, "Balanced");
	assert.deepEqual(bindings().get("s1").modelProfiles, STORE.profiles.Balanced, "the profile's routing, as a snapshot");
	assert.deepEqual(calls.setModel, [], "no orchestrator in Balanced: this session keeps its model");
	assert.equal(rows()[3], "│ [◉ 1: Balanced] [● 2: Max] [○ 3: Low]", "◉ follows, read again from gentle-pi");
	tab.handleClick(3, "left", rows()[3].indexOf("Max"));
	await settle();
	press(tab, rows, "[ Use in this session ]");
	await settle();
	assert.equal(bindings().get("s1")?.name, "Max");
	assert.deepEqual(calls.setModel.map((model) => `${model.provider}/${model.id}`), ["claude-bridge/claude-opus-5-5"]);
	assert.deepEqual(calls.thinking, ["high"]);
	assert.equal(rows()[3], "│ [○ 1: Balanced] [◉● 2: Max] [○ 3: Low]");
	assert.equal(storeText(env), before, "nothing shared is written");
	assert.deepEqual(calls.sent, []);
	bindings().delete("s1");
});

test("Use in this session with staged edits saves them first, as gentle-pi's screen does, then binds what is shown", async () => {
	bindings().delete("s1");
	const env = install({ lib: EDIT_LIB });
	const { tab, rows, calls } = await opened(env);
	const startWrites = writes();
	await pickModel(tab, rows, calls, "review-risk", "grok", "openai/gpt-5.5");
	assert.equal(press(tab, rows, "[ Use in this session ]"), true);
	await settle();
	assert.equal(writes(), startWrites + 1, "saved once");
	assert.deepEqual(stored(env).profiles.Max["review-risk"], { model: "openai/gpt-5.5" });
	assert.equal(bindings().get("s1")?.name, "Max");
	assert.deepEqual(bindings().get("s1").modelProfiles["review-risk"], { model: "openai/gpt-5.5" }, "the session takes what is shown");
	assert.ok(!rows().some((row) => /unsaved/.test(row)));
	assert.ok(calls.notices.some(([text]) => /Saved "Max"\. This session now uses "Max"/.test(text)));
	bindings().delete("s1");
});

test("Make default: gentle-pi keeps it in its screen, so staged edits are saved and /gentle:profiles opens", async () => {
	const env = install({ lib: EDIT_LIB });
	const { tab, rows, calls } = await opened(env);
	const startWrites = writes();
	assert.equal(press(tab, rows, "[ Make default ]"), true);
	await settle();
	assert.equal(writes(), startWrites, "nothing to save: nothing written");
	assert.deepEqual(calls.sent, [["/gentle:profiles", { expandPromptTemplates: true }]]);
	assert.ok(calls.notices.some(([text]) => /Make default/.test(text) && /"Max"/.test(text)));
	await pickModel(tab, rows, calls, "custom", "inherit", "xai/grok-4.7");
	press(tab, rows, "[ Make default ]");
	await settle();
	assert.equal(writes(), startWrites + 1, "the edits saved first, as gentle-pi's Make default does");
	assert.deepEqual(stored(env).profiles.Max.custom, { model: "xai/grok-4.7" });
	assert.equal(stored(env).active, "Max", "the default itself is left to gentle-pi");
	assert.equal(calls.sent.length, 2);
});

test("switching profiles with staged edits asks as gentle-pi's screen: Save and switch, Discard, Stay", async () => {
	const env = install({ lib: EDIT_LIB });
	const before = storeText(env);
	const { tab, rows, calls } = await opened(env);
	const startWrites = writes();
	await pickModel(tab, rows, calls, "custom", "inherit", "xai/grok-4.7");
	tab.handleClick(3, "left", rows()[3].indexOf("Balanced"));
	await settle();
	let out = rows();
	assert.ok(out.some((row) => row === "│ Max has 1 unsaved change."), out.join("\n"));
	assert.ok(out.some((row) => row === "│ [ Save and switch ]  [ Discard ]  [ Stay ]"));
	assert.ok(out.some((row) => /custom +grok-4\.7/.test(row)), "still on Max");
	// Stay: back to Max, the edit kept.
	press(tab, rows, "[ Stay ]");
	await settle();
	out = rows();
	assert.ok(!out.some((row) => /unsaved change\./.test(row)));
	assert.ok(out.some((row) => /custom +grok-4\.7/.test(row)) && out.some((row) => /● 1 unsaved/.test(row)));
	// Discard: on to Balanced, the edit dropped.
	tab.handleClick(3, "left", rows()[3].indexOf("Balanced"));
	await settle();
	press(tab, rows, "[ Discard ]");
	await settle();
	out = rows();
	assert.ok(out.some((row) => /gentle-ai-worker/.test(row)), "Balanced shown");
	assert.equal(storeText(env), before);
	tab.handleClick(3, "left", rows()[3].indexOf("Max"));
	await settle();
	assert.ok(rows().some((row) => /custom +inherit \(inherit\)$/.test(row)), "Max's edit was discarded");
	// Save and switch: written once, then Balanced.
	await pickModel(tab, rows, calls, "custom", "inherit", "xai/grok-4.7");
	tab.handleClick(3, "left", rows()[3].indexOf("Low"));
	await settle();
	press(tab, rows, "[ Save and switch ]");
	await settle();
	assert.equal(writes(), startWrites + 1);
	assert.deepEqual(stored(env).profiles.Max.custom, { model: "xai/grok-4.7" });
	out = rows();
	assert.ok(out.some((row) => /^│ orchestrator +leave untouched$/.test(row)) && out.some((row) => row === "│ no subagents routed"), "Low shown");
	assert.ok(!out.some((row) => /unsaved/.test(row)));
});

test("a right click on a profile is left alone", async () => {
	const env = install({ lib: EDIT_LIB });
	const before = storeText(env);
	const { tab, rows, calls } = await opened(env);
	const out = rows();
	assert.equal(tab.handleClick(3, "right", out[3].indexOf("Balanced")), false);
	await settle();
	assert.equal(storeText(env), before);
	assert.deepEqual(calls.sent, []);
});

test("a click on an agent's model opens a picker of Pi's models by the row; the choice is staged for that agent only", async () => {
	const env = install({ lib: EDIT_LIB });
	const before = storeText(env);
	const { tab, rows, calls } = await opened(env);
	const out = rows();
	const at = rowIndex(out, /gentle-ai-explore/);
	const x = out[at].indexOf("claude-sonnet-5-5");
	assert.equal(tab.handleClick(at, "left", x, { screenX: 121 + x, screenY: 14, x }), true);
	await settle();
	assert.equal(calls.custom.length, 1, "one pop-up");
	assert.deepEqual(calls.sent, []);
	const { options } = calls.custom[0];
	assert.equal(options.overlay, true);
	const picker = calls.component(); // Pi builds the pop-up, then places it
	const place = typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
	assert.equal(place.row, 15, "just under the clicked row");
	assert.ok(place.col >= 120 && place.col + place.width <= 180, "inside the column");
	assert.ok(place.width <= 55);
	const shown = pickerRows(picker);
	assert.ok(shown.every((row) => [...row].length <= 55), "fits 55 columns");
	assert.ok(shown.some((row) => row.includes("Model · gentle-ai-explore · Max")), shown.join("\n"));
	const listed = shown.filter((row) => /inherit|\w\//.test(row) && !row.includes("Model ·")).map((row) => row.replace(/^▏ [▸ ] ?/, "").replace(/ +▕$/, "").trim());
	assert.deepEqual(
		listed.map((row) => row.replace(/^● /, "")),
		["inherit", "claude-bridge/claude-opus-5-5", "claude-bridge/claude-sonnet-5-5", "openai/gpt-5.5", "xai/grok-4.7"],
		"inherit, then Pi's models as provider/model, sorted",
	);
	assert.ok(shown.some((row) => row.includes("● claude-bridge/claude-sonnet-5-5")), "the current model marked");
	assert.equal(pickRow(picker, "xai/grok-4.7")?.handled, true);
	await settle();
	assert.equal(calls.done.length, 1, "the picker closed");
	assert.equal(storeText(env), before, "staged, not written");
	const shownRows = rows();
	assert.ok(shownRows.some((row) => /gentle-ai-explore +grok-4\.7 \(medium\)/.test(row)));
	assert.ok(shownRows.some((row) => /jd-judge-a +claude-opus-5-5 \(high\)/.test(row)), "the other agents untouched");
	assert.ok(shownRows.some((row) => /● 1 unsaved/.test(row)));
});

test("the orchestrator's model picker: the keyboard moves and picks, and leave untouched removes it on Save", async () => {
	const env = install({ lib: EDIT_LIB });
	const { tab, rows, calls } = await opened(env);
	const out = rows();
	const at = rowIndex(out, /orchestrator/);
	assert.equal(tab.handleClick(at, "left", out[at].indexOf("claude-opus")), true);
	await settle();
	const picker = calls.component();
	assert.ok(pickerRows(picker).some((row) => row.includes("leave untouched")), "the orchestrator's inherit");
	picker.handleInput(KEYS.up);
	picker.handleInput(KEYS.enter);
	await settle();
	assert.equal(calls.done.length, 1);
	assert.ok(rows().some((row) => /^│ orchestrator +leave untouched$/.test(row)));
	assert.deepEqual(stored(env).profiles.Max.orchestrator, MAX.orchestrator, "not yet written");
	press(tab, rows, "[ Save ]");
	await settle();
	assert.equal(stored(env).profiles.Max.orchestrator, undefined);
	assert.ok(rows().some((row) => /^│ orchestrator +leave untouched$/.test(row)));
});

test("the picker filters as you type and keeps within the terminal", async () => {
	const env = install({ lib: EDIT_LIB });
	const { tab, rows, calls } = await opened(env, { rows: 20 });
	const out = rows();
	const at = rowIndex(out, /review-risk/);
	tab.handleClick(at, "left", out[at].indexOf("grok"), { screenX: 150, screenY: 19, x: 30 });
	await settle();
	const picker = calls.component();
	const place = calls.custom[0].options.overlayOptions();
	assert.ok(place.row + picker.render(place.width).length <= 20, "moved up to fit");
	for (const char of "son") picker.handleInput(char);
	let listed = pickerRows(picker).filter((row) => row.includes("/"));
	assert.deepEqual(listed.map((row) => row.match(/[\w-]+\/[\w.-]+/)[0]), ["claude-bridge/claude-sonnet-5-5"]);
	picker.handleInput(KEYS.backspace);
	picker.handleInput(KEYS.backspace);
	picker.handleInput(KEYS.backspace);
	listed = pickerRows(picker).filter((row) => row.includes("/"));
	assert.equal(listed.length, 4);
});

test("Esc or a click outside closes the picker and stages nothing", async () => {
	const env = install({ lib: EDIT_LIB });
	const before = storeText(env);
	const { tab, rows, calls } = await opened(env);
	const out = rows();
	const at = rowIndex(out, /jd-judge-a/);
	tab.handleClick(at, "left", out[at].indexOf("claude-opus"));
	await settle();
	let picker = calls.component();
	picker.handleInput(KEYS.down);
	picker.handleInput(KEYS.escape);
	assert.equal(calls.done.length, 1);
	tab.handleClick(at, "left", out[at].indexOf("claude-opus"));
	await settle();
	picker = calls.component();
	calls.top = { component: picker };
	const routed = calls.tui.dispatchMouseToOverlay({ type: "press", button: "left", screenX: 2, screenY: 2, width: 180, height: 40 });
	assert.equal(routed.hit, true, "the press is taken");
	assert.equal(calls.done.length, 2, "and closes the picker");
	await settle();
	assert.equal(storeText(env), before);
	assert.deepEqual(calls.sent, []);
	assert.ok(!rows().some((row) => /unsaved/.test(row)));
});

test("a click on an agent's effort cycles the levels gentle-pi offers for its model, staged; Save keeps the last", async () => {
	const env = install({ lib: EDIT_LIB });
	const before = storeText(env);
	const { tab, rows } = await opened(env);
	const click = (agent, effort) => {
		const out = rows();
		const at = rowIndex(out, new RegExp(`${agent} `));
		const x = out[at].lastIndexOf(`(${effort})`);
		assert.ok(x > 0, `${agent} (${effort})`);
		return tab.handleClick(at, "left", x + 1);
	};
	const shows = (agent, effort) => assert.ok(rows().some((row) => new RegExp(`${agent} +claude-[\\w.-]+ \\(${effort}\\)$`).test(row)), `${agent} (${effort})`);
	// Pi says nothing about the model's levels here: every level, then inherit.
	const saved = { ...thinkingSupport };
	thinkingSupport.load = async () => {
		throw new Error("no pi-ai");
	};
	try {
		for (const [from, to] of [["high", "xhigh"], ["xhigh", "max"], ["max", "inherit"], ["inherit", "off"]]) {
			assert.equal(click("jd-judge-a", from), true);
			await settle();
			shows("jd-judge-a", to);
		}
		// Pi's catalog knows the model's levels: only those.
		thinkingSupport.load = async () => ({ getSupportedThinkingLevels: () => ["off", "low", "medium", "high"] });
		for (const [from, to] of [["medium", "high"], ["high", "inherit"], ["inherit", "off"], ["off", "low"]]) {
			assert.equal(click("gentle-ai-explore", from), true);
			await settle();
			shows("gentle-ai-explore", to);
		}
	} finally {
		Object.assign(thinkingSupport, saved);
	}
	assert.equal(storeText(env), before, "staged only");
	press(tab, rows, "[ Save ]");
	await settle();
	assert.deepEqual(stored(env).profiles.Max["jd-judge-a"], { model: "claude-bridge/claude-opus-5-5", thinking: "off" });
	assert.deepEqual(stored(env).profiles.Max["gentle-ai-explore"], { model: "claude-bridge/claude-sonnet-5-5", thinking: "low" });
});

test("saving the profile this session uses keeps the session on what is saved", async () => {
	bindings().delete("s1");
	const env = install({ lib: EDIT_LIB });
	const { tab, rows, calls } = await opened(env);
	press(tab, rows, "[ Use in this session ]");
	await settle();
	assert.equal(bindings().get("s1")?.name, "Max");
	await pickModel(tab, rows, calls, "review-risk", "grok", "openai/gpt-5.5");
	assert.deepEqual(bindings().get("s1")?.modelProfiles["review-risk"], { model: "xai/grok-4.7" }, "staged: the session is unchanged");
	press(tab, rows, "[ Save ]");
	await settle();
	assert.deepEqual(stored(env).profiles.Max["review-risk"], { model: "openai/gpt-5.5" });
	assert.deepEqual(bindings().get("s1")?.modelProfiles["review-risk"], { model: "openai/gpt-5.5" }, "the session's snapshot follows");
	bindings().delete("s1");
});

test("the title still opens gentle-pi's full editor", async () => {
	const env = install({ lib: EDIT_LIB });
	const { tab, calls } = await opened(env);
	assert.equal(tab.handleClick(1, "left", 4), true);
	assert.deepEqual(calls.sent, [["/gentle:profiles", { expandPromptTemplates: true }]]);
	assert.equal(calls.custom.length, 0);
});

test("without gentle-pi's writers, or with Gentle Shell on, every click runs /gentle:profiles and nothing is written", async () => {
	for (const [lib, shellOff] of [[LIB, true], [{ ...EDIT_LIB, "session-profile-binding.ts": LIB["session-profile-binding.ts"] }, true], [EDIT_LIB, false]]) {
		bindings().delete("s1");
		const env = install({ lib });
		const before = storeText(env);
		const { tab, rows, calls } = await opened(env, { shellOff });
		const out = rows();
		const roster = rowIndex(out, /jd-judge-a/);
		assert.equal(tab.handleClick(3, "left", out[3].indexOf("Balanced")), true);
		assert.equal(tab.handleClick(roster, "left", out[roster].indexOf("claude-opus")), true);
		assert.equal(tab.handleClick(roster, "left", out[roster].indexOf("(high)") + 1), true);
		for (const label of ["[ Use in this session ]", "[ Make default ]", "[ Save ]"]) assert.equal(press(tab, rows, label), true, label);
		await settle();
		assert.equal(calls.sent.length, 6);
		assert.ok(calls.sent.every(([text]) => text === "/gentle:profiles"));
		assert.equal(calls.custom.length, 0, "no picker");
		assert.equal(storeText(env), before);
		assert.equal(bindings().get("s1"), undefined);
	}
});

// ---- The keyboard, as gentle-pi's /gentle:profiles screen (T26) ----

const KEY = { left: "\x1b[D", right: "\x1b[C", up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", ctrlS: "\x13" };
const INVERSE = "\x1b[7m";
// The test theme's selectedBg (host() above).
const SELECTED = "\x1b[48;5;240m";
/** The roster row the keyboard has selected (the one on the selection background), plain, or undefined. */
const marked = (draw) => {
	const row = draw().find((line) => line.includes(SELECTED));
	return row === undefined ? undefined : plain(row).replace(/ +│$/, "");
};
/** A card row's content between the outline's "│ " and " │". */
const content = (line) => line.slice(line.indexOf("│") + 1 + "\x1b[39m ".length, line.lastIndexOf(theme.fg("border", "│")) - 1);
const HINT = /←→ profile · ↑↓ agent/;

test("a left click anywhere on the Profiles card gives the tab the keyboard; the click still does its own", async () => {
	const env = install({ lib: EDIT_LIB });
	const { tab, rows, calls } = await opened(env);
	const out = rows();
	assert.equal(tab.handleClick(3, "left", out[3].length + 2), false, "past the last chip: nothing to do");
	assert.deepEqual(calls.focuses, ["prof"], "but the card has the keyboard");
	assert.equal(tab.handleClick(3, "left", out[3].indexOf("Balanced")), true);
	assert.equal(calls.focuses.length, 2);
	assert.ok(rows().some((row) => /gentle-ai-worker/.test(row)), "the chip still selects");
	calls.focused = undefined;
	assert.equal(tab.handleClick(3, "right", 4), false);
	assert.equal(tab.handleClick(rowIndex(rows(), /Plan usage/) + 2, "left", 4), false);
	assert.equal(calls.focuses.length, 2, "not a right click, not the Plan usage card");
});

test("unfocused, the card is as today: no selected row, no hint, and keys are not the tab's", async () => {
	const env = install({ lib: EDIT_LIB });
	const { rows, draw } = await opened(env);
	assert.equal(marked(draw), undefined);
	assert.ok(!rows().some((row) => HINT.test(row)));
	assert.ok(!draw().some((row) => row.includes(INVERSE) || row.includes(SELECTED)));
});

test("focused: the selected row is on the selection background, the text where it was, ↑↓ move it over the orchestrator and the agents, and a dim hint fits the card", async () => {
	const env = install({ lib: EDIT_LIB });
	const { tab, rows, draw, calls } = await opened(env);
	calls.focused = "prof";
	assert.match(marked(draw), /^│ orchestrator +claude-opus-5-5 \(high\)/, "the orchestrator first, nothing moved");
	const unfocused = (calls.focused = undefined, draw());
	calls.focused = "prof";
	const raw = draw();
	const at = raw.findIndex((row) => row.includes(SELECTED));
	const text = plain(content(unfocused[at]));
	assert.equal([...text].length, 55, "the card's inner width");
	assert.match(text, /^orchestrator +claude-opus-5-5 \(high\)$/);
	assert.equal(content(raw[at]), `${SELECTED}${theme.fg("text", text)}\x1b[49m`, "the whole row, name, model and effort, plain text on selectedBg");
	assert.equal(raw.filter((row) => row.includes(SELECTED)).length, 1, "one row");
	const above = (rows) => rows.slice(0, rows.findIndex((row) => HINT.test(plain(row))));
	above(raw).forEach((row, index) => index === at || assert.equal(row, unfocused[index], `row ${index} untouched`));
	assert.ok(!raw.some((row) => row.includes(INVERSE)), "no reverse video");
	assert.ok(!rows().some((row) => row.includes("▸")), "no glyph");
	const hint = rows().findIndex((row) => HINT.test(row));
	assert.ok(hint > rowIndex(rows(), /\[ Save \]/), `under the buttons:\n${rows().join("\n")}`);
	assert.ok(raw[hint].includes(role("dim")));
	assert.ok(rows().every((row) => [...row].length <= 59));
	assert.equal(tab.handleKey(KEY.down), true);
	assert.match(marked(draw), /^│ custom /);
	for (let i = 0; i < 10; i++) tab.handleKey(KEY.down);
	assert.match(marked(draw), /^│ review-risk /, "stops at the last agent");
	tab.handleKey(KEY.up);
	assert.match(marked(draw), /^│ jd-judge-a /);
	for (let i = 0; i < 10; i++) tab.handleKey(KEY.up);
	assert.match(marked(draw), /^│ orchestrator /, "stops at the orchestrator");
	const wide = tab.render(100, 40).map(plain);
	assert.ok(wide.some((row) => row.includes("←→ profile · ↑↓ agent · enter model · e effort · s save · u use · d default · esc")), wide.join("\n"));
	assert.ok(tab.render(30, 40).map(plain).every((row) => [...row].length <= 30), "cut to a narrow column");
});

test("←→ show the previous or next profile, as a click on its chip, and stop at the ends", async () => {
	const env = install({ lib: EDIT_LIB });
	const { tab, rows, calls } = await opened(env);
	calls.focused = "prof";
	assert.equal(tab.handleKey(KEY.left), true);
	assert.ok(rows().some((row) => /gentle-ai-worker/.test(row)), "Balanced");
	tab.handleKey(KEY.left);
	assert.ok(rows().some((row) => /gentle-ai-worker/.test(row)), "still Balanced: the first");
	tab.handleKey(KEY.right);
	tab.handleKey(KEY.right);
	assert.ok(rows().some((row) => /no subagents routed/.test(row)), "Low");
	tab.handleKey(KEY.right);
	assert.ok(rows().some((row) => /no subagents routed/.test(row)), "still Low: the last");
	assert.equal(bindings().get("s1"), undefined, "only shown, as a chip click");
	assert.deepEqual(calls.sent, []);
});

test("←→ away from unsaved edits ask as a click does; s saves and switches, d discards, esc stays", async () => {
	const env = install({ lib: EDIT_LIB });
	const { tab, rows, calls } = await opened(env);
	calls.focused = "prof";
	const startWrites = writes();
	await pickModel(tab, rows, calls, "custom", "inherit", "xai/grok-4.7");
	tab.handleKey(KEY.left);
	assert.ok(rows().some((row) => row === "│ Max has 1 unsaved change."));
	assert.ok(rows().some((row) => /s save and switch · d discard · esc stay/.test(row)), "the hint follows the question");
	assert.equal(tab.handleKey(KEY.escape), true, "esc answers Stay; the keyboard stays");
	await settle();
	assert.ok(!rows().some((row) => /unsaved change\./.test(row)));
	assert.ok(rows().some((row) => /● 1 unsaved/.test(row)));
	tab.handleKey(KEY.left);
	tab.handleKey("d");
	await settle();
	assert.ok(rows().some((row) => /gentle-ai-worker/.test(row)), "Discard: on to Balanced");
	assert.equal(writes(), startWrites);
	tab.handleKey(KEY.right);
	await pickModel(tab, rows, calls, "custom", "inherit", "xai/grok-4.7");
	tab.handleKey(KEY.right);
	tab.handleKey("s");
	await settle();
	assert.equal(writes(), startWrites + 1, "Save and switch");
	assert.deepEqual(stored(env).profiles.Max.custom, { model: "xai/grok-4.7" });
	assert.ok(rows().some((row) => /no subagents routed/.test(row)), "on to Low");
});

test("enter opens the model picker on the selected row; while it is open the keys are its own, and esc closes it first", async () => {
	const env = install({ lib: EDIT_LIB });
	const before = storeText(env);
	const { tab, rows, calls } = await opened(env);
	calls.focused = "prof";
	tab.handleKey(KEY.down);
	tab.handleKey(KEY.down);
	assert.equal(tab.handleKey(KEY.enter), true);
	await settle();
	assert.equal(calls.custom.length, 1, "one pop-up");
	const picker = calls.component();
	assert.ok(pickerRows(picker).some((row) => row.includes("Model · gentle-ai-explore · Max")));
	assert.ok(pickerRows(picker).some((row) => row.includes("● claude-bridge/claude-sonnet-5-5")));
	assert.equal(tab.handleKey(KEY.escape), true, "esc goes to the picker");
	assert.equal(calls.done.length, 1, "and closes it");
	assert.equal(tab.handleKey(KEY.escape), false, "the next esc is the column's: it gives the keyboard back");
	assert.equal(storeText(env), before);
	// enter and the picker's own keys pick a model, staged on that row.
	tab.handleKey(KEY.enter);
	await settle();
	const second = calls.component();
	for (const char of "grok") assert.equal(tab.handleKey(char), true);
	tab.handleKey(KEY.enter);
	await settle();
	assert.equal(calls.done.length, 2);
	assert.ok(rows().some((row) => /gentle-ai-explore +grok-4\.7 \(medium\)/.test(row)), rows().join("\n"));
	assert.ok(second.closed);
	assert.equal(storeText(env), before, "staged, not written");
});

test("e steps the selected row's effort, as a click on it", async () => {
	const env = install({ lib: EDIT_LIB });
	const { tab, rows, calls } = await opened(env);
	calls.focused = "prof";
	const saved = { ...thinkingSupport };
	thinkingSupport.load = async () => {
		throw new Error("no pi-ai");
	};
	try {
		assert.equal(tab.handleKey("e"), true);
		await settle();
		assert.ok(rows().some((row) => /orchestrator +claude-opus-5-5 \(xhigh\)/.test(row)), rows().join("\n"));
		tab.handleKey(KEY.down);
		tab.handleKey(KEY.down);
		tab.handleKey(KEY.down);
		tab.handleKey("e");
		await settle();
		assert.ok(rows().some((row) => /jd-judge-a +claude-opus-5-5 \(xhigh\)/.test(row)));
	} finally {
		Object.assign(thinkingSupport, saved);
	}
	assert.ok(rows().some((row) => /● 2 unsaved/.test(row)));
});

test("s and ctrl+s save, u uses in this session, d makes default: the buttons' own actions", async () => {
	bindings().delete("s1");
	const env = install({ lib: EDIT_LIB });
	const { tab, rows, calls } = await opened(env);
	calls.focused = "prof";
	const startWrites = writes();
	assert.equal(tab.handleKey("s"), true);
	await settle();
	assert.ok(calls.notices.some(([text]) => text === "Nothing to save."));
	await pickModel(tab, rows, calls, "custom", "inherit", "xai/grok-4.7");
	assert.equal(tab.handleKey(KEY.ctrlS), true);
	await settle();
	assert.equal(writes(), startWrites + 1);
	assert.deepEqual(stored(env).profiles.Max.custom, { model: "xai/grok-4.7" });
	tab.handleKey(KEY.left);
	assert.equal(tab.handleKey("u"), true);
	await settle();
	assert.equal(bindings().get("s1")?.name, "Balanced");
	assert.equal(tab.handleKey("d"), true);
	await settle();
	assert.deepEqual(calls.sent, [["/gentle:profiles", { expandPromptTemplates: true }]]);
	assert.equal(tab.handleKey("x"), false, "a key it has no use for");
	bindings().delete("s1");
});

test("without gentle-pi's writers the keys do what the clicks do: /gentle:profiles", async () => {
	const env = install();
	const { tab, calls } = await opened(env);
	calls.focused = "prof";
	for (const key of [KEY.right, KEY.enter, "e", "s", "u", "d"]) assert.equal(tab.handleKey(key), true, JSON.stringify(key));
	await settle();
	assert.equal(calls.sent.length, 6);
	assert.ok(calls.sent.every(([text]) => text === "/gentle:profiles"));
	assert.equal(calls.custom.length, 0);
});

test("a selected entry that wraps is on the selection background on both of its rows", async () => {
	const env = install({ lib: EDIT_LIB });
	const { tab, draw, calls } = await opened(env, {}, 34);
	const unfocused = draw();
	calls.focused = "prof";
	tab.handleKey(KEY.down);
	tab.handleKey(KEY.down);
	const raw = draw();
	const at = raw.map((row, index) => (row.includes(SELECTED) ? index : -1)).filter((index) => index >= 0);
	assert.equal(at.length, 2, raw.map(plain).join("\n"));
	assert.equal(at[1], at[0] + 1);
	assert.match(plain(content(raw[at[0]])), /^gentle-ai-explore +$/);
	assert.match(plain(content(raw[at[1]])), /^ +claude-sonnet-5-5 \(medium\) *$/);
	for (const index of at) {
		const text = plain(content(unfocused[index]));
		assert.equal([...text].length, 30);
		assert.equal(content(raw[index]), `${SELECTED}${theme.fg("text", text)}\x1b[49m`);
	}
	raw.slice(0, raw.findIndex((row) => HINT.test(plain(row)))).forEach((row, index) => at.includes(index) || assert.equal(row, unfocused[index], `row ${index} untouched`));
});

test("a theme without selectedBg: the selected name in reverse video and accent bold, as before", async () => {
	const env = install({ lib: EDIT_LIB });
	const { draw, calls } = await opened(env, { selectedBg: false });
	calls.focused = "prof";
	const raw = draw();
	const at = raw.findIndex((row) => row.includes(INVERSE));
	assert.ok(raw[at].includes(`${INVERSE}${theme.bold(theme.fg("accent", "orchestrator"))}`), "the same text in reverse video, accent bold");
	assert.match(plain(raw[at]), /^│ orchestrator +claude-opus-5-5 \(high\)/);
	assert.ok(!raw.some((row) => row.includes(SELECTED)));
});
