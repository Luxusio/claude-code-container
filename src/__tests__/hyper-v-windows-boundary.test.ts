import { readFileSync, readdirSync } from "fs";
import { dirname, extname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const projectSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(projectSourceRoot, "hyper-v-windows");

function sourceFiles(root: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory() ? sourceFiles(path) : extname(path) === ".ts" ? [path] : [];
    });
}

describe("Hyper-V Windows package boundary", () => {
    it("contains no upward imports or consumer-specific terminology", () => {
        const forbiddenTerms = /device-lab|deviceId|ownerId|incarnationId|\bbackend\b|\bMCP\b|\bHTTP\b/;
        for (const path of sourceFiles(sourceRoot)) {
            const source = readFileSync(path, "utf8");
            expect(source, relative(sourceRoot, path)).not.toMatch(forbiddenTerms);
            for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
                const specifier = match[1];
                expect(
                    specifier.startsWith(".") || specifier.startsWith("node:") || ["crypto", "fs", "path", "url"].includes(specifier),
                    `${relative(sourceRoot, path)} imports ${specifier}`,
                ).toBe(true);
            }
        }
    });

    it("keeps lifecycle dependencies out of the low-level layer", () => {
        const lowLevelRoot = join(sourceRoot, "low-level");
        for (const path of sourceFiles(lowLevelRoot)) {
            expect(readFileSync(path, "utf8"), relative(sourceRoot, path)).not.toMatch(/from\s+["'][^"']*lifecycle/);
        }
    });

    it("keeps the lifecycle layer package-local and free of persistence layout policy", () => {
        const lifecycleRoot = join(sourceRoot, "lifecycle");
        const forbiddenPolicy = /operation\.json|root\.vhdx|device_(?:start|stop|reboot|delete)/;
        for (const path of sourceFiles(lifecycleRoot)) {
            const source = readFileSync(path, "utf8");
            expect(source, relative(sourceRoot, path)).not.toMatch(forbiddenPolicy);
            for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
                const specifier = match[1];
                expect(
                    specifier.startsWith("./") || specifier.startsWith("../low-level/") || specifier === "path",
                    `${relative(sourceRoot, path)} imports ${specifier}`,
                ).toBe(true);
            }
        }
    });

    it("exports both extractable layers from the internal root", () => {
        const rootEntrypoint = readFileSync(join(sourceRoot, "index.ts"), "utf8");
        expect(rootEntrypoint).toContain('export * from "./low-level/index.js"');
        expect(rootEntrypoint).toContain('export * from "./lifecycle/index.js"');
    });

    it("keeps production consumers on layer entrypoints", () => {
        for (const path of sourceFiles(projectSourceRoot)) {
            const projectPath = relative(projectSourceRoot, path);
            if (projectPath.startsWith("hyper-v-windows/") || projectPath.startsWith("__tests__/")) continue;
            const source = readFileSync(path, "utf8");
            for (const match of source.matchAll(/hyper-v-windows\/(?:low-level|lifecycle)\/([^"']+)/g)) {
                expect(match[1], `${projectPath} deep-imports ${match[0]}`).toBe("index.js");
            }
        }
    });
});
