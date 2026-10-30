import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configFile, load, painted, plain, role, theme, writeConfig } from "./helpers.mjs";
import { createTab, PROF_TIMEOUTS } from "../extensions/sidebar/prof.ts";

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
function host(env, { git, usage = { name: "", windows: [] }, sessionId = "s1", noPi = false } = {}) {
	const calls = { git: [], sent: [], renders: 0, usage: 0 };
	const h = {
		theme,
		fg: (name, text) => theme.fg(name, text),
		bold: (text) => theme.bold(text),
		card: (title, rows, width) => boxed([theme.fg("toolTitle", theme.bold(title)), ...(rows.length ? ["", ...rows] : [])], width),
		box: (rows, width) => boxed(rows, width),
		inner: (width) => width - 4,
		cwd: () => env?.repo,
		ctx: () => ({ sessionManager: { getSessionId: () => sessionId } }),
		pi: noPi ? undefined : { sendUserMessage: (text, options) => calls.sent.push([text, options]) },
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
	};
	return { host: h, calls };
}

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
		assert.equal(out[3], "│ [◉ 1: Balanced] [★ 2: Max] [⌂ 3: Low]");
		const raw = draw();
		assert.ok(raw[3].includes(role("accent")) && raw[3].includes(theme.bold("[◉ 1: Balanced]")), "the session's profile is the one shown");
		assert.ok(painted(raw[3], "muted", "Max") && painted(raw[3], "accent", "★"), "others muted, marks in their tones");
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
	assert.equal(out[3], "│ [○ 1: Balanced] [★ 2: Max] [○ 3: Low]", "no session, no pin: the default is shown");
	const orchestrator = rowIndex(out, /orchestrator/);
	assert.match(out[orchestrator], /^│ ◆ orchestrator +claude-opus-5-5 \(high\)$/);
	assert.equal(out[orchestrator + 1], "│");
	const roster = out.slice(orchestrator + 2, orchestrator + 6);
	[/^│ • custom +inherit \(inherit\)$/, /^│ • gentle-ai-explore +claude-sonnet-5-5 \(medium\)$/, /^│ • jd-judge-a +claude-opus-5-5 \(high\)$/, /^│ • review-risk +grok-4\.7 \(inherit\)$/].forEach((pattern, i) =>
		assert.match(roster[i], pattern),
	);
	assert.ok(roster.every((row) => [...row].length === 57), "the model and effort flush with the card's edge");
	const raw = draw();
	assert.ok(painted(raw[orchestrator + 3], "accent", "•"), "gentle-ai- agents in accent");
	assert.ok(painted(raw[orchestrator + 4], "warning", "•"), "jd- agents in warning");
	assert.ok(painted(raw[orchestrator + 5], "success", "•"), "review- agents in success");
	assert.ok(painted(raw[orchestrator + 3], "dim", "(medium)"), "the effort dim");
	assert.ok(out.every((row) => [...row].length <= 59));
});

test("a roster row too long for the card puts the model on its own row", async () => {
	const env = install({ store: { ...STORE, profiles: { Max: { "gentle-ai-a-very-long-agent-name-here": { model: "provider/a-very-long-model-name-for-sure", thinking: "xhigh" } } } } });
	const { rows } = await opened(env, {}, 50);
	const out = rows();
	const at = rowIndex(out, /gentle-ai-a-very-long/);
	assert.match(out[at], /^│ • gentle-ai-a-very-long-agent-name-here$/);
	assert.match(out[at + 1], /^│ {3}a-very-long-model-name-for-sure \(xhigh\)$/);
});

test("a profile with no subagents and no orchestrator says so", async () => {
	const env = install({ store: { ...STORE, active: "Low" } });
	const out = (await opened(env)).rows();
	assert.ok(out.some((row) => /◆ orchestrator +leave untouched/.test(row)));
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
	assert.equal(out[3], "│ [○ 1: Balanced] [★ 2: Max] [⌂ 3: Low]");
	assert.ok(out.some((row) => /^│ ◆ orchestrator +leave untouched$/.test(row)), "the pinned profile is shown");
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
		assert.equal(out[3], "│ [○ 1: Balanced] [★ 2: Max] [○ 3: Low]");
	}
});

test("a git that never answers times out: the profiles show without the repository mark", async () => {
	const saved = { ...PROF_TIMEOUTS };
	PROF_TIMEOUTS.git = 10;
	try {
		const env = install();
		env.pin("local", "Low");
		const out = (await opened(env, { git: () => new Promise(() => {}) })).rows();
		assert.equal(out[3], "│ [○ 1: Balanced] [★ 2: Max] [○ 3: Low]");
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
	assert.equal(rows()[3], "│ [○ 1: Balanced] [★ 2: Max] [○ 3: Low]");
	env.writeStore({ ...STORE, active: "Balanced" });
	const before = calls.renders;
	tab.onShow();
	await settle();
	assert.equal(rows()[3], "│ [★ 1: Balanced] [○ 2: Max] [○ 3: Low]");
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

test("in gentle-quiet's column: PROF draws the Profiles card and a click on a profile runs /gentle:profiles", async () => {
	const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
	const agentDir = path.dirname(configFile);
	const libDir = path.join(agentDir, "npm/node_modules/gentle-pi/lib");
	mkdirSync(libDir, { recursive: true });
	for (const [name, source] of Object.entries(LIB)) writeFileSync(path.join(libDir, name), source);
	const configHome = mkdtempSync(path.join(os.tmpdir(), "gentle-quiet-test-prof-home-"));
	writeFileSync(path.join(configHome, "profiles.json"), JSON.stringify(STORE));
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writeConfig({});
	const loaded = await load({ mode: "tui", session: { cwd: "/srv/app", model: { id: "claude-opus-5-5" } } });
	const native = { type: "vstack", entries: [] };
	const root = { render: () => [], [NODE]: () => native };
	const tui = { terminal: { columns: 180, rows: 40 }, mode: "fullscreen", layoutRoot: root, requestRender() {} };
	loaded.footer()?.(tui, theme, { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} });
	const side = () => root[NODE]().entries?.[1]?.component?.[NODE]?.();
	const bar = side().entries[0].component;
	const x = plain(bar.render(60)[0]).indexOf("4:PROF") + 1;
	bar.handleMouse({ type: "click", button: "left", x, y: 0, width: 60, height: 2, screenX: 120, screenY: 0 });
	const content = () => side().entries.at(-1).component;
	content().render(60);
	await settle();
	const out = content().render(60).map(plain);
	assert.match(out[1], /^│ Profiles/);
	const at = rowIndex(out, /\[★ 2: Max\]/);
	assert.ok(at > 0, out.join("\n"));
	const result = content().handleMouse({ type: "click", button: "left", x: out[at].indexOf("Max"), y: at, width: 60, height: 38, screenX: 120, screenY: at + 2 });
	assert.equal(result?.handled, true);
	assert.deepEqual(loaded.sent.at(-1), ["/gentle:profiles", { expandPromptTemplates: true }]);
});
