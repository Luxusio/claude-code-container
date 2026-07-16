import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    validateLocalInputPath,
    validateLocalOutputPath,
    validateLocalReferencePath,
} from "../../device-lab-mcp/src/policy/files.mjs";

describe("device-lab local file policy", () => {
    const roots: string[] = [];

    function tempRoot() {
        const root = mkdtempSync(join(tmpdir(), "ccc-device-file-policy-"));
        roots.push(root);
        return root;
    }

    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("accepts regular input and missing output paths", () => {
        const root = tempRoot();
        const source = join(root, "upload.txt");
        const destination = join(root, "downloads", "out.txt");
        writeFileSync(source, "ok");

        expect(validateLocalInputPath(source)).toEqual(expect.objectContaining({ ok: true, path: source, size: 2 }));
        expect(validateLocalOutputPath(destination)).toEqual(expect.objectContaining({ ok: true, path: destination }));
    });

    it("rejects secret-looking and oversized upload sources", () => {
        const root = tempRoot();
        const secret = join(root, ".env");
        const big = join(root, "big.txt");
        writeFileSync(secret, "TOKEN=secret");
        writeFileSync(big, "12345");

        expect(validateLocalInputPath(secret)).toEqual(expect.objectContaining({
            ok: false,
            error: "local-input-path-secret-looking-file",
        }));
        expect(validateLocalInputPath(big, { maxFileBytes: 4 })).toEqual(expect.objectContaining({
            ok: false,
            error: "local-input-path-file-too-large",
            size: 5,
            maxFileBytes: 4,
        }));
    });

    it("rejects secret content in upload sources without leaking matched values", () => {
        const root = tempRoot();
        const source = join(root, "config.txt");
        writeFileSync(source, "TOKEN=super-secret-token-value-12345\n");

        const result = validateLocalInputPath(source);

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            error: "local-input-path-secret-content",
            path: source,
            pattern: "secret-assignment",
        }));
        expect(JSON.stringify(result)).not.toContain("super-secret-token-value-12345");
    });

    it("rejects symlink inputs, symlink output ancestors, and symlink references", () => {
        const root = tempRoot();
        const outside = tempRoot();
        const source = join(root, "source.txt");
        const sourceLink = join(root, "source-link.txt");
        const ancestorLink = join(root, "linked-parent");
        const key = join(root, "id_ed25519");
        const keyLink = join(root, "key-link");
        writeFileSync(source, "ok");
        writeFileSync(key, "private-key");
        symlinkSync(source, sourceLink);
        symlinkSync(outside, ancestorLink);
        symlinkSync(key, keyLink);

        expect(validateLocalInputPath(sourceLink)).toEqual(expect.objectContaining({
            ok: false,
            error: "local-input-path-symlink-rejected",
        }));
        expect(validateLocalOutputPath(join(ancestorLink, "out.txt"))).toEqual(expect.objectContaining({
            ok: false,
            error: "local-output-path-symlink-ancestor-rejected",
            ancestorPath: ancestorLink,
        }));
        expect(validateLocalReferencePath(key)).toEqual(expect.objectContaining({ ok: true, path: key }));
        expect(validateLocalReferencePath(keyLink, { label: "ssh-key-path" })).toEqual(expect.objectContaining({
            ok: false,
            error: "ssh-key-path-symlink-rejected",
        }));
    });

    it("rejects raw symlink prefixes before parent-directory traversal can escape", () => {
        const root = tempRoot();
        const outside = tempRoot();
        const source = join(root, "safe.txt");
        const key = join(root, "safe-key");
        const link = join(root, "linked-parent");
        writeFileSync(source, "ok");
        writeFileSync(key, "private-key");
        symlinkSync(outside, link);

        expect(validateLocalInputPath(`${root}/linked-parent/../safe.txt`)).toEqual(expect.objectContaining({
            ok: false,
            error: "local-input-path-symlink-ancestor-rejected",
            ancestorPath: link,
        }));
        expect(validateLocalOutputPath(`${root}/linked-parent/../out.txt`)).toEqual(expect.objectContaining({
            ok: false,
            error: "local-output-path-symlink-ancestor-rejected",
            ancestorPath: link,
        }));
        expect(validateLocalReferencePath(`${root}/linked-parent/../safe-key`, { label: "ssh-key-path" })).toEqual(expect.objectContaining({
            ok: false,
            error: "ssh-key-path-symlink-ancestor-rejected",
            ancestorPath: link,
        }));
    });

    it("rejects existing non-file output and reference paths", () => {
        const root = tempRoot();
        const outputDirectory = join(root, "output-dir");
        const referenceDirectory = join(root, "reference-dir");
        mkdirSync(outputDirectory);
        mkdirSync(referenceDirectory);

        expect(validateLocalOutputPath(outputDirectory)).toEqual(expect.objectContaining({
            ok: false,
            error: "local-output-path-not-a-file",
        }));
        expect(validateLocalReferencePath(referenceDirectory, { label: "ssh-key-path" })).toEqual(expect.objectContaining({
            ok: false,
            error: "ssh-key-path-not-a-file",
        }));
    });
});
