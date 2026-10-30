import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { configFile, load, picker, plain, readConfig, theme, writeConfig } from "./helpers.mjs";

// Stand-ins for gentle-pi's jobs files, installed where Pi keeps npm packages: the event and its
// snapshot check (lib/jobs-sidebar-state.ts) and the card (lib/jobs-widget.ts).
const agentDir = path.dirname(configFile);
const lib = path.join(agentDir, "npm/node_modules/gentle-pi/lib");
const settingsFile = path.join(agentDir, "settings.json");
mkdirSync(lib, { recursive: true });
writeFileSync(path.join(lib, "jobs-sidebar-state.ts"), `
export const JOBS_SIDEBAR_EVENT = "gentle-ai:jobs-sidebar";
export function jobsCollapseKey(env = process.env) {
	const value = env.GENTLE_PI_JOBS_KEY?.trim();
	if (value === undefined) return "ctrl+shift+j";
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}
export function isJobsSidebarSnapshot(value) {
	return Array.isArray(value?.jobs) && value.jobs.every((job) => typeof job?.id === "string" && typeof job.startedAt === "number");
}
`);
writeFileSync(path.join(lib, "jobs-widget.ts"), `
export const JOBS_FINISHED_TTL_MS = 60000;
export function widgetJobs(jobs, now) {
	const running = jobs.filter((job) => job.status === undefined).sort((a, b) => b.startedAt - a.startedAt);
	const finished = jobs.filter((job) => job.status !== undefined && now - job.endedAt < JOBS_FINISHED_TTL_MS);
	return [...running, ...finished];
}
// Like gentle-pi's: a panel with a margin, the title with its collapse control, one row per job.
export function renderJobsCard(jobs, theme, width, now, options) {
	const shown = widgetJobs(jobs, now);
	if (shown.length === 0) return [];
	const mark = (job) => (job.status === undefined ? theme.fg("accent", "⧗") : job.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗"));
	const row = (job) => {
		const elapsed = Math.round(((job.status === undefined ? now : job.endedAt) - job.startedAt) / 1000) + "s";
		const head = "⧗  " + job.label;
		return "   " + mark(job) + head.slice(1) + " ".repeat(Math.max(1, width - 5 - head.length - elapsed.length)) + theme.fg("dim", elapsed);
	};
	const listed = options.collapsed ? [shown[0]] : shown;
	const control = options.collapseControl ? (options.collapsed ? " ▸ Expand" : " ▾ Collapse") : "";
	const body = listed.map(row);
	if (options.collapsed && shown.length > 1) body.push("   … " + (shown.length - 1) + " more");
	if (options.collapsed && options.collapseKey) body.push("   " + options.collapseKey + " expand");
	return ["   ⧗ Jobs" + control + "  " + shown.length + " jobs", ...body];
}
`);

const shellOff = () => writeFileSync(settingsFile, JSON.stringify({ packages: [{ source: "npm:gentle-pi", extensions: ["-extensions/gentle-shell.ts"] }] }));
const shellOn = () => writeFileSync(settingsFile, JSON.stringify({ packages: ["npm:gentle-pi"] }));

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const EVENT = "gentle-ai:jobs-sidebar";

// A fullscreen host whose layout root hands out the native tree until the extension swaps it.
function host(columns = 180) {
	const native = { type: "vstack", entries: [] };
	const root = { render: () => [], [NODE]: () => native };
	const tui = { terminal: { columns, rows: 40 }, mode: "fullscreen", layoutRoot: root, requestRender() {} };
	return { tui, root, native };
}

// The status gentle-agents sets next to the event, as the footer reads it.
const statuses = new Map([["gentle-jobs", "⧗ 2 jobs"]]);
const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => statuses, onBranchChange: () => () => {} };

async function wide({ columns, config = {}, load: options = {} } = {}) {
	writeConfig(config);
	const loaded = await load({ mode: "tui", ...options, session: { id: "s1", cwd: "/srv/app", model: { id: "claude-opus-5-5" }, usage: { percent: 28 } } });
	const h = host(columns);
	const footer = loaded.footer()?.(h.tui, theme, footerData);
	// [conversation | [Status card / the other cards, scrolling]]
	const layout = () => {
		const tree = h.root[NODE]();
		const side = tree.entries?.[1]?.component?.[NODE]?.();
		return { tree, status: side?.entries?.[1]?.component, rail: side?.entries?.[2]?.component }; // under the tab bar
	};
	const publish = (jobs, sessionId = "s1") => loaded.events.emit(EVENT, { sessionId, snapshot: { jobs } });
	const rows = () => layout().rail?.render(60).map(plain) ?? [];
	return { ...loaded, ...h, footer, layout, publish, rows };
}

const now = Date.now();
const build = { id: "job-1", label: "npm run build", startedAt: now - 12_000 };
const tests = { id: "job-2", label: "npm test", startedAt: now - 3_000 };

