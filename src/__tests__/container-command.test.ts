
/** This owner fakes native process leaves; captured transport compilation remains real. */
vi.mock("../container-runtime.js", async original => {
    const actual = await original<typeof import("../container-runtime.js")>();
    const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import("../ports/container-runtime-invocation.js");
    let info: ReturnType<typeof actual.getRuntimeInfo> = {
        runtime: "podman", flavor: "podman-rootful", version: "0.0.0",
        socketPath: "/run/podman/podman.sock", rootless: false, remote: false, dockerDesktop: false,
    };
    const preload = (value: Parameters<typeof actual._setRuntimeInfoForTest>[0]) => {
        actual._setRuntimeInfoForTest(value);
        info = actual.getRuntimeInfo();
    };
    preload(info);
    const invocation = (runtime = info.runtime) => actual.validateNativeRuntimeInvocation({
        version: 1, runtime, executable: `/fixture/runtime/${runtime}`,
        transport: runtime === "docker"
            ? { kind: "docker", host: "unix:///fixture/engine.sock", configDirectory: "/fixture/config",
                tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } }
            : { kind: "podman-local", graphRoot: "/fixture/storage", runRoot: "/fixture/run",
                storageDriver: "overlay", storageOptions: [], transientStore: false },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
    });
    return { ...actual, getRuntimeInfo: () => info, runtimeCli: () => info.runtime,
        getRuntimeInvocation: invocation, captureNativeRuntimeInvocation: invocation,
        runtimeSpawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) =>
            actual.bindNativeRuntimeInvocation(invocation()).spawnSync(args, options),
        runtimeSpawn: (args: readonly string[], options?: import("child_process").SpawnOptions) =>
            actual.bindNativeRuntimeInvocation(invocation()).spawn(args, options),
        runWithNativeRuntimeInvocation: <T>(_invocation: unknown, operation: () => T): T => operation(),
        _setRuntimeInfoForTest: preload,
        _resetRuntimeCacheForTest: () => { actual._resetRuntimeCacheForTest(); preload({runtime: "podman"}); },
    };
});

function logicalNativeCall(call: unknown[]): unknown[] {
    const [program, argv, options] = call;
    if (program !== "/fixture/runtime/docker" && program !== "/fixture/runtime/podman") return call;
    const runtime = program.endsWith("/docker") ? "docker" : "podman";
    const prefix = runtime === "docker"
        ? ["--config", "/fixture/config", "--host", "unix:///fixture/engine.sock", "--tls=false", "--tlscacert=", "--tlscert=", "--tlskey="]
        : ["--remote=false", "--root", "/fixture/storage", "--runroot", "/fixture/run", "--storage-driver", "overlay", "--transient-store=false"];
    expect((argv as string[]).slice(0, prefix.length)).toEqual(prefix);
    const { env, shell, ...logicalOptions } = options as import("child_process").SpawnSyncOptions;
    expect(shell).toBe(false);
    expect(env?.DOCKER_CONTEXT).toBeUndefined();
    expect(env?.CONTAINER_HOST).toBeUndefined();
    return [runtime, (argv as string[]).slice(prefix.length), logicalOptions];
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runContainerCommand } from "../container-command.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), sync: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawn: (...args: unknown[]) => native.spawn(...logicalNativeCall(args)), spawnSync: (...args: unknown[]) => native.sync(...logicalNativeCall(args)),
}));
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const args = ["exec", "-it", "exact-container-id", "codex", "resume", "argument with spaces", "$(never a shell)"];
let child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
let baseline: Map<string, ReturnType<typeof process.listeners>>;

beforeEach(() => {
    vi.resetAllMocks();
    child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    native.spawn.mockReturnValue(child);
    baseline = new Map(signals.map(signal => [signal, process.listeners(signal)]));
});
afterEach(() => {
    // Only fixture-owned listeners are removed, including after a failed assertion.
    for (const signal of signals) {
        for (const listener of process.listeners(signal)) {
            if (!baseline.get(signal)!.includes(listener)) process.removeListener(signal, listener);
        }
    }
});

function clean() {
    for (const signal of signals) expect(process.listeners(signal)).toEqual(baseline.get(signal));
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
}

