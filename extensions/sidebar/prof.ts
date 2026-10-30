// The PROF tab of gentle-quiet's side column (the contract is in ./tabs.ts), after pi-cinlodev-cute's
// profiles card (src/profiles/profiles-card.ts) filled with gentle-pi's own profiles instead of
// pi-sdd-profiles, and gentle-quiet's plan usage instead of CLIProxyAPI's quotas. Two cards:
//
//   Profiles     one button per saved profile, "[★ 2: Max]", wrapped at most three rows deep with cute's
//                [▼]/[▲] toggle for the rest; gentle-pi's marks: ◉ this session, ★ default for new
//                sessions, ⌂ this repository; the selected profile in accent bold, "•" in warning when it
//                has unsaved edits. Under a rule, its routing: the orchestrator first, then each subagent
//                with its model and effort (an unsaved value in warning). Under the routing, gentle-pi's
//                screen's buttons "[ Use in this session ]  [ Make default ]  [ Save ]" (wrapped when the
//                column is narrow; Save dim with nothing to save), and "● N unsaved" when there are edits.
//   Plan usage   each window of the plan usage the Context card shows as cute's quota gauge: the label,
//                the percent used and the reset on one row, a bar across the card under it.
//
// Editing works as gentle-pi's /gentle:profiles screen, through its own writers (./prof-data.ts profileEditor):
// a click on a profile selects the one shown (it starts on the profile in effect, the session's first); a click
// on an agent's model (or the orchestrator's) opens a picker of Pi's models under the row (./prof-picker.ts), a
// click on an effort steps to the next level gentle-pi offers for that model; both are staged in memory until
// [ Save ] writes them (gentle-pi's Save). [ Use in this session ] saves staged edits first and binds the profile
// to this session, as the screen does. Leaving a profile with unsaved edits asks as the screen does, under the
// profiles: "[ Save and switch ]  [ Discard ]  [ Stay ]". [ Make default ] saves staged edits (the screen saves
// first too) and opens /gentle:profiles: gentle-pi keeps its global apply inside that command (confirmation, the
// models.json diff, the repository pin, rollback) and exports no way to run it from here. A click on the
// Profiles title opens gentle-pi's full editor, and so does every click when this gentle-pi does not export the
// writers or Gentle Shell is on. The wheel is left to the column.
// The data is read in ./prof-data.ts when the tab is shown, never while it draws.
// @ts-nocheck

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { changeCount, loadProfiles, PROF_TIMEOUTS, profileEditor, stageEdit, thinkingSupport } from "./prof-data.ts";
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
// gentle-pi's screen's button labels (ROUTING_TABLE_BUTTONS).
const BUTTONS = { use: "Use in this session", default: "Make default", save: "Save", "switch-save": "Save and switch", "switch-discard": "Discard", "switch-stay": "Stay" };
const plural = (count) => `${count} unsaved change${count === 1 ? "" : "s"}`;

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
	let selected; // the profile shown in the card; undefined is the one in effect
	let draft; // { name, config }: staged edits, written by Save
	let leaving; // the profile a click asked for while the shown one has unsaved edits

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
			// A profile gone from gentle-pi's store (renamed, deleted elsewhere) takes its selection and edits with it.
			const names = data?.state === "ok" ? data.names : [];
			if (!names.includes(selected)) selected = undefined;
			if (draft && !names.includes(draft.name)) draft = undefined;
			if (!names.includes(leaving)) leaving = undefined;
			if (again) {
				again = false;
				refresh();
			}
			if (changed) host.requestRender();
		});
	};

	// The profile on the card, its saved routing, and the routing the card shows (with the staged edits).
	const current = () => (data?.state === "ok" && data.names.includes(selected) ? selected : data?.shown);
	const savedConfig = (name) => data?.configs?.[name] ?? {};
	const shownConfig = (name) => (draft?.name === name ? draft.config : savedConfig(name));
	const unsaved = (name) => (draft?.name === name ? changeCount(savedConfig(name), draft.config) : 0);

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
		const shown = current();
		const buttons = data.names.map((name, index) => {
			const own = marks(name);
			const glyphs = own.map(([, glyph]) => glyph).join("") || "○";
			const dirty = unsaved(name) > 0;
			const raw = `[${glyphs} ${index + 1}: ${name}${dirty ? " •" : ""}]`;
			const dot = dirty ? ` ${fg("warning", "•")}` : "";
			const styled =
				name === shown
					? dirty
						? `${fg("accent", host.bold(`[${glyphs} ${index + 1}: ${name}`))}${dot}${fg("accent", host.bold("]"))}`
						: fg("accent", host.bold(raw))
					: `${fg("dim", "[")}${own.length ? own.map(([, glyph, role]) => fg(role, glyph)).join("") : fg("dim", "○")}${fg("dim", ` ${index + 1}: `)}${fg("muted", name)}${dot}${fg("dim", "]")}`;
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
		const visible = paged && !expanded ? wrapped.slice(0, MAX_PROFILE_ROWS) : wrapped;
		const toggle = expanded ? "[▲]" : "[▼]";
		return visible.map((buttons, index) => {
			const last = paged && index === visible.length - 1;
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
				spans.push({ startX: x, endX: x + button.len, action: "select", name: button.name });
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

	// gentle-pi's footer buttons, "[ label ]" two apart, wrapped onto more rows when the card is narrow.
	const buttonBar = (buttons, inner) => {
		const rows = [];
		let row;
		for (const { id, role, strong } of buttons) {
			const text = `[ ${BUTTONS[id]} ]`;
			const len = visibleWidth(text);
			if (!row || row.width + 2 + len > inner) rows.push((row = { parts: [], spans: [], width: 0 }));
			const startX = row.width ? row.width + 2 : 0;
			row.parts.push(strong ? host.bold(fg(role, text)) : fg(role, text));
			row.spans.push({ startX, endX: startX + len, action: id });
			row.width = startX + len;
		}
		return rows.map(({ parts, spans, width }) => ({ text: parts.join("  "), spans, width }));
	};

	// Use in this session, Make default, Save; "● N unsaved" on the right, on a row of its own when it does not fit.
	const footerRows = (inner) => {
		const changes = unsaved(current());
		const rows = buttonBar(
			[
				{ id: "use", role: "accent" },
				{ id: "default", role: "accent" },
				changes ? { id: "save", role: "accent", strong: true } : { id: "save", role: "dim" },
			],
			inner,
		);
		if (!changes) return rows;
		const status = `● ${changes} unsaved`;
		const last = rows.at(-1);
		const gap = inner - last.width - visibleWidth(status);
		if (gap >= 2) last.text += `${" ".repeat(gap)}${fg("warning", status)}`;
		else rows.push(`${" ".repeat(Math.max(0, inner - visibleWidth(status)))}${fg("warning", status)}`);
		return rows;
	};

	// gentle-pi's question on leaving a profile with unsaved edits, under the profiles.
	const leavingRows = (inner) => {
		const name = current();
		return [
			`${fg("accent", host.bold(name))} ${fg("text", `has ${plural(unsaved(name))}.`)}`,
			...buttonBar(
				[
					{ id: "switch-save", role: "accent", strong: true },
					{ id: "switch-discard", role: "accent" },
					{ id: "switch-stay", role: "dim" },
				],
				inner,
			),
		];
	};

	const rosterRows = (inner) => {
		const name = current();
		const saved = savedConfig(name);
		const config = shownConfig(name);
		const edited = (agent, field) => (saved[agent]?.[field] ?? undefined) !== (config[agent]?.[field] ?? undefined);
		const modelPart = (agent, value, unset = INHERIT) => {
			const set = value !== undefined && value !== INHERIT;
			const label = set ? shortModel(value) : unset;
			const role = edited(agent, "model") ? "warning" : set ? "text" : "dim";
			return { styled: fg(role, label), len: visibleWidth(label), action: "model", agent, model: set ? value : undefined };
		};
		const effortPart = (agent, model, thinking) => {
			const label = `(${thinking ?? INHERIT})`;
			const role = edited(agent, "thinking") ? "warning" : "dim";
			return { styled: fg(role, label), len: visibleWidth(label), action: "effort", agent, model, thinking: thinking === INHERIT ? undefined : thinking };
		};
		const view = data.view ? data.view(config) : { orchestrator: data.orchestrator, rows: data.rows };
		const orchestrator = view.orchestrator;
		const head = `${fg("accent", "◆")} ${host.bold("orchestrator")}`;
		const rows = spreadParts(
			head,
			orchestrator?.model
				? [modelPart(ORCHESTRATOR, orchestrator.model), effortPart(ORCHESTRATOR, orchestrator.model, orchestrator.thinking)]
				: [modelPart(ORCHESTRATOR, undefined, UNTOUCHED)],
			inner,
		);
		rows.push("");
		if (!view.rows.length) rows.push(fg("dim", "no subagents routed"));
		for (const entry of view.rows) {
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

	const notify = (message, level = "info") => {
		try {
			host.ctx()?.ui?.notify?.(message, level);
		} catch {
			// a stale ctx: nothing to tell
		}
	};

	// One edit staged on the shown profile, as gentle-pi's screen keeps it in its draft until Save.
	const stage = (name, key, change) => {
		const next = stageEdit(shownConfig(name), key, change);
		if (next.error) notify(next.error, "warning");
		else draft = { name, config: next.config };
		host.requestRender();
	};

	// The effort after `hit.thinking`: inherit, then the levels gentle-pi offers for the row's model, wrapping.
	const nextEffort = async (profile, hit) => {
		const levels = [INHERIT, ...(await editor.efforts(hit.model))];
		const next = levels[(levels.indexOf(hit.thinking ?? INHERIT) + 1) % levels.length];
		stage(profile, hit.agent, { thinking: next === INHERIT ? undefined : next });
	};

	// The staged edits written (gentle-pi's Save); the card keeps showing them as saved until gentle-pi is read again.
	const save = async (name) => {
		const outcome = await editor.save(name, shownConfig(name));
		if (outcome.ok && draft?.name === name) {
			if (data?.configs) data.configs[name] = draft.config;
			draft = undefined;
		}
		return outcome;
	};

	// gentle-pi's three buttons and its leave-with-unsaved-edits answers.
	const press = async (id) => {
		const name = current();
		const changes = unsaved(name);
		switch (id) {
			case "save":
				return changes ? save(name) : { ok: true, message: "Nothing to save." };
			case "use": {
				const outcome = await editor.use(name, changes ? draft.config : undefined);
				if (outcome.ok && changes) {
					if (data?.configs) data.configs[name] = draft.config;
					draft = undefined;
				}
				return outcome;
			}
			case "default": {
				const saved = changes ? await save(name) : undefined;
				if (saved && !saved.ok) return saved;
				openEditor();
				return { ok: true, message: `${saved ? `Saved "${name}". ` : ""}Make default is in gentle-pi's screen: on "${name}", press [ Make default ].` };
			}
			case "switch-save": {
				const saved = await save(name);
				if (!saved.ok) return saved;
				selected = leaving;
				leaving = undefined;
				return { ok: true, message: `Saved "${name}". Showing "${selected}".` };
			}
			case "switch-discard":
				draft = undefined;
				selected = leaving;
				leaving = undefined;
				return undefined;
			case "switch-stay":
				leaving = undefined;
				return undefined;
		}
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
			else rows = [...buttonRows(inner), ...(leaving ? leavingRows(inner) : []), fg("border", "─".repeat(inner)), ...rosterRows(inner), "", ...footerRows(inner)];
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
			if (hit.action === "select") {
				// gentle-pi's tabs: leaving a profile with unsaved edits asks first; nothing is lost in silence.
				if (hit.name === current()) leaving = undefined;
				else if (unsaved(current())) leaving = hit.name;
				else selected = hit.name;
				host.requestRender();
				return true;
			}
			if (hit.action in BUTTONS) return done(press(hit.action));
			leaving = undefined; // an edit answers the question with Stay
			const profile = current();
			if (hit.action === "effort") {
				nextEffort(profile, hit);
				return true;
			}
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
					onPick: (choice) => stage(profile, hit.agent, { model: choice === untouched ? undefined : choice }),
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
