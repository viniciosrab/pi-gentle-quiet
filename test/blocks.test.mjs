import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, painted, theme } from "./helpers.mjs";

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
		"│ ✓ Task A                             │",
		"│ ○ Task C                             │",
		"└──────────────────────────────────────┘",
	]);
	assert.ok(!out.some((line) => /\x1b\[48/.test(line)), "no background left");
	assert.ok(painted(out[0], "border", "┌"), "border uses the theme border color");
});

test("padding rows without a background are trimmed too; inner blank rows stay", async () => {
	const { component } = await widget("gentle-agents", () => ["      ", "   ❀ Agents  1 done", "   ✓ a", "", "   ✓ b", "      "]);
	assert.deepEqual(lines(component, 30), [
		"┌────────────────────────────┐",
		"│ ◈ Agents  1 done           │",
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
