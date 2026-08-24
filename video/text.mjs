// A normal space keeps the font's intended advance width. The following word
// joiner prevents a line break without relying on the font's NBSP glyph, which
// can have a zero advance in subsetted webfonts.
export const tieOrphan = (value) => value.replace(/\s+(\S+)\s*$/u, " \u2060$1");

export function splitGoldHeadline(value, requestedPhrase) {
  const headline = tieOrphan(value);
  const phrase = requestedPhrase || String(value).trim().split(/\s+/u).at(-1) || "";
  const index = phrase
    ? headline.toLocaleLowerCase().lastIndexOf(phrase.toLocaleLowerCase())
    : -1;
  if (index < 0) return {before: headline, highlighted: "", after: ""};
  return {
    before: headline.slice(0, index),
    highlighted: headline.slice(index, index + phrase.length),
    after: headline.slice(index + phrase.length),
  };
}

const coverWords = (value) => String(value).trim().split(/\s+/u).filter(Boolean);

export function fitCoverHeadline(value, options = {}) {
  const width = Number(options.width || 896);
  const height = Number(options.height || 353);
  const maximum = Number(options.maximum || 120);
  const step = Number(options.step || 4);
  const lineHeight = Number(options.lineHeight || 1.01);
  const emPerCharacter = Number(options.emPerCharacter || 0.44);
  const words = coverWords(value);
  const longestWord = words.reduce((longest, word) => Math.max(longest, word.length), 0);
  for (let size = maximum; size > step; size -= step) {
    const charactersPerLine = width / (size * emPerCharacter);
    if (longestWord > charactersPerLine) continue;
    let rows = 1;
    let used = 0;
    for (const word of words) {
      if (used && used + 1 + word.length > charactersPerLine) {
        rows += 1;
        used = word.length;
      } else {
        used = used ? used + 1 + word.length : word.length;
      }
    }
    if (rows * size * lineHeight <= height) return size;
  }
  return step;
}
