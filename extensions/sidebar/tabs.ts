// Tabs of gentle-quiet's side column, after pi-cinlodev-cute's rail: a tab bar fixed on top of the column,
// "1:MAIN 2:GIT 3:PROF 4:MEM 5:TREE 6:PR", the active tab drawn "[ 5:TREE ]" in accent bold, the
// others with a dim key and a muted label, then a "─" divider row. A left click on the bar (or its divider)
// picks the nearest tab; the wheel over it cycles the tabs, wrapping at both ends. The active tab lives in
// memory and starts at MAIN. The order is the user's (sidebar.tabOrder in /gentle-quiet, normalised by
// normalizeTabOrder); a tab's number is its position in it, while its id never changes.
//
// MAIN (today's column: Status, Context, Jobs, Todos) is drawn by gentle-quiet.ts; the Agents card stays
// inline above the editor, as in cute. GIT, PROF, MEM, TREE and PR are modules in this folder, one file each, registered in TAB_FACTORIES below; a tab
// is written without touching gentle-quiet.ts or another tab's file.
//
// This folder has no index.ts on purpose: Pi loads only top-level files and folders with an index or a
// package.json as extensions, so these files are loaded by gentle-quiet.ts alone.
//
// ---------------------------------------------------------------------------------------------------
// Tab contract: each tab file exports
//
//   export function createTab(host: SidebarHost): SidebarTab
//
// createTab is called once per side column, the first time the tab is opened. Keep it cheap: no I/O there.
//
// SidebarTab (only `id` and `render` are required):
//   id: string
//       "git" | "prof" | "mem" | "tree" | "pr", the tab's id in TABS.
//   render(width: number, height: number): string[]
//       The tab's rows, top to bottom, synchronously, with ANSI colors from host.fg. `width` is the column's
//       content width (59 today): a row wider than that is cut with "…". `height` is how many rows of the
//       terminal the tab has under the bar; render more and the column scrolls (with its own scroll position
//       per tab), fewer and the rest stays blank, so a tab can fill the column by returning `height` rows.
//       Called on every frame while the tab is open: read cached data, never wait. Load data asynchronously
//       (host.git, files, ...) and call host.requestRender() when it changed. A render that throws draws an
//       "<LABEL> — <message>" card instead of closing the column.
//   handleClick?(line: number, button: "left" | "right" | "middle", x: number, event?: MouseEvent): boolean
//       A click on the tab's content. `line` is the index in the rows render() last returned (the scroll
//       offset is already added); `x` is the column within the row, 0 at its first character; `event` is
//       Pi's mouse event (screenX/screenY place a pop-up by the click). Return true when the tab acted on
//       it: the column is redrawn and the click goes no further.
//   handleWheel?(delta: number, line: number, x: number): boolean
//       The wheel over the tab's content (delta > 0 scrolls down). Return true to keep it (a card scrolling
//       its own list, an account switcher); false or no method and the column scrolls.
//   handleKey?(data: string): boolean
//       A key while the tab has the keyboard (host.focus): Pi's raw input, before the editor sees it. Return
//       true when the tab used it. While the tab has the keyboard every key is kept from the editor anyway;
//       an Esc the tab does not use gives the keyboard back to the editor.
//   keyOverlay?(): Component | undefined
//       The pop-up the tab has open over Pi (a picker), whose keys still come through handleKey. Any other
//       component taking Pi's focus (a dialog, another screen) gives the keyboard back to it.
//   onShow?(): void
//       The tab became the active one (also on its first render): refresh its data here.
//   onHide?(): void
//       Another tab (MAIN included) took its place: stop polling here. Not called when the whole column
//       closes under the breakpoint, so a timer should also stop when render() stops coming.
//   invalidate?(): void
//       Pi invalidated the column (theme change): drop cached rendered rows.
//   dispose?(): void
//       The column was taken down: clear timers and watchers.
//
// SidebarHost: what gentle-quiet hands a tab; every member reads the live value when called.
//   theme: Theme
//       Pi's active theme (a getter).
//   fg(role: string, text: string): string
//   bold(text: string): string
//       Theme painting that degrades to plain text. Roles as Pi's: "accent", "border", "dim", "muted", "text",
//       "toolTitle", "success", "warning", "error", "toolDiffAdded", "toolDiffRemoved", ...
//   card(title: string, rows: string[], width: number): string[]
//       A card as the column draws Status, Jobs and Todos: a square outline in the border color, the title
//       bold in toolTitle, a blank row, then `rows` (each cut to fit). No rows: the title alone. With the
//       outline turned off in /gentle-quiet, the same rows indented by one column.
//   box(rows: string[], width: number): string[]
//       The bare square outline around `rows`, cut to fit, for cards with a title of their own.
//   inner(width: number): number
//       The room for a row inside card() and box() at `width`.
//   cwd(): string | undefined
//       The session's working directory.
//   ctx(): ExtensionContext | undefined
//       Pi's latest extension context (model, sessionManager, modelRegistry, ui).
//   pi: ExtensionAPI | undefined
//       Pi's extension API (events, getAllTools, getCommands, sendUserMessage).
//   agentDir: string
//       Pi's agent dir (~/.pi/agent): installed packages are under npm/node_modules.
//   gentleShellOff(): boolean
//       True when settings.json turns Gentle Shell off in gentle-pi's package entry (PROF edits profiles then).
//   requestRender(): void
//       Redraws the column.
//   git(args: string[], cwd?: string): Promise<string | undefined>
//       `git -C <cwd> ...args` (3 s timeout): stdout, or undefined on any failure. cwd defaults to cwd().
//   changes(cwd?: string): { files: number, added: number, deleted: number } | undefined
//       The status line's cached uncommitted changes (untracked files included); undefined until read.
//   usage(): { name: string, windows: { label: string, percent: number, resetAt: number | null }[] }
//       The plan usage windows the Context card shows (5h, week), from the provider's rate-limit headers.
//   gauge(percent: number | null): string
//       The status line's ring gauge for a percentage, painted.
//   icons: Record<string, string>
//       gentle-quiet's configured icons (memory, todo, agents, jobs, rdd, other, branch).
//   treeIcons: "emoji" | "nerd"; treeHidden: boolean; setTreeHidden(value: boolean): void
//       TREE's settings in /gentle-quiet: its icons, and whether it lists hidden entries (set and saved).
//   focus(id: string): void; blur(): void; focused(): string | undefined
//       The column's keyboard: focus gives the tab `id` the keys (handleKey) until Esc, another tab, a
//       narrower terminal or blur gives them back to Pi's editor; focused() is the tab holding them.
//       PROF's alt+p (gentle-quiet.ts) opens PROF and focuses it.
// ---------------------------------------------------------------------------------------------------
// @ts-nocheck

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createTab as createGitTab } from "./git.ts";
import { createTab as createMemTab } from "./mem.ts";
import { createTab as createPrTab } from "./pr.ts";
import { createTab as createProfTab } from "./prof.ts";
import { createTab as createTreeTab } from "./tree.ts";

