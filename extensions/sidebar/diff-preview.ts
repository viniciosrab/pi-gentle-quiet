// The changes in a file preview opened from the GIT tab (./git.ts, ./tree-preview.ts): a `git diff` of one
// file, run with the whole file as context, read back as the file's rows. Each row is unchanged (" "), added
// ("+") or removed ("-"); unchanged and removed rows carry their line number in the old file (`old`), unchanged
// and added ones their number in the new file (`number`); removed rows stand where they were removed from.
// Parsers are pure functions.
// @ts-nocheck

/** Context lines asked of `git diff` so its one hunk holds the whole file (-U<FULL_CONTEXT>). */
export const FULL_CONTEXT = 1000000;

export interface DiffRow {
	sign: " " | "+" | "-";
	text: string;
	old?: number; // the line in the old file; none on an added row
	number?: number; // the line in the new file; none on a removed row
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * One file's `git diff` as { rows, added, removed }, or undefined when it has no hunk: no change, a binary
 * file, a failed git. Hunks are read by their line counts, so a removed "-- x" is never taken for a header.
 */
export function parseFileDiff(output) {
	if (typeof output !== "string" || !output) return undefined;
	const lines = output.split("\n");
	const rows = [];
	let added = 0;
	let removed = 0;
	let hunks = 0;
	for (let i = 0; i < lines.length; i++) {
		const head = HUNK.exec(lines[i]);
		if (!head) continue;
		hunks++;
		let old = head[2] === undefined ? 1 : Number(head[2]); // old lines left in the hunk
		let fresh = head[4] === undefined ? 1 : Number(head[4]); // new lines left
		let before = Number(head[1]) || 1; // the next old line's number
		let number = Number(head[3]);
		while ((old > 0 || fresh > 0) && i + 1 < lines.length) {
			const line = lines[++i];
			if (line.startsWith("\\")) continue; // "\ No newline at end of file"
			const sign = line[0];
			const text = line.slice(1).replace(/\r$/, "");
			if (sign === "+") {
				rows.push({ sign, text, number: number++ });
				added++;
				fresh--;
			} else if (sign === "-") {
				rows.push({ sign, text, old: before++ });
				removed++;
				old--;
			} else if (sign === " " || line === "") {
				rows.push({ sign: " ", text, old: before++, number: number++ });
				old--;
				fresh--;
			} else {
				i--; // not a hunk line: a truncated hunk ends here
				break;
			}
		}
	}
	return hunks && rows.length ? { rows, added, removed } : undefined;
}

/** Every line of a new file as an added row. */
export function addedRows(lines) {
	return lines.map((text, index) => ({ sign: "+", text, number: index + 1 }));
}

/** Where each run of changed rows starts, in row indexes. */
export function changeBlocks(rows) {
	const starts = [];
	rows.forEach((row, index) => {
		if (row.sign !== " " && (index === 0 || rows[index - 1].sign === " ")) starts.push(index);
	});
	return starts;
}
