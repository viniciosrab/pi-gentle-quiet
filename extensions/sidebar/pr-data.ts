// The PR tab's data: every open pull request of the repository from one `gh api graphql` call, with its base
// and head, mergeability, review decision, checks and unresolved review threads; the current branch's PR among
// them (matched by branch and head repository), its stack, its verdict and the prompts that hand its threads or
// failed checks to the agent. The process call is asynchronous with a timeout; a failure comes back as a short
// problem for the card, never a throw. The tab only reads from GitHub. Parsers are pure functions.
// gh resolves {owner} and {repo} from the folder's remotes; an Enterprise host is chosen with GH_HOST.
// @ts-nocheck

import { execFile, spawn } from "node:child_process";
import type { SidebarHost } from "./tabs.ts";

/** How often the PRs are read again while shown, how often the branch is probed, and the gh timeout (ms). */
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

const LIMIT = 30;
const PR_FIELDS =
	"number title url isDraft baseRefName headRefName headRepositoryOwner{login} mergeable mergeStateStatus reviewDecision " +
	"commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ...on CheckRun{name status conclusion detailsUrl} ...on StatusContext{context state targetUrl}}}}}}} " +
	"reviewThreads(last:100){totalCount nodes{isResolved path line comments(first:1){nodes{author{login} body url}}}}";

// The newest open PRs, and apart ("mine") the open PRs of the current branch, so its PR shows even past LIMIT.
const QUERY =
	`query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){owner{login} ` +
	`pullRequests(states:OPEN,first:${LIMIT},orderBy:{field:CREATED_AT,direction:DESC}){nodes{...pr}} ` +
	`mine:pullRequests(states:OPEN,headRefName:$branch,first:10){nodes{...pr}}}} fragment pr on PullRequest{${PR_FIELDS}}`;

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

/** Why a gh call failed, for the card: "none" when the branch has no PR. */
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

/** A commit's check runs and status contexts as { name, state: passed | failed | running | skipped, url }. */
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

const MERGE = { CLEAN: "clean", HAS_HOOKS: "clean", DIRTY: "conflicts", BLOCKED: "blocked", UNSTABLE: "unstable", BEHIND: "behind" };
const REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

