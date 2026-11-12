// Nonworkspace consumers read the declared sections directly.
import declaration from "../../../sections.json";
import { normalizeSections } from "./sections.mjs";

export const sections = normalizeSections(declaration);
