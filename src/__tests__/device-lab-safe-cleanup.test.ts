import { directorySymlink } from "./helpers/file-symlink-fixture.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quarantineAndRemoveDirectory, type QuarantinedCleanupError } from "@ccc/device-lab/device-lab-safe-cleanup.js";

const windowsFs = vi.hoisted(() => ({ enabled: false, target: "", fault: "none", targetOpens: 0, live: new Map<number, { path: string; fresh: boolean }>() }));
vi.mock("fs", async importOriginal => {
    const actual = await importOriginal<typeof import("fs")>();
    const metadata = (stat: any, pathname: boolean, fresh = false) => {
        const bigint = typeof stat.ino === "bigint";
        const inode = BigInt(stat.ino) + 2n ** 60n + (fresh && windowsFs.fault === "inode" ? 1n : 0n);
        const volume = 574283787n + (fresh && windowsFs.fault === "volume" ? 1n : 0n);
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: bigint ? (pathname ? 0n : volume) : Number(pathname ? 0n : volume), ino: bigint ? inode : Number(inode) });
    };
    return {
        ...actual,
        openSync: (...args: Parameters<typeof actual.openSync>) => {
            const fresh = windowsFs.enabled && String(args[0]) === windowsFs.target && ++windowsFs.targetOpens >= 2;
            if (fresh && windowsFs.fault === "open") throw Object.assign(new Error("fresh open denied"), { code: "EACCES" });
            const fd = actual.openSync(...args);
            if (windowsFs.enabled) windowsFs.live.set(fd, { path: String(args[0]), fresh });
            return fd;
        },
        fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
            const stat = actual.fstatSync(...args);
            return windowsFs.enabled ? metadata(stat, false, windowsFs.live.get(args[0])?.fresh) : stat;
        },
        lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
            const stat = actual.lstatSync(...args);
            if (!windowsFs.enabled) return stat;
            const observed = metadata(stat, true);
            if (String(args[0]) === windowsFs.target && windowsFs.targetOpens >= 2 && windowsFs.fault === "path-swap") observed.ino = typeof observed.ino === "bigint" ? observed.ino + 1n : observed.ino + 1;
            return observed;
        },
        closeSync: (fd: number) => { actual.closeSync(fd); windowsFs.live.delete(fd); },
    };
});

