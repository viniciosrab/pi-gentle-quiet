// The PROF tab of gentle-quiet's side column (the contract is in ./tabs.ts), after pi-cinlodev-cute's
// profiles card (src/profiles/profiles-card.ts) filled with gentle-pi's own profiles instead of
// pi-sdd-profiles, and gentle-quiet's plan usage instead of CLIProxyAPI's quotas. Two cards:
//
//   Profiles     one button per saved profile, "[★ 2: Max]", wrapped at most three rows deep with cute's
//                [▼]/[▲] toggle for the rest; gentle-pi's marks: ◉ this session, ★ default for new
//                sessions, ⌂ this repository; the profile in effect in accent bold. Under a rule, its
//                routing: the orchestrator first, then each subagent with its model and effort.
//   Plan usage   each window of the plan usage the Context card shows as cute's quota gauge: the label,
//                the percent used and the reset on one row, a bar across the card under it.
//
// A click on a profile or on the Profiles title runs /gentle:profiles: switching stays gentle-pi's, in its
// own screen, rather than cute's in-card switcher. The wheel is left to the column, which scrolls the tab.
// The data is read in ./prof-data.ts when the tab is shown, never while it draws.
// @ts-nocheck

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadProfiles, PROF_TIMEOUTS } from "./prof-data.ts";
import type { SidebarHost, SidebarTab } from "./tabs.ts";

export { PROF_TIMEOUTS };

