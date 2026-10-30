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
 *     rows: [{ agent, model, thinking }], configs: { [name]: saved routing }, view(config) }
 * where view(config) is { orchestrator, rows } for any routing (a profile with staged edits), read by gentle-pi's
 * readers as the shown one is. view is a function, so it is left out of a JSON comparison.
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
		const view = (routing) => ({ orchestrator: read.readProfileOrchestrator(routing ?? {}), rows: read.profileRoutingRows(routing ?? {}) ?? [] });
		return {
			state: "ok",
			names,
			session,
			default: byDefault,
			repo,
			shown,
			orchestrator: read.readProfileOrchestrator(config),
			rows: read.profileRoutingRows(config) ?? [],
			configs: Object.fromEntries(names.map((name) => [name, profiles[name] ?? {}])),
			view,
		};
	};
	const timedOut = { state: "message", message: "Profiles did not load in time" };
	try {
		return await within(work(), PROF_TIMEOUTS.load, timedOut);
	} catch (error) {
		return { state: "message", message: `Profiles unavailable: ${error?.message ?? error}` };
	}
}

// ---- Editing, through gentle-pi's own writers ----

/** Where the effort levels a model supports come from: Pi's pi-ai, as gentle-pi's models screen reads them. Tests replace load. */
export const thinkingSupport = { load: () => import("@earendil-works/pi-ai") };

// What each edit needs from gentle-pi, by file. An edit whose writers gentle-pi does not export is not offered:
// the click runs /gentle:profiles instead, so nothing is written by a guess at gentle-pi's format.
const WRITERS = {
	"agent-home.ts": ["gentlePiConfigHome"],
	"agent-profiles.ts": ["profilesFilePath", "readProfilesFileResult", "readProfileOrchestrator", "updateProfile", "writeProfilesFileSync"],
	"model-routing-authority.ts": ["THINKING_LEVELS", "normalizeModelConfig", "normalizeModelId"],
	"session-profile-binding.ts": ["bindSessionProfile", "readSessionProfileBinding"],
};
const LIVE = { "profiles-orchestrator.ts": ["parseOrchestratorModelRef"] };

async function exportsOf(lib, files) {
	const found = {};
	for (const [name, wanted] of Object.entries(files)) {
		const module = await importLib(lib, name);
		for (const key of wanted) {
			if (module[key] === undefined) return undefined;
			found[key] = module[key];
		}
	}
	return found;
}

const errorText = (error) => String(error?.message ?? error);
const copy = (config) => JSON.parse(JSON.stringify(config ?? {}));

/**
 * One edit to a staged routing, as gentle-pi's screen makes it in its draft (setModel, setThinking): { model } or
 * { thinking } for one agent (or the orchestrator); undefined is inherit, "leave untouched" for the orchestrator,
 * which drops its entry. An agent with nothing set stays as {}. Returns { config } (a new routing) or { error }.
 */
export function stageEdit(config, key, change) {
	const next = copy(config);
	const entry = { ...(next[key] ?? {}) };
	if (own(change, "thinking")) {
		if (key === ORCHESTRATOR && !entry.model) return { error: "Pick a model for the orchestrator first; its effort follows the model." };
		if (change.thinking === undefined) delete entry.thinking;
		else entry.thinking = change.thinking;
	}
	if (own(change, "model")) {
		if (change.model === undefined) delete entry.model;
		else entry.model = change.model;
	}
	if (key === ORCHESTRATOR && !entry.model) delete next[key];
	else next[key] = entry.model || entry.thinking ? entry : {};
	return { config: next };
}

/** gentle-pi's screen's unsaved count: each model and each effort that differs from the saved profile. */
export function changeCount(saved, draft) {
	if (!draft) return 0;
	let count = 0;
	for (const key of new Set([...Object.keys(saved ?? {}), ...Object.keys(draft)])) {
		for (const field of ["model", "thinking"]) if ((saved?.[key]?.[field] ?? undefined) !== (draft[key]?.[field] ?? undefined)) count += 1;
	}
	return count;
}

/**
 * gentle-pi's profile editing for the PROF tab, or undefined when this gentle-pi does not export what it
 * needs (or Gentle Shell is on, host.gentleShellOff() false): the tab then runs /gentle:profiles. Never throws.
 *
 *   save(name, config)        gentle-pi's Save: the staged routing written into the profile (updateProfile,
 *                             writeProfilesFileSync). When this session uses that profile it takes the saved
 *                             routing too, and moves to the orchestrator when that changed.
 *   use(name, config)         gentle-pi's "Use in this session": a staged routing that differs from the saved one is
 *                             saved first, as its screen does ("what you see is what the session uses"); then the
 *                             routing is bound to this session (bindSessionProfile) and the live session moves to
 *                             its orchestrator, if it has one.
 *   models()                  Pi's available models as provider/model, sorted, as gentle-pi's picker lists them.
 *   efforts(model)            the effort levels for `model`: the ones Pi's catalog says it supports, or all.
 * Each edit resolves to { ok, message }.
 */
