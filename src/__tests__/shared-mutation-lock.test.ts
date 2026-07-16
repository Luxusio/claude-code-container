import { existsSync, linkSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { hostname, tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    copyFileAtomically as copyNestedFileAtomically,
    withSharedMutationLock as withNestedSharedMutationLock,
    withSharedMutationLockAsync,
    writeFileAtomically as writeNestedFileAtomically,
} from "../../device-lab-mcp/src/state/shared-mutation-lock.mjs";
import {
    copyFileAtomically as copyHostFileAtomically,
    withSharedMutationLock as withHostSharedMutationLock,
    withSharedMutationLockAsync as withHostSharedMutationLockAsync,
} from "../device-lab-shared-state.js";

const withSharedMutationLock = withNestedSharedMutationLock;

describe("device-lab shared mutation lock", () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    function lockPath() {
        const root = mkdtempSync(join(tmpdir(), "ccc-shared-mutation-lock-"));
        roots.push(root);
        return join(root, "state.mutation.lock");
    }

    function linkedBackendPath() {
        const root = mkdtempSync(join(tmpdir(), "ccc-linked-backend-"));
        const external = mkdtempSync(join(tmpdir(), "ccc-linked-backend-external-"));
        roots.push(root, external);
        const owner = join(root, ".ccc", "devices", "owners", "test-owner");
        const backend = join(owner, "android");
        writeFileSync(join(root, "source.txt"), "trusted-source");
        mkdirSync(owner, { recursive: true });
        symlinkSync(external, backend, process.platform === "win32" ? "junction" : "dir");
        return { root, external, backend, source: join(root, "source.txt") };
    }

    it("removes its token-fenced lock after the operation", () => {
        const file = lockPath();
        const result = withSharedMutationLock(file, () => {
            const lock = JSON.parse(readFileSync(file, "utf8"));
            expect(lock).toEqual(expect.objectContaining({ token: expect.any(String), pid: process.pid, host: hostname(), bootId: expect.any(String) }));
            return "done";
        });
        expect(result).toBe("done");
        expect(existsSync(file)).toBe(false);
    });

    it("recovers an old malformed lock without removing a live lock", () => {
        const malformed = lockPath();
        writeFileSync(malformed, "");
        const old = new Date(Date.now() - 5000);
        utimesSync(malformed, old, old);
        expect(withSharedMutationLock(malformed, () => "recovered", { waitMs: 1000, staleMs: 1000 })).toBe("recovered");
        expect(existsSync(malformed)).toBe(false);

        const live = lockPath();
        const record = { token: "live-token", pid: process.pid, host: hostname(), createdAt: new Date().toISOString() };
        writeFileSync(live, JSON.stringify(record));
        expect(() => withSharedMutationLock(live, () => "unexpected", { waitMs: 30, staleMs: 1 })).toThrow(/Timed out acquiring shared mutation lock/);
        expect(JSON.parse(readFileSync(live, "utf8"))).toEqual(record);
    });

    it("never restores a mismatched moved lock over a live successor", async () => {
        const file = lockPath();
        const stale = { token: "observed-stale-token", pid: 2147483647, host: hostname() };
        const movedMismatch = { token: "moved-racing-token", pid: process.pid, host: hostname() };
        const successor = { token: "live-successor-token", pid: process.pid, host: hostname() };
        writeFileSync(file, JSON.stringify(stale));
        const old = new Date(Date.now() - 5000);
        utimesSync(file, old, old);

        vi.resetModules();
        vi.doMock("fs", async (importOriginal) => {
            const actual = await importOriginal<typeof import("fs")>();
            return {
                ...actual,
                renameSync(source: string, destination: string) {
                    if (source === file && destination === `${file}.${stale.token}.stale`) {
                        writeFileSync(file, JSON.stringify(movedMismatch));
                        actual.renameSync(source, destination);
                        writeFileSync(file, JSON.stringify(successor));
                        return;
                    }
                    actual.renameSync(source, destination);
                },
            };
        });

        try {
            const racedModule = await import("../../device-lab-mcp/src/state/shared-mutation-lock.mjs?recovery-race");
            let entered = false;
            expect(() => racedModule.withSharedMutationLock(file, () => {
                entered = true;
            }, { waitMs: 30, staleMs: 1 })).toThrow(/Timed out acquiring shared mutation lock/);
            expect(entered).toBe(false);
            expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(successor);
        } finally {
            vi.doUnmock("fs");
            vi.resetModules();
        }
    });

    it.runIf(process.platform !== "win32")("does not follow linked lock records or use the target modification time", () => {
        for (const acquire of [withHostSharedMutationLock, withNestedSharedMutationLock]) {
            const file = lockPath();
            const target = `${file}.external`;
            const targetContents = JSON.stringify({ token: "external-token", pid: process.pid, host: hostname() });
            writeFileSync(target, targetContents);
            symlinkSync(target, file);
            const old = new Date(Date.now() - 5000);
            lutimesSync(file, old, old);

            expect(acquire(file, () => "recovered", { waitMs: 500, staleMs: 1000 })).toBe("recovered");
            expect(existsSync(file)).toBe(false);
            expect(readFileSync(target, "utf8")).toBe(targetContents);
        }
    });

    it("holds an async lock until the operation settles and serializes a waiter", async () => {
        const file = lockPath();
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
        const order: string[] = [];
        const first = withSharedMutationLockAsync(file, async () => {
            order.push("first-enter");
            entered();
            await gate;
            order.push("first-exit");
        }, { waitMs: 1000 });
        await firstEntered;
        expect(existsSync(file)).toBe(true);

        const second = withSharedMutationLockAsync(file, async () => {
            order.push("second-enter");
        }, { waitMs: 1000 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(order).toEqual(["first-enter"]);

        release();
        await Promise.all([first, second]);
        expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
        expect(existsSync(file)).toBe(false);
    });

    it("releases an async lock when the operation rejects", async () => {
        const file = lockPath();
        await expect(withSharedMutationLockAsync(file, async () => {
            throw new Error("operation failed");
        })).rejects.toThrow("operation failed");
        expect(existsSync(file)).toBe(false);
    });

    it.runIf(process.platform !== "win32")("atomically replaces a linked copy destination without modifying its target", () => {
        for (const copy of [copyHostFileAtomically, copyNestedFileAtomically]) {
            const file = lockPath();
            const root = dirname(file);
            const source = join(root, `source-${Math.random()}`);
            const destination = join(root, `destination-${Math.random()}`);
            const target = join(root, `external-${Math.random()}`);
            writeFileSync(source, "trusted-source");
            writeFileSync(target, "external-target");
            symlinkSync(target, destination);

            expect(copy(source, destination, { prefix: "copy-test", limitBytes: 64 })).toBe(14);
            expect(readFileSync(destination, "utf8")).toBe("trusted-source");
            expect(readFileSync(target, "utf8")).toBe("external-target");
            expect(readdirSync(root).some((name) => name.includes(".tmp"))).toBe(false);
        }
    });

    it.runIf(process.platform !== "win32")("rejects linked and multiply-linked copy sources", () => {
        for (const copy of [copyHostFileAtomically, copyNestedFileAtomically]) {
            const file = lockPath();
            const root = dirname(file);
            const source = join(root, `source-${Math.random()}`);
            const linked = join(root, `linked-${Math.random()}`);
            const hardLinked = join(root, `hard-linked-${Math.random()}`);
            const destination = join(root, `destination-${Math.random()}`);
            writeFileSync(source, "trusted-source");
            writeFileSync(destination, "preserved");
            symlinkSync(source, linked);
            expect(() => copy(linked, destination, { prefix: "copy-test", limitBytes: 64 })).toThrow("copy-test-state-invalid");
            expect(readFileSync(destination, "utf8")).toBe("preserved");
            linkSync(source, hardLinked);
            expect(() => copy(source, destination, { prefix: "copy-test", limitBytes: 64 })).toThrow("copy-test-state-invalid");
            expect(readFileSync(destination, "utf8")).toBe("preserved");
        }
    });

    it.runIf(process.platform === "linux")("bounds streamed copies even when the source reports an initial size of zero", () => {
        for (const copy of [copyHostFileAtomically, copyNestedFileAtomically]) {
            const destination = lockPath();
            writeFileSync(destination, "preserved");
            expect(() => copy("/proc/self/status", destination, { prefix: "copy-test", limitBytes: 32 })).toThrow("copy-test-file-too-large");
            expect(readFileSync(destination, "utf8")).toBe("preserved");
        }
    });

    it("returns a stable error code when async lock acquisition times out", async () => {
        const file = lockPath();
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
        const first = withSharedMutationLockAsync(file, async () => {
            entered();
            await gate;
        }, { waitMs: 1000 });
        await firstEntered;

        await expect(withSharedMutationLockAsync(file, () => undefined, { waitMs: 20 })).rejects.toMatchObject({
            code: "shared-mutation-lock-timeout",
        });
        release();
        await first;
        expect(existsSync(file)).toBe(false);
    });

    it("revalidates TS lock ancestors after acquisition before entering the operation", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-ts-lock-acquire-replacement-"));
        roots.push(root);
        const backend = join(root, ".ccc", "devices", "owners", "test-owner", "android");
        const displaced = `${backend}.displaced`;
        const file = join(backend, "devices.mutation.lock");
        mkdirSync(backend, { recursive: true });

        let acquiredFd: number | null = null;
        vi.resetModules();
        vi.doMock("fs", async (importOriginal) => {
            const actual = await importOriginal<typeof import("fs")>();
            return {
                ...actual,
                openSync(path: import("fs").PathLike, flags: import("fs").OpenMode, mode?: import("fs").Mode) {
                    const fd = actual.openSync(path, flags, mode);
                    if (path === file && flags === "wx") acquiredFd = fd;
                    return fd;
                },
                closeSync(fd: number) {
                    actual.closeSync(fd);
                    if (fd === acquiredFd) {
                        acquiredFd = null;
                        actual.renameSync(backend, displaced);
                        actual.mkdirSync(backend);
                    }
                },
            };
        });

        try {
            const racedModule = await import("../device-lab-shared-state.js?ts-lock-acquire-replacement");
            let entered = false;
            expect(() => racedModule.withSharedMutationLock(file, () => {
                entered = true;
            })).toThrow(expect.objectContaining({ code: "device-lab-state-directory-invalid" }));
            expect(entered).toBe(false);
            expect(readdirSync(backend)).toEqual([]);
            expect(existsSync(join(displaced, "devices.mutation.lock"))).toBe(true);
        } finally {
            vi.doUnmock("fs");
            vi.resetModules();
        }
    });

    it("does not release a TS lock token through a replaced ancestor namespace", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-ts-lock-release-replacement-"));
        roots.push(root);
        const backend = join(root, ".ccc", "devices", "owners", "test-owner", "android");
        const displaced = `${backend}.displaced`;
        const file = join(backend, "devices.mutation.lock");
        mkdirSync(backend, { recursive: true });
        const successor = { token: "successor-token", pid: process.pid, host: hostname() };

        await expect(withHostSharedMutationLockAsync(file, async () => {
            renameSync(backend, displaced);
            mkdirSync(backend);
            writeFileSync(file, JSON.stringify(successor));
        })).rejects.toMatchObject({ code: "device-lab-state-directory-invalid" });

        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(successor);
        expect(existsSync(join(displaced, "devices.mutation.lock"))).toBe(true);
    });

    it("rejects an owner-writable backend link before lock, stage, or final writes", async () => {
        const operations = [
            ({ backend }: ReturnType<typeof linkedBackendPath>) => writeNestedFileAtomically(join(backend, "devices.json"), "{}"),
            ({ backend, source }: ReturnType<typeof linkedBackendPath>) => copyNestedFileAtomically(source, join(backend, "devices.json"), { prefix: "linked-backend", limitBytes: 64 }),
            ({ backend }: ReturnType<typeof linkedBackendPath>) => withNestedSharedMutationLock(join(backend, "devices.mutation.lock"), () => "unexpected"),
        ];

        for (const operation of operations) {
            const paths = linkedBackendPath();
            expect(() => operation(paths)).toThrow(expect.objectContaining({ code: "device-lab-state-directory-invalid" }));
            expect(readdirSync(paths.external)).toEqual([]);
        }

        const paths = linkedBackendPath();
        await expect(withSharedMutationLockAsync(join(paths.backend, "devices.mutation.lock"), async () => "unexpected"))
            .rejects.toMatchObject({ code: "device-lab-state-directory-invalid" });
        expect(readdirSync(paths.external)).toEqual([]);
    });

    it("detects a backend directory replacement between staging and rename", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-backend-replacement-"));
        const external = mkdtempSync(join(tmpdir(), "ccc-backend-replacement-external-"));
        roots.push(root, external);
        const backend = join(root, ".ccc", "devices", "owners", "test-owner", "android");
        const destination = join(backend, "devices.json");
        mkdirSync(backend, { recursive: true });

        vi.resetModules();
        vi.doMock("fs", async (importOriginal) => {
            const actual = await importOriginal<typeof import("fs")>();
            return {
                ...actual,
                writeFileSync(file: import("fs").PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: import("fs").WriteFileOptions) {
                    actual.writeFileSync(file, data, options);
                    if (typeof file === "string" && file.startsWith(`${destination}.`) && file.endsWith(".tmp")) {
                        actual.rmSync(backend, { recursive: true, force: true });
                        actual.symlinkSync(external, backend, process.platform === "win32" ? "junction" : "dir");
                    }
                },
            };
        });

        try {
            const racedModule = await import("../../device-lab-mcp/src/state/shared-mutation-lock.mjs?backend-replacement-race");
            expect(() => racedModule.writeFileAtomically(destination, "escaped"))
                .toThrow(expect.objectContaining({ code: "device-lab-state-directory-invalid" }));
            expect(readdirSync(external)).toEqual([]);
        } finally {
            vi.doUnmock("fs");
            vi.resetModules();
        }
    });
});
