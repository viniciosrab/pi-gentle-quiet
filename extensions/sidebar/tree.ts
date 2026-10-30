// The TREE tab of gentle-quiet's side column (the contract is in ./tabs.ts), after pi-cinlodev-cute's
// project explorer (src/tree/tree-card.ts): one card filling the column, headed "⌂ PROYECTO · <project>
// ══ [ ↗ nvim ]" in the card title style, then the project's tree with git badges on the right ("M", "?",
// "A", "U" on files, "●" on folders holding a change). Only src is open at first. The row icons are emoji
// (📁 📂 📄), or with /gentle-quiet's Tree icons on nerd (host.treeIcons), Nerd Font glyphs picked and colored as
// Miguel Solorio's Symbols theme picks its icons (./nerd-icons.ts), one cell wide, each in its own 24-bit color.
//
// Mouse: the header (or its badge) opens the editor on the project; a folder opens or closes; a file opens in
// a read-only preview over Pi (./tree-preview.ts), whose e key opens it in the editor (straight in the editor
// when Pi has no overlay UI); a right click closes every folder, or opens them all when none is open; the wheel scrolls the
// tree one line. The data is read in the background (./tree-scan.ts) when the tab is shown, every 3 s while it
// stays shown, and right after a folder is toggled; render() only draws what was read.
// @ts-nocheck

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import path from "node:path";
import type { SidebarHost, SidebarTab } from "./tabs.ts";
import { editorCommand, launchDeps } from "./tree-launch.ts";
import { nerdIcon } from "./nerd-icons.ts";
import { openPreview } from "./tree-preview.ts";
import { collectDirs, flattenTree, parseGitStatus, projectName, scanTree } from "./tree-scan.ts";

/** How often the tree is read again while shown, and how long a launch failure stays on the card. */
export const treeTiming = { rescanMs: 3000, noticeMs: 8000 };

const ICON = "⌂";
const COMPACT_WIDTH = 38; // cute's: under it the badge is "[ ↗ ]"
const CODE = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
const DATA = new Set(["json", "yaml", "yml", "toml", "lock"]);
const BADGES = { modified: ["warning", "M"], added: ["success", "A"], untracked: ["accent", "?"], conflict: ["error", "U"], deleted: ["error", "D"] };

