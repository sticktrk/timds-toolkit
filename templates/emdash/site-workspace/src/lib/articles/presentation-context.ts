import { collectionContexts } from "virtual:timds/design-system";

export const divisionForArticle = (collection: string): string | null =>
	Object.hasOwn(collectionContexts, collection) ? collectionContexts[collection] ?? null : null;
