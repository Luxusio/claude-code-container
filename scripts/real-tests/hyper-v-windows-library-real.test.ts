import { EventEmitter } from "events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { PassThrough } from "stream";
import { fileURLToPath } from "url";

import { describe, expect, it, vi } from "vitest";

import {
    createBoundedPowerShellFileRunner,
    createFixtureOperation,
    HYPER_V_WINDOWS_LIBRARY_FIXTURE_SHA256,
    loadHyperVWindowsLibrary,
    resolveTrustedWindowsSystemExecutables,
    runHyperVWindowsLibraryScenario,
    verifiedHyperVWindowsLibraryFixturePath,
} from "./hyper-v-windows-library-real.ts";
import {
    isHyperVWindowsLibrarySourceEntrypoint,
    runHyperVWindowsLibraryLevel3,
    withExclusiveHyperVLibraryRun,
} from "./hyper-v-windows-library.ts";

class FakeChild extends EventEmitter {
    readonly pid = 4321;
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin = new PassThrough();
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    readonly kill = vi.fn(() => true);

    close(status: number | null): void {
        this.exitCode = status;
        this.emit("close", status);
    }
}

const TEST_WINDOWS_ROOT = "C:\\Windows";
const TEST_EXECUTABLES = resolveTrustedWindowsSystemExecutables(TEST_WINDOWS_ROOT);

const request = {
    executable: TEST_EXECUTABLES.powershell,
    scriptPath: "C:\\fixture.ps1",
    scriptSource: "$global:CccHyperVJsonInput | Out-Null",
    input: "{\"ok\":true}\n",
};

const context = {
    timeoutMilliseconds: 1000,
    maximumOutputBytes: 1024,
};

const fixtureFrame = (value: unknown) => `CCC_HYPER_V_WINDOWS_LIBRARY_FIXTURE_RESULT:${Buffer.from(
    JSON.stringify(value),
    "utf8",
).toString("base64")}`;

function output() {
    let stdout = "";
    let stderr = "";
    return {
        stdout: { write: (value: unknown) => { stdout += String(value); return true; } },
        stderr: { write: (value: unknown) => { stderr += String(value); return true; } },
        read: () => ({ stdout, stderr }),
    };
}

