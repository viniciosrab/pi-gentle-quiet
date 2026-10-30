import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { painted, plain, theme } from "./helpers.mjs";
import { createTab, treeTiming } from "../extensions/sidebar/tree.ts";
import { launchDeps, launchEditor } from "../extensions/sidebar/tree-launch.ts";
import { flattenTree, parseGitStatus, scanTree } from "../extensions/sidebar/tree-scan.ts";
import { symbolIcon } from "../extensions/sidebar/symbols-icons.ts";

// A project on disk: `files` are relative paths, a trailing "/" makes an empty folder.
function project(files, name = "demo-app") {
	const root = path.join(mkdtempSync(path.join(os.tmpdir(), "gq-tree-")), name);
	mkdirSync(root);
	for (const file of files) {
		const full = path.join(root, file);
		if (file.endsWith("/")) mkdirSync(full, { recursive: true });
		else {
			mkdirSync(path.dirname(full), { recursive: true });
			writeFileSync(full, "x");
		}
	}
	return root;
}

const FILES = ["src/index.ts", "src/lib/util.ts", "src/lib/deep/a.ts", "docs/guide.md", "node_modules/pkg/index.js", ".git/HEAD", "dist/out.js", "README.md", "package.json"];

// gentle-quiet's square outline, as the column's host draws it (border on).
const BOX_CHROME = 4;
const fit = (row, inner) => {
	const text = plain(row);
	const cut = [...text].length <= inner ? row : [...text].slice(0, inner - 1).join("") + "…";
	return cut + " ".repeat(Math.max(0, inner - [...plain(cut)].length));
};
function boxed(rows, width) {
	const inner = width - BOX_CHROME;
	const line = (text) => theme.fg("border", text);
	return [line(`┌${"─".repeat(inner + 2)}┐`), ...rows.map((row) => `${line("│")} ${fit(row, inner)} ${line("│")}`), line(`└${"─".repeat(inner + 2)}┘`)];
}

// A stand-in for gentle-quiet's SidebarHost; `git` answers by the first git argument after any "-c" pair.
function fakeHost({ cwd, git = {}, border = true, ctx, treeIcons } = {}) {
	const calls = { git: [], renders: 0 };
	const host = {
		theme,
		fg: (role, text) => theme.fg(role, text),
		bold: (text) => theme.bold(text),
		inner: (width) => (border ? width - BOX_CHROME : width - 1),
		box: (rows, width) => (border ? boxed(rows, width) : rows.map((row) => ` ${row}`)),
		card: (title, rows, width) => boxed([theme.fg("toolTitle", theme.bold(title)), ...(rows.length ? ["", ...rows] : [])], width),
		cwd: () => cwd,
		ctx: () => ctx,
		pi: undefined,
		agentDir: "/nowhere",
		requestRender: () => calls.renders++,
		git: async (args) => {
			calls.git.push(args);
			const verb = args[0] === "-c" ? args[2] : args[0];
			const answer = typeof git === "function" ? git(args) : git[verb];
			return typeof answer === "function" ? answer(args) : answer;
		},
		changes: () => undefined,
		usage: () => ({ name: "", windows: [] }),
		gauge: () => "",
		icons: {},
		...(treeIcons ? { treeIcons } : {}),
	};
	return { host, calls };
}

async function until(check, what = "condition") {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`timed out waiting for ${what}`);
}

// Records editor launches instead of opening anything.
function recordLaunches(t) {
	const launches = [];
	const original = { ...launchDeps };
	launchDeps.launch = async (target, cwd) => {
		launches.push([target, cwd]);
		return launches.failWith;
	};
	t.after(() => Object.assign(launchDeps, original));
	return launches;
}

// Opens the tab like the column does (onShow, then render) and waits for the first scan.
async function opened(options = {}, width = 59, height = 30) {
	const { host, calls } = fakeHost(options);
	const tab = createTab(host);
	tab.onShow?.();
	await until(() => !plain(tab.render(width, height).join("\n")).includes("Scanning"), "the first scan");
	const rows = () => tab.render(width, height).map(plain);
	return { tab, host, calls, rows, raw: () => tab.render(width, height) };
}

const STATUS = (out) => ({ "rev-parse": "\n", status: out });

test("createTab does no I/O: nothing is read until the tab is shown", () => {
	const { host, calls } = fakeHost({ cwd: project(FILES) });
	const tab = createTab(host);
	assert.equal(tab.id, "tree");
	assert.equal(calls.git.length, 0);
	assert.match(plain(tab.render(59, 20).join("\n")), /Scanning/);
	tab.dispose?.();
});

