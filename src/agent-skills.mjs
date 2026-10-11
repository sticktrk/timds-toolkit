// The one place both repository kinds (a Design System and a product that
// consumes one) make their managed agent skills visible to every agent.
// Codex and other agents read `.agents/skills/`; Claude Code reads
// `.claude/skills/`. A relative link from the second to the first keeps a
// single copy of each skill and gives its slash command to both.
import { promises as fs } from "node:fs";
import path from "node:path";

export const CLAUDE_SKILLS_LINK = ".claude/skills";
const CLAUDE_SKILLS_TARGET = path.join("..", ".agents", "skills");

/**
 * Create `.claude/skills -> ../.agents/skills` under `repoRoot` when nothing
 * is there yet. An existing file, directory, or link of any kind is left
 * alone: a repository may keep its own Claude skills there. Returns the link
 * path when one was created, else null.
 */
export async function linkClaudeSkills(repoRoot, created = null) {
  const linkPath = path.join(repoRoot, ...CLAUDE_SKILLS_LINK.split("/"));
  try {
    await fs.lstat(linkPath);
    return null;
  } catch (caught) {
    if (caught?.code !== "ENOENT") throw caught;
  }
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(CLAUDE_SKILLS_TARGET, linkPath, "dir");
  created?.push(linkPath);
  return linkPath;
}
