// The Design System's tokens as CSS custom properties, compiled from the
// pinned design-system/tokens.json by the rule the system's own build uses
// (`--group-name` on `:root`). The site reads the pin and keeps no copy, so a
// pin update is what changes these values. If the Design System moves off its
// starter build, import the stylesheet that declares its tokens from
// src/styles/theme.css instead and delete this module.
import tokens from "../../design-system/tokens.json";

type TokenGroups = Record<string, Record<string, { value: string }>>;

const cssName = (group: string, name: string) =>
	`--${group}-${name}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();

const declarations = Object.entries(tokens as TokenGroups)
	.flatMap(([group, entries]) =>
		Object.entries(entries).map(([name, token]) => `${cssName(group, name)}:${token.value}`),
	)
	.sort();

// `<` never appears in a token value; escaping it keeps the block inert markup.
export const designSystemTokenCss = `:root{${declarations.join(";")}}`.replaceAll("<", "\\3C ");