const TITLE = "Profiles";
const USAGE_TITLE = "Plan usage";
const MAX_PROFILE_ROWS = 3;
const STALE_MS = 15_000;
const strip = (text) => String(text).replace(/\x1b\[[0-9;:]*m/g, "");

/** cute's relative reset ("in 2h 5m"), from a reset time in ms. */
export function formatReset(resetAt, now = Date.now()) {
	if (!resetAt) return "";
	const ms = resetAt - now;
	if (Number.isNaN(ms)) return "";
	if (ms <= 0) return "resetting…";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return minutes % 60 ? `in ${hours}h ${minutes % 60}m` : `in ${hours}h`;
	const days = Math.floor(hours / 24);
	return hours % 24 ? `in ${days}d ${hours % 24}h` : `in ${days}d`;
}

// The status line's tones for a percentage used.
const tone = (percent) => (percent >= 95 ? "error" : percent >= 80 ? "warning" : "accent");
// cute's colors by agent family, in theme roles.
const FAMILIES = [
	["gentle-ai-", "accent"],
	["jd-", "warning"],
	["review-", "success"],
	["research-", "error"],
];
const shortModel = (model) => String(model).split("/").at(-1);

export function createTab(host: SidebarHost): SidebarTab {
	const fg = (role, text) => host.fg(role, text);
	let data; // what prof-data.ts read last
	let loadedAt = 0;
	let loading = false;
	let again = false; // a refresh asked for while one was running
	let expanded = false;
	let hitboxes = []; // { line, startX, endX, action }

	const refresh = () => {
		if (loading) {
			again = true;
			return;
		}
		loading = true;
		loadProfiles(host).then((next) => {
			loading = false;
			loadedAt = Date.now();
			const changed = JSON.stringify(next) !== JSON.stringify(data);
			data = next;
			if (again) {
				again = false;
				refresh();
			}
			if (changed) host.requestRender();
		});
	};

	// A row with `right` flush with the card's edge; too long for one row, `right` goes on the next.
	const spread = (left, right, inner) => {
		const gap = inner - visibleWidth(left) - visibleWidth(right);
		return gap >= 2 ? [`${left}${" ".repeat(gap)}${right}`] : [left, `  ${right}`];
	};

	// cute's profile buttons, wrapped; the third row makes room for the toggle when more rows follow.
	const buttonRows = (inner) => {
		const marks = (name) =>
			[
				[data.session, "◉", "success"],
				[data.default, "★", "accent"],
				[data.repo, "⌂", "warning"],
			].filter(([owner]) => owner === name);
		const buttons = data.names.map((name, index) => {
			const own = marks(name);
			const glyphs = own.map(([, glyph]) => glyph).join("") || "○";
			const raw = `[${glyphs} ${index + 1}: ${name}]`;
			const styled =
				name === data.shown
					? fg("accent", host.bold(raw))
					: `${fg("dim", "[")}${own.length ? own.map(([, glyph, role]) => fg(role, glyph)).join("") : fg("dim", "○")}${fg("dim", ` ${index + 1}: `)}${fg("muted", name)}${fg("dim", "]")}`;
			return { styled, len: visibleWidth(raw) };
		});
		const wrapped = [];
		let row = [];
		let used = 0;
		for (const button of buttons) {
			const room = used ? used + 1 + button.len : button.len;
			if (room <= inner || !row.length) {
				row.push(button);
				used = room;
			} else {
				wrapped.push(row);
				row = [button];
				used = button.len;
			}
		}
		if (row.length) wrapped.push(row);
		const paged = wrapped.length > MAX_PROFILE_ROWS;
		const shown = paged && !expanded ? wrapped.slice(0, MAX_PROFILE_ROWS) : wrapped;
		const toggle = expanded ? "[▲]" : "[▼]";
		return shown.map((buttons, index) => {
			const last = paged && index === shown.length - 1;
			const fits = [];
			let width = 0;
			for (const button of buttons) {
				const next = width ? width + 1 + button.len : button.len;
				if (last && next > inner - toggle.length - 1) break;
				fits.push(button);
				width = next;
			}
			const spans = [];
			let x = 0;
			for (const button of fits) {
				spans.push({ startX: x, endX: x + button.len, action: "profiles" });
				x += button.len + 1;
			}
			const parts = fits.map((button) => button.styled);
			if (last) {
				spans.push({ startX: x, endX: x + toggle.length, action: "toggle" });
				parts.push(fg("accent", host.bold(toggle)));
			}
			return { text: parts.join(" "), spans };
		});
	};

	const rosterRows = (inner) => {
		const effort = (entry, fallback) => fg("dim", `(${entry?.thinking ?? fallback})`);
		const model = (value) => (value === undefined || value === "inherit" ? fg("dim", "inherit") : fg("text", shortModel(value)));
		const orchestrator = data.orchestrator;
		const head = `${fg("accent", "◆")} ${host.bold("orchestrator")}`;
		const rows = spread(head, orchestrator?.model ? `${model(orchestrator.model)} ${effort(orchestrator, "inherit")}` : fg("dim", "leave untouched"), inner);
		rows.push("");
		if (!data.rows.length) rows.push(fg("dim", "no subagents routed"));
		for (const entry of data.rows) {
			const family = FAMILIES.find(([prefix]) => entry.agent.startsWith(prefix))?.[1];
			const left = `${fg(family ?? "muted", "•")} ${fg(family ?? "text", entry.agent)}`;
			rows.push(...spread(left, `${model(entry.model)} ${effort(entry, "inherit")}`, inner));
		}
		return rows;
	};

	const usageRows = (inner) => {
		let usage;
		try {
			usage = host.usage();
		} catch {
			usage = undefined;
		}
		const windows = usage?.windows ?? [];
		if (!windows.length) return [fg("muted", "No plan usage yet")];
		return windows.flatMap((window, index) => {
			const percent = Math.max(0, Math.min(100, Math.round(window.percent ?? 0)));
			const label = index === 0 && usage.name ? `${fg("muted", usage.name)} ${fg("dim", "·")} ${fg("muted", window.label)}` : fg("muted", window.label);
			const reset = formatReset(window.resetAt);
			const right = `${host.bold(fg(tone(percent), `${percent}%`))}${reset ? ` ${fg("dim", `(${reset})`)}` : ""}`;
			const filled = Math.round((percent / 100) * inner);
			const bar = [filled && fg(tone(percent), "■".repeat(filled)), filled < inner && fg("dim", "□".repeat(inner - filled))].filter(Boolean).join("");
			return [...spread(label, right, inner), bar];
		});
	};

	// A card with its rows' hitboxes moved to where the card puts them: rows start two under the title.
	const card = (title, rows, width, titleAction) => {
		const lines = host.card(title, rows.map((row) => (typeof row === "string" ? row : row.text)), width);
		const titleLine = Math.max(0, lines.findIndex((line) => strip(line).includes(title)));
		const offset = Math.ceil((width - host.inner(width)) / 2);
		const spans = [];
		if (titleAction) spans.push({ line: titleLine, startX: 0, endX: width, action: titleAction });
		rows.forEach((row, index) => {
			for (const span of row.spans ?? []) spans.push({ ...span, line: titleLine + 2 + index, startX: span.startX + offset, endX: span.endX + offset });
		});
		return { lines, spans };
	};

	return {
		id: "prof",
		render(width) {
			if (!loading && (!data || Date.now() - loadedAt > STALE_MS)) refresh();
			const inner = Math.max(1, host.inner(width));
			let rows;
			if (!data) rows = [fg("muted", "Loading gentle-pi's profiles…")];
			else if (data.state !== "ok") rows = [fg("muted", data.message)];
			else rows = [...buttonRows(inner), fg("border", "─".repeat(inner)), ...rosterRows(inner)];
			const profiles = card(TITLE, rows, width, "profiles");
			const usage = card(USAGE_TITLE, usageRows(inner), width);
			const lines = [...profiles.lines, ...usage.lines];
			hitboxes = profiles.spans;
			return lines.map((line) => (visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…")));
		},
		handleClick(line, button, x) {
			if (button !== "left") return false;
			const hit = hitboxes.find((box) => box.line === line && x >= box.startX && x < box.endX);
			if (!hit) return false;
			if (hit.action === "toggle") {
				expanded = !expanded;
				host.requestRender();
				return true;
			}
			try {
				host.pi?.sendUserMessage?.("/gentle:profiles", { expandPromptTemplates: true });
			} catch {
				// Pi's API went away with the session: nothing to run
			}
			return true;
		},
		handleWheel() {
			return false;
		},
		onShow() {
			refresh();
		},
	};
}
