// A site that already had src/live.config.ts keeps it and adds the `_emdash`
// entry to its exported collections. The scaffold does not overwrite the file.
import { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime"; // NEW

export const collections = {
	// ...the site's existing live collections stay here.
	_emdash: defineLiveCollection({ loader: emdashLoader() }), // NEW
};
