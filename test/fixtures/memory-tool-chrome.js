// Fixture with the exports gentle-quiet uses from gentle-engram's
// memory-tool-chrome.js, producing the same text shapes as gentle-engram 0.2.0.
const LABELS = { mem_search: "search", mem_stats: "stats", mem_current_project: "current project" };

export const humanToolName = (toolName) => LABELS[toolName] ?? toolName.replace(/^mem_/, "").replace(/_/g, " ");

export function compactToolArg(toolName, args = {}) {
	if (toolName === "mem_search" && args.query) return `“${args.query}”`;
	return "";
}

export function renderCallText(toolName, args = {}) {
	const arg = compactToolArg(toolName, args);
	return `🧠 ${humanToolName(toolName)}${arg ? ` ${arg}` : ""} …`;
}

export function renderResultText(toolName, result, options = {}) {
	if (options.isPartial) return `↳ ${humanToolName(toolName)}…`;
	if (options.isError || result?.isError) return `↳ ✗ ${result?.content?.[0]?.text ?? "error"}`;
	const count = result?.details?.data?.results?.length;
	const status = toolName === "mem_search" ? `✓ ${count ?? 0} result${count === 1 ? "" : "s"}` : "✓ loaded";
	const body = options.expanded ? `\n\n${result?.content?.[0]?.text ?? ""}` : "";
	return `↳ ${status}${body}`;
}
