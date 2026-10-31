import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { favoritePaths, favoritesDeps, goQuote, readFavoritePaths, toggleFavorite } from "../extensions/sidebar/music-favorites.ts";

const BUBBLES = `[[entry]]
favorited_at = "2026-10-31T07:01:37Z"
path = "https://radio.cliamp.stream/lofi/tracks/76b27030c181634b"
title = "Bubbles ( Lofi , Bright , Relaxed )"
artist = "HoliznaCC0"
album = "Public Domain Lofi"
`;
const NEON = `[[entry]]
favorited_at = "2026-10-30T10:00:00Z"
path = "https://radio.cliamp.stream/synthwave/tracks/s1"
title = "Neon"
artist = "Volt"
genre = "Synthwave"
`;
const SHIMMER = { path: "https://radio.cliamp.stream/lofi/tracks/3d984cd3b593ecfc", title: "Shimmer ( LoFi , Chill )", artist: "HoliznaCC0", album: "Public Domain Lofi" };
const SHIMMER_ENTRY = `[[entry]]
favorited_at = "2026-10-31T12:34:56Z"
path = "https://radio.cliamp.stream/lofi/tracks/3d984cd3b593ecfc"
title = "Shimmer ( LoFi , Chill )"
artist = "HoliznaCC0"
album = "Public Domain Lofi"
`;

// A cliamp config dir of its own under /tmp, with favorites.toml holding `text` (undefined: no file).
function store(t, text) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "music-favorites-"));
	const file = path.join(dir, "cliamp", "favorites.toml");
	fs.mkdirSync(path.dirname(file));
	if (text !== undefined) fs.writeFileSync(file, text);
	const saved = { ...favoritesDeps };
	Object.assign(favoritesDeps, { file: () => file, now: () => new Date("2026-10-31T12:34:56.789Z"), wait: 1 });
	t.after(() => Object.assign(favoritesDeps, saved));
	return { dir, file, read: () => fs.readFileSync(file, "utf8") };
}

test("a track is added first, in cliamp's format; the other entries stay byte for byte", async (t) => {
	const { file, read } = store(t, `${BUBBLES}\n${NEON}`);
	assert.equal(await toggleFavorite(SHIMMER), true);
	assert.equal(read(), `${SHIMMER_ENTRY}\n${BUBBLES}\n${NEON}`);
	assert.equal(fs.statSync(file).mode & 0o777, 0o644);
	assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["favorites.toml", "favorites.toml.lock", "favorites.toml.pi-backup"], "no temp file left");
});

test("a track already there is removed by its path", async (t) => {
	const { read } = store(t, `${BUBBLES}\n${NEON}`);
	assert.equal(await toggleFavorite({ path: "https://radio.cliamp.stream/synthwave/tracks/s1", title: "whatever" }), false);
	assert.equal(read(), BUBBLES, "the last one gone, with its blank row");
	const { read: again } = store(t, `${BUBBLES}\n${NEON}`);
	await toggleFavorite({ path: "https://radio.cliamp.stream/lofi/tracks/76b27030c181634b" });
	assert.equal(again(), NEON, "the first one gone");
	const { read: last } = store(t, BUBBLES);
	await toggleFavorite({ path: "https://radio.cliamp.stream/lofi/tracks/76b27030c181634b" });
	assert.equal(last(), "", "no entry left");
});

test("a missing file is created with the one entry; the artist and album only when there are some", async (t) => {
	const { file, read } = store(t);
	assert.equal(await toggleFavorite({ path: "/music/a.mp3", title: "A", artist: "", album: undefined }), true);
	assert.equal(read(), '[[entry]]\nfavorited_at = "2026-10-31T12:34:56Z"\npath = "/music/a.mp3"\ntitle = "A"\n');
	assert.ok(!fs.existsSync(`${file}.pi-backup`), "nothing to back up");
});

