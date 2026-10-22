
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

const native = vi.hoisted(() => ({ spawn: vi.fn(), sync: vi.fn(), writeSync: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawn: (...args: unknown[]) => native.spawn(...logicalNativeCall(args)), spawnSync: (...args: unknown[]) => native.sync(...logicalNativeCall(args)),
}));
vi.mock("fs", async original => ({ ...await original<typeof import("node:fs")>(), writeSync: native.writeSync }));
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const lifecycleEvents = [...signals, "exit"] as const;
const args = ["exec", "-it", "exact-container-id", "codex", "resume", "argument with spaces", "$(never a shell)"];
let child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
type LifecycleListener = NodeJS.ExitListener | NodeJS.SignalsListener;
let baseline: Map<string, LifecycleListener[]>;
const ttyDescriptors = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));

function lifecycleListeners(event: typeof lifecycleEvents[number]): LifecycleListener[] {
    return event === "exit" ? process.listeners("exit") : process.listeners(event);
}

function setTty(input: boolean, output: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: input });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: output });
}

function terminalFixture(input = true, output = true) {
    setTty(input, output);
    native.sync.mockReturnValue({ status: 0, stdout: "500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0\n" });
    native.writeSync.mockImplementation((_fd: number, data: string | NodeJS.ArrayBufferView) => typeof data === "string" ? Buffer.byteLength(data) : data.byteLength);
    return { write: native.writeSync, output: () => native.writeSync.mock.calls.map(call => String(call[1])).join("") };
}

