import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../..");

describe("npm package contents", () => {
    it("ships the postinstall script referenced by package.json", () => {
        const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
            scripts?: Record<string, string>;
        };
        expect(pkg.scripts?.postinstall).toBe("node scripts/install.js --postinstall");

        const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
            cwd: repoRoot,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        const [pack] = JSON.parse(out) as Array<{
            files: Array<{ path: string }>;
        }>;
        const files = new Set(pack.files.map((file) => file.path));

        expect(files).toContain("scripts/install.js");
        expect(files).toContain("dist/index.js");
        expect(files).toContain("dist/x11-mcp/server.mjs");
    });
});
