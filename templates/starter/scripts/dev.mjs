// Builds this Design System once and serves dist/ on 127.0.0.1 (PORT, else
// 4321) with the TimDS renderer from the toolkit package
// (@dtconcepts/timds/viewer). This file is stock and every upgrade keeps it
// current.
import { fileURLToPath } from "node:url";

const viewer = await import("@dtconcepts/timds/viewer").catch(async (error) => {
  if (!["ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"].includes(error?.code) || !process.env.TIMDS_VIEWER_MODULE) throw error;
  return import(process.env.TIMDS_VIEWER_MODULE);
});
await viewer.dev(fileURLToPath(new URL("..", import.meta.url)));