export interface SidebarHost {
	readonly theme: any;
	fg(role: string, text: string): string;
	bold(text: string): string;
	card(title: string, rows: string[], width: number): string[];
	box(rows: string[], width: number): string[];
	inner(width: number): number;
	cwd(): string | undefined;
	ctx(): any;
	readonly pi: any;
	readonly agentDir: string;
	gentleShellOff?(): boolean;
	requestRender(): void;
	git(args: string[], cwd?: string): Promise<string | undefined>;
	changes(cwd?: string): { files: number; added: number; deleted: number } | undefined;
	usage(): { name: string; windows: { label: string; percent: number; resetAt: number | null }[] };
	gauge(percent: number | null): string;
	readonly icons: Record<string, string>;
	/** TREE's icon theme: "emoji", or "nerd" (Nerd Font glyphs as Neo-tree draws them, ./nerd-icons.ts). */
	readonly treeIcons: "emoji" | "nerd";
	/** Whether TREE lists its hidden entries (/gentle-quiet's Tree hidden items). */
	readonly treeHidden: boolean;
	/** Sets Tree hidden items and saves it in gentle-quiet.json. */
	setTreeHidden(value: boolean): void;
	/** Gives the tab `id` the keyboard; blur() gives it back to the editor. */
	focus?(id: string): void;
	blur?(): void;
	focused?(): string | undefined;
}

