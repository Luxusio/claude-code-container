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
];
function filesUnder(directory: string, extension: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        if (entry.isSymbolicLink()) throw new Error(`Linked core entry: ${entry.name}`);
        const path = join(directory, entry.name);
        return entry.isDirectory() ? filesUnder(path, extension) : entry.name.endsWith(extension) ? [path] : [];
    });
}

describe("core layer dependency graph", () => {
    it("checks every migrated core file across all three source roots", () => {
        let checked = 0;
        const findings: Array<{ file: string; violations: string[] }> = [];
        for (const boundary of boundaries) for (const layer of ["domain", "ports", "application"]) {
            for (const file of filesUnder(join(boundary.root, layer), `.${boundary.language}`)) {
                const violations = coreBoundaryViolations(readFileSync(file, "utf8"), file, boundary);
                if (violations.length) findings.push({ file, violations });
                checked++;
            }
        }
        expect(checked).toBeGreaterThanOrEqual(3);
        expect(findings).toEqual([]);
    });

});