describe("container command asynchronous native boundary", () => {
    it.each([0, 7, 130])("inherits stdio and preserves ordinary close status %s", async status => {
        const pending = runContainerCommand("podman", args, true);
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("podman", args, { stdio: "inherit" });
        expect(native.spawn.mock.calls[0][1]).toEqual(args);
        expect(native.sync).not.toHaveBeenCalled();
        expect(child.listenerCount("close")).toBe(1);
        child.emit("close", status, null);
        expect(await pending).toBe(status);
        expect(child.kill).not.toHaveBeenCalled();
        clean();
    });

    it.each([[null, null], [null, "SIGTERM"], [0, "SIGINT"], [NaN, null]] as const)("returns finite failure for close %s/%s", async (code, signal) => {
        const pending = runContainerCommand("docker", args, true);
        child.emit("close", code, signal);
        expect(await pending).toBe(1);
        clean();
    });

    it("handles native error once and ignores a subsequent close", async () => {
        const pending = runContainerCommand("missing-runtime", args, true);
        child.emit("error", new Error("launch failed"));
        child.emit("close", 0, null);
        expect(await pending).toBe(1);
        clean();
    });

    it.each([new Error("spawn"), { spawn: true }])("propagates synchronous launch throws without signal residue: %s", async failure => {
        native.spawn.mockImplementation(() => { throw failure; });
        try { await runContainerCommand("docker", args, true); throw new Error("expected rejection"); }
        catch (error) { expect(error).toBe(failure); }
        clean();
    });

    it.each(signals)("kills only its returned child before an existing %s cleanup/exit handler", async signal => {
        const order: string[] = [];
        const cleanup = () => { order.push("existing-cleanup-exit"); };
        process.on(signal, cleanup);
        const pending = runContainerCommand("docker", args, true);
        const listeners = process.listeners(signal);
        const owned = listeners.find(listener => !baseline.get(signal)!.includes(listener) && listener !== cleanup)!;
        expect(listeners.indexOf(owned)).toBeLessThan(listeners.indexOf(cleanup));
        child.kill.mockImplementation(target => { order.push(`owned-client:${target}`); return true; });
        // Invoke only fixture-owned handlers; never signal the test host.
        owned();
        cleanup();
        child.emit("close", null, "SIGKILL");
        expect(await pending).toBe(1);
        expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
        expect(order).toEqual(["owned-client:SIGKILL", "existing-cleanup-exit"]);
        process.removeListener(signal, cleanup);
        clean();
    });

    it.each(["close", "throw", "false"] as const)("settles once when owned interruption races native %s", async outcome => {
        const pending = runContainerCommand("docker", args, true);
        child.kill.mockImplementation(() => {
            if (outcome === "close") child.emit("close", 0, null);
            if (outcome === "throw") throw new Error("already exited");
            return false;
        });
        process.listeners("SIGTERM").find(listener => !baseline.get("SIGTERM")!.includes(listener))!();
        child.emit("close", 9, null);
        expect(await pending).toBe(1);
        clean();
    });

    it.each([0, 8, null, undefined])("retains noninteractive synchronous status %s", async status => {
        native.sync.mockReturnValue({ status });
        expect(await runContainerCommand("podman", args, false)).toBe(status ?? 1);
        expect(native.sync).toHaveBeenCalledExactlyOnceWith("podman", args, { stdio: "inherit" });
        expect(native.spawn).not.toHaveBeenCalled();
        clean();
    });

    it("preserves noninteractive native throws", async () => {
        const failure = { synchronous: true };
        native.sync.mockImplementation(() => { throw failure; });
        try { await runContainerCommand("docker", args, false); throw new Error("expected rejection"); }
        catch (error) { expect(error).toBe(failure); }
        clean();
    });
});

async function until(predicate: () => boolean, timeout = 4000): Promise<void> {
    const end = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() >= end) throw new Error("owned fixture did not reach its readiness/teardown barrier");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

describe.skipIf(process.platform === "win32")("real isolated parent signal responsiveness", () => {
    it.each(signals)("handles parent-directed %s while child is alive and retires only the owned client", async signal => {
        const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
        const directory = mkdtempSync(join(tmpdir(), "ccc-container-command-signal-"));
        const ready = join(directory, "child-ready.json");
        const parentReady = join(directory, "parent-ready");
        const cleaned = join(directory, "cleanup.json");
        const ordinaryEnd = join(directory, "ordinary-end");
        const script = join(directory, "owned-client.mjs");
        writeFileSync(script, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setTimeout(()=>{writeFileSync(${JSON.stringify(ordinaryEnd)},'ended');process.exit(0)},30000);`);
        const helperUrl = new URL("../../dist/container-command.js", import.meta.url).href;
        const source = [
            "import {existsSync,writeFileSync} from 'node:fs';",
            `import {runContainerCommand} from ${JSON.stringify(helperUrl)};`,
            `process.on(${JSON.stringify(signal)},()=>{writeFileSync(${JSON.stringify(cleaned)},JSON.stringify({beforeOrdinaryEnd:!existsSync(${JSON.stringify(ordinaryEnd)})}));process.exit(0)});`,
            `const pending=runContainerCommand(process.execPath,[${JSON.stringify(script)}],true);`,
            `const readyTimer=setInterval(()=>{if(existsSync(${JSON.stringify(ready)})){writeFileSync(${JSON.stringify(parentReady)},'ready');clearInterval(readyTimer)}},10);`,
            "await pending;",
        ].join("\n");
        const parent = spawn(process.execPath, ["--input-type=module", "-e", source], { detached: true, stdio: "ignore" });
        const closed = new Promise<number | null>((resolve, reject) => {
            parent.once("error", reject); parent.once("close", resolve);
        });
        void closed.catch(() => undefined);
        let childPid: number | undefined;
        function live(pid: number): boolean {
            try {
                process.kill(pid, 0);
                // An orphan killed before its parent exits can await init's reap on Linux.
                if (process.platform === "linux" && readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z")) return false;
                return true;
            } catch { return false; }
        }
        try {
            await until(() => existsSync(parentReady));
            childPid = JSON.parse(readFileSync(ready, "utf8")).pid;
            expect(live(childPid!)).toBe(true);
            expect(existsSync(ordinaryEnd)).toBe(false);
            expect(parent.kill(signal)).toBe(true);
            await until(() => existsSync(cleaned));
            expect(JSON.parse(readFileSync(cleaned, "utf8"))).toEqual({ beforeOrdinaryEnd: true });
            expect(await closed).toBe(0);
            await until(() => !live(childPid!));
            expect(existsSync(ordinaryEnd)).toBe(false);
        } finally {
            // This detached group was created solely by this fixture, never a shared runtime.
            if (parent.pid !== undefined) {
                try { process.kill(-parent.pid, "SIGKILL"); } catch { /* already retired */ }
            }
            try {
                await closed.catch(() => undefined);
                if (childPid === undefined && existsSync(ready)) childPid = JSON.parse(readFileSync(ready, "utf8")).pid;
                if (childPid !== undefined) await until(() => !live(childPid!));
            } finally { rmSync(directory, { recursive: true, force: true }); }
        }
    }, 15000);
});
