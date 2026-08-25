const PRODUCER_SCHEMA_VERSION = 1;
const PRODUCER_AUTHORING_SCHEMA_VERSION = 1;
const beatRoles = ["hook", "rule", "risk", "process", "exception", "answer"];

const object = (value, label) => {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be a JSON object`);
  return value;
};

const text = (value, label) => {
  const result = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
};

const words = (value) => String(value ?? "").trim().split(/\s+/u).filter(Boolean);
const slugSafe = (value, label) => {
  const result = text(value, label);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(result)) throw new Error(`${label} must use lowercase letters, numbers, and hyphens`);
  return result;
};

const positiveInteger = (value, label) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
};

const promptBlockId = (value, label) => {
  const result = text(value, label);
  if (!/^[a-z0-9][a-z0-9/-]*#[a-z0-9][a-z0-9-]*$/u.test(result)) {
    throw new Error(`${label} must be a page/block id such as social/voice#writing-rules`);
  }
  return result;
};

const promptBlockIds = (value, label) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => promptBlockId(entry, `${label}[${index}]`));
};

const renderTemplate = (template, values) => text(template, "video producer template").replace(/\{\{(question|topic|site|series)\}\}/gu, (_match, key) => values[key]);
const tokens = (value) => new Set(String(value ?? "").toLocaleLowerCase().replace(/[^a-z0-9]+/gu, " ").split(/\s+/u).filter((token) => token.length >= 4));
const score = (query, candidate) => [...query].reduce((sum, token) => sum + (tokens(candidate).has(token) ? 1 : 0), 0);

export function validateVideoProducerConfig(input, contract) {
  if (input === undefined || input === null || input === false) return null;
  const config = object(input, "video contract producer");
  if (Number(config.schemaVersion) !== PRODUCER_SCHEMA_VERSION) throw new Error(`video contract producer.schemaVersion must be ${PRODUCER_SCHEMA_VERSION}`);
  const roleEyebrows = object(config.roleEyebrows, "video contract producer.roleEyebrows");
  const engagement = object(config.engagement || {}, "video contract producer.engagement");
  const intro = object(config.intro || {}, "video contract producer.intro");
  const outro = object(config.outro || {}, "video contract producer.outro");
  const cover = object(config.cover || {}, "video contract producer.cover");
  const footage = object(config.footage || {}, "video contract producer.footage");
  const authoring = object(config.authoring || {}, "video contract producer.authoring");
  const formatPromptBlocks = object(authoring.formatPromptBlocks || {}, "video contract producer.authoring.formatPromptBlocks");
  const formats = engagement.formats || ["horizontal"];
  if (!Array.isArray(formats) || formats.some((format) => !["horizontal", "short"].includes(format))) {
    throw new Error("video contract producer.engagement.formats may contain only horizontal or short");
  }
  const prefix = (value, label, fallback) => {
    const result = text(value || fallback, label);
    if (!/^[a-z0-9][a-z0-9-]*-$/u.test(result)) throw new Error(`${label} must be a slug-safe prefix ending in a hyphen`);
    return result;
  };
  return {
    ...config,
    schemaVersion: PRODUCER_SCHEMA_VERSION,
    topicLabel: {
      minimumWords: positiveInteger(config.topicLabel?.minimumWords || 2, "video contract producer.topicLabel.minimumWords"),
      maximumWords: positiveInteger(config.topicLabel?.maximumWords || 4, "video contract producer.topicLabel.maximumWords"),
    },
    roleEyebrows: Object.fromEntries(beatRoles.map((role) => [role, text(roleEyebrows[role], `video contract producer.roleEyebrows.${role}`)])),
    intro: { enabled: intro.enabled !== false, id: slugSafe(intro.id || "intro", "video contract producer.intro.id") },
    engagement: {
      enabled: engagement.enabled !== false,
      formats,
      id: slugSafe(engagement.id || "engage", "video contract producer.engagement.id"),
      eyebrow: text(engagement.eyebrow, "video contract producer.engagement.eyebrow"),
      narrationTemplate: text(engagement.narrationTemplate, "video contract producer.engagement.narrationTemplate"),
      requireYesNoQuestion: engagement.requireYesNoQuestion === true,
    },
    outro: {
      enabled: outro.enabled !== false,
      id: slugSafe(outro.id || "outro", "video contract producer.outro.id"),
      narrationTemplate: text(outro.narrationTemplate, "video contract producer.outro.narrationTemplate"),
    },
    cover: {
      eyebrow: text(cover.eyebrow || contract.brand.series, "video contract producer.cover.eyebrow"),
      defaultEmotion: text(cover.defaultEmotion || "concern", "video contract producer.cover.defaultEmotion"),
      assetPrefix: prefix(cover.assetPrefix, "video contract producer.cover.assetPrefix", "cover-subject-"),
    },
    footage: {
      assetPrefix: prefix(footage.assetPrefix, "video contract producer.footage.assetPrefix", "footage-"),
    },
    authoring: {
      sharedPromptBlocks: promptBlockIds(authoring.sharedPromptBlocks, "video contract producer.authoring.sharedPromptBlocks"),
      formatPromptBlocks: {
        horizontal: promptBlockIds(formatPromptBlocks.horizontal, "video contract producer.authoring.formatPromptBlocks.horizontal"),
        short: promptBlockIds(formatPromptBlocks.short, "video contract producer.authoring.formatPromptBlocks.short"),
      },
    },
  };
}

