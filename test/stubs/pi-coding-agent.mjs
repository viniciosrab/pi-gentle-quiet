// Minimal stand-in for @earendil-works/pi-coding-agent: just what gentle-quiet imports.

/** Base editor: renders a top rule, the text lines indented by the padding, and a bottom rule. */
export class CustomEditor {
	constructor() {
		this.paddingX = 0;
		this.lines = ["hello", "world"];
	}
	getPaddingX() {
		return this.paddingX;
	}
	setPaddingX(padding) {
		this.paddingX = padding;
	}
	borderColor(text) {
		return `[${text}]`;
	}
	render(width) {
		const rule = "─".repeat(width);
		return [rule, ...this.lines.map((line) => " ".repeat(this.paddingX) + line), rule];
	}
}

export const keyHint = (_binding, description) => `ctrl+o ${description}`;

// Each test process points the agent dir at its own temporary directory.
export const getAgentDir = () => process.env.GENTLE_QUIET_TEST_AGENT_DIR;

/** Sent user message: one markdown child padded by outputPad and one blank row above and below, like Pi. */
export class UserMessageComponent {
	constructor(text, outputPad = 1) {
		this.text = text;
		this.outputPad = outputPad;
		this.rebuild();
	}
	rebuild() {
		this.children = [{ text: this.text, paddingX: this.outputPad, paddingY: 1, cachedText: this.text }];
	}
}

/** A tool call: Pi's background box fills every column; renderShell "self" leaves the framing to the tool. */
export class ToolExecutionComponent {
	constructor(toolDefinition) {
		this.toolDefinition = toolDefinition;
	}
	hasRendererDefinition() {
		return this.toolDefinition !== undefined;
	}
	getRenderShell() {
		return this.toolDefinition?.renderShell ?? "default";
	}
	render(width) {
		return ["", "#".repeat(width)];
	}
	handleMouse(event) {
		return event;
	}
}

/** A custom message: Pi's background box unless a registered renderer returned its own component. */
export class CustomMessageComponent {
	constructor(customComponent) {
		this.customComponent = customComponent;
	}
	render(width) {
		return ["", "#".repeat(width)];
	}
	handleMouse(event) {
		return event;
	}
}