test("the header reads '<icon> PROYECTO · <project> ══ [ ↗ nvim ]' in the card title style", async (t) => {
	const saved = process.env.VISUAL;
	process.env.VISUAL = "/usr/bin/nvim";
	t.after(() => (saved === undefined ? delete process.env.VISUAL : (process.env.VISUAL = saved)));
	const root = project(FILES);
	writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pkg-name" }));
	const { tab, rows, raw } = await opened({ cwd: root, git: STATUS("") });
	t.after(() => tab.dispose());
	const out = rows();
	assert.ok(out[0].startsWith("┌") && out.at(-1).startsWith("└"), "square outline");
	assert.match(out[1], /^│ ⌂ PROYECTO · pkg-name ═+ \[ ↗ nvim \] │$/);
	assert.ok(painted(raw()[1], "toolTitle", theme.bold("⌂ PROYECTO · pkg-name")), "title bold in toolTitle");
	assert.ok(painted(raw()[1], "border", "═"), "the fill in the border color");
	assert.ok(out.every((row) => [...row].length === 59), "every row as wide as the column");
	assert.equal(out.length, 30, "the card fills the height");
});

test("the project name falls back to the folder name, and a narrow column gets the compact badge", async (t) => {
	const root = project(["a.txt"], "plain-folder");
	const { tab, rows } = await opened({ cwd: root, git: STATUS("") });
	t.after(() => tab.dispose());
	assert.match(rows()[1], /PROYECTO · plain-folder ═+ \[ ↗ [^\]]+\] │$/);
	const narrow = tab.render(36, 12).map(plain);
	assert.match(narrow[1], /\[ ↗ \] │$/, "compact badge under 38 columns");
	assert.ok(narrow.every((row) => [...row].length === 36));
});

test("the tree: folders first with item counts, guides, ignored folders left out, only src expanded", async (t) => {
	const { tab, rows } = await opened({ cwd: project(FILES), git: STATUS("") });
	t.after(() => tab.dispose());
	const body = rows().slice(3, -1).map((row) => row.replace(/^│ /, "").replace(/ *│$/, "")).filter(Boolean);
	assert.deepEqual(body, [
		"├── 📁 docs (1 items)",
		"├── 📂 src (2 items)",
		"│   ├── 📁 lib (2 items)",
		"│   └── 📄 index.ts",
		"├── 📄 package.json",
		"└── 📄 README.md",
	]);
	assert.ok(!rows().join("").match(/node_modules|dist|\.git\b/), "ignored names");
});

// A Symbols icon as the TREE paints it: the glyph in its own 24-bit color.
const truecolor = ({ char, color }) => `\x1b[38;2;${parseInt(color.slice(1, 3), 16)};${parseInt(color.slice(3, 5), 16)};${parseInt(color.slice(5, 7), 16)}m${char}\x1b[39m`;

test("with Symbols icons each row draws its mapped glyph in its color, one cell, and the rows keep their width", async (t) => {
	const git = STATUS(" M src/index.ts\n?? docs/guide.md\n");
	const { tab, rows, raw } = await opened({ cwd: project([...FILES, "src/tree.test.ts"]), git, treeIcons: "symbols" });
	t.after(() => tab.dispose());
	const icon = (name, options) => symbolIcon(name, options);
	const body = rows().slice(3, -1).map((row) => row.replace(/^│ /, "").replace(/ *[●M]? │$/, "")).filter(Boolean);
	assert.deepEqual(body, [
		`├── ${icon("docs", { isDirectory: true }).char} docs (1 items)`,
		`├── ${icon("src", { isDirectory: true, open: true }).char} src (3 items)`,
		`│   ├── ${icon("lib", { isDirectory: true }).char} lib (2 items)`,
		`│   ├── ${icon("index.ts").char} index.ts`,
		`│   └── ${icon("tree.test.ts").char} tree.test.ts`,
		`├── ${icon("package.json").char} package.json`,
		`└── ${icon("README.md").char} README.md`,
	]);
	for (const [name, options] of [["docs", { isDirectory: true }], ["src", { isDirectory: true, open: true }], ["index.ts"], ["tree.test.ts"], ["package.json"], ["README.md"]]) {
		const line = raw().find((row) => plain(row).includes(` ${name}`));
		assert.ok(line.includes(`${truecolor(icon(name, options))} `), `${name} painted in ${icon(name, options).color}`);
	}
	assert.match(rows().find((row) => row.includes(" index.ts")), /index\.ts +M │$/, "the badge stays on the right edge");
	assert.match(rows().find((row) => row.includes(" docs")), /docs \(1 items\) +● │$/);
	assert.ok(rows().every((row) => [...row].length === 59), "every row as wide as the column");
	assert.ok(!rows().join("").match(/[📁📂📄]/u), "no emoji left");
});

