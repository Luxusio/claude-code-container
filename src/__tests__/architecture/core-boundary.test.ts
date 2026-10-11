import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coreBoundaryViolations, type CoreBoundary } from "./core-boundary.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const boundaries: CoreBoundary[] = [
    { root: join(repository, "packages/device-lab/providers"), language: "mjs" },
    { root: join(repository, "src"), language: "ts" },
    { root: join(repository, "packages/device-lab/src/device-lab"), language: "ts" },
    { root: join(repository, "device-lab-mcp/src"), language: "mjs", providerRoot: join(repository, "packages/device-lab/providers") },
    { root: join(repository, "scripts/install"), language: "mjs", flat: true },
];
function filesUnder(directory: string, extensions: string[]): string[] {
    if (!existsSync(directory)) throw new Error(`Missing core directory: ${directory}`);
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        if (entry.isSymbolicLink()) throw new Error(`Linked core entry: ${entry.name}`);
        const path = join(directory, entry.name);
        return entry.isDirectory() ? filesUnder(path, extensions) : extensions.some(extension => entry.name.endsWith(extension)) ? [path] : [];
    });
}

describe("core layer dependency graph", () => {
    it("checks every migrated core file across all five production source roots", () => {
        const findings: Array<{ file: string; violations: string[] }> = [];
        for (const boundary of boundaries) {
            const files = boundary.flat
                ? ["domain.mjs", "ports.d.mts", "application.mjs"].map(file => join(boundary.root, file))
                : ["domain", "ports", "application"].flatMap(layer => filesUnder(join(boundary.root, layer), boundary.language === "mjs" ? [".mjs", ".d.mts"] : [".ts"]));
            expect(files.length, boundary.root).toBeGreaterThan(0);
            for (const file of files) {
                const violations = coreBoundaryViolations(readFileSync(file, "utf8"), file, boundary);
                if (violations.length) findings.push({ file, violations });
            }
        }
        expect(findings).toEqual([]);
    });

});
