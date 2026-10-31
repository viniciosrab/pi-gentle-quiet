// The PR tab of gentle-quiet's side column (the contract is in ./tabs.ts): the repository's open pull requests
// as their stack, each with the one thing it waits on, read with gh (./pr-data.ts), read-only towards GitHub.
//
// - The title counts the open PRs ("⇄ Pull requests · 4"). Every PR is one row: "#19 <title>" and flush right
//   its verdict, the most serious of ✗ conflicts, ✗ CI, ✗ changes, ⚠ N threads, ⧗ CI, ◌ draft, ⧗ review,
//   ⊘ blocked, ↓ behind, else ✓ ready. Before the verdict a PR with checks shows its CI chip, the passed checks
//   of those that count (skipped ones left out): "✓ CI 10/10", "⧗ CI 5/10", "✗ CI 9/10"; it stands for a ✗ CI
//   or ⧗ CI verdict, which is not drawn as well. The current branch's PR is marked ◉ before them.
// - The rows follow the stack: a PR whose base is another open PR's head sits under it ("├ #19", "└ #20").
//   No branch names anywhere.
// - Any number of PRs are expanded (▾, the others ▸), the current branch's PR to begin with. The detail sits
//   under its row: mergeability, review and "no checks" on one row, each check with its state, each unresolved
//   thread (severity, title, file:line; eight at most, then "+N more"), then the buttons. When PRs sit under
//   it, its detail rows carry the stack's "│" in its marker's column, down to its first "├" or "└".
// - On the current branch's PR only, when Pi's editor is there, [ Fix N threads with agent ] and [ Fix CI ]
//   (when a check failed) put the threads or the failed checks in the editor, after any draft already there;
//   nothing is sent, the user reads it and presses Enter. [ Open ] opens the PR.
// - No open PR: "No open pull requests". Without gh, signed out or outside GitHub: one dim row saying so.
//
// A click on a PR's row expands it, or closes it when it was open, the others left as they are; those choices
// stay across refreshes (all closed stays closed) and go back to the current branch's PR when the branch or the
// folder changes. A click on a check or a thread opens it in the browser (xdg-open, detached). The column
// scrolls what does not fit. The PRs are read when the tab is shown, every 30 s while it stays shown and when
// the branch changes (probed every 5 s); nothing runs while it is hidden, and render() only draws what was read.
// @ts-nocheck

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SidebarHost, SidebarTab } from "./tabs.ts";
import { checksSummary, ciPrompt, loadPr, prDeps, prTiming, stackOf, threadsPrompt, verdictOf } from "./pr-data.ts";

const TITLE = "⇄ Pull requests";
const MERGES = {
	clean: ["success", "✓ clean"],
	conflicts: ["error", "✗ conflicts"],
	blocked: ["warning", "⊘ blocked"],
	unstable: ["warning", "! unstable"],
	behind: ["warning", "↓ behind base"],
	checking: ["dim", "… checking"],
};
const CHECKS = { passed: ["success", "✓ passed"], failed: ["error", "✗ failed"], running: ["warning", "⧗ running"], skipped: ["dim", "– skipped"] };
const REVIEWS = { approved: ["success", "✓ approved"], "changes requested": ["error", "✗ changes requested"], "review required": ["warning", "⧗ review required"] };
const VERDICTS = {
	conflicts: ["error", "✗ conflicts"],
	"ci-failed": ["error", "✗ CI"],
	changes: ["error", "✗ changes"],
	"ci-running": ["warning", "⧗ CI"],
	draft: ["dim", "◌ draft"],
	review: ["warning", "⧗ review"],
	blocked: ["warning", "⊘ blocked"],
	behind: ["warning", "↓ behind"],
	ready: ["success", "✓ ready"],
};
const CHIPS = { passed: ["success", "✓"], failed: ["error", "✗"], running: ["warning", "⧗"] };
const MAX_THREADS = 8;

