import { existsSync, linkSync, lutimesSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { hostname, tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    copyFileAtomically as copyNestedFileAtomically,
    withSharedMutationLock as withNestedSharedMutationLock,
    withSharedMutationLockAsync,
} from "../../device-lab-mcp/src/state/shared-mutation-lock.mjs";
import { copyFileAtomically as copyHostFileAtomically, withSharedMutationLock as withHostSharedMutationLock } from "../device-lab-shared-state.js";

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
});
