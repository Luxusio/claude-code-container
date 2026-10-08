import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createRootWorkspaceRepair } from "../../application/workspace/repair-root.js";
import type { RootWorkspaceRepairPorts } from "../../ports/workspace/repair-root.js";
import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";
import { coreBoundaryViolations } from "./core-boundary.js";

describe("root repair inward boundary and admission", () => {
    it("does not observe native getters at construction", () => {
        createRootWorkspaceRepair(new Proxy({}, { get() { throw new Error("eager native lookup"); } }) as RootWorkspaceRepairPorts<WorkspaceRepairAuthority>);
    });
    it("refuses an already-valid registration without native recovery effects", () => {
        const effects: string[] = [];
        const ports = new Proxy({}, { get(_target, key) {
            if (key === "isValidWorktree") return () => { effects.push("validity"); return true; };
            throw new Error(`Unused native effect ${String(key)}`);
        } }) as RootWorkspaceRepairPorts<WorkspaceRepairAuthority>;
        const result = createRootWorkspaceRepair(ports).handleWorkspaceRootOwnership("workspace", "source", "branch", "confirmed", function (this: unknown, message) {
            expect(this).toBeUndefined(); effects.push(message);
        });
        expect(result).toBe(false); expect(effects).toEqual(["validity", "workspace registration is already valid"]);
    });
    it("guards actual root application/ports and intentional native dependency mutations", () => {
        const root = resolve("src"); const boundary = { root, language: "ts" as const };
        for (const layer of ["ports", "application"]) {
            const path = resolve(root, layer, "workspace/repair-root.ts"); const source = readFileSync(path, "utf8");
            expect(coreBoundaryViolations(source, path, boundary)).toEqual([]);
            for (const forbidden of ["import { spawnSync } from 'node:child_process';", "process.platform;", "Buffer.alloc(1);", "import('../../worktree.js');"]) {
                expect(coreBoundaryViolations(source + forbidden, path, boundary)).not.toEqual([]);
            }
        }
    });
});
