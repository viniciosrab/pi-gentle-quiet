import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { painted, plain, theme } from "./helpers.mjs";
import { createTab } from "../extensions/sidebar/git.ts";
import { parseBranchDiff, parseBranches, parseStatus, statusCounts } from "../extensions/sidebar/git-data.ts";
import { launchDeps, openDiff, openInEditor } from "../extensions/sidebar/git-launch.ts";

const GRAPH = [
	"* a1b2c3d (HEAD -> main, origin/main) Add git tab",
	"* 9f8e7d6 Fix footer",
	"| * 1234567 (feature) Feature work",
	"|/  ",
	"* 0abcdef Initial commit",
	"",
].join("\n");
const STATUS = " M src/a.ts\nA  src/b.ts\n?? new.txt\n";
const NUMSTAT = "10\t2\tsrc/a.ts\n2\t1\tsrc/b.ts\n";
const REFS = [
	"refs/heads/main\tmain\torigin/main\t\t2 hours ago",
	"refs/heads/feature\tfeature\torigin/feature\t[ahead 2, behind 1]\t3 days ago",
	"refs/heads/old\told\torigin/old\t[gone]\t5 weeks ago",
	"refs/heads/wip\twip\t\t\t10 minutes ago",
	"refs/remotes/origin/HEAD\torigin\t\t\t2 hours ago",
	"refs/remotes/origin/main\torigin/main\t\t\t2 hours ago",
	"refs/remotes/origin/release\torigin/release\t\t\t1 day ago",
	"",
].join("\n");
const DIFF_NUMSTAT = "5\t0\tsrc/new.ts\n0\t7\tsrc/gone.ts\n3\t1\tsrc/{old => moved}.ts\n";
const DIFF_NAMES = "A\tsrc/new.ts\nD\tsrc/gone.ts\nR090\tsrc/old.ts\tsrc/moved.ts\n";

// What `git` answers in the fixture repository, by the arguments the tab passes to host.git.
function repo(overrides = {}) {
	const table = {
		toplevel: "/repo\n",
		branch: "main\n",
		short: "a1b2c3d\n",
		log: GRAPH,
		status: STATUS,
		numstat: NUMSTAT,
		refs: REFS,
		"diff...numstat": DIFF_NUMSTAT,
		"diff...names": DIFF_NAMES,
		"diff..numstat": "",
		"diff..names": "",
		...overrides,
	};
	return (args) => {
		const line = args.join(" ");
		const pick = (key) => (typeof table[key] === "function" ? table[key](args) : table[key]);
		if (line === "rev-parse --show-toplevel") return pick("toplevel");
		if (line === "branch --show-current") return pick("branch");
		if (line === "rev-parse --short HEAD") return pick("short");
		if (line.startsWith("log --graph --oneline --decorate")) return pick("log");
		if (line.includes("status --porcelain=v1")) return pick("status");
		if (line.includes("diff HEAD --numstat")) return pick("numstat");
		if (line.startsWith("for-each-ref")) return pick("refs");
		if (/^diff HEAD\.\.\.\S+ --numstat/.test(line)) return pick("diff...numstat");
		if (/^diff HEAD\.\.\.\S+ --name-status/.test(line)) return pick("diff...names");
		if (/^diff HEAD \S+ --numstat/.test(line)) return pick("diff..numstat");
		if (/^diff HEAD \S+ --name-status/.test(line)) return pick("diff..names");
		return undefined;
	};
}

const pad = (row, width) => {
	const cut = visibleWidth(row) <= width ? row : truncateToWidth(row, width, "…");
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
};

// A host like gentle-quiet's tabHost, with the theme of the helpers and git answered by `git`.
function makeHost({ git = repo(), cwd = "/repo", outline = true, changes, ctx } = {}) {
	const calls = [];
	let renders = 0;
	const inner = (width) => (outline ? width - 4 : width - 1);
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
		inner,
		cwd: () => cwd,
		ctx: () => ctx,
		pi: undefined,
		agentDir: "/agent",
		requestRender: () => renders++,
		git: (args, dir) => {
			calls.push([args.join(" "), dir]);
			return Promise.resolve().then(() => git(args));
		},
		changes: () => changes,
		usage: () => ({ name: "", windows: [] }),
		gauge: () => "",
		icons: { branch: "⎇" },
	};
	return { host, calls, renders: () => renders };
}

