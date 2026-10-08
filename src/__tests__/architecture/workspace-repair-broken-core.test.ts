import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokenWorkspaceRepair } from "../../application/workspace/repair-broken.js";
import type { BrokenWorkspaceRepairPorts } from "../../ports/workspace/repair-broken.js";
import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";
import { coreBoundaryViolations } from "./core-boundary.js";

describe("broken repair inward admission and dependency boundary", () => {
    it("does not look up native effects before explicit confirmation", () => {
        const ports = new Proxy({}, { get() { throw new Error("unconfirmed native lookup"); } }) as BrokenWorkspaceRepairPorts<WorkspaceRepairAuthority>;
        const app = createBrokenWorkspaceRepair(ports);
        expect(() => app.fixBrokenWorktreeSanitized("source", "workspace", "repo", "branch", false, {})).toThrow("Explicit confirmation is required to replace broken worktree content.");
    });
    it("checks actual broken repair ports/application and representative forbidden edges", () => {
        const root = resolve("src"); const boundary = { root, language: "ts" as const };
        for (const layer of ["ports", "application"]) {
            const path = resolve(root, layer, "workspace/repair-broken.ts"); const source = readFileSync(path, "utf8");
            expect(coreBoundaryViolations(source, path, boundary)).toEqual([]);
            for (const forbidden of ["import { renameSync } from 'node:fs';", "process.stderr;", "Date.now();", "import('../../worktree.js');"]) {
                expect(coreBoundaryViolations(source + forbidden, path, boundary)).not.toEqual([]);
            }
        }
    });
});
