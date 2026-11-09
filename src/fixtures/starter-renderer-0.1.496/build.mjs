import { fileURLToPath } from "node:url";
import { build } from "./viewer.mjs";

await build();

// Website designs under src/designs/ and the changelog page are rendered by
// TimDS, so `dev` shows them beside the viewer. `timds check` renders them the
// same way, so a fresh scaffold before `npm install`, where the toolkit is not
// resolvable yet, still gets them on its first check.
const root = fileURLToPath(new URL("..", import.meta.url));
const optional = (specifier) => import(specifier).catch((error) => {
  if (error?.code === "ERR_MODULE_NOT_FOUND") return null;
  throw error;
});
const designs = await optional("@dtconcepts/timds/designs");
if (designs) {
  const { pageCount, stateCount } = await designs.buildDesigns(root);
  if (pageCount) console.log(`Built ${pageCount} design page${pageCount === 1 ? "" : "s"} (${stateCount} state${stateCount === 1 ? "" : "s"}) under dist/designs/`);
}
const changelog = await optional("@dtconcepts/timds/changelog");
if (changelog) {
  const { releaseCount } = await changelog.buildChangelog(root);
  if (releaseCount) console.log(`Built the changelog with ${releaseCount} release${releaseCount === 1 ? "" : "s"} under dist/changelog/`);
}