export interface SidebarTab {
	id: string;
	render(width: number, height: number): string[];
	handleClick?(line: number, button: string, x: number, event?: any): boolean;
	handleWheel?(delta: number, line: number, x: number): boolean;
	handleKey?(data: string): boolean;
	keyOverlay?(): any;
	onShow?(): void;
	onHide?(): void;
	invalidate?(): void;
	dispose?(): void;
}

export type CreateTab = (host: SidebarHost) => SidebarTab;

export const TABS = [
	{ id: "main", key: "1", label: "MAIN" },
	{ id: "git", key: "2", label: "GIT" },
	{ id: "prof", key: "3", label: "PROF" },
	{ id: "mem", key: "4", label: "MEM" },
	{ id: "tree", key: "5", label: "TREE" },
	{ id: "pr", key: "6", label: "PR" },
];

/** The tabs drawn by their own module, by id. Tests swap entries for stand-ins. */
export const TAB_FACTORIES: Record<string, CreateTab> = {
	git: createGitTab,
	prof: createProfTab,
	mem: createMemTab,
	tree: createTreeTab,
	pr: createPrTab,
};

/** Rows the tab bar takes on top of the column: the bar and its divider. */
export const TAB_BAR_ROWS = 2;
const COMPACT_WIDTH = 44;
const INVERSE = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";

const paint = (t, role, text) => {
	try {
		return t?.fg ? t.fg(role, text) : text;
	} catch {
		return text;
	}
};
const strong = (t, text) => {
	try {
		return t?.bold ? t.bold(text) : text;
	} catch {
		return text;
	}
};

export const tabLabel = (id) => TABS.find((tab) => tab.id === id)?.label ?? id.toUpperCase();

export const DEFAULT_TAB_ORDER = TABS.map((tab) => tab.id);

/**
 * A saved tab order made safe: the known ids once each, in their order, then the tabs it leaves out in the
 * default order, so an old, partial or broken value never hides a tab.
 */
export function normalizeTabOrder(order) {
	const known = Array.isArray(order) ? order.filter((id) => DEFAULT_TAB_ORDER.includes(id)) : [];
	return [...new Set([...known, ...DEFAULT_TAB_ORDER])];
}

/** `order` with `id` swapped with its neighbour `step` (-1 up, 1 down) away; unchanged at the ends. */
export function moveTab(order, id, step) {
	const next = normalizeTabOrder(order);
	const from = next.indexOf(id);
	const to = from + (step > 0 ? 1 : -1);
	if (from < 0 || to < 0 || to >= next.length) return next;
	[next[from], next[to]] = [next[to], next[from]];
	return next;
}

/** `order` with `id` taken out and put back at `index` (clamped to the ends); unchanged for an unknown id. */
export function moveTabTo(order, id, index) {
	const next = normalizeTabOrder(order);
	if (!next.includes(id)) return next;
	const rest = next.filter((other) => other !== id);
	rest.splice(Math.max(0, Math.min(rest.length, index)), 0, id);
	return rest;
}

/** The index of the slot (a tab bar hitbox) whose middle is nearest column `x`; the ends past either side. */
export function slotAt(slots, x) {
	let best = 0;
	slots.forEach((slot, i) => {
		const mid = (slot.startX + slot.endX) / 2;
		const bestMid = (slots[best].startX + slots[best].endX) / 2;
		if (Math.abs(x - mid) < Math.abs(x - bestMid)) best = i;
	});
	return best;
}

/** The tabs in `order`, each keyed by its position: "1", "2", … */
export const orderedTabs = (order) => normalizeTabOrder(order).map((id, i) => ({ ...TABS.find((tab) => tab.id === id), key: String(i + 1) }));

/** The tab `delta` steps from `id` in `order`, wrapping at both ends. */
export function cycleTab(id, delta, order = DEFAULT_TAB_ORDER) {
	const ids = normalizeTabOrder(order);
	const index = Math.max(0, ids.indexOf(id));
	const step = delta > 0 ? 1 : -1;
	return ids[(index + step + ids.length) % ids.length];
}

