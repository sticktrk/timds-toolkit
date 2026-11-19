// Exercise the public package export under browser resolution without Node polyfills.
import { build } from "esbuild";
import { isBuiltin } from "node:module";

await build({
  stdin: { contents: 'export * from "@dtconcepts/timds/read-tools";', resolveDir: process.cwd() },
  bundle: true, platform: "browser", format: "esm", write: false,
  plugins: [{
    name: "runtime-neutral",
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => {
        if (isBuiltin(path) || path.startsWith("@modelcontextprotocol/")) {
          return { errors: [{ text: `Read tools cannot import ${path}` }] };
        }
      });
    },
  }],
});
console.log("Worker read-tools bundle passed.");
