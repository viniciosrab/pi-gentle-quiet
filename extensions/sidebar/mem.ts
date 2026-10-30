// The MEM tab of gentle-quiet's side column, after pi-cinlodev-cute's MEM tab; the contract is in ./tabs.ts.
// Cards, top to bottom, as cute stacks them:
//   Engram          local essentials only, no cloud: the local server's status and version, this project's
//                   memories, sessions and prompts, the size on disk of the database all projects share,
//                   and "⚑ 3 to review · 1 conflict" when Engram has observations due for review or
//                   relations waiting for judgment. A click on the title collapses it to one row; its rows
//                   are not actions.
//   Active Handoff  the project's latest session summary, folded to one row (`#920 · 1h ago · <goal>`); a
//                   click on the title or the card toggles the full text. Without one, a click fetches again.
//   Saved this session     the memories the agent saved or updated in this Pi session (./mem-session.ts).
//   Recalled this session  the memories it read (mem_get_observation), searched (mem_search, with the hits)
//                          or loaded (mem_context).
// A click on a saved or recalled memory opens it read-only in the preview pop-up (./tree-preview.ts), its text
// from Engram's local server, else from the session. Engram and Active Handoff are left out without
// gentle-engram. cute's Stack · Ecosystem card is not drawn: nothing offline knows the latest versions, and
// it would only show when an update is out. Nor is cute's persistent memory card (~/.memory/memories.db): no
// package of this stack writes that store.
//
// Data loads asynchronously (./mem-engram.ts) and is cached: Engram for 10 s, the handoff for 15 s, the
// session's memories until the session changes. render() only reads the caches. Nothing here writes to Engram.
// @ts-nocheck

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { defaultDeps, fetchHandoff, fetchObservation, fetchSnapshot, formatBytes, relativeTime } from "./mem-engram.ts";
import { scanSession } from "./mem-session.ts";
import { engramInstalled } from "./mem-stack.ts";
import type { SidebarHost, SidebarTab } from "./tabs.ts";
import { openPreview } from "./tree-preview.ts";

const ENGRAM_TTL = 10_000;
const HANDOFF_TTL = 15_000;

const join = (icon, text) => (icon ? `${icon} ${text}` : text);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const memoriesOf = (n) => `${n} ${n === 1 ? "memory" : "memories"}`;

/** `left` and `right` on one row `inner` wide, `right` flush right; `left` is cut first. */
function pair(left, right, inner) {
	const rightWidth = visibleWidth(right);
	if (rightWidth >= inner) return truncateToWidth(right, inner, "…");
	const room = Math.max(0, inner - (rightWidth ? rightWidth + 1 : 0));
	const cut = visibleWidth(left) > room ? truncateToWidth(left, room, "…") : left;
	return `${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut) - rightWidth))}${right}`;
}

/** Words into rows of at most `width` columns. */
function wrap(text, width) {
	const rows = [];
	let current = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (current && visibleWidth(`${current} ${word}`) > width) {
			rows.push(current);
			current = word;
		} else current = current ? `${current} ${word}` : word;
	}
	if (current) rows.push(current);
	return rows.map((row) => (visibleWidth(row) > width ? truncateToWidth(row, width, "…") : row));
}

// The goal's first line: the first text under "Goal", else the first text row, else the record's title.
function goalOf(record) {
	const lines = (record.rawLines ?? []).map((line) => line.trim()).filter(Boolean);
	const heading = (line) => line.startsWith("#") || line.endsWith(":");
	const goal = lines.findIndex((line) => heading(line) && /goal/i.test(line));
	const after = goal >= 0 ? lines.slice(goal + 1).find((line) => !heading(line)) : undefined;
	const text = after ?? lines.find((line) => !heading(line)) ?? record.title ?? "";
	return text.replace(/^[-*•]\s*/, "");
}

export function createTab(host: SidebarHost): SidebarTab {
	return createMemTab(host, defaultDeps());
}

