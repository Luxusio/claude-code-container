import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { afterEach, describe, expect, it } from "vitest";

function cleanupProcess(home: string, target: string, order: string, label: string): Promise<number | null> {
    const script = [
        `import { quarantineAndRemoveDirectory } from ${JSON.stringify(new URL("../device-lab-safe-cleanup.js", import.meta.url).href.replace("/src/", "/dist/").replace("/__tests__", ""))};`,
        `import { appendFileSync } from "fs";`,
        `const sleep = new Int32Array(new SharedArrayBuffer(4));`,
        `quarantineAndRemoveDirectory(${JSON.stringify(target)}, () => {}, { beforeRemove() {`,
        `  appendFileSync(${JSON.stringify(order)}, ${JSON.stringify(label.toUpperCase())});`,
        `  Atomics.wait(sleep, 0, 0, 250);`,
        `  appendFileSync(${JSON.stringify(order)}, ${JSON.stringify(label.toLowerCase())});`,
        `} });`,
    ].join("\n");
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
            env: { ...process.env, HOME: home },
            stdio: "ignore",
        });
        child.once("error", reject);
        child.once("close", resolve);
    });
}

describe.runIf(process.platform !== "win32")("safe cleanup cross-process lock", () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("serializes quarantine through final deletion across CCC processes", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-safe-cleanup-lock-"));
        roots.push(root);
        const home = join(root, "home");
        const firstTarget = join(root, "first");
        const secondTarget = join(root, "second");
        const order = join(root, "order.txt");
        mkdirSync(home);
        mkdirSync(firstTarget);
        mkdirSync(secondTarget);
        writeFileSync(join(firstTarget, "owned.txt"), "first");
        writeFileSync(join(secondTarget, "owned.txt"), "second");

        const first = cleanupProcess(home, firstTarget, order, "a");
        await new Promise((resolve) => setTimeout(resolve, 50));
        const second = cleanupProcess(home, secondTarget, order, "b");

        await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
        // What the lock guarantees is that the two critical sections do not interleave — not which
        // process wins the race for it. The 50ms head start makes "AaBb" the usual outcome, but it
        // is a head start, not a barrier: a full-suite run measured "BbAa" when spawn latency
        // swallowed the 50ms. Pinning one winner made a lock that had just done its job look
        // broken. Interleaving ("ABab", "ABba", "BAab", "BAba") is the failure, and only that.
        expect(["AaBb", "BbAa"]).toContain(readFileSync(order, "utf8"));
    });
});
