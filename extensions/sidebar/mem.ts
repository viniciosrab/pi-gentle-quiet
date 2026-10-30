// The MEM tab of gentle-quiet's side column, after pi-cinlodev-cute's MEM tab; the contract is in ./tabs.ts.
// Cards, top to bottom, as cute stacks them:
//   Engram          the local server's health and observation count, the cloud host with "dashboard ↗"
//                   (opens the project's dashboard), sync state and the enroll / unsync / sync now buttons
//                   (enroll and unsync ask for a second click). A click on the title collapses it to one row.
//   Active Handoff  the project's latest session summary; a click fetches it again.
//   Stack · Ecosystem  Pi, gentle-pi, gentle-engram and engram versions; a click shows their status.
//   Tools           the session's tool calls by group; left out before the first call.
// Engram and Active Handoff are left out without gentle-engram. cute's persistent memory card
// (~/.memory/memories.db) is not drawn: no package of this stack writes that store.
//
// Data loads asynchronously (./mem-engram.ts, ./mem-stack.ts) and is cached: Engram for 10 s, the handoff
// for 15 s, the versions until the column goes away. render() only reads the caches.
// @ts-nocheck

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cloudCommand, cloudHost, dashboardUrl, defaultDeps, fetchHandoff, fetchSnapshot, relativeTime } from "./mem-engram.ts";
import { countTools, detectEcosystem, engramInstalled, TOOL_GROUPS } from "./mem-stack.ts";
import type { SidebarHost, SidebarTab } from "./tabs.ts";

const ENGRAM_TTL = 10_000;
const HANDOFF_TTL = 15_000;
const NOTICE_MS = 4000;
const CONFIRM_MS = 6000;

const PILLS = {
	read: ["accent", "✎", "read"],
	write: ["toolDiffAdded", "✎", "write"],
	bash: ["success", ">_", "bash"],
	engram: ["toolTitle", undefined, "engram"],
	grep: ["warning", "⌕", "grep"],
	fetch: ["accent", "↓", "fetch"],
	search: ["accent", "◆", "search"],
	other: ["dim", "⚙", "other"],
};

