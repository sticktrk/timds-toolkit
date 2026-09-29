// Board rules every TimDS production obeys, shared the way footage.mjs is:
// the default board components apply them while rendering, the producer
// applies them at compile and finalize, and `timds video check` enforces them
// over every committed production. A client snapshot imports this module from
// `@dtconcepts/timds/video/boards` so a toolkit fix reaches the client's frames
// without regenerating the snapshot.
//
// Nothing here knows a client's vocabulary: which board kinds exist, their
// fields, budgets, and motifs live in that Design System's video/boards.json.

/**
 * The board kinds the TimDS default components draw and the default catalog
 * declares, in shelf order. A client catalog may declare fewer or more; its
 * components then register what it declares.
 */
export const DEFAULT_BOARD_KINDS = Object.freeze(["chapter-title", "statement", "cards", "compare", "flow", "steps", "document", "subscribe"]);

/**
 * A caption word and a cue reduced to the same comparable form: lowercase,
 * letters and digits only, so "Deed," and "deed" are one word and a cue can be
 * matched against the measured take.
 */
export const normalizeCueWord = (value) => String(value ?? "")
  .toLocaleLowerCase()
  .normalize("NFKD")
  .replace(/[^\p{L}\p{N}]+/gu, "");

/** "two-jobs" → "Two Jobs": the label for a chapter no board named. */
export const titleCaseChapterId = (id) => String(id ?? "")
  .split("-")
  .filter(Boolean)
  .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
  .join(" ");

/**
 * Chapters in scene order. A `chapter-title` board's title labels its chapter;
 * a chapter with no such board is labelled from its id. The first board wins
 * when a chapter carries more than one.
 */
export const deriveVideoChapters = (scenes) => {
  const chapters = [];
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    if (!scene || typeof scene.chapter !== "string" || !scene.chapter) continue;
    const visual = scene.visual && typeof scene.visual === "object" ? scene.visual : null;
    const title = visual?.kind === "chapter-title" && typeof visual.title === "string" && visual.title.trim()
      ? visual.title.trim()
      : undefined;
    const existing = chapters.find((chapter) => chapter.id === scene.chapter);
    if (existing) {
      if (title && !existing.titled) {
        existing.label = title;
        existing.titled = true;
      }
      continue;
    }
    chapters.push({ id: scene.chapter, label: title ?? titleCaseChapterId(scene.chapter), titled: Boolean(title) });
  }
  return chapters.map(({ id, label }) => ({ id, label }));
};

/**
 * The frame at which a cued reveal lands: when the take speaks the cue word
 * (the first caption word that normalizes to it), otherwise the item's share
 * of an even spread across the scene. `index`/`count` describe the item's
 * place among its board's reveals; `lead` is the scene's leading pad in
 * frames.
 */
export const revealFrame = ({ cue, words, index, count, duration, lead = 0, fps }) => {
  const wanted = normalizeCueWord(cue);
  if (wanted) {
    const word = (Array.isArray(words) ? words : []).find((candidate) => normalizeCueWord(candidate?.text) === wanted);
    if (word && Number.isFinite(word.startMs)) return lead + Math.max(0, Math.round(word.startMs / 1000 * fps));
  }
  const usable = Math.max(1, duration - lead);
  const slots = Math.max(1, count);
  return lead + Math.round(usable * (index + 0.5) / (slots + 0.5));
};