const indexBlock = (index, blockId) => {
  const [pageId] = blockId.split("#");
  const page = index.pages.find((candidate) => candidate?.id === pageId);
  return page?.blocks?.find((candidate) => candidate?.id === blockId) || null;
};

const renderPromptBlock = (block) => {
  const lines = [];
  if (block.intro) lines.push(text(block.intro, `${block.id}.intro`));
  for (const table of Array.isArray(block.specs) ? block.specs : []) {
    const columns = Array.isArray(table.columns) ? table.columns : [];
    for (const row of Array.isArray(table.rows) ? table.rows : []) {
      const values = columns.map((column) => String(row?.fields?.[column] ?? "").trim()).filter(Boolean);
      if (!values.length || /^\{[A-Z0-9_]+\}$/u.test(values[0])) continue;
      lines.push(`- [${text(row.id, `${block.id} spec row id`)}] ${values.join(" — ")}`);
    }
  }
  for (const note of Array.isArray(block.notes) ? block.notes : []) {
    lines.push(`- [${text(note.id, `${block.id} note id`)}] ${text(note.text, `${block.id} note text`)}`);
  }
  for (const prose of Array.isArray(block.prose) ? block.prose : []) {
    lines.push(`- [${text(prose.id, `${block.id} prose id`)}] ${text(prose.text, `${block.id} prose text`)}`);
  }
  return `${block.id} — ${text(block.title, `${block.id}.title`)}\n${lines.join("\n")}`;
};

const maximumWordsPattern = (maximum) => `^\\S+(?:\\s+\\S+){0,${maximum - 1}}$`;
const wordRangePattern = (minimum, maximum) => `^\\S+(?:\\s+\\S+){${minimum - 1},${maximum - 1}}$`;
const yesNoQuestionPattern = "^(?:[Aa][Rr][Ee]|[Cc][Aa][Nn]|[Cc][Oo][Uu][Ll][Dd]|[Dd][Ii][Dd]|[Dd][Oo]|[Dd][Oo][Ee][Ss]|[Hh][Aa][Ss]|[Hh][Aa][Vv][Ee]|[Ii][Ss]|[Ss][Hh][Oo][Uu][Ll][Dd]|[Ww][Aa][Ss]|[Ww][Ee][Rr][Ee]|[Ww][Ii][Ll][Ll]|[Ww][Oo][Uu][Ll][Dd])\\b";

/**
 * Describe the exact model input accepted by one client producer and format.
 * The client selects the published Design System blocks; TimDS turns those
 * choices and the executable video contract into one prompt/schema boundary.
 */
