import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    boundedProviderCommandRunnerScript,
    defaultProviderCommandRunner,
    defaultProviderCommandRunnerAsync,
    providerCommandSpawn,
    runBrokerBackendChild,
    terminateBrokerSpawnedProcessTree,
    windowsHiddenVbsLauncherScript,
} from "../device-lab-broker.js";

const roots: string[] = [];

function temporaryRoot() {
    const root = mkdtempSync(join(tmpdir(), "ccc-broker-process-tree-"));
    roots.push(root);
    return root;
}

function descendantProbeScript(readyFile: string) {
    const childScript = [
        "(async () => {",
        "const { writeFileSync } = await import('node:fs');",
        `writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
        "setInterval(() => undefined, 1000);",
        "})().catch((error) => { console.error(error); process.exit(1); });",
    ].join("\n");
    return [
        "(async () => {",
        "const { spawn } = await import('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "setInterval(() => undefined, 1000);",
        "})().catch((error) => { console.error(error); process.exit(1); });",
    ].join("\n");
}

function stdioHoldingDescendantScript(readyFile: string) {
    const childScript = [
        "(async () => {",
        "const { writeFileSync } = await import('node:fs');",
        `writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
        "setInterval(() => undefined, 1000);",
        "})().catch((error) => { console.error(error); process.exit(1); });",
    ].join("\n");
    return [
        "const { spawn } = await import('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'inherit' });`,
        "setInterval(() => undefined, 1000);",
    ].join("\n");
}

function outputOverflowDescendantScript(readyFile: string, outputBytes: number) {
    const childScript = [
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
        "setInterval(() => undefined, 1000);",
    ].join("\n");
    return [
        "(async () => {",
        "const { existsSync } = await import('node:fs');",
        "const { spawn } = await import('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        `while (!existsSync(${JSON.stringify(readyFile)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
        `process.stdout.write('x'.repeat(${outputBytes}));`,
        "setInterval(() => undefined, 1000);",
        "})().catch((error) => { console.error(error); process.exit(1); });",
    ].join("\n");
}

