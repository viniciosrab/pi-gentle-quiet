// Whether gentle-engram is part of the stack, for the MEM tab's Engram and Active Handoff cards.
// @ts-nocheck

import path from "node:path";
import { memoryTool } from "./mem-session.ts";

async function packageInstalled(deps, agentDir, name) {
	const text = await deps.readFile(path.join(agentDir, "npm", "node_modules", name, "package.json"));
	try {
		return text !== undefined && Boolean(JSON.parse(text).version);
	} catch {
		return false;
	}
}

/** gentle-engram is there: its memory tools are registered (by name or prefixed), or its package is installed. */
export async function engramInstalled(deps, host) {
	try {
		if ((host.pi?.getAllTools?.() ?? []).some((tool) => String(tool?.name ?? "").startsWith("mem_") || memoryTool(tool?.name))) return true;
	} catch {}
	return packageInstalled(deps, host.agentDir, "gentle-engram");
}
