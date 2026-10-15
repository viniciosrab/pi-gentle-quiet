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