describe("quarantineAndRemoveDirectory", () => {
    const roots: string[] = [];

    afterEach(() => {
        windowsFs.enabled = false;
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("removes a quarantined nested directory with Windows dev0 paths and exact bigint descriptors", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-safe-cleanup-windows-proof-"));
        roots.push(root);
        const target = join(root, "device");
        mkdirSync(join(target, "nested"), { recursive: true });
        writeFileSync(join(target, "nested", "owned.txt"), "owned");
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.assign(windowsFs, { enabled: true, target, fault: "none", targetOpens: 0 });
        Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
        try {
            const result = quarantineAndRemoveDirectory(target, () => {});
            expect(existsSync(target)).toBe(false);
            expect(existsSync(result.quarantineRoot)).toBe(false);
            expect(windowsFs.live.size).toBe(0);
        } finally { windowsFs.enabled = false; Object.defineProperty(process, "platform", platform); }
    });

    it.each(["volume", "inode", "open", "path-swap"])("retains the target when fresh Windows directory proof fails (%s)", fault => {
        const root = mkdtempSync(join(tmpdir(), "ccc-safe-cleanup-windows-refusal-"));
        roots.push(root);
        const target = join(root, "device");
        mkdirSync(target);
        writeFileSync(join(target, "owned.txt"), "preserved");
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.assign(windowsFs, { enabled: true, target, fault, targetOpens: 0 });
        Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
        try {
            expect(() => quarantineAndRemoveDirectory(target, () => {})).toThrow();
            expect(readFileSync(join(target, "owned.txt"), "utf8")).toBe("preserved");
            expect(readdirSync(root)).toEqual(["device"]);
            expect(windowsFs.live.size).toBe(0);
        } finally { windowsFs.enabled = false; Object.defineProperty(process, "platform", platform); }
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
                    directorySymlink(external, path);
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
                    writeFileSync(join(String(source), "foreign.txt"), "preserved");
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

    it("anchors recursive removal to the opened directory after a final-path substitution", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-safe-cleanup-fd-race-"));
        roots.push(root);
        const target = join(root, "device");
        const displaced = join(root, "displaced");
        mkdirSync(target);
        writeFileSync(join(target, "owned.txt"), "owned");
        let foreignRoot = "";
        let caught: QuarantinedCleanupError | null = null;
        try {
            quarantineAndRemoveDirectory(target, () => {}, {
                beforeRemove(quarantineRoot) {
                    foreignRoot = quarantineRoot;
                    renameSync(quarantineRoot, displaced);
                    mkdirSync(quarantineRoot);
                    writeFileSync(join(quarantineRoot, "foreign.txt"), "preserved");
                },
            });
        } catch (error) {
            caught = error as QuarantinedCleanupError;
        }

        expect(caught?.message).toBe("quarantined-cleanup-target-invalid");
        expect(readFileSync(join(foreignRoot, "foreign.txt"), "utf8")).toBe("preserved");
        expect(readFileSync(join(displaced, "owned.txt"), "utf8")).toBe("owned");
    });

    it("preserves a substituted child detected after enumeration", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-safe-cleanup-entry-race-"));
        roots.push(root);
        const target = join(root, "device");
        const displaced = join(root, "owned.txt");
        mkdirSync(target);
        writeFileSync(join(target, "artifact.txt"), "owned");
        let caught: QuarantinedCleanupError | null = null;
        try {
            quarantineAndRemoveDirectory(target, () => {}, {
                beforeRemoveEntry(entry) {
                    renameSync(entry, displaced);
                    writeFileSync(entry, "foreign");
                },
            });
        } catch (error) {
            caught = error as QuarantinedCleanupError;
        }

        expect(caught?.message).toBe("quarantined-cleanup-target-invalid");
        expect(readFileSync(displaced, "utf8")).toBe("owned");
        const staged = readdirSync(caught!.quarantineRoot!).find((entry) => entry.startsWith(".ccc-entry-"));
        expect(staged).toBeTruthy();
        expect(readFileSync(join(caught!.quarantineRoot!, staged!), "utf8")).toBe("foreign");
    });

    it("preserves a child substituted immediately before deletion", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-safe-cleanup-delete-race-"));
        roots.push(root);
        const target = join(root, "device");
        const displaced = join(root, "owned.txt");
        mkdirSync(target);
        writeFileSync(join(target, "artifact.txt"), "owned");
        let foreignName = "";
        let caught: QuarantinedCleanupError | null = null;
        try {
            quarantineAndRemoveDirectory(target, () => {}, {
                beforeDeleteEntry(entry) {
                    foreignName = basename(entry);
                    renameSync(entry, displaced);
                    writeFileSync(entry, "foreign");
                },
            });
        } catch (error) {
            caught = error as QuarantinedCleanupError;
        }

        expect(caught?.message).toBe("quarantined-cleanup-target-invalid");
        expect(readFileSync(displaced, "utf8")).toBe("owned");
        expect(readFileSync(join(caught!.quarantineRoot!, foreignName), "utf8")).toBe("foreign");
    });

    it("preserves an empty directory substituted immediately before deletion", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-safe-cleanup-root-delete-race-"));
        roots.push(root);
        const target = join(root, "device");
        const displaced = join(root, "owned-empty");
        mkdirSync(target);
        let foreign = "";
        let caught: QuarantinedCleanupError | null = null;
        try {
            quarantineAndRemoveDirectory(target, () => {}, {
                beforeDeleteRoot(entry) {
                    foreign = entry;
                    renameSync(entry, displaced);
                    mkdirSync(entry);
                },
            });
        } catch (error) {
            caught = error as QuarantinedCleanupError;
        }

        expect(caught?.message).toBe("quarantined-cleanup-target-invalid");
        expect(existsSync(displaced)).toBe(true);
        expect(existsSync(foreign)).toBe(true);
    });
});
