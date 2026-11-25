// Worker-compatible concept reads. The caller supplies the MCP registration,
// schema implementation, and an authorized resolver for one exact release.
export const CONCEPT_USAGE = "Take colors, fonts and media from the system. Read a concept to learn the direction and its reasons, or because the task is about that concept.";

export function systemStamp(resolved) {
  const layer = resolved.layer;
  return {
    id: layer.system?.id ?? null,
    name: layer.system?.name ?? null,
    version: layer.system?.version ?? null,
    // An unversioned publication is identified by its stamp, not a label.
    ...(!layer.system?.version && layer.provenance?.sourceCommit ? { sourceCommit: layer.provenance.sourceCommit } : {}),
    ...(!layer.system?.version && typeof layer.provenance?.contentDigest === "string" ? { contentDigest: layer.provenance.contentDigest } : {}),
    published: resolved.published ?? null,
    pinned: resolved.pinned ?? null,
    ...(layer.stale ? { stale: true } : {}),
    source: layer.source?.kind ?? null,
    ...(layer.source?.kind === "draft" ? { draft: layer.source.draft, revision: layer.source.revision } : {}),
  };
}

export function registerConceptReadTools({ tool, z, systemFor }) {
  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  tool("list_concepts", {
    title: "List brand concepts",
    annotations: READ_ONLY,
    description: `List brand proposals with their id, title, reason, status and page. ${CONCEPT_USAGE}`,
  }, async args => {
    const resolved = await systemFor(args, ["concepts"]);
    const document = resolved.layer.concepts;
    const concepts = (document?.concepts ?? []).map(({ id, title, summary, status, url }) => ({ id, title, summary, status, url }));
    return { system: systemStamp(resolved), base: document?.base ?? null, approved: document?.approved ?? null, total: concepts.length, concepts };
  });

  tool("read_concept", {
    title: "Read a brand concept",
    annotations: READ_ONLY,
    description: `Read a proposal and its ordered pieces. Name an HTML piece by its file to read the mockup source. ${CONCEPT_USAGE}`,
    inputSchema: {
      concept: z.string().min(1).describe("Concept id from list_concepts"),
      piece: z.string().min(1).optional().describe("The file name of an HTML piece"),
    },
  }, async args => {
    const resolved = await systemFor(args, ["concepts"]);
    const document = resolved.layer.concepts;
    const concept = document?.concepts.find(entry => entry.id === args.concept);
    if (!concept) throw Object.assign(new Error(`No concept ${JSON.stringify(args.concept)}; list_concepts shows the directory`), { statusCode: 404 });
    const header = { system: systemStamp(resolved), base: document.base ?? null };
    if (args.piece) {
      const piece = concept.pieces.find(entry => entry.file === args.piece);
      if (typeof piece?.html !== "string") throw Object.assign(new Error(`No HTML piece ${JSON.stringify(args.piece)} in concept ${concept.id}`), { statusCode: 404 });
      return { ...header, concept: concept.id, file: piece.file, url: piece.url, html: piece.html };
    }
    return { ...header, concept: { ...concept, pieces: concept.pieces.map(({ html, ...metadata }) => metadata) } };
  });
}