/** The tab, with its I/O through `deps` (tests hand in stand-ins). */
export function createMemTab(host, deps) {
	const s = {
		installed: undefined, // gentle-engram present: undefined until checked
		snapshot: undefined,
		loadingSnapshot: false,
		handoff: undefined, // null: none found
		handoffAt: 0,
		loadingHandoff: false,
		engramOpen: true,
		handoffOpen: false,
		session: { key: undefined, memories: undefined },
		targets: new Map(), // row -> action, from the last render
		disposed: false,
	};
	const redraw = () => {
		if (!s.disposed) host.requestRender();
	};
	const fg = (role, text) => host.fg(role, text);

	const loadSnapshot = (force = false) => {
		if (s.loadingSnapshot || (!force && s.snapshot && deps.now() - s.snapshot.at < ENGRAM_TTL)) return;
		s.loadingSnapshot = true;
		fetchSnapshot(host.cwd(), deps)
			.then((snapshot) => {
				s.snapshot = snapshot;
			})
			.catch(() => {
				s.snapshot = { project: undefined, failed: true, at: deps.now() };
			})
			.finally(() => {
				s.loadingSnapshot = false;
				redraw();
				if (s.snapshot?.project) loadHandoff();
			});
	};
	const loadHandoff = (force = false) => {
		const project = s.snapshot?.project;
		if (!project || s.loadingHandoff || (!force && s.handoff !== undefined && deps.now() - s.handoffAt < HANDOFF_TTL)) return;
		s.loadingHandoff = true;
		fetchHandoff(project, deps)
			.then((record) => {
				s.handoff = record;
			})
			.catch(() => {
				s.handoff = null;
			})
			.finally(() => {
				s.handoffAt = deps.now();
				s.loadingHandoff = false;
				redraw();
			});
	};
	let checking = false;
	const refresh = () => {
		if (s.installed === true) {
			loadSnapshot();
			loadHandoff();
		} else if (s.installed === undefined && !checking) {
			checking = true;
			engramInstalled(deps, host)
				.then((installed) => {
					s.installed = installed;
				})
				.catch(() => {
					s.installed = false;
				})
				.finally(() => {
					checking = false;
					redraw();
					if (s.installed) loadSnapshot();
				});
		}
	};

	// A card from host.card, with its title and rows' actions placed at the rows they landed on. The
	// outline adds a row above the title (and one under the rows); without it the title is the first row.
	const place = (out, title, items, width, titleAction) => {
		const lines = host.card(title, items.map((item) => item.text), width);
		const bare = 1 + (items.length ? items.length + 1 : 0);
		const titleRow = lines.length - bare >= 2 ? 1 : 0;
		const base = out.length;
		if (titleAction) s.targets.set(base + titleRow, titleAction);
		items.forEach((item, i) => {
			if (item.action) s.targets.set(base + titleRow + 2 + i, item.action);
		});
		out.push(...lines);
	};

	const engramCard = (out, width) => {
		const inner = host.inner(width);
		const snap = s.snapshot;
		const icon = host.icons?.memory;
		const toggle = () => {
			s.engramOpen = !s.engramOpen;
			redraw();
		};
		if (!snap || (!snap.project && !snap.failed && host.cwd())) {
			place(out, join(icon, "Engram"), [{ text: fg("muted", "Checking Engram…") }], width);
			return;
		}
		if (!snap.project) {
			place(out, join(icon, "Engram"), [{ text: fg("muted", snap.failed ? "Engram could not be read" : "No project: Pi has no working directory") }], width);
			return;
		}
		const title = pair(`${icon ? `${icon} ` : ""}Engram: ${snap.project}`, fg("dim", s.engramOpen ? "▲" : "▼"), inner);
		const size = formatBytes(snap.dbSize);
		if (!s.engramOpen) {
			const dot = snap.healthy ? fg("success", "●") : fg("warning", "○");
			const summary = [snap.counts && memoriesOf(snap.counts.project.observations), size].filter(Boolean).join(" · ");
			place(out, title, [{ text: summary ? `${dot} ${summary}` : dot }], width, toggle);
			return;
		}
		const row = (label, value) => ({ text: pair(fg("muted", label), value, inner) });
		const items = [];
		const daemon =
			!snap.endpoint ? fg("warning", "○ Unreachable")
			: snap.healthy ? `${fg("success", "● Online")}${snap.version ? fg("muted", ` · v${snap.version.replace(/^v/, "")}`) : ""}`
			: fg("warning", "○ Offline");
		items.push(row(`Local (${snap.endpoint?.label ?? "private"})`, daemon));
		if (snap.counts) {
			// Only this project's counts; the database below is the one file every project shares.
			const { project } = snap.counts;
			items.push(row("This project", fg("text", `${memoriesOf(project.observations)} · ${plural(project.sessions, "session")} · ${plural(project.prompts, "prompt")}`)));
		}
		if (size) items.push(row("Database (all projects)", fg("text", size)));
		const { review = 0, conflicts = 0 } = snap.pending ?? {};
		const pending = [review && `${review} to review`, conflicts && `${conflicts} conflict${conflicts === 1 ? "" : "s"}`].filter(Boolean);
		if (pending.length) items.push({ text: fg("warning", truncateToWidth(`⚑ ${pending.join(" · ")}`, inner, "…")) });
		place(out, title, items, width, toggle);
	};

	const mark = (text) =>
		text
			.replace(/(PR\s*#\d+)/gi, (m) => fg("warning", m))
			.replace(/\b(develop|main|master)\b/g, (m) => fg("success", m))
			.replace(/(->|➔)/g, () => fg("accent", "➔"));

	const handoffCard = (out, width) => {
		const inner = host.inner(width);
		const again = () => {
			loadHandoff(true);
			redraw();
		};
		const record = s.handoff;
		if (!record) {
			const title = join(host.icons?.memory, "Active Handoff");
			const empty = [fg("dim", record === undefined ? "Looking for the last session summary…" : "No previous session summary"), ...(record === null ? [fg("dim", "(saved when a session closes)")] : [])];
			place(out, title, empty.map((text) => ({ text, action: again })), width, again);
			return;
		}
		const toggle = () => {
			s.handoffOpen = !s.handoffOpen;
			redraw();
		};
		const title = pair(join(host.icons?.memory, "Active Handoff"), fg("dim", s.handoffOpen ? "▲" : "▼"), inner);
		const age = record.date ? relativeTime(record.date, deps.now()) : "recent";
		if (!s.handoffOpen) {
			const row = `${fg("accent", `#${record.id ?? "?"}`)} ${fg("dim", "·")} ${fg("muted", age)} ${fg("dim", "·")} ${fg("text", goalOf(record))}`;
			place(out, title, [{ text: truncateToWidth(row, inner, "…"), action: toggle }], width, toggle);
			return;
		}
		const items = [
			pair(`${fg("accent", `#${record.id ?? "?"}`)} ${fg("warning", record.type || "session_summary")}`, fg("muted", age), inner),
			fg("border", "─".repeat(Math.max(0, inner))),
			"",
		];
		const lines = record.rawLines?.length ? record.rawLines : [record.title ?? ""];
		for (const raw of lines) {
			const line = raw.trim();
			if (!line) continue;
			if (/^[-*•]\s/.test(line)) {
				const text = line.replace(/^[-*•]\s*/, "");
				const cut = visibleWidth(text) > inner - 4 ? truncateToWidth(text, Math.max(1, inner - 4), "…") : text;
				items.push(`  ${fg("accent", "•")} ${fg("text", mark(cut))}`);
			} else if (line.endsWith(":") || line.startsWith("#")) {
				items.push(`${fg("accent", "✦")} ${fg("warning", line.replace(/^#+\s*/, ""))}`);
			} else {
				for (const row of wrap(line, Math.max(1, inner - 2))) items.push(fg("text", mark(row)));
			}
		}
		items.push("");
		place(out, title, items.map((text) => ({ text, action: toggle })), width, toggle);
	};

	// The session's memories, scanned again only when the branch changed.
	const memories = () => {
		const ctx = (() => {
			try {
				return host.ctx();
			} catch {
				return undefined;
			}
		})();
		let entries;
		try {
			entries = ctx?.sessionManager?.getBranch?.();
		} catch {
			entries = undefined;
		}
		const key = entries ? `${entries.length}:${entries.at?.(-1)?.id ?? ""}` : undefined;
		if (!key || key !== s.session.key || !s.session.memories) s.session = { key, memories: scanSession(ctx) };
		return s.session.memories;
	};

	// The memory read-only in the preview pop-up: Engram's text when its server has it, else the session's.
	const openMemory = (memory) => {
		const heading = [`#${memory.id}`, memory.type, memory.title].filter(Boolean).join(" · ");
		const text = fetchObservation(memory.id, deps)
			.catch(() => undefined)
			.then((observation) => (typeof observation?.content === "string" && observation.content.trim() ? observation.content : (memory.body ?? "")));
		openPreview(host.ctx(), { text, title: heading, label: "Memory" });
	};
	const cut = (text, room) => (visibleWidth(text) > room ? truncateToWidth(text, Math.max(1, room), "…") : text);

	const savedCard = (out, width) => {
		const inner = host.inner(width);
		const { saved } = memories();
		const items = saved.length
			? saved.map((memory) => {
					const marker = memory.updated ? fg("warning", "updated") : "";
					const room = inner - (marker ? visibleWidth(marker) + 1 : 0);
					const badge = memory.type ? `${memory.type} ` : "";
					const left = `${fg("dim", badge)}${fg("text", cut(memory.title, room - visibleWidth(badge)))}`;
					return { text: pair(left, marker, inner), action: memory.id ? () => openMemory(memory) : undefined };
				})
			: [{ text: fg("dim", "Nothing saved yet") }];
		place(out, "Saved this session", items, width);
	};

	const recalledCard = (out, width) => {
		const inner = host.inner(width);
		const { recalled } = memories();
		const items = recalled.length
			? recalled.map((memory) => {
					if (memory.kind === "context") return { text: `${fg("accent", "◆")} ${fg("text", "context loaded")}` };
					if (memory.kind === "search") {
						const hits = memory.hits === undefined ? "" : fg("dim", `${memory.hits} hit${memory.hits === 1 ? "" : "s"}`);
						const room = inner - 2 - (hits ? visibleWidth(hits) + 1 : 0);
						return { text: pair(`${fg("accent", "⌕")} ${fg("text", cut(`"${memory.query}"`, room))}`, hits, inner) };
					}
					const id = `#${memory.id} `;
					return { text: `${fg("dim", id)}${fg("text", cut(memory.title, inner - visibleWidth(id)))}`, action: () => openMemory(memory) };
				})
			: [{ text: fg("dim", "Nothing recalled yet") }];
		place(out, "Recalled this session", items, width);
	};

	return {
		id: "mem",
		render(width) {
			refresh();
			s.targets = new Map();
			const out = [];
			if (s.installed) {
				engramCard(out, width);
				handoffCard(out, width);
			}
			savedCard(out, width);
			recalledCard(out, width);
			return out;
		},
		handleClick(line, button) {
			if (button !== "left") return false;
			const action = s.targets.get(line);
			if (action) {
				Promise.resolve()
					.then(action)
					.catch(() => {});
				return true;
			}
			return false;
		},
		onShow() {
			refresh();
		},
		invalidate() {
			s.session = { key: undefined, memories: undefined };
		},
		dispose() {
			s.disposed = true;
		},
	};
}
