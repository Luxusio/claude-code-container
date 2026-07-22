import { randomUUID } from "crypto";
import { mkdtempSync, rmdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    ownerStateDir,
    withOwnerDeviceOperation,
    withOwnerDeviceOperations,
} from "../../device-lab-mcp/src/state/device-store.mjs";

describe("owner device operation lock", () => {
    const backends: string[] = [];
    let originalHome: string | undefined;
    let testHome: string;

    beforeEach(() => {
        originalHome = process.env.HOME;
        testHome = mkdtempSync(join(tmpdir(), "ccc-operation-lock-home-"));
        process.env.HOME = testHome;
    });

    afterEach(() => {
        for (const backend of backends.splice(0)) {
            const backendDir = ownerStateDir(backend);
            rmSync(backendDir, { recursive: true, force: true });
            let current = dirname(backendDir);
            for (let depth = 0; depth < 3; depth += 1) {
                try { rmdirSync(current); } catch { break; }
                current = dirname(current);
            }
        }
        rmSync(testHome, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    });

    function target() {
        const backend = `operation-lock-test-${randomUUID()}`;
        backends.push(backend);
        return { backend, deviceId: `device-${randomUUID()}` };
    }

    it("allows an awaited same-device nested operation without reacquiring the file lock", async () => {
        const { backend, deviceId } = target();
        const order: string[] = [];

        await withOwnerDeviceOperation(backend, deviceId, async () => {
            order.push("outer-enter");
            await withOwnerDeviceOperation(backend, deviceId, async () => {
                order.push("inner");
            }, { waitMs: 20 });
            order.push("outer-exit");
        });

        expect(order).toEqual(["outer-enter", "inner", "outer-exit"]);
    });

    it("does not let a detached descendant reuse an expired operation context", async () => {
        const { backend, deviceId } = target();
        let releaseDetached!: () => void;
        let releaseHolder!: () => void;
        let holderEntered!: () => void;
        let detachedEntered = false;
        const detachedGate = new Promise<void>((resolve) => { releaseDetached = resolve; });
        const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
        const holderReady = new Promise<void>((resolve) => { holderEntered = resolve; });
        let detachedTask!: Promise<void>;

        await withOwnerDeviceOperation(backend, deviceId, async () => {
            detachedTask = (async () => {
                await detachedGate;
                await withOwnerDeviceOperation(backend, deviceId, async () => {
                    detachedEntered = true;
                }, { waitMs: 1000 });
            })();
        });

        const holder = withOwnerDeviceOperation(backend, deviceId, async () => {
            holderEntered();
            await holderGate;
        });
        await holderReady;
        releaseDetached();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(detachedEntered).toBe(false);

        releaseHolder();
        await Promise.all([holder, detachedTask]);
        expect(detachedEntered).toBe(true);
    });

    it("sorts multi-device locks so inverse requests serialize without deadlock", async () => {
        const { backend } = target();
        const first = `a-${randomUUID()}`;
        const second = `b-${randomUUID()}`;
        let active = 0;
        let maxActive = 0;
        const run = async (ids: string[]) => withOwnerDeviceOperations(backend, ids, async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 30));
            active -= 1;
        });

        await Promise.all([
            run([second, first]),
            run([first, second, first]),
        ]);

        expect(maxActive).toBe(1);
    });
});