export function createVideoAuthoringContract({ contract, manifest, designSystemIndex, provenance, outputFormat }) {
  const config = validateVideoProducerConfig(contract.producer, contract);
  if (!config) throw new Error(`${contract.name} has no video producer contract`);
  if (!["horizontal", "short"].includes(outputFormat)) throw new Error("video authoring outputFormat must be horizontal or short");
  const systemId = text(manifest?.systemId, "timds manifest systemId");
  const systemName = text(manifest?.name, "timds manifest name");
  const version = text(provenance?.version || manifest?.version, "video authoring Design System version");
  const commit = text(provenance?.commit, "video authoring Design System commit");
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("video authoring Design System commit must be a full Git SHA");
  const index = object(designSystemIndex, "published Design System index");
  const indexSystem = object(index.system, "published Design System index.system");
  if (indexSystem.id !== systemId) throw new Error(`published Design System ${String(indexSystem.id)} does not match ${systemId}`);
  if (indexSystem.version !== version) throw new Error(`published Design System ${String(indexSystem.version)} does not match pinned ${version}`);
  if (!Array.isArray(index.pages)) throw new Error("published Design System index.pages must be an array");

  const blockIds = [...new Set([
    ...config.authoring.sharedPromptBlocks,
    ...config.authoring.formatPromptBlocks[outputFormat],
  ])];
  const blocks = blockIds.map((blockId) => {
    const block = indexBlock(index, blockId);
    if (!block) throw new Error(`${contract.name} authoring block ${blockId} is missing from the published Design System`);
    return block;
  });
  const headlineWords = outputFormat === "short" ? contract.copy.shortHeadlineWords : contract.copy.horizontalHeadlineWords;
  const engagementRequired = config.engagement.enabled && config.engagement.formats.includes(outputFormat);
  const topicRequired = ["label", ...(engagementRequired ? ["engagementQuestion"] : [])];
  const topicProperties = {
    label: {
      type: "string",
      pattern: wordRangePattern(config.topicLabel.minimumWords, config.topicLabel.maximumWords),
      minLength: 1,
      description: `${config.topicLabel.minimumWords}–${config.topicLabel.maximumWords} plain words naming the subject`,
      "x-timds-minWords": config.topicLabel.minimumWords,
      "x-timds-maxWords": config.topicLabel.maximumWords,
    },
    coverEmotion: { type: "string", minLength: 1, description: "The viewer feeling this answer resolves" },
    ...(engagementRequired ? {
      engagementQuestion: {
        type: "string",
        minLength: 2,
        maxLength: contract.copy.coverHeadlineCharacters,
        allOf: [
          { pattern: maximumWordsPattern(headlineWords) },
          { pattern: "\\?$" },
          ...(config.engagement.requireYesNoQuestion ? [{ pattern: yesNoQuestionPattern }] : []),
        ],
        description: config.engagement.requireYesNoQuestion
          ? "A complete, article-grounded yes/no question the viewer can answer about their own situation"
          : "A complete, article-grounded question the viewer can answer about their own situation",
        "x-timds-maxWords": headlineWords,
        ...(config.engagement.requireYesNoQuestion ? { "x-timds-questionType": "yes-no" } : {}),
      },
    } : {}),
  };
  const inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "slug", "outputFormat", "exactQuestion", "topic", "answerBeats"],
    properties: {
      schemaVersion: { const: PRODUCER_SCHEMA_VERSION },
      slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
      outputFormat: { const: outputFormat },
      exactQuestion: {
        type: "string",
        minLength: 2,
        maxLength: contract.copy.coverHeadlineCharacters,
        allOf: [
          { pattern: maximumWordsPattern(contract.copy.coverHeadlineWords) },
          { pattern: "\\?$" },
        ],
        "x-timds-maxWords": contract.copy.coverHeadlineWords,
      },
      topic: { type: "object", additionalProperties: false, required: topicRequired, properties: topicProperties },
      answerBeats: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "role", "narration", "summary"],
          properties: {
            id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
            role: { type: "string", enum: beatRoles },
            narration: { type: "string", minLength: 1, description: "Natural spoken copy for this answer beat" },
            summary: {
              type: "string",
              minLength: 1,
              pattern: maximumWordsPattern(headlineWords),
              description: `A complete standalone micro-headline of at most ${headlineWords} words; never a truncated sentence fragment`,
              "x-timds-maxWords": headlineWords,
            },
          },
        },
      },
    },
  };
  return {
    schemaVersion: PRODUCER_AUTHORING_SCHEMA_VERSION,
    producerContractVersion: config.schemaVersion,
    designSystem: {
      id: systemId,
      name: systemName,
      version,
      commit,
      ...(provenance?.indexUrl ? { indexUrl: text(provenance.indexUrl, "video authoring index URL") } : {}),
    },
    outputFormat,
    prompt: {
      instructions: [
        "Build the final compile request so it validates against inputSchema; do not invent compiler-input fields.",
        "Write answerBeats as ordered spoken answer content and choose the closest supported semantic role for each beat.",
        `Write every summary as a complete standalone micro-headline of at most ${headlineWords} words. Never truncate a longer sentence to meet the limit.`,
        "Do not write role eyebrows, CTA template copy, intro/outro structure, cover subjects, footage, timing, safe zones, or layout; the compiler owns them.",
      ],
      blockIds,
      brief: blocks.map(renderPromptBlock).join("\n\n"),
    },
    constraints: {
      headlineWords,
      topicLabelWords: { minimum: config.topicLabel.minimumWords, maximum: config.topicLabel.maximumWords },
      exactQuestion: { maximumWords: contract.copy.coverHeadlineWords, maximumCharacters: contract.copy.coverHeadlineCharacters, mustEndWithQuestionMark: true },
      engagementQuestion: { required: engagementRequired, requireYesNoQuestion: engagementRequired && config.engagement.requireYesNoQuestion, maximumWords: headlineWords },
      answerBeatRoles: [...beatRoles],
      reservedSceneIds: [...new Set([config.intro.id, config.engagement.id, config.outro.id])],
    },
    compilerOwns: [
      "role eyebrows",
      "intro, engagement, and outro scene structure",
      "CTA template copy",
      "cover eyebrow and cover subject",
      "footage chains",
      "timing, safe zones, and layout",
    ],
    inputSchema,
  };
}