test("titles are quoted as Go's %q, and read back", async (t) => {
	assert.equal(goQuote('say "hi" \\ there'), '"say \\"hi\\" \\\\ there"');
	assert.equal(goQuote("a\nb\tc\rd\x01é ♥"), '"a\\nb\\tc\\rd\\x01é ♥"');
	const { read } = store(t, NEON);
	await toggleFavorite({ path: '/x/"q"\\.mp3', title: 'He said "go" \\ now' });
	assert.match(read(), /^\[\[entry\]\]\nfavorited_at = "2026-10-31T12:34:56Z"\npath = "\/x\/\\"q\\"\\\\\.mp3"\ntitle = "He said \\"go\\" \\\\ now"\n\n/);
	assert.deepEqual(favoritePaths(read()), ['/x/"q"\\.mp3', "https://radio.cliamp.stream/synthwave/tracks/s1"]);
	assert.equal(await toggleFavorite({ path: '/x/"q"\\.mp3' }), false, "found again by its path");
	assert.equal(read(), NEON);
});

test("the paths are read from the file; no file is no favorites; an entry without a path is dropped", async (t) => {
	assert.deepEqual(favoritePaths(`${BUBBLES}\n[[entry]]\ntitle = "no path"\n\n${NEON}`), ["https://radio.cliamp.stream/lofi/tracks/76b27030c181634b", "https://radio.cliamp.stream/synthwave/tracks/s1"]);
	store(t, `${BUBBLES}\n${NEON}`);
	assert.deepEqual([...(await readFavoritePaths())], ["https://radio.cliamp.stream/lofi/tracks/76b27030c181634b", "https://radio.cliamp.stream/synthwave/tracks/s1"]);
	store(t);
	assert.deepEqual([...(await readFavoritePaths())], []);
});

test("the first change backs the file up once", async (t) => {
	const { file, read } = store(t, BUBBLES);
	await toggleFavorite(SHIMMER);
	assert.equal(fs.readFileSync(`${file}.pi-backup`, "utf8"), BUBBLES);
	await toggleFavorite(SHIMMER);
	await toggleFavorite({ path: "https://radio.cliamp.stream/lofi/tracks/76b27030c181634b" });
	assert.equal(read(), "");
	assert.equal(fs.readFileSync(`${file}.pi-backup`, "utf8"), BUBBLES, "the backup is the file before the first change");
});

test("while another process holds cliamp's lock the toggle waits, then gives up and leaves the file alone", async (t) => {
	const { file, read } = store(t, BUBBLES);
	const lock = `${file}.lock`;
	const holder = spawn("flock", [lock, "sleep", "5"], { stdio: "ignore" });
	t.after(() => holder.kill());
	for (let i = 0; i < 50; i++) {
		try {
			execFileSync("flock", ["-n", lock, "true"]);
			await new Promise((resolve) => setTimeout(resolve, 20));
		} catch {
			break; // held
		}
	}
	const started = Date.now();
	await assert.rejects(toggleFavorite(SHIMMER), /cliamp's favorites are busy/);
	assert.ok(Date.now() - started >= 900, "it waited for the lock");
	assert.equal(read(), BUBBLES);
	assert.ok(!fs.existsSync(`${file}.pi-backup`));
});

test("a lock released in time is waited for, then the toggle goes on", async (t) => {
	const { file, read } = store(t, BUBBLES);
	favoritesDeps.wait = 3;
	const holder = spawn("flock", [`${file}.lock`, "sleep", "0.6"], { stdio: "ignore" });
	t.after(() => holder.kill());
	await new Promise((resolve) => setTimeout(resolve, 100));
	const started = Date.now();
	assert.equal(await toggleFavorite(SHIMMER), true);
	assert.ok(Date.now() - started >= 300, "it waited for the other process");
	assert.equal(read(), `${SHIMMER_ENTRY}\n${BUBBLES}`);
});

test("without flock the toggle fails with a reason and writes nothing", async (t) => {
	const { read } = store(t, BUBBLES);
	favoritesDeps.flock = "/nonexistent/flock";
	await assert.rejects(toggleFavorite(SHIMMER), /flock/);
	assert.equal(read(), BUBBLES);
});
