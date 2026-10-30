import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { painted, plain, theme } from "./helpers.mjs";
import { createTab } from "../extensions/sidebar/pr.ts";
import { firstLine, ghProblem, openUrl, parseChecks, parsePr, parseThreads, prDeps, prTiming } from "../extensions/sidebar/pr-data.ts";

const PR = {
	number: 17,
	title: "feat(sidebar): tabs in the side column (MAIN, GIT, PROF, MEM, TREE) and a TREE file preview",
	state: "OPEN",
	isDraft: false,
	mergeable: "MERGEABLE",
	mergeStateStatus: "UNSTABLE",
	url: "https://github.com/o/r/pull/17",
	headRefName: "feat/x",
	baseRefName: "main",
	reviewDecision: "CHANGES_REQUESTED",
	statusCheckRollup: [
		{ __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/1" },
		{ __typename: "CheckRun", name: "Greptile Review", status: "IN_PROGRESS", conclusion: "", detailsUrl: "https://greptile/17" },
		{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/lint" },
		{ __typename: "StatusContext", context: "deploy", state: "SUCCESS", targetUrl: "https://deploy/17" },
		{ __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: "https://ci/docs" },
	],
	comments: [],
	reviews: [],
	latestReviews: [],
};

const THREADS = {
	data: {
		repository: {
			pullRequest: {
				reviewThreads: {
					nodes: [
						{ isResolved: true, comments: { nodes: [{ author: { login: "bob" }, body: "done", url: "https://github.com/o/r/pull/17#r0", createdAt: "2026-10-30T09:00:00Z" }] } },
						{
							isResolved: false,
							comments: { nodes: [{ author: { login: "greptile-apps" }, body: '<a href="#"><img alt="P1" src="x.svg"></a> **Tab-heavy previews can freeze Pi**\n\nMore text', url: "https://github.com/o/r/pull/17#r1", createdAt: "2026-10-30T08:00:00Z" }] },
						},
						{ isResolved: false, comments: { nodes: [{ author: { login: "alice" }, body: "older one", url: "https://github.com/o/r/pull/17#r2", createdAt: "2026-10-29T08:00:00Z" }] } },
					],
				},
			},
		},
	},
};

const NO_PR = { code: 1, stderr: 'no pull requests found for branch "feat/x"\n' };

// What `gh` answers: `view` for `gh pr view`, `graphql` for `gh api graphql`; a { code, stderr } fails.
function stubGh(answers = {}) {
	const table = { view: PR, graphql: THREADS, ...answers };
	const calls = [];
	prDeps.execFile = (bin, args, options, done) => {
		calls.push({ bin, args, cwd: options?.cwd, timeout: options?.timeout });
		const key = args[0] === "api" ? "graphql" : "view";
		let answer = table[key];
		if (typeof answer === "function") answer = answer(args);
		setImmediate(() => {
			if (answer?.code !== undefined) {
				const error = Object.assign(new Error(answer.stderr ?? "failed"), { code: answer.code });
				done(error, "", answer.stderr ?? "");
			} else done(null, JSON.stringify(answer), "");
		});
	};
	return calls;
}

// Timers the tab sets, recorded so tests run them by hand.
function stubTimers() {
	const timers = [];
	let clock = 1_000_000;
	prDeps.setInterval = (fn, ms) => {
		const timer = { fn, ms, cleared: false };
		timers.push(timer);
		return timer;
	};
	prDeps.clearInterval = (timer) => {
		if (timer) timer.cleared = true;
	};
	prDeps.now = () => clock;
	return {
		timers,
		live: () => timers.filter((timer) => !timer.cleared),
		advance: (ms) => {
			clock += ms;
		},
	};
}

const opened = [];
prDeps.open = (url) => opened.push(url);

const pad = (row, width) => {
	const cut = visibleWidth(row) <= width ? row : truncateToWidth(row, width, "…");
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
};

// What `git` answers, by the arguments the tab passes to host.git.
function stubGit({ branch = "feat/x\n", counts = "1\t2\n" } = {}) {
	const state = { branch, counts };
	const git = (args) => {
		const line = args.join(" ");
		if (line === "branch --show-current") return typeof state.branch === "function" ? state.branch() : state.branch;
		if (line.startsWith("rev-list --left-right --count")) return state.counts ?? undefined; // null: no upstream
		return undefined;
	};
	return { state, git };
}

function makeHost({ git = stubGit().git, cwd = "/repo", outline = true } = {}) {
	let renders = 0;
	const box = (rows, width) =>
		outline
			? [theme.fg("border", `┌${"─".repeat(width - 2)}┐`), ...rows.map((row) => `${theme.fg("border", "│")} ${pad(row, width - 4)} ${theme.fg("border", "│")}`), theme.fg("border", `└${"─".repeat(width - 2)}┘`)]
			: rows.map((row) => ` ${truncateToWidth(row, width - 1, "…")}`);
	const host = {
		theme,
		fg: theme.fg,
		bold: theme.bold,
		card: (title, rows, width) => box([theme.fg("toolTitle", theme.bold(title)), ...(rows.length ? ["", ...rows] : [])], width),
		box,
		inner: (width) => (outline ? width - 4 : width - 1),
		cwd: () => cwd,
		ctx: () => undefined,
		pi: undefined,
		agentDir: "/agent",
		requestRender: () => renders++,
		git: (args) => Promise.resolve().then(() => git(args)),
		changes: () => undefined,
		usage: () => ({ name: "", windows: [] }),
		gauge: () => "",
		icons: { branch: "⎇" },
	};
	return { host, renders: () => renders };
}

const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function open({ gh = {}, git, outline, width = 59, height = 40 } = {}) {
	const calls = stubGh(gh);
	const clock = stubTimers();
	const made = makeHost({ git, outline });
	const tab = createTab(made.host);
	tab.onShow?.();
	const first = tab.render(width, height);
	await settle();
	const draw = () => tab.render(width, height);
	const rows = () => draw().map(plain);
	const lineOf = (text) => rows().findIndex((row) => row.includes(text));
	const row = (text) => draw().find((line) => plain(line).includes(text));
	return { ...made, tab, calls, clock, first, draw, rows, lineOf, row, width };
}

test("an open PR: number and title cut with …, an open badge, its mergeability and branch → base", async () => {
	const { rows, row, first, calls } = await open();
	assert.ok(first.map(plain).some((line) => line.includes("refreshing…")), "the first load says so");
	assert.ok(painted(first.find((line) => plain(line).includes("refreshing…")), "dim"));
	const out = rows();
	assert.ok(out.every((line) => [...line].length <= 59), "within the column");
	const header = out.find((line) => line.includes("#17"));
	assert.match(header, /│ #17 feat\(sidebar\): tabs in the side column .*… +│$/);
	assert.ok(painted(row("open"), "success", "● open"));
	assert.ok(painted(row("open"), "warning", "! unstable"));
	assert.ok(out.some((line) => line.includes("feat/x → main")));
	assert.ok(!out.some((line) => line.includes("refreshing…")));
	const view = calls.find((call) => call.args[0] === "pr");
	assert.equal(view.bin, "gh");
	assert.deepEqual(view.args.slice(0, 3), ["pr", "view", "--json"]);
	for (const field of ["number", "title", "state", "isDraft", "mergeable", "mergeStateStatus", "url", "headRefName", "baseRefName", "reviewDecision", "statusCheckRollup"]) {
		assert.ok(view.args[3].split(",").includes(field), field);
	}
	assert.equal(view.cwd, "/repo");
	assert.ok(view.timeout >= 5000 && view.timeout <= 15000, "a timeout around 10 s");
});

test("checks: one row each, the name at the start and the state flush right in its color, counted in the title", async () => {
	const { rows, row } = await open();
	const out = rows();
	const title = out.findIndex((line) => line.includes("Checks"));
	assert.match(out[title], /Checks 2\/4/);
	assert.equal(out[title - 1].replace(/[│ ]/g, ""), "", "a blank row before the section");
	assert.match(row("CI ") && plain(row("✓ passed")), /│ CI +✓ passed │$/);
	assert.ok(painted(row("✓ passed"), "success", "✓ passed"));
	assert.match(plain(row("lint")), /│ lint +✗ failed │$/);
	assert.ok(painted(row("lint"), "error", "✗ failed"));
	assert.match(plain(row("Greptile Review")), /│ Greptile Review +⧗ running │$/);
	assert.ok(painted(row("Greptile Review"), "warning", "⧗ running"));
	assert.match(plain(row("docs")), /│ docs +– skipped │$/);
	assert.ok(painted(row("docs"), "dim", "– skipped"));
	assert.ok(out.some((line) => /│ deploy +✓ passed │$/.test(line)), "a status context counts as a check");
	assert.ok(!out.some((line) => /^│ ─+/.test(line)), "no divider rules");
});

test("reviews: the decision, the unresolved review comments and the latest one's author and first line", async () => {
	const { rows, row, calls } = await open();
	const out = rows();
	assert.ok(out.some((line) => line.includes("Reviews")));
	assert.ok(painted(row("changes requested"), "error", "✗ changes requested"));
	assert.ok(out.some((line) => line.includes("2 unresolved comments")));
	assert.ok(out.some((line) => line.includes("greptile-apps: Tab-heavy previews can freeze Pi")), "the latest unresolved comment, markup stripped");
	assert.ok(!out.some((line) => line.includes("alice")), "only the latest");
	const graphql = calls.find((call) => call.args[0] === "api");
	assert.ok(graphql.args.includes("graphql"));
	assert.ok(graphql.args.some((arg) => arg === "owner=o") && graphql.args.some((arg) => arg === "name=r") && graphql.args.some((arg) => arg === "number=17"));
});

test("an approved PR with no unresolved comments, and a review left to do", async () => {
	const approved = await open({ gh: { view: { ...PR, reviewDecision: "APPROVED" }, graphql: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } } } });
	assert.ok(painted(approved.row("approved"), "success", "✓ approved"));
	assert.ok(approved.rows().some((line) => line.includes("no unresolved comments")));
	const required = await open({ gh: { view: { ...PR, reviewDecision: "REVIEW_REQUIRED" } } });
	assert.ok(painted(required.row("review required"), "warning", "⧗ review required"));
});

test("without the review threads (graphql failing) the PR's comment count shows instead, and nothing throws", async () => {
	const comments = [{ author: { login: "carol" }, body: "Looks fine\nsecond", createdAt: "2026-10-30T10:00:00Z", url: "https://github.com/o/r/pull/17#c1" }];
	const { rows } = await open({ gh: { view: { ...PR, comments }, graphql: { code: 1, stderr: "HTTP 502" } } });
	const out = rows();
	assert.ok(out.some((line) => line.includes("1 comment")));
	assert.ok(out.some((line) => line.includes("carol: Looks fine")));
	assert.ok(out.some((line) => line.includes("#17")));
});

test("draft, merged and closed badges; mergeability only while the PR is open", async () => {
	const draft = await open({ gh: { view: { ...PR, isDraft: true, mergeStateStatus: "DRAFT" } } });
	assert.ok(painted(draft.row("draft"), "dim", "◌ draft"));
	const merged = await open({ gh: { view: { ...PR, state: "MERGED", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } } });
	assert.ok(painted(merged.row("merged"), "accent", "● merged"));
	assert.ok(!merged.rows().some((line) => /unstable|clean|conflicts|blocked/.test(line)));
	const closed = await open({ gh: { view: { ...PR, state: "CLOSED" } } });
	assert.ok(painted(closed.row("closed"), "error", "● closed"));
	const conflicts = await open({ gh: { view: { ...PR, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } } });
	assert.ok(painted(conflicts.row("conflicts"), "error", "✗ conflicts"));
	const clean = await open({ gh: { view: { ...PR, mergeStateStatus: "CLEAN" } } });
	assert.ok(painted(clean.row("clean"), "success", "✓ clean"));
	const blocked = await open({ gh: { view: { ...PR, mergeStateStatus: "BLOCKED" } } });
	assert.ok(painted(blocked.row("blocked"), "warning", "⊘ blocked"));
});

test("no PR for the branch: commits ahead and behind its upstream and a note", async () => {
	const { rows, row } = await open({ gh: { view: NO_PR } });
	const out = rows();
	assert.ok(out.some((line) => line.includes("No pull request for feat/x")));
	assert.ok(out.some((line) => line.includes("feat/x")) && painted(row("↑2"), "warning", "↑2") && painted(row("↓1"), "error", "↓1"), "ahead 2, behind 1");
	assert.ok(!out.some((line) => line.includes("Checks")));
});

test("no PR and no upstream: not pushed", async () => {
	const { rows } = await open({ gh: { view: NO_PR }, git: stubGit({ counts: null }).git });
	assert.ok(rows().some((line) => line.includes("not pushed")));
	assert.ok(rows().some((line) => line.includes("No pull request for feat/x")));
});

test("without gh, signed out, or outside GitHub: one dim row saying so, and no throw", async () => {
	for (const [answer, text] of [
		[{ code: "ENOENT", stderr: "" }, "gh is not installed"],
		[{ code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login\n" }, "gh is not signed in"],
		[{ code: 1, stderr: "none of the git remotes configured for this repository point to a known GitHub host.\n" }, "Not a GitHub repository"],
		[{ code: 1, stderr: "failed to run git: fatal: not a git repository (or any of the parent directories): .git\n" }, "Not a git repository"],
		[{ code: 1, stderr: "something odd\nmore" }, "gh: something odd"],
	]) {
		const { draw } = await open({ gh: { view: answer } });
		const out = draw();
		const line = out.find((row) => plain(row).includes(text));
		assert.ok(line, text);
		assert.ok(painted(line, "dim"), `${text}: dim`);
		assert.equal(out.filter((row) => /\w/.test(plain(row).replace(/[│┌┐└┘─]/g, ""))).length, 2, `${text}: the title and one row`);
	}
	const bad = await open({ gh: { view: () => "not json" } });
	assert.doesNotThrow(() => bad.draw());
});

test("a click on the PR header opens the PR, on a check its details link; other clicks are left alone", async () => {
	const { tab, lineOf, rows } = await open();
	opened.length = 0;
	assert.equal(tab.handleClick(lineOf("#17"), "left", 5), true);
	assert.equal(tab.handleClick(lineOf("feat/x → main"), "left", 5), true);
	assert.equal(tab.handleClick(lineOf("lint"), "left", 5), true);
	assert.equal(tab.handleClick(lineOf("deploy"), "left", 5), true);
	assert.deepEqual(opened, ["https://github.com/o/r/pull/17", "https://github.com/o/r/pull/17", "https://ci/lint", "https://deploy/17"]);
	assert.equal(tab.handleClick(lineOf("Checks"), "left", 5), false);
	assert.equal(tab.handleClick(lineOf("lint"), "right", 5), false);
	assert.equal(tab.handleClick(rows().length + 5, "left", 5), false);
	assert.equal(tab.handleWheel?.(1, 0, 0) ?? false, false, "the column scrolls the overflow");
});

test("without the outline the hits move with the rows", async () => {
	const { tab, lineOf } = await open({ outline: false });
	opened.length = 0;
	tab.handleClick(lineOf("Greptile Review"), "left", 3);
	assert.deepEqual(opened, ["https://greptile/17"]);
});

test("openUrl runs xdg-open detached", () => {
	const saved = prDeps.spawn;
	const runs = [];
	prDeps.spawn = (bin, args, options) => {
		runs.push({ bin, args, detached: options.detached, stdio: options.stdio });
		return { on() {}, unref() {} };
	};
	try {
		assert.equal(openUrl("https://github.com/o/r/pull/17"), true);
		assert.deepEqual(runs, [{ bin: "xdg-open", args: ["https://github.com/o/r/pull/17"], detached: true, stdio: "ignore" }]);
		prDeps.spawn = () => {
			throw new Error("no xdg-open");
		};
		assert.equal(openUrl("https://x"), false);
		assert.equal(openUrl("javascript:alert(1)"), false, "only web links");
	} finally {
		prDeps.spawn = saved;
	}
});

test("refreshes every 30 s while shown and on a branch change, without the refreshing note; stops when hidden or disposed", async () => {
	const git = stubGit();
	const { tab, calls, clock, draw } = await open({ git: git.git });
	const views = () => calls.filter((call) => call.args[0] === "pr").length;
	assert.equal(views(), 1);
	assert.equal(clock.live().length, 1, "one timer while shown");
	const timer = clock.live()[0];
	timer.fn();
	await settle();
	assert.equal(views(), 1, "a probe within 30 s reads no PR");
	clock.advance(prTiming.refreshMs);
	draw();
	timer.fn();
	assert.ok(!draw().map(plain).some((row) => row.includes("refreshing…")), "the cached PR stays while it refreshes");
	await settle();
	assert.equal(views(), 2, "30 s later it reads again");
	git.state.branch = "feat/y\n";
	draw();
	timer.fn();
	await settle();
	await settle();
	assert.equal(views(), 3, "a new branch reads again");
	tab.onHide?.();
	assert.equal(clock.live().length, 0, "hidden: no polling");
	draw();
	assert.equal(clock.live().length, 1, "drawn again: polling again");
	tab.dispose();
	assert.equal(clock.live().length, 0, "disposed: no timers");
	draw();
	assert.equal(clock.live().length, 0, "nothing restarts after dispose");
});

test("the timer stops on its own when the tab is no longer drawn", async () => {
	const { clock } = await open();
	const timer = clock.live()[0];
	clock.advance(prTiming.refreshMs + prTiming.probeMs + 1);
	timer.fn();
	assert.equal(clock.live().length, 0);
});

test("parsers: checks, PR, threads, first lines and gh errors", () => {
	assert.deepEqual(
		parseChecks(PR.statusCheckRollup).map((check) => [check.name, check.state, check.url]),
		[
			["CI", "passed", "https://ci/1"],
			["Greptile Review", "running", "https://greptile/17"],
			["lint", "failed", "https://ci/lint"],
			["deploy", "passed", "https://deploy/17"],
			["docs", "skipped", "https://ci/docs"],
		],
	);
	assert.equal(parseChecks([{ __typename: "StatusContext", context: "x", state: "PENDING" }])[0].state, "running");
	assert.equal(parseChecks([{ __typename: "CheckRun", name: "y", status: "COMPLETED", conclusion: "TIMED_OUT" }])[0].state, "failed");
	assert.equal(parseChecks([{ __typename: "CheckRun", name: "z", status: "COMPLETED", conclusion: "NEUTRAL" }])[0].state, "skipped");
	const pr = parsePr(PR);
	assert.equal(pr.state, "open");
	assert.equal(pr.merge, "unstable");
	assert.equal(pr.review, "changes requested");
	assert.equal(parsePr({ ...PR, isDraft: true }).state, "draft");
	assert.equal(parsePr({ ...PR, state: "MERGED" }).merge, undefined);
	const threads = parseThreads(THREADS);
	assert.equal(threads.unresolved, 2);
	assert.equal(threads.latest.author, "greptile-apps");
	assert.equal(parseThreads({}), undefined);
	assert.equal(firstLine("<!-- x -->\n\n## **Hello** `world` &amp; you\nnext"), "Hello world & you");
	assert.equal(ghProblem({ code: "ENOENT" }, ""), "gh is not installed");
	assert.equal(ghProblem({ code: 1 }, 'no pull requests found for branch "x"'), "none");
	assert.equal(ghProblem({ code: 1 }, "HTTP 401: Bad credentials"), "gh is not signed in");
});