const join = (icon, text) => (icon ? `${icon} ${text}` : text);

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
		ecosystem: undefined,
		loadingEcosystem: false,
		engramOpen: true,
		ecosystemOpen: false,
		confirming: null, // "enroll" | "unenroll"
		notice: null,
		tools: { key: undefined, counts: undefined },
		targets: new Map(), // row -> action, from the last render
		disposed: false,
	};
	let noticeTimer;
	let confirmTimer;
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
	const loadEcosystem = () => {
		if (s.ecosystem || s.loadingEcosystem) return;
		s.loadingEcosystem = true;
		detectEcosystem(deps, host.agentDir)
			.then((tools) => {
				s.ecosystem = tools;
			})
			.catch(() => {
				s.ecosystem = [];
			})
			.finally(() => {
				s.loadingEcosystem = false;
				redraw();
			});
	};
	let checking = false;
	const refresh = () => {
		loadEcosystem();
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

	const flash = (message) => {
		s.notice = message;
		clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => {
			s.notice = null;
			redraw();
		}, NOTICE_MS);
		noticeTimer.unref?.();
		redraw();
	};
	const resetConfirm = () => {
		clearTimeout(confirmTimer);
		s.confirming = null;
	};
	const confirm = (kind) => {
		s.confirming = kind;
		clearTimeout(confirmTimer);
		confirmTimer = setTimeout(() => {
			s.confirming = null;
			redraw();
		}, CONFIRM_MS);
		confirmTimer.unref?.();
		redraw();
	};
	const runCloud = async (kind, project, doing, done, failed) => {
		resetConfirm();
		flash(`${doing} ${project}…`);
		const result = await cloudCommand(kind, project, deps).catch((error) => ({ success: false, message: String(error?.message ?? error) }));
		if (result.success) {
			flash(`✓ ${project} ${done}`);
			loadSnapshot(true);
		} else flash(`⚠ ${failed}: ${result.message.slice(0, 30)}`);
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
			resetConfirm();
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
		const project = snap.project;
		const title = pair(`${icon ? `${icon} ` : ""}Engram: ${project}`, fg("dim", s.engramOpen ? "▲" : "▼"), inner);
		const observations = snap.stats?.observations ?? 0;
		if (!s.engramOpen) {
			const dot = snap.healthy ? fg("success", "●") : fg("error", "○");
			const badge = snap.enrolled ? fg("success", "cloud✓") : fg("dim", "local");
			place(out, title, [{ text: `${dot} ${observations} obs · ${badge}` }], width, toggle);
			return;
		}
		const items = [];
		if (s.notice) items.push({ text: fg("warning", /^[✓⚠]/.test(s.notice) ? s.notice : `⚡ ${s.notice}`) });
		const daemon =
			!snap.endpoint ? fg("error", "○ Unreachable")
			: snap.healthy ? `${fg("success", "● Online")} · ${fg("accent", `${observations} obs`)}`
			: fg("error", "○ Down");
		items.push({ text: pair(fg("text", `Local (${snap.endpoint?.label ?? "private"})`), daemon, inner) });
		items.push({ text: fg("border", "─".repeat(Math.max(0, inner))) });
		items.push({
			text: pair(`${fg("text", "Cloud:")} ${fg("dim", cloudHost(snap.cloud, snap.endpoint))}`, fg("accent", "dashboard ↗"), inner),
			action: () => {
				resetConfirm();
				const opened = (() => {
					try {
						return deps.open(dashboardUrl(snap.cloud, project, snap.endpoint));
					} catch {
						return false;
					}
				})();
				flash(opened ? `Opening ${project} in the browser…` : "Could not open the browser.");
			},
		});
		const label = (text) => `   ${fg("dim", text)}`;
		if (snap.enrolled) {
			const state = snap.sync?.phase === "syncing" ? fg("warning", "⟳ Syncing…") : fg("success", `● Enrolled (${relativeTime(snap.sync?.lastSyncAt, deps.now())})`);
			items.push({ text: pair(label("Sync:"), state, inner) });
			items.push({ text: pair(label("Push:"), fg("accent", "sync now ⟳"), inner), action: () => runCloud("sync", project, "Syncing", "synced", "Sync failed") });
			const asking = s.confirming === "unenroll";
			items.push({
				text: pair(label("Action:"), fg("error", asking ? "Unsync? [click = yes]" : "unsync ✕"), inner),
				action: () => (asking ? runCloud("unenroll", project, "Unsyncing", "unsynced", "Unsync failed") : confirm("unenroll")),
			});
		} else {
			items.push({ text: pair(label("State:"), fg("dim", "○ Not synced"), inner) });
			const asking = s.confirming === "enroll";
			items.push({
				text: pair(label("Action:"), fg("success", asking ? "Enroll repo? [click = yes]" : "+ enroll repo"), inner),
				action: () => (asking ? runCloud("enroll", project, "Enrolling", "enrolled", "Enroll failed") : confirm("enroll")),
			});
		}
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
		const title = join(host.icons?.memory, "Active Handoff");
		const record = s.handoff;
		if (!record) {
			const empty = [fg("dim", record === undefined ? "Looking for the last session summary…" : "No previous session summary"), ...(record === null ? [fg("dim", "(saved when a session closes)")] : [])];
			place(out, title, empty.map((text) => ({ text, action: again })), width, again);
			return;
		}
		const items = [
			pair(`${fg("accent", `#${record.id ?? "?"}`)} ${fg("warning", record.type || "session_summary")}`, fg("muted", record.date ? relativeTime(record.date, deps.now()) : "recent"), inner),
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
		place(out, title, items.map((text) => ({ text, action: again })), width, again);
	};

	const ecosystemCard = (out, width) => {
		const inner = host.inner(width);
		const toggle = () => {
			s.ecosystemOpen = !s.ecosystemOpen;
			redraw();
		};
		const title = "✿ Stack · Ecosystem";
		if (!s.ecosystem) {
			place(out, title, [{ text: fg("dim", "Detecting tools…") }], width);
			return;
		}
		const items = s.ecosystem.map((tool) => {
			const pill = tool.available ? `${fg("success", "●")} ${fg("accent", tool.name)} ${fg("text", `v${tool.version}`)}` : `${fg("dim", "○")} ${fg("dim", tool.name)} ${fg("dim", "-")}`;
			const text = s.ecosystemOpen ? pair(pill, tool.available ? fg("success", "installed") : fg("dim", "not available"), inner) : pill;
			return { text, action: toggle };
		});
		place(out, title, items, width, toggle);
	};

	const toolsCard = (out, width) => {
		const inner = host.inner(width);
		let entries;
		try {
			entries = host.ctx()?.sessionManager?.getBranch?.();
		} catch {
			entries = undefined;
		}
		const key = entries ? `${entries.length}:${entries.at?.(-1)?.id ?? ""}` : undefined;
		if (!key || key !== s.tools.key) s.tools = { key, counts: countTools(host.ctx()) };
		const counts = s.tools.counts;
		if (!counts?.total) return;
		const pills = TOOL_GROUPS.filter((group) => counts[group] > 0).map((group) => {
			const [role, glyph, name] = PILLS[group];
			return fg(role, join(group === "engram" ? host.icons?.memory : glyph, `${counts[group]} ${name}`));
		});
		const rows = [];
		let current = [];
		for (const pill of pills) {
			if (current.length && visibleWidth([...current, pill].join("   ")) > inner) {
				rows.push(current.join("   "));
				current = [pill];
			} else current.push(pill);
		}
		if (current.length) rows.push(current.join("   "));
		place(out, pair("Tools", fg("dim", `${counts.total} calls`), inner), rows.map((text) => ({ text })), width);
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
			ecosystemCard(out, width);
			toolsCard(out, width);
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
			if (s.confirming) {
				resetConfirm();
				redraw();
				return true;
			}
			return false;
		},
		onShow() {
			refresh();
		},
		invalidate() {
			s.tools = { key: undefined, counts: undefined };
		},
		dispose() {
			s.disposed = true;
			clearTimeout(noticeTimer);
			clearTimeout(confirmTimer);
		},
	};
}