// A comment's text without HTML comments, tags and the common entities.
const unhtml = (body = "") =>
	String(body ?? "")
		.replace(/\r/g, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");

/** The first line of a comment with its HTML and Markdown markup taken out. */
export function firstLine(body = "") {
	const line = unhtml(body).split("\n").map((row) => row.trim()).find(Boolean) ?? "";
	return line
		.replace(/^#+\s*/, "")
		.replace(/^>\s*/, "")
		.replace(/\*\*|__|`/g, "")
		.replace(/\\([\\`*_{}[\]()#+\-.!'])/g, "$1")
		.replace(/[\x00-\x1f\x7f]/g, "")
		.trim();
}

const BODY_LIMIT = 1500;

// The comment after its first line, for the agent: markup kept, HTML out, at most three lines apart.
function restOf(body = "") {
	const lines = unhtml(body).split("\n");
	const first = lines.findIndex((line) => line.trim());
	const rest = (first < 0 ? "" : lines.slice(first + 1).join("\n")).replace(/\n{3,}/g, "\n\n").trim();
	return rest.length > BODY_LIMIT ? `${rest.slice(0, BODY_LIMIT).trimEnd()}…` : rest;
}

// A reviewer's severity badge ("P1"), as Greptile puts it at the head of a comment.
const severityOf = (body = "") => /<img[^>]*\balt="(P\d)"/i.exec(String(body ?? ""))?.[1]?.toUpperCase();

function parsePull(item) {
	const draft = Boolean(item?.isDraft);
	const status = item?.mergeStateStatus;
	const merge = item?.mergeable === "CONFLICTING" ? "conflicts" : (MERGE[status] ?? (status === "DRAFT" ? undefined : "checking"));
	const contexts = item?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes;
	const nodes = Array.isArray(item?.reviewThreads?.nodes) ? item.reviewThreads.nodes : [];
	const threads = nodes
		.filter((node) => node && !node.isResolved)
		.map((node) => {
			const comment = node.comments?.nodes?.[0];
			return {
				path: node.path ?? "",
				line: node.line ?? undefined,
				author: comment?.author?.login ?? "?",
				title: firstLine(comment?.body),
				severity: severityOf(comment?.body),
				body: restOf(comment?.body),
				url: comment?.url,
			};
		});
	return {
		number: item?.number,
		title: String(item?.title ?? ""),
		url: item?.url,
		draft,
		base: item?.baseRefName ?? "",
		head: item?.headRefName ?? "",
		headOwner: item?.headRepositoryOwner?.login,
		merge,
		review: REVIEW[item?.reviewDecision],
		checks: parseChecks(contexts),
		threads,
		threadsPartial: Number(item?.reviewThreads?.totalCount ?? nodes.length) > nodes.length,
	};
}

/**
 * The GraphQL answer as { owner, prs } (the repository's owner and its open PRs, newest first, then the current
 * branch's PRs the first page left out), or { problem } when GitHub answered an error or nothing readable.
 * `branch` keeps only the "mine" PRs of that branch; without it they are all kept.
 */
export function parsePulls(json, branch = undefined) {
	const repo = json?.data?.repository;
	if (!repo) return { owner: undefined, prs: [], problem: json?.errors?.[0]?.message || "unreadable answer" };
	const prs = (repo.pullRequests?.nodes ?? []).filter(Boolean).map(parsePull);
	for (const item of repo.mine?.nodes ?? []) {
		if (!item || (branch !== undefined && item.headRefName !== branch)) continue;
		if (!prs.some((pr) => pr.number === item.number)) prs.push(parsePull(item));
	}
	return { owner: repo.owner?.login, prs };
}

// The owner in a remote's URL: git@github.com:owner/repo.git, https://github.com/owner/repo, ssh://…/owner/repo.
const ownerOfUrl = (url) => /[:/]([^/:]+)\/[^/]+?(?:\.git)?\/?$/.exec(String(url ?? "").trim())?.[1];

/**
 * The open PR of `branch`: its head is that branch in the repository the branch is pushed to (`remoteUrl`, the
 * upstream remote's URL), else in the repository itself, so a fork's PR from a same-named branch is not taken.
 */
export function currentPr(prs, branch, owner, remoteUrl = undefined) {
	if (!branch) return undefined;
	const want = ownerOfUrl(remoteUrl) ?? owner;
	return prs.find((pr) => pr.head === branch && (pr.headOwner ?? owner) === want);
}

/**
 * The PRs as their stack, in drawing order: a PR whose base is another open PR's head (a branch of this
 * repository) under it, siblings in the list's order. Each entry: { pr, prefix, cont, depth }, where prefix is
 * the tree's lead before the row ("", "├ ", "│ └ ") and cont the lead of the rows under it.
 */
export function stackOf(prs, owner) {
	const parent = new Map();
	for (const pr of prs) {
		const base = prs.find((other) => other !== pr && other.head === pr.base && (other.headOwner ?? owner) === owner);
		if (base) parent.set(pr, base);
	}
	const children = new Map();
	for (const pr of prs) if (parent.has(pr)) children.set(parent.get(pr), [...(children.get(parent.get(pr)) ?? []), pr]);
	const out = [];
	const seen = new Set();
	const walk = (pr, lead, last, depth) => {
		if (seen.has(pr)) return;
		seen.add(pr);
		const prefix = depth ? `${lead}${last ? "└ " : "├ "}` : "";
		const cont = depth ? `${lead}${last ? "  " : "│ "}` : "";
		out.push({ pr, prefix, cont, depth });
		const kids = (children.get(pr) ?? []).filter((kid) => !seen.has(kid));
		kids.forEach((kid, index) => walk(kid, cont, index === kids.length - 1, depth + 1));
	};
	for (const pr of prs) if (!parent.has(pr)) walk(pr, "", true, 0);
	for (const pr of prs) walk(pr, "", true, 0); // bases that loop: each PR still once
	return out;
}

/**
 * What a PR waits on, the most serious first: conflicts, ci-failed, changes, threads ({ count, partial }),
 * ci-running, draft, review, blocked, behind, else ready. Threads not all read never count as none.
 */
export function verdictOf(pr) {
	const states = pr.checks.map((check) => check.state);
	if (pr.merge === "conflicts") return { kind: "conflicts" };
	if (states.includes("failed")) return { kind: "ci-failed" };
	if (pr.review === "changes requested") return { kind: "changes" };
	if (pr.threads.length || pr.threadsPartial) return { kind: "threads", count: pr.threads.length, partial: pr.threadsPartial };
	if (states.includes("running")) return { kind: "ci-running" };
	if (pr.draft) return { kind: "draft" };
	if (pr.review === "review required") return { kind: "review" };
	if (pr.merge === "blocked") return { kind: "blocked" };
	if (pr.merge === "behind") return { kind: "behind" };
	return { kind: "ready" };
}

/** The editor text that hands a PR's unresolved review threads to the agent. */
export function threadsPrompt(pr) {
	const items = pr.threads.map((thread, index) => {
		const where = thread.line ? `${thread.path}:${thread.line}` : thread.path;
		const who = thread.severity ? `${thread.author} (${thread.severity})` : thread.author;
		return [`${index + 1}. ${where}, ${who}: ${thread.url ?? pr.url}`, thread.title, ...(thread.body ? ["", thread.body] : [])].join("\n");
	});
	const partial = pr.threadsPartial ? ["Only the newest review threads were read: check the PR for older ones too.", ""] : [];
	return [`Address the unresolved review threads on PR #${pr.number} (${pr.url}):`, "", ...items.flatMap((item) => [item, ""]), ...partial, "Fix each one in this branch, or tell me why it should stay as it is."].join("\n");
}

/** The editor text that hands a PR's failed checks to the agent. */
export function ciPrompt(pr) {
	const failed = pr.checks.filter((check) => check.state === "failed");
	return [
		`These checks failed on PR #${pr.number} (${pr.url}):`,
		...failed.map((check) => `- ${check.name}${check.url ? `: ${check.url}` : ""}`),
		"",
		`Find out why (gh pr checks ${pr.number}, gh run view --log-failed) and fix it in this branch.`,
	].join("\n");
}

// The URL of the remote the current branch is pushed to, when it has an upstream.
async function upstreamUrl(host, cwd) {
	try {
		const upstream = (await host.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd))?.trim();
		if (!upstream || !upstream.includes("/")) return undefined;
		return (await host.git(["remote", "get-url", upstream.split("/")[0]], cwd))?.trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Everything the tab shows for `cwd`, read once:
 *   { kind: "list", branch, owner, prs, current }   current: the number of the branch's open PR, else undefined
 *   { kind: "problem", branch, message }            no gh, signed out, not GitHub, ...
 */
export async function loadPr(host: SidebarHost, cwd) {
	let branch = "";
	try {
		branch = (await host.git(["branch", "--show-current"], cwd))?.trim() ?? "";
	} catch {
		branch = "";
	}
	const remoteUrl = branch ? await upstreamUrl(host, cwd) : undefined;
	const answer = await gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `branch=${branch}`, "-f", `query=${QUERY}`], cwd);
	if (!answer.ok) {
		const problem = ghProblem(answer.error, answer.stderr);
		return { kind: "problem", branch, message: problem === "none" ? "No open pull requests" : problem };
	}
	let json;
	try {
		json = JSON.parse(answer.stdout);
	} catch {
		return { kind: "problem", branch, message: "gh: unreadable answer" };
	}
	const { owner, prs, problem } = parsePulls(json, branch);
	if (problem) return { kind: "problem", branch, message: `gh: ${problem}` };
	return { kind: "list", branch, owner, prs, current: currentPr(prs, branch, owner, remoteUrl)?.number };
}
