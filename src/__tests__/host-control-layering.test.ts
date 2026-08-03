import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const hostControlRoot = join(repoRoot, "src", "host-control");

function sourceFiles(root: string): string[] {
    if (!existsSync(root)) {
        return [];
    }
    return readdirSync(root).flatMap((entry) => {
        const path = join(root, entry);
        return statSync(path).isDirectory()
            ? sourceFiles(path)
            : /\.(?:[cm]?[jt]s)$/.test(path)
                ? [path]
                : [];
    });
}

describe("host-control dependency boundary", () => {
    it("removes the legacy Hyper-V provider path", () => {
        expect(existsSync(join(repoRoot, "src", "device-lab", "providers", "hyper-v.ts"))).toBe(false);
        const legacyPath = ["device-lab", "providers", "hyper-v"].join("/");
        const legacyImports = [
            join(repoRoot, "src"),
            join(repoRoot, "scripts"),
            join(repoRoot, "device-lab-mcp"),
        ].flatMap(sourceFiles)
            .filter((file) => readFileSync(file, "utf8").includes(legacyPath));
        expect(legacyImports).toEqual([]);
    });

    it("does not depend on broker, MCP, HTTP, owner-auth, or persistent state modules", () => {
        const forbidden = [
            /device-lab-broker/,
            /device-lab\/broker/,
            /device-lab-mcp/,
            /node:http/,
            /(?:^|\/)http(?:\.js)?["']/,
            /owner-auth/,
            /device-lab-state/,
        ];
        const violations = sourceFiles(hostControlRoot).flatMap((file) => {
            const imports = Array.from(readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g), (match) => match[1]);
            return imports.filter((specifier) => forbidden.some((pattern) => pattern.test(specifier)))
                .map((specifier) => `${file}:${specifier}`);
        });

        expect(violations).toEqual([]);
    });
});