/**
 * Cute's tab bar at `width`: the active tab "[ 1:MAIN ]" ("[1:MAIN]" under 44 columns) in accent bold, the
 * others "2:GIT" with a dim key and a muted label, equal gaps between them; the divider row under it; and
 * where each tab sits ([startX, endX) columns), for the mouse. The tabs follow `order`, numbered by position.
 * The tab being dragged (`draggedId`) is drawn in reverse video in the accent colour, so it shows where it goes.
 */
export function renderTabBar(width, activeId, t, order = DEFAULT_TAB_ORDER, draggedId = undefined) {
	const compact = width < COMPACT_WIDTH;
	const items = orderedTabs(order).map((tab) => {
		if (tab.id === draggedId) {
			const label = tab.id !== activeId ? `${tab.key}:${tab.label}` : compact ? `[${tab.key}:${tab.label}]` : `[ ${tab.key}:${tab.label} ]`;
			return { tab, styled: `${INVERSE}${paint(t, "accent", strong(t, label))}${INVERSE_OFF}`, len: visibleWidth(label) };
		}
		if (tab.id === activeId) {
			const label = compact ? `[${tab.key}:${tab.label}]` : `[ ${tab.key}:${tab.label} ]`;
			return { tab, styled: paint(t, "accent", strong(t, label)), len: visibleWidth(label) };
		}
		const styled = `${paint(t, "dim", tab.key)}${paint(t, "dim", ":")}${paint(t, "muted", tab.label)}`;
		return { tab, styled, len: visibleWidth(`${tab.key}:${tab.label}`) };
	});
	const total = items.reduce((sum, item) => sum + item.len, 0);
	const gaps = items.length - 1;
	const remaining = Math.max(0, width - total);
	const base = Math.floor(remaining / gaps);
	let extra = remaining % gaps;
	const parts = [];
	const hitboxes = [];
	let x = 0;
	items.forEach((item, index) => {
		hitboxes.push({ id: item.tab.id, startX: x, endX: x + item.len });
		parts.push(item.styled);
		x += item.len;
		if (index < gaps) {
			const gap = Math.max(1, base + (extra-- > 0 ? 1 : 0));
			parts.push(" ".repeat(gap));
			x += gap;
		}
	});
	let line = parts.join("");
	if (visibleWidth(line) > width) line = truncateToWidth(line, Math.max(0, width), "…");
	else line += " ".repeat(width - visibleWidth(line));
	return {
		line,
		divider: paint(t, "border", "─".repeat(Math.max(0, width))),
		hitboxes: hitboxes.filter((box) => box.startX < width).map((box) => ({ ...box, endX: Math.min(box.endX, width) })),
	};
}

/**
 * What the column does with raw input `data` while a tab has the keyboard: "pass" for what is not a key (a mouse
 * report, a terminal's answer) so Pi still gets it, "release" for a paste (the keyboard goes back and the paste
 * lands in the editor), "key" for the rest. `parseKey` is pi-tui's, when it has one.
 */
export function keyInput(data, parseKey = undefined) {
	if (typeof data !== "string" || !data.length) return "pass";
	if (data.startsWith("\x1b[200~")) return "release";
	if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M") || data === "\x1b[I" || data === "\x1b[O") return "pass";
	if (typeof parseKey !== "function" || [...data].length === 1) return "key";
	try {
		return parseKey(data) ? "key" : "pass";
	} catch {
		return "key";
	}
}

/** The tab under column `x` of the bar; between two tabs, the nearer one. */
export function tabAt(hitboxes, x) {
	const inside = hitboxes.find((box) => x >= box.startX && x < box.endX);
	if (inside) return inside.id;
	for (let i = 0; i < hitboxes.length - 1; i++) {
		const box = hitboxes[i];
		const next = hitboxes[i + 1];
		if (x >= box.endX && x < next.startX) return x < (box.endX + next.startX) / 2 ? box.id : next.id;
	}
	if (hitboxes.length && x < hitboxes[0].startX) return hitboxes[0].id;
	if (hitboxes.length && x >= hitboxes.at(-1).endX) return hitboxes.at(-1).id;
	return undefined;
}
