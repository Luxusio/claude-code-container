import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { scanVersionFiles } from "../../scanner.js";
const trees: string[] = [];
function tree() {
    const root = mkdtempSync(join(tmpdir(), "ccc-version-facade-"));
    trees.push(root);
    return root;
}
afterEach(() => {
    vi.doUnmock("fs");
    vi.resetModules();
    for (const root of trees.splice(0))
        rmSync(root, {
            recursive: true,
            force: true
        });
});
describe("native version scanner compatibility", () => {
    it("preserves arity, default depth, relative native paths and positional overrides", () => {
        const root = tree();
        mkdirSync(join(root, "a", "b", "c", "d"), {
            recursive: true
        });
        for (const dir of [
            root,
            join(root, "a", "b", "c"),
            join(root, "a", "b", "c", "d")
        ])
            writeFileSync(join(dir, ".nvmrc"), "22");
        expect(scanVersionFiles.length).toBe(1);
        expect([
            ...scanVersionFiles(root).keys()
        ]).toEqual([
            ".nvmrc",
            join("a", "b", "c", ".nvmrc")
        ]);
        expect(scanVersionFiles(root, root, 0, 4).size).toBe(3);
        expect([
            ...scanVersionFiles(root, join(root, "a", "b", "c"), 3, 3).keys()
        ]).toEqual([
            join("a", "b", "c", ".nvmrc")
        ]);
        expect(scanVersionFiles(root, root, 4, 3).size).toBe(0);
        expect(scanVersionFiles(join(root, "missing")).size).toBe(0);
    });
    it("uses UTF-8 stat bytes at the inclusive boundary, dotfiles and case-sensitive skips", () => {
        const root = tree();
        const exact = "é".repeat(51200);
        const over = `${exact}x`;
        writeFileSync(join(root, "package.json"), exact);
        writeFileSync(join(root, "go.mod"), over);
        writeFileSync(join(root, ".nvmrc"), "22");
        writeFileSync(join(root, "random.txt"), "ignore");
        for (const name of [
            "node_modules",
            "bin",
            "obj",
            "Pods",
            ".hidden",
            "Node_modules"
        ]) {
            mkdirSync(join(root, name));
            writeFileSync(join(root, name, "Cargo.toml"), name);
        }
        expect(statSync(join(root, "package.json")).size).toBe(102400);
        expect(statSync(join(root, "go.mod")).size).toBe(102401);
        const files = scanVersionFiles(root);
        expect(files.get("package.json")).toBe(exact);
        expect(files.get(".nvmrc")).toBe("22");
        expect(files.get(join("Node_modules", "Cargo.toml"))).toBe("Node_modules");
        expect(files.size).toBe(3);
    });
    it("preserves native directory order and skips file and directory links when available", ({ skip }) => {
        const root = tree();
        writeFileSync(join(root, "go.mod"), "go 1.23");
        writeFileSync(join(root, ".nvmrc"), "22");
        mkdirSync(join(root, "real"));
        writeFileSync(join(root, "real", "Cargo.toml"), "rust");
        try {
            symlinkSync(join(root, "go.mod"), join(root, "linked.csproj"));
            symlinkSync(join(root, "real"), join(root, "linked-dir"), "dir");
        }
        catch {
            skip();
            return;
        }
        const expected = readdirSync(root, {
            withFileTypes: true
        }).flatMap(entry => entry.isDirectory() ? [
            join(entry.name, "Cargo.toml")
        ] : entry.isFile() ? [
            entry.name
        ] : []);
        expect([
            ...scanVersionFiles(root).keys()
        ]).toEqual(expected);
    });
    it("takes the mutable common-ignore array snapshot at facade import", async () => {
        vi.resetModules();
        const { COMMON_IGNORE_DIRS } = await import("../../utils.js");
        const name = "scanner-custom-ignore";
        COMMON_IGNORE_DIRS.push(name);
        try {
            const scanner = await import("../../scanner.js");
            COMMON_IGNORE_DIRS.splice(COMMON_IGNORE_DIRS.lastIndexOf(name), 1);
            const root = tree();
            mkdirSync(join(root, name));
            writeFileSync(join(root, name, ".nvmrc"), "22");
            expect(scanner.scanVersionFiles(root).size).toBe(0);
            COMMON_IGNORE_DIRS.push("scanner-later-ignore");
            mkdirSync(join(root, "scanner-later-ignore"));
            writeFileSync(join(root, "scanner-later-ignore", ".nvmrc"), "23");
            expect([
                ...scanner.scanVersionFiles(root).keys()
            ]).toEqual([
                join("scanner-later-ignore", ".nvmrc")
            ]);
        }
        finally {
            for (const value of [
                name,
                "scanner-later-ignore"
            ]) {
                const index = COMMON_IGNORE_DIRS.lastIndexOf(value);
                if (index >= 0)
                    COMMON_IGNORE_DIRS.splice(index, 1);
            }
        }
    });
    it.each([
        "list",
        "stat",
        "read",
        "source",
        "child"
    ])("contains only the named native %s fault while delegating actual reads", async (boundary) => {
        const root = tree();
        const sub = join(root, "sub");
        mkdirSync(sub);
        writeFileSync(join(root, ".nvmrc"), "22");
        writeFileSync(join(sub, "go.mod"), "go 1.23");
        writeFileSync(join(root, "rust-toolchain"), "stable");
        vi.resetModules();
        vi.doMock("fs", () => ({
            readdirSync: (path: string, options: {
                withFileTypes: true;
            }) => {
                if (boundary === "list" && path === sub)
                    throw Error("named list fault");
                return readdirSync(path, options);
            },
            statSync: (path: string) => {
                if (boundary === "stat" && path === join(root, ".nvmrc"))
                    throw Error("named stat fault");
                return statSync(path);
            },
            readFileSync: (path: string, encoding: "utf-8") => {
                if (boundary === "read" && path === join(root, ".nvmrc"))
                    throw Error("named read fault");
                return readFileSync(path, encoding);
            }
        }));
        vi.doMock("path", () => ({
            join: (dir: string, name: string) => {
                if (boundary === "child" && name === "sub")
                    throw Error("named child fault");
                return join(dir, name);
            },
            relative: (base: string, file: string) => {
                if (boundary === "source" && file === join(root, ".nvmrc"))
                    throw Error("named source fault");
                return relative(base, file);
            }
        }));
        try {
            const scanner = await import("../../scanner.js");
            const result = scanner.scanVersionFiles(root);
            expect(result.get("rust-toolchain")).toBe("stable");
            expect(result.has(".nvmrc")).toBe(![
                "stat",
                "read",
                "source"
            ].includes(boundary));
            expect(result.has(join("sub", "go.mod"))).toBe(![
                "list",
                "child"
            ].includes(boundary));
        }
        finally {
            vi.doUnmock("path");
        }
    });
    it("proves permission faults only under an actually nonprivileged UID", ({ skip }) => {
        if (!process.getuid || process.getuid() === 0) {
            skip();
            return;
        }
        const root = tree();
        writeFileSync(join(root, ".nvmrc"), "22");
        writeFileSync(join(root, "go.mod"), "go 1.23");
        chmodSync(join(root, ".nvmrc"), 0);
        try {
            expect(() => readFileSync(join(root, ".nvmrc"), "utf8")).toThrow();
            expect([
                ...scanVersionFiles(root).keys()
            ]).toEqual([
                "go.mod"
            ]);
            chmodSync(root, 0);
            expect(() => readdirSync(root)).toThrow();
            expect(scanVersionFiles(root).size).toBe(0);
        }
        finally {
            chmodSync(root, 0o700);
            chmodSync(join(root, ".nvmrc"), 0o600);
        }
    });
});
