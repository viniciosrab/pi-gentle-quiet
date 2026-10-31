import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, painted, theme, writeConfig } from "./helpers.mjs";

// Shape of a gentle-pi float panel: background, accent bar, padding rows.
const bg = (text) => `\x1b[48;2;20;20;20m${text}\x1b[49m`;
const floatPanel = (width) => [
	bg(` ▎${" ".repeat(width - 3)}`),
	bg(` ▎ ✿ Todos  1 of 3${" ".repeat(width - 19)}`),
	bg(` ▎${" ".repeat(width - 3)}`),
	bg(` ▎ ✓ Task A${" ".repeat(width - 12)}`),
	bg(` ▎ ○ Task C${" ".repeat(width - 12)}`),
	bg(` ▎${" ".repeat(width - 3)}`),
];

const widget = async (key, render) => {
	const loaded = await load();
	loaded.ui.setWidget(key, () => ({ render, handleMouse: () => "mouse" }));
	return { ...loaded, component: loaded.widgets[key]({}, theme) };
};

test("Todos block is flat, full width and inside a square border", async () => {
	const { component } = await widget("gentle-todo", floatPanel);
	const out = component.render(40);
	assert.deepEqual(lines({ render: () => out }, 40), [
		"┌──────────────────────────────────────┐",
		"│ ≡ Todos  1 of 3                      │",
		"│                                      │",
		"│ ✓ Task A                             │",
		"│ ○ Task C                             │",
		"└──────────────────────────────────────┘",
	]);
	assert.ok(!out.some((line) => /\x1b\[48/.test(line)), "no background left");
	assert.ok(painted(out[0], "border", "┌"), "border uses the theme border color");
});

test("the Agents card under the editor draws a running agent with ◔", async () => {
	const { component } = await widget("gentle-agents", () => ["   ❀ Agents  1 active", "   ◐ gentle-ai-worker", "   ✓ gentle-ai-explore"]);
	assert.deepEqual(lines({ render: () => component.render(40) }, 40).slice(3, 5), ["│ ◔ gentle-ai-worker                   │", "│ ✓ gentle-ai-explore                  │"]);
});

test("the Agents card under the editor starts an agent's name in the column of its title", async () => {
	const { component } = await widget("gentle-agents", () => ["   ❀ Agents  2 active", "   ◐  gentle-ai-worker  variant A", "   ✓  gentle-ai-explore"]);
	assert.deepEqual(lines({ render: () => component.render(40) }, 40).slice(1, 5), ["│ ◈ Agents  2 active                   │", "│                                      │", "│ ◔ gentle-ai-worker  variant A        │", "│ ✓ gentle-ai-explore                  │"]);
});

test("without the outline an agent's name still starts in the column of its title", async () => {
	writeConfig({ blocks: { border: false } });
	const { component } = await widget("gentle-agents", () => ["   ❀ Agents  1 active", "   ◐  gentle-ai-worker"]);
	const rows = component.render(40).map((row) => row.replace(/\x1b\[[0-9;:]*m/g, ""));
	assert.equal(rows.find((row) => row.includes("gentle-ai-worker")).indexOf("gentle-ai-worker"), rows[0].indexOf("Agents"));
	writeConfig({});
});

test("without the outline the Agents card still draws a running agent with ◔", async () => {
	writeConfig({ blocks: { border: false } });
	const { component } = await widget("gentle-agents", () => ["   ❀ Agents  1 active", "   ◐ gentle-ai-worker"]);
	assert.ok(component.render(40).some((row) => /^\s*◔ gentle-ai-worker/.test(row.replace(/\x1b\[[0-9;:]*m/g, ""))));
	writeConfig({});
});

test("padding rows without a background are trimmed too; inner blank rows stay, under the blank row after the title", async () => {
	const { component } = await widget("gentle-agents", () => ["      ", "   ❀ Agents  1 done", "   ✓ a", "", "   ✓ b", "      "]);
	assert.deepEqual(lines(component, 30), [
		"┌────────────────────────────┐",
		"│ ◈ Agents  1 done           │",
		"│                            │",
		"│ ✓ a                        │",
		"│                            │",
		"│ ✓ b                        │",
		"└────────────────────────────┘",
	]);
});

test("block input handlers still reach gentle-pi", async () => {
	const { component } = await widget("gentle-todo", floatPanel);
	assert.equal(component.handleMouse(), "mouse");
});

test("narrow terminals drop the border instead of breaking it", async () => {
	const { component } = await widget("gentle-todo", () => ["   ✿ Todos"]);
	assert.deepEqual(lines(component, 12), [" ≡ Todos"]);
});

test("the Agents and Todos cards head their list like the Status card: the title bold in toolTitle, then a blank row", async () => {
	for (const [key, panel, name] of [
		["gentle-agents", () => ["   ❀ Agents ▾ Collapse  1 active", "   ◐  gentle-ai-worker"], "Agents"],
		["gentle-todo", floatPanel, "Todos"],
	]) {
		const { component } = await widget(key, panel);
		const out = component.render(40);
		const rows = out.map((row) => row.replace(/\x1b\[[0-9;:]*m/g, ""));
		assert.match(rows[1], new RegExp(`^│ \\S ${name}\\b`), `${name}: the title row`);
		assert.match(rows[2], /^│ +│$/, `${name}: a blank row under the title`);
		assert.ok(painted(out[1], "toolTitle", theme.bold(name)), `${name}: the title bold in toolTitle`);
		assert.ok(!painted(out[1], "toolTitle", theme.bold(`${name} `)) && !out[1].includes(theme.bold("Collapse")), `${name}: only the name`);
	}
});

test("without the outline the Agents title is bold in toolTitle and a blank row follows it", async () => {
	writeConfig({ blocks: { border: false } });
	const { component } = await widget("gentle-agents", () => ["   ❀ Agents  1 active", "   ◐  gentle-ai-worker"]);
	const out = component.render(40);
	assert.ok(painted(out[0], "toolTitle", theme.bold("Agents")));
	assert.equal(out[1].replace(/\x1b\[[0-9;:]*m/g, "").trim(), "");
	assert.match(out[2].replace(/\x1b\[[0-9;:]*m/g, ""), /◔ gentle-ai-worker/);
	writeConfig({});
});
