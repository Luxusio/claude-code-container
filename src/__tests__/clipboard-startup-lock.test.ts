import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { processStartToken } from "../session-lock-liveness.js";
import { tryAcquireClipboardStartupLock, recoverDeadClipboardStartupLock, releaseClipboardStartupLock } from "../clipboard-startup-lock.js";
let root: string, path: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ccc-startup-lock-")); path = join(root, "clipboard.starting.v2"); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("clipboard startup ownership", () => {
    it("never reclaims a live owner because its timestamp is old", () => {
        const owner = tryAcquireClipboardStartupLock(path)!;
        try {
            utimesSync(path, new Date(0), new Date(0));
            const inode = statSync(path).ino;
            expect(tryAcquireClipboardStartupLock(path)).toBeNull();
            expect(recoverDeadClipboardStartupLock(path)).toBe(false);
            expect(statSync(path).ino).toBe(inode);
            expect(readFileSync(path, "utf8")).toBe(owner.content);
        } finally { releaseClipboardStartupLock(owner); }
    });
    it("release cannot delete a successor's inode or token", () => {
        const owner = tryAcquireClipboardStartupLock(path)!;
        unlinkSync(path);
        const successor = tryAcquireClipboardStartupLock(path)!;
        releaseClipboardStartupLock(owner);
        try { expect(readFileSync(path, "utf8")).toBe(successor.content); }
        finally { releaseClipboardStartupLock(successor); }
    });
    it.each(["", "startup-in-progress", "{}"])("does not infer death from unknown ownership %j", content => {
        writeFileSync(path, content);
        const before = statSync(path);
        expect(recoverDeadClipboardStartupLock(path)).toBe(false);
        expect(statSync(path).ino).toBe(before.ino);
        expect(readFileSync(path, "utf8")).toBe(content);
    });
    it("gives bounded actionable refusal for a leftover recovery guard", () => {
        mkdirSync(`${path}.recovery`);
        expect(() => recoverDeadClipboardStartupLock(path)).toThrow("inspect leftover ownership");
        expect(statSync(`${path}.recovery`).isDirectory()).toBe(true);
    });
    it("recovers after an actual recorded owner process is killed", async () => {
        const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        try {
            const content = JSON.stringify({ version: 2, pid: child.pid, startToken: processStartToken(child.pid!), nonce: "a".repeat(32) });
            writeFileSync(path, content);
            expect(recoverDeadClipboardStartupLock(path)).toBe(false);
            child.kill("SIGKILL");
            await exited;
            expect(recoverDeadClipboardStartupLock(path)).toBe(true);
            const next = tryAcquireClipboardStartupLock(path)!;
            expect(next).not.toBeNull();
            releaseClipboardStartupLock(next);
        } finally {
            if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
        }
    });
});
