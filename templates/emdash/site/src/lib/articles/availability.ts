import { getCollectionInfo } from "emdash";
import type { Section } from "./index";

/** Empty and absent collections are different: a missing schema is a deployment failure. */
export async function sectionAvailable(section: Section): Promise<boolean> {
  const collection = await getCollectionInfo(section.collection);
  return Boolean(collection && collection.urlPattern === section.urlPattern);
}

export function sectionUnavailable(): Response {
  return new Response("This section is temporarily unavailable.", { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
}