test("emoji icons stay the default and draw exactly as before", async (t) => {
	const root = project(FILES);
	const git = STATUS(" M src/index.ts\n");
	const plainTab = await opened({ cwd: root, git });
	const emojiTab = await opened({ cwd: root, git, treeIcons: "emoji" });
	t.after(() => (plainTab.tab.dispose(), emojiTab.tab.dispose()));
	assert.deepEqual(emojiTab.raw(), plainTab.raw());
	assert.ok(plainTab.rows().some((row) => row.includes("📂 src")) && plainTab.rows().some((row) => row.includes("📄 index.ts")));
	assert.ok(!plainTab.raw().join("").includes("\x1b[38;2;"), "no 24-bit colors");
});

test("git badges: M and ? on files, ● on folders holding a change, read from git status --porcelain=v1", async (t) => {
	const git = STATUS(" M src/index.ts\n?? docs/guide.md\nA  src/lib/util.ts\n");
	const { tab, rows, raw, calls } = await opened({ cwd: project(FILES), git });
	t.after(() => tab.dispose());
	assert.ok(calls.git.some((args) => args.includes("status") && args.includes("--porcelain=v1")));
	const row = (name) => rows().find((line) => line.includes(` ${name}`));
	assert.match(row("index.ts"), /index\.ts +M │$/);
	assert.match(row("docs"), /docs \(1 items\) +● │$/);
	assert.match(row("src"), /src \(2 items\) +● │$/);
	assert.match(row("lib"), /lib \(2 items\) +● │$/);
	assert.doesNotMatch(row("README.md"), /[M?●] │$/);
	const index = raw().find((line) => plain(line).includes("index.ts"));
	assert.ok(painted(index, "warning", "M"), "M in the warning color");
	assert.ok(painted(index, "warning", "index.ts"), "the modified name too");
	assert.ok(painted(raw().find((line) => plain(line).includes(" docs")), "warning", "●"));
});

test("an untracked folder, a rename and a subfolder session map onto the tree", () => {
	const parsed = parseGitStatus('?? new/\nR  old.ts -> app/moved.ts\n M "app/with space.ts"\n M other/x.ts\n', "app/");
	assert.equal(parsed.status("moved.ts"), "modified", "a rename, at its new path");
	assert.equal(parsed.status("with space.ts"), "modified");
	assert.equal(parsed.status("x.ts"), undefined, "outside the session's folder");
	const top = parseGitStatus("?? new/\n", "");
	assert.equal(top.status("new/inner/file.ts"), "untracked", "inside an untracked folder");
	assert.ok(top.dirty("new"));
	assert.ok(!top.dirty("other"));
});

test("an empty project, no directory and an unreadable directory draw a short message", async (t) => {
	const empty = await opened({ cwd: project([]), git: STATUS("") });
	t.after(() => empty.tab.dispose());
	assert.match(empty.rows()[3], /No files in the project/);

	const none = fakeHost({ cwd: undefined });
	const tab = createTab(none.host);
	tab.onShow();
	assert.match(tab.render(59, 10).map(plain)[3], /No project folder/);
	tab.dispose();

	const missing = await opened({ cwd: path.join(os.tmpdir(), "gq-tree-does-not-exist-" + Date.now()), git: STATUS(undefined) });
	t.after(() => missing.tab.dispose());
	assert.match(missing.rows()[3], /Cannot read the folder: ENOENT/);
	assert.ok(missing.rows().every((row) => [...row].length === 59));
});

test("no repository, a missing git or a timeout leave the tree without badges and a dim note", async (t) => {
	const { tab, rows, raw } = await opened({ cwd: project(FILES), git: {} });
	t.after(() => tab.dispose());
	await until(() => rows()[2].includes("git status unavailable"), "the git note");
	assert.ok(painted(raw()[2], "dim", "git status unavailable"));
	assert.ok(rows().some((row) => row.includes("index.ts")), "the tree still draws");
	assert.ok(!rows().slice(3).some((row) => /[M?●] │$/.test(row)));

	const throwing = fakeHost({ cwd: project(FILES), git: () => Promise.reject(new Error("spawn git ENOENT")) });
	const other = createTab(throwing.host);
	t.after(() => other.dispose());
	other.onShow();
	await until(() => other.render(59, 20).map(plain).some((row) => row.includes("index.ts")));
	assert.doesNotThrow(() => other.render(59, 20));
});