export function createTab(host: SidebarHost): SidebarTab {
	const state = {
		cwd: undefined,
		result: undefined, // the last read (pr-data's loadPr), kept while the next one runs
		branch: undefined, // the branch of the last read
		expanded: undefined, // the expanded PRs' numbers (a Set, maybe empty); undefined: the current branch's PR
		loading: undefined,
		queued: false,
		loadedAt: undefined,
		renderedAt: 0,
		timer: undefined,
		probing: false,
		hits: new Map(), // line -> { toggle } | { url } | { spans }
		disposed: false,
	};

	const c = (role, text) => host.fg(role, text);

	// One read at a time; a request while one runs reads again right after it.
	const refresh = () => {
		if (state.disposed) return;
		const cwd = host.cwd();
		if (cwd !== state.cwd) {
			state.cwd = cwd;
			state.result = undefined;
			state.branch = undefined;
			state.expanded = undefined;
		}
		if (!cwd) return;
		if (state.loading) {
			state.queued = true;
			return;
		}
		state.loadedAt = prDeps.now();
		state.loading = loadPr(host, cwd)
			.catch((error) => ({ kind: "problem", message: `gh: ${error?.message ?? error}` }))
			.then((result) => {
				state.loading = undefined;
				if (state.disposed) return;
				if (cwd === state.cwd) {
					if (state.result && (result.branch ?? "") !== (state.branch ?? "")) state.expanded = undefined;
					else if (state.expanded && result.kind === "list") state.expanded = expandedOf(result); // the PRs gone drop out
					state.result = result;
					state.branch = result.branch;
				}
				host.requestRender(); // also tells the timer the tab is still drawn
				if (state.queued) {
					state.queued = false;
					refresh();
				}
			});
	};

	const stop = () => {
		if (state.timer) prDeps.clearInterval(state.timer);
		state.timer = undefined;
	};

	// Every 5 s: read again after 30 s or when the branch changed. The tab cannot always see itself hidden
	// (the column closes under the breakpoint), so the timer stops when no frame came for that long.
	const tick = () => {
		if (state.disposed) return stop();
		const now = prDeps.now();
		if (now - state.renderedAt > prTiming.refreshMs + prTiming.probeMs) return stop();
		if (state.loadedAt === undefined || now - state.loadedAt >= prTiming.refreshMs || host.cwd() !== state.cwd) return refresh();
		if (state.probing || state.loading) return;
		state.probing = true;
		Promise.resolve()
			.then(() => host.git(["branch", "--show-current"], state.cwd))
			.catch(() => undefined)
			.then((out) => {
				state.probing = false;
				const branch = out?.trim() ?? "";
				if (state.result && branch !== (state.result.branch ?? "")) refresh();
			});
	};

	const start = () => {
		if (state.timer || state.disposed) return;
		state.timer = prDeps.setInterval(tick, prTiming.probeMs);
		state.timer?.unref?.();
	};

	// `left` cut to leave room for `right`, which sits against the right edge of `inner` columns.
	const spread = (left, right, inner) => {
		const room = Math.max(0, inner - (right ? visibleWidth(right) + 1 : 0));
		const cut = visibleWidth(left) > room ? truncateToWidth(left, room, "…") : left;
		return `${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut) - visibleWidth(right)))}${right}`;
	};
	const badge = ([role, text]) => c(role, text);
	// `head` then the plain `text` painted in `role`, the text cut first so the head keeps its colors.
	const tail = (head, role, text, right, inner) => {
		const room = Math.max(0, inner - visibleWidth(head) - (right ? visibleWidth(right) + 1 : 0));
		return `${head}${c(role, visibleWidth(text) > room ? truncateToWidth(text, room, "…") : text)}`;
	};

	// The PRs whose detail is shown: the ones clicked open that are still listed, else the current branch's PR.
	const expandedOf = ({ prs, current }) => {
		if (state.expanded === undefined) return new Set(current === undefined ? [] : [current]);
		return new Set(prs.filter((pr) => state.expanded.has(pr.number)).map((pr) => pr.number));
	};

	// The CI chip, "⧗ CI 5/10": passed of the checks that count; none without such checks.
	const ciChip = (pr) => {
		const summary = checksSummary(pr.checks);
		if (!summary) return "";
		const counted = pr.checks.filter((check) => check.state !== "skipped");
		const passed = counted.filter((check) => check.state === "passed").length;
		const [role, icon] = CHIPS[summary];
		return c(role, `${icon} CI ${passed}/${counted.length}`);
	};

	const verdictText = (verdict) => {
		if (verdict.kind !== "threads") return badge(VERDICTS[verdict.kind]);
		if (!verdict.count) return c("warning", "⚠ threads?");
		const many = verdict.count !== 1 || verdict.partial;
		return c("warning", `⚠ ${verdict.count}${verdict.partial ? "+" : ""} ${many ? "threads" : "thread"}`);
	};

	// The CI chip then the verdict, the chip alone when the verdict is about CI.
	const verdictBadge = (pr) => {
		const verdict = verdictOf(pr);
		const chip = ciChip(pr);
		if (chip && (verdict.kind === "ci-failed" || verdict.kind === "ci-running")) return chip;
		return [chip, verdictText(verdict)].filter(Boolean).join(" ");
	};

	// Pi's editor, when this session has one an extension may fill.
	const editorUi = () => {
		const ui = host.ctx()?.ui;
		return typeof ui?.setEditorText === "function" ? ui : undefined;
	};

	// The prompt goes in the editor after a draft already there; nothing is sent.
	const fill = (prompt) => {
		const ui = editorUi();
		if (!ui) return false;
		const draft = ui.getEditorText?.();
		ui.setEditorText(typeof draft === "string" && draft.trim() ? `${draft.trimEnd()}\n\n${prompt}` : prompt);
		return true;
	};

	// Buttons in accent two apart, a new row when the next one does not fit `inner`.
	const buttonBar = (buttons, inner) => {
		const rows = [];
		let row;
		for (const { label, action } of buttons) {
			const text = `[ ${label} ]`;
			const len = visibleWidth(text);
			if (!row || row.width + 2 + len > inner) rows.push((row = { parts: [], spans: [], width: 0 }));
			const startX = row.width ? row.width + 2 : 0;
			row.parts.push(c("accent", text));
			row.spans.push({ startX, endX: startX + len, action });
			row.width = startX + len;
		}
		return rows.map(({ parts, spans }) => ({ text: parts.join("  "), spans }));
	};

	// The expanded PR's rows under its own, each led by `indent`.
	const detailRows = (pr, isCurrent, indent, inner) => {
		const lead = visibleWidth(indent);
		const room = Math.max(1, inner - lead);
		const rows = [];
		const push = (row) => rows.push({ ...row, left: `${c("dim", indent)}${spread(row.left, row.right ?? "", room)}`, right: undefined });

		const merge = pr.merge && MERGES[pr.merge];
		const facts = [pr.draft && badge(VERDICTS.draft), merge && badge(merge), pr.review ? badge(REVIEWS[pr.review]) : c("dim", "no review yet"), !pr.checks.length && c("dim", "no checks")];
		push({ left: facts.filter(Boolean).join(c("dim", " · ")) });

		for (const check of pr.checks) {
			const right = badge(CHECKS[check.state] ?? CHECKS.running);
			push({ left: tail("", "text", check.name, right, room), right, hit: check.url && { url: check.url } });
		}

		for (const thread of pr.threads.slice(0, MAX_THREADS)) {
			const severity = thread.severity && c(/^P[01]$/.test(thread.severity) ? "error" : "warning", thread.severity);
			const where = thread.path ? `${thread.path.split("/").pop()}${thread.line ? `:${thread.line}` : ""}` : "";
			const right = where && c("dim", where);
			const left = tail(`${[c("warning", "●"), severity].filter(Boolean).join(" ")} `, "text", thread.title || "…", right, room);
			push({ left, right, hit: thread.url && { url: thread.url } });
		}
		if (pr.threads.length > MAX_THREADS) push({ left: c("dim", `+${pr.threads.length - MAX_THREADS} more`), hit: { url: pr.url } });

		// The agent's buttons, then [ Open ] on its own row.
		const fixes = [];
		if (isCurrent && editorUi()) {
			const count = pr.threads.length;
			const many = count !== 1 || pr.threadsPartial;
			if (count) fixes.push({ label: `Fix ${count}${pr.threadsPartial ? "+" : ""} ${many ? "threads" : "thread"} with agent`, action: () => fill(threadsPrompt(pr)) });
			if (pr.checks.some((check) => check.state === "failed")) fixes.push({ label: "Fix CI", action: () => fill(ciPrompt(pr)) });
		}
		const bars = [...buttonBar(fixes, room), ...buttonBar([{ label: "Open", action: () => prDeps.open(pr.url) }], room)];
		for (const bar of bars) {
			rows.push({ left: `${c("dim", indent)}${bar.text}`, hit: { spans: bar.spans.map((span) => ({ ...span, startX: span.startX + lead, endX: span.endX + lead })) } });
		}
		return rows;
	};

	const listRows = (result, inner) => {
		const open = expandedOf(result);
		const rows = [];
		const stack = stackOf(result.prs, result.owner);
		stack.forEach(({ pr, prefix, cont, depth }, index) => {
			const isCurrent = pr.number === result.current;
			const isOpen = open.has(pr.number);
			const hasKids = (stack[index + 1]?.depth ?? 0) > depth; // the guide sits under the marker, where they start
			const right = `${isCurrent ? `${c("accent", "◉")} ` : ""}${verdictBadge(pr)}`;
			const left = tail(`${c("dim", `${prefix}${isOpen ? "▾" : "▸"}`)} ${c("accent", `#${pr.number}`)} `, "text", pr.title, right, inner);
			rows.push({ left, right, hit: { toggle: pr.number } });
			if (isOpen) rows.push(...detailRows(pr, isCurrent, `${cont}${hasKids ? "│" : " "} `, inner));
		});
		if (!rows.length) rows.push({ left: c("muted", "No open pull requests") });
		return rows;
	};

	return {
		id: "pr",

		render(width) {
			state.renderedAt = prDeps.now();
			if (!state.timer && !state.disposed) {
				start();
				if (state.loadedAt === undefined || state.renderedAt - state.loadedAt >= prTiming.refreshMs) refresh();
			}
			if (host.cwd() !== state.cwd) refresh();
			const inner = Math.max(1, host.inner(width));
			const result = state.result;
			let rows;
			if (!state.cwd) rows = [{ left: c("dim", "No working directory") }];
			else if (!result) rows = [{ left: c("dim", "refreshing…") }];
			else if (result.kind === "problem") rows = [{ left: c("dim", result.message) }];
			else rows = listRows(result, inner);
			const title = result?.kind === "list" && result.prs.length ? `${TITLE} · ${result.prs.length}` : TITLE;
			const offset = (host.box([], width).length ? 1 : 0) + 2; // the outline's top, the title and its blank row
			const left = Math.ceil((width - host.inner(width)) / 2); // the outline's columns before a row
			state.hits = new Map();
			rows.forEach((row, index) => {
				if (!row.hit) return;
				const hit = row.hit.spans ? { spans: row.hit.spans.map((span) => ({ ...span, startX: span.startX + left, endX: span.endX + left })) } : row.hit;
				state.hits.set(offset + index, hit);
			});
			return host.card(title, rows.map((row) => spread(row.left, row.right ?? "", inner)), width);
		},

		handleClick(line, button, x) {
			if (button !== "left") return false;
			const hit = state.hits.get(line);
			if (!hit) return false;
			if (hit.toggle !== undefined) {
				const result = state.result;
				const open = result?.kind === "list" ? expandedOf(result) : new Set();
				if (!open.delete(hit.toggle)) open.add(hit.toggle);
				state.expanded = open;
				return true;
			}
			if (hit.url) {
				prDeps.open(hit.url);
				return true;
			}
			const span = hit.spans?.find((item) => x >= item.startX && x < item.endX);
			if (!span) return false;
			span.action();
			return true;
		},

		// The column scrolls the card when it does not fit.
		handleWheel() {
			return false;
		},

		onShow() {
			refresh();
			start();
		},

		onHide() {
			stop();
		},

		dispose() {
			state.disposed = true;
			stop();
		},
	};
}
