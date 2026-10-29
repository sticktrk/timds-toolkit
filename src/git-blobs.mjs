// Read immutable Git object bytes in one process, without checkout filters.
import { execFileSync } from 'node:child_process';

/** The caller inventories sizes first; this reader also bounds and checks the
 * batch response before returning exact bytes for the requested object IDs. */
export function readBlobs(root, shas, {maxBytes = 200_000_000, maxBlobBytes = maxBytes} = {}) {
  const blobs = new Map(), wanted = [...new Set(shas)];
  if (!wanted.length) return blobs;
  if (wanted.some(sha => !/^[0-9a-f]{40}$/.test(sha))) throw new Error('Source contract blobs require exact object IDs');
  const out = execFileSync('git', ['cat-file', '--batch'], {cwd: root, input: `${wanted.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: maxBytes + wanted.length * 100, timeout: 30_000});
  let offset = 0, total = 0;
  for (const sha of wanted) {
    const end = out.indexOf(10, offset);
    const header = end === -1 ? null : /^([0-9a-f]{40}) blob (\d+)$/.exec(out.subarray(offset, end).toString('utf8'));
    const size = header ? Number(header[2]) : NaN;
    total += size;
    if (!header || header[1] !== sha || !Number.isSafeInteger(size) || size > maxBlobBytes || total > maxBytes || end + size + 1 >= out.length || out[end + size + 1] !== 10) throw new Error('Source contract blobs could not be read from the source commit');
    blobs.set(sha, out.subarray(end + 1, end + size + 1));
    offset = end + size + 2;
  }
  if (offset !== out.length) throw new Error('Source contract blobs could not be read from the source commit');
  return blobs;
}
