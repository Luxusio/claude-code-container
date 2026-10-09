import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import ts from "typescript";
import { nativeCleanupRoot, nativeCleanupAdmission, originalPayload } from "../helpers/native-cleanup-fixture.js";

describe("native cleanup static boundary and frozen provenance", () => {
    it("retains all original47 bodies and9 data/type declarations", () => {
        const bodies = JSON.parse(fs.readFileSync(path.join(nativeCleanupAdmission, "static-source/bodies.json"), "utf8")) as Array<{ name: string; text: string; sha256: string; kind: string }>;
        const candidate = fs.readFileSync(path.join(nativeCleanupRoot, "src/device-lab-cleanup.ts"), "utf8");
        expect(bodies.filter(body => body.kind === "FunctionDeclaration")).toHaveLength(47);
        expect(bodies.filter(body => body.kind !== "FunctionDeclaration")).toHaveLength(9);
        for (const body of bodies) {
            expect(crypto.createHash("sha256").update(body.text).digest("hex")).toBe(body.sha256);
            expect(candidate.replace(/\bexport /g, "")).toContain(body.text.replace(/\bexport /g, ""));
        }
    });
    it("binds authentic whole original payload and declaration hashes", () => {
        const provenance = JSON.parse(fs.readFileSync(path.join(nativeCleanupAdmission, "baseline/provenance.json"), "utf8"));
        expect(provenance.sourceBase).toBe("efc11279e957802b0de1f34b591f96a104035fb4");
        expect(provenance.productionUnchanged).toBe(true);
        expect(provenance.fileCount).toBe(687);
        for (const file of provenance.wholePayloadHashes) {
            expect(crypto.createHash("sha256").update(fs.readFileSync(path.join(originalPayload, file.path))).digest("hex")).toBe(file.sha256);
        }
        expect(crypto.createHash("sha256").update(fs.readFileSync(path.join(originalPayload, "dist/device-lab-admin.d.ts"))).digest("hex"))
            .toBe("6693d0cdc6d2812c1b982d316c6f761d8ae8a509237f880fcc22fedfb82c6109");
    });
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