test("a click on a folder toggles it and asks for a redraw", async (t) => {
	const { tab, rows, calls } = await opened({ cwd: project(FILES), git: STATUS("") });
	t.after(() => tab.dispose());
	const line = (name) => rows().findIndex((row) => row.includes(` ${name} (`));
	const before = calls.renders;
	assert.equal(tab.handleClick(line("docs"), "left", 10), true);
	assert.ok(calls.renders > before);
	await until(() => rows().some((row) => row.includes("guide.md")), "docs expanded");
	assert.match(rows()[line("docs")], /📂 docs/);
	assert.equal(tab.handleClick(line("src"), "left", 10), true);
	await until(() => !rows().some((row) => row.includes("index.ts")), "src collapsed");
	assert.match(rows()[line("src")], /📁 src/);
});

// A Pi context whose ui.custom records the overlays it is asked for.
function overlayCtx() {
	const overlays = [];
	return { overlays, hasUI: true, ui: { custom: (factory, options) => (overlays.push({ factory, options }), new Promise(() => {})) } };
}
const fakeTui = { terminal: { rows: 30, columns: 120 }, requestRender() {} };

test("a click on a file opens the read-only preview, not the editor, and marks the file", async (t) => {
	const launches = recordLaunches(t);
	const root = project(FILES);
	writeFileSync(path.join(root, "README.md"), "# Demo\nhello\n");
	const ctx = overlayCtx();
	const { tab, rows, raw } = await opened({ cwd: root, git: STATUS(""), ctx });
	t.after(() => tab.dispose());
	const line = rows().findIndex((row) => row.includes("README.md"));
	assert.equal(tab.handleClick(line, "left", 12), true);
	assert.equal(launches.length, 0, "no editor tab");
	assert.equal(ctx.overlays.length, 1);
	assert.equal(ctx.overlays[0].options.overlay, true);
	assert.ok(painted(raw()[line], "accent", theme.bold("README.md")), "the clicked file in accent bold");

	const closed = [];
	const preview = ctx.overlays[0].factory(fakeTui, theme, {}, (value) => closed.push(value));
	await preview.ready;
	const out = preview.render(70).map(plain);
	assert.match(out[1], /Read-only — Markdown/);
	assert.match(out[2], /README\.md/);
	assert.match(out[4], /^▏ Demo +▕$/, "the Markdown rendered");
	preview.handleInput("e");
	assert.equal(closed.length, 1, "e closes the preview");
	assert.deepEqual(launches.at(-1), [path.join(root, "README.md"), root], "and opens the file as a click did before");
});

test("the header row or the badge opens the editor on the project, a folder still toggles, with an overlay UI", async (t) => {
	const launches = recordLaunches(t);
	const root = project(FILES);
	const ctx = overlayCtx();
	const { tab, rows } = await opened({ cwd: root, git: STATUS(""), ctx });
	t.after(() => tab.dispose());
	const badgeX = rows()[1].indexOf("[ ↗");
	assert.equal(tab.handleClick(1, "left", badgeX + 2), true, "the badge");
	assert.deepEqual(launches.at(-1), [undefined, root]);
	assert.equal(tab.handleClick(0, "left", 3), true, "the top row");
	assert.equal(tab.handleClick(1, "left", 3), true, "the title");
	assert.equal(launches.length, 3);
	assert.equal(tab.handleClick(2, "left", 3), false, "the blank row under the header does nothing");
	assert.equal(tab.handleClick(rows().length - 1, "left", 3), false, "the bottom border does nothing");
	const docs = rows().findIndex((row) => row.includes(" docs ("));
	assert.equal(tab.handleClick(docs, "left", 10), true);
	await until(() => rows().some((row) => row.includes("guide.md")), "docs expanded");
	assert.equal(ctx.overlays.length, 0, "no preview for folders or the header");
});

test("without an overlay UI a click on a file opens it in the editor as before", async (t) => {
	const launches = recordLaunches(t);
	const root = project(FILES);
	const { tab, rows, raw } = await opened({ cwd: root, git: STATUS(""), ctx: { hasUI: false, ui: { custom: () => assert.fail("no overlay") } } });
	t.after(() => tab.dispose());
	const line = rows().findIndex((row) => row.includes("README.md"));
	assert.equal(tab.handleClick(line, "left", 12), true);
	assert.deepEqual(launches.at(-1), [path.join(root, "README.md"), root]);
	assert.ok(painted(raw()[line], "accent", theme.bold("README.md")), "the opened file in accent bold");
});

