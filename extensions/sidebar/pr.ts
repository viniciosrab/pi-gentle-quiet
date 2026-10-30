// The PR tab of gentle-quiet's side column (the contract is in ./tabs.ts): the repository's open pull requests
// and CI in one card, read with gh (./pr-data.ts), read-only towards GitHub.
//
// - The current branch's PR, when it is open, first with its detail:
//   - "#17 <title>", its state (open, draft) and mergeability.
//   - Checks: one row per check with its state flush right (✓ passed, ✗ failed, ⧗ running, – skipped),
//     counted in the section title ("Checks 2/3").
//   - Reviews: the review decision, the unresolved review comments and the latest one's author and first line.
// - The other open PRs, one row each: "#21 <title>" and flush right its checks summary (✓ all passed, ✗ one
//   failed, ⧗ one running, nothing without checks), "draft" before it for drafts. Under an "Open pull requests"
//   title after the detail. No branch names and no ahead/behind counts.
// - No open PR: "No open pull requests". Without gh, signed out or outside GitHub: one dim row saying so.
//
// A click on a PR's rows opens it in the browser, on a check its details link, on the latest comment the
// comment (xdg-open, detached). The column scrolls what does not fit. The PRs are read when the tab is shown,
// every 30 s while it stays shown and when the branch changes (probed every 5 s); nothing runs while it is
// hidden, and render() only draws what was read.
// @ts-nocheck

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SidebarHost, SidebarTab } from "./tabs.ts";
import { loadPr, prDeps, prTiming } from "./pr-data.ts";

const TITLE = "⇄ Pull requests";
const STATES = { open: ["success", "● open"], draft: ["dim", "◌ draft"], merged: ["accent", "● merged"], closed: ["error", "● closed"] };
const MERGES = {
	clean: ["success", "✓ clean"],
	conflicts: ["error", "✗ conflicts"],
	blocked: ["warning", "⊘ blocked"],
	unstable: ["warning", "! unstable"],
	behind: ["warning", "↓ behind base"],
	checking: ["dim", "… checking"],
};
const CHECKS = { passed: ["success", "✓ passed"], failed: ["error", "✗ failed"], running: ["warning", "⧗ running"], skipped: ["dim", "– skipped"] };
const SUMMARY = { passed: ["success", "✓"], failed: ["error", "✗"], running: ["warning", "⧗"] };
const REVIEWS = { approved: ["success", "✓ approved"], "changes requested": ["error", "✗ changes requested"], "review required": ["warning", "⧗ review required"] };

export function createTab(host: SidebarHost): SidebarTab {
	const state = {
		cwd: undefined,
		result: undefined, // the last read (pr-data's loadPr), kept while the next one runs
		loading: undefined,
		queued: false,
		loadedAt: undefined,
		renderedAt: 0,
		timer: undefined,
		probing: false,
		hits: new Map(), // line -> url
		disposed: false,
	};

	const c = (role, text) => host.fg(role, text);
	const title = (text) => c("toolTitle", host.bold(text));
	const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

	// One read at a time; a request while one runs reads again right after it.
	const refresh = () => {
		if (state.disposed) return;
		const cwd = host.cwd();
		if (cwd !== state.cwd) {
			state.cwd = cwd;
			state.result = undefined;
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
				if (cwd === state.cwd) state.result = result;
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

	const prRows = ({ pr, threads }) => {
		const rows = [];
		rows.push({ left: `${c("accent", `#${pr.number}`)} ${c("text", pr.title)}`, url: pr.url });
		const merge = pr.merge && MERGES[pr.merge];
		rows.push({ left: [badge(STATES[pr.state] ?? STATES.open), merge && badge(merge)].filter(Boolean).join(c("dim", " · ")), url: pr.url });

		const checks = pr.checks;
		const counted = checks.filter((check) => check.state !== "skipped");
		const passed = counted.filter((check) => check.state === "passed").length;
		const role = checks.some((check) => check.state === "failed") ? "error" : checks.some((check) => check.state === "running") ? "warning" : "success";
		rows.push({ left: "" }, { left: checks.length ? `${title("Checks")} ${c(role, `${passed}/${counted.length}`)}` : title("Checks") });
		if (!checks.length) rows.push({ left: c("dim", "No checks") });
		for (const check of checks) rows.push({ left: c("text", check.name), right: badge(CHECKS[check.state] ?? CHECKS.running), url: check.url });

		rows.push({ left: "" }, { left: title("Reviews") });
		rows.push({ left: pr.review ? badge(REVIEWS[pr.review]) : c("dim", "no review decision") });
		const latest = threads ? threads.latest : pr.comments.latest;
		if (threads) rows.push({ left: threads.unresolved ? c("warning", `● ${plural(threads.unresolved, "unresolved comment", "unresolved comments")}`) : c("success", "✓ no unresolved comments") });
		else rows.push({ left: `${c("muted", plural(pr.comments.count, "comment", "comments"))} ${c("dim", "· review threads unavailable")}` });
		if (latest) rows.push({ left: `${c("accent", latest.author)}${c("dim", ":")} ${c("text", latest.line || "…")}`, url: latest.url });
		return rows;
	};

	const listRows = ({ current, open }) => {
		const rows = current ? prRows(current) : [];
		if (current && open.length) rows.push({ left: "" }, { left: `${title("Open pull requests")} ${c("muted", String(open.length))}` });
		for (const item of open) {
			const right = [item.draft && c("dim", "draft"), item.checks && badge(SUMMARY[item.checks])].filter(Boolean).join(" ");
			rows.push({ left: `${c("accent", `#${item.number}`)} ${c("text", item.title)}`, right, url: item.url });
		}
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
			else rows = listRows(result);
			const offset = (host.box([], width).length ? 1 : 0) + 2; // the outline's top, the title and its blank row
			state.hits = new Map();
			rows.forEach((row, index) => {
				if (row.url) state.hits.set(offset + index, row.url);
			});
			return host.card(TITLE, rows.map((row) => spread(row.left, row.right ?? "", inner)), width);
		},

		handleClick(line, button) {
			if (button !== "left") return false;
			const url = state.hits.get(line);
			if (!url) return false;
			prDeps.open(url);
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
