import { colorLiterals, renderSite } from "./viewer.mjs";

const site = await renderSite();

const literals = await colorLiterals();
if (literals.length) {
  throw new Error(`Color literals belong in tokens.json; add a token and use its custom property instead (${literals.join(", ")})`);
}

console.log(`Validated ${site.tokenGroups} token groups, ${site.formatCount} formats, and ${site.pages} authored pages`);
if (site.fallbacks.length) console.log(`Stock samples used for unfilled slots: ${site.fallbacks.join(", ")}`);
for (const warning of site.warnings) console.warn(`Warning: ${warning}`);
if (site.planned.length) console.log(`Planned pages not yet authored: ${site.planned.join(", ")}`);
