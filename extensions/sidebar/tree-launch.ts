// The TREE tab's editor launcher, after pi-cinlodev-cute's src/tree/tree-launchers.ts: $VISUAL, $EDITOR or
// nvim on a file or the project, in a new focused herdr tab when Pi runs inside herdr, otherwise in a detached
// terminal window ($TERMINAL, or the first of foot, alacritty, ghostty, kitty on the PATH). Nothing blocks:
// every process call is asynchronous, and a failure comes back as a short message for the card.
// @ts-nocheck

import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TERMINALS = ["foot", "alacritty", "ghostty", "kitty"];

/** The process calls the launcher makes; tests swap them, and `launch` itself, for stand-ins. */
export const launchDeps = {
	env: process.env,
	spawn,
	execFile: async (bin, args) => (await run(bin, args, { encoding: "utf8", timeout: 2000 })).stdout,
	executable: async (name) => {
		const candidates = name.includes("/") ? [name] : String(launchDeps.env.PATH ?? "").split(":").filter(Boolean).map((dir) => path.join(dir, name));
		for (const candidate of candidates) {
			try {
				await access(candidate, constants.X_OK);
				return true;
			} catch {
				// next one
			}
		}
		return false;
	},
	launch: (target, cwd) => launchEditor(target, cwd),
};

/** The editor's command line ($VISUAL, $EDITOR, nvim) and the name the badge shows. */
export function editorCommand(env = launchDeps.env) {
	const command = String(env.VISUAL || env.EDITOR || "nvim").trim() || "nvim";
	const argv = command.split(/\s+/);
	return { command, argv, label: path.basename(argv[0]) };
}

const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;

async function inHerdr(command, label, cwd) {
	const env = launchDeps.env;
	if (!env.HERDR_SOCKET_PATH && !env.HERDR_ENV) return false;
	const herdr = env.HERDR_BIN_PATH || "herdr";
	try {
		const created = JSON.parse(await launchDeps.execFile(herdr, ["tab", "create", "--cwd", cwd, "--label", label, "--focus"]));
		const pane = created?.result?.root_pane?.pane_id;
		if (!pane) return false;
		await launchDeps.execFile(herdr, ["pane", "run", pane, command]);
		return true;
	} catch {
		return false;
	}
}

async function terminal() {
	const env = launchDeps.env;
	if (env.TERMINAL && (await launchDeps.executable(env.TERMINAL))) return env.TERMINAL;
	for (const name of TERMINALS) if (await launchDeps.executable(name)) return name;
	return env.TERMINAL || undefined;
}

function terminalArgs(bin, title, editor, file) {
	switch (path.basename(bin).toLowerCase()) {
		case "foot":
			return ["--app-id=cute-editor", "-T", title, ...editor, file];
		case "alacritty":
			return ["--class", "cute-editor,cute-editor", "-t", title, "-e", ...editor, file];
		case "kitty":
			return ["--class=cute-editor", "-T", title, ...editor, file];
		case "ghostty":
			return ["--class=cute-editor", "-e", ...editor, file];
		default:
			return ["-e", ...editor, file];
	}
}

/**
 * Opens `target` (the project folder `cwd` when undefined) in the editor. Resolves undefined once it is on
 * its way, or a short message saying why it could not be opened.
 */
export async function launchEditor(target, cwd) {
	try {
		const dir = cwd || process.cwd();
		const file = target ? path.resolve(dir, target) : dir;
		const editor = editorCommand();
		if (await inHerdr(`${editor.command} ${shellQuote(file)}`, `${editor.label}: ${path.basename(file)}`, dir)) return undefined;
		const bin = await terminal();
		if (!bin) return "no terminal found (set $TERMINAL)";
		return await new Promise((resolve) => {
			const child = launchDeps.spawn(bin, terminalArgs(bin, `CUTE: ${path.basename(file)}`, editor.argv, file), { detached: true, stdio: "ignore", cwd: dir });
			child.once("error", (error) => resolve(`could not open ${path.basename(bin)}: ${error?.message ?? error}`));
			child.once("spawn", () => {
				child.unref?.();
				resolve(undefined);
			});
		});
	} catch (error) {
		return `could not open the editor: ${error?.message ?? error}`;
	}
}
