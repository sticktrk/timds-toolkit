// Builds this Design System with the TimDS renderer from the toolkit package
// (@dtconcepts/timds/viewer): the viewer, the website designs, the changelog,
// then the commands timds.json lists in workspace.after.build. Add a build
// step there rather than here; this file is stock and every upgrade keeps it
// current. Before the first install, timds check supplies the toolkit itself.
import { fileURLToPath } from "node:url";

const viewer = await import("@dtconcepts/timds/viewer").catch(async (error) => {
  if (!["ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"].includes(error?.code) || !process.env.TIMDS_VIEWER_MODULE) throw error;
  return import(process.env.TIMDS_VIEWER_MODULE);
});
await viewer.build(fileURLToPath(new URL("..", import.meta.url)));
