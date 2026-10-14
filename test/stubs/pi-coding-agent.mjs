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
