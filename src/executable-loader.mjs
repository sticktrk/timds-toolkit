import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const packageRequire = createRequire(new URL('../package.json', import.meta.url));
export async function resolve(specifier, context, nextResolve) {
  // Stock viewer imports always use the exact packaged release. Product tools
  // retain their own dependencies; the fallback supplies bundled TSX visuals.
  if (specifier === '@dtconcepts/timds' || specifier.startsWith('@dtconcepts/timds/')) {
    return { url: pathToFileURL(packageRequire.resolve(specifier)).href, shortCircuit: true };
  }
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !/^(?:@[^/]+\/)?[^.:/][^:]*$/.test(specifier)) throw error;
    try { return await nextResolve(specifier, { ...context, parentURL: new URL('../package.json', import.meta.url).href }); }
    catch { throw error; }
  }
}
