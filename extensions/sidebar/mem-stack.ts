// The MEM tab's Ecosystem and Tools data, after pi-cinlodev-cute's src/ecosystem/ecosystem-client.ts and
// src/cute-tools.ts: the versions of Pi, gentle-pi, gentle-engram and the engram binary, and the session's
// tool calls counted by group.
// @ts-nocheck

import path from "node:path";
import { engramBin } from "./mem-engram.ts";

/** "engram 3.6.0 (commit …)" -> "3.6.0"; "v1.3.0\n" -> "1.3.0". */
export function cleanVersion(raw) {
	const trimmed = String(raw ?? "").trim();
	if (!trimmed) return "";
	const semver = trimmed.match(/\b(\d+\.\d+\.\d+(?:-[a-zA-Z0-9_.]+)?)\b/);
	if (semver) return semver[1];
	return trimmed.split("\n")[0].trim().split(/\s+/).at(-1).replace(/^v/i, "");
}

async function binaryVersion(deps, bin, args) {
	const result = await deps.run(bin, args, 1500);
	return result.ok ? cleanVersion(result.stdout) || undefined : undefined;
}

async function packageVersion(deps, agentDir, name) {
	const text = await deps.readFile(path.join(agentDir, "npm", "node_modules", name, "package.json"));
	try {
		return text === undefined ? undefined : cleanVersion(JSON.parse(text).version) || undefined;
	} catch {
		return undefined;
	}
}

/** The Ecosystem card's rows: one per tool, with its version or unavailable. */
export async function detectEcosystem(deps, agentDir) {
	const bin = engramBin(deps.env);
	const [pi, gentlePi, gentleEngram, engram] = await Promise.all([
		binaryVersion(deps, "pi", ["--version"]),
		packageVersion(deps, agentDir, "gentle-pi"),
		packageVersion(deps, agentDir, "gentle-engram"),
		binaryVersion(deps, bin, ["version"]).then((version) => version ?? binaryVersion(deps, bin, ["--version"])),
	]);
	return [
		["pi", pi],
		["gentle-pi", gentlePi],
		["gentle-engram", gentleEngram],
		["engram", engram],
	].map(([name, version]) => ({ name, version: version ?? "-", available: Boolean(version) }));
}

/** gentle-engram is there: its memory tools are registered, or its package is installed. */
export async function engramInstalled(deps, host) {
	try {
		if ((host.pi?.getAllTools?.() ?? []).some((tool) => String(tool?.name ?? "").startsWith("mem_"))) return true;
	} catch {}
	return (await packageVersion(deps, host.agentDir, "gentle-engram")) !== undefined;
}

export const TOOL_GROUPS = ["read", "write", "bash", "engram", "grep", "fetch", "search", "other"];

const groupOf = (name) => {
	const lower = name.trim().toLowerCase();
	if (lower === "read") return "read";
	if (lower === "write" || lower === "edit") return "write";
	if (lower === "bash") return "bash";
	if (lower.startsWith("mem_")) return "engram";
	if (lower === "grep") return "grep";
	if (lower === "fetch" || lower === "fetch_content") return "fetch";
	if (lower === "search" || lower === "web_search") return "search";
	return "other";
};

/** The session's tool calls by group, from the assistant messages on the current branch. */
export function countTools(ctx) {
	const counts = Object.fromEntries([...TOOL_GROUPS, "total"].map((key) => [key, 0]));
	let entries = [];
	try {
		entries = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
	} catch {
		entries = [];
	}
	for (const entry of entries) {
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const name = part?.type === "toolCall" ? String(part.name ?? "").trim() : "";
			if (!name) continue;
			counts[groupOf(name)]++;
			counts.total++;
		}
	}
	return counts;
}
