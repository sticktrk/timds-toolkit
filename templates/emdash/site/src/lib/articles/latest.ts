import { getEmDashCollection, type CacheHint, type ContentEntry } from "emdash";
import { sections, type ArticleData, type Section } from "./index";
import { sectionAvailable } from "./availability";
import { mergeSectionEntries } from "./mixed.mjs";

/** A latest list for home pages, or a topic's entries across every section. */
export async function getLatestArticles(options: { cursor?: string; topic?: string; limit?: number } = {}): Promise<{ entries: Array<{ entry: ContentEntry<ArticleData>; section: Section }>; nextCursor?: string; cacheHints: CacheHint[] }> {
  if (!(await Promise.all(sections.map(sectionAvailable))).every(Boolean)) throw new Error("An article section is unavailable.");
  return mergeSectionEntries(sections, (collection: string, filter: object) => getEmDashCollection<string, ArticleData>(collection, filter), options);
}
