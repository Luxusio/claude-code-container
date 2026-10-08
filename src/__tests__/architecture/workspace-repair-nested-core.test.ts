import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createNestedWorkspaceRepair } from "../../application/workspace/repair-nested.js";
import type { NestedWorkspaceRepairPorts } from "../../ports/workspace/repair-nested.js";
import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";
import { coreBoundaryViolations } from "./core-boundary.js";

describe("nested repair inward boundaries", () => {
    it("does not eagerly observe any native capability during construction", () => {
        createNestedWorkspaceRepair(new Proxy({}, { get() { throw new Error("eager lookup"); } }) as NestedWorkspaceRepairPorts<WorkspaceRepairAuthority>);
    });
    it("returns a mutable empty result before ownership/inventory effects for a non-repository source", () => {
        const events: string[] = [];
        const ports = new Proxy({}, { get(_target, key) {
            if (key === "resolve") return () => { events.push("resolve"); return "source"; };
            if (key === "hasGitMetadata") return () => { events.push("metadata"); return false; };
            throw new Error(`Unused capability ${String(key)}`);
        } }) as NestedWorkspaceRepairPorts<WorkspaceRepairAuthority>;
        const result = createNestedWorkspaceRepair(ports).repairWorkspace("raw", "workspace", "branch");
        result.push({ name: "mutable", branch: "branch", action: "worktree-existing" });
        expect(events).toEqual(["resolve", "metadata"]);
    });
    it("checks actual domain/ports/application and intentional forbidden dependency mutations", () => {
        const root = resolve("src"); const boundary = { root, language: "ts" as const };
        for (const [layer, name] of [["domain", "repair-authority"], ["ports", "repair-nested"], ["application", "repair-nested"]]) {
            const path = resolve(root, layer, `workspace/${name}.ts`); const source = readFileSync(path, "utf8");
            expect(coreBoundaryViolations(source, path, boundary)).toEqual([]);
            for (const forbidden of ["import { readFileSync } from 'node:fs';", "process.env;", "Buffer.alloc(1);", "import('../../worktree.js');"]) {
                expect(coreBoundaryViolations(source + forbidden, path, boundary)).not.toEqual([]);
            }
        }
    });
});
