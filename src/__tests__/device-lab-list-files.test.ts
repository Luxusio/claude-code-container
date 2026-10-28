import { directorySymlink } from "./helpers/file-symlink-fixture.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildListFilesCommand, listContainedDirectory, parseListFilesOutput, validateListFilesArgs, LIST_FILES_COMMAND_LIMIT_CHARS, LIST_FILES_OUTPUT_LIMIT_BYTES } from "@ccc/device-lab/providers/file-listing.mjs";

const roots: string[] = [];
function directory() { const root = mkdtempSync(join(tmpdir(), "ccc-list-files-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function execute(path: string, extra = {}) {
    const command = buildListFilesCommand(process.platform === "darwin" ? "macos-vm" : "linux-vm", { deviceId: "test-device", path, ...extra });
    const result = spawnSync("/bin/sh", ["-c", command], { cwd: path, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
    expect(result.status, result.stderr || String(result.error || "")).toBe(0);
    return { raw: result.stdout, value: parseListFilesOutput(result.stdout) };
}

// Generated POSIX commands require a POSIX host; parser/schema cases remain portable.
describe("bounded device directory commands", () => {
    it.skipIf(process.platform === "win32")("preserves hidden, Unicode, quoted and newline names with file sizes and link types", () => {
        const root = directory();
        const names = ["ordinary.txt", ".hidden", "한글 🎈", "quote'\";$(echo nope)", "line\nbreak\tname", "back\\slash"];
        for (const name of names) writeFileSync(join(root, name), "abc");
        mkdirSync(join(root, "folder"));
        writeFileSync(join(root, "folder", "nested.txt"), "not enumerated");
        symlinkSync("absent", join(root, "broken-link"));
        symlinkSync("folder", join(root, "directory-link"));
        const { value } = execute(root);
        expect(value.truncated).toBeUndefined();
        expect(value.entries).toHaveLength(names.length + 3);
        for (const name of names) expect(value.entries).toContainEqual({ name, type: "file", size: 3 });
        expect(value.entries).toContainEqual({ name: "folder", type: "directory" });
        expect(value.entries).toContainEqual({ name: "broken-link", type: "symlink" });
        expect(value.entries).toContainEqual({ name: "directory-link", type: "symlink" });
        expect(JSON.stringify(value)).not.toContain("nested.txt");
    });
    it.skipIf(process.platform === "win32")("treats the selected directory path as data", () => {
        const root = directory();
        const path = join(root, "x'; touch PWN; printf '");
        mkdirSync(path); writeFileSync(join(path, "kept"), "x");
        expect(execute(path).value.entries).toContainEqual({ name: "kept", type: "file", size: 1 });
        expect(existsSync(join(path, "PWN"))).toBe(false);
        expect(existsSync(join(root, "PWN"))).toBe(false);
    });
    it.skipIf(process.platform === "win32")("distinguishes an empty directory from missing or non-directory paths", () => {
        const root = directory();
        expect(execute(root).value).toEqual({ entries: [] });
        writeFileSync(join(root, "file"), "x");
        for (const path of [join(root, "missing"), join(root, "file")]) {
            const command = buildListFilesCommand("linux-vm", { deviceId: "test-device", path });
            const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 5000 });
            expect(result.status).not.toBe(0);
        }
    });
    it.skipIf(process.platform === "win32")("reports truncation only when entries were omitted", () => {
        const root = directory();
        for (const name of ["a", "b", "c"]) writeFileSync(join(root, name), "");
        expect(execute(root, { limit: 3 }).value.truncated).toBeUndefined();
        const limited = execute(root, { limit: 2 }).value;
        expect(limited.entries).toHaveLength(2);
        expect(limited.truncated).toBe(true);
    });
    it.skipIf(process.platform === "win32")("bounds produced bytes even below the requested entry limit", () => {
        const root = directory();
        for (let i = 0; i < 150; i++) writeFileSync(join(root, `${String(i).padStart(3, "0")}-${"x".repeat(180)}`), "");
        const { raw, value } = execute(root, { limit: 500 });
        expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(LIST_FILES_OUTPUT_LIMIT_BYTES);
        expect(value.truncated).toBe(true);
        expect(value.entries.length).toBeGreaterThan(0);
        expect(value.entries.length).toBeLessThan(150);
    });
    it.each(["", "garbage", "{}", '{"entries":"invalid"}'])("rejects malformed output %j instead of reporting empty success", (value) => {
        expect(() => parseListFilesOutput(value)).toThrow();
    });
    it.each([null, 0, [], "", "a\0b"].map(path => ({ path })))("rejects invalid path $path", ({ path }) => {
        expect(validateListFilesArgs({ deviceId: "test-device", path })).toBeTruthy();
    });
    it.each([0, -1, 501, 1.5, "10", null])("rejects invalid limit %j", (limit) => {
        expect(validateListFilesArgs({ deviceId: "test-device", path: "/tmp", limit })).toBeTruthy();
    });
    it("uses literal Windows path handling and keeps normal commands within guest limits", () => {
        for (const backend of ["windows-vm", "windows-sandbox"]) {
            const command = buildListFilesCommand(backend, { deviceId: "test-device", path: "C:\\Users\\ccc\\a'$(Write-Output injected)", limit: 100 });
            expect(command.length).toBeLessThanOrEqual(4096);
            expect(command).toMatch(/LiteralPath/);
        }
    });
    it("applies the macOS command budget after quoting the complete listing program", () => {
        expect(buildListFilesCommand("macos-vm", { path: "/tmp" }).length).toBeLessThanOrEqual(LIST_FILES_COMMAND_LIMIT_CHARS);
        expect(() => buildListFilesCommand("macos-vm", { path: "'".repeat(300) }))
            .toThrow("list-files-path-exceeds-command-budget");
    });
});

const strictBashAvailable = process.platform !== "win32" && existsSync("/bin/bash");
describe.skipIf(!strictBashAvailable)("macOS listings through a strict outer shell (requires POSIX /bin/bash)", () => {
    function executeFromLoginShell(path: string, extra = {}) {
        const command = buildListFilesCommand("macos-vm", { path, ...extra });
        const env = { ...process.env };
        for (const name of ["BASH_ENV", "ENV", "BASHOPTS", "SHELLOPTS"]) delete env[name];
        return spawnSync("/bin/bash", ["--noprofile", "--norc", "-O", "failglob", "-c", command], {
            cwd: dirname(path), encoding: "utf8", env, timeout: 5000, maxBuffer: 64 * 1024,
        });
    }

    it("returns an empty listing even when unmatched outer-shell patterns are errors", () => {
        const result = executeFromLoginShell(directory());
        expect(result.status, result.stderr || String(result.error || "")).toBe(0);
        expect(parseListFilesOutput(result.stdout)).toEqual({ entries: [] });
    });

    it("keeps directory paths and literal entry names as data through both shell layers", () => {
        const root = directory();
        const path = join(root, "x'; touch PWN; printf '");
        mkdirSync(path);
        const names = ["ordinary.txt", ".hidden", "한글 🎈", "quote'\";$(echo nope)", "line\nbreak\tname"];
        for (const name of names) writeFileSync(join(path, name), "abc");
        mkdirSync(join(path, "folder"));
        writeFileSync(join(path, "folder", "nested.txt"), "not listed");
        symlinkSync("absent", join(path, "broken-link"));
        symlinkSync("folder", join(path, "directory-link"));

        const result = executeFromLoginShell(path);
        expect(result.status, result.stderr || String(result.error || "")).toBe(0);
        const listing = parseListFilesOutput(result.stdout);
        expect(listing.entries).toHaveLength(names.length + 3);
        for (const name of names) {
            const entry = listing.entries.find(item => item.name === name);
            expect(entry).toEqual(expect.objectContaining({ name, type: "file" }));
            // Linux does not qualify BSD stat; the existing platform-native cases check exact sizes.
            if (entry?.size !== undefined) expect(entry.size).toBe(3);
        }
        expect(listing.entries).toContainEqual({ name: "folder", type: "directory" });
        expect(listing.entries).toContainEqual({ name: "broken-link", type: "symlink" });
        expect(listing.entries).toContainEqual({ name: "directory-link", type: "symlink" });
        expect(JSON.stringify(listing)).not.toContain("nested.txt");
        expect(existsSync(join(root, "PWN"))).toBe(false);
        expect(existsSync(join(path, "PWN"))).toBe(false);
    });

    it("preserves truncation and native directory errors through the selected interpreter", () => {
        const root = directory();
        for (const name of ["a", "b", "c"]) writeFileSync(join(root, name), "");
        const complete = executeFromLoginShell(root, { limit: 3 });
        expect(complete.status, complete.stderr).toBe(0);
        const completeListing = parseListFilesOutput(complete.stdout);
        expect(completeListing.entries).toHaveLength(3);
        expect(completeListing.truncated).toBeUndefined();
        const limited = executeFromLoginShell(root, { limit: 2 });
        expect(limited.status, limited.stderr).toBe(0);
        expect(parseListFilesOutput(limited.stdout)).toMatchObject({ entries: [expect.any(Object), expect.any(Object)], truncated: true });
        for (const path of [join(root, "missing"), join(root, "a")]) {
            expect(executeFromLoginShell(path).status).not.toBe(0);
        }
    });
});

describe("simulator app-container directory boundary", () => {
    it("lists only immediate app entries, preserves hidden names and never follows entry links", () => {
        const root = directory(), outside = directory();
        writeFileSync(join(root, ".hidden"), "x");
        writeFileSync(join(outside, "private-name"), "not exposed");
        directorySymlink(outside, join(root, "link"));
        mkdirSync(join(root, "Documents"));
        expect(listContainedDirectory(root, ".")).toEqual({ entries: expect.arrayContaining([
            expect.objectContaining({ name: ".hidden", type: "file" }), { name: "link", type: "symlink" }, { name: "Documents", type: "directory" },
        ]) });
        expect(listContainedDirectory(root, "Documents")).toEqual({ entries: [] });
        expect(listContainedDirectory(root, ".", 1)).toMatchObject({ entries: [expect.any(Object)], truncated: true });
        expect(() => listContainedDirectory(root, "link")).toThrow();
        expect(() => listContainedDirectory(root, "../")).toThrow();
        expect(() => listContainedDirectory(root, outside)).toThrow();
        expect(() => listContainedDirectory(root, "absent")).toThrow();
    });
    it("bounds app-container result bytes independently from entry count", () => {
        const root = directory();
        for (let i = 0; i < 150; i++) writeFileSync(join(root, `${i}-${"x".repeat(180)}`), "");
        const result = listContainedDirectory(root, ".", 500);
        expect(result.truncated).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(LIST_FILES_OUTPUT_LIMIT_BYTES);
    });
});
