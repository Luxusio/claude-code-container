import {
    appendFileSync,
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyWritableTestTree } from "./helpers/writable-test-copy.js";

type TreeEntry = { mode: number; bytes?: string };

function snapshotTree(root: string): Record<string, TreeEntry> {
    const entries: Record<string, TreeEntry> = {};
    function visit(path: string): void {
        const stat = lstatSync(path);
        const entry: TreeEntry = { mode: stat.mode & 0o777 };
        entries[relative(root, path) || "."] = entry;
        if (stat.isDirectory()) {
            for (const name of readdirSync(path).sort()) visit(join(path, name));
        } else {
            entry.bytes = readFileSync(path).toString("hex");
        }
    }
    visit(root);
    return entries;
}

// These trees are created by this owner. Restore only their modes for cleanup.
function restoreOwnedTree(path: string): void {
    const stat = lstatSync(path);
    chmodSync(path, (stat.mode & 0o777) | (stat.isDirectory() ? 0o700 : 0o600));
    if (stat.isDirectory()) {
        for (const name of readdirSync(path)) restoreOwnedTree(join(path, name));
    }
}

describe.skipIf(process.platform === "win32")("writable private MCP fixture copies", () => {
    const ownedRoots: string[] = [];

    afterEach(() => {
        for (const root of ownedRoots.splice(0)) {
            restoreOwnedTree(root);
            rmSync(root, { recursive: true, force: true });
        }
    });

    function createFixture(): { source: string; destination: string } {
        const root = mkdtempSync(join(tmpdir(), "ccc-mcp-fixture-copy-"));
        ownedRoots.push(root);
        const source = join(root, "sealed-source");
        const destination = join(root, "private-copy");
        const nested = join(source, "dist", "nested");
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(nested, "payload.txt"), "original payload\n");
        writeFileSync(join(source, "dist", "broker-entry.js"), "export const original = true;\n");
        chmodSync(join(nested, "payload.txt"), 0o444);
        chmodSync(join(source, "dist", "broker-entry.js"), 0o444);
        chmodSync(nested, 0o555);
        chmodSync(join(source, "dist"), 0o555);
        chmodSync(source, 0o555);
        return { source, destination };
    }

    it("allows nested appends and entry replacement without changing source bytes or modes", () => {
        const { source, destination } = createFixture();
        const original = snapshotTree(source);

        copyWritableTestTree(source, destination, { recursive: true });

        expect(lstatSync(destination).mode & 0o700).toBe(0o700);
        expect(lstatSync(join(destination, "dist", "nested")).mode & 0o700).toBe(0o700);
        expect(lstatSync(join(destination, "dist", "nested", "payload.txt")).mode & 0o600).toBe(0o600);
        appendFileSync(join(destination, "dist", "nested", "payload.txt"), "private append\n");
        const replacement = join(destination, "dist", "replacement.js");
        writeFileSync(replacement, "export const replacement = true;\n");
        renameSync(replacement, join(destination, "dist", "broker-entry.js"));
        mkdirSync(join(destination, "dist", "nested", "new-directory"));

        expect(readFileSync(join(destination, "dist", "nested", "payload.txt"), "utf8"))
            .toBe("original payload\nprivate append\n");
        expect(readFileSync(join(destination, "dist", "broker-entry.js"), "utf8"))
            .toBe("export const replacement = true;\n");
        expect(snapshotTree(source)).toEqual(original);
    });

    it("retains existing executable and group/other permission bits while adding owner access", () => {
        const { source, destination } = createFixture();
        chmodSync(source, 0o755);
        const modes = [0o400, 0o440, 0o444, 0o455, 0o551];
        for (const mode of modes) {
            const file = join(source, `mode-${mode.toString(8)}`);
            writeFileSync(file, `mode ${mode.toString(8)}\n`);
            chmodSync(file, mode);
        }
        chmodSync(join(source, "dist", "nested"), 0o550);
        chmodSync(source, 0o555);
        const original = snapshotTree(source);

        copyWritableTestTree(source, destination, { recursive: true });

        const copied = snapshotTree(destination);
        expect(Object.keys(copied)).toEqual(Object.keys(original));
        for (const [path, entry] of Object.entries(original)) {
            expect(copied[path]).toEqual({
                ...entry,
                mode: entry.mode | (entry.bytes === undefined ? 0o700 : 0o600),
            });
        }
        expect(lstatSync(join(destination, "mode-444")).mode & 0o111).toBe(0);
        expect(lstatSync(join(destination, "mode-551")).mode & 0o111).toBe(0o111);
        expect(snapshotTree(source)).toEqual(original);
    });

    it("preserves copy filters without recreating excluded files or subtrees", () => {
        const { source, destination } = createFixture();
        chmodSync(source, 0o755);
        const excludedDirectory = join(source, "node_modules");
        mkdirSync(excludedDirectory);
        writeFileSync(join(excludedDirectory, "excluded.txt"), "excluded dependency\n");
        writeFileSync(join(source, "omit.txt"), "excluded file\n");
        chmodSync(join(excludedDirectory, "excluded.txt"), 0o444);
        chmodSync(join(source, "omit.txt"), 0o444);
        chmodSync(excludedDirectory, 0o555);
        chmodSync(source, 0o555);
        const original = snapshotTree(source);

        copyWritableTestTree(source, destination, {
            recursive: true,
            filter: path => !relative(source, path).split(sep).includes("node_modules") && basename(path) !== "omit.txt",
        });

        expect(existsSync(join(destination, "node_modules"))).toBe(false);
        expect(existsSync(join(destination, "omit.txt"))).toBe(false);
        const payload = join(destination, "dist", "nested", "payload.txt");
        expect(readFileSync(payload, "utf8")).toBe("original payload\n");
        expect(lstatSync(payload).mode & 0o777).toBe(0o644);
        appendFileSync(payload, "allowed private edit\n");
        expect(snapshotTree(source)).toEqual(original);
    });
});
