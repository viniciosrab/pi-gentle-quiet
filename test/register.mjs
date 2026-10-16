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
	// Node does not strip types under node_modules, where Pi installs gentle-pi. The stand-ins tests
	// put there are plain JavaScript, so they load as modules as they are (Pi itself loads them with jiti).
	load(url, context, nextLoad) {
		if (url.includes("/gentle-quiet-test-") && url.includes("/node_modules/") && url.endsWith(".ts")) {
			return { ...nextLoad(url, { ...context, format: "module" }), format: "module", shortCircuit: true };
		}
		return nextLoad(url, context);
	},
});
