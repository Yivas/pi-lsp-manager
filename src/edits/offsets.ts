import type { LspPosition, NormalizedTextEdit } from "./normalize.js";

export interface OffsetEdit {
	start: number;
	end: number;
	newText: string;
}

/** Converts a UTF-16 LSP position without accepting CRLF interiors or surrogate halves. */
export function utf16Offset(
	text: string,
	position: LspPosition,
): number | undefined {
	if (
		!Number.isInteger(position.line) ||
		!Number.isInteger(position.character) ||
		position.line < 0 ||
		position.character < 0
	)
		return undefined;
	let offset = 0;
	for (let line = 0; line < position.line; line += 1) {
		const newline = text.indexOf("\n", offset);
		if (newline < 0) return undefined;
		offset = newline + 1;
	}
	let units = 0;
	for (let index = offset; index < text.length; ) {
		const unit = text.charCodeAt(index);
		if (unit === 0x0a || unit === 0x0d) break;
		if (units === position.character) return index;
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return undefined;
			units += 2;
			index += 2;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return undefined;
		} else {
			units += 1;
			index += 1;
		}
	}
	return units === position.character
		? offset + lineLength(text, offset)
		: undefined;
}
function lineLength(text: string, offset: number): number {
	let index = offset;
	while (index < text.length && text[index] !== "\r" && text[index] !== "\n")
		index += 1;
	return index - offset;
}

export function offsetEdits(
	text: string,
	edits: readonly NormalizedTextEdit[],
): readonly OffsetEdit[] | undefined {
	const values: OffsetEdit[] = [];
	for (const edit of edits) {
		const start = utf16Offset(text, edit.range.start);
		const end = utf16Offset(text, edit.range.end);
		if (start === undefined || end === undefined || start > end)
			return undefined;
		values.push({ start, end, newText: edit.newText });
	}
	const ascending = [...values].sort(
		(left, right) => left.start - right.start || left.end - right.end,
	);
	for (let index = 1; index < ascending.length; index += 1) {
		const previous = ascending[index - 1];
		const current = ascending[index];
		if (
			!previous ||
			!current ||
			previous.end > current.start ||
			// Concurrent zero-length insertions at one byte offset have no stable
			// server-defined ordering, so reject rather than silently reorder them.
			(previous.start === previous.end &&
				current.start === current.end &&
				previous.start === current.start)
		)
			return undefined;
	}
	return ascending.sort(
		(left, right) => right.start - left.start || right.end - left.end,
	);
}

export function applyOffsetEdits(
	text: string,
	edits: readonly OffsetEdit[],
): string {
	let result = text;
	for (const edit of edits)
		result = `${result.slice(0, edit.start)}${edit.newText}${result.slice(edit.end)}`;
	return result;
}