describe("bounded Hyper-V Windows PowerShell file runner", () => {
    it("does not activate the shared launcher main branch after bundling", () => {
        const source = join("repo", "scripts", "real-tests", "hyper-v-windows-library.ts");
        const bundle = join("protected", "hyper-v-windows-library-privileged.mjs");
        expect(isHyperVWindowsLibrarySourceEntrypoint(source, source)).toBe(true);
        expect(isHyperVWindowsLibrarySourceEntrypoint(bundle, bundle)).toBe(false);
    });

    it("passes JSON through stdin and preserves a valid native nonzero result", async () => {
        const child = new FakeChild();
        let invocation: { command: string; args: readonly string[]; options: Record<string, unknown> } | null = null;
        child.stdin.on("data", (chunk) => expect(JSON.parse(Buffer.from(String(chunk), "base64").toString("utf8"))).toEqual({
            script: request.scriptSource,
            input: request.input,
        }));
        const runner = createBoundedPowerShellFileRunner({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            spawnImpl: (command, args, options) => {
                invocation = { command, args, options };
                queueMicrotask(() => {
                    child.stdout.end('{"schemaVersion":1,"ok":false,"errorCode":"native-failed"}');
                    child.stderr.end("bounded native detail");
                    child.close(1);
                });
                return child;
            },
        });

        await expect(runner(request, context)).resolves.toEqual({
            status: 1,
            stdout: '{"schemaVersion":1,"ok":false,"errorCode":"native-failed"}',
            stderr: "bounded native detail",
        });
        expect(invocation).toMatchObject({
            command: TEST_EXECUTABLES.powershell,
            args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", expect.stringContaining("ScriptBlock")],
            options: { windowsHide: true, detached: false },
        });
        const bootstrap = (invocation as { args: readonly string[] }).args.at(-1) ?? "";
        expect(bootstrap).toContain("[Convert]::FromBase64String([Console]::In.ReadToEnd())");
        expect(bootstrap).not.toContain("[Console]::InputEncoding =");
        expect(bootstrap).not.toContain("[Console]::OutputEncoding =");
        expect(bootstrap).not.toContain("StreamReader");
        expect(bootstrap).not.toContain("StreamWriter");
        expect(child.listenerCount("error")).toBe(0);
        expect(child.listenerCount("close")).toBe(0);
    });

    it("classifies spawn failures without leaking the native error", async () => {
        const throwing = createBoundedPowerShellFileRunner({ spawnImpl: () => { throw new Error("private path"); } });
        await expect(throwing(request, context)).resolves.toEqual({
            status: null,
            stdout: "",
            error: "powershell-spawn-failed",
        });

        const child = new FakeChild();
        const emitted = createBoundedPowerShellFileRunner({
            spawnImpl: () => {
                queueMicrotask(() => child.emit("error", new Error("private path")));
                return child;
            },
        });
        await expect(emitted(request, context)).resolves.toMatchObject({
            status: null,
            error: "powershell-spawn-failed",
        });
    });

    it.each([
        ["timeout", "timedOut"],
        ["cancellation", "cancelled"],
        ["output overflow", "outputLimitExceeded"],
    ] as const)("kills the Windows process tree on %s", async (kind, property) => {
        const child = new FakeChild();
        const taskkill = vi.fn(() => {
            queueMicrotask(() => child.close(1));
            return { status: 0 };
        });
        const controller = new AbortController();
        const runner = createBoundedPowerShellFileRunner({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            spawnImpl: () => {
                queueMicrotask(() => {
                    if (kind === "cancellation") controller.abort();
                    if (kind === "output overflow") child.stdout.write("x".repeat(20));
                });
                return child;
            },
            taskkillImpl: taskkill,
        });
        const result = await runner(request, {
            timeoutMilliseconds: kind === "timeout" ? 5 : 1000,
            maximumOutputBytes: 8,
            signal: controller.signal,
        });

        expect(result[property]).toBe(true);
        expect(taskkill).toHaveBeenCalledTimes(1);
        expect(taskkill).toHaveBeenCalledWith(
            TEST_EXECUTABLES.taskkill,
            ["/pid", "4321", "/t", "/f"],
            expect.objectContaining({ timeout: 5000 }),
        );
        expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8);
    });

    it.each([
        ["nonzero taskkill", () => ({ status: 1, error: new Error("denied") })],
        ["throwing taskkill", () => { throw new Error("denied"); }],
    ])("fails closed when %s cannot confirm child closure", async (_label, taskkillImpl) => {
        const child = new FakeChild();
        child.kill.mockReturnValue(false);
        const runner = createBoundedPowerShellFileRunner({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            spawnImpl: () => child,
            taskkillImpl,
            processIdentityImpl: () => "same-process",
            terminationGraceMilliseconds: 5,
        });
        const result = await runner(request, { ...context, timeoutMilliseconds: 1 });
        expect(result).toMatchObject({
            status: null,
            timedOut: true,
            terminationUnconfirmed: true,
            error: "powershell-termination-unconfirmed",
        });
        expect(child.listenerCount("close")).toBe(0);
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("blocks cleanup classification when child error precedes close after termination starts", async () => {
        const child = new FakeChild();
        child.kill.mockImplementation(() => {
            queueMicrotask(() => child.emit("error", new Error("termination raced")));
            return false;
        });
        const runner = createBoundedPowerShellFileRunner({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            spawnImpl: () => child,
            taskkillImpl: () => ({ status: 1 }),
            processIdentityImpl: () => "same-process",
            terminationGraceMilliseconds: 100,
        });
        await expect(runner(request, { ...context, timeoutMilliseconds: 1 })).resolves.toMatchObject({
            status: null,
            timedOut: true,
            terminationUnconfirmed: true,
            error: "powershell-termination-unconfirmed",
        });
    });

    it("does not taskkill a reused PID when the captured process identity changed", async () => {
        const child = new FakeChild();
        const identities = ["original-process", "reused-process"];
        const taskkillImpl = vi.fn();
        child.kill.mockImplementation(() => {
            queueMicrotask(() => child.close(1));
            return true;
        });
        const runner = createBoundedPowerShellFileRunner({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            spawnImpl: () => child,
            taskkillImpl,
            processIdentityImpl: () => identities.shift() ?? "reused-process",
            terminationGraceMilliseconds: 20,
        });
        const result = await runner(request, { ...context, timeoutMilliseconds: 1 });
        expect(result).toMatchObject({
            status: 1,
            timedOut: true,
            terminationUnconfirmed: true,
            error: "powershell-termination-unconfirmed",
        });
        expect(taskkillImpl).not.toHaveBeenCalled();
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("does not spawn when already cancelled", async () => {
        const controller = new AbortController();
        controller.abort();
        const spawnImpl = vi.fn();
        const runner = createBoundedPowerShellFileRunner({ spawnImpl });
        await expect(runner(request, { ...context, signal: controller.signal })).resolves.toEqual({
            status: null,
            stdout: "",
            cancelled: true,
        });
        expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("rejects relative or non-system PowerShell executables before spawning", async () => {
        const spawnImpl = vi.fn();
        const runner = createBoundedPowerShellFileRunner({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            spawnImpl,
        });
        await expect(runner({ ...request, executable: "powershell.exe" }, context)).resolves.toMatchObject({
            status: null,
            error: "powershell-executable-untrusted",
        });
        await expect(runner({ ...request, executable: "C:\\Users\\Public\\powershell.exe" }, context)).resolves.toMatchObject({
            status: null,
            error: "powershell-executable-untrusted",
        });
        expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("rejects an oversized in-memory script envelope before spawning", async () => {
        const spawnImpl = vi.fn();
        const runner = createBoundedPowerShellFileRunner({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            spawnImpl,
        });
        await expect(runner({ ...request, scriptSource: "x".repeat(300 * 1024) }, context)).resolves.toEqual({
            status: null,
            stdout: "",
            error: "powershell-input-limit-exceeded",
        });
        expect(spawnImpl).not.toHaveBeenCalled();
    });
});

describe("fixture protocol", () => {
    it("accepts only the pinned embedded fixture source", async () => {
        const scriptSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hyper-v-windows-library-fixture.ps1"), "utf8");
        const runner = vi.fn(async () => ({
            status: 0,
            stdout: fixtureFrame({ schemaVersion: 1, operation: "preflight", ok: true, result: { ready: true } }),
        }));
        const embedded = createFixtureOperation(runner, TEST_EXECUTABLES.powershell, {
            scriptPath: "embedded:hyper-v-windows-library-fixture.ps1",
            scriptSource,
        });
        await expect(embedded("preflight", {})).resolves.toEqual({ ready: true });
        expect(runner).toHaveBeenCalledWith(expect.objectContaining({
            scriptPath: "embedded:hyper-v-windows-library-fixture.ps1",
            scriptSource,
        }), expect.any(Object));

        const tampered = createFixtureOperation(runner, TEST_EXECUTABLES.powershell, {
            scriptPath: "embedded:hyper-v-windows-library-fixture.ps1",
            scriptSource: `${scriptSource}\n# tampered`,
        });
        await expect(tampered("preflight", {})).rejects.toThrow("hyper-v-library-fixture-asset-integrity-failed");
    });

    it("accepts successful JSON and preserves native nonzero failure codes", async () => {
        const success = createFixtureOperation(async () => ({
            status: 0,
            stdout: `module chatter\r\n${fixtureFrame({ schemaVersion: 1, operation: "preflight", ok: true, result: { ready: true } })}\r\n`,
        }), TEST_EXECUTABLES.powershell);
        await expect(success("preflight", {})).resolves.toEqual({ ready: true });

        const nativeFailure = createFixtureOperation(async () => ({
            status: 1,
            stdout: fixtureFrame({ schemaVersion: 1, operation: "preflight", ok: false, errorCode: "administrator-required" }),
        }), TEST_EXECUTABLES.powershell);
        await expect(nativeFailure("preflight", {})).rejects.toThrow("hyper-v-library-fixture-administrator-required");

        const cleanupRefusal = createFixtureOperation(async () => ({
            status: 1,
            stdout: fixtureFrame({ schemaVersion: 1, operation: "cleanup", ok: false, errorCode: "pathless-hard-disk-refused" }),
        }), TEST_EXECUTABLES.powershell);
        await expect(cleanupRefusal("cleanup", {})).rejects.toThrow("hyper-v-library-fixture-pathless-hard-disk-refused");

        const unsafeFailure = createFixtureOperation(async () => ({
            status: 1,
            stdout: fixtureFrame({ schemaVersion: 1, operation: "cleanup", ok: false, errorCode: "private path\nsecret" }),
        }), TEST_EXECUTABLES.powershell);
        await expect(unsafeFailure("cleanup", {})).rejects.toThrow("hyper-v-library-fixture-response-invalid");
    });

    it.each([
        [{ status: null, stdout: "", error: "spawn" }, "transport-failed"],
        [{ status: null, stdout: "", timedOut: true }, "timeout"],
        [{ status: null, stdout: "", cancelled: true }, "cancelled"],
        [{ status: null, stdout: "", outputLimitExceeded: true }, "output-limit"],
        [{ status: 0, stdout: "not-json" }, "response-marker-missing"],
    ])("rejects bounded fixture process failure %#", async (result, code) => {
        const fixture = createFixtureOperation(async () => result, TEST_EXECUTABLES.powershell);
        await expect(fixture("preflight", {})).rejects.toThrow(`hyper-v-library-fixture-${code}`);
    });

    it("adds only bounded classifications when the fixture marker is missing", async () => {
        const fixture = createFixtureOperation(async () => ({
            status: 1,
            stdout: "private stdout path C:\\Users\\secret",
            stderr: "#< CLIXML private stderr path C:\\Users\\secret",
        }), TEST_EXECUTABLES.powershell);
        let observed = "";
        try {
            await fixture("preflight", {});
        } catch (error) {
            observed = error instanceof Error ? error.message : String(error);
        }
        expect(observed).toMatch(/^hyper-v-library-fixture-response-marker-missing\[s=1,o=\d+,e=\d+,ok=text,ek=clixml\]$/);
        expect(observed).not.toContain("private");
        expect(observed).not.toContain("Users");
    });

    it.each([
        [
            `${fixtureFrame({ schemaVersion: 1, operation: "preflight", ok: true })}\n${fixtureFrame({ schemaVersion: 1, operation: "preflight", ok: true })}`,
            "response-marker-ambiguous",
        ],
        ["CCC_HYPER_V_WINDOWS_LIBRARY_FIXTURE_RESULT:not-base64", "response-payload-invalid"],
        [`CCC_HYPER_V_WINDOWS_LIBRARY_FIXTURE_RESULT:${Buffer.from([0xff]).toString("base64")}`, "response-malformed"],
        [`CCC_HYPER_V_WINDOWS_LIBRARY_FIXTURE_RESULT:${Buffer.from("not-json").toString("base64")}`, "response-malformed"],
        [fixtureFrame(null), "response-invalid"],
        [fixtureFrame([]), "response-invalid"],
    ])("rejects an invalid marked fixture frame %#", async (stdout, code) => {
        const fixture = createFixtureOperation(async () => ({ status: 0, stdout }), TEST_EXECUTABLES.powershell);
        await expect(fixture("preflight", {})).rejects.toThrow(`hyper-v-library-fixture-${code}`);
    });
});

function fakeScenario(options: {
    createFailure?: Error;
    inspectFailure?: Error;
    cleanupFailure?: Error;
    transitionDelayInspections?: number;
    onCreate?: () => void;
    onCleanup?: () => void;
    crossKindControllerDuplicate?: boolean;
    unconfirmedOnStart?: boolean;
} = {}) {
    const calls: string[] = [];
    let attached = false;
    let state = "Off";
    let targetState: string | null = null;
    let remainingTransitionInspections = 0;
    let removed = false;
    let checkpoint: {
        id: string; name: string; vmId: string; vmName: string; snapshotType: string;
        parentSnapshotId: string | null; parentSnapshotName: string | null; creationTimeMilliseconds: number;
    } | null = null;
    let publicRunner: ((request: any, context: any) => Promise<any>) | null = null;
    const token = "0123456789abcdef0123456789abcdef";
    const vmId = "01234567-89ab-cdef-0123-456789abcdef";
    let fixtureRoot = "";
    let fixtureVhds: readonly string[] = [];
    const fixtureOperation = vi.fn(async (operation: string, input: Record<string, unknown>) => {
        calls.push(`fixture:${operation}`);
        if (operation === "preflight") return { ready: true };
        if (operation === "create") {
            if (options.createFailure) throw options.createFailure;
            fixtureRoot = String(input.root);
            fixtureVhds = [join(fixtureRoot, "disk-1.vhdx"), join(fixtureRoot, "disk-2.vhdx")];
            options.onCreate?.();
            return { ...input, vmId, vhdPaths: fixtureVhds };
        }
        if (operation === "attach") {
            attached = true;
            return { attached: true };
        }
        if (operation === "cleanup") {
            options.onCleanup?.();
            if (options.cleanupFailure) throw options.cleanupFailure;
            return { cleaned: true };
        }
        throw new Error("unexpected-fixture-operation");
    });
    const inspection = () => {
        if (options.inspectFailure) throw options.inspectFailure;
        if (targetState !== null) {
            if (remainingTransitionInspections > 0) remainingTransitionInspections -= 1;
            else {
                state = targetState;
                targetState = null;
            }
        }
        const vm = {
            id: vmId,
            name: `ccc-hyper-v-library-real-${token}`,
            state,
            notes: `ccc-hyper-v-windows-library-real:${token}`,
        };
        return {
            virtualMachines: removed ? [] : [vm],
            hardDiskDrives: !attached || removed ? [] : fixtureVhds.map((path, index) => ({
                vmId,
                vmName: vm.name,
                path,
                controllerType: "SCSI",
                controllerNumber: 0,
                controllerLocation: index,
            })),
            dvdDrives: !attached || removed ? [] : [0, 1].map((index) => ({
                vmId,
                vmName: vm.name,
                path: null,
                controllerType: "SCSI",
                controllerNumber: options.crossKindControllerDuplicate && index === 0 ? 0 : 1,
                controllerLocation: index,
            })),
        };
    };
    const client = {
        getVM: vi.fn(async (selector: { kind: string; id?: string; name?: string }) => {
            calls.push(`client:get:${selector.kind}`);
            if (removed) return [];
            return inspection().virtualMachines;
        }),
        startVM: vi.fn(async () => {
            calls.push("client:start");
            if (options.unconfirmedOnStart) {
                await publicRunner?.(request, context);
            }
            targetState = "Running";
            remainingTransitionInspections = options.transitionDelayInspections ?? 0;
        }),
        stopVM: vi.fn(async () => {
            calls.push("client:stop");
            targetState = "Off";
            remainingTransitionInspections = options.transitionDelayInspections ?? 0;
        }),
        removeVM: vi.fn(async () => { calls.push("client:remove"); removed = true; }),
        getVMSnapshots: vi.fn(async () => {
            calls.push("client:snapshots");
            return checkpoint ? [checkpoint] : [];
        }),
        checkpointVM: vi.fn(async (request: { snapshotName: string }) => {
            calls.push("client:checkpoint");
            checkpoint = {
                id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                name: request.snapshotName,
                vmId,
                vmName: inspection().virtualMachines[0]?.name ?? "",
                snapshotType: "Production",
                parentSnapshotId: null,
                parentSnapshotName: null,
                creationTimeMilliseconds: 1_700_000_000_000,
            };
            return checkpoint;
        }),
        restoreVMSnapshot: vi.fn(async () => { calls.push("client:snapshot-restore"); }),
        removeVMSnapshot: vi.fn(async () => { calls.push("client:snapshot-remove"); checkpoint = null; }),
    };
    const library = {
        createHyperVWindowsPowerShellExecutor: vi.fn((executorOptions: { run: typeof publicRunner }) => {
            publicRunner = executorOptions.run;
            return { execute: vi.fn() };
        }),
        createHyperVWindowsClient: vi.fn(() => client),
        inspectHyperVVirtualMachine: vi.fn(async (_client: unknown, _selector: unknown, callOptions?: { signal?: AbortSignal }) => {
            calls.push("library:inspect");
            if (callOptions?.signal?.aborted) throw new Error("scenario-aborted");
            return inspection();
        }),
        reconcileHyperVVirtualMachine: vi.fn((current: ReturnType<typeof inspection>, expected: any, intent: string) => {
            calls.push(`library:reconcile:${intent}`);
            const vm = current.virtualMachines[0];
            if (!vm) return { kind: "absent" };
            if (vm.notes !== expected.notes) return { kind: "identity-conflict", reason: "notes-mismatch" };
            const unexpected = current.hardDiskDrives.filter((drive) => !expected.attachments.allowedPaths.includes(drive.path));
            if (unexpected.length > 0) return { kind: "attachment-conflict", unexpectedAttachments: unexpected };
            if (intent === "remove") return { kind: "pending", action: "remove" };
            const desired = intent === "start" ? "Running" : "Off";
            return vm.state === desired
                ? { kind: "settled", drift: { missingExpectedPaths: [] } }
                : { kind: "pending", action: intent };
        }),
        retryHyperVLifecycle: vi.fn(async (operation: () => Promise<any>, retryOptions: { maxAttempts: number }) => {
            calls.push("library:retry");
            let outcome: any = null;
            for (let attempt = 1; attempt <= retryOptions.maxAttempts; attempt += 1) {
                outcome = await operation();
                if (outcome.kind !== "pending") return outcome;
            }
            return outcome;
        }),
    };
    return { calls, fixtureOperation, library, token, fixtureVhds: () => fixtureVhds };
}

describe("standalone compiled-library scenario", () => {
    it.each([
        ["invalid VM GUID", "not-a-guid", (root: string) => [join(root, "disk-1.vhdx"), join(root, "disk-2.vhdx")], "vm-id-invalid"],
        ["duplicate VHD paths", "01234567-89ab-cdef-0123-456789abcdef", (root: string) => [join(root, "disk-1.vhdx"), join(root, "disk-1.vhdx")], "identity-invalid"],
    ])("rejects a create response with %s and cleans using the provisional fence", async (_label, vmId, vhdPaths, errorCode) => {
        const token = "0123456789abcdef0123456789abcdef";
        const calls: string[] = [];
        const fixtureOperation = vi.fn(async (operation: string, input: Record<string, unknown>) => {
            calls.push(operation);
            if (operation === "preflight") return { ready: true };
            if (operation === "create") return { ...input, vmId, vhdPaths: vhdPaths(String(input.root)) };
            if (operation === "cleanup") return { cleaned: true };
            throw new Error("unexpected-fixture-operation");
        });
        await expect(runHyperVWindowsLibraryScenario({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            randomToken: () => token,
            temporaryDirectory: "C:\\Temp",
            fixtureOperation,
            importLibraryImpl: vi.fn(),
        })).rejects.toThrow(`hyper-v-library-fixture-${errorCode}`);
        expect(calls).toEqual(["preflight", "create", "cleanup"]);
        expect(fixtureOperation).toHaveBeenLastCalledWith(
            "cleanup",
            expect.objectContaining({ vmId: "", vhdPaths: expect.any(Array) }),
            undefined,
        );
    });

    it("runs observations, lifecycle mutations, retention proof, and cleanup in order", async () => {
        const fake = fakeScenario();
        const existenceChecks: string[] = [];
        const steps = await runHyperVWindowsLibraryScenario({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            randomToken: () => fake.token,
            temporaryDirectory: "C:\\Temp",
            fixtureOperation: fake.fixtureOperation,
            importLibraryImpl: async () => fake.library as any,
            fileExists: async (path) => {
                fake.calls.push(`fileExists:${path}`);
                existenceChecks.push(path);
                return true;
            },
            sleeper: async () => undefined,
        });

        expect(steps).toHaveLength(10);
        expect(fake.calls.filter((call) => call.startsWith("fixture:"))).toEqual([
            "fixture:preflight",
            "fixture:create",
            "fixture:attach",
            "fixture:cleanup",
        ]);
        expect(fake.calls.filter((call) => call.startsWith("client:"))).toEqual([
            "client:start",
            "client:stop",
            "client:snapshots",
            "client:checkpoint",
            "client:snapshots",
            "client:snapshot-restore",
            "client:snapshot-remove",
            "client:snapshots",
            "client:remove",
            "client:get:id",
            "client:get:name",
        ]);
        expect(existenceChecks).toEqual(fake.fixtureVhds());
        expect(fake.calls.indexOf("client:remove")).toBeLessThan(fake.calls.indexOf("fixture:cleanup"));
        expect(Math.max(...fake.calls.map((call, index) => call.startsWith("fileExists:") ? index : -1)))
            .toBeLessThan(fake.calls.indexOf("fixture:cleanup"));
        expect(fake.library.createHyperVWindowsPowerShellExecutor).toHaveBeenCalledTimes(1);
        expect(fake.library.createHyperVWindowsClient).toHaveBeenCalledTimes(1);
        expect(fake.library.retryHyperVLifecycle).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ maxAttempts: 40 }));
    });

    it("rejects a controller slot duplicated across HDD and DVD collections", async () => {
        const fake = fakeScenario({ crossKindControllerDuplicate: true });
        await expect(runHyperVWindowsLibraryScenario({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            randomToken: () => fake.token,
            temporaryDirectory: "C:\\Temp",
            fixtureOperation: fake.fixtureOperation,
            importLibraryImpl: async () => fake.library as any,
        })).rejects.toThrow("hyper-v-library-controller-location-duplicate");
        expect(fake.calls.at(-1)).toBe("fixture:cleanup");
        expect(fake.calls).not.toContain("client:start");
    });

    it("refuses fixture cleanup when child-process termination was not confirmed", async () => {
        const fake = fakeScenario({ unconfirmedOnStart: true });
        await expect(runHyperVWindowsLibraryScenario({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            randomToken: () => fake.token,
            temporaryDirectory: "C:\\Temp",
            fixtureOperation: fake.fixtureOperation,
            importLibraryImpl: async () => fake.library as any,
            runner: async () => ({
                status: null,
                stdout: "",
                error: "powershell-termination-unconfirmed",
                terminationUnconfirmed: true,
            }),
            fileExists: async () => true,
        })).rejects.toThrow("hyper-v-library-cleanup-refused-process-termination-unconfirmed");
        expect(fake.calls).not.toContain("fixture:cleanup");
    });

    it("keeps polling through delayed native transitions", async () => {
        const fake = fakeScenario({ transitionDelayInspections: 2 });
        await runHyperVWindowsLibraryScenario({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            randomToken: () => fake.token,
            temporaryDirectory: "C:\\Temp",
            fixtureOperation: fake.fixtureOperation,
            importLibraryImpl: async () => fake.library as any,
            fileExists: async () => true,
            sleeper: async () => undefined,
        });
        expect(fake.calls.filter((call) => call === "library:inspect").length).toBeGreaterThanOrEqual(10);
    });

    it("fails and cleans up when a native transition exceeds the retry bound", async () => {
        const fake = fakeScenario({ transitionDelayInspections: 100 });
        await expect(runHyperVWindowsLibraryScenario({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            randomToken: () => fake.token,
            temporaryDirectory: "C:\\Temp",
            fixtureOperation: fake.fixtureOperation,
            importLibraryImpl: async () => fake.library as any,
            fileExists: async () => true,
            sleeper: async () => undefined,
        })).rejects.toThrow("hyper-v-library-start-did-not-settle");
        expect(fake.calls.filter((call) => call === "library:inspect")).toHaveLength(42);
        expect(fake.calls.at(-1)).toBe("fixture:cleanup");
    });

    it("attempts cleanup after a scenario failure", async () => {
        const fake = fakeScenario({ inspectFailure: new Error("inspection-failed") });
        await expect(runHyperVWindowsLibraryScenario({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            randomToken: () => fake.token,
            temporaryDirectory: "C:\\Temp",
            fixtureOperation: fake.fixtureOperation,
            importLibraryImpl: async () => fake.library as any,
        })).rejects.toThrow("inspection-failed");
        expect(fake.fixtureOperation).toHaveBeenLastCalledWith(
            "cleanup",
            expect.objectContaining({ token: fake.token }),
            undefined,
        );
    });

    it("attempts guarded cleanup with deterministic identity when create transport fails", async () => {
        const fake = fakeScenario({ createFailure: new Error("create-transport-failed") });
        await expect(runHyperVWindowsLibraryScenario({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            randomToken: () => fake.token,
            temporaryDirectory: "C:\\Temp",
            fixtureOperation: fake.fixtureOperation,
            importLibraryImpl: async () => fake.library as any,
        })).rejects.toThrow("create-transport-failed");
        expect(fake.fixtureOperation).toHaveBeenLastCalledWith(
            "cleanup",
            expect.objectContaining({ token: fake.token, vmId: "", vhdPaths: expect.any(Array) }),
            undefined,
        );
    });

    it("makes cleanup failure terminal and retains the original failure", async () => {
        const fake = fakeScenario({
            inspectFailure: new Error("inspection-failed"),
            cleanupFailure: new Error("cleanup-refused"),
        });
        await expect(runHyperVWindowsLibraryScenario({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            randomToken: () => fake.token,
            temporaryDirectory: "C:\\Temp",
            fixtureOperation: fake.fixtureOperation,
            importLibraryImpl: async () => fake.library as any,
        })).rejects.toThrow("scenario failed: inspection-failed; cleanup failed: cleanup-refused");
    });

    it("propagates external cancellation and still performs guarded cleanup", async () => {
        const controller = new AbortController();
        const fake = fakeScenario({ onCreate: () => controller.abort() });
        await expect(runHyperVWindowsLibraryScenario({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            signal: controller.signal,
            randomToken: () => fake.token,
            temporaryDirectory: "C:\\Temp",
            fixtureOperation: fake.fixtureOperation,
            importLibraryImpl: async () => fake.library as any,
        })).rejects.toThrow();
        expect(fake.fixtureOperation).toHaveBeenLastCalledWith("cleanup", expect.any(Object), undefined);
    });

    it("fails after successful cleanup when cancellation arrives during cleanup", async () => {
        const controller = new AbortController();
        const fake = fakeScenario({ onCleanup: () => controller.abort() });
        await expect(runHyperVWindowsLibraryScenario({
            platform: "win32",
            windowsSystemRoot: TEST_WINDOWS_ROOT,
            signal: controller.signal,
            randomToken: () => fake.token,
            temporaryDirectory: "C:\\Temp",
            fixtureOperation: fake.fixtureOperation,
            importLibraryImpl: async () => fake.library as any,
            fileExists: async () => true,
        })).rejects.toThrow("hyper-v-library-scenario-cancelled");
        expect(fake.calls.at(-1)).toBe("fixture:cleanup");
    });

    it("rejects non-Windows hosts before fixture or library work", async () => {
        const fixtureOperation = vi.fn();
        const importLibraryImpl = vi.fn();
        await expect(runHyperVWindowsLibraryScenario({
            platform: "linux",
            fixtureOperation,
            importLibraryImpl,
        })).rejects.toThrow("windows-required");
        expect(fixtureOperation).not.toHaveBeenCalled();
        expect(importLibraryImpl).not.toHaveBeenCalled();
    });
});

describe("standalone launcher and boundary", () => {
    it("reports explicit non-Windows SKIP", async () => {
        const sink = output();
        await expect(runHyperVWindowsLibraryLevel3({
            platform: "linux",
            stdout: sink.stdout as any,
            stderr: sink.stderr as any,
        })).resolves.toBe(0);
        expect(sink.read().stdout).toContain("SKIP level 3 Hyper-V Windows library real-host test");
        expect(sink.read().stdout).toContain("pass=0 skip=1 fail=0");
    });

    it("uses the exclusive lock and fails Windows scenario errors", async () => {
        const sink = output();
        const exclusive = vi.fn(async (_label, operation) => operation());
        await expect(runHyperVWindowsLibraryLevel3({
            platform: "win32",
            stdout: sink.stdout as any,
            stderr: sink.stderr as any,
            withExclusiveRealProviderRunImpl: exclusive as any,
            runScenarioImpl: async () => { throw new Error("administrator-required"); },
        })).resolves.toBe(1);
        expect(exclusive).toHaveBeenCalledTimes(1);
        expect(sink.read().stderr).toContain("FAIL level 3 Hyper-V Windows library real-host test: administrator-required");
    });

    it("coordinates with the shared real-provider lock without a Device Lab import", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-hyper-v-library-lock-"));
        try {
            await expect(withExclusiveHyperVLibraryRun(async () => "done", { home })).resolves.toBe("done");
            const lockFile = join(home, ".ccc", "devices", "test-runs", "real-provider.lock");
            expect(() => readFileSync(lockFile)).toThrow();

            writeFileSync(lockFile, JSON.stringify({
                token: "0123456789abcdef0123456789abcdef",
                pid: process.pid,
                host: (await import("os")).hostname(),
                createdAt: "2026-08-31T00:00:00.000Z",
            }));
            await expect(withExclusiveHyperVLibraryRun(async () => "unsafe", { home }))
                .rejects.toThrow("real-provider-test-already-running");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("loads only the compiled public root and keeps fixture work setup/cleanup-only", () => {
        const root = dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(join(root, "hyper-v-windows-library-real.ts"), "utf8");
        const launcher = readFileSync(join(root, "hyper-v-windows-library.ts"), "utf8");
        const fixture = readFileSync(join(root, "hyper-v-windows-library-fixture.ps1"), "utf8");
        expect(source).toMatch(/"dist",\s*"hyper-v-windows",\s*"index\.js"/);
        expect(source).toContain("process.env.ProgramData");
        expect(source).toContain("GLOBALROOT\\\\SystemRoot");
        expect(source).not.toContain("process.env.SystemRoot");
        expect(source).not.toContain("tmpdir()");
        expect(source).not.toMatch(/from\s+["'][^"']*src\//);
        expect(`${source}\n${launcher}`).not.toMatch(/device-lab|device_lab|broker|mcp/i);
        expect(fixture).toContain('"preflight" { Invoke-Preflight }');
        expect(fixture).toContain('"create" { Invoke-Create $Request }');
        expect(fixture).toContain('"attach" { Invoke-Attach $Request }');
        expect(fixture).toContain('"cleanup" { Invoke-Cleanup $Request }');
        expect(fixture).not.toMatch(/"Start-VM"\s*\{/);
        expect(fixture).not.toMatch(/"Get-VMHardDiskDrive"\s*\{/);
        expect(fixture).toContain("pathless-hard-disk-refused");
        expect(fixture).toMatch(/if \(\[string\]::IsNullOrWhiteSpace\(\[string\]\$Marker\.vmId\)\) \{\s*throw "marker-vm-id-missing"\s*\}/);
        expect(fixture).toContain("unexpected-fixture-content");
        expect(fixture).toContain('[Environment]::GetFolderPath("CommonApplicationData")');
        expect(fixture).toContain('Import-Module -Name $ModulePath -Force -PassThru');
        expect(fixture).toContain("Resolve-TrustedHyperVModulePath");
        expect(fixture).toContain("Get-ChildItem -LiteralPath $ModuleRoot -Directory");
        expect(fixture).toContain("[Version]$VersionDirectory.Name");
        expect(fixture).toContain("[string]$_.ModuleBase");
        expect(fixture).toContain("[IO.FileAttributes]::ReparsePoint");
        expect(fixture).toContain('Hyper-V\\New-VM');
        expect(fixture).toContain('catch { throw "new-vm-failed" }');
        expect(fixture).toContain('catch { throw "new-vhd-failed" }');
        expect(fixture).toContain('catch { throw "add-vm-hard-disk-failed" }');
        expect(fixture).toContain('catch { throw "add-vm-dvd-failed" }');
        expect(fixture).toContain('catch { throw "fixture-integrity-tool-failed" }');
        expect(fixture).not.toContain("function Invoke-NativeStage");
        expect(fixture).toContain("$DeclaredFixtureErrorCodes.Contains($ErrorCode)");
        expect(fixture).not.toContain("$_.FullyQualifiedErrorId");
        expect(fixture).toContain('"cleanup" { "cleanup-failed" }');
        expect(fixture).toContain('Hyper-V\\Remove-VM');
        expect(fixture).toContain('$RawRequest = [string]$global:CccHyperVJsonInput');
        expect(fixture).toContain('[IO.Directory]::Move($Staging, $Parent)');
        expect(fixture).not.toContain('Protect-FixtureDirectory $Parent');
        expect(fixture).toContain('"/setintegritylevel" "(OI)(CI)H"');
        expect(fixture).toContain("GetNamedSecurityInfo");
        expect(fixture).toContain("$LabelSecurityInformation = [uint32]0x00000010");
        expect(fixture).toContain("ConvertSecurityDescriptorToStringSecurityDescriptor");
        expect(fixture).toContain("LocalFree($Descriptor)");
        expect(fixture).not.toContain("Get-Acl -LiteralPath $Path -Audit");
        expect(fixture).toContain('[Security.AccessControl.DirectorySecurity]::new()');
        expect(fixture).toContain('$Security.SetAccessRuleProtection($true, $false)');
        expect(fixture).not.toMatch(/^\s+-(?:or|and)\b/m);
        expect(fixture).toContain('[IO.Directory]::SetAccessControl($Path, $Security)');
        expect(fixture).toContain('if (-not $Acl.AreAccessRulesProtected)');
        expect(fixture).toContain('@("S-1-5-18", "S-1-5-32-544")');
        expect(fixture).toContain("Assert-RestrictedDirectoryDacl $Root");
        expect(fixture).toContain("Assert-ProtectedFixtureRoot $Root");
        expect(fixture).toContain("Assert-FixtureCleanupBoundary $Root");
        expect(fixture).not.toMatch(/Get-VM\s+-Name/);
        expect(fixture).not.toMatch(/Remove-Item[^\n]+-Recurse/);
        const missingRootBranch = fixture.slice(
            fixture.indexOf('if (-not (Test-Path -LiteralPath $Root -PathType Container)) {', fixture.indexOf("function Invoke-Cleanup")),
            fixture.indexOf("Assert-NoReparsePoint $Root", fixture.indexOf("function Invoke-Cleanup")),
        );
        expect(missingRootBranch).not.toContain("cleanup-identity-incomplete");
        expect(missingRootBranch).toContain("vm-name-present-without-id");
        expect(missingRootBranch).toContain("return [ordered]@{ cleaned = $true }");
        expect(missingRootBranch).toContain("Get-VMByExactId");
        expect(missingRootBranch).toContain("Get-VMByExactName");
        expect(fixture.lastIndexOf("Assert-ProtectedFixtureRoot $Root"))
            .toBeLessThan(fixture.lastIndexOf("Remove-Item -LiteralPath $Root"));
        const cleanup = fixture.slice(fixture.indexOf("function Invoke-Cleanup"));
        expect(cleanup.indexOf("Assert-FixtureCleanupBoundary $Root"))
            .toBeLessThan(cleanup.indexOf("$Marker = Get-FixtureMarker $Request"));
        expect(cleanup.lastIndexOf("Assert-FixtureCleanupBoundary $Root"))
            .toBeLessThan(cleanup.lastIndexOf("Protect-FixtureDirectory $Root"));
        expect(cleanup.lastIndexOf("Protect-FixtureDirectory $Root"))
            .toBeLessThan(cleanup.lastIndexOf("Remove-Item -LiteralPath $File"));
        const guardedCleanupComment = "# The Node scenario always invokes the guarded cleanup operation after a";
        const createFailureRollback = fixture.slice(
            fixture.indexOf(guardedCleanupComment, fixture.indexOf("function Invoke-Create")),
            fixture.indexOf("function Invoke-Attach"),
        );
        expect(createFailureRollback).toContain(guardedCleanupComment);
        expect(createFailureRollback).not.toMatch(/Remove-(?:VM|Item)/);
        expect(verifiedHyperVWindowsLibraryFixturePath()).toBe(join(root, "hyper-v-windows-library-fixture.ps1"));
        expect(HYPER_V_WINDOWS_LIBRARY_FIXTURE_SHA256).toHaveLength(64);
    });

    it("loads the built public library entrypoint without a source import", async () => {
        const library = await loadHyperVWindowsLibrary();
        expect(library).toMatchObject({
            createHyperVWindowsPowerShellExecutor: expect.any(Function),
            createHyperVWindowsClient: expect.any(Function),
            inspectHyperVVirtualMachine: expect.any(Function),
            reconcileHyperVVirtualMachine: expect.any(Function),
            retryHyperVLifecycle: expect.any(Function),
        });
    });
});
