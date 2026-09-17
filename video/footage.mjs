// Footage-chain and headline-copy rules every TimDS production obeys.
//
// These are production rules, not styling, so they live in the engine rather
// than in a client's component snapshot: the default Media component applies
// them while rendering, the producer applies them while selecting footage, and
// `timds video check` enforces them over every committed production. A client
// snapshot imports this module from `@dtconcepts/timds/video/footage` so a
// toolkit fix reaches the client's frames without regenerating the snapshot.

/**
 * Key suffixes that mark a derivative of the same source footage. Offset,
 * mirrored, and vertical cuts of one master are the same picture; playing one
 * immediately after its sibling reads as a repeated clip.
 */
export const FOOTAGE_DERIVATIVE_SUFFIXES = ["-vertical", "-mirrored", "-offset"];

export const footageFamily = (key) => {
  let family = String(key);
  for (const suffix of FOOTAGE_DERIVATIVE_SUFFIXES) {
    if (family.endsWith(suffix)) family = family.slice(0, -suffix.length);
  }
  return family;
};

/** The shortest cut that still reads as an intentional edit rather than a blip. */
export const MINIMUM_CHAIN_CLIP_SECONDS = 2;

/** The fixed headline zone used by the default scene, including legacy placements. */
export const verticalTextZone = (text) => text === "lower" || text?.endsWith("bottom") ? "lower" : "upper";

/**
 * Screen time per chain clip. Clips play in order at natural speed and the
 * scene boundary cuts the last one, so a chain whose total barely exceeds the
 * scene would leave a sub-second final cut. Rebalance by cutting the previous
 * clip early — cutting mid-clip is expected — so the last visible clip holds
 * at least the minimum, never freezing a clip past its natural length and
 * never shrinking the previous clip below that same minimum.
 */
export const chainClipFrames = (availableFrames, duration, minimumFrames) => {
  const allotted = [];
  let cursor = 0;
  for (const available of availableFrames) {
    const clipFrames = Math.min(available, Math.max(0, duration - cursor));
    allotted.push(clipFrames);
    cursor += clipFrames;
  }
  for (let index = allotted.length - 1; index > 0; index -= 1) {
    if (!allotted[index]) continue;
    const deficit = Math.min(
      Math.max(0, minimumFrames - allotted[index]),
      availableFrames[index] - allotted[index],
      Math.max(0, allotted[index - 1] - minimumFrames),
    );
    if (deficit > 0) {
      allotted[index - 1] -= deficit;
      allotted[index] += deficit;
    }
    break;
  }
  return allotted;
};

/** A scene's ordered footage chain: the `assets` array, or the single `asset`. */
export const sceneAssetKeys = (scene) => scene.assets || (scene.asset ? [scene.asset] : []);

/**
 * Every place one footage family plays twice in a row across an ordered list
 * of scenes — inside a scene's chain or across a scene boundary. Intro and
 * outro cards carry no footage and break the sequence.
 */
export function adjacentFootageRepeats(scenes) {
  const repeats = [];
  let previous;
  for (const scene of scenes) {
    if (scene.intro || scene.outro) {
      previous = undefined;
      continue;
    }
    for (const key of sceneAssetKeys(scene)) {
      const current = { scene: scene.id, key, family: footageFamily(key) };
      if (previous && previous.family === current.family) repeats.push({ previous, current });
      previous = current;
    }
  }
  return repeats;
}

/**
 * A headline must be a complete thought within its word limit. A compiler may
 * compact a longer summary to that limit, so the copy cannot rely on words
 * beyond it; these endings — a possessive, article, conjunction, or dependent
 * preposition — are what mechanical truncation leaves behind.
 */
export const DANGLING_HEADLINE_ENDING = /(?:\b(?:a|an|and|at|but|by|for|from|of|or|the|to|with|your|their|its)|[’']s)[.!?]*$/iu;

export const truncatedHeadline = (headline) => {
  const value = String(headline ?? "").trim();
  return Boolean(value) && DANGLING_HEADLINE_ENDING.test(value);
};
