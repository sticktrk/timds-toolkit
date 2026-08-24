export const tieOrphan = (value) => value.replace(/\s+(\S+)\s*$/u, "\u00a0$1");

export function splitGoldHeadline(value, requestedPhrase) {
  const headline = tieOrphan(value);
  const phrase = requestedPhrase || headline.split(/\s+/u).at(-1) || "";
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
