// The GIT tab of gentle-quiet's side column (the contract is in ./tabs.ts), after pi-cinlodev-cute's Git tab
// (src/git/git-graph-card.ts, git-working-tree-card.ts): two cards splitting the height 50/50.
//
// - Top, "⎇ Git": the branch with its status badges, the ASCII commit graph (git log --graph, 20 commits) and
//   the changes row; "[ Graph | Branches ]" in its title switches to the branch list (ahead/behind, gone, age).
// - Bottom, "Working tree": the changed files with a status badge and +n −n. A click on a branch in the list
//   turns it into the branch diff inspector, "Diff · <branch>", with [ ✕ ] to close it.
//
// A left click on a file opens its read-only preview over Pi (./tree-preview.ts; e there opens the editor:
// $VISUAL, $EDITOR, nvim). No diff opens in a tab of its own: the preview is where a file is looked at. The
// editor opens in a herdr tab inside herdr, else in a detached terminal (./git-launch.ts). A click on a card's
// title folds it to one summary row. The wheel scrolls a card whose rows do not fit its half.
// @ts-nocheck

import path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SidebarHost, SidebarTab } from "./tabs.ts";
import { createGitData, statusCounts } from "./git-data.ts";
import { openInEditor } from "./git-launch.ts";
import { openPreview } from "./tree-preview.ts";

const GAP = 1; // blank rows between the two cards
const MIN_HEIGHT = 14; // under this the cards keep it and the column scrolls, as cute's
const SCROLL_STEP = 2;
const COMPACT_WIDTH = 38; // narrower columns get "[ G | B ]"

const FILE_BADGES = {
	modified: ["warning", "M"],
	added: ["success", "A"],
	deleted: ["error", "D"],
	renamed: ["accent", "R"],
	untracked: ["accent", "U"], // as VS Code and Neo-tree mark them
	conflict: ["error", "!"],
};

/** One row of a card: `left` cut to fit, `right` against the right edge; `hit` is what a click on it does. */
function fitRow(row, inner) {
	const right = row.right ?? "";
	const rightWidth = visibleWidth(right);
	const room = Math.max(0, inner - (rightWidth ? rightWidth + 1 : 0));
	const left = visibleWidth(row.left ?? "") > room ? truncateToWidth(row.left, room, "…") : (row.left ?? "");
	if (!rightWidth) return { text: left, rightAt: inner };
	const gap = Math.max(1, inner - visibleWidth(left) - rightWidth);
	return { text: `${left}${" ".repeat(gap)}${right}`, rightAt: visibleWidth(left) + gap };
}

