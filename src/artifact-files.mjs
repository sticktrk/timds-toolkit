// The built artifact walk shared by workspace validation and release
// publication: every regular file under design-system/dist with its bytes,
// limits, and SHA-256, in a stable per-directory order. Symbolic links are
// refused so the artifact a ref push or a portal hash sees is exactly what
// was walked here. Nothing here reads Git or the network.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const MAX_ARTIFACT_FILE_BYTES = 12_000_000;
export const MAX_ARTIFACT_FILES = 2_000;
export const MAX_ARTIFACT_TOTAL_BYTES = 80_000_000;
export const MAX_DIRECTORY_DEPTH = 20;
export const MAX_SCANNED_ENTRIES = 5_000;

export async function collectArtifactFiles(root) {
  const files = [];
  let scannedEntries = 0;
  let totalBytes = 0;
  const walk = async (directory, depth) => {
    if (depth > MAX_DIRECTORY_DEPTH) throw new Error("design-system/dist exceeds the directory depth limit");
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAX_SCANNED_ENTRIES) throw new Error("design-system/dist contains too many entries");
      const absolutePath = path.join(directory, entry.name);
      const info = await fs.lstat(absolutePath);
      if (info.isSymbolicLink()) throw new Error("design-system/dist cannot contain symbolic links");
      if (info.isDirectory()) {
        await walk(absolutePath, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      if (info.size > MAX_ARTIFACT_FILE_BYTES) {
        throw new Error(`${path.relative(root, absolutePath)} exceeds the ${MAX_ARTIFACT_FILE_BYTES}-byte artifact file limit`);
      }
      totalBytes += info.size;
      if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
        throw new Error(`design-system/dist exceeds the ${MAX_ARTIFACT_TOTAL_BYTES}-byte total limit`);
      }
      if (files.length >= MAX_ARTIFACT_FILES) {
        throw new Error(`design-system/dist contains more than ${MAX_ARTIFACT_FILES} files`);
      }
      const content = await fs.readFile(absolutePath);
      files.push({
        absolutePath,
        bytes: info.size,
        content,
        path: path.relative(root, absolutePath).split(path.sep).join("/"),
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  };
  await walk(root, 0);
  return { files, totalBytes };
}