export async function profileEditor(host) {
	try {
		if (host.gentleShellOff?.() !== true) return undefined;
		const lib = path.join(host.agentDir, "npm/node_modules/gentle-pi/lib");
		if (!existsSync(lib)) return undefined;
		const w = await exportsOf(lib, WRITERS);
		if (!w || !Array.isArray(w.THINKING_LEVELS) || typeof w.gentlePiConfigHome !== "function") return undefined;
		if (![w.profilesFilePath, w.readProfilesFileResult, w.updateProfile, w.writeProfilesFileSync, w.bindSessionProfile, w.normalizeModelConfig].every((f) => typeof f === "function")) return undefined;
		const live = (await exportsOf(lib, LIVE)) ?? {};
		const ctx = () => {
			try {
				return host.ctx();
			} catch {
				return undefined; // ctx went stale after a session replacement
			}
		};
		const sessionId = () => {
			try {
				const id = ctx()?.sessionManager?.getSessionId?.();
				return typeof id === "string" && id.length ? id : undefined;
			} catch {
				return undefined;
			}
		};
		const store = () => {
			const file = w.profilesFilePath(w.gentlePiConfigHome());
			const read = w.readProfilesFileResult(file);
			if (read?.status !== "valid") throw new Error(read?.status === "missing" ? "no profiles saved yet" : "gentle-pi's profiles.json is unreadable");
			return { file, store: read.file };
		};
		// The live session onto the orchestrator entry, with Pi's own setModel/setThinkingLevel; a note on failure.
		const switchLive = async (entry) => {
			const reference = typeof live.parseOrchestratorModelRef === "function" ? live.parseOrchestratorModelRef(entry?.model) : undefined;
			if (!reference) return "";
			const label = `${reference.provider}/${reference.model}`;
			const model = ctx()?.modelRegistry?.find?.(reference.provider, reference.model);
			if (!model) return ` ${label} is not in the model catalog; this session keeps its model.`;
			if (typeof host.pi?.setModel !== "function") return "";
			try {
				if (!(await host.pi.setModel(model))) return ` No authentication for ${reference.provider}; this session keeps its model.`;
				if (entry.thinking !== undefined) host.pi.setThinkingLevel?.(entry.thinking);
			} catch (error) {
				return ` This session could not switch to ${label}: ${errorText(error)}.`;
			}
			return ` This session now runs on ${label}${entry.thinking ? ` · ${entry.thinking}` : ""}.`;
		};
		const bind = async (id, name, config, moveLive) => {
			const snapshot = w.normalizeModelConfig(config) ?? {};
			w.bindSessionProfile(id, name, snapshot);
			const orchestrator = w.readProfileOrchestrator?.(snapshot);
			return moveLive && orchestrator ? switchLive(orchestrator) : "";
		};
		const differs = (a, b) => JSON.stringify(w.normalizeModelConfig(a) ?? {}) !== JSON.stringify(w.normalizeModelConfig(b) ?? {});
		const write = (file, current, name, config) => w.writeProfilesFileSync(file, w.updateProfile(current, name, w.normalizeModelConfig(config) ?? {}));
		return {
			async save(name, config) {
				try {
					const { file, store: current } = store();
					if (!own(current.profiles, name)) return { ok: false, message: `No profile named "${name}".` };
					const was = current.profiles[name];
					if (!differs(config, was)) return { ok: true, message: "Nothing to save." };
					write(file, current, name, config);
					const id = sessionId();
					const bound = id && w.readSessionProfileBinding(id)?.name === name;
					const moved = differs({ [ORCHESTRATOR]: config?.[ORCHESTRATOR] }, { [ORCHESTRATOR]: was?.[ORCHESTRATOR] });
					const note = bound ? await bind(id, name, config, moved) : "";
					return { ok: true, message: `Saved "${name}".${note}` };
				} catch (error) {
					return { ok: false, message: `"${name}" was not saved: ${errorText(error)}` };
				}
			},
			async use(name, config) {
				try {
					const id = sessionId();
					if (!id) return { ok: false, message: `This Pi session has no id to bind "${name}" to.` };
					const { file, store: current } = store();
					if (!own(current.profiles, name)) return { ok: false, message: `No profile named "${name}".` };
					const saved = config !== undefined && differs(config, current.profiles[name]);
					if (saved) write(file, current, name, config);
					const note = await bind(id, name, saved ? config : current.profiles[name], true);
					return { ok: true, message: `${saved ? `Saved "${name}". ` : ""}This session now uses "${name}".${note}` };
				} catch (error) {
					return { ok: false, message: `"${name}" was not used: ${errorText(error)}` };
				}
			},
			async models() {
				let available;
				try {
					available = await ctx()?.modelRegistry?.getAvailable?.();
				} catch {
					available = undefined;
				}
				if (!Array.isArray(available)) return [];
				const ids = available.map((model) => w.normalizeModelId(`${model?.provider}/${model?.id}`)).filter(Boolean);
				return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
			},
			async efforts(model) {
				const all = [...w.THINKING_LEVELS];
				if (!model) return all;
				try {
					const available = await ctx()?.modelRegistry?.getAvailable?.();
					const entry = (Array.isArray(available) ? available : []).find((candidate) => `${candidate?.provider}/${candidate?.id}` === model);
					// Without the reasoning flag the catalog says nothing about effort: every level, as gentle-pi does.
					if (!entry || typeof entry.reasoning !== "boolean") return all;
					const supported = (await thinkingSupport.load()).getSupportedThinkingLevels(entry);
					const levels = all.filter((level) => supported.includes(level));
					return levels.length ? levels : all;
				} catch {
					return all;
				}
			},
		};
	} catch {
		return undefined;
	}
}
