// Maps Pi's host packages to the local stubs, so tests run without Pi installed.
import { registerHooks } from "node:module";

const STUBS = {
	"@earendil-works/pi-tui": new URL("./stubs/pi-tui.mjs", import.meta.url).href,
	"@earendil-works/pi-coding-agent": new URL("./stubs/pi-coding-agent.mjs", import.meta.url).href,
};

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
