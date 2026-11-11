/**
 * EmDash live content collection. Every EmDash collection, `articles`
 * included, is read through this one `_emdash` entry with
 * getEmDashCollection() and getEmDashEntry().
 */
import { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime";

export const collections = {
	_emdash: defineLiveCollection({ loader: emdashLoader() }),
};
