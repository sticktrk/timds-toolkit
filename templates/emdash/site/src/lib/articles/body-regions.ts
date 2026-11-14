import { getEditMeta, type PortableTextBlock } from "emdash";

export function insertionIndex(length: number, fraction: number | undefined): number | undefined {
	if (length < 2 || fraction === undefined || !(fraction > 0 && fraction < 1)) return undefined;
	return Math.min(length - 1, Math.max(1, Math.round(length * fraction)));
}

function blockGroup(block: PortableTextBlock): "list" | "quote" | undefined {
	if (block?._type !== "block") return undefined;
	if ("listItem" in block && typeof block.listItem === "string") return "list";
	if ("style" in block && block.style === "blockquote") return "quote";
	return undefined;
}

/** Preserve the inline editor and avoid splitting a list, numbered continuation or quote. */
export function portableTextBoundary(body: PortableTextBlock[] | null | undefined, fraction: number | undefined): number | undefined {
	if (!Array.isArray(body) || getEditMeta(body)) return undefined;
	const target = insertionIndex(body.length, fraction);
	if (target === undefined) return undefined;
	const listRuns = new Map<string, { first: number; last: number }>();
	for (const [index, block] of body.entries()) {
		if (blockGroup(block) !== "list" || !("listId" in block) || typeof block.listId !== "string" || !block.listId) continue;
		const run = listRuns.get(block.listId);
		if (run) run.last = index;
		else listRuns.set(block.listId, { first: index, last: index });
	}
	const changes = new Map<number, number>();
	for (const { first, last } of listRuns.values()) {
		changes.set(first + 1, (changes.get(first + 1) ?? 0) + 1);
		changes.set(last + 1, (changes.get(last + 1) ?? 0) - 1);
	}
	let nearest: number | undefined;
	let continuations = 0;
	for (let index = 1; index < body.length; index++) {
		continuations += changes.get(index) ?? 0;
		const previous = blockGroup(body[index - 1]);
		if (continuations || previous && previous === blockGroup(body[index])) continue;
		if (nearest === undefined || Math.abs(index - target) < Math.abs(nearest - target)) nearest = index;
	}
	return nearest;
}
