import { fileURLToPath } from "node:url";
import { build } from "./viewer.mjs";

await build();

// Website designs under src/designs/ are rendered by TimDS, so `dev` shows
// them beside the viewer. `timds check` renders them the same way, so a fresh
// scaffold before `npm install`, where the toolkit is not resolvable yet,
// still gets them on its first check.
const designs = await import("@dtconcepts/timds/designs").catch((error) => {
  if (error?.code === "ERR_MODULE_NOT_FOUND") return null;
  throw error;
});
if (designs) {
  const { pageCount, stateCount } = await designs.buildDesigns(fileURLToPath(new URL("..", import.meta.url)));
  if (pageCount) console.log(`Built ${pageCount} design page${pageCount === 1 ? "" : "s"} (${stateCount} state${stateCount === 1 ? "" : "s"}) under dist/designs/`);
}
