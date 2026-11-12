/** Merge opaque EmDash cursors without offsets or invented database cursor encodings. */
export async function mergeSectionEntries(sections, query, { cursor, topic, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("The article page size must be between 1 and 100.");
  const scope = JSON.stringify([sections.map(({ collection }) => collection), topic ?? null]);
  let positions = sections.map(() => "");
  if (cursor) {
    try {
      if (cursor.length > 100000) throw new Error();
      const document = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0))));
      if (document.version !== 1 || document.scope !== scope || !Array.isArray(document.positions) || document.positions.length !== sections.length || document.positions.some((value) => value !== null && (typeof value !== "string" || value.length > 4096))) throw new Error();
      positions = document.positions;
    } catch { throw new Error("Invalid article page cursor; start again from the first page."); }
  }
  const candidates = new Map(), cacheHints = [];
  const load = async (index) => {
    if (positions[index] === null) return;
    const page = await query(sections[index].collection, { orderBy: { published_at: "desc" }, limit: 1, ...(topic ? { where: { topic } } : {}), ...(positions[index] ? { cursor: positions[index] } : {}) });
    if (page.error) throw page.error;
    cacheHints.push(page.cacheHint);
    if (page.entries.length) candidates.set(index, { entry: page.entries[0], next: page.nextCursor ?? null });
    else positions[index] = null;
  };
  await Promise.all(sections.map((_section, index) => load(index)));
  const entries = [];
  while (entries.length < limit && candidates.size) {
    const [index, selected] = [...candidates].sort(([a, left], [b, right]) => {
      const date = new Date(right.entry.data.publishedAt ?? 0).getTime() - new Date(left.entry.data.publishedAt ?? 0).getTime();
      return date || sections[a].collection.localeCompare(sections[b].collection) || String(right.entry.data.id).localeCompare(String(left.entry.data.id));
    })[0];
    entries.push({ entry: selected.entry, section: sections[index] });
    candidates.delete(index);
    positions[index] = selected.next;
    if (entries.length < limit) await load(index);
  }
  const hasMore = positions.some((position) => position !== null);
  const document = JSON.stringify({ version: 1, scope, positions });
  const nextCursor = hasMore ? btoa(String.fromCharCode(...new TextEncoder().encode(document))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : undefined;
  return { entries, nextCursor, cacheHints };
}
