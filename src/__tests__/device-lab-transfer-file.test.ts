import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    commitLocalOutputStage,
    createLocalOutputStage,
    populateLocalOutputStage,
    restoreLocalOutputStage,
    stageLocalInputFile,
} from "../../device-lab-mcp/src/transfer-file.mjs";

describe("device-lab transfer file boundaries", () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    function tempRoot() {
        const root = mkdtempSync(join(tmpdir(), "ccc-transfer-file-"));
        roots.push(root);
        return root;
    }

    it("stages a stable upload snapshot and removes it on cleanup", () => {
        const source = join(tempRoot(), "upload.txt");
        writeFileSync(source, "before");
        const staged = stageLocalInputFile(source);
        expect(staged.ok).toBe(true);
        if (!staged.ok) return;

        writeFileSync(source, "after");
        expect(readFileSync(staged.stagedPath, "utf8")).toBe("before");
        staged.cleanup();
        expect(existsSync(staged.stagedPath)).toBe(false);
    });

    it("rejects linked and secret upload content after staging", () => {
        const root = tempRoot();
        const source = join(root, "upload.txt");
        const hard = join(root, "hard.txt");
        writeFileSync(source, "safe");
        linkSync(source, hard);
        expect(stageLocalInputFile(source)).toEqual(expect.objectContaining({ ok: false, error: "upload-local-path-state-invalid" }));

        const secret = join(root, "payload.txt");
        writeFileSync(secret, "api_key=abcdefghijklmnop");
        expect(stageLocalInputFile(secret)).toEqual(expect.objectContaining({ ok: false, error: "upload-local-path-secret-content" }));
    });

    it("preserves an existing destination on failed commit", () => {
        const destination = join(tempRoot(), "download.bin");
        writeFileSync(destination, "original");
        const stage = createLocalOutputStage(destination);
        expect(stage.ok).toBe(true);
        if (!stage.ok) return;
        writeFileSync(stage.stagedPath, "too-large");

        expect(commitLocalOutputStage(stage, { limitBytes: 3 })).toEqual(expect.objectContaining({ ok: false }));
        expect(readFileSync(destination, "utf8")).toBe("original");
        stage.cleanup();
    });

    it("rejects a replaced final destination link without changing its target", () => {
        const root = tempRoot();
        const external = join(root, "external.bin");
        const destination = join(root, "download.bin");
        const source = join(root, "remote.bin");
        writeFileSync(external, "external");
        writeFileSync(source, "downloaded");
        const stage = createLocalOutputStage(destination);
        expect(stage.ok).toBe(true);
        if (!stage.ok) return;
        const populated = populateLocalOutputStage(source, stage);
        expect(populated.ok).toBe(true);
        symlinkSync(external, destination);

        expect(commitLocalOutputStage(stage)).toEqual(expect.objectContaining({ ok: false, error: "download-local-path-symlink-rejected" }));
        expect(readFileSync(external, "utf8")).toBe("external");
        stage.cleanup();
    });

    it("restores only an expected persistent stage and enforces recording minimum size", () => {
        const root = tempRoot();
        const destination = join(root, "recording.mp4");
        const stageParent = join(root, "recordings");
        const stage = createLocalOutputStage(destination, {
            stageParent,
            stagePrefix: ".recording-stage-",
        });
        expect(stage.ok).toBe(true);
        if (!stage.ok) return;
        writeFileSync(stage.stagedPath, "");

        const restored = restoreLocalOutputStage(destination, stage.stagedPath, {
            stageParent,
            stagePrefix: ".recording-stage-",
        });
        expect(restored.ok).toBe(true);
        if (!restored.ok) return;
        expect(commitLocalOutputStage(restored, { minBytes: 1 })).toEqual(expect.objectContaining({
            ok: false,
            error: "download-local-path-stage-file-too-small",
        }));
        expect(existsSync(destination)).toBe(false);
        expect(restoreLocalOutputStage(destination, join(root, "foreign", "payload"), {
            stageParent,
            stagePrefix: ".recording-stage-",
        })).toEqual(expect.objectContaining({ ok: false, error: "download-local-path-stage-path-invalid" }));
        restored.cleanup();
        expect(existsSync(stage.stagedPath)).toBe(false);
    });
});
