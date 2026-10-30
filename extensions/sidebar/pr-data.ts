// The PR tab's data: the repository's open pull requests from `gh pr list`, and when the current branch has one
// of them its detail from `gh pr view --json ...` with its unresolved review threads from `gh api graphql`.
// Every process call is asynchronous with a timeout; a failure comes back as a short problem for the card,
// never a throw. The tab only reads from GitHub. Parsers are pure functions.
// @ts-nocheck

import { execFile, spawn } from "node:child_process";
import type { SidebarHost } from "./tabs.ts";

/** How often the PR is read again while shown, how often the branch is probed, and the gh timeout (ms). */
export const prTiming = { refreshMs: 30_000, probeMs: 5000, timeoutMs: 10_000 };

/** What the tab runs with; tests swap these for stand-ins. */
export const prDeps = {
	execFile,
	spawn,
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (timer) => clearInterval(timer),
	now: () => Date.now(),
	open: (url) => openUrl(url),
};

const LIST_FIELDS = "number,title,url,isDraft,headRefName,author,statusCheckRollup";
const LIST_LIMIT = "30";

const FIELDS = "number,title,state,isDraft,mergeable,mergeStateStatus,url,headRefName,baseRefName,reviewDecision,statusCheckRollup,comments,reviews,latestReviews";

const THREADS_QUERY =
	"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(last:100){nodes{isResolved comments(last:1){nodes{author{login} body url createdAt}}}}}}}";