test("an editor that fails to open shows a short warning instead of throwing", async (t) => {
	const launches = recordLaunches(t);
	launches.failWith = "no terminal found (set $TERMINAL)";
	const { tab, rows, raw } = await opened({ cwd: project(FILES), git: STATUS("") });
	t.after(() => tab.dispose());
	assert.equal(tab.handleClick(1, "left", 3), true);
	await until(() => rows()[2].includes("no terminal found"), "the warning");
	assert.ok(painted(raw()[2], "warning"));
});

test("right click closes every open folder, and with none open it opens them all (cute's toggle)", async (t) => {
	const { tab, rows } = await opened({ cwd: project(FILES), git: STATUS("") });
	t.after(() => tab.dispose());
	assert.equal(tab.handleClick(5, "right", 4), true, "src is open: close all");
	await until(() => !rows().some((row) => row.includes("index.ts")), "everything collapsed");
	assert.ok(rows().some((row) => row.includes("📁 src")));
	assert.equal(tab.handleClick(5, "right", 4), true, "none open: open all");
	await until(() => rows().some((row) => row.includes("a.ts")), "everything expanded");
	assert.ok(rows().some((row) => row.includes("guide.md")));
	assert.ok(rows().some((row) => row.includes("📂 deep")), "down to the deepest folder");
	assert.equal(tab.handleClick(5, "middle", 4), false, "the middle button is left alone");
});

