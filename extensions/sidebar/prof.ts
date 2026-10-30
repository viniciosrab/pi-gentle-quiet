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
// Editing happens in the card, through gentle-pi's own writers (./prof-data.ts profileEditor), without its
// screen: a click on a profile uses it in this session (gentle-pi's "Use in this session"); a click on an
// agent's model (or the orchestrator's) opens a picker of Pi's models under the row (./prof-picker.ts), and
// the choice is saved in the shown profile (gentle-pi's Save); a click on an effort steps to the next level
// gentle-pi offers for that model, saved the same way. The card is read again after each change. A click on
// the Profiles title opens gentle-pi's full editor (/gentle:profiles), and so does every click when this
// gentle-pi does not export the writers or Gentle Shell is on. Make default is not offered here: gentle-pi
// keeps it inside its command (confirmation, models.json, rollback). The wheel is left to the column.
// The data is read in ./prof-data.ts when the tab is shown, never while it draws.
// @ts-nocheck

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadProfiles, PROF_TIMEOUTS, profileEditor, thinkingSupport } from "./prof-data.ts";
import { openPicker } from "./prof-picker.ts";
import type { SidebarHost, SidebarTab } from "./tabs.ts";

export { PROF_TIMEOUTS, thinkingSupport };

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
const ORCHESTRATOR = "orchestrator";
const INHERIT = "inherit";
const UNTOUCHED = "leave untouched"; // gentle-pi's inherit for the orchestrator
const COMMAND = "/gentle:profiles";

export function createTab(host: SidebarHost): SidebarTab {
	const fg = (role, text) => host.fg(role, text);
	let data; // what prof-data.ts read last
	let loadedAt = 0;
	let loading = false;
	let again = false; // a refresh asked for while one was running
	let expanded = false;
	let hitboxes = []; // { line, startX, endX, action, ... }
	let editor; // gentle-pi's writers (./prof-data.ts profileEditor), once resolved; undefined runs the command
	let editorLoad;

	const refresh = () => {
		if (loading) {
			again = true;
			return;
		}
		loading = true;
		editorLoad ??= profileEditor(host).then((found) => (editor = found));
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
			return { styled, len: visibleWidth(raw), name };
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
				spans.push({ startX: x, endX: x + button.len, action: "use", name: button.name });
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

	// spread() for a row whose right side is clickable parts ({ styled, len, ...hit }), joined by a space.
	const spreadParts = (left, parts, inner) => {
		const right = parts.map((part) => part.styled).join(" ");
		const width = parts.reduce((sum, part) => sum + part.len, 0) + parts.length - 1;
		const rows = spread(left, right, inner);
		let x = rows.length === 1 ? inner - width : 2;
		const spans = [];
		for (const { styled, len, ...hit } of parts) {
			if (hit.action) spans.push({ startX: x, endX: x + len, ...hit });
			x += len + 1;
		}
		return rows.length === 1 ? [{ text: rows[0], spans }] : [rows[0], { text: rows[1], spans }];
	};

	const rosterRows = (inner) => {
		const modelPart = (agent, value, unset = INHERIT) => {
			const set = value !== undefined && value !== INHERIT;
			const label = set ? shortModel(value) : unset;
			return { styled: set ? fg("text", label) : fg("dim", label), len: visibleWidth(label), action: "model", agent, model: set ? value : undefined };
		};
		const effortPart = (agent, model, thinking) => {
			const label = `(${thinking ?? INHERIT})`;
			return { styled: fg("dim", label), len: visibleWidth(label), action: "effort", agent, model, thinking: thinking === INHERIT ? undefined : thinking };
		};
		const orchestrator = data.orchestrator;
		const head = `${fg("accent", "◆")} ${host.bold("orchestrator")}`;
		const rows = spreadParts(
			head,
			orchestrator?.model
				? [modelPart(ORCHESTRATOR, orchestrator.model), effortPart(ORCHESTRATOR, orchestrator.model, orchestrator.thinking)]
				: [modelPart(ORCHESTRATOR, undefined, UNTOUCHED)],
			inner,
		);
		rows.push("");
		if (!data.rows.length) rows.push(fg("dim", "no subagents routed"));
		for (const entry of data.rows) {
			const family = FAMILIES.find(([prefix]) => entry.agent.startsWith(prefix))?.[1];
			const left = `${fg(family ?? "muted", "•")} ${fg(family ?? "text", entry.agent)}`;
			const model = entry.model === INHERIT ? undefined : entry.model;
			rows.push(...spreadParts(left, [modelPart(entry.agent, model), effortPart(entry.agent, model, entry.thinking)], inner));
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

	const openEditor = () => {
		try {
			host.pi?.sendUserMessage?.(COMMAND, { expandPromptTemplates: true });
		} catch {
			// Pi's API went away with the session: nothing to run
		}
		return true;
	};

	// An edit's outcome: said in Pi's notice line, then the card read again from gentle-pi.
	const done = (pending) => {
		Promise.resolve(pending).then((outcome) => {
			try {
				if (outcome?.message) host.ctx()?.ui?.notify?.(outcome.message, outcome.ok ? "info" : "warning");
			} catch {
				// a stale ctx: the card still refreshes
			}
			refresh();
		});
		return true;
	};

	// The effort after `hit.thinking`: inherit, then the levels gentle-pi offers for the row's model, wrapping.
	const nextEffort = async (profile, hit) => {
		const levels = [INHERIT, ...(await editor.efforts(hit.model))];
		const next = levels[(levels.indexOf(hit.thinking ?? INHERIT) + 1) % levels.length];
		return editor.set(profile, hit.agent, { thinking: next === INHERIT ? undefined : next });
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
		handleClick(line, button, x, event) {
			if (button !== "left") return false;
			const hit = hitboxes.find((box) => box.line === line && x >= box.startX && x < box.endX);
			if (!hit) return false;
			if (hit.action === "toggle") {
				expanded = !expanded;
				host.requestRender();
				return true;
			}
			if (hit.action === "profiles" || !editor || data?.state !== "ok") return openEditor();
			if (hit.action === "use") return done(editor.use(hit.name));
			const profile = data.shown;
			if (hit.action === "effort") return done(nextEffort(profile, hit));
			const untouched = hit.agent === ORCHESTRATOR ? UNTOUCHED : INHERIT;
			const ctx = (() => {
				try {
					return host.ctx();
				} catch {
					return undefined;
				}
			})();
			editor.models().then((models) => {
				const opened = openPicker(ctx, {
					title: `Model · ${hit.agent} · ${profile}`,
					choices: [untouched, ...models],
					current: hit.model ?? untouched,
					at: event && { screenX: event.screenX, screenY: event.screenY, x: event.x ?? x },
					onPick: (choice) => done(editor.set(profile, hit.agent, { model: choice === untouched ? undefined : choice })),
				});
				if (!opened) openEditor(); // no overlay UI here: gentle-pi's screen instead
			});
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