// No test opens a real editor, terminal or herdr tab: launches fail unless a test records them.
launchDeps.env = { PATH: "/nonexistent" };
launchDeps.execFile = (bin, args, options, done) => done(new Error("no launches in tests"));
launchDeps.spawn = () => {
	throw new Error("no launches in tests");
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function open(options = {}, { width = 59, height = 40 } = {}) {
	const made = makeHost(options);
	const tab = createTab(made.host);
	tab.onShow?.();
	await settle();
	tab.render(width, height); // asks for what the first data needs (the branch list, a diff, ...)
	await settle();
	const draw = (w = width, h = height) => tab.render(w, h);
	const rows = (w = width, h = height) => draw(w, h).map(plain);
	const lineOf = (pattern, list = rows()) => list.findIndex((row) => (typeof pattern === "string" ? row.includes(pattern) : pattern.test(row)));
	const click = (pattern, { button = "left", at } = {}) => {
		const list = rows();
		const line = lineOf(pattern, list);
		assert.ok(line >= 0, `a row with ${pattern}`);
		const x = at === undefined ? list[line].search(/\S/) + 2 : list[line].indexOf(at) + 1;
		return tab.handleClick(line, button, x);
	};
	return { ...made, tab, draw, rows, lineOf, click, width, height };
}

// Launchers record what they would run instead of opening anything.
function recordLaunches(env = {}) {
	const saved = { ...launchDeps };
	const runs = [];
	launchDeps.env = { PATH: "/bin", ...env };
	launchDeps.execFile = (bin, args, options, done) => {
		runs.push({ via: "execFile", bin, args, cwd: options?.cwd });
		if (args[0] === "tab") done(null, JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" } } }));
		else done(null, "");
	};
	launchDeps.spawn = (bin, args, options) => {
		runs.push({ via: "spawn", bin, args, cwd: options.cwd, detached: options.detached });
		return { on() {}, unref() {} };
	};
	launchDeps.which = (name) => ["foot", "kitty"].includes(name);
	return { runs, restore: () => Object.assign(launchDeps, saved) };
}

test("with no working directory the tab draws a short card and runs no git", async () => {
	const { rows, calls } = await open({ cwd: null });
	assert.match(rows().join("\n"), /No working directory/);
	assert.equal(calls.length, 0);
});

test("while git answers, the tab says it is reading", async () => {
	const made = makeHost({ git: () => new Promise(() => {}) });
	const tab = createTab(made.host);
	tab.onShow();
	const out = tab.render(59, 30).map(plain);
	assert.match(out.join("\n"), /Reading git…/);
	assert.ok(out.length <= 30);
});

test("outside a repository, or with git missing or failing, the tab degrades to one short message", async () => {
	for (const git of [repo({ toplevel: undefined }), () => Promise.reject(new Error("spawn git ENOENT")), () => {
		throw new Error("boom");
	}]) {
		const { rows } = await open({ git });
		const text = rows().join("\n");
		assert.match(text, /Not a git repository/);
		assert.ok(rows().length < 10, "one small card");
	}
});

test("a git that never answers for one part leaves only that part reading", async () => {
	const { rows } = await open({ git: repo({ status: () => new Promise(() => {}), log: () => new Promise(() => {}) }) });
	const text = rows().join("\n");
	assert.match(text, /Reading log…/);
	assert.match(text, /Reading status…/);
});

test("two cards split the height 50/50: the commit graph on top and the working tree under it", async () => {
	const { rows, draw } = await open({}, { height: 40 });
	const out = rows();
	assert.equal(out.length, 40, "the cards fill the tab");
	assert.match(out[0], /^┌─+┐$/);
	assert.match(out[1], /^│ ⎇ Git +\[ Graph \| Branches \] │$/);
	const topEnd = out.findIndex((row) => row.startsWith("└"));
	assert.equal(topEnd + 1, 19, "top card: half of the 39 rows left by the gap");
	assert.equal(out[19].trim(), "", "a blank row between the cards");
	assert.match(out[20], /^┌/);
	assert.match(out[21], /Working tree ▲/);
	assert.match(out.at(-1), /^└/);
	for (const row of out) assert.ok([...row].length <= 59, `fits: ${row}`);
	assert.ok(draw().some((row) => painted(row, "toolTitle")), "titles as gentle-quiet's cards");
});

test("the graph card shows the branch with its status badges, the ASCII graph and the changes", async () => {
	const { rows, draw } = await open({ changes: { files: 3, added: 14, deleted: 3 } });
	const out = rows();
	assert.match(out[3], /│ main +● 1 mod · \+1 staged · \?1 untracked │/);
	const graph = out.findIndex((row) => row.includes("a1b2c3d"));
	assert.match(out[graph], /\* a1b2c3d \(HEAD -> main, origin\/main\) Add git tab/);
	assert.match(out[graph + 2], /\| \* 1234567 \(feature\) Feature work/);
	assert.match(out[graph + 3], /\|\//);
	assert.ok(out.some((row) => /✎ 3 files · \+14 −3/.test(row)), "the changes row from the status line's counts");
	const colored = draw();
	assert.ok(painted(colored[graph], "accent", "*"), "graph node in accent");
	assert.ok(painted(colored[graph], "warning", "a1b2c3d"), "hash in warning");
	assert.ok(painted(colored[graph], "success", "HEAD -> main"), "HEAD ref in success");
	assert.ok(painted(colored[3], "warning", "● 1 mod"));
});

test("a clean repository with no commits says so in each card", async () => {
	const { rows } = await open({ git: repo({ log: undefined, status: "", numstat: undefined }) });
	const text = rows().join("\n");
	assert.match(text, /No commits yet/);
	assert.match(text, /✔ Clean · No pending changes/);
	assert.match(rows()[3], /main +✔ clean/);
});

test("a detached HEAD shows the short commit as the branch", async () => {
	const { rows } = await open({ git: repo({ branch: "\n" }) });
	assert.match(rows()[3], /│ a1b2c3d /);
});

test("the working tree card lists each file with its status badge and +n −n, and [diff]", async () => {
	const { rows, draw } = await open();
	const out = rows();
	assert.ok(out.some((row) => /● 3 files changed +\+12 {2}−3 │$/.test(row)));
	assert.ok(out.some((row) => /click: nvim · \[diff\]: view diff/.test(row)));
	assert.ok(out.some((row) => /│ M {2}src\/a\.ts +\[diff\] \+10 −2 │$/.test(row)));
	assert.ok(out.some((row) => /│ A {2}src\/b\.ts +\[diff\] \+2 −1 │$/.test(row)));
	assert.ok(out.some((row) => /│ \? {2}new\.txt +\[diff\] │$/.test(row)));
	const colored = draw();
	const a = rows().findIndex((row) => row.includes("src/a.ts"));
	assert.ok(painted(colored[a], "warning", "M"));
	assert.ok(painted(colored[a], "dim", "src/") && painted(colored[a], "text", "a.ts"), "folder dim, name in text");
	assert.ok(painted(colored[a], "toolDiffAdded", "+10") && painted(colored[a], "toolDiffRemoved", "−2"));
	const b = rows().findIndex((row) => row.includes("src/b.ts"));
	assert.ok(painted(colored[b], "success", "A"));
});

test("the toggle switches to the branch list, with tracking and dates, and back to the graph", async () => {
	const { tab, rows, click } = await open();
	assert.equal(click(/Graph \| Branches/, { at: "Branches" }), true);
	await settle();
	const out = rows();
	assert.match(out.join("\n"), /● 5 branches/);
	assert.ok(out.some((row) => /│ ● main +current │$/.test(row)));
	assert.ok(out.some((row) => /│ ● feature +↑2 ↓1 │$/.test(row)));
	assert.ok(out.some((row) => /│ ● old +gone │$/.test(row)));
	assert.ok(out.some((row) => /│ ● wip +10m │$/.test(row)));
	assert.ok(out.some((row) => /│ ● origin\/release +1d │$/.test(row)), "remote-only branches after the local ones");
	assert.ok(!out.some((row) => /origin\/main +2h/.test(row)), "a remote with a local branch is left out");
	assert.ok(!out.some((row) => row.includes("a1b2c3d")), "no graph");
	assert.equal(click(/Graph \| Branches/, { at: "Graph" }), true);
	assert.ok(rows().some((row) => row.includes("a1b2c3d")));
	assert.equal(tab.handleClick(rows().findIndex((row) => row.includes("a1b2c3d")), "left", 4), false, "a graph row does nothing");
});

test("clicking a branch turns the working tree card into the branch diff inspector", async () => {
	const { rows, click, calls, draw } = await open();
	click(/Graph \| Branches/, { at: "Branches" });
	await settle();
	assert.equal(click(/● feature/), true);
	await settle();
	const out = rows();
	assert.ok(calls.some(([args]) => args === "diff HEAD...feature --numstat"));
	assert.ok(out.some((row) => /│ Diff · feature +\[ ✕ \] \[ ↗ \] │$/.test(row)));
	assert.ok(out.some((row) => /│ ▶ feature +diff │$/.test(row)), "the selected branch marked");
	assert.ok(out.some((row) => /● 3 files +\+8 {2}−8 │$/.test(row)));
	assert.ok(out.some((row) => /│ A {2}src\/new\.ts +\[diff\] \+5 │$/.test(row)));
	assert.ok(out.some((row) => /│ D {2}src\/gone\.ts +\[diff\] −7 │$/.test(row)));
	assert.ok(out.some((row) => /│ R {2}src\/moved\.ts +\[diff\] \+3 −1 │$/.test(row)), "a rename under its new name");
	assert.ok(!out.some((row) => row.includes("Working tree")));
	const colored = draw();
	assert.ok(colored.some((row) => painted(row, "error", "✕")) && colored.some((row) => painted(row, "accent", "↗")));
	// The same branch again closes the inspector.
	assert.equal(click(/▶ feature/), true);
	assert.ok(rows().some((row) => row.includes("Working tree")));
	// The current branch never opens it.
	assert.equal(click(/● main +current/), true);
	assert.ok(rows().some((row) => row.includes("Working tree")));
});

test("[ ✕ ] closes the inspector, and [ ↗ ] opens the full branch diff", async () => {
	const launches = recordLaunches();
	try {
		const { rows, click } = await open();
		click(/Graph \| Branches/, { at: "Branches" });
		await settle();
		click(/● feature/);
		await settle();
		assert.equal(click(/Diff · feature/, { at: "↗" }), true);
		await settle();
		const command = launches.runs.at(-1).args.at(-1);
		assert.equal(command, "git -c color.ui=always diff --color=always 'HEAD...feature' | less -R");
		assert.equal(launches.runs.at(-1).cwd, "/repo");
		assert.equal(click(/Diff · feature/, { at: "✕" }), true);
		assert.ok(rows().some((row) => row.includes("Working tree")));
	} finally {
		launches.restore();
	}
});

test("a branch with no merge base falls back to the direct diff; no difference says so", async () => {
	const direct = await open({ git: repo({ "diff...numstat": "", "diff..numstat": "4\t4\tREADME.md\n", "diff..names": "M\tREADME.md\n" }) });
	direct.click(/Graph \| Branches/, { at: "Branches" });
	await settle();
	direct.click(/● feature/);
	await settle();
	assert.ok(direct.rows().some((row) => /M {2}README\.md +\[diff\] \+4 −4/.test(row)));
	assert.ok(direct.calls.some(([args]) => args === "diff HEAD feature --name-status"));

	const same = await open({ git: repo({ "diff...numstat": "", "diff..numstat": "" }) });
	same.click(/Graph \| Branches/, { at: "Branches" });
	await settle();
	same.click(/● feature/);
	await settle();
	assert.ok(same.rows().some((row) => /✔ No differences with HEAD/.test(row)));
});

test("a file click opens it in the editor; [diff] or a right click opens its diff", async () => {
	const launches = recordLaunches({ EDITOR: "hx" });
	try {
		const { click } = await open();
		assert.equal(click(/src\/a\.ts/), true);
		assert.deepEqual(launches.runs.at(-1).args.slice(-3), ["sh", "-c", "hx '/repo/src/a.ts'"]);
		assert.equal(click(/src\/a\.ts/, { at: "[diff]" }), true);
		assert.equal(launches.runs.at(-1).args.at(-1), "git -c color.ui=always diff --color=always HEAD -- 'src/a.ts' | less -R");
		assert.equal(click(/src\/b\.ts/, { button: "right" }), true);
		assert.match(launches.runs.at(-1).args.at(-1), /diff --color=always HEAD -- 'src\/b\.ts'/);
		click(/new\.txt/, { at: "[diff]" });
		assert.match(launches.runs.at(-1).args.at(-1), /diff --color=always --no-index -- \/dev\/null 'new\.txt'/, "an untracked file against nothing");
		assert.equal(click(/src\/a\.ts/, { button: "middle" }), false);
	} finally {
		launches.restore();
	}
});

test("in the inspector a file's diff is against the branch", async () => {
	const launches = recordLaunches();
	try {
		const { click } = await open();
		click(/Graph \| Branches/, { at: "Branches" });
		await settle();
		click(/● feature/);
		await settle();
		click(/src\/new\.ts/, { at: "[diff]" });
		assert.equal(launches.runs.at(-1).args.at(-1), "git -c color.ui=always diff --color=always 'HEAD...feature' -- 'src/new.ts' | less -R");
		click(/src\/new\.ts/);
		assert.match(launches.runs.at(-1).args.at(-1), /^nvim '\/repo\/src\/new\.ts'$/, "nvim when neither $VISUAL nor $EDITOR is set");
	} finally {
		launches.restore();
	}
});

test("launchers: a focused herdr tab inside herdr, else a detached terminal, falling back when herdr fails", async () => {
	const herdr = recordLaunches({ HERDR_ENV: "1", HERDR_BIN_PATH: "/opt/herdr", VISUAL: "nvim -p" });
	try {
		assert.equal(await openInEditor("/repo/x.ts", "/repo"), true);
		assert.deepEqual(herdr.runs[0], { via: "execFile", bin: "/opt/herdr", args: ["tab", "create", "--cwd", "/repo", "--label", "nvim: x.ts", "--focus"], cwd: undefined });
		assert.deepEqual(herdr.runs[1].args, ["pane", "run", "w1:p9", "nvim -p '/repo/x.ts'"]);
		assert.equal(herdr.runs.length, 2, "no terminal");
	} finally {
		herdr.restore();
	}
	const plainEnv = recordLaunches({ TERMINAL: "kitty" });
	try {
		assert.equal(await openDiff("/repo", "it's", "a b.ts"), true);
		const run = plainEnv.runs[0];
		assert.equal(run.via, "spawn");
		assert.equal(run.bin, "kitty");
		assert.equal(run.detached, true);
		assert.equal(run.args.at(-1), "git -c color.ui=always diff --color=always 'HEAD...it'\\''s' -- 'a b.ts' | less -R", "quoted for the shell");
	} finally {
		plainEnv.restore();
	}
	const broken = recordLaunches({ HERDR_ENV: "1" });
	launchDeps.execFile = (bin, args, options, done) => done(new Error("no herdr"));
	try {
		assert.equal(await openDiff("/repo", null), true);
		assert.equal(broken.runs.at(-1).via, "spawn");
		assert.equal(broken.runs.at(-1).bin, "foot", "the first terminal found");
	} finally {
		broken.restore();
	}
	const failing = recordLaunches();
	launchDeps.spawn = () => {
		throw new Error("ENOENT");
	};
	try {
		assert.equal(await openDiff("/repo", null), false, "a launcher that cannot start says so and does not throw");
	} finally {
		failing.restore();
	}
});

test("the wheel scrolls inside a card with more rows than room, with a position marker", async () => {
	const many = Array.from({ length: 30 }, (_, i) => ` M f${String(i).padStart(2, "0")}.ts`).join("\n");
	const { tab, rows } = await open({ git: repo({ status: many, numstat: "" }) }, { height: 30 });
	let out = rows(59, 30);
	assert.equal(out.length, 30);
	const marker = out.findIndex((row) => /wheel to scroll +\[ ▲ 1\.\.\d+\/33 ▼ \] │$/.test(row));
	assert.ok(marker > 15, "the marker in the working tree card");
	const bottomLine = out.findIndex((row) => row.includes("f00.ts"));
	assert.equal(tab.handleWheel(1, bottomLine, 5), true);
	out = rows(59, 30);
	assert.ok(!out.some((row) => row.includes("● 30 files")), "scrolled by two rows");
	assert.ok(out.some((row) => /\[ ▲ 3\.\./.test(row)));
	assert.equal(tab.handleWheel(-1, bottomLine, 5), true);
	assert.ok(rows(59, 30).some((row) => row.includes("● 30 files")));
	assert.equal(tab.handleWheel(-1, bottomLine, 5), true, "kept at the top while the card overflows");
	assert.equal(tab.handleWheel(1, 3, 5), false, "the graph card fits: the wheel is not taken");
	for (let i = 0; i < 40; i++) tab.handleWheel(1, bottomLine, 5);
	assert.ok(rows(59, 30).some((row) => row.includes("f29.ts")), "down to the last file");
});

test("the graph card scrolls on its own when its graph is taller than its half", async () => {
	const log = Array.from({ length: 20 }, (_, i) => `* ${String(i).padStart(7, "0")} Commit ${i}`).join("\n");
	const { tab, rows } = await open({ git: repo({ log }) }, { height: 24 });
	assert.ok(rows(59, 24).some((row) => /\[ ▲ 1\.\./.test(row)));
	assert.equal(tab.handleWheel(1, 4, 5), true);
	assert.ok(rows(59, 24).some((row) => /\[ ▲ 3\.\./.test(row)));
});

test("a click on a card's title folds it to a summary row and gives its room to the other card", async () => {
	const { rows, click, lineOf } = await open({}, { height: 40 });
	assert.equal(click(/Working tree ▲/), true);
	let out = rows();
	assert.ok(out.some((row) => /Working tree ▼/.test(row)));
	assert.ok(out.some((row) => /● 3 files +\+12 −3 │$/.test(row)), "the summary row");
	assert.ok(!out.some((row) => row.includes("src/a.ts")));
	assert.ok(lineOf(/Working tree ▼/) > 30, "the graph card took the room");
	assert.equal(out.length, 40);
	assert.equal(click(/⎇ Git/), true);
	out = rows();
	assert.ok(out.some((row) => /│ main · a1b2c3d Add.* ● 1 mod · \+1 staged/.test(row)), "the graph folded to branch and last commit");
	assert.ok(!out.some((row) => row.includes("Graph | Branches")));
	click(/⎇ Git/);
	click(/Working tree ▼/);
	assert.ok(rows().some((row) => row.includes("src/a.ts")));
});

test("data is cached with a TTL and refreshed in onShow, redrawing when it changed", async () => {
	let status = STATUS;
	const { tab, rows, calls, renders } = await open({ git: repo({ status: () => status }) });
	const before = calls.length;
	rows();
	rows();
	await settle();
	assert.equal(calls.length, before, "no git while the cache is fresh");
	status = " M src/a.ts\n";
	const drawn = renders();
	tab.onShow();
	await settle();
	assert.ok(calls.length > before);
	assert.ok(renders() > drawn, "asked for a redraw");
	assert.ok(rows().some((row) => row.includes("● 1 files changed") || row.includes("● 1 file changed")));
	tab.dispose?.();
});

test("without the outline the rows are indented and clicks still land on the right row and column", async () => {
	const launches = recordLaunches();
	try {
		const { rows, click } = await open({ outline: false });
		const out = rows();
		assert.match(out[0], /^ ⎇ Git +\[ Graph \| Branches \]$/);
		assert.equal(click(/src\/a\.ts/, { at: "[diff]" }), true);
		assert.match(launches.runs.at(-1).args.at(-1), /diff --color=always HEAD -- 'src\/a\.ts'/);
		assert.equal(click(/Graph \| Branches/, { at: "Branches" }), true);
		await settle();
		assert.ok(rows().some((row) => row.includes("● 5 branches")));
	} finally {
		launches.restore();
	}
});

test("narrow columns keep every row inside the width and shorten the toggle", async () => {
	const { rows } = await open({}, { width: 34, height: 30 });
	const out = rows(34, 30);
	for (const row of out) assert.ok([...row].length <= 34, row);
	assert.match(out[1], /\[ G \| B \]/);
});

test("parsers: porcelain with renames and quoted paths, counts, branches and branch diffs", () => {
	const files = parseStatus('R  old.ts -> new.ts\n?? "with space.txt"\nUU both.ts\n D gone.ts\n', "3\t1\tnew.ts\n");
	assert.deepEqual(files.map((f) => [f.code, f.path, f.status, f.added, f.deleted]), [
		["R", "new.ts", "renamed", 3, 1],
		["??", "with space.txt", "untracked", 0, 0],
		["UU", "both.ts", "conflict", 0, 0],
		["D", "gone.ts", "deleted", 0, 0],
	]);
	assert.deepEqual(statusCounts(files), { staged: 1, modified: 1, untracked: 1, conflicts: 1, added: 3, deleted: 1, clean: false });
	assert.equal(statusCounts([]).clean, true);
	const branches = parseBranches(REFS, "main");
	assert.deepEqual(branches.map((b) => b.name), ["main", "feature", "old", "wip", "origin/release"]);
	assert.deepEqual(branches[1], { name: "feature", current: false, remote: false, ahead: 2, behind: 1, gone: false, date: "3d" });
	const diff = parseBranchDiff("1\t0\ta/{x => y}/z.ts\n-\t-\timg.png\n", "R100\ta/x/z.ts\ta/y/z.ts\nM\timg.png\n");
	assert.deepEqual(diff.files.map((f) => [f.path, f.status, f.added]), [["a/y/z.ts", "renamed", 1], ["img.png", "modified", 0]]);
	assert.equal(diff.added, 1);
});

test("with Pi's overlay UI a file click opens the read-only preview, and e there opens the editor", async () => {
	const launches = recordLaunches({ EDITOR: "hx" });
	const overlays = [];
	const ctx = { hasUI: true, ui: { custom: (factory, options) => (overlays.push({ factory, options }), new Promise(() => {})) } };
	try {
		const { click } = await open({ ctx });
		const before = launches.runs.length;
		assert.equal(click(/src\/a\.ts/), true);
		assert.equal(overlays.length, 1, "the preview pop-up, as in TREE");
		assert.equal(launches.runs.length, before, "no editor tab");
		const done = [];
		const preview = overlays[0].factory({ terminal: { columns: 120, rows: 30 }, requestRender() {} }, theme, {}, (value) => done.push(value));
		assert.ok(preview.render(80).some((row) => row.includes("src/a.ts")), "the file's path in the pop-up");
		preview.handleInput("e");
		assert.equal(done.length, 1, "e closes the preview");
		await settle();
		assert.deepEqual(launches.runs.at(-1).args.slice(-3), ["sh", "-c", "hx '/repo/src/a.ts'"], "and opens the editor");
		assert.equal(click(/src\/a\.ts/, { at: "[diff]" }), true);
		assert.equal(overlays.length, 1, "[diff] still opens the diff, not the preview");
	} finally {
		launches.restore();
	}
});

