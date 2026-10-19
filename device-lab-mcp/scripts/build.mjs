import { build } from "esbuild-wasm";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--outfile" || !args[1])) {
    throw new Error("Usage: node device-lab-mcp/scripts/build.mjs [--outfile <path relative to cwd>]");
}

// Every shipped server has its standalone production diagnostic beside it.
const serverOutfile = args.length ? resolve(args[1]) : join(packageRoot, "dist", "server.mjs");
const diagnosticOutfile = join(dirname(serverOutfile), "diagnostic.mjs");
if (basename(serverOutfile).toLowerCase() === "diagnostic.mjs") {
    throw new Error(`MCP server output cannot use the reserved diagnostic.mjs basename: ${serverOutfile}. Choose a different --outfile name; the diagnostic is written to ${diagnosticOutfile}.`);
}
const sharedOptions = {
    absWorkingDir: packageRoot,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
        js: "// device-lab-mcp-version: 1\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
};
await build({
    ...sharedOptions,
    entryPoints: ["server.mjs"],
    outfile: serverOutfile,
});
await build({
    ...sharedOptions,
    entryPoints: ["src/installed-diagnostic.mjs"],
    outfile: diagnosticOutfile,
});
