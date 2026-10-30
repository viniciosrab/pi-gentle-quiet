// The YT tab's cover art, after pi-cinlodev-cute's src/youtube/youtube-cover.ts: the cover pi-youtube-player
// downloads (the file at thumbnailPath, else thumbnailBase64) drawn as a Kitty image three rows high. Unlike
// cute, nothing here blocks a render: the cover is read, and a JPEG converted to PNG (Kitty takes PNG only)
// with ImageMagick, in the background, and the column is redrawn once it is ready. Until the first one is
// ready, and wherever the terminal draws no Kitty images, draw() returns undefined and the tab keeps cute's
// stand-in; while a later cover loads, the last one stays.
//
// Each cover is turned into its Kitty sequence once, under one image id for the tab's life. Pi's renderImage
// registers the image anew on every call, and Pi re-sends a registered image whole (instead of placing the
// copy the terminal already holds) whenever it redraws the rows holding images: drawing the sequence afresh
// on every render made each redraw upload the cover again, and the cover blinked or stayed blank.
// @ts-nocheck

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as PiTui from "@earendil-works/pi-tui";

const ROWS = 3;
const CONVERT_TIMEOUT_MS = 3000;

/** A PNG's size from its IHDR header, or undefined when `buffer` is no PNG. */
export function pngSize(buffer) {
	if (!buffer || buffer.length < 24 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return undefined;
	return { widthPx: buffer.readUInt32BE(16), heightPx: buffer.readUInt32BE(20) };
}

/** cute's columns for a cover three rows high: 7 for a square one, up to 14 for a wide video frame. */
export function coverColumns(dimensions, inner) {
	if (!dimensions?.widthPx || !dimensions?.heightPx) return 7;
	const ratio = dimensions.widthPx / dimensions.heightPx;
	if (ratio <= 1.15) return 7;
	const most = Math.min(14, Math.max(7, Math.floor(inner * 0.38)));
	return Math.max(7, Math.min(most, Math.round(6.5 * ratio)));
}

// `magick - -resize 128x128 png:-`, then `convert` (ImageMagick 6): the PNG, or undefined.
function convert(command, buffer) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, ["-", "-resize", "128x128", "png:-"], { stdio: ["pipe", "pipe", "ignore"] });
		} catch {
			resolve(undefined);
			return;
		}
		const chunks = [];
		const timer = setTimeout(() => child.kill(), CONVERT_TIMEOUT_MS);
		timer.unref?.();
		child.on("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 ? Buffer.concat(chunks) : undefined);
		});
		child.stdin.on("error", () => {});
		child.stdin.end(buffer);
	});
}

const DEFAULTS = {
	images: () => PiTui.getCapabilities?.()?.images ?? null,
	allocateImageId: () => PiTui.allocateImageId?.(),
	renderImage: (base64, dimensions, options) => PiTui.renderImage?.(base64, dimensions, options),
	toPng: async (buffer) => (await convert("magick", buffer)) ?? (await convert("convert", buffer)),
};

// What identifies a cover without reading it. pi-youtube-player writes every cover to the same file, so the
// file is told apart by the cover's URL and the published copy beside it.
const sourceKey = (state) => {
	const base64 = typeof state?.thumbnailBase64 === "string" ? state.thumbnailBase64 : "";
	const file = typeof state?.thumbnailPath === "string" ? state.thumbnailPath : "";
	if (!base64 && !file) return "";
	return `${file}|${state?.thumbnailUrl ?? ""}|${base64.length}:${base64.slice(0, 64)}:${base64.slice(-64)}`;
};

// The cover's bytes: the file on disk first, the published base64 when the file cannot be read.
async function readCover(state) {
	if (typeof state?.thumbnailPath === "string" && state.thumbnailPath) {
		try {
			const buffer = await readFile(state.thumbnailPath);
			if (buffer.length) return buffer;
		} catch {
			// gone or unreadable: the published copy
		}
	}
	return typeof state?.thumbnailBase64 === "string" && state.thumbnailBase64 ? Buffer.from(state.thumbnailBase64, "base64") : undefined;
}

/**
 * The cover for the YT tab. draw(state, inner) gives the Kitty sequence and the columns it covers, or
 * undefined (no image protocol, no cover, the first one still loading, unreadable); `requestRender` is called
 * when a cover finished loading.
 */
export function createCover(requestRender, deps = {}) {
	const use = { ...DEFAULTS, ...deps };
	let wanted = ""; // the source key asked for last
	let ready; // { key, base64, dimensions }: the last cover read
	let imageId; // one for the tab: each new cover replaces the last in the terminal
	let image; // { key, columns, sequence, drawnColumns }: ready's sequence, made once

	const load = async (key, state) => {
		let buffer = await readCover(state);
		if (buffer && !pngSize(buffer)) buffer = await use.toPng(buffer);
		const dimensions = pngSize(buffer);
		if (!dimensions || key !== wanted) return;
		ready = { key, base64: buffer.toString("base64"), dimensions };
		requestRender();
	};

	return {
		draw(state, inner) {
			try {
				if (use.images() !== "kitty") return undefined;
				const key = sourceKey(state);
				if (!key) return undefined;
				if (key !== wanted) {
					wanted = key;
					load(key, state).catch(() => {});
				}
				if (!ready) return undefined;
				const columns = coverColumns(ready.dimensions, inner);
				if (image?.key !== ready.key || image.columns !== columns) {
					imageId ??= use.allocateImageId();
					const drawn = use.renderImage(ready.base64, ready.dimensions, { maxWidthCells: columns, maxHeightCells: ROWS, imageId, moveCursor: false });
					image = drawn?.sequence ? { key: ready.key, columns, sequence: drawn.sequence, drawnColumns: drawn.columns ?? columns } : undefined;
				}
				return image ? { sequence: image.sequence, columns: image.drawnColumns } : undefined;
			} catch {
				return undefined;
			}
		},
	};
}
