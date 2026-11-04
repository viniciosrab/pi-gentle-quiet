import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { configFile, load, plain, theme, writeConfig } from "./helpers.mjs";

// gentle-pi 4.6.0 and later: lib/jobs-widget.ts draws only the rail's `▾ JOBS` section (renderJobsSection) and no
// longer exports renderJobsCard. The card is put together from the pieces it was made of: widgetJobs, the panel
// card (lib/shell-card.ts) and the job glyph and duration (lib/background-jobs-tools.ts).
const agentDir = path.dirname(configFile);
const lib = path.join(agentDir, "npm/node_modules/gentle-pi/lib");
const settingsFile = path.join(agentDir, "settings.json");
mkdirSync(lib, { recursive: true });
writeFileSync(path.join(lib, "jobs-sidebar-state.ts"), `
export const JOBS_SIDEBAR_EVENT = "gentle-ai:jobs-sidebar";
export const JOBS_STATUS_KEY = "gentle-jobs";
export function jobsCollapseKey(env = process.env, bindings = {}) {
	const value = env.GENTLE_PI_JOBS_KEY?.trim();
	if (value === undefined) return "ctrl+shift+j";
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}
export function isJobsSidebarSnapshot(value) {
	return Array.isArray(value?.jobs) && value.jobs.every((job) => typeof job?.id === "string" && typeof job.startedAt === "number");
}
`);
writeFileSync(path.join(lib, "jobs-widget.ts"), `
export const JOBS_GLYPH = "⧗";
export const JOBS_FINISHED_TTL_MS = 60000;
export function widgetJobs(jobs, now) {
	const running = jobs.filter((job) => job.status === undefined).sort((a, b) => b.startedAt - a.startedAt);
	const finished = jobs.filter((job) => job.status !== undefined && now - job.endedAt < JOBS_FINISHED_TTL_MS);
	return [...running, ...finished];
}
export function renderJobsSection(jobs, theme, width, now, options) {
	const shown = widgetJobs(jobs, now);
	return shown.length ? ["▾ JOBS  " + shown.length + " running", ...shown.map((job) => "  ⧗ " + job.id + " " + job.label)] : [];
}
`);
// Like gentle-pi's panel card: a margin, the glyph and title, the subtitle, then the body under the same margin.
writeFileSync(path.join(lib, "shell-card.ts"), `
export const CARD_TONE = { INFO: "info" };
export function panelInnerWidth(theme, width, tone) {
	return width - 5;
}
export function renderCard(card, theme, width, options) {
	const head = "   " + card.glyph + " " + card.title + "  " + card.subtitle + (options.hint ? "  " + options.hint : "");
	return [head, ...card.body.map((row) => "   " + row)];
}
`);
writeFileSync(path.join(lib, "background-jobs-tools.ts"), `
export const JOB_GLYPH = "⧗";
export function formatJobDuration(ms) {
	return Math.round(ms / 1000) + "s";
}
`);

const shellOff = () => writeFileSync(settingsFile, JSON.stringify({ packages: [{ source: "npm:gentle-pi", extensions: ["-extensions/gentle-shell.ts"] }] }));

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const EVENT = "gentle-ai:jobs-sidebar";

function host(columns = 180) {
	const native = { type: "vstack", entries: [] };
	const root = { render: () => [], [NODE]: () => native };
	const tui = { terminal: { columns, rows: 40 }, mode: "fullscreen", layoutRoot: root, requestRender() {} };
	return { tui, root, native };
}

const statuses = new Map([["gentle-jobs", "⧗ 2 jobs"]]);
const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => statuses, onBranchChange: () => () => {} };

async function wide() {
	writeConfig({});
	const loaded = await load({ mode: "tui", session: { id: "s1", cwd: "/srv/app", model: { id: "claude-opus-5-5" }, usage: { percent: 28 } } });
	const h = host();
	loaded.footer()?.(h.tui, theme, footerData);
	const layout = () => {
		const side = h.root[NODE]().entries?.[1]?.component?.[NODE]?.();
		return { status: side?.entries?.[1]?.component, rail: side?.entries?.[2]?.component };
	};
	const publish = (jobs) => loaded.events.emit(EVENT, { sessionId: "s1", snapshot: { jobs } });
	const rows = () => (layout().rail?.render(60).map(plain) ?? []).map((row) => row.replace(/ +│$/, ""));
	return { ...loaded, layout, publish, rows };
}

const now = Date.now();
const build = { id: "job-1", label: "npm run build", startedAt: now - 12_000 };
const tests = { id: "job-2", label: "npm test", startedAt: now - 3_000 };

test("with gentle-pi's rail section only, the Jobs card is still drawn as a card, newest first", async () => {
	shellOff();
	const { publish, rows, layout } = await wide();
	publish([build, tests]);
	const out = rows();
	assert.equal(out.findIndex((row) => row.startsWith("┌")), 0, "the Jobs card comes first under the Status card");
	assert.match(out[1], /^│ ⧗ Jobs ▾ Collapse {2}2 running/u);
	assert.equal(out[2], "│", "a blank row under the title");
	assert.match(out[3], /^│ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] npm test +3s ?↗$/u, "the label, not the job id; elapsed on the right, then the popup's ↗");
	assert.match(out[4], /^│ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] npm run build +12s ?↗$/u);
	assert.ok(out[5].startsWith("└"));
	assert.ok(!out.some((row) => row.includes("JOBS")), "not gentle-pi's rail section");
	assert.doesNotMatch(plain(layout().status.render(60).join("\n")), /2 jobs/, "the card replaces the status count");
});

test("with gentle-pi's rail section only, finished jobs keep their outcome mark", async () => {
	shellOff();
	const { publish, rows } = await wide();
	publish([
		{ ...build, status: "exited", exitCode: 0, endedAt: now - 2_000 },
		{ ...tests, status: "exited", exitCode: 1, endedAt: now - 1_000 },
		{ id: "job-3", label: "lint", startedAt: now - 5_000, status: "stopped", endedAt: now - 1_000 },
	]);
	const out = rows();
	assert.match(out[1], /Jobs ▾ Collapse {2}3 finished/u);
	assert.ok(out.some((row) => /^│ ✓ npm run build +10s/u.test(row)));
	assert.ok(out.some((row) => /^│ ✗ npm test +2s/u.test(row)));
	assert.ok(out.some((row) => /^│ – lint +4s/u.test(row)));
});

test("with gentle-pi's rail section only, ctrl+shift+j still collapses the card to its newest job", async () => {
	shellOff();
	const { publish, rows, shortcuts, ctx } = await wide();
	publish([build, tests]);
	await shortcuts["ctrl+shift+j"].handler(ctx);
	const collapsed = rows();
	assert.match(collapsed[1], /Jobs ▸ Expand/u);
	assert.ok(collapsed.some((row) => row.includes("npm test")));
	assert.ok(!collapsed.some((row) => row.includes("npm run build")));
	assert.ok(collapsed.some((row) => row.includes("… 1 more")));
	await shortcuts["ctrl+shift+j"].handler(ctx);
	assert.ok(rows().some((row) => row.includes("npm run build")));
});