function processIsRunning(pid: number) {
    try {
        process.kill(pid, 0);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (process.platform !== "win32") {
        const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
        if (status.status !== 0 || /^Z/.test(status.stdout.trim())) return false;
    }
    return true;
}

async function expectProcessTreeExit(readyFile: string) {
    expect(existsSync(readyFile), "descendant never reached its ready point before the timeout").toBe(true);
    const pid = Number(readFileSync(readyFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 5000;
    while (processIsRunning(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(processIsRunning(pid), `descendant process ${pid} survived timeout cleanup`).toBe(false);
}

function terminateTestProcess(pid: number) {
    if (!processIsRunning(pid)) return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        return;
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* best-effort test cleanup */ }
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("device broker timed-out process tree cleanup", () => {
    it("never bypasses worker process identity fencing with a direct child kill", () => {
        const script = boundedProviderCommandRunnerScript();
        expect(script).toContain("terminateTree(child.pid, spawnedIdentity)");
        expect(script).toContain("$Descendants[$Index].Kill()");
        expect(script).toContain("$Root.Kill()");
        expect(script).not.toContain("child.kill(");
        expect(script).not.toContain("taskkill");
        expect(runBrokerBackendChild.toString()).not.toContain("child.kill(");
    });

    it("rejects percent expansion and line breaks in Windows command-shell arguments", () => {
        for (const unsafe of ["%PATH%", "safe\r\nwhoami", "safe\nwhoami"]) {
            expect(() => providerCommandSpawn({
                mode: "exec",
                provider: "test-provider",
                executable: "C:\\tools\\provider.cmd",
                args: [unsafe],
            }, "win32"), unsafe).toThrow(/windows-command-argument-(percent-expansion|newline)-rejected/);
            expect(() => windowsHiddenVbsLauncherScript("C:\\tools\\provider.exe", [unsafe]), unsafe)
                .toThrow(/windows-command-argument-(percent-expansion|newline)-rejected/);
        }
    });

    it("targets the POSIX process group instead of only the wrapper pid", () => {
        const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
        const cleanup = terminateBrokerSpawnedProcessTree(321, {
            platform: "linux",
            kill: (pid, signal) => signals.push({ pid, signal }),
        });

        expect(cleanup).toMatchObject({ attempted: true, ok: true, pid: 321, platform: "linux" });
        expect(signals).toEqual([{ pid: -321, signal: "SIGKILL" }]);
    });

    it("requests recursive Windows tree termination", () => {
        const pids: number[] = [];
        const cleanup = terminateBrokerSpawnedProcessTree(654, {
            platform: "win32",
            terminateWindowsTree: (pid) => {
                pids.push(pid);
                return { attempted: true, ok: true };
            },
        });

        expect(cleanup).toMatchObject({ attempted: true, ok: true, pid: 654, platform: "win32" });
        expect(pids).toEqual([654]);
    });

    it("passes the verified Windows start token into the default tree terminator", () => {
        const source = terminateBrokerSpawnedProcessTree.toString();
        expect(source).toContain("options.expectedIdentity?.startToken");
        expect(source).not.toContain("terminateWindowsProcessTree(value, undefined, true)");
    });

    it("refuses process-tree termination when the spawned process identity changed", () => {
        const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
        const expectedIdentity = { pid: 777, startToken: "linux:100", commandHash: "a".repeat(64) };
        const cleanup = terminateBrokerSpawnedProcessTree(777, {
            platform: "linux",
            expectedIdentity,
            requireIdentity: true,
            readIdentity: () => ({ ...expectedIdentity, startToken: "linux:200" }),
            kill: (pid, signal) => signals.push({ pid, signal }),
        });

        expect(cleanup).toMatchObject({ attempted: false, ok: false, pid: 777, error: "spawned-process-identity-mismatch" });
        expect(signals).toEqual([]);
    });

    it("terminates a process tree only after matching the spawned process identity", () => {
        const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
        const expectedIdentity = { pid: 778, startToken: "linux:100", commandHash: "b".repeat(64) };
        const cleanup = terminateBrokerSpawnedProcessTree(778, {
            platform: "linux",
            expectedIdentity,
            requireIdentity: true,
            readIdentity: () => expectedIdentity,
            kill: (pid, signal) => signals.push({ pid, signal }),
        });

        expect(cleanup).toMatchObject({ attempted: true, ok: true, pid: 778 });
        expect(signals).toEqual([{ pid: -778, signal: "SIGKILL" }]);
    });

    it("prevents a backend descendant from performing late work after timeout", async () => {
        const root = temporaryRoot();
        const readyFile = join(root, "backend-descendant.ready");
        const result = await runBrokerBackendChild(descendantProbeScript(readyFile), "", {
            cwd: root,
            timeoutMs: 3000,
            outputLimit: 1024,
        });

        expect(result).toMatchObject({ timedOut: true, cleanup: { attempted: true, ok: true } });
        await expectProcessTreeExit(readyFile);
    });

    it("settles backend execution and reports cleanup failure when descendants retain stdio", async () => {
        const root = temporaryRoot();
        const readyFile = join(root, "backend-cleanup-failure.ready");
        const startedAt = Date.now();
        const result = await runBrokerBackendChild(stdioHoldingDescendantScript(readyFile), "", {
            cwd: root,
            timeoutMs: 1000,
            outputLimit: 1024,
            cleanupGraceMs: 50,
            terminateTree: (pid) => ({
                attempted: true,
                ok: false,
                pid: pid || 0,
                signal: "SIGKILL",
                platform: process.platform,
                error: "injected-tree-kill-failure",
            }),
        });
        const parentPid = Number(result.cleanup?.pid);
        let descendantPid = 0;
        try {
            expect(Date.now() - startedAt).toBeLessThan(5000);
            expect(result).toMatchObject({
                timedOut: true,
                status: null,
                cleanup: { attempted: true, ok: false, error: "injected-tree-kill-failure" },
            });
            expect(result.error?.message).toContain("process-tree cleanup failed: injected-tree-kill-failure");
            expect(existsSync(readyFile)).toBe(true);
            descendantPid = Number(readFileSync(readyFile, "utf8"));
        } finally {
            if (Number.isInteger(parentPid) && parentPid > 0) terminateBrokerSpawnedProcessTree(parentPid);
            if (Number.isInteger(descendantPid) && descendantPid > 0) terminateTestProcess(descendantPid);
        }
    });

    it("prevents a provider descendant from surviving timeout cleanup on every platform", async () => {
        const root = temporaryRoot();
        const readyFile = join(root, "provider-descendant.ready");
        const result = defaultProviderCommandRunner({
            mode: "exec",
            provider: "test-provider",
            executable: process.execPath,
            args: ["-e", descendantProbeScript(readyFile)],
            cwd: root,
        }, { timeoutMs: 3000, outputLimit: 1024 });

        expect(result).toMatchObject({ timedOut: true, cleanup: { attempted: true, ok: true } });
        await expectProcessTreeExit(readyFile);
    });

    it("cleans the live provider tree when the Worker wrapper itself times out", async () => {
        const root = temporaryRoot();
        const readyFile = join(root, "provider-wrapper-timeout.ready");
        const result = defaultProviderCommandRunner({
            mode: "exec",
            provider: "test-provider",
            executable: process.execPath,
            args: ["-e", descendantProbeScript(readyFile)],
            cwd: root,
        }, {
            timeoutMs: 30000,
            wrapperTimeoutMs: 3000,
            outputLimit: 1024,
        });

        expect(result).toMatchObject({
            timedOut: true,
            error: "device-lab provider wrapper timed out after 3000ms",
            cleanup: { attempted: true, ok: true },
        });
        await expectProcessTreeExit(readyFile);
    });

    it("identity-fences asynchronous provider cleanup when the Worker wrapper times out", async () => {
        const root = temporaryRoot();
        const readyFile = join(root, "async-provider-wrapper-timeout.ready");
        const result = await defaultProviderCommandRunnerAsync({
            mode: "exec",
            provider: "test-provider",
            executable: process.execPath,
            args: ["-e", descendantProbeScript(readyFile)],
            cwd: root,
        }, {
            timeoutMs: 30000,
            wrapperTimeoutMs: 3000,
            outputLimit: 1024,
        });

        expect(result).toMatchObject({
            timedOut: true,
            error: "device-lab provider wrapper timed out after 3000ms",
            cleanup: { attempted: true, ok: true },
        });
        await expectProcessTreeExit(readyFile);
    });

    it("terminates provider descendants when bounded output overflows", async () => {
        const root = temporaryRoot();
        const readyFile = join(root, "provider-output-overflow.ready");
        const result = defaultProviderCommandRunner({
            mode: "exec",
            provider: "test-provider",
            executable: process.execPath,
            args: ["-e", outputOverflowDescendantScript(readyFile, 64 * 1024)],
            cwd: root,
        }, { timeoutMs: 10000, outputLimit: 1024 });

        expect(result).toMatchObject({
            timedOut: false,
            cleanup: { attempted: true, ok: true },
        });
        expect(result.error).toContain("ENOBUFS");
        expect(Buffer.byteLength(result.stdout || "")).toBeLessThanOrEqual(1024);
        await expectProcessTreeExit(readyFile);
    });

    it("carries worst-case JSON-escaped output through the bounded shared transport", () => {
        const outputBytes = 30000;
        const result = defaultProviderCommandRunner({
            mode: "exec",
            provider: "test-provider",
            executable: process.execPath,
            args: ["-e", `process.stdout.write('\\u0000'.repeat(${outputBytes}))`],
        }, { timeoutMs: 10000, outputLimit: outputBytes });

        expect(result).toMatchObject({ status: 0, timedOut: false });
        expect(result.error).toBeUndefined();
        expect(Buffer.byteLength(result.stdout || "")).toBe(outputBytes);
        expect(result.stdout).toBe("\u0000".repeat(outputBytes));
    });
});
