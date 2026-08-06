import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HYPER_V_POWERSHELL_MANIFEST } from "../src/host-control/hyper-v/powershell-manifest.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(repoRoot, "scripts", "host-control", "hyper-v");

function filesUnder(root: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory() ? filesUnder(path) : [path];
    });
}

if (HYPER_V_POWERSHELL_MANIFEST.schemaVersion !== 1 || Object.keys(HYPER_V_POWERSHELL_MANIFEST.operations).length === 0) {
    throw new Error("Hyper-V PowerShell command manifest is empty or invalid");
}

const realRoot = realpathSync(assetRoot);
for (const [name, metadata] of Object.entries(HYPER_V_POWERSHELL_MANIFEST.assets)) {
    const file = realpathSync(join(assetRoot, name));
    if (relative(realRoot, file).startsWith("..") || !lstatSync(file).isFile()) {
        throw new Error(`Hyper-V PowerShell asset escapes package root: ${name}`);
    }
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (digest !== metadata.sha256) throw new Error(`Hyper-V PowerShell asset digest mismatch: ${name}`);
}
for (const [operation, entry] of Object.entries(HYPER_V_POWERSHELL_MANIFEST.operations)) {
    if (entry.requestVersion !== 1 || !(entry.script in HYPER_V_POWERSHELL_MANIFEST.assets)) {
        throw new Error(`Invalid Hyper-V PowerShell operation: ${operation}`);
    }
}

for (const file of filesUnder(assetRoot).filter((candidate) => /\.ps(?:1|m1)$/i.test(candidate))) {
    const source = readFileSync(file);
    if (source.includes(0)) throw new Error(`NUL byte in PowerShell asset: ${relative(repoRoot, file)}`);
    const text = source.toString("utf8");
    if (text.includes("\uFFFD")) throw new Error(`Invalid UTF-8 in PowerShell asset: ${relative(repoRoot, file)}`);
    if (/__[A-Z][A-Z0-9_]{2,}__/.test(text)) throw new Error(`Unresolved template token in PowerShell asset: ${relative(repoRoot, file)}`);
}

const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
if (!packageJson.files?.includes("scripts/host-control/hyper-v/")) {
    throw new Error("npm package omits Hyper-V PowerShell assets");
}

console.log(`PASS Hyper-V PowerShell contracts operations=${Object.keys(HYPER_V_POWERSHELL_MANIFEST.operations).length}`);