const validateQuestion = (fail, label, value, maximumWords, maximumCharacters) => {
  const normalized = text(value, label);
  if (!normalized.endsWith("?")) fail(`${label} must end with a question mark`);
  if (words(normalized).length > maximumWords) fail(`${label} exceeds ${maximumWords} words`);
  if (normalized.length > maximumCharacters) fail(`${label} exceeds ${maximumCharacters} characters`);
  return normalized;
};

export function createVideoProducer({ contract, assetCatalog, mediaCatalog }) {
  const config = validateVideoProducerConfig(contract.producer, contract);
  if (!config) throw new Error(`${contract.name} has no video producer contract`);
  const assets = object(assetCatalog.assets || assetCatalog, "video producer asset catalog");
  const mediaEntries = Array.isArray(mediaCatalog.assets) ? mediaCatalog.assets : [];
  const mediaByKey = new Map(mediaEntries.map((asset) => [asset.key, asset]));
  const fail = (message) => { throw new Error(`${contract.name} producer contract: ${message}`); };
  const reservedIds = new Set([config.intro.id, config.engagement.id, config.outro.id]);
  const yesNoQuestion = /^(?:are|can|could|did|do|does|has|have|is|should|was|were|will|would)\b/iu;

  const mediaFor = (key) => {
    const declared = assets[key] || fail(`asset ${key} is not declared`);
    const published = declared.mediaKey ? mediaByKey.get(declared.mediaKey) : null;
    if (!published?.publicUrl || !published.filename) fail(`asset ${key} is not published in the media catalog`);
    return { ...published, ...declared, key };
  };

  const compileProduction = (input) => {
    if (input.schemaVersion !== PRODUCER_SCHEMA_VERSION) fail(`unsupported compile schema version ${String(input.schemaVersion)}`);
    const productionSlug = slugSafe(input.slug, "producer slug");
    if (!["horizontal", "short"].includes(input.outputFormat)) fail("outputFormat must be horizontal or short");
    const exactQuestion = validateQuestion(fail, "exactQuestion", input.exactQuestion, contract.copy.coverHeadlineWords, contract.copy.coverHeadlineCharacters);
    const topicLabel = text(input.topic?.label, "producer topic.label");
    const topicWords = words(topicLabel);
    if (topicWords.length < config.topicLabel.minimumWords || topicWords.length > config.topicLabel.maximumWords) {
      fail(`topic.label must contain ${config.topicLabel.minimumWords} to ${config.topicLabel.maximumWords} words`);
    }
    if (!Array.isArray(input.answerBeats) || !input.answerBeats.length) fail("at least one approved answer beat is required");
    const ids = new Set();
    const headlineWords = input.outputFormat === "short" ? contract.copy.shortHeadlineWords : contract.copy.horizontalHeadlineWords;
    const content = input.answerBeats.map((beat) => {
      const id = slugSafe(beat.id, "producer answer beat id");
      if (ids.has(id) || reservedIds.has(id)) fail(`answer beat id ${id} must be unique and not reserved by the producer`);
      ids.add(id);
      if (!beatRoles.includes(beat.role)) fail(`answer beat ${id} has unsupported semantic role ${String(beat.role)}`);
      const summary = text(beat.summary, `producer answer beat ${id}.summary`);
      if (words(summary).length > headlineWords) fail(`answer beat ${id}.summary exceeds ${headlineWords} words`);
      return {
        id,
        role: beat.role,
        narration: text(beat.narration, `producer answer beat ${id}.narration`),
        eyebrow: config.roleEyebrows[beat.role],
        headline: summary,
      };
    });
    const values = { question: exactQuestion, topic: topicLabel.toLocaleLowerCase(), site: contract.brand.site, series: contract.brand.series };
    const engagementEnabled = config.engagement.enabled && config.engagement.formats.includes(input.outputFormat);
    const engagementQuestion = engagementEnabled
      ? validateQuestion(fail, "topic.engagementQuestion", input.topic?.engagementQuestion, headlineWords, contract.copy.coverHeadlineCharacters)
      : "";
    if (engagementEnabled && config.engagement.requireYesNoQuestion && !yesNoQuestion.test(engagementQuestion)) {
      fail("topic.engagementQuestion must be answerable yes or no");
    }
    const scenes = [];
    if (config.intro.enabled) scenes.push({ id: config.intro.id, role: "intro", narration: exactQuestion, headline: exactQuestion, intro: true });
    scenes.push(...content);
    if (engagementEnabled) scenes.push({
      id: config.engagement.id,
      role: "engage",
      narration: renderTemplate(config.engagement.narrationTemplate, { ...values, question: engagementQuestion }),
      eyebrow: config.engagement.eyebrow,
      headline: engagementQuestion,
    });
    if (config.outro.enabled) scenes.push({ id: config.outro.id, role: "outro", narration: renderTemplate(config.outro.narrationTemplate, values), outro: true });
    return {
      schemaVersion: PRODUCER_SCHEMA_VERSION,
      producerContractVersion: config.schemaVersion,
      slug: productionSlug,
      outputFormat: input.outputFormat,
      exactQuestion,
      topic: { ...input.topic, label: values.topic },
      scenes,
      cover: { eyebrow: config.cover.eyebrow, headline: exactQuestion },
    };
  };

  const compatibleTextSides = (keys) => ["left", "right"].filter((side) => keys.every((key) => {
    const asset = assets[key];
    return !["left", "right"].includes(asset.subject) || asset.subject !== side || asset.flip === true;
  }));

  const horizontalFootage = () => Object.keys(assets)
    .filter((key) => key.startsWith(config.footage.assetPrefix) && Number.isFinite(assets[key].durationSeconds) && assets[key].durationSeconds > 0)
    .filter((key) => !Object.values(assets).some((asset) => asset.vertical === key))
    .map((key) => {
      const master = mediaFor(key);
      const verticalKey = assets[key].vertical;
      const vertical = verticalKey ? mediaFor(verticalKey) : null;
      return { master, vertical, durationSeconds: master.durationSeconds };
    })
    .sort((left, right) => left.master.key.localeCompare(right.master.key));

  // Offset, mirrored, and vertical derivatives are the same footage; chaining
  // one directly into its sibling — within a scene or across a scene cut —
  // plays as a repeated clip.
  const footageFamily = (key) => String(key)
    .replace(/-vertical$/u, "")
    .replace(/-mirrored$/u, "")
    .replace(/-offset$/u, "");

  const selectFootage = (scene, seconds, format, previousFamily = "") => {
    const query = tokens(`${scene.role} ${scene.narration} ${scene.headline || ""}`);
    const ranked = horizontalFootage()
      .filter((pair) => format !== "short" || (pair.vertical && Number.isFinite(pair.vertical.durationSeconds)))
      .map((pair) => ({ ...pair, effectiveDurationSeconds: format === "short" ? pair.vertical.durationSeconds : pair.master.durationSeconds }))
      .sort((left, right) => score(query, right.master.key) - score(query, left.master.key) || right.effectiveDurationSeconds - left.effectiveDurationSeconds || left.master.key.localeCompare(right.master.key));
    const selected = [];
    const used = new Set();
    let duration = 0;
    let lastFamily = previousFamily;
    while (duration + Number.EPSILON < seconds) {
      const candidate = ranked.find((pair) => !used.has(pair.master.key)
        && footageFamily(pair.master.key) !== lastFamily
        && (format !== "horizontal" || compatibleTextSides([...selected.map((entry) => entry.master.key), pair.master.key]).length > 0));
      if (!candidate) {
        fail(`scene ${scene.id} needs ${seconds.toFixed(2)} seconds, but registered footage covers only ${duration.toFixed(2)} seconds at natural 1x speed without repeating a footage family back to back`);
      }
      used.add(candidate.master.key);
      selected.push(candidate);
      duration += candidate.effectiveDurationSeconds;
      lastFamily = footageFamily(candidate.master.key);
    }
    return selected;
  };

  const chooseCover = (compiled) => {
    const query = tokens(`${compiled.topic.coverEmotion || config.cover.defaultEmotion} ${compiled.topic.label} ${compiled.exactQuestion}`);
    const candidates = Object.keys(assets)
      .filter((key) => key.startsWith(config.cover.assetPrefix))
      .map((key) => mediaFor(key))
      .filter((asset) => String(asset.contentType || "").startsWith("image/"))
      .sort((left, right) => score(query, right.key) - score(query, left.key) || left.key.localeCompare(right.key));
    return candidates[0] || fail(`the ${config.cover.assetPrefix} cover library is empty`);
  };

  const finalizeProduction = (input) => {
    if (input.schemaVersion !== PRODUCER_SCHEMA_VERSION) fail(`unsupported finalize schema version ${String(input.schemaVersion)}`);
    if (input.compiled.producerContractVersion !== config.schemaVersion) fail(`compiled production uses producer contract ${String(input.compiled.producerContractVersion)}; expected ${config.schemaVersion}`);
    if (!Array.isArray(input.timings) || input.timings.length !== input.compiled.scenes.length) fail("timings must match every compiled scene");
    const timingById = new Map(input.timings.map((line) => [line.id, line]));
    const selectedByScene = new Map();
    // Intro and outro cards break the footage sequence; between them the last
    // clip of one scene must not share a family with the next scene's first.
    let previousFamily = "";
    for (const scene of input.compiled.scenes) {
      const timing = timingById.get(scene.id) || fail(`scene ${scene.id} has no measured timing`);
      if (!Number.isFinite(timing.durationMs) || timing.durationMs <= 0) fail(`scene ${scene.id} needs a positive measured duration`);
      if (scene.intro || scene.outro) {
        previousFamily = "";
        continue;
      }
      const selected = selectFootage(scene, timing.durationMs / 1000, input.compiled.outputFormat, previousFamily);
      selectedByScene.set(scene.id, selected);
      previousFamily = footageFamily(selected[selected.length - 1].master.key);
    }
    const coverSubject = chooseCover(input.compiled);
    const coverExtension = String(coverSubject.filename).match(/\.[a-z0-9]+$/iu)?.[0] || ".png";
    const scenes = input.compiled.scenes.map((scene) => {
      if (scene.intro) return { id: scene.id, intro: true, headline: scene.headline };
      if (scene.outro) return { id: scene.id, outro: true };
      const selected = selectedByScene.get(scene.id);
      const masters = selected.map((pair) => pair.master.key);
      const verticals = selected.map((pair) => pair.vertical?.key).filter(Boolean);
      return {
        id: scene.id,
        eyebrow: scene.eyebrow,
        headline: scene.headline,
        ...(masters.length === 1 ? { asset: masters[0], ...(verticals[0] ? { verticalAsset: verticals[0] } : {}) } : { assets: masters, ...(verticals.length ? { verticalAssets: verticals } : {}) }),
      };
    });
    const selectedMedia = new Map();
    for (const pairs of selectedByScene.values()) for (const pair of pairs) {
      selectedMedia.set(pair.master.key, pair.master);
      if (pair.vertical) selectedMedia.set(pair.vertical.key, pair.vertical);
    }
    return {
      schemaVersion: PRODUCER_SCHEMA_VERSION,
      producerContractVersion: config.schemaVersion,
      plan: {
        schemaVersion: PRODUCER_SCHEMA_VERSION,
        slug: input.compiled.slug,
        outputFormat: input.compiled.outputFormat,
        lines: input.compiled.scenes.map((scene) => timingById.get(scene.id)),
        scenes,
        pads: Object.fromEntries(input.compiled.scenes.map((scene) => [scene.id, { lead: 0, tail: 0 }])),
        audioSrc: input.audioSrc,
        cover: { ...input.compiled.cover, image: input.coverImage || `cover${coverExtension.toLocaleLowerCase()}` },
      },
      coverSubject,
      footage: [...selectedMedia.values()].sort((left, right) => left.key.localeCompare(right.key)),
    };
  };

  return { PRODUCER_CONTRACT_VERSION: config.schemaVersion, compileProduction, finalizeProduction };
}

export { PRODUCER_SCHEMA_VERSION as VIDEO_PRODUCER_CONTRACT_VERSION };
