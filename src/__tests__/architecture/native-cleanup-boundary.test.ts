import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { nativeCleanupRoot } from "../helpers/native-cleanup-fixture.js";

describe("native cleanup current import boundaries", () => {
    it("walks the actual transitive native import graph without admin/broker backedges", () => {
        const visited = new Set<string>();
        const visit = (file: string) => {
            if (visited.has(file)) return; visited.add(file);
            expect(file).not.toMatch(/device-lab-admin\.|device-lab-broker\.|\/broker\//);
            const code = fs.readFileSync(file, "utf8");
            const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
            for (const node of ast.statements) {
                if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
                const specifier = node.moduleSpecifier.text;
                if (specifier.startsWith(".")) {
                    let next = path.resolve(path.dirname(file), specifier);
                    if (next.endsWith(".js") && fs.existsSync(next.slice(0, -3) + ".ts")) next = next.slice(0, -3) + ".ts";
                    visit(next);
                } else if (specifier.startsWith("@ccc/device-lab/")) {
                    visit(path.join(nativeCleanupRoot, "packages/device-lab/src", specifier.slice("@ccc/device-lab/".length).replace(/\.js$/, ".ts")));
                } else expect(specifier.replace(/^node:/, "")).toMatch(/^(fs|path|crypto|os|util|child_process)(\/promises)?$/);
            }
        };
        visit(path.join(nativeCleanupRoot, "src/device-lab-cleanup.ts"));
        expect(visited.size).toBeGreaterThan(10);
        const adapter = fs.readFileSync(path.join(nativeCleanupRoot, "src/adapters/session-cleanup.ts"), "utf8");
        expect(adapter).toContain('from "../device-lab-cleanup.js"');
        expect(adapter).not.toContain("device-lab-admin");
    });
    it("walks actual emitted cleanup/session/ownership startup edges without legacy admin or broker", () => {
        const visited = new Set<string>();
        const visit = (file: string) => {
            if (visited.has(file)) return;
            visited.add(file);
            expect(file).not.toMatch(/device-lab-admin\.|device-lab-broker\.|\/broker\//);
            const ast = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
            for (const node of ast.statements) {
                if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
                const specifier = node.moduleSpecifier.text;
                if (specifier.startsWith(".")) visit(path.resolve(path.dirname(file), specifier));
                else if (specifier.startsWith("@ccc/device-lab/")) visit(path.join(nativeCleanupRoot, "dist/packages/device-lab/dist", specifier.slice("@ccc/device-lab/".length)));
                else expect(specifier.replace(/^node:/, "")).toMatch(/^(fs|path|crypto|os|util|url|readline|child_process)(\/promises)?$/);
            }
        };
        for (const entry of ["device-lab-cleanup.js", "session.js", "composition/session-ownership.js"]) visit(path.join(nativeCleanupRoot, "dist", entry));
        expect(visited.size).toBeGreaterThan(20);
    });

});
