// Entry hook for the native executable. The launcher (scripts/binary-launcher.cjs)
// and `javascriptCommand` in executable.mjs start Node with
// `--import src/executable-register.mjs`, which registers executable-loader.mjs
// as the module-resolution hook before bin/timds.mjs loads, so stock viewer
// imports of @dtconcepts/timds and bare specifiers resolve against the
// materialized package in the per-user cache rather than a client's
// node_modules. Nothing else belongs here.
import { register } from 'node:module';
register('./executable-loader.mjs', import.meta.url);
