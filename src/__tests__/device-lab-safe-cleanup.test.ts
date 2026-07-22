import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { quarantineAndRemoveDirectory, type QuarantinedCleanupError } from "../device-lab-safe-cleanup.js";

describe("quarantineAndRemoveDirectory", () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("renames before recursively removing the validated directory", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-safe-cleanup-"));
        roots.push(root);
        const target = join(root, "device");
        mkdirSync(target);
        writeFileSync(join(target, "artifact.txt"), "artifact");
        const validated: string[] = [];

        const result = quarantineAndRemoveDirectory(target, (path) => validated.push(path));

        expect(existsSync(target)).toBe(false);
        expect(existsSync(result.quarantineRoot)).toBe(false);
        expect(validated[0]).toBe(target);
        expect(basename(validated[1])).toMatch(/^\.ccc-cleanup-[a-f0-9]{32}$/);
        expect(basename(validated[2])).toBe("device");
    });

    it.runIf(process.platform !== "win32")("preserves evidence and refuses a post-rename symlink replacement", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-safe-cleanup-race-"));
        const external = mkdtempSync(join(tmpdir(), "ccc-safe-cleanup-external-"));
        roots.push(root, external);
        const target = join(root, "device");
        const displaced = join(root, "displaced");
        mkdirSync(target);
        writeFileSync(join(target, "artifact.txt"), "artifact");
        writeFileSync(join(external, "victim.txt"), "preserved");

        let caught: QuarantinedCleanupError | null = null;
        try {
            quarantineAndRemoveDirectory(target, (path) => {
                if (basename(path) === "device" && path !== target) {
                    renameSync(path, displaced);
                    symlinkSync(external, path, "dir");
                }
            });
        } catch (error) {
            caught = error as QuarantinedCleanupError;
        }

        expect(caught?.message).toBe("quarantined-cleanup-target-invalid");
        expect(caught?.quarantineRoot).toBeTruthy();
        expect(existsSync(caught!.quarantineRoot!)).toBe(true);
        expect(readFileSync(join(external, "victim.txt"), "utf8")).toBe("preserved");
        expect(readFileSync(join(displaced, "artifact.txt"), "utf8")).toBe("artifact");
    });

    it("refuses to delete a real directory substituted immediately before rename", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-safe-cleanup-real-race-"));
        roots.push(root);
        const target = join(root, "device");
        const displaced = join(root, "displaced");
        mkdirSync(target);
        writeFileSync(join(target, "owned.txt"), "owned");
        let caught: QuarantinedCleanupError | null = null;
        try {
            quarantineAndRemoveDirectory(target, () => {}, {
                rename(source, destination) {
                    renameSync(source, displaced);
                    mkdirSync(source);
                    writeFileSync(join(source, "foreign.txt"), "preserved");
                    renameSync(source, destination);
                },
            });
        } catch (error) {
            caught = error as QuarantinedCleanupError;
        }

        expect(caught?.message).toBe("quarantined-cleanup-target-invalid");
        expect(caught?.quarantineRoot).toBeTruthy();
        expect(readFileSync(join(caught!.quarantineRoot!, "foreign.txt"), "utf8")).toBe("preserved");
        expect(readFileSync(join(displaced, "owned.txt"), "utf8")).toBe("owned");
    });
});