export function createTab(host: SidebarHost): SidebarTab {
	const state = {
		cwd: undefined,
		noCwd: false,
		name: undefined,
		prefix: undefined,
		tree: undefined,
		error: undefined,
		git: parseGitStatus(""),
		gitFailed: false,
		expanded: new Set(["src"]),
		firstScan: true,
		scroll: 0,
		selected: undefined,
		notice: undefined,
		noticeAt: 0,
		signature: "",
		version: 0,
		flat: undefined,
		flatVersion: -1,
		hits: new Map(), // line -> node
		header: { from: 0, to: 0, blank: -1 },
		capacity: 1,
		scanning: undefined,
		queued: false,
		timer: undefined,
		awaitingRender: false,
		disposed: false,
	};

	const paint = (role, text) => host.fg(role, text);
	// The row's icon and the space after it.
	const icon = (node, open) => {
		if (host.treeIcons !== "nerd") return `${node.isDirectory ? (open ? "📂" : "📁") : "📄"} `;
		const { char, color } = nerdIcon(node.name, { isDirectory: node.isDirectory, open });
		const [r, g, b] = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
		// The glyph is one cell; two spaces start the name where an emoji row (a two-cell emoji and a space) starts it.
		return `\x1b[38;2;${r};${g};${b}m${char}\x1b[39m  `;
	};
	const changed = () => {
		state.version++;
		state.awaitingRender = true;
		host.requestRender();
	};

	const reset = (cwd) => {
		Object.assign(state, { cwd, noCwd: false, name: undefined, prefix: undefined, tree: undefined, error: undefined, git: parseGitStatus(""), gitFailed: false, firstScan: true, scroll: 0, selected: undefined, signature: "" });
		state.expanded = new Set(["src"]);
		state.version++;
	};

	const scan = async () => {
		const cwd = host.cwd();
		if (!cwd) {
			if (!state.noCwd) {
				reset(undefined);
				state.noCwd = true;
				changed();
			}
			return;
		}
		if (cwd !== state.cwd) reset(cwd);
		const quiet = (promise) => Promise.resolve().then(() => promise).catch(() => undefined);
		const [read, status, prefix, name] = await Promise.all([
			scanTree(cwd, state.expanded).then((tree) => ({ tree }), (error) => ({ error })),
			quiet(host.git(["status", "--porcelain=v1"], cwd)),
			state.prefix ?? quiet(host.git(["rev-parse", "--show-prefix"], cwd)),
			state.name ?? projectName(cwd).catch(() => path.basename(cwd)),
		]);
		if (state.disposed || cwd !== state.cwd) return;
		state.name = name;
		if (typeof prefix === "string") state.prefix = prefix.trim();
		state.tree = read.tree;
		state.error = read.error;
		if (state.firstScan && read.tree) {
			state.firstScan = false;
			if (!read.tree.some((node) => node.isDirectory && node.relPath === "src")) state.expanded.delete("src");
		}
		state.gitFailed = typeof status !== "string";
		state.git = parseGitStatus(status ?? "", state.prefix ?? "");
		const shape = (nodes) => (nodes ?? []).map((node) => [node.relPath, node.itemCount, shape(node.children)]);
		const signature = JSON.stringify([name, read.error?.code ?? read.error?.message, shape(read.tree), status ?? null]);
		if (signature !== state.signature) {
			state.signature = signature;
			changed();
		}
	};

	// One read at a time; a request while one runs reads again right after it.
	const refresh = () => {
		if (state.disposed) return Promise.resolve();
		if (state.scanning) {
			state.queued = true;
			return state.scanning;
		}
		state.scanning = scan()
			.catch(() => undefined)
			.finally(() => {
				state.scanning = undefined;
				if (state.queued) {
					state.queued = false;
					refresh();
				}
			});
		return state.scanning;
	};

	// The tab cannot see itself hidden, so the timer stops when a redraw it asked for never came.
	const tick = () => {
		if (state.awaitingRender) {
			clearInterval(state.timer);
			state.timer = undefined;
			return;
		}
		refresh();
	};

	const toggled = () => {
		state.version++;
		host.requestRender();
		refresh();
	};

	const launch = (target) => {
		const cwd = state.cwd;
		if (!cwd) return;
		let pending;
		try {
			pending = launchDeps.launch(target, cwd);
		} catch (error) {
			pending = Promise.reject(error);
		}
		Promise.resolve(pending)
			.catch((error) => error?.message ?? String(error))
			.then((problem) => {
				if (state.disposed) return;
				state.notice = problem || undefined;
				state.noticeAt = Date.now();
				if (problem) host.requestRender();
			});
	};

	const toggleAll = () => {
		if (state.expanded.size > 0) {
			state.expanded.clear();
			toggled();
			return;
		}
		const cwd = state.cwd;
		if (!cwd) return;
		scanTree(cwd)
			.then((tree) => {
				if (state.disposed || cwd !== state.cwd) return;
				state.expanded = collectDirs(tree);
				toggled();
			})
			.catch(() => undefined);
	};

	const flat = () => {
		if (state.flatVersion !== state.version || !state.flat) {
			state.flat = flattenTree(state.tree ?? [], state.expanded);
			state.flatVersion = state.version;
		}
		return state.flat;
	};

	// `left` cut to leave room for `right`, which sits against the right edge of `inner` columns.
	const spread = (left, right, inner) => {
		const room = Math.max(0, inner - (right ? visibleWidth(right) + 1 : 0));
		const cut = visibleWidth(left) > room ? truncateToWidth(left, room, "…") : left;
		return `${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut) - visibleWidth(right)))}${right}`;
	};

	const headerRow = (width, inner) => {
		const label = editorCommand().label;
		const compact = width < COMPACT_WIDTH;
		const badge = compact ? `${paint("dim", "[")} ${paint("accent", "↗")} ${paint("dim", "]")}` : `${paint("dim", "[")} ${paint("accent", "↗")} ${paint("toolTitle", label)} ${paint("dim", "]")}`;
		const badgeWidth = visibleWidth(compact ? "[ ↗ ]" : `[ ↗ ${label} ]`);
		const room = inner - badgeWidth - 3; // a space, at least one "═", a space
		const prefix = `${ICON} PROYECTO · `;
		let title = "";
		if (room >= 18) {
			const name = state.name ?? path.basename(state.cwd ?? "") ?? "";
			const space = room - visibleWidth(prefix);
			title = `${prefix}${visibleWidth(name) > space ? truncateToWidth(name, space, "…") : name}`;
		} else if (room >= 11) title = `${ICON} PROYECTO`;
		else if (room >= 6) title = `${ICON} TREE`;
		else if (room >= 1) title = ICON;
		const lead = title ? `${paint("toolTitle", host.bold(title))} ` : "";
		const fill = Math.max(1, inner - visibleWidth(title) - (title ? 1 : 0) - badgeWidth - 1);
		return spread(`${lead}${paint("border", "═".repeat(fill))}`, badge, inner);
	};

	const fileRow = (row, inner) => {
		const node = row.node;
		const guides = paint("dim", row.prefix);
		if (node.isDirectory) {
			const open = state.expanded.has(node.relPath);
			const dirty = state.git.dirty(node.relPath);
			const name = paint(dirty ? "warning" : "accent", node.name);
			const count = typeof node.itemCount === "number" ? paint("dim", ` (${node.itemCount} items)`) : "";
			return spread(`${guides}${icon(node, open)}${name}${count}`, dirty ? paint("warning", "●") : "", inner);
		}
		const status = state.git.status(node.relPath);
		const [role, mark] = BADGES[status] ?? [CODE.has(node.extension) ? "text" : DATA.has(node.extension) ? "muted" : "text", ""];
		const name = state.selected === node.relPath ? paint("accent", host.bold(node.name)) : paint(role, node.name);
		return spread(`${guides}${icon(node, false)}${name}`, mark ? paint(role, mark) : "", inner);
	};

	return {
		id: "tree",

		render(width, height) {
			state.awaitingRender = false;
			const inner = Math.max(1, host.inner(width));
			const framed = host.box([""], width).length > 1 ? 1 : 0;
			const capacity = Math.max(1, (height ?? 20) - 2 * framed - 2);
			state.capacity = capacity;
			state.header = { from: 0, to: framed, blank: framed + 1 };
			state.hits = new Map();

			const fresh = state.notice && Date.now() - state.noticeAt < treeTiming.noticeMs;
			const second = fresh ? paint("warning", `⚠ ${state.notice}`) : state.gitFailed && state.tree ? paint("dim", "git status unavailable") : "";
			const body = [];
			if (state.noCwd) body.push(paint("muted", "No project folder"));
			else if (state.error) body.push(paint("warning", `Cannot read the folder: ${state.error.code ?? state.error.message ?? state.error}`));
			else if (!state.tree) body.push(paint("dim", "Scanning…"));
			else if (!state.tree.length) body.push(`${paint("dim", "No files in the project")} ${paint("dim", "·")} ${paint("accent", ICON)}`);
			else {
				const rows = flat();
				const overflow = rows.length > capacity;
				const shown = overflow ? Math.max(1, capacity - 1) : capacity;
				state.scroll = Math.max(0, Math.min(state.scroll, rows.length - shown));
				rows.slice(state.scroll, state.scroll + shown).forEach((row, index) => {
					state.hits.set(framed + 2 + index, row.node);
					body.push(fileRow(row, inner));
				});
				if (overflow) {
					const below = rows.length - state.scroll - shown;
					const parts = [state.scroll > 0 && `▲ ${state.scroll} above`, below > 0 && `▼ ${below} below`].filter(Boolean);
					body.push(paint("dim", `… ${parts.join(" · ")} (wheel scroll)`));
				}
			}
			while (body.length < capacity) body.push("");
			return host.box([headerRow(width, inner), second, ...body.map((row) => spread(row, "", inner))], width);
		},

		handleClick(line, button) {
			if (button === "right") {
				toggleAll();
				return true;
			}
			if (button !== "left") return false;
			if (line >= state.header.from && line <= state.header.to) {
				launch(undefined);
				return true;
			}
			const node = state.hits.get(line);
			if (!node) return false;
			if (node.isDirectory) {
				if (state.expanded.has(node.relPath)) state.expanded.delete(node.relPath);
				else state.expanded.add(node.relPath);
				toggled();
				return true;
			}
			state.selected = node.relPath;
			state.version++;
			const edit = () => launch(node.absPath);
			if (!openPreview(host.ctx(), { file: node.absPath, relPath: node.relPath, onEdit: edit })) edit();
			return true;
		},

		handleWheel(delta) {
			if (!delta || !state.tree?.length) return false;
			const rows = flat();
			if (rows.length <= state.capacity) return false;
			const shown = Math.max(1, state.capacity - 1);
			const next = Math.max(0, Math.min(rows.length - shown, state.scroll + (delta > 0 ? 1 : -1)));
			if (next === state.scroll) return false;
			state.scroll = next;
			return true;
		},

		onShow() {
			refresh();
			if (!state.timer && !state.disposed) {
				state.timer = setInterval(tick, treeTiming.rescanMs);
				state.timer.unref?.();
			}
		},

		invalidate() {
			state.flat = undefined;
		},

		dispose() {
			state.disposed = true;
			clearInterval(state.timer);
			state.timer = undefined;
		},
	};
}
