import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src");
const destination = path.join(root, "dist");

function cssName(group, name) {
  return `--${group}-${name}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function compileTokens(tokens) {
  const declarations = [];
  let count = 0;

  for (const group of Object.keys(tokens).sort()) {
    for (const name of Object.keys(tokens[group]).sort()) {
      const token = tokens[group][name];
      if (!token || typeof token.value !== "string" || !token.value.trim()) {
        throw new Error(`Token ${group}.${name} must have a non-empty string value`);
      }
      declarations.push(`  ${cssName(group, name)}: ${token.value};`);
      count += 1;
    }
  }

  return { count, css: `:root {\n${declarations.join("\n")}\n}\n` };
}

export async function build() {
  const manifest = JSON.parse(await readFile(path.join(root, "timds.json"), "utf8"));
  const tokens = JSON.parse(await readFile(path.join(root, "tokens.json"), "utf8"));
  const compiled = compileTokens(tokens);
  const indexTemplate = await readFile(path.join(source, "index.html"), "utf8");
  const index = indexTemplate
    .replaceAll("__TIMDS_NAME__", escapeHtml(manifest.name || "Design System"))
    .replaceAll("__TIMDS_DESCRIPTION__", escapeHtml(manifest.description || "Repository-owned visual and interface standards."))
    .replaceAll("__TIMDS_VERSION__", escapeHtml(manifest.version || "0.1.0"))
    .replaceAll("__TIMDS_TOKEN_COUNT__", String(compiled.count));

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
  await writeFile(path.join(destination, "index.html"), index, "utf8");
  await writeFile(path.join(destination, "tokens.css"), compiled.css, "utf8");
  await writeFile(path.join(destination, "tokens.json"), `${JSON.stringify(tokens, null, 2)}\n`, "utf8");

  console.log(`Built starter viewer with ${compiled.count} tokens`);
}

await build();
