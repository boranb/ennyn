#!/usr/bin/env node
/**
 * The CLI's place before the plugin moved into plugin/: runs plugin/scripts/ennyn.mjs with the same arguments.
 * Kept for what names this path: a commit-msg hook `ennyn install-hook` wrote from a clone or the npm package
 * (`cli='<root>/scripts/ennyn.mjs'`), which lets every commit through unchecked once the file is gone, and the
 * repository's own `node scripts/ennyn.mjs`. The plugin never loads this file; the npm package ships it for the
 * hooks its earlier versions wrote.
 */
import { fileURLToPath } from "node:url";

const cli = new URL("../plugin/scripts/ennyn.mjs", import.meta.url);
// The CLI runs its command only when it is the file node started (process.argv[1], compared as a real path).
process.argv[1] = fileURLToPath(cli);
await import(cli.href);
