import { colorLiterals, renderSite } from "./viewer.mjs";

const site = await renderSite();

const literals = await colorLiterals();
if (literals.length) {
  throw new Error(`Color literals belong in tokens.json; add a token and use its custom property instead (${literals.join(", ")})`);
}

console.log(`Validated ${site.tokenGroups} token groups and ${site.pages} authored pages`);
if (site.planned.length) console.log(`Planned pages not yet authored: ${site.planned.join(", ")}`);
