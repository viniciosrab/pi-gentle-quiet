// The GIT tab's launchers, after pi-cinlodev-cute's src/git/git-launchers.ts, src/tree/tree-launchers.ts and
// launchInHerdrTab in src/cute-notify.ts: inside herdr a focused herdr tab, else a detached terminal window
// (foot, alacritty, kitty, ghostty). Nothing here blocks the UI: herdr runs through an asynchronous execFile.
// @ts-nocheck

import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const onPath = (name, env) =>
	(env.PATH ?? "").split(path.delimiter).some((dir) => {
		try {
			const full = path.join(dir, name);
			return existsSync(full) && (statSync(full).mode & 0o111) !== 0;
		} catch {
			return false;
		}
	});

/** What the launchers run with; tests swap these. */
export const launchDeps = {
	env: process.env,
	execFile,
	spawn,
	which: (name) => onPath(name, launchDeps.env),
};

const quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

/** The editor command: $VISUAL, $EDITOR, or nvim. */
export const editorCommand = () => launchDeps.env.VISUAL || launchDeps.env.EDITOR || "nvim";
/** The editor's program name, for hints and titles. */
export const editorName = () => path.basename(editorCommand().trim().split(/\s+/)[0] || "nvim");

const inHerdr = () => Boolean(launchDeps.env.HERDR_SOCKET_PATH || launchDeps.env.HERDR_ENV);
const herdrBin = () => launchDeps.env.HERDR_BIN_PATH || "herdr";

const run = (bin, args) =>
	new Promise((resolve) => {
		try {
			launchDeps.execFile(bin, args, { encoding: "utf8", timeout: 2000 }, (error, stdout) => resolve(error ? undefined : String(stdout ?? "")));
		} catch {
			resolve(undefined);
		}
	});

/** `command` in a new focused herdr tab labeled `label`; false when herdr is not there or fails. */
async function herdrTab(command, label, cwd) {
	const out = await run(herdrBin(), ["tab", "create", "--cwd", cwd, "--label", label, "--focus"]);
	let pane;
	try {
		pane = JSON.parse(out ?? "")?.result?.root_pane?.pane_id;
	} catch {
		pane = undefined;
	}
	if (!pane) return false;
	return (await run(herdrBin(), ["pane", "run", pane, command])) !== undefined;
}

/** The terminal to open: $TERMINAL when it is on the PATH, else the first of foot, alacritty, ghostty, kitty. */
export function detectTerminal() {
	const wanted = launchDeps.env.TERMINAL;
	if (wanted && launchDeps.which(wanted)) return wanted;
	return ["foot", "alacritty", "ghostty", "kitty"].find((name) => launchDeps.which(name)) ?? wanted ?? "foot";
}

/** `command` through `sh -c` in a detached terminal window titled `title`. */
function terminalWindow(command, title, cwd) {
	try {
		const terminal = detectTerminal();
		const shell = ["sh", "-c", command];
		const args = {
			foot: ["--app-id=pi-gentle-quiet", "-T", title, ...shell],
			alacritty: ["--class", "pi-gentle-quiet,pi-gentle-quiet", "-t", title, "-e", ...shell],
			kitty: ["--class=pi-gentle-quiet", "-T", title, ...shell],
			ghostty: ["--class=pi-gentle-quiet", "-e", ...shell],
		}[path.basename(terminal).toLowerCase()] ?? ["-e", ...shell];
		const child = launchDeps.spawn(terminal, args, { detached: true, stdio: "ignore", cwd });
		child.on?.("error", () => {});
		child.unref?.();
		return true;
	} catch {
		return false;
	}
}

// Outside herdr the terminal starts right away, inside the click.
function launch(command, label, cwd): Promise<boolean> {
	if (!inHerdr()) return Promise.resolve(terminalWindow(command, label, cwd));
	return herdrTab(command, label, cwd)
		.catch(() => false)
		.then((opened) => opened || terminalWindow(command, label, cwd));
}

/** Opens `file` (absolute) in the editor. */
export function openInEditor(file, cwd) {
	return launch(`${editorCommand()} ${quote(file)}`, `${editorName()}: ${path.basename(file)}`, cwd);
}

/**
 * Opens a diff in less: the working tree against HEAD (branch null) or HEAD...branch, of one file or all of
 * them. An untracked file is shown against nothing.
 */
export function openDiff(cwd, branch, file = undefined, untracked = false) {
	const target = branch ? quote(`HEAD...${branch}`) : "HEAD";
	const what = file === undefined ? target : untracked ? `--no-index -- /dev/null ${quote(file)}` : `${target} -- ${quote(file)}`;
	const command = `git -c color.ui=always diff --color=always ${what} | less -R`;
	return launch(command, `diff: ${file ? path.basename(file) : "all"} (${branch ?? "HEAD"})`, cwd);
}
