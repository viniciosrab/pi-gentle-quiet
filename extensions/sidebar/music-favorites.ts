// cliamp's favorites, the ♥ of the Music card (./music.ts) and of its picker (./music-picker.ts). cliamp v2.3 keeps
// them in favorites.toml in its config folder (cliampDir) and toggles them only from its TUI (f): playlist.bookmark,
// the remote call, refuses its Favorites. So the Pi edits that file itself, as cliamp's favorites store does: under an
// exclusive flock on favorites.toml.lock, held for the whole read-modify-write; a track whose path is there is
// removed, any other is put first as a new [[entry]] (favorited_at, path, title, then artist and album when
// there are some, Go-quoted). The file is edited as text blocks, so every other entry stays byte for byte, and
// written atomically (a temp file in the same folder, fsync, rename, 0644). The first change ever copies the file
// to favorites.toml.pi-backup.
//
// Node has no flock, and Pi usually runs from a compiled Bun binary (process.execPath is Pi itself, so a helper
// script cannot be run with it): the lock is taken by util-linux's `flock` running `cat` with the lock held, and
// it is held until this process closes that child's stdin (or dies, which closes it too).
// @ts-nocheck

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** cliamp's config folder, as its appdir.Dir: $CLIAMP_CONFIG_DIR, else $XDG_CONFIG_HOME/cliamp, else ~/.config/cliamp. */
export function cliampDir(env = process.env) {
	if (env.CLIAMP_CONFIG_DIR) return env.CLIAMP_CONFIG_DIR;
	return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config"), "cliamp");
}

/** Where the favorites are and how they are locked; tests swap them for a folder of their own. */
export const favoritesDeps = {
	file: () => path.join(cliampDir(), "favorites.toml"),
	flock: "flock",
	wait: 3, // seconds to wait for cliamp's lock
	now: () => new Date(),
};

const BUSY = 75; // flock's exit code when the lock could not be taken in time

/** A string quoted as Go's %q does for the usual text: \\ \" \n \t \r and the other controls escaped. */
export function goQuote(text) {
	let out = '"';
	for (const char of String(text ?? "")) {
		const code = char.codePointAt(0);
		const named = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\t": "\\t", "\r": "\\r", "\x07": "\\a", "\b": "\\b", "\f": "\\f", "\v": "\\v" }[char];
		if (named) out += named;
		else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
		else if (code >= 0x80 && code <= 0x9f) out += `\\u${code.toString(16).padStart(4, "0")}`;
		else out += char;
	}
	return `${out}"`;
}

// A Go- or TOML-quoted string's text.
function unquote(quoted) {
	const named = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", '"': '"', "\\": "\\", "'": "'" };
	return quoted.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, escape) => {
		if (escape.length > 1) return String.fromCodePoint(parseInt(escape.slice(1), 16));
		return named[escape] ?? escape;
	});
}

// The file split at its [[entry]] rows: what comes before the first one, and each entry with what follows it.
function split(text) {
	const starts = [...text.matchAll(/^\[\[entry\]\][ \t]*$/gm)].map((match) => match.index);
	return { head: text.slice(0, starts[0] ?? text.length), blocks: starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length)) };
}

const pathOf = (block) => {
	const match = /^path[ \t]*=[ \t]*("(?:[^"\\]|\\.)*")[ \t]*$/m.exec(block);
	return match ? unquote(match[1]) : undefined;
};

/** The paths of favorites.toml's entries, newest first; an entry without a path is left out, as cliamp does. */
export function favoritePaths(text) {
	return split(String(text ?? "")).blocks.map(pathOf).filter(Boolean);
}

/** favorites.toml with `track` toggled: { text, added }. */
export function toggledText(text, track, now) {
	const { head, blocks } = split(text);
	const at = blocks.findIndex((block) => pathOf(block) === track.path);
	if (at >= 0) {
		blocks.splice(at, 1);
		// The entry that is now the last one loses the blank row that parted it from the removed one.
		if (at === blocks.length && blocks.length && blocks[at - 1].endsWith("\n\n")) blocks[at - 1] = blocks[at - 1].slice(0, -1);
		return { text: head + blocks.join(""), added: false };
	}
	const lines = ["[[entry]]", `favorited_at = ${goQuote(now.toISOString().replace(/\.\d+Z$/, "Z"))}`, `path = ${goQuote(track.path)}`, `title = ${goQuote(track.title ?? "")}`];
	if (track.artist) lines.push(`artist = ${goQuote(track.artist)}`);
	if (track.album) lines.push(`album = ${goQuote(track.album)}`);
	const entry = `${lines.join("\n")}\n`;
	return { text: head + entry + (blocks.length ? `\n${blocks.join("")}` : ""), added: true };
}

/** The favorites' paths read from favorites.toml (none when there is no file); undefined when it cannot be read. */
export async function readFavoritePaths() {
	try {
		return new Set(favoritePaths(await fs.promises.readFile(favoritesDeps.file(), "utf8")));
	} catch (error) {
		return error?.code === "ENOENT" ? new Set() : undefined;
	}
}

// Takes cliamp's lock; resolves the release once it is held.
function lock(lockPath) {
	return new Promise((resolve, reject) => {
		const child = spawn(favoritesDeps.flock, ["-w", String(favoritesDeps.wait), "-E", String(BUSY), lockPath, "cat"], { stdio: ["pipe", "pipe", "pipe"] });
		let held = false;
		let errors = "";
		const exited = new Promise((done) => child.once("close", done));
		const release = async () => {
			child.stdin.end();
			const timer = setTimeout(() => child.kill(), 2000);
			await exited;
			clearTimeout(timer);
		};
		child.stderr.on("data", (data) => (errors += data));
		child.on("error", (error) => reject(error?.code === "ENOENT" ? new Error("flock is not installed") : error));
		child.on("spawn", () => {
			// flock runs cat only once the lock is held: cat echoing a byte back says so.
			child.stdout.once("data", () => {
				held = true;
				resolve(release);
			});
			child.stdin.write("\n");
		});
		child.on("close", (code) => {
			if (held) return;
			reject(new Error(code === BUSY ? "cliamp's favorites are busy" : errors.trim().split("\n")[0] || `flock ended with ${code}`));
		});
	});
}

// Writes `text` to `file` through a temp file in its folder: fsync, then rename, 0644.
async function writeAtomic(file, text) {
	const temp = path.join(path.dirname(file), `.${path.basename(file)}.pi-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`);
	try {
		const handle = await fs.promises.open(temp, "wx", 0o644);
		try {
			await handle.writeFile(text, "utf8");
			await handle.chmod(0o644);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.promises.rename(temp, file);
	} catch (error) {
		await fs.promises.rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
}

/**
 * Toggles `track` ({ path, title, artist, album }) in cliamp's favorites: true when it was added, false when it
 * was removed. Rejects with a short reason (flock missing, the lock busy, a write that failed); then the file is
 * as it was.
 */
export async function toggleFavorite(track) {
	if (typeof track?.path !== "string" || !track.path) throw new Error("the track has no path");
	const file = favoritesDeps.file();
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const release = await lock(`${file}.lock`);
	try {
		let text = "";
		let exists = true;
		try {
			text = await fs.promises.readFile(file, "utf8");
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			exists = false;
		}
		const next = toggledText(text, track, favoritesDeps.now());
		if (exists) await fs.promises.copyFile(file, `${file}.pi-backup`, fs.constants.COPYFILE_EXCL).catch((error) => {
			if (error?.code !== "EEXIST") throw error;
		});
		await writeAtomic(file, next.text);
		return next.added;
	} finally {
		await release();
	}
}
