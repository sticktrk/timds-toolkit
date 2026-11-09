// Where an agent sent to a page of the site finds the agent-readable layer.
//
// People paste llms.txt into their tools, but as often they send an agent to
// the site itself. A reader of the raw HTML sees the head: a comment that
// names the entry point and a link to it. A reader of the extracted text, which
// drops the head, sees one visible line at the end of the body. The starter
// viewer writes the same two on every page it renders (src/viewer.mjs,
// with the page's own Markdown mirror); the pages the
// toolkit renders itself, the changelog and the designs directory, take theirs
// from here. `robotsText` is the robots.txt extract writes at the site root
// for a crawler that reads it first.
import { escapeHtml } from "./html.mjs";

/** Head lines, indented for the toolkit's rendered shells. */
export function agentPointerHead(basePrefix) {
  return [
    `    <!-- AI agents: this design system's entry point is ${basePrefix}/llms.txt (how to use it, the brand essentials, then every page with a link to its Markdown). Every page in one file: ${basePrefix}/llms-full.txt. -->`,
    `    <link rel="llms-txt" type="text/plain" href="${escapeHtml(basePrefix)}/llms.txt">`,
  ];
}

/** The visible line, placed last in the body under the shell's own class. */
export function agentPointerNote(basePrefix, className) {
  const href = `${escapeHtml(basePrefix)}/llms.txt`;
  return `<p class="${className}">AI agents: start at <a href="${href}">${href}</a>.</p>`;
}

/** robots.txt for the site root: nothing is closed, and the entry point is named for whoever reads this file first. */
export function robotsText() {
  return [
    "# AI agents and tools: this design system's entry point is /llms.txt",
    "# (how to use it, the brand essentials, then every page with a link to",
    "# its Markdown). Every page in one file: /llms-full.txt. The machine index:",
    "# /index.json.",
    "",
    "User-agent: *",
    "Allow: /",
    "",
  ].join("\n");
}