export function createTab(host: SidebarHost): SidebarTab {
	const data = createGitData(host);
	const state = { view: "graph", selected: null, folded: { graph: false, tree: false }, scroll: { graph: 0, tree: 0, diff: 0 } };
	let drawn = { cards: [], hits: new Map() }; // what the last render put where, for the mouse
	let root; // the repository's top folder: git paths are relative to it

	const c = (role, text) => host.fg(role, text);
	const title = (text) => c("toolTitle", host.bold(text));
	const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
	const deltas = (added, deleted, sep = "  ") => (added || deleted ? `${c("toolDiffAdded", `+${added}`)}${sep}${c("toolDiffRemoved", `−${deleted}`)}` : "");
	const button = (label, role) => `${c("dim", "[")} ${c(role, label)} ${c("dim", "]")}`;

	// Everything the current view needs, from the caches; asking for it starts the stale reads.
	const snapshot = () => {
		const cwd = host.cwd();
		if (!cwd) return { cwd };
		const repo = data.repo(cwd);
		if (!repo?.ok) return { cwd, repo };
		root = repo.root;
		return {
			cwd,
			repo,
			graph: data.graph(cwd),
			status: data.status(cwd),
			branches: state.view === "branches" && !state.folded.graph ? data.branches(cwd, repo.branch) : undefined,
			diff: state.selected ? data.diff(cwd, repo.branch, state.selected) : undefined,
		};
	};

	const badges = (status) => {
		if (!status?.files) return "";
		const counts = statusCounts(status.files);
		if (counts.clean) return c("success", "✔ clean");
		return [
			counts.conflicts && c("error", `✖ ${counts.conflicts} conflict`),
			counts.modified && c("warning", `● ${counts.modified} mod`),
			counts.staged && c("success", `+${counts.staged} staged`),
			counts.untracked && c("accent", `?${counts.untracked} untracked`),
		]
			.filter(Boolean)
			.join(c("dim", " · "));
	};

	// A `git log --graph --oneline --decorate` row in theme roles, as cute colors it.
	const colorGraph = (line) => {
		if (/^[\\/|_\s]+$/.test(line)) return line.replace(/[\\/|_]+/g, (edge) => c("muted", edge));
		const m = /^([*\\/|_\s]*\*[*\\/|_\s]*)\s+([0-9a-f]{7,40})\s*(?:\(([^)]+)\))?\s*(.*)$/.exec(line);
		if (!m) return line.replace(/^[*\\/|_\s]+/, (graph) => graph.replace(/\*|[\\/|_]+/g, (part) => c(part === "*" ? "accent" : "muted", part)));
		const [, graph, hash, refs, subject] = m;
		const edges = graph.replace(/\*|[\\/|_]+/g, (part) => c(part === "*" ? "accent" : "muted", part));
		const ref = (name) => c(name.includes("HEAD") ? "success" : name.startsWith("tag:") ? "warning" : name.includes("/") ? "muted" : "accent", name);
		const decorated = refs ? ` ${c("dim", "(")}${refs.split(",").map((name) => ref(name.trim())).join(c("dim", ", "))}${c("dim", ")")}` : "";
		return `${edges} ${c("warning", hash)}${decorated}${subject ? ` ${c("text", subject)}` : ""}`;
	};

	// Cute's changes row: the status line's uncommitted changes, or the status counts when they are not read yet.
	const changesRow = (status) => {
		const changes = host.changes?.();
		let files = changes?.files ?? 0;
		let added = changes?.added ?? 0;
		let deleted = changes?.deleted ?? 0;
		if (!changes && status?.files) {
			const counts = statusCounts(status.files);
			files = counts.staged + counts.modified;
			added = counts.added;
			deleted = counts.deleted;
		}
		if (!files || (!added && !deleted)) return undefined;
		return `${c("accent", "✎")} ${plural(files, "file", "files")} · ${deltas(added, deleted, " ")}`;
	};

	const fileRow = (file) => {
		const [role, letter] = FILE_BADGES[file.status] ?? FILE_BADGES.modified;
		const slash = file.path.lastIndexOf("/");
		const name = slash < 0 ? c("text", file.path) : `${c("dim", file.path.slice(0, slash + 1))}${c("text", file.path.slice(slash + 1))}`;
		const right = [file.added > 0 && c("toolDiffAdded", `+${file.added}`), file.deleted > 0 && c("toolDiffRemoved", `−${file.deleted}`)];
		return { left: `${c(role, letter)}  ${name}`, right: right.filter(Boolean).join(" "), hit: { kind: "file", path: file.path } };
	};

	// The top card: title with the view toggle, then the graph or the branch list (or one summary row, folded).
	const graphCard = (snap, width) => {
		const { repo, graph, status, branches } = snap;
		const compact = width < COMPACT_WIDTH;
		const toggle = compact ? "[ G | B ]" : "[ Graph | Branches ]";
		const label = (text, view) => (state.view === view ? c("accent", host.bold(text)) : c("dim", text));
		const styledToggle = `${c("dim", "[")} ${label(compact ? "G" : "Graph", "graph")} ${c("dim", "|")} ${label(compact ? "B" : "Branches", "branches")} ${c("dim", "]")}`;
		const bar = toggle.indexOf("|");
		const head = [
			{
				left: title([host.icons?.branch, "Git"].filter(Boolean).join(" ")),
				right: state.folded.graph ? "" : styledToggle,
				hit: { kind: "title", card: "graph", buttons: state.folded.graph ? [] : [{ from: 0, to: bar, action: "graph" }, { from: bar + 1, to: toggle.length, action: "branches" }] },
			},
			{ left: "" },
		];
		if (state.folded.graph) {
			const first = /^[*\\/|_\s]*([0-9a-f]{7,40})(?:\s*\([^)]*\))?\s*(.*)$/.exec(graph?.lines?.[0] ?? "");
			const commit = first ? [first[1], first[2]].filter(Boolean).join(" ") : "no commits";
			return { head, body: [{ left: `${c("text", repo.branch)} ${c("dim", "·")} ${c("muted", commit)}`, right: badges(status) }] };
		}
		if (state.view === "branches") {
			if (!branches) return { head, body: [{ left: c("dim", "Reading branches…") }] };
			const body = [{ left: `${c("warning", `● ${branches.branches.length}`)} ${c("dim", branches.branches.length === 1 ? "branch" : "branches")}`, right: badges(status) }];
			for (const branch of branches.branches) {
				const selected = branch.name === state.selected;
				const role = branch.current ? "success" : selected ? "accent" : branch.remote ? "muted" : "text";
				const mark = branch.current ? c("success", "●") : selected ? c("accent", "▶") : c("dim", "●");
				const right = branch.current
					? [c("success", "current")]
					: selected
						? [c("accent", "diff")]
						: [branch.ahead > 0 && c("warning", `↑${branch.ahead}`), branch.behind > 0 && c("error", `↓${branch.behind}`), branch.gone && c("error", "gone")].filter(Boolean);
				if (!right.length && branch.date) right.push(c("dim", branch.date));
				body.push({ left: `${mark} ${c(role, branch.name)}`, right: right.join(" "), hit: { kind: "branch", name: branch.name } });
			}
			return { head, body };
		}
		const body = [{ left: c("text", repo.branch), right: badges(status) }, { left: "" }];
		if (!graph) body.push({ left: c("dim", "Reading log…") });
		else if (!graph.lines.length) body.push({ left: c("muted", "No commits yet") });
		else body.push(...graph.lines.map((line) => ({ left: colorGraph(line) })));
		const changes = changesRow(status);
		if (changes) body.push({ left: "" }, { left: changes });
		return { head, body };
	};

	// The bottom card: the working tree, or the diff of the selected branch.
	const treeCard = (snap, inner) => {
		const divider = { left: c("border", "─".repeat(Math.max(0, inner))) };
		if (state.selected) {
			const head = [
				{
					left: `${title("Diff")} ${c("dim", "·")} ${c("accent", state.selected)}`,
					right: button("✕", "error"),
					hit: { kind: "title", card: "diff", buttons: [{ from: 0, to: 5, action: "close" }] },
				},
				{ left: "" },
			];
			const diff = snap.diff;
			if (!diff) return { key: "diff", head, body: [{ left: c("dim", "Reading diff…") }] };
			const body = [{ left: `${c("warning", `● ${diff.files.length}`)} ${c("dim", diff.files.length === 1 ? "file" : "files")}`, right: deltas(diff.added, diff.deleted) }];
			body.push(divider);
			if (!diff.files.length) body.push({ left: `${c("success", "✔")} ${c("success", "No differences with HEAD")}` });
			body.push(...diff.files.map((file) => fileRow(file)));
			return { key: "diff", head, body };
		}
		const head = [{ left: `${title("Working tree")} ${c("dim", state.folded.tree ? "▼" : "▲")}`, hit: { kind: "title", card: "tree", buttons: [] } }, { left: "" }];
		const status = snap.status;
		if (!status) return { key: "tree", head, body: [{ left: c("dim", "Reading status…") }] };
		if (status.error) return { key: "tree", head, body: [{ left: c("muted", "Status unavailable") }] };
		if (!status.files.length) return { key: "tree", head, body: [{ left: `${c("success", "✔ Clean")} ${c("dim", "· No pending changes")}` }] };
		const counts = statusCounts(status.files);
		if (state.folded.tree) {
			return { key: "tree", head, body: [{ left: `${c("warning", `● ${status.files.length}`)} ${c("dim", status.files.length === 1 ? "file" : "files")}`, right: deltas(counts.added, counts.deleted, " ") }] };
		}
		const body = [{ left: `${c("warning", `● ${status.files.length}`)} ${c("dim", status.files.length === 1 ? "file changed" : "files changed")}`, right: deltas(counts.added, counts.deleted) }, divider];
		body.push(...status.files.map((file) => fileRow(file)));
		return { key: "tree", head, body };
	};

	// A card `total` rows high (outline included); its body scrolls when it does not fit, with cute's marker.
	const drawCard = (key, card, total, width, start, out) => {
		const inner = host.inner(width);
		const chrome = host.box([], width).length; // 2 with the outline, 0 without
		const xPad = chrome ? Math.floor((width - inner) / 2) : width - inner;
		const room = Math.max(card.head.length + 1, total - chrome);
		const bodyRoom = room - card.head.length;
		let shown = card.body;
		let maxScroll = 0;
		let marker;
		if (card.body.length > bodyRoom) {
			const visible = Math.max(1, bodyRoom - 1);
			maxScroll = card.body.length - visible;
			const top = (state.scroll[key] = Math.max(0, Math.min(state.scroll[key] ?? 0, maxScroll)));
			shown = card.body.slice(top, top + visible);
			const arrow = (on, glyph) => c(on ? "accent" : "dim", glyph);
			marker = { left: c("dim", "wheel to scroll"), right: `${c("dim", "[")} ${arrow(top > 0, "▲")} ${c("dim", `${top + 1}..${top + shown.length}/${card.body.length}`)} ${arrow(top < maxScroll, "▼")} ${c("dim", "]")}` };
		} else state.scroll[key] = 0;
		const rows = [...card.head, ...shown, ...(marker ? [marker] : [])];
		while (rows.length < room) rows.push({ left: "" });
		const fitted = rows.map((row) => fitRow(row, inner));
		const boxed = host.box(fitted.map((row) => row.text), width);
		const offset = chrome ? 1 : 0;
		rows.forEach((row, i) => {
			if (row.hit) drawn.hits.set(start + offset + i, { ...row.hit, xPad, rightAt: fitted[i].rightAt });
		});
		drawn.cards.push({ key, start, end: start + boxed.length, maxScroll });
		out.push(...boxed);
	};

	const message = (text, width) => {
		drawn = { cards: [], hits: new Map() };
		return host.card([host.icons?.branch, "Git"].filter(Boolean).join(" "), [text], width);
	};

	const render = (width, height) => {
		const snap = snapshot();
		if (!snap.cwd) return message(c("muted", "No working directory"), width);
		if (!snap.repo) return message(c("dim", "Reading git…"), width);
		if (!snap.repo.ok) return message(c("muted", "Not a git repository (or git is not available)"), width);
		drawn = { cards: [], hits: new Map() };
		const chrome = host.box([], width).length;
		const folded = chrome + 3; // title, blank, summary
		const avail = Math.max(MIN_HEIGHT, height - GAP);
		const graphFolded = state.folded.graph;
		const treeFolded = state.folded.tree && !state.selected;
		let top = Math.floor(avail / 2);
		let bottom = avail - top;
		if (graphFolded) top = folded;
		if (treeFolded) bottom = folded;
		if (graphFolded && !treeFolded) bottom = avail - folded;
		if (treeFolded && !graphFolded) top = avail - folded;
		const out = [];
		drawCard("graph", graphCard(snap, width), top, width, 0, out);
		for (let i = 0; i < GAP; i++) out.push("");
		const tree = treeCard(snap, host.inner(width));
		drawCard(tree.key, tree, bottom, width, out.length, out);
		return out;
	};

	const act = (hit, button, x) => {
		const local = x - hit.xPad;
		const onButton = (hit.buttons ?? []).find((b) => local - hit.rightAt >= b.from && local - hit.rightAt < b.to);
		if (hit.kind === "title") {
			if (button !== "left") return false;
			if (onButton?.action === "graph" || onButton?.action === "branches") {
				state.view = onButton.action;
				state.scroll.graph = 0;
			} else if (onButton?.action === "close") {
				state.selected = null;
				state.scroll.diff = 0;
			} else if (hit.card === "graph" || hit.card === "tree") {
				state.folded[hit.card] = !state.folded[hit.card];
			} else return false;
			return true;
		}
		if (hit.kind === "branch") {
			if (button !== "left") return false;
			const current = snapshot().repo?.branch;
			state.selected = hit.name === current || hit.name === state.selected ? null : hit.name;
			state.scroll.diff = 0;
			return true;
		}
		if (hit.kind === "file" && root) {
			if (button !== "left") return false;
			// The read-only preview pop-up, as in TREE; e there, or a Pi without overlays, opens the editor.
			const file = path.join(root, hit.path);
			const edit = () => openInEditor(file, root);
			if (!openPreview(host.ctx?.(), { file, relPath: hit.path, onEdit: edit })) edit();
			return true;
		}
		return false;
	};

	return {
		id: "git",
		render,
		handleClick(line, button, x) {
			const hit = drawn.hits.get(line);
			if (!hit) return false;
			const acted = act(hit, button, x);
			if (acted) snapshot(); // start the reads the new view needs
			return acted;
		},
		handleWheel(delta, line) {
			const card = drawn.cards.find((card) => line >= card.start && line < card.end);
			if (!card || card.maxScroll <= 0 || !delta) return false;
			state.scroll[card.key] = Math.max(0, Math.min(card.maxScroll, (state.scroll[card.key] ?? 0) + (delta > 0 ? SCROLL_STEP : -SCROLL_STEP)));
			return true;
		},
		onShow() {
			data.refresh();
			snapshot();
		},
		dispose() {
			data.dispose();
		},
	};
}