/** Opens a web link in the browser with xdg-open, detached; false when it cannot start. */
export function openUrl(url) {
	if (!/^https?:\/\//.test(String(url ?? ""))) return false;
	try {
		const child = prDeps.spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
		child.on?.("error", () => {});
		child.unref?.();
		return true;
	} catch {
		return false;
	}
}

/** `gh ...args` in `cwd`: { ok, stdout } or { ok: false, error, stderr }. */
function gh(args, cwd) {
	return new Promise((resolve) => {
		try {
			prDeps.execFile("gh", args, { cwd, encoding: "utf8", timeout: prTiming.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
				resolve(error ? { ok: false, error, stderr: String(stderr ?? "") } : { ok: true, stdout: String(stdout ?? "") }),
			);
		} catch (error) {
			resolve({ ok: false, error, stderr: "" });
		}
	});
}

/** Why a `gh pr` call failed, for the card: "none" when the branch has no PR. */
export function ghProblem(error, stderr = "") {
	const text = `${stderr}\n${error?.message ?? ""}`;
	if (error?.code === "ENOENT") return "gh is not installed";
	if (/no pull requests? found/i.test(text)) return "none";
	if (/gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(text)) return "gh is not signed in";
	if (/not a git repository/i.test(text)) return "Not a git repository";
	if (/known GitHub host|no git remotes|unable to determine (the )?(base )?repo/i.test(text)) return "Not a GitHub repository";
	if (error?.killed || error?.signal === "SIGTERM") return "gh timed out";
	const first = String(stderr || error?.message || "failed").split("\n").map((line) => line.trim()).find(Boolean) ?? "failed";
	return `gh: ${first}`;
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const SKIPPED = new Set(["SKIPPED", "NEUTRAL", "STALE"]);

/** statusCheckRollup as { name, state: passed | failed | running | skipped, url }. */
export function parseChecks(rollup = []) {
	return (Array.isArray(rollup) ? rollup : []).map((item) => {
		const name = item?.name || item?.context || "check";
		const url = item?.detailsUrl || item?.targetUrl || undefined;
		let state;
		if (item?.__typename === "StatusContext" || (item?.state && !item?.status)) {
			const value = String(item?.state ?? "").toUpperCase();
			state = value === "SUCCESS" ? "passed" : FAILED.has(value) ? "failed" : "running";
		} else if (String(item?.status ?? "").toUpperCase() !== "COMPLETED") state = "running";
		else {
			const conclusion = String(item?.conclusion ?? "").toUpperCase();
			state = conclusion === "SUCCESS" ? "passed" : SKIPPED.has(conclusion) ? "skipped" : "failed";
		}
		return { name, state, url };
	});
}

/** One summary of a PR's checks: failed when any failed, else running when any runs, else passed; none without checks. */
export function checksSummary(checks = []) {
	const counted = checks.filter((check) => check.state !== "skipped");
	if (!counted.length) return undefined;
	if (counted.some((check) => check.state === "failed")) return "failed";
	if (counted.some((check) => check.state === "running")) return "running";
	return "passed";
}

/** `gh pr list --json` as rows: { number, title, url, draft, head, author, checks }. */
export function parseList(json) {
	return (Array.isArray(json) ? json : []).map((item) => ({
		number: item?.number,
		title: String(item?.title ?? ""),
		url: item?.url,
		draft: Boolean(item?.isDraft),
		head: item?.headRefName ?? "",
		author: item?.author?.login ?? "",
		checks: checksSummary(parseChecks(item?.statusCheckRollup)),
	}));
}

const MERGE = { CLEAN: "clean", HAS_HOOKS: "clean", DIRTY: "conflicts", BLOCKED: "blocked", UNSTABLE: "unstable", BEHIND: "behind" };
const REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

/** `gh pr view --json` as the card needs it. */
export function parsePr(json) {
	const raw = String(json?.state ?? "").toUpperCase();
	const state = raw === "MERGED" ? "merged" : raw === "CLOSED" ? "closed" : json?.isDraft ? "draft" : "open";
	const live = state === "open" || state === "draft";
	let merge;
	if (live) merge = json?.mergeable === "CONFLICTING" ? "conflicts" : (MERGE[json?.mergeStateStatus] ?? (json?.mergeStateStatus === "DRAFT" ? undefined : "checking"));
	const comments = [...(json?.comments ?? []), ...(json?.reviews ?? []).filter((review) => review?.body)];
	const latest = comments.reduce((best, item) => (!best || String(item?.createdAt ?? item?.submittedAt ?? "") > String(best?.createdAt ?? best?.submittedAt ?? "") ? item : best), undefined);
	return {
		number: json?.number,
		title: String(json?.title ?? ""),
		state,
		merge,
		url: json?.url,
		head: json?.headRefName ?? "",
		base: json?.baseRefName ?? "",
		review: REVIEW[json?.reviewDecision],
		checks: parseChecks(json?.statusCheckRollup),
		comments: { count: comments.length, latest: latest && { author: latest.author?.login ?? "?", line: firstLine(latest.body), url: latest.url } },
	};
}

/** The review threads from `gh api graphql`: how many are unresolved and the latest unresolved comment. */
export function parseThreads(json) {
	const nodes = json?.data?.repository?.pullRequest?.reviewThreads?.nodes;
	if (!Array.isArray(nodes)) return undefined;
	const open = nodes.filter((node) => node && !node.isResolved).map((node) => node.comments?.nodes?.at(-1)).filter(Boolean);
	const latest = open.reduce((best, item) => (!best || String(item.createdAt ?? "") > String(best.createdAt ?? "") ? item : best), undefined);
	return { unresolved: open.length, latest: latest && { author: latest.author?.login ?? "?", line: firstLine(latest.body), url: latest.url } };
}

/** The first line of a comment with its HTML and Markdown markup taken out. */
export function firstLine(body = "") {
	const text = String(body ?? "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
	const line = text.split(/\r?\n/).map((row) => row.trim()).find(Boolean) ?? "";
	return line
		.replace(/^#+\s*/, "")
		.replace(/^>\s*/, "")
		.replace(/\*\*|__|`/g, "")
		.replace(/\\([\\`*_{}[\]()#+\-.!'])/g, "$1")
		.replace(/[\x00-\x1f\x7f]/g, "")
		.trim();
}

/** The GitHub host, owner, repository and number in a PR's URL. */
const repoOf = (url) => {
	const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(String(url ?? ""));
	return m ? { host: m[1], owner: m[2], name: m[3], number: m[4] } : undefined;
};

/**
 * Everything the tab shows for `cwd`, read once:
 *   { kind: "list", branch, current, open }   current: { pr, threads } for the branch's open PR, else undefined
 *                                             (threads undefined when graphql failed); open: the other open PRs
 *   { kind: "problem", branch, message }      no gh, signed out, not GitHub, ...
 */
export async function loadPr(host: SidebarHost, cwd) {
	let branch = "";
	try {
		branch = (await host.git(["branch", "--show-current"], cwd))?.trim() ?? "";
	} catch {
		branch = "";
	}
	const list = await gh(["pr", "list", "--state", "open", "--json", LIST_FIELDS, "--limit", LIST_LIMIT], cwd);
	if (!list.ok) {
		const problem = ghProblem(list.error, list.stderr);
		return problem === "none" ? { kind: "list", branch, current: undefined, open: [] } : { kind: "problem", branch, message: problem };
	}
	let rows;
	try {
		rows = parseList(JSON.parse(list.stdout));
	} catch {
		return { kind: "problem", branch, message: "gh: unreadable answer" };
	}
	const mine = branch ? rows.find((row) => row.head === branch) : undefined;
	const current = mine && (await loadDetail(mine.number, cwd));
	return { kind: "list", branch, current, open: current ? rows.filter((row) => row !== mine) : rows };
}

/** The detail of open PR `number`: { pr, threads }, or undefined when `gh pr view` fails. */
async function loadDetail(number, cwd) {
	const view = await gh(["pr", "view", String(number), "--json", FIELDS], cwd);
	if (!view.ok) return undefined;
	let pr;
	try {
		pr = parsePr(JSON.parse(view.stdout));
	} catch {
		return undefined;
	}
	let threads;
	const repo = repoOf(pr.url);
	if (repo) {
		const args = ["api", "graphql", ...(repo.host === "github.com" ? [] : ["--hostname", repo.host]), "-F", `owner=${repo.owner}`, "-F", `name=${repo.name}`, "-F", `number=${repo.number}`, "-f", `query=${THREADS_QUERY}`];
		const answer = await gh(args, cwd);
		if (answer.ok) {
			try {
				threads = parseThreads(JSON.parse(answer.stdout));
			} catch {
				threads = undefined;
			}
		}
	}
	return { pr, threads };
}