test("the wheel scrolls the tree one line at a time and an indicator tells what is hidden", async (t) => {
	const many = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`);
	const { tab, rows } = await opened({ cwd: project(many), git: STATUS("") }, 59, 16);
	t.after(() => tab.dispose());
	assert.equal(rows().length, 16);
	const first = () => rows()[3];
	assert.match(first(), /f00\.txt/);
	assert.match(rows().at(-2), /▼ \d+ below/);
	assert.equal(tab.handleWheel(1, 5, 4), true);
	assert.match(first(), /f01\.txt/);
	assert.match(rows().at(-2), /▲ 1 above · ▼ \d+ below/);
	assert.equal(tab.handleWheel(-3, 5, 4), true);
	assert.match(first(), /f00\.txt/, "one line per wheel event, whatever the delta");
	assert.equal(tab.handleWheel(-1, 5, 4), false, "nothing above");
	for (let i = 0; i < 40; i++) tab.handleWheel(1, 5, 4);
	assert.match(rows().at(-3), /f29\.txt/, "stops at the end");
	const line = rows().findIndex((row) => row.includes("f29.txt"));
	const launches = recordLaunches(t);
	tab.handleClick(line, "left", 10);
	assert.match(launches.at(-1)[0], /f29\.txt$/, "clicks follow the scrolled rows");
});

test("a project that fits does not take the wheel", async (t) => {
	const { tab } = await opened({ cwd: project(["a.txt"]), git: STATUS("") });
	t.after(() => tab.dispose());
	assert.equal(tab.handleWheel(1, 4, 4), false);
});

test("with the outline off the rows are indented and clicks still find their row", async (t) => {
	const launches = recordLaunches(t);
	const root = project(FILES);
	const { tab, rows } = await opened({ cwd: root, git: STATUS(""), border: false });
	t.after(() => tab.dispose());
	assert.match(rows()[0], /^ ⌂ PROYECTO/);
	const line = rows().findIndex((row) => row.includes("README.md"));
	tab.handleClick(line, "left", 8);
	assert.deepEqual(launches.at(-1), [path.join(root, "README.md"), root]);
});

test("the tree rescans on its own while shown and redraws when the files change", async (t) => {
	const saved = treeTiming.rescanMs;
	treeTiming.rescanMs = 20;
	t.after(() => (treeTiming.rescanMs = saved));
	let status = "";
	const root = project(FILES);
	const { tab, rows } = await opened({ cwd: root, git: { "rev-parse": "\n", status: () => status } });
	t.after(() => tab.dispose());
	writeFileSync(path.join(root, "src", "added.ts"), "x");
	status = "?? src/added.ts\n";
	await until(() => rows().some((row) => /added\.ts +\? │$/.test(row)), "the new file with its badge");
});

test("render stays synchronous and cheap: repeated frames do not rescan", async (t) => {
	const { tab, calls } = await opened({ cwd: project(FILES), git: STATUS("") });
	t.after(() => tab.dispose());
	const count = calls.git.length;
	for (let i = 0; i < 20; i++) tab.render(59, 30);
	assert.equal(calls.git.length, count);
	tab.invalidate?.();
	assert.doesNotThrow(() => tab.render(59, 30));
});

test("scanTree reads at most five levels below the root and counts the items of closed folders", async () => {
	const root = project(["a/b/c/d/e/f/g/deep.txt", "a/x.txt"]);
	const open = await scanTree(root);
	let node = open[0];
	let depth = 0;
	while (node?.children?.length) {
		node = node.children.find((child) => child.isDirectory) ?? node.children[0];
		depth++;
	}
	assert.equal(depth, 5, "the folders five levels down are counted, not read");
	const closed = await scanTree(root, new Set());
	assert.equal(closed[0].children, undefined);
	assert.equal(closed[0].itemCount, 2);
	const rows = flattenTree(open, new Set(["a"]));
	assert.deepEqual(rows.map((row) => row.prefix), ["└── ", "    ├── ", "    └── "]);
	await assert.rejects(scanTree(path.join(root, "missing")), /ENOENT/);
});

// The launcher with every process call faked.
function fakeProcesses(t, { env = {}, executables = [], herdr } = {}) {
	const saved = { ...launchDeps };
	const spawned = [];
	launchDeps.env = env;
	launchDeps.executable = async (name) => executables.includes(name);
	launchDeps.spawn = (bin, args, options) => {
		const child = new EventEmitter();
		child.unref = () => {};
		spawned.push({ bin, args, options });
		queueMicrotask(() => (executables.includes(bin) ? child.emit("spawn") : child.emit("error", Object.assign(new Error(`spawn ${bin} ENOENT`), { code: "ENOENT" }))));
		return child;
	};
	launchDeps.execFile = async (bin, args) => {
		spawned.push({ bin, args });
		if (!herdr) throw new Error("herdr ENOENT");
		return herdr(args);
	};
	t.after(() => Object.assign(launchDeps, saved));
	return spawned;
}

test("inside herdr the editor opens in a new focused herdr tab", async (t) => {
	const spawned = fakeProcesses(t, {
		env: { HERDR_ENV: "1", EDITOR: "nvim" },
		herdr: (args) => (args[0] === "tab" ? JSON.stringify({ result: { root_pane: { pane_id: "p7" } } }) : ""),
	});
	assert.equal(await launchEditor("/srv/app/it's.ts", "/srv/app"), undefined);
	assert.deepEqual(spawned[0].args, ["tab", "create", "--cwd", "/srv/app", "--label", "nvim: it's.ts", "--focus"]);
	assert.deepEqual(spawned[1].args, ["pane", "run", "p7", "nvim '/srv/app/it'\\''s.ts'"]);
});

test("outside herdr, or when herdr fails, the editor opens in a detached terminal", async (t) => {
	const spawned = fakeProcesses(t, { env: { HERDR_ENV: "1", VISUAL: "hx" }, executables: ["alacritty"], herdr: () => "not json" });
	assert.equal(await launchEditor(undefined, "/srv/app"), undefined);
	const term = spawned.at(-1);
	assert.equal(term.bin, "alacritty");
	assert.deepEqual(term.args, ["--class", "cute-editor,cute-editor", "-t", "CUTE: app", "-e", "hx", "/srv/app"]);
	assert.equal(term.options.detached, true);
	assert.equal(term.options.cwd, "/srv/app");
});

test("$TERMINAL wins, and a missing terminal or editor binary comes back as a short message", async (t) => {
	let spawned = fakeProcesses(t, { env: { TERMINAL: "foot" }, executables: ["foot", "kitty"] });
	assert.equal(await launchEditor("/p/a.ts", "/p"), undefined);
	assert.deepEqual(spawned.at(-1).args, ["--app-id=cute-editor", "-T", "CUTE: a.ts", "nvim", "/p/a.ts"]);

	fakeProcesses(t, { env: {}, executables: [] });
	assert.equal(await launchEditor("/p/a.ts", "/p"), "no terminal found (set $TERMINAL)");

	fakeProcesses(t, { env: { TERMINAL: "weirdterm" }, executables: ["weirdterm-not"] });
	launchDeps.executable = async () => true;
	assert.match(await launchEditor("/p/a.ts", "/p"), /could not open weirdterm: spawn weirdterm ENOENT/);
});