function expectTerminalRestored(output: string): void {
    const modes = new Map<number, boolean>();
    for (const match of output.matchAll(/\u001b\[\?([\d;]+)([hl])/g)) {
        for (const mode of match[1].split(";")) modes.set(Number(mode), match[2] === "h");
    }
    for (const mode of [1000, 1002, 1003, 1006, 1004, 2004, 1049]) expect(modes.get(mode)).toBe(false);
    expect(modes.get(25)).toBe(true);
    expect(output).not.toContain("\u001bc");
    expect(output).not.toMatch(/\u001b\[[23]J/);
}

beforeEach(() => {
    vi.resetAllMocks();
    child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    native.spawn.mockReturnValue(child);
    setTty(false, false);
    baseline = new Map(lifecycleEvents.map(signal => [signal, lifecycleListeners(signal)]));
});
afterEach(() => {
    // Only fixture-owned listeners are removed, including after a failed assertion.
    for (const signal of lifecycleEvents) {
        for (const listener of lifecycleListeners(signal)) {
            if (!baseline.get(signal)!.includes(listener)) process.removeListener(signal, listener);
        }
    }
    vi.restoreAllMocks();
    [process.stdin, process.stdout].forEach((stream, index) => {
        const descriptor = ttyDescriptors[index];
        if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
        else Reflect.deleteProperty(stream, "isTTY");
    });
});

function clean() {
    for (const signal of lifecycleEvents) expect(lifecycleListeners(signal)).toEqual(baseline.get(signal));
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
        const terminal = terminalFixture();
        const pending = runContainerCommand("docker", args, true);
        child.kill.mockImplementation(() => {
            if (outcome === "close") child.emit("close", 0, null);
            if (outcome === "throw") throw new Error("already exited");
            return false;
        });
        process.listeners("SIGTERM").find(listener => !baseline.get("SIGTERM")!.includes(listener))!();
        expectTerminalRestored(terminal.output());
        const writes = terminal.write.mock.calls.length;
        child.emit("close", 9, null);
        expect(await pending).toBe(1);
        expect(terminal.write).toHaveBeenCalledTimes(writes);
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

describe("inherited interactive terminal lifetime", () => {
    it.each(["close", "error"] as const)("restores TTY modes synchronously on %s and disposes only its listeners once", async event => {
        const terminal = terminalFixture();
        const unrelatedExit = vi.fn();
        process.on("exit", unrelatedExit);
        const pending = runContainerCommand("docker", args, true);
        if (event === "close") child.emit("close", 7, null);
        else child.emit("error", Error("runtime disappeared"));
        expectTerminalRestored(terminal.output());
        const writes = terminal.write.mock.calls.length;
        child.emit("close", 0, null);
        expect(await pending).toBe(event === "close" ? 7 : 1);
        expect(terminal.write).toHaveBeenCalledTimes(writes);
        expect(process.listeners("exit")).toEqual([...baseline.get("exit")!, unrelatedExit]);
        expect(unrelatedExit).not.toHaveBeenCalled();
        process.removeListener("exit", unrelatedExit);
        clean();
    });

    it("restores a TTY before propagating the original synchronous launch failure", async () => {
        const terminal = terminalFixture();
        const failure = { launch: "original" };
        native.spawn.mockImplementation(() => { throw failure; });
        const pending = runContainerCommand("docker", args, true);
        expectTerminalRestored(terminal.output());
        await expect(pending).rejects.toBe(failure);
        clean();
    });

    it.each(signals)("restores a TTY before existing synchronous %s cleanup exits", async signal => {
        const terminal = terminalFixture();
        const cleanup = vi.fn(() => { expectTerminalRestored(terminal.output()); });
        process.on(signal, cleanup);
        const pending = runContainerCommand("docker", args, true);
        const listeners = process.listeners(signal);
        const owned = listeners.find(listener => !baseline.get(signal)!.includes(listener) && listener !== cleanup)!;
        expect(listeners.indexOf(owned)).toBeLessThan(listeners.indexOf(cleanup));
        owned();
        cleanup();
        const writes = terminal.write.mock.calls.length;
        child.emit("close", 0, null);
        expect(await pending).toBe(1);
        expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
        expect(terminal.write).toHaveBeenCalledTimes(writes);
        process.removeListener(signal, cleanup);
        clean();
    });

    it("restores from its temporary exit fallback once and removes that fallback on settlement", async () => {
        const terminal = terminalFixture();
        const pending = runContainerCommand("docker", args, true);
        const owned = process.listeners("exit").filter(listener => !baseline.get("exit")!.includes(listener));
        expect(owned).toHaveLength(1);
        // Exercise only the owned fallback; never emit exit on the Vitest host.
        (owned[0] as (code: number) => void)(0);
        expectTerminalRestored(terminal.output());
        const writes = terminal.write.mock.calls.length;
        child.emit("close", 9, null);
        expect(await pending).toBe(9);
        expect(terminal.write).toHaveBeenCalledTimes(writes);
        clean();
    });

    it.each([[false, false], [true, false], [false, true]])("leaves redirected input/output %s/%s bytes unchanged", async (input, output) => {
        const terminal = terminalFixture(input, output);
        const pending = runContainerCommand("docker", args, true);
        child.emit("close", 8, null);
        expect(await pending).toBe(8);
        expect(terminal.write).not.toHaveBeenCalled();
        expect(native.sync).not.toHaveBeenCalled();
        clean();
    });

    it("keeps noninteractive TTY output and status unchanged", async () => {
        const terminal = terminalFixture();
        native.sync.mockReturnValue({ status: 12 });
        expect(await runContainerCommand("podman", args, false)).toBe(12);
        expect(terminal.write).not.toHaveBeenCalled();
        expect(native.sync).toHaveBeenCalledExactlyOnceWith("podman", args, { stdio: "inherit" });
        clean();
    });

    it("contains native terminal cleanup faults without replacing child status", async () => {
        const terminal = terminalFixture();
        const pending = runContainerCommand("docker", args, true);
        native.sync.mockImplementation(() => { throw Error("terminal unavailable"); });
        terminal.write.mockImplementation(() => { throw Error("output disappeared"); });
        expect(() => child.emit("close", 6, null)).not.toThrow();
        expect(await pending).toBe(6);
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

describe.skipIf(process.platform === "win32")("real inherited POSIX terminal restoration", () => {
    it("restores actual shared termios and mouse modes before returning from an abruptly killed runtime client", async () => {
        const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
        const directory = mkdtempSync(join(tmpdir(), "ccc-container-command-pty-"));
        const clientPath = join(directory, "owned-runtime-client.mjs");
        const parentPath = join(directory, "owned-parent.mjs");
        const startPath = join(directory, "allow-client-start");
        const releasePath = join(directory, "allow-client-death");
        const helperUrl = new URL("../../dist/container-command.js", import.meta.url).href;
        writeFileSync(clientPath, [
            "import {existsSync} from 'node:fs';",
            "import {spawnSync} from 'node:child_process';",
            "const changed=spawnSync('stty',['-icanon','-echo','-isig'],{stdio:['inherit','pipe','pipe'],timeout:1000});",
            "if(changed.status!==0)throw Error('owned client could not change its inherited terminal');",
            `process.stdout.write(${JSON.stringify("\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\u001b[?1004h\u001b[?2004h\u001b[?1049h\u001b[?25lCCC_CLIENT_RAW\n")});`,
            `const ready=setInterval(()=>{if(existsSync(${JSON.stringify(releasePath)})){clearInterval(ready);process.kill(process.pid,'SIGKILL')}},10);`,
            "setTimeout(()=>process.kill(process.pid,'SIGKILL'),7000);",
        ].join("\n"));
        writeFileSync(parentPath, [
            "import {existsSync} from 'node:fs';",
            `import {runContainerCommand} from ${JSON.stringify(helperUrl)};`,
            "const isRawBefore=process.stdin.isRaw===true;",
            'process.stdout.write("CCC_PARENT_READY\\n");',
            `while(!existsSync(${JSON.stringify(startPath)}))await new Promise(resolve=>setTimeout(resolve,10));`,
            `const status=await runContainerCommand(process.execPath,[${JSON.stringify(clientPath)}],true);`,
            'process.stdout.write("CCC_CONTROL_RETURNED "+JSON.stringify({status,isRawBefore,isRawAtReturn:process.stdin.isRaw===true})+"\\n");',
            // The controller inspects shared termios while this process remains
            // alive, before Node's own exit can incidentally reset the terminal.
            "setTimeout(()=>process.exit(0),10000);",
        ].join("\n"));
        const controller = String.raw`
import base64, json, os, pty, select, signal, subprocess, sys, termios, time
master, slave = pty.openpty()
parent = None
captured = bytearray()
deadline = time.monotonic() + 7
def flags(attributes):
    return {name: bool(attributes[3] & getattr(termios, name)) for name in ('ICANON', 'ECHO', 'ISIG')}
def configured_attributes(attributes):
    configured = list(attributes)
    # XNU sets PENDIN when ICANON is restored; only this kernel state is excluded.
    if sys.platform == 'darwin':
        configured[3] &= ~termios.PENDIN
    return configured
def read_until(predicate):
    while not predicate(bytes(captured)):
        if time.monotonic() >= deadline:
            raise RuntimeError('owned PTY barrier timed out: ' + repr(bytes(captured)[-1000:]))
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            data = os.read(master, 65536)
            if not data:
                raise RuntimeError('owned PTY closed before control returned')
            captured.extend(data)
try:
    initial = termios.tcgetattr(slave)
    initial[3] |= termios.ICANON | termios.ECHO | termios.ISIG
    termios.tcsetattr(slave, termios.TCSANOW, initial)
    parent = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    # Observe the boundary owned by runContainerCommand after Node initializes its TTY streams.
    read_until(lambda data: b'CCC_PARENT_READY' in data)
    before = termios.tcgetattr(slave)
    with open(sys.argv[4], 'w') as gate:
        gate.write('start only this owned client')
    read_until(lambda data: b'CCC_CLIENT_RAW' in data)
    mutated = termios.tcgetattr(slave)
    with open(sys.argv[3], 'w') as gate:
        gate.write('release only this owned client')
    marker = b'CCC_CONTROL_RETURNED '
    read_until(lambda data: marker in data and b'\n' in data.split(marker, 1)[1])
    before_return, returned = bytes(captured).split(marker, 1)
    outcome = json.loads(returned.splitlines()[0])
    after = termios.tcgetattr(slave)
    result = dict(outcome, before=flags(before), mutated=flags(mutated), after=flags(after),
                  configuredAttributesRestored=configured_attributes(after) == configured_attributes(before),
                  parentAliveAtObservation=parent.poll() is None,
                  attributeDifferences=[dict(field=field, before=repr(old), after=repr(new))
                      for field, old, new in zip(('iflag', 'oflag', 'cflag', 'lflag', 'ispeed', 'ospeed', 'cc'), before, after) if old != new],
                  bytesBeforeReturn=base64.b64encode(before_return).decode('ascii'))
finally:
    if parent is not None:
        try:
            os.killpg(parent.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        parent.wait(timeout=2)
    os.close(master)
    os.close(slave)
print(json.dumps(result))
`;
        try {
            const run = spawnSync("python3", ["-c", controller, process.execPath, parentPath, releasePath, startPath], { encoding: "utf8", timeout: 11000, killSignal: "SIGKILL" });
            expect(run.error, run.stderr).toBeUndefined();
            expect(run.status, run.stderr).toBe(0);
            const result = JSON.parse(run.stdout) as {
                status: number; isRawBefore: boolean; isRawAtReturn: boolean;
                before: Record<string, boolean>; mutated: Record<string, boolean>; after: Record<string, boolean>;
                configuredAttributesRestored: boolean; parentAliveAtObservation: boolean; bytesBeforeReturn: string;
                attributeDifferences: Array<{ field: string; before: string; after: string }>;
            };
            expect(result.before).toEqual({ ICANON: true, ECHO: true, ISIG: true });
            expect(result.mutated).toEqual({ ICANON: false, ECHO: false, ISIG: false });
            expect(result.parentAliveAtObservation).toBe(true);
            expect(result.status).toBe(1);
            expect(result.isRawBefore).toBe(false);
            expect(result.isRawAtReturn).toBe(false);
            expect(result.after).toEqual(result.before);
            expectTerminalRestored(Buffer.from(result.bytesBeforeReturn, "base64").toString("utf8"));
            expect(result.configuredAttributesRestored, JSON.stringify(result.attributeDifferences)).toBe(true);
        } finally { rmSync(directory, { recursive: true, force: true }); }
    }, 15000);
});
