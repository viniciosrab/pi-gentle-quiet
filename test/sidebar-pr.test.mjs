import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { painted, plain, theme } from "./helpers.mjs";
import { createTab } from "../extensions/sidebar/pr.ts";
import {
	checksSummary,
	ciPrompt,
	currentPr,
	firstLine,
	ghProblem,
	openUrl,
	parseChecks,
	parsePulls,
	prDeps,
	prTiming,
	stackOf,
	threadsPrompt,
	verdictOf,
} from "../extensions/sidebar/pr-data.ts";

const url = (n) => `https://github.com/o/r/pull/${n}`;
const run = (name, status, conclusion = "") => ({ __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://ci/${name}` });
const context = (name, state) => ({ __typename: "StatusContext", context: name, state, targetUrl: `https://ctx/${name}` });
const badge = (sev) => (sev ? `<a href="#"><img alt="${sev}" src="https://x/badges/${sev.toLowerCase()}.svg" align="top"></a> ` : "");
const thread = (title, { resolved = false, path = "extensions/sidebar/pr.ts", line = 12, author = "greptile-apps", sev, id = title.length } = {}) => ({
	isResolved: resolved,
	path,
	line,
	originalLine: line ?? 7,
	comments: { nodes: [{ author: { login: author }, body: `${badge(sev)}**${title}**\n\n<!-- hidden -->Why ${title.toLowerCase()} &amp; more.\n\n\n\nLast line.`, url: `${url(0)}#discussion_r${id}` }] },
});

// One PR as GitHub's GraphQL answers it.
function node({ number, title, base = "main", head, owner = "o", draft = false, mergeable = "MERGEABLE", merge = "CLEAN", review = "", checks = [], threads = [], threadsTotal }) {
	return {
		number,
		title,
		url: url(number),
		isDraft: draft,
		baseRefName: base,
		headRefName: head,
		headRepositoryOwner: owner === null ? null : { login: owner },
		mergeable,
		mergeStateStatus: merge,
		reviewDecision: review,
		commits: { nodes: [{ commit: { statusCheckRollup: checks.length ? { contexts: { totalCount: checks.length, nodes: checks } } : null } }] },
		reviewThreads: { totalCount: threadsTotal ?? threads.length, nodes: threads },
	};
}

// This repository's real stack: #18 on main, #19 and #20 on #18, the session on #20's branch.
const P18 = node({
	number: 18,
	title: "feat(sidebar): PR tab, tab order and drag, file preview, MEM rework, Nerd Font icons",
	head: "feat/sidebar-pr-tab",
	threads: [
		thread("File names break TREE", { sev: "P1", path: "extensions/sidebar/nerd-icons.ts", line: null }),
		thread("Another fork's PR appears", { sev: "P1", path: "extensions/sidebar/pr-data.ts", line: 200 }),
		thread("Current PR can disappear", { sev: "P2", path: "extensions/sidebar/pr-data.ts", line: 188 }),
		thread("Older comments go missing", { path: "extensions/sidebar/pr-data.ts", line: 29, author: "alice" }),
		thread("Already handled", { resolved: true }),
	],
});
const P19 = node({ number: 19, title: "feat(sidebar): GIT file rows with the TREE's icon and the status letter last", base: "feat/sidebar-pr-tab", head: "feat/git-icons", checks: [run("CI", "COMPLETED", "SUCCESS")] });
const P20 = node({
	number: 20,
	title: "feat(sidebar): PROF keyboard mode with gentle-pi's profile screen keys",
	base: "feat/sidebar-pr-tab",
	head: "feat/prof-keyboard",
	review: "REVIEW_REQUIRED",
	checks: [run("CI", "COMPLETED", "SUCCESS"), run("lint", "COMPLETED", "FAILURE"), context("deploy", "PENDING"), run("docs", "COMPLETED", "SKIPPED")],
	threads: [thread("Dialogs lose their keys", { sev: "P1", path: "extensions/sidebar/prof.ts", line: 212 }), thread("Esc twice", { path: "extensions/sidebar/prof.ts", line: 40, author: "bob" })],
});
const P15 = node({ number: 15, title: "chore: bump pi-tui", head: "chore/tui", checks: [run("CI", "COMPLETED", "FAILURE"), run("lint", "IN_PROGRESS")] });

const answer = (nodes, mine = []) => ({ data: { repository: { owner: { login: "o" }, pullRequests: { nodes }, mine: { nodes: mine } } } });
const STACK = answer([P20, P19, P18, P15]);

// What `gh api graphql` answers: an object, a function of the arguments, or { code, stderr } to fail.
function stubGh(reply = STACK) {
	const calls = [];
	prDeps.execFile = (bin, args, options, done) => {
		calls.push({ bin, args, cwd: options?.cwd, timeout: options?.timeout });
		const value = typeof reply === "function" ? reply(args) : reply;
		setImmediate(() => {
			if (value?.code !== undefined) done(Object.assign(new Error(value.stderr ?? "failed"), { code: value.code }), "", value.stderr ?? "");
			else done(null, typeof value === "string" ? value : JSON.stringify(value), "");
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
	return { live: () => timers.filter((timer) => !timer.cleared), advance: (ms) => (clock += ms) };
}

const opened = [];
prDeps.open = (link) => opened.push(link);

const pad = (row, width) => {
	const cut = visibleWidth(row) <= width ? row : truncateToWidth(row, width, "…");
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
};

// What `git` answers, by the arguments the tab passes to host.git; `remotes` maps a remote to its URL.
function stubGit({ branch = "feat/prof-keyboard\n", upstream, remotes = {} } = {}) {
	const state = { branch, upstream, remotes };
	const calls = [];
	const git = (args) => {
		const line = args.join(" ");
		calls.push(line);
		if (line === "branch --show-current") return state.branch;
		if (line === "rev-parse --abbrev-ref --symbolic-full-name @{u}") return state.upstream;
		if (args[0] === "remote" && args[1] === "get-url") return state.remotes[args[2]];
		return undefined;
	};
	return { state, git, calls };
}

// Pi's editor as ctx.ui shows it to an extension.
function stubEditor(text = "") {
	const editor = { text, sets: [] };
	editor.ui = {
		getEditorText: () => editor.text,
		setEditorText: (value) => {
			editor.sets.push(value);
			editor.text = value;
		},
	};
	return editor;
}

function makeHost({ git = stubGit().git, cwd = "/repo", outline = true, editor = stubEditor() } = {}) {
	let renders = 0;
	const sent = [];
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
		ctx: () => (editor ? { ui: editor.ui } : undefined),
		pi: { sendUserMessage: (text) => sent.push(text) },
		agentDir: "/agent",
		requestRender: () => renders++,
		git: (args) => Promise.resolve().then(() => git(args)),
		changes: () => undefined,
		usage: () => ({ name: "", windows: [] }),
		gauge: () => "",
		icons: { branch: "⎇" },
	};
	return { host, sent, renders: () => renders };
}

const settle = async () => {
	for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function open({ gh = STACK, git, outline, editor, width = 59, height = 60 } = {}) {
	const calls = stubGh(gh);
	const clock = stubTimers();
	const made = makeHost({ git, outline, editor });
	const tab = createTab(made.host);
	tab.onShow?.();
	const first = tab.render(width, height);
	await settle();
	const draw = () => tab.render(width, height);
	const rows = () => draw().map(plain);
	const lineOf = (text) => rows().findIndex((row) => row.includes(text));
	const row = (text) => draw().find((line) => plain(line).includes(text));
	// A left click at the middle of `label` on the row that holds it.
	const press = (label, button = "left") => {
		const line = lineOf(label);
		const x = rows()[line].indexOf(label) + Math.floor(label.length / 2);
		return tab.handleClick(line, button, x);
	};
	const numbers = () => rows().filter((line) => /[▸▾] #\d+/.test(line)).map((line) => Number(/#(\d+)/.exec(line)[1]));
	return { ...made, tab, calls, clock, first, draw, rows, lineOf, row, press, numbers, width };
}

test("one gh api graphql call reads every open PR, with the branch for the current one", async () => {
	const { calls, first } = await open();
	assert.ok(first.map(plain).some((line) => line.includes("refreshing…")), "the first load says so");
	assert.equal(calls.length, 1, "one gh call");
	const [call] = calls;
	assert.equal(call.bin, "gh");
	assert.deepEqual(call.args.slice(0, 2), ["api", "graphql"]);
	const field = (flag, name) => call.args.find((arg, i) => call.args[i - 1] === flag && arg.startsWith(`${name}=`));
	assert.equal(field("-F", "owner"), "owner={owner}");
	assert.equal(field("-F", "name"), "name={repo}");
	assert.equal(field("-f", "branch"), "branch=feat/prof-keyboard");
	const query = field("-f", "query");
	for (const part of ["pullRequests(states:OPEN", "mine:pullRequests(states:OPEN,headRefName:$branch", "headRepositoryOwner", "baseRefName", "mergeStateStatus", "reviewDecision", "statusCheckRollup", "reviewThreads", "totalCount"]) {
		assert.ok(query.includes(part), part);
	}
	assert.equal(call.cwd, "/repo");
	assert.ok(call.timeout >= 5000 && call.timeout <= 15000, "a timeout around 10 s");
});

test("the stack: a PR on another open PR's head sits under it; no branch names anywhere", async () => {
	const { rows, numbers, draw } = await open();
	assert.deepEqual(numbers(), [18, 20, 19, 15], "the base first, its PRs under it, then the others in GitHub's order");
	const out = rows();
	assert.match(out.find((line) => line.includes("#18")), /^│ [▸▾] #18 /);
	assert.match(out.find((line) => line.includes("#20 ")), /^│ ├ ▾ #20 /);
	assert.match(out.find((line) => line.includes("#19")), /^│ └ ▸ #19 /);
	assert.match(out.find((line) => line.includes("#15")), /^│ ▸ #15 /);
	assert.ok(!out.some((line) => /feat\/|chore\/|\bmain\b|⎇/.test(line)), "no branch names");
	assert.ok(out[1].includes("⇄ Pull requests · 4"), "the title counts the open PRs");
	assert.ok(draw().every((line) => visibleWidth(line) <= 59), "within the column");
});

test("each row: number in accent, the title cut with …, and flush right its verdict", async () => {
	const { row, rows } = await open();
	assert.ok(painted(row("#18"), "accent", "#18"));
	assert.match(plain(row("#18")), /│ ▸ #18 feat\(sidebar\): PR tab, .*… ⚠ 4 threads │$/);
	assert.ok(painted(row("#18"), "warning", "⚠ 4 threads"), "unresolved threads, the resolved one not counted");
	assert.match(plain(row("#19")), /│ └ ▸ #19 .*… ✓ CI 1\/1 ✓ ready │$/);
	assert.ok(painted(row("#19"), "success", "✓ ready"));
	assert.match(plain(row("#15")), /│ ▸ #15 chore: bump pi-tui +✗ CI 0\/2 │$/);
	assert.ok(painted(row("#15"), "error", "✗ CI 0/2"), "a failed check wins over a running one");
	assert.match(plain(row("#20 ")), /│ ├ ▾ #20 .*… ◉ ✗ CI 1\/3 │$/, "the current branch's PR is marked ◉");
	assert.ok(painted(row("#20 "), "accent", "◉"));
	assert.ok(rows().every((line) => [...line].length <= 59));
});

test("verdicts: the most serious one wins, in order", () => {
	const pr = (fields) => parsePulls(answer([node({ number: 1, title: "t", head: "h", ...fields })])).prs[0];
	const failed = [run("CI", "COMPLETED", "FAILURE")];
	const running = [run("CI", "IN_PROGRESS")];
	const open1 = [thread("x")];
	const cases = [
		[{ mergeable: "CONFLICTING", merge: "DIRTY", checks: failed, review: "CHANGES_REQUESTED", threads: open1 }, "conflicts"],
		[{ checks: failed, review: "CHANGES_REQUESTED", threads: open1, draft: true }, "ci-failed"],
		[{ review: "CHANGES_REQUESTED", threads: open1, checks: running }, "changes"],
		[{ threads: open1, checks: running, draft: true }, "threads"],
		[{ checks: running, draft: true, review: "REVIEW_REQUIRED" }, "ci-running"],
		[{ draft: true, merge: "DRAFT", review: "REVIEW_REQUIRED" }, "draft"],
		[{ review: "REVIEW_REQUIRED", merge: "BLOCKED" }, "review"],
		[{ merge: "BLOCKED" }, "blocked"],
		[{ merge: "BEHIND" }, "behind"],
		[{ checks: [run("CI", "COMPLETED", "SUCCESS"), run("docs", "COMPLETED", "SKIPPED")], review: "APPROVED" }, "ready"],
		[{}, "ready"],
	];
	for (const [fields, kind] of cases) assert.equal(verdictOf(pr(fields)).kind, kind, `${JSON.stringify(fields)} → ${kind}`);
	assert.equal(verdictOf(pr({ threads: [thread("a"), thread("b"), thread("c", { resolved: true })] })).count, 2);
});

test("every verdict as the row draws it", async () => {
	const failed = [run("CI", "COMPLETED", "FAILURE")];
	const nodes = [
		node({ number: 9, title: "a", head: "a", mergeable: "CONFLICTING", merge: "DIRTY" }),
		node({ number: 8, title: "b", head: "b", checks: failed }),
		node({ number: 7, title: "c", head: "c", review: "CHANGES_REQUESTED" }),
		node({ number: 6, title: "d", head: "d", threads: [thread("one")] }),
		node({ number: 5, title: "e", head: "e", checks: [run("CI", "QUEUED")] }),
		node({ number: 4, title: "f", head: "f", draft: true, merge: "DRAFT" }),
		node({ number: 3, title: "g", head: "g", review: "REVIEW_REQUIRED", merge: "BLOCKED" }),
		node({ number: 2, title: "h", head: "h", merge: "BLOCKED" }),
		node({ number: 1, title: "i", head: "i", merge: "BEHIND" }),
	];
	const { row } = await open({ gh: answer(nodes), git: stubGit({ branch: "other\n" }).git });
	for (const [n, role, text] of [
		[9, "error", "✗ conflicts"],
		[8, "error", "✗ CI 0/1"],
		[7, "error", "✗ changes"],
		[6, "warning", "⚠ 1 thread"],
		[5, "warning", "⧗ CI 0/1"],
		[4, "dim", "◌ draft"],
		[3, "warning", "⧗ review"],
		[2, "warning", "⊘ blocked"],
		[1, "warning", "↓ behind"],
	]) {
		assert.ok(plain(row(`#${n} `)).trimEnd().endsWith(`${text} │`), `#${n}: ${text}`);
		assert.ok(painted(row(`#${n} `), role, text), `#${n}: ${role}`);
	}
});

test("the CI chip: passed / checks that count, before the verdict, standing for a CI verdict", async () => {
	const many = (n, status, conclusion = "") => Array.from({ length: n }, () => run(`c${status}${conclusion}`, status, conclusion));
	const passed = (n) => many(n, "COMPLETED", "SUCCESS");
	const nodes = [
		node({ number: 9, title: "all", head: "all", checks: passed(10) }),
		node({ number: 8, title: "half", head: "half", checks: [...passed(5), ...many(5, "IN_PROGRESS")] }),
		node({ number: 7, title: "one", head: "one", checks: [...passed(9), ...many(1, "COMPLETED", "FAILURE")] }),
		node({ number: 6, title: "talk", head: "talk", checks: [...passed(5), ...many(5, "QUEUED")], threads: [thread("a"), thread("b")] }),
		node({ number: 5, title: "skip", head: "skip", checks: [...passed(1), run("docs", "COMPLETED", "SKIPPED")] }),
		node({ number: 4, title: "skipped", head: "skipped", checks: [run("docs", "COMPLETED", "SKIPPED")] }),
		node({ number: 3, title: "none", head: "none" }),
		node({ number: 2, title: "clash", head: "clash", mergeable: "CONFLICTING", merge: "DIRTY", checks: [...passed(1), ...many(1, "COMPLETED", "FAILURE")] }),
		node({ number: 1, title: "mine", head: "mine", checks: [...passed(1), ...many(1, "IN_PROGRESS")], threads: [thread("x")] }),
	];
	const { row, draw } = await open({ gh: answer(nodes), git: stubGit({ branch: "mine\n" }).git });
	const right = (n) => plain(row(`#${n} `)).replace(/^│ [▸▾] #\d+ \w+ +/, "").replace(/ │$/, "");
	assert.equal(right(9), "✓ CI 10/10 ✓ ready");
	assert.ok(painted(row("#9 "), "success", "✓ CI 10/10"));
	assert.equal(right(8), "⧗ CI 5/10", "the chip stands for a running CI");
	assert.ok(painted(row("#8 "), "warning", "⧗ CI 5/10"));
	assert.equal(right(7), "✗ CI 9/10", "the chip stands for a failed CI");
	assert.ok(painted(row("#7 "), "error", "✗ CI 9/10"));
	assert.equal(right(6), "⧗ CI 5/10 ⚠ 2 threads", "a running CI no longer hides behind threads");
	assert.ok(painted(row("#6 "), "warning", "⧗ CI 5/10") && painted(row("#6 "), "warning", "⚠ 2 threads"));
	assert.equal(right(5), "✓ CI 1/1 ✓ ready", "skipped checks do not count");
	assert.equal(right(4), "✓ ready", "only skipped checks: no chip");
	assert.equal(right(3), "✓ ready", "no checks: no chip");
	assert.equal(right(2), "✗ CI 1/2 ✗ conflicts");
	assert.ok(painted(row("#2 "), "error", "✗ CI 1/2") && painted(row("#2 "), "error", "✗ conflicts"));
	assert.equal(right(1), "◉ ⧗ CI 1/2 ⚠ 1 thread");
	for (const line of draw().map(plain)) assert.ok(!/CI.*CI/.test(line), `CI drawn once: ${line}`);
	assert.ok(draw().every((line) => visibleWidth(line) <= 59), "within the column");
});

test("the current branch's PR starts expanded with its detail; the others are collapsed", async () => {
	const { rows, row, lineOf } = await open();
	const out = rows();
	const at = lineOf("#20 ");
	const detail = out.slice(at + 1, lineOf("#19"));
	assert.match(detail[0], /^│ │   ✓ clean · ⧗ review required +│$/, "mergeability and review, indented under the row");
	assert.ok(painted(row("✓ clean"), "success", "✓ clean"));
	assert.ok(painted(row("✓ clean"), "warning", "⧗ review required"));
	assert.ok(detail.some((line) => /│ │   CI +✓ passed │$/.test(line)));
	assert.ok(detail.some((line) => /│ │   lint +✗ failed │$/.test(line)));
	assert.ok(painted(row("lint"), "error", "✗ failed"));
	assert.ok(detail.some((line) => /│ │   deploy +⧗ running │$/.test(line)), "a status context is a check");
	assert.ok(detail.some((line) => /│ │   docs +– skipped │$/.test(line)));
	assert.ok(detail.some((line) => /│ │   ● P1 Dialogs lose their keys +prof\.ts:212 │$/.test(line)), "a thread: severity, title, file:line");
	assert.ok(painted(row("Dialogs"), "error", "P1"));
	assert.ok(detail.some((line) => /│ │   ● Esc twice +prof\.ts:40 │$/.test(line)), "no severity, none drawn");
	assert.ok(detail.some((line) => /│ │   \[ Fix 2 threads with agent \]  \[ Fix CI \] +│$/.test(line)), "gentle-pi's buttons, two apart");
	assert.ok(detail.some((line) => /│ │   \[ Open \] +│$/.test(line)), "[ Open ] on a row of its own, under the agent's buttons");
	assert.ok(!out.some((line) => /Fix|P2|Older comments/.test(line) && out.indexOf(line) > lineOf("#19")), "#18 and #19 show no detail");
	assert.ok(!out.some((line) => line.includes("Current PR can disappear")), "#18 collapsed");
});

test("no checks and no review decision are said once, dim", async () => {
	const { row, rows } = await open({ git: stubGit({ branch: "feat/sidebar-pr-tab\n" }).git });
	const facts = row("no review yet");
	assert.match(plain(facts), /^│ │ ✓ clean · no review yet · no checks +│$/, "#18 has PRs under it: its detail carries the line");
	assert.ok(painted(facts, "dim", "no review yet") && painted(facts, "dim", "no checks"));
	assert.ok(rows().some((line) => /│ │ ● P1 File names break TREE +nerd-icons\.ts │$/.test(line)), "an outdated thread without a line: the file alone");
});

test("a click on a row opens or closes only that PR; several stay open; the choice survives a refresh", async () => {
	const { tab, rows, press, lineOf, clock, draw } = await open();
	opened.length = 0;
	const isOpen = (n) => /▾ #/.test(rows()[lineOf(`#${n} `)]);
	assert.equal(press("#18"), true);
	assert.ok(rows().some((line) => line.includes("Current PR can disappear")), "#18 open");
	assert.ok(rows().some((line) => line.includes("Dialogs lose their keys")), "#20 stays open");
	assert.deepEqual([isOpen(18), isOpen(20), isOpen(19)], [true, true, false]);
	assert.deepEqual(opened, [], "expanding opens nothing");
	assert.equal(press("#19"), true);
	assert.deepEqual([isOpen(18), isOpen(20), isOpen(19), isOpen(15)], [true, true, true, false], "three open");
	assert.equal(press("#20 "), true);
	assert.deepEqual([isOpen(18), isOpen(20), isOpen(19)], [true, false, true], "only #20 closed");
	assert.ok(!rows().some((line) => line.includes("Dialogs lose their keys")));
	assert.ok(rows().some((line) => line.includes("[ Open ]")) && !rows().some((line) => line.includes("Fix")), "no agent button on another branch's PR");
	clock.advance(prTiming.refreshMs);
	draw();
	clock.live()[0].fn();
	await settle();
	assert.deepEqual([isOpen(18), isOpen(20), isOpen(19)], [true, false, true], "the same after a refresh");
	assert.equal(press("#18"), true);
	assert.equal(press("#19"), true);
	assert.ok(!rows().some((line) => /Current PR can disappear|Dialogs lose/.test(line)), "all closed");
	assert.ok(!rows().some((line) => line.includes("[ Open ]")));
	clock.advance(prTiming.refreshMs);
	draw();
	clock.live()[0].fn();
	await settle();
	assert.ok(!rows().some((line) => line.includes("[ Open ]")), "still all closed after a refresh: the current PR does not reopen");
	assert.equal(tab.handleClick(lineOf("#19"), "right", 5), false, "a right click does nothing");
	assert.ok(!rows().some((line) => line.includes("[ Open ]")));
});

test("an open PR with PRs under it carries the stack's line through its detail", async () => {
	const { press, rows, lineOf, row, draw } = await open();
	press("#18");
	const out = rows();
	const detail18 = out.slice(lineOf("#18") + 1, lineOf("#20 "));
	assert.ok(detail18.length >= 2, "#18's facts and buttons");
	for (const line of detail18) assert.match(line, /^│ │ \S/, `a guide in #18's marker column, the text where it was: ${line}`);
	assert.match(detail18[0], /^│ │ ✓ clean · no review yet · no checks +│$/);
	assert.ok(detail18.some((line) => /^│ │ ● P1 File names break TREE +nerd-icons\.ts │$/.test(line)));
	assert.ok(detail18.some((line) => /^│ │ \[ Open \] +│$/.test(line)));
	assert.ok(painted(row("no review yet"), "dim", "│"), "the guide is dim like the stack's prefix");
	assert.match(out[lineOf("#20 ")], /^│ ├ ▾ #20 /, "the line goes on into #20's ├");
	const detail20 = out.slice(lineOf("#20 ") + 1, lineOf("#19"));
	for (const line of detail20) assert.match(line, /^│ │   \S/, `#20 has no PR under it: the parent's line only: ${line}`);
	assert.match(out[lineOf("#19")], /^│ └ ▸ #19 /);
	press("#19");
	const after = rows();
	const detail19 = after.slice(lineOf("#19") + 1, lineOf("#15"));
	assert.ok(detail19.length >= 2);
	for (const line of detail19) assert.match(line, /^│     \S/, `#19, the last child without children, has no guide: ${line}`);
	assert.ok(draw().every((line) => visibleWidth(line) <= 59), "within the column");

	const deep = answer([node({ number: 3, title: "c", base: "b", head: "c" }), node({ number: 2, title: "b", base: "a", head: "b" }), node({ number: 4, title: "d", base: "a", head: "d" }), node({ number: 1, title: "a", head: "a" })]);
	const nested = await open({ gh: deep, git: stubGit({ branch: "b\n" }).git });
	nested.press("#1 ");
	const lines = nested.rows();
	const at = (n) => nested.lineOf(`#${n} `);
	assert.deepEqual(nested.numbers(), [1, 2, 3, 4]);
	for (const line of lines.slice(at(1) + 1, at(2))) assert.match(line, /^│ │ \S/, `#1's guide: ${line}`);
	assert.match(lines[at(2)], /^│ ├ ▾ #2 /);
	const detail2 = lines.slice(at(2) + 1, at(3));
	assert.ok(detail2.length >= 2);
	for (const line of detail2) assert.match(line, /^│ │ │ \S/, `#2's guide in its own marker's column, under #1's: ${line}`);
	assert.match(lines[at(3)], /^│ │ └ ▸ #3 /, "the guide runs into #3's └");
	assert.match(lines[at(4)], /^│ └ ▸ #4 /);
	nested.press("#3 ");
	nested.press("#4 ");
	const deeper = nested.rows();
	for (const line of deeper.slice(at(3) + 1, at(4))) assert.match(line, /^│ │     \S/, `#3 has no PR under it: ${line}`);
	for (const line of deeper.slice(at(4) + 1, deeper.findIndex((l, i) => i > at(4) && /^└/.test(l)))) assert.match(line, /^│     \S/, `#4: ${line}`);
});

test("a branch change goes back to the new branch's PR", async () => {
	const git = stubGit();
	const { press, rows, clock, draw } = await open({ git: git.git });
	press("#18");
	git.state.branch = "feat/git-icons\n";
	draw();
	clock.live()[0].fn();
	await settle();
	await settle();
	const out = rows();
	assert.match(out.find((line) => line.includes("#19")), /▾ #19 .*◉ ✓ CI 1\/1 ✓ ready/);
	assert.ok(!out.some((line) => line.includes("Current PR can disappear")));
});

test("clicks on a check, a thread and [ Open ] open the browser; the facts row and blank rows do nothing", async () => {
	const { tab, press, lineOf, rows } = await open();
	opened.length = 0;
	assert.equal(press("lint"), true);
	assert.equal(press("deploy"), true);
	assert.equal(press("Dialogs lose their keys"), true);
	assert.equal(press("[ Open ]"), true);
	assert.deepEqual(opened, ["https://ci/lint", "https://ctx/deploy", `${url(0)}#discussion_r23`, url(20)]);
	assert.equal(tab.handleClick(lineOf("✓ clean"), "left", 6), false);
	assert.equal(tab.handleClick(lineOf("[ Open ]"), "left", rows()[lineOf("[ Open ]")].length - 2), false, "past the buttons");
	assert.equal(tab.handleClick(rows().length + 5, "left", 5), false);
	assert.equal(tab.handleClick(lineOf("lint"), "right", 5), false);
	assert.equal(tab.handleWheel?.(1, 0, 0) ?? false, false, "the column scrolls the overflow");
});

test("[ Fix N threads with agent ] fills the editor with the unresolved threads and sends nothing", async () => {
	const editor = stubEditor();
	const { press, sent } = await open({ editor });
	opened.length = 0;
	assert.equal(press("[ Fix 2 threads with agent ]"), true);
	assert.equal(editor.sets.length, 1);
	assert.equal(
		editor.text,
		[
			`Address the unresolved review threads on PR #20 (${url(20)}):`,
			"",
			`1. extensions/sidebar/prof.ts:212, greptile-apps (P1): ${url(0)}#discussion_r23`,
			"Dialogs lose their keys",
			"",
			"Why dialogs lose their keys & more.",
			"",
			"Last line.",
			"",
			`2. extensions/sidebar/prof.ts:40, bob: ${url(0)}#discussion_r9`,
			"Esc twice",
			"",
			"Why esc twice & more.",
			"",
			"Last line.",
			"",
			"Fix each one in this branch, or tell me why it should stay as it is.",
		].join("\n"),
	);
	assert.deepEqual(sent, [], "never sent to the agent");
	assert.deepEqual(opened, []);
});

test("a draft in the editor is kept: the prompt goes after it", async () => {
	const editor = stubEditor("my own note\n\n");
	const { press } = await open({ editor });
	press("[ Fix CI ]");
	assert.equal(
		editor.text,
		["my own note", "", `These checks failed on PR #20 (${url(20)}):`, "- lint: https://ci/lint", "", "Find out why (gh pr checks 20, gh run view --log-failed) and fix it in this branch."].join("\n"),
	);
});

test("without Pi's editor there is no agent button; [ Open ] stays", async () => {
	const { rows } = await open({ editor: null });
	assert.ok(rows().some((line) => /│ │   \[ Open \] +│$/.test(line)));
	assert.ok(!rows().some((line) => line.includes("Fix")));
});

test("a fork's PR with the same branch name is not the current one; the branch's upstream remote decides", async () => {
	const fork = node({ number: 30, title: "someone else's", head: "feat/prof-keyboard", owner: "someone" });
	const gh = answer([fork, P20]);
	const mine = await open({ gh });
	assert.match(mine.rows().find((line) => line.includes("#20 ")), /▾ #20 .*◉/);
	assert.ok(!mine.rows().find((line) => line.includes("#30")).includes("◉"));
	const git = stubGit({ upstream: "fork/feat/prof-keyboard\n", remotes: { fork: "git@github.com:someone/r.git\n" } });
	const theirs = await open({ gh, git: git.git });
	assert.match(theirs.rows().find((line) => line.includes("#30")), /▾ #30 .*◉/);
	assert.ok(git.calls.includes("remote get-url fork"));
	assert.equal(currentPr(parsePulls(gh).prs, "feat/prof-keyboard", "o", "https://github.com/someone/r").number, 30, "an https remote");
	assert.equal(currentPr(parsePulls(gh).prs, "feat/none", "o", undefined), undefined);
});

test("the current PR past the first 30 still shows, from the branch's own query", async () => {
	const { numbers, rows } = await open({ gh: answer([P19, P18, P15], [P20]) });
	assert.deepEqual(numbers(), [18, 19, 20, 15], "joined to its stack");
	assert.match(rows().find((line) => line.includes("#20 ")), /▾ #20 .*◉/);
	const twice = await open({ gh: answer([P20, P18], [P20]) });
	assert.deepEqual(twice.numbers(), [18, 20], "listed once");
});

test("more review threads than were read: the count says so and the PR is never ready for them", async () => {
	const some = node({ number: 5, title: "busy", head: "busy", threads: [thread("one"), thread("two")], threadsTotal: 150 });
	const none = node({ number: 4, title: "quiet", head: "quiet", threads: [thread("done", { resolved: true })], threadsTotal: 150 });
	const { row } = await open({ gh: answer([some, none]), git: stubGit({ branch: "busy\n" }).git });
	assert.ok(plain(row("#5 ")).includes("⚠ 2+ threads"));
	assert.ok(plain(row("#4 ")).includes("⚠ threads?"));
	assert.ok(painted(row("#4 "), "warning", "⚠ threads?"));
	assert.ok(plain(row("[ Fix")).includes("[ Fix 2+ threads with agent ]"));
});

test("no open pull requests: one row saying so", async () => {
	const { draw } = await open({ gh: answer([]) });
	const out = draw();
	assert.ok(out.some((line) => plain(line).includes("No open pull requests")));
	assert.ok(out.some((line) => plain(line).includes("⇄ Pull requests ")) && !out.some((line) => plain(line).includes("· 0")));
	assert.equal(out.filter((line) => /\w/.test(plain(line).replace(/[│┌┐└┘─]/g, ""))).length, 2, "the title and one row");
});

test("without gh, signed out, outside GitHub or a GraphQL error: one dim row saying so, and no throw", async () => {
	for (const [reply, text] of [
		[{ code: "ENOENT", stderr: "" }, "gh is not installed"],
		[{ code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login\n" }, "gh is not signed in"],
		[{ code: 1, stderr: "none of the git remotes configured for this repository point to a known GitHub host.\n" }, "Not a GitHub repository"],
		[{ code: 1, stderr: "failed to run git: fatal: not a git repository (or any of the parent directories): .git\n" }, "Not a git repository"],
		[{ code: 1, stderr: "GraphQL: Could not resolve to a Repository\nmore" }, "gh: GraphQL: Could not resolve to a Repository"],
		[{ errors: [{ message: "Something went wrong" }] }, "gh: Something went wrong"],
		["not json", "gh: unreadable answer"],
	]) {
		const { draw } = await open({ gh: reply });
		const out = draw();
		const line = out.find((row) => plain(row).includes(text));
		assert.ok(line, text);
		assert.ok(painted(line, "dim"), `${text}: dim`);
		assert.equal(out.filter((row) => /\w/.test(plain(row).replace(/[│┌┐└┘─]/g, ""))).length, 2, `${text}: the title and one row`);
	}
});

test("without the outline the hits move with the rows", async () => {
	const { press } = await open({ outline: false });
	opened.length = 0;
	press("deploy");
	press("[ Open ]");
	assert.deepEqual(opened, ["https://ctx/deploy", url(20)]);
});

test("openUrl runs xdg-open detached", () => {
	const saved = prDeps.spawn;
	const runs = [];
	prDeps.spawn = (bin, args, options) => {
		runs.push({ bin, args, detached: options.detached, stdio: options.stdio });
		return { on() {}, unref() {} };
	};
	try {
		assert.equal(openUrl(url(17)), true);
		assert.deepEqual(runs, [{ bin: "xdg-open", args: [url(17)], detached: true, stdio: "ignore" }]);
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
	assert.equal(calls.length, 1);
	assert.equal(clock.live().length, 1, "one timer while shown");
	const timer = clock.live()[0];
	timer.fn();
	await settle();
	assert.equal(calls.length, 1, "a probe within 30 s reads no PR");
	clock.advance(prTiming.refreshMs);
	draw();
	timer.fn();
	assert.ok(!draw().map(plain).some((row) => row.includes("refreshing…")), "the cached PRs stay while they refresh");
	await settle();
	assert.equal(calls.length, 2, "30 s later it reads again");
	git.state.branch = "feat/y\n";
	draw();
	timer.fn();
	await settle();
	await settle();
	assert.equal(calls.length, 3, "a new branch reads again");
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

test("parsers: checks, pulls, the stack, prompts, first lines and gh errors", () => {
	assert.deepEqual(
		parseChecks(P20.commits.nodes[0].commit.statusCheckRollup.contexts.nodes).map((check) => [check.name, check.state, check.url]),
		[
			["CI", "passed", "https://ci/CI"],
			["lint", "failed", "https://ci/lint"],
			["deploy", "running", "https://ctx/deploy"],
			["docs", "skipped", "https://ci/docs"],
		],
	);
	assert.equal(parseChecks([context("x", "ERROR")])[0].state, "failed");
	assert.equal(parseChecks([run("y", "COMPLETED", "TIMED_OUT")])[0].state, "failed");
	assert.equal(parseChecks([run("z", "COMPLETED", "NEUTRAL")])[0].state, "skipped");
	assert.equal(checksSummary([]), undefined);
	assert.equal(checksSummary([{ state: "skipped" }]), undefined, "only skipped checks: no summary");
	assert.equal(checksSummary([{ state: "running" }, { state: "failed" }]), "failed");
	const { owner, prs } = parsePulls(STACK);
	assert.equal(owner, "o");
	const p20 = prs.find((pr) => pr.number === 20);
	assert.deepEqual([p20.base, p20.head, p20.headOwner, p20.merge, p20.review, p20.draft], ["feat/sidebar-pr-tab", "feat/prof-keyboard", "o", "clean", "review required", false]);
	assert.deepEqual(
		p20.threads.map((t) => [t.path, t.line, t.author, t.title, t.severity]),
		[
			["extensions/sidebar/prof.ts", 212, "greptile-apps", "Dialogs lose their keys", "P1"],
			["extensions/sidebar/prof.ts", 40, "bob", "Esc twice", undefined],
		],
	);
	assert.equal(prs.find((pr) => pr.number === 18).threads[0].line, undefined, "an outdated thread has no line");
	assert.deepEqual(parsePulls({}), { owner: undefined, prs: [], problem: "unreadable answer" });
	assert.deepEqual(
		stackOf(prs, "o").map(({ pr, prefix }) => [pr.number, prefix]),
		[
			[18, ""],
			[20, "├ "],
			[19, "└ "],
			[15, ""],
		],
	);
	const deep = parsePulls(answer([node({ number: 3, title: "c", base: "b", head: "c" }), node({ number: 2, title: "b", base: "a", head: "b" }), node({ number: 4, title: "d", base: "a", head: "d" }), node({ number: 1, title: "a", head: "a" })])).prs;
	assert.deepEqual(
		stackOf(deep, "o").map(({ pr, prefix }) => [pr.number, prefix]),
		[
			[1, ""],
			[2, "├ "],
			[3, "│ └ "],
			[4, "└ "],
		],
	);
	const loop = parsePulls(answer([node({ number: 2, title: "b", base: "a", head: "b" }), node({ number: 1, title: "a", base: "b", head: "a" })])).prs;
	assert.deepEqual(stackOf(loop, "o").map(({ pr }) => pr.number).sort(), [1, 2], "a loop of bases still lists each PR once");
	const forkBase = parsePulls(answer([node({ number: 2, title: "b", base: "a", head: "b" }), node({ number: 1, title: "a", head: "a", owner: "someone" })])).prs;
	assert.deepEqual(stackOf(forkBase, "o").map(({ prefix }) => prefix), ["", ""], "a fork's branch is not a base in this repository");
	assert.match(threadsPrompt(p20), /^Address the unresolved review threads on PR #20/);
	assert.match(ciPrompt(p20), /- lint: https:\/\/ci\/lint/);
	assert.equal(firstLine("<!-- x -->\n\n## **Hello** `world` &amp; you\nnext"), "Hello world & you");
	assert.equal(ghProblem({ code: "ENOENT" }, ""), "gh is not installed");
	assert.equal(ghProblem({ code: 1 }, "HTTP 401: Bad credentials"), "gh is not signed in");
});
