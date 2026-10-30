// gentle-pi's agent-model profiles for the PROF tab, read at runtime and read-only: the profile list, which
// one is in effect in this session (◉), by default (★) and in this repository (⌂), and the routing of the
// one in effect. The readers are gentle-pi's own (lib/agent-profiles.ts, agent-profile-pin.ts,
// session-profile-binding.ts, agent-home.ts), imported the way gentle-quiet imports its command palette;
// a reader gentle-pi no longer exports is replaced by a read of the same file. Only the repository's root
// and common dir come from elsewhere: host.git (async, with its own timeout) instead of gentle-pi's
// synchronous git children, so the column never waits on git.
// @ts-nocheck

import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** How long the repository lookup and the whole load may take, in ms. Tests shorten them. */
export const PROF_TIMEOUTS = { git: 4000, load: 8000 };

const ORCHESTRATOR = "orchestrator";
const SESSION_BINDINGS = Symbol.for("gentle-pi:session-profile-bindings");
const own = (record, key) => Object.prototype.hasOwnProperty.call(record ?? {}, key);

/** Resolves to `fallback` when `promise` takes longer than `ms`. */
function within(promise, ms, fallback) {
	let timer;
	const late = new Promise((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
		timer.unref?.();
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function importLib(lib, name) {
	const file = path.join(lib, name);
	if (!existsSync(file)) return {};
	try {
		return await import(pathToFileURL(file).href);
	} catch {
		return {}; // gentle-pi moved or changed: read the files instead
	}
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

// The same files gentle-pi's readers read, for a gentle-pi that does not export them.
const fallback = {
	gentlePiConfigHome: () => process.env.GENTLE_PI_CONFIG_HOME || path.join(os.homedir(), ".pi", "gentle-ai"),
	profilesFilePath: (home) => path.join(home, "profiles.json"),
	readProfilesFileResult(file) {
		if (!existsSync(file)) return { status: "missing" };
		let value;
		try {
			value = readJson(file);
		} catch {
			return { status: "invalid" };
		}
		if (value?.kind !== "gentle-pi.agent_model_profiles" || !value.profiles || typeof value.profiles !== "object") return { status: "invalid" };
		return { status: "valid", file: { ...value, active: own(value.profiles, value.active) ? value.active : undefined } };
	},
	readProfileOrchestrator: (config) => (config?.[ORCHESTRATOR] && Object.keys(config[ORCHESTRATOR]).length ? config[ORCHESTRATOR] : undefined),
	profileRoutingRows: (config) =>
		Object.entries(config ?? {})
			.filter(([agent]) => agent !== ORCHESTRATOR)
			.map(([agent, entry]) => ({ agent, model: entry?.model ?? "inherit", thinking: entry?.thinking ?? "inherit" }))
			.sort((a, b) => a.agent.localeCompare(b.agent)),
	localProfilePinPath: (commonDir) => path.join(commonDir, "gentle-ai", "profile-pin.json"),
	repoProfileDeclarationPath: (root) => path.join(root, ".pi", "gentle-ai", "profile.json"),
	readProfilePinResult(file) {
		if (!existsSync(file)) return { status: "missing" };
		try {
			const value = readJson(file);
			return value?.kind === "gentle-pi.agent_model_profile_pin" && typeof value.profile === "string" ? { status: "valid", profile: value.profile } : { status: "invalid" };
		} catch {
			return { status: "invalid" };
		}
	},
	evaluateProfilePin(status, profiles) {
		const layers = [status?.local, status?.repo].filter((read) => read?.status === "valid" && own(profiles, read.profile));
		return { winner: layers[0] && { profile: layers[0].profile }, invalid: [], stale: [] };
	},
	readSessionProfileBinding: (sessionId) => (sessionId === undefined ? undefined : globalThis[SESSION_BINDINGS]?.get?.(sessionId)),
};

/** gentle-pi's readers by name, each from gentle-pi when it exports it, else the fallback above. */
async function readers(lib) {
	const modules = await Promise.all(["agent-home.ts", "agent-profiles.ts", "agent-profile-pin.ts", "session-profile-binding.ts"].map((name) => importLib(lib, name)));
	const found = Object.assign({}, ...modules);
	return Object.fromEntries(Object.entries(fallback).map(([name, read]) => [name, typeof found[name] === "function" ? found[name] : read]));
}

const real = (dir) => {
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
};

/** The profile this repository pins, as gentle-pi's launch resolves it: undefined outside a repository. */
async function repoPin(host, read, profiles) {
	const ask = (flag) => within(Promise.resolve().then(() => host.git(["--no-optional-locks", "rev-parse", "--path-format=absolute", flag])).catch(() => undefined), PROF_TIMEOUTS.git, undefined);
	const [top, common] = await Promise.all([ask("--show-toplevel"), ask("--git-common-dir")]);
	const root = top?.trim();
	const commonDir = common?.trim();
	if (!root || !commonDir) return undefined;
	const status = { root: real(root), commonDir: real(commonDir) };
	status.localPath = read.localProfilePinPath(status.commonDir);
	status.repoPath = read.repoProfileDeclarationPath(status.root);
	status.local = read.readProfilePinResult(status.localPath);
	status.repo = read.readProfilePinResult(status.repoPath);
	return read.evaluateProfilePin(status, profiles)?.winner?.profile;
}

/**
 * What the PROF tab shows, or why it cannot:
 *   { state: "ok", names, session, default, repo, shown, orchestrator: { model, thinking } | undefined,
 *     rows: [{ agent, model, thinking }] }
 *   { state: "message", message }
 * Never throws.
 */
export async function loadProfiles(host) {
	const lib = path.join(host.agentDir, "npm/node_modules/gentle-pi/lib");
	if (!existsSync(lib)) return { state: "message", message: "gentle-pi's profiles not found" };
	const work = async () => {
		const read = await readers(lib);
		const store = read.readProfilesFileResult(read.profilesFilePath(read.gentlePiConfigHome()));
		if (store?.status === "missing") return { state: "message", message: "No profiles yet · /gentle:profiles creates them" };
		if (store?.status !== "valid") return { state: "message", message: "gentle-pi's profiles.json is unreadable" };
		const profiles = store.file.profiles ?? {};
		const names = Object.keys(profiles);
		let sessionId;
		try {
			sessionId = host.ctx()?.sessionManager?.getSessionId?.();
		} catch {
			sessionId = undefined; // ctx went stale after a session replacement
		}
		const bound = read.readSessionProfileBinding(sessionId)?.name;
		const session = own(profiles, bound) ? bound : undefined;
		const repo = await repoPin(host, read, profiles).catch(() => undefined);
		const byDefault = own(profiles, store.file.active) ? store.file.active : undefined;
		// gentle-pi's launch precedence: the session's binding, then the repository's pin, then the default.
		const shown = session ?? repo ?? byDefault ?? names[0];
		const config = shown === undefined ? {} : profiles[shown] ?? {};
		return {
			state: "ok",
			names,
			session,
			default: byDefault,
			repo,
			shown,
			orchestrator: read.readProfileOrchestrator(config),
			rows: read.profileRoutingRows(config) ?? [],
		};
	};
	const timedOut = { state: "message", message: "Profiles did not load in time" };
	try {
		return await within(work(), PROF_TIMEOUTS.load, timedOut);
	} catch (error) {
		return { state: "message", message: `Profiles unavailable: ${error?.message ?? error}` };
	}
}