test("with Gentle Shell off, running jobs get their own card on top of the side column, newest first", async () => {
	shellOff();
	const { publish, rows } = await wide();
	publish([build, tests]);
	const out = rows().map((row) => row.replace(/ +│$/, ""));
	const top = out.findIndex((row) => row.startsWith("┌"));
	assert.equal(top, 0, "the Jobs card comes first under the Status card");
	assert.match(out[1], /^│ ⧗ Jobs ▾ Collapse {2}2 jobs/u, "a still icon on the title: only running jobs spin");
	assert.equal(out[2], "│", "a blank row under the title");
	assert.match(out[3], /^│ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] npm test +3s$/u, "newest first, one space after the glyph, elapsed on the right");
	assert.match(out[4], /^│ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] npm run build +12s$/u);
	assert.ok(out[5].startsWith("└"));
	assert.ok(out.slice(2).every((row) => !row.includes("⧗")), "the rows spin with Pi's Working spinner");
});

test("the Jobs title icon is an Icons choice, saved: another glyph or none", async () => {
	shellOff();
	const { publish, rows } = await wide({ config: { icons: { jobs: "◷" } } });
	publish([build]);
	assert.match(rows()[1], /^│ ◷ Jobs ▾ Collapse/);
	const none = await wide({ config: { icons: { jobs: "" } } });
	none.publish([build]);
	assert.match(none.rows()[1], /^│ Jobs ▾ Collapse/);
	assert.match(none.rows()[3], /^│ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] npm run build/u, "the rows keep spinning");
});

test("/gentle-quiet lists the Jobs icon with the other icons", async () => {
	shellOff();
	const { select, seen } = picker(/^Icons ›$/, /^Jobs icon/, /^◆$/);
	const { commands, ctx } = await wide({ load: { select } });
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[1].items.includes('Jobs icon: "⧗"'));
	assert.equal(readConfig().icons.jobs, "◆");
});

test("the Status card drops the job count while the Jobs card shows the jobs", async () => {
	shellOff();
	const { publish, layout } = await wide();
	assert.match(plain(layout().status.render(60).join("\n")), /2 jobs/, "no Jobs card yet: the count stays");
	publish([build]);
	const { status } = layout();
	assert.doesNotMatch(plain(status.render(60).join("\n")), /2 jobs/);
});

test("finished jobs keep their outcome mark and the card clears itself once they age out", async () => {
	shellOff();
	const { publish, rows } = await wide();
	publish([{ ...build, status: "exited", exitCode: 0, endedAt: now - 2_000 }]);
	assert.ok(rows().some((row) => /^│ ✓ npm run build +10s/.test(row)));
	publish([{ ...build, status: "exited", exitCode: 0, endedAt: now - 61_000 }]);
	assert.deepEqual(rows(), []);
});

test("snapshots of another session or of the wrong shape are ignored", async () => {
	shellOff();
	const { publish, events, rows } = await wide();
	publish([build], "other");
	assert.deepEqual(rows(), []);
	events.emit(EVENT, { sessionId: "s1", snapshot: { jobs: [{ label: "no id" }] } });
	assert.deepEqual(rows(), []);
});

test("ctrl+shift+j collapses the card to its newest job and expands it again", async () => {
	shellOff();
	const { publish, rows, shortcuts, ctx } = await wide();
	publish([build, tests]);
	assert.ok(shortcuts["ctrl+shift+j"], "the shortcut is registered");
	await shortcuts["ctrl+shift+j"].handler(ctx);
	const collapsed = rows();
	assert.match(collapsed[1], /Jobs ▸ Expand/);
	assert.ok(collapsed.some((row) => row.includes("npm test")));
	assert.ok(!collapsed.some((row) => row.includes("npm run build")));
	assert.ok(collapsed.some((row) => row.includes("… 1 more")));
	assert.ok(collapsed.some((row) => row.includes("ctrl+shift+j expand")));
	await shortcuts["ctrl+shift+j"].handler(ctx);
	assert.ok(rows().some((row) => row.includes("npm run build")));
});

test("GENTLE_PI_JOBS_KEY remaps or disables the shortcut", async () => {
	shellOff();
	process.env.GENTLE_PI_JOBS_KEY = "alt+j";
	try {
		assert.ok((await wide()).shortcuts["alt+j"]);
		process.env.GENTLE_PI_JOBS_KEY = "off";
		const { shortcuts } = await wide();
		assert.equal(shortcuts["ctrl+shift+j"], undefined);
		assert.equal(shortcuts.off, undefined);
	} finally {
		delete process.env.GENTLE_PI_JOBS_KEY;
	}
});

test("clicking the Jobs title in the column collapses the card; the wheel still scrolls the column", async () => {
	shellOff();
	const { publish, layout, rows } = await wide();
	publish([build, tests]);
	const mouse = (type, y, extra = {}) => layout().rail.handleMouse({ type, button: "left", x: 10, y, width: 60, height: 30, screenX: 100, screenY: y, ...extra });
	assert.equal(mouse("click", 3)?.handled, undefined, "a job row is not the control");
	assert.equal(mouse("wheel", 1, { wheelDelta: 3 })?.handled, undefined, "the card leaves the wheel to the column");
	assert.equal(mouse("click", 1)?.handled, true);
	assert.match(rows()[1], /Jobs ▸ Expand/);
});

test("with Gentle Shell on there is no Jobs card here and no shortcut: Gentle Shell draws its own", async () => {
	shellOn();
	const { publish, rows, shortcuts } = await wide();
	publish([build]);
	assert.deepEqual(rows(), []);
	assert.equal(shortcuts["ctrl+shift+j"], undefined);
});
