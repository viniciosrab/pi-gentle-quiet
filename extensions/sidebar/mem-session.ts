// The MEM tab's session cards: what the agent saved to Engram and what it pulled from it in this Pi session,
// read from the session's tool calls (ctx.sessionManager, the current branch) and their results. Memory tools
// go by their own names or with a prefix (mcp__engram__mem_save): the suffix decides. Calls that failed or
// have no result yet are left out.
//
// Rows are newest first. Saved: { id, title, type, updated, body } per memory, the newest call kept.
// Recalled: { kind: "observation", id, title, type, body }, { kind: "search", query, hits }, { kind: "context" },
// one per memory, query or context.
// @ts-nocheck

const TOOLS = ["mem_save", "mem_update", "mem_get_observation", "mem_search", "mem_context"];
const NAME = new RegExp(`(?:^|[_.:/-])(${TOOLS.join("|")})$`);

/** "mcp__engram__mem_save" -> "mem_save"; undefined for any other tool. */
export function memoryTool(name) {
	return String(name ?? "").trim().toLowerCase().match(NAME)?.[1];
}

const text = (result) => (Array.isArray(result?.content) ? result.content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("\n") : "");

// The result's data: gentle-engram keeps it in details.data; others hand JSON or plain text.
function dataOf(result) {
	const data = result?.details?.data ?? result?.details;
	if (data !== undefined && data !== null) return data;
	try {
		return JSON.parse(text(result));
	} catch {
		return undefined;
	}
}

const idOf = (value) => {
	const id = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(id) && id > 0 ? id : undefined;
};
const given = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const textId = (raw) => idOf(raw.match(/#(\d+)/)?.[1] ?? raw.match(/\bid\b["']?\s*[:=]\s*#?(\d+)/i)?.[1]);

function hitsOf(data, raw) {
	if (Array.isArray(data)) return data.length;
	for (const key of ["results", "observations", "memories"]) if (Array.isArray(data?.[key])) return data[key].length;
	if (typeof data?.count === "number") return data.count;
	if (/no memories found/i.test(raw)) return 0;
	const found = raw.match(/found\s+(\d+)/i)?.[1];
	return found === undefined ? undefined : Number(found);
}

function entriesOf(ctx) {
	try {
		return ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
	} catch {
		return [];
	}
}

/** The session's saved and recalled memories, newest first. */
export function scanSession(ctx) {
	const calls = new Map(); // tool call id -> { tool, args }
	const done = [];
	for (const entry of entriesOf(ctx)) {
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				const tool = part?.type === "toolCall" ? memoryTool(part.name) : undefined;
				if (tool) calls.set(part.id, { tool, args: part.arguments ?? {} });
			}
		} else if (message?.role === "toolResult" && !message.isError) {
			const call = calls.get(message.toolCallId);
			if (call) done.push({ ...call, result: message });
		}
	}
	const saved = [];
	const recalled = [];
	const seen = new Set();
	for (const { tool, args, result } of done.reverse()) {
		const data = dataOf(result);
		const raw = text(result);
		if (tool === "mem_save" || tool === "mem_update") {
			const id = idOf(tool === "mem_update" ? args.id : undefined) ?? idOf(data?.id) ?? idOf(data?.observation_id) ?? textId(raw);
			const key = id === undefined ? undefined : `saved:${id}`;
			if (key && seen.has(key)) continue;
			if (key) seen.add(key);
			saved.push({ id, title: given(args.title) ?? given(data?.title) ?? (id ? `#${id}` : "(untitled)"), type: given(args.type) ?? given(data?.type), updated: tool === "mem_update", body: given(args.content) ?? given(data?.content) });
		} else if (tool === "mem_get_observation") {
			const id = idOf(data?.id) ?? idOf(args.id);
			if (!id || seen.has(`obs:${id}`)) continue;
			seen.add(`obs:${id}`);
			recalled.push({ kind: "observation", id, title: given(data?.title) ?? `#${id}`, type: given(data?.type), body: given(data?.content) ?? given(raw) });
		} else if (tool === "mem_search") {
			const query = given(args.query) ?? "";
			if (seen.has(`search:${query}`)) continue;
			seen.add(`search:${query}`);
			recalled.push({ kind: "search", query, hits: hitsOf(data, raw) });
		} else if (!seen.has("context")) {
			seen.add("context");
			recalled.push({ kind: "context" });
		}
	}
	return { saved, recalled };
}
