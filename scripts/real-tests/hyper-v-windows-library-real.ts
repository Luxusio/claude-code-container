import { spawn, spawnSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import { lstatSync, readFileSync, realpathSync } from "fs";
import { access } from "fs/promises";
import { dirname, isAbsolute, join, relative, sep, win32 } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const PROCESS_OUTPUT_LIMIT_BYTES = 64 * 1024;
const PROCESS_INPUT_LIMIT_BYTES = 256 * 1024;
const PROCESS_TIMEOUT_MILLISECONDS = 120 * 1000;
const SCENARIO_TIMEOUT_MILLISECONDS = 5 * 60 * 1000;
const STATE_ATTEMPTS = 40;
const STATE_DELAY_MILLISECONDS = 500;
const FIXTURE_PARENT_NAME = "ccc-hyper-v-windows-library-real";
const VM_NAME_PREFIX = "ccc-hyper-v-library-real-";
const NOTES_PREFIX = "ccc-hyper-v-windows-library-real:";
const WINDOWS_SYSTEM_ROOT_ALIAS = "\\\\?\\GLOBALROOT\\SystemRoot";
export const HYPER_V_WINDOWS_LIBRARY_FIXTURE_SHA256 = "9ca5140b9cd9498b8bb2de76b6edff6f954660ed790630cb12240421c2791813";
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATIVE_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// A copy, because this lane must not import from src/ — it exists to exercise the compiled public
// root, and the boundary test enforces that. So the copy is checked against the library's own
// exported constant at scenario start instead: it silently diverged once already, keeping the
// pre-v4 shape after the pinned asset stopped calling exit and moved its failure onto
// $global:CccHyperVExitCode, which had this lane claiming v4 conformance while driving the asset
// through a v3 bootstrap.
export const POWERSHELL_MEMORY_BOOTSTRAP = [
    "$EnvelopeJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))",
    "$Envelope = $EnvelopeJson | ConvertFrom-Json -ErrorAction Stop",
    "$global:CccHyperVJsonInput = [string]$Envelope.input",
    "& ([ScriptBlock]::Create([string]$Envelope.script))",
    "if ($global:CccHyperVExitCode) { exit [int]$global:CccHyperVExitCode }",
].join("; ");
const FIXTURE_RESULT_MARKER = "CCC_HYPER_V_WINDOWS_LIBRARY_FIXTURE_RESULT:";

export type PowerShellFileRequest = {
    readonly executable: string;
    readonly scriptPath: string;
    readonly scriptSource: string;
    readonly input: string;
};

export type PowerShellExecutionContext = {
    readonly timeoutMilliseconds: number;
    readonly maximumOutputBytes: number;
    readonly signal?: AbortSignal;
};

export type PowerShellExecutionResult = {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr?: string;
    readonly error?: string;
    readonly timedOut?: boolean;
    readonly cancelled?: boolean;
    readonly outputLimitExceeded?: boolean;
    readonly terminationUnconfirmed?: boolean;
};

type ChildLike = {
    readonly pid?: number;
    readonly stdout: NodeJS.ReadableStream | null;
    readonly stderr: NodeJS.ReadableStream | null;
    readonly stdin: NodeJS.WritableStream | null;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    once(event: "error", listener: (error: Error) => void): ChildLike;
    once(event: "close", listener: (status: number | null) => void): ChildLike;
    removeListener(event: "error", listener: (error: Error) => void): ChildLike;
    removeListener(event: "close", listener: (status: number | null) => void): ChildLike;
    kill(signal?: NodeJS.Signals): boolean;
};

export type BoundedPowerShellRunnerDependencies = {
    readonly platform?: NodeJS.Platform;
    readonly spawnImpl?: (command: string, args: readonly string[], options: Record<string, unknown>) => ChildLike;
    readonly taskkillImpl?: (command: string, args: readonly string[], options: Record<string, unknown>) => unknown;
    readonly processIdentityImpl?: (executable: string, pid: number) => string | null;
    readonly windowsSystemRoot?: string;
    readonly terminationGraceMilliseconds?: number;
};

export type TrustedWindowsSystemExecutables = {
    readonly powershell: string;
    readonly taskkill: string;
};

export function resolveTrustedWindowsSystemExecutables(
    systemRoot?: string,
): TrustedWindowsSystemExecutables {
    let resolvedRoot: string;
    try {
        resolvedRoot = systemRoot ?? realpathSync.native(WINDOWS_SYSTEM_ROOT_ALIAS);
    } catch {
        throw new Error("hyper-v-library-windows-system-root-invalid");
    }
    const normalizedRoot = win32.normalize(resolvedRoot);
    if (!win32.isAbsolute(normalizedRoot) || normalizedRoot === win32.parse(normalizedRoot).root) {
        throw new Error("hyper-v-library-windows-system-root-invalid");
    }
    const system32 = win32.join(normalizedRoot, "System32");
    return {
        powershell: win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
        taskkill: win32.join(system32, "taskkill.exe"),
    };
}

function isInside(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function verifiedHyperVWindowsLibraryFixture(): { readonly scriptPath: string; readonly scriptSource: string } {
    const packageRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
    const fixtureRoot = realpathSync(join(packageRoot, "scripts", "real-tests"));
    const fixturePath = realpathSync(join(fixtureRoot, "hyper-v-windows-library-fixture.ps1"));
    if (!isInside(fixtureRoot, fixturePath) || !lstatSync(fixturePath).isFile()) {
        throw new Error("hyper-v-library-fixture-asset-invalid");
    }
    const source = readFileSync(fixturePath);
    const digest = createHash("sha256").update(source).digest("hex");
    if (digest !== HYPER_V_WINDOWS_LIBRARY_FIXTURE_SHA256) {
        throw new Error("hyper-v-library-fixture-asset-integrity-failed");
    }
    return { scriptPath: fixturePath, scriptSource: source.toString("utf8") };
}

export function verifiedHyperVWindowsLibraryFixturePath(): string {
    return verifiedHyperVWindowsLibraryFixture().scriptPath;
}

function resultRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function windowsProcessIdentity(executable: string, pid: number): string | null {
    const result = spawnSync(executable, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$Process = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($Process.StartTime.ToUniversalTime().Ticks)`,
    ], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    const identity = String(result.stdout ?? "").trim();
    return result.status === 0 && /^\d{10,20}$/.test(identity) ? identity : null;
}

function terminateChildTree(
    child: ChildLike,
    dependencies: BoundedPowerShellRunnerDependencies,
    executable: string,
    expectedIdentity: string | null,
    processIdentity: (executable: string, pid: number) => string | null,
    taskkillExecutable: string,
): boolean {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    const platform = dependencies.platform ?? process.platform;
    if (platform === "win32" && Number.isInteger(child.pid)) {
        const identity = processIdentity(executable, child.pid as number);
        if (expectedIdentity !== null && identity === expectedIdentity) {
            try {
                const killed = (dependencies.taskkillImpl ?? spawnSync)(
                    taskkillExecutable,
                    ["/pid", String(child.pid), "/t", "/f"],
                    { stdio: "ignore", windowsHide: true, timeout: 5000 },
                );
                const outcome = resultRecord(killed);
                if (outcome?.status === 0 && !outcome.error) return true;
            } catch {
                // Fall through to the captured process handle.
            }
        }
        try {
            child.kill("SIGKILL");
            return false;
        } catch {
            return false;
        }
    }
    try {
        if (Number.isInteger(child.pid)) {
            process.kill(-(child.pid as number), "SIGKILL");
            return true;
        }
        return child.kill("SIGKILL");
    } catch {
        try {
            return child.kill("SIGKILL");
        } catch {
            return false;
        }
    }
}

export function createBoundedPowerShellFileRunner(
    dependencies: BoundedPowerShellRunnerDependencies = {},
): (request: PowerShellFileRequest, context: PowerShellExecutionContext) => Promise<PowerShellExecutionResult> {
    return async (request, context) => {
        if (context.signal?.aborted) {
            return { status: null, stdout: "", cancelled: true };
        }

        const platform = dependencies.platform ?? process.platform;
        let taskkillExecutable = "";
        if (platform === "win32") {
            let trusted: TrustedWindowsSystemExecutables;
            try {
                trusted = resolveTrustedWindowsSystemExecutables(dependencies.windowsSystemRoot);
            } catch {
                return { status: null, stdout: "", error: "windows-system-root-invalid" };
            }
            if (win32.normalize(request.executable).toLowerCase() !== trusted.powershell.toLowerCase()) {
                return { status: null, stdout: "", error: "powershell-executable-untrusted" };
            }
            taskkillExecutable = trusted.taskkill;
        }

        const outputLimit = Math.max(1, context.maximumOutputBytes);
        const processInput = Buffer.from(
            JSON.stringify({ script: request.scriptSource, input: request.input }),
            "utf8",
        ).toString("base64");
        if (Buffer.byteLength(processInput, "utf8") > PROCESS_INPUT_LIMIT_BYTES) {
            return { status: null, stdout: "", error: "powershell-input-limit-exceeded" };
        }
        const spawnImpl = dependencies.spawnImpl ?? ((command, args, options) => spawn(
            command,
            [...args],
            options,
        ) as unknown as ChildLike);
        let child: ChildLike;
        try {
            child = spawnImpl(request.executable, [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                POWERSHELL_MEMORY_BOOTSTRAP,
            ], {
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                detached: (dependencies.platform ?? process.platform) !== "win32",
            });
        } catch {
            return { status: null, stdout: "", error: "powershell-spawn-failed" };
        }
        const processIdentity = dependencies.processIdentityImpl
            ?? (process.platform === "win32" ? windowsProcessIdentity : (_executable, pid) => `test-process-${pid}`);
        const expectedProcessIdentity = platform === "win32" && Number.isInteger(child.pid)
            ? processIdentity(request.executable, child.pid as number)
            : null;

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let capturedBytes = 0;
        let timedOut = false;
        let cancelled = false;
        let outputLimitExceeded = false;
        let treeTerminationRequested = false;
        let treeTerminationConfirmed = false;
        let terminationUnconfirmed = false;
        let terminationGraceTimer: NodeJS.Timeout | null = null;

        let settleOutcome: (value: { status: number | null; spawnError: boolean }) => void = () => undefined;
        const terminate = () => {
            if (treeTerminationRequested) return;
            treeTerminationRequested = true;
            treeTerminationConfirmed = terminateChildTree(
                child,
                dependencies,
                request.executable,
                expectedProcessIdentity,
                processIdentity,
                taskkillExecutable,
            );
            terminationGraceTimer = setTimeout(() => {
                terminationUnconfirmed = true;
                settleOutcome({ status: null, spawnError: false });
            }, dependencies.terminationGraceMilliseconds ?? 5000);
        };
        const append = (destination: Buffer[], chunk: unknown) => {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
            const remaining = Math.max(0, outputLimit - capturedBytes);
            if (remaining > 0) destination.push(value.subarray(0, remaining));
            capturedBytes += value.length;
            if (capturedBytes > outputLimit) {
                outputLimitExceeded = true;
                terminate();
            }
        };
        const onStdout = (chunk: unknown) => append(stdout, chunk);
        const onStderr = (chunk: unknown) => append(stderr, chunk);
        const onStdinError = () => undefined;
        child.stdout?.on("data", onStdout);
        child.stderr?.on("data", onStderr);
        child.stdin?.on("error", onStdinError);

        let onChildError: (error: Error) => void = () => undefined;
        let onChildClose: (status: number | null) => void = () => undefined;
        const outcomePromise = new Promise<{ status: number | null; spawnError: boolean }>((resolve) => {
            let settled = false;
            settleOutcome = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            onChildError = () => {
                if (treeTerminationRequested) terminationUnconfirmed = true;
                settleOutcome({ status: null, spawnError: true });
            };
            onChildClose = (status) => {
                if (treeTerminationRequested && !treeTerminationConfirmed) terminationUnconfirmed = true;
                settleOutcome({ status, spawnError: false });
            };
            child.once("error", onChildError);
            child.once("close", onChildClose);
        });

        const onAbort = () => {
            cancelled = true;
            terminate();
        };
        context.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => {
            timedOut = true;
            terminate();
        }, context.timeoutMilliseconds);

        try {
            child.stdin?.end(processInput);
        } catch {
            settleOutcome({ status: null, spawnError: true });
        }
        const outcome = await outcomePromise;

        clearTimeout(timer);
        if (terminationGraceTimer) clearTimeout(terminationGraceTimer);
        context.signal?.removeEventListener("abort", onAbort);
        child.stdout?.off("data", onStdout);
        child.stderr?.off("data", onStderr);
        child.stdin?.off("error", onStdinError);
        child.removeListener("error", onChildError);
        child.removeListener("close", onChildClose);
        const result: PowerShellExecutionResult = {
            status: outcome.status,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            ...(terminationUnconfirmed
                ? { error: "powershell-termination-unconfirmed", terminationUnconfirmed: true }
                : outcome.spawnError ? { error: "powershell-spawn-failed" } : {}),
            ...(timedOut ? { timedOut: true } : {}),
            ...(cancelled ? { cancelled: true } : {}),
            ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
        };
        return result;
    };
}

type Fixture = {
    readonly token: string;
    readonly root: string;
    readonly markerPath: string;
    readonly vmId: string;
    readonly vmName: string;
    readonly notes: string;
    readonly vhdPaths: readonly string[];
};

export type HyperVWindowsLibraryFixtureAsset = {
    readonly scriptPath: string;
    readonly scriptSource: string;
};

type FixtureResponse = {
    readonly schemaVersion: 1;
    readonly operation: string;
    readonly ok: boolean;
    readonly result?: unknown;
    readonly errorCode?: string;
};

function decodeFixtureResponse(stdout: string): FixtureResponse {
    const frames = stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith(FIXTURE_RESULT_MARKER));
    if (frames.length === 0) throw new Error("hyper-v-library-fixture-response-marker-missing");
    if (frames.length !== 1) throw new Error("hyper-v-library-fixture-response-marker-ambiguous");
    const payload = frames[0].slice(FIXTURE_RESULT_MARKER.length);
    if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
        throw new Error("hyper-v-library-fixture-response-payload-invalid");
    }
    const bytes = Buffer.from(payload, "base64");
    if (bytes.toString("base64") !== payload) {
        throw new Error("hyper-v-library-fixture-response-payload-invalid");
    }
    let parsed: unknown;
    try {
        const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        parsed = JSON.parse(json) as unknown;
    } catch {
        throw new Error("hyper-v-library-fixture-response-malformed");
    }
    if (!record(parsed)) throw new Error("hyper-v-library-fixture-response-invalid");
    return parsed as FixtureResponse;
}

function fixtureMarkerDiagnostic(execution: PowerShellExecutionResult): string {
    const stderr = execution.stderr ?? "";
    const stderrKind = stderr.length === 0
        ? "empty"
        : /#<\s*CLIXML/i.test(stderr)
            ? "clixml"
            : /ParserError/i.test(stderr)
                ? "parser"
                : /MethodInvocationException|MethodException/i.test(stderr)
                    ? "method"
                    : /IOException/i.test(stderr)
                        ? "io"
                        : "other";
    const stdoutKind = execution.stdout.length === 0 ? "empty" : execution.stdout.includes("\0") ? "nul" : "text";
    return `[s=${execution.status ?? "null"},o=${Buffer.byteLength(execution.stdout, "utf8")},e=${Buffer.byteLength(stderr, "utf8")},ok=${stdoutKind},ek=${stderrKind}]`;
}

export type FixtureOperation = (
    operation: "preflight" | "create" | "attach" | "cleanup",
    input: Record<string, unknown>,
    signal?: AbortSignal,
) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function requiredString(value: unknown, code: string): string {
    if (typeof value !== "string" || value.length === 0) throw new Error(code);
    return value;
}

function parseFixture(value: unknown, expected: Omit<Fixture, "vmId">): Fixture {
    const item = record(value);
    if (!item || !Array.isArray(item.vhdPaths)) throw new Error("hyper-v-library-fixture-result-invalid");
    const vmId = requiredString(item.vmId, "hyper-v-library-fixture-vm-id-invalid");
    if (!GUID_PATTERN.test(vmId)) throw new Error("hyper-v-library-fixture-vm-id-invalid");
    const fixture: Fixture = {
        token: requiredString(item.token, "hyper-v-library-fixture-token-invalid"),
        root: requiredString(item.root, "hyper-v-library-fixture-root-invalid"),
        markerPath: requiredString(item.markerPath, "hyper-v-library-fixture-marker-invalid"),
        vmId: vmId.toLowerCase(),
        vmName: requiredString(item.vmName, "hyper-v-library-fixture-vm-name-invalid"),
        notes: requiredString(item.notes, "hyper-v-library-fixture-notes-invalid"),
        vhdPaths: item.vhdPaths.map((path) => requiredString(path, "hyper-v-library-fixture-vhd-path-invalid")),
    };
    if (fixture.token !== expected.token
        || fixture.root !== expected.root
        || fixture.markerPath !== expected.markerPath
        || fixture.vmName !== expected.vmName
        || fixture.notes !== expected.notes
        || fixture.vhdPaths.length !== expected.vhdPaths.length
        || new Set(fixture.vhdPaths.map(windowsPath)).size !== expected.vhdPaths.length
        || !expected.vhdPaths.every((path) => fixture.vhdPaths.some((observedPath) => windowsPath(path) === windowsPath(observedPath)))) {
        throw new Error("hyper-v-library-fixture-identity-invalid");
    }
    return fixture;
}

export function createFixtureOperation(
    runner: ReturnType<typeof createBoundedPowerShellFileRunner>,
    powershellExecutable = resolveTrustedWindowsSystemExecutables().powershell,
    embeddedAsset?: HyperVWindowsLibraryFixtureAsset,
): FixtureOperation {
    return async (operation, input, signal) => {
        const fixtureAsset = embeddedAsset ?? verifiedHyperVWindowsLibraryFixture();
        const fixtureDigest = createHash("sha256").update(fixtureAsset.scriptSource, "utf8").digest("hex");
        if (fixtureDigest !== HYPER_V_WINDOWS_LIBRARY_FIXTURE_SHA256) {
            throw new Error("hyper-v-library-fixture-asset-integrity-failed");
        }
        const execution = await runner({
            executable: powershellExecutable,
            ...fixtureAsset,
            input: `${JSON.stringify({ schemaVersion: 1, operation, ...input })}\n`,
        }, {
            timeoutMilliseconds: PROCESS_TIMEOUT_MILLISECONDS,
            maximumOutputBytes: PROCESS_OUTPUT_LIMIT_BYTES,
            ...(signal ? { signal } : {}),
        });
        if (execution.cancelled) throw new Error("hyper-v-library-fixture-cancelled");
        if (execution.timedOut) throw new Error("hyper-v-library-fixture-timeout");
        if (execution.outputLimitExceeded) throw new Error("hyper-v-library-fixture-output-limit");
        if (execution.error || execution.status === null) throw new Error("hyper-v-library-fixture-transport-failed");
        let response: FixtureResponse;
        try {
            response = decodeFixtureResponse(execution.stdout);
        } catch (error) {
            if (error instanceof Error && error.message === "hyper-v-library-fixture-response-marker-missing") {
                throw new Error(`${error.message}${fixtureMarkerDiagnostic(execution)}`);
            }
            throw error;
        }
        if (response.schemaVersion !== 1 || response.operation !== operation || typeof response.ok !== "boolean") {
            throw new Error("hyper-v-library-fixture-response-invalid");
        }
        if (!response.ok) {
            throw new Error(typeof response.errorCode === "string" && NATIVE_ERROR_CODE_PATTERN.test(response.errorCode)
                ? `hyper-v-library-fixture-${response.errorCode}`
                : "hyper-v-library-fixture-response-invalid");
        }
        if (execution.status !== 0) throw new Error("hyper-v-library-fixture-status-conflict");
        return response.result;
    };
}

export type HyperVWindowsLibraryModule = {
    createHyperVWindowsPowerShellExecutor(options: {
        executable: string;
        run: ReturnType<typeof createBoundedPowerShellFileRunner>;
    }): unknown;
    createHyperVWindowsClient(executor: unknown): HyperVClient;
    readonly HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP: string;
    inspectHyperVVirtualMachine(client: HyperVClient, selector: Selector, options?: { signal?: AbortSignal }): Promise<Inspection>;
    reconcileHyperVVirtualMachine(inspection: Inspection, expectation: Expectation, intent: Intent): Outcome;
    retryHyperVLifecycle(
        operation: (context: { attempt: number; signal?: AbortSignal }) => Promise<Outcome>,
        options: {
            maxAttempts: number;
            delayMilliseconds: number;
            signal?: AbortSignal;
            sleeper?: (delayMilliseconds: number, signal?: AbortSignal) => Promise<void> | void;
        },
    ): Promise<Outcome>;
};

type Selector = { readonly kind: "id"; readonly id: string } | { readonly kind: "name"; readonly name: string };
type Intent = "start" | "stop" | "remove";
type VM = { readonly id: string; readonly name: string; readonly state: string; readonly notes: string };
type HardDisk = { readonly vmId: string; readonly vmName: string; readonly path: string | null; readonly controllerType: string; readonly controllerNumber: number; readonly controllerLocation: number };
type Dvd = { readonly vmId: string; readonly vmName: string; readonly path: string | null; readonly controllerType: string; readonly controllerNumber: number; readonly controllerLocation: number };
type Inspection = { readonly virtualMachines: readonly VM[]; readonly hardDiskDrives: readonly HardDisk[]; readonly dvdDrives: readonly Dvd[] };
type Expectation = { readonly id: string; readonly name: string; readonly notes: string; readonly attachments: { readonly allowedPaths: readonly string[]; readonly expectedPaths?: readonly string[] } };
type Outcome = {
    readonly kind: string;
    readonly action?: string;
    readonly reason?: string;
    readonly drift?: { readonly missingExpectedPaths: readonly string[] };
    readonly unexpectedAttachments?: readonly { path: string | null }[];
};

type Snapshot = {
    readonly id: string;
    readonly name: string;
    readonly vmId: string;
    readonly vmName: string;
    readonly snapshotType: string;
    readonly parentSnapshotId: string | null;
    readonly parentSnapshotName: string | null;
    readonly creationTimeMilliseconds: number;
};

type SnapshotSelector = { kind: "id"; id: string } | { kind: "name"; name: string };

type HyperVClient = {
    getVM(selector: Selector, options?: { signal?: AbortSignal }): Promise<readonly VM[]>;
    startVM(request: { selector: Selector }, options?: { signal?: AbortSignal }): Promise<void>;
    stopVM(request: { selector: Selector; mode: "turn-off"; force: boolean }, options?: { signal?: AbortSignal }): Promise<void>;
    removeVM(request: { selector: Selector; force: boolean }, options?: { signal?: AbortSignal }): Promise<void>;
    getVMSnapshots(selector: Selector, options?: { signal?: AbortSignal }): Promise<readonly Snapshot[]>;
    checkpointVM(request: { selector: Selector; snapshotName: string }, options?: { signal?: AbortSignal }): Promise<Snapshot>;
    removeVMSnapshot(request: { selector: Selector; snapshot: SnapshotSelector }, options?: { signal?: AbortSignal }): Promise<void>;
    restoreVMSnapshot(request: { selector: Selector; snapshot: SnapshotSelector }, options?: { signal?: AbortSignal }): Promise<void>;
};

export type HyperVLibraryScenarioDependencies = {
    readonly platform?: NodeJS.Platform;
    readonly importLibraryImpl?: () => Promise<HyperVWindowsLibraryModule>;
    readonly runner?: ReturnType<typeof createBoundedPowerShellFileRunner>;
    readonly windowsSystemRoot?: string;
    readonly fixtureOperation?: FixtureOperation;
    readonly fixtureAsset?: HyperVWindowsLibraryFixtureAsset;
    readonly randomToken?: () => string;
    readonly temporaryDirectory?: string;
    readonly fileExists?: (path: string) => Promise<boolean>;
    readonly sleeper?: (delayMilliseconds: number, signal?: AbortSignal) => Promise<void> | void;
    readonly log?: (message: string) => void;
    readonly scenarioTimeoutMilliseconds?: number;
    readonly signal?: AbortSignal;
};

function assert(condition: unknown, code: string): asserts condition {
    if (!condition) throw new Error(code);
}

function windowsPath(path: string): string {
    return path.replaceAll("/", "\\").toLowerCase();
}

function controllerKeys<T extends { controllerType: string; controllerNumber: number; controllerLocation: number }>(items: readonly T[]): Set<string> {
    return new Set(items.map((item) => `${item.controllerType.toLowerCase()}:${item.controllerNumber}:${item.controllerLocation}`));
}

function expectation(fixture: Fixture, allowedPaths = fixture.vhdPaths, notes = fixture.notes): Expectation {
    return {
        id: fixture.vmId,
        name: fixture.vmName,
        notes,
        attachments: { allowedPaths, expectedPaths: allowedPaths },
    };
}

function assertInspectionIdentity(inspection: Inspection, fixture: Fixture): void {
    assert(inspection.virtualMachines.length === 1, "hyper-v-library-vm-cardinality-invalid");
    const vm = inspection.virtualMachines[0];
    assert(vm.id.toLowerCase() === fixture.vmId, "hyper-v-library-vm-id-mismatch");
    assert(vm.name === fixture.vmName, "hyper-v-library-vm-name-mismatch");
    assert(vm.notes === fixture.notes, "hyper-v-library-vm-notes-mismatch");
    assert([...inspection.hardDiskDrives, ...inspection.dvdDrives].every(
        (drive) => drive.vmId.toLowerCase() === fixture.vmId && drive.vmName === fixture.vmName,
    ), "hyper-v-library-attachment-identity-mismatch");
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function defaultFileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

export async function loadHyperVWindowsLibrary(): Promise<HyperVWindowsLibraryModule> {
    const publicRoot = pathToFileURL(join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "dist",
        "hyper-v-windows",
        "index.js",
    )).href;
    return import(publicRoot) as Promise<HyperVWindowsLibraryModule>;
}

export async function runHyperVWindowsLibraryScenario(
    dependencies: HyperVLibraryScenarioDependencies = {},
): Promise<readonly string[]> {
    if ((dependencies.platform ?? process.platform) !== "win32") {
        throw new Error("hyper-v-library-real-host-windows-required");
    }

    const trustedExecutables = resolveTrustedWindowsSystemExecutables(dependencies.windowsSystemRoot);
    const baseRunner = dependencies.runner ?? createBoundedPowerShellFileRunner({
        platform: "win32",
        windowsSystemRoot: dependencies.windowsSystemRoot,
    });
    let terminationUnconfirmed = false;
    const runner: ReturnType<typeof createBoundedPowerShellFileRunner> = async (request, context) => {
        const result = await baseRunner(request, context);
        if (result.terminationUnconfirmed) terminationUnconfirmed = true;
        return result;
    };
    const fixtureOperation = dependencies.fixtureOperation
        ?? createFixtureOperation(runner, trustedExecutables.powershell, dependencies.fixtureAsset);
    const importLibrary = dependencies.importLibraryImpl ?? loadHyperVWindowsLibrary;
    const token = (dependencies.randomToken ?? (() => randomBytes(16).toString("hex")))();
    assert(/^[0-9a-f]{32}$/.test(token), "hyper-v-library-token-invalid");
    const fixtureParent = dependencies.temporaryDirectory
        ? join(dependencies.temporaryDirectory, FIXTURE_PARENT_NAME)
        : join(requiredString(process.env.ProgramData, "hyper-v-library-program-data-unavailable"), FIXTURE_PARENT_NAME);
    const root = join(fixtureParent, token);
    const expected = {
        token,
        root,
        markerPath: join(root, ".ccc-hyper-v-library-fixture"),
        vmName: `${VM_NAME_PREFIX}${token}`,
        notes: `${NOTES_PREFIX}${token}`,
    };
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (dependencies.signal?.aborted) controller.abort();
    else dependencies.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(
        () => controller.abort(),
        dependencies.scenarioTimeoutMilliseconds ?? SCENARIO_TIMEOUT_MILLISECONDS,
    );
    const steps: string[] = [];
    const step = (message: string) => {
        steps.push(message);
        dependencies.log?.(`PASS ${message}`);
    };
    let fixture: Fixture | null = null;
    let failure: unknown = null;

    try {
        await fixtureOperation("preflight", {}, controller.signal);
        step("Hyper-V library preflight");

        const expectedVhdPaths = [join(root, "disk-1.vhdx"), join(root, "disk-2.vhdx")];
        fixture = {
            ...expected,
            vmId: "",
            vhdPaths: expectedVhdPaths,
        };
        fixture = parseFixture(await fixtureOperation("create", expected, controller.signal), {
            ...expected,
            vhdPaths: expectedVhdPaths,
        });
        const library = await importLibrary();
        // This lane cannot import from src/ — it exists to drive the compiled public root, and the
        // boundary test enforces that — so the local copy of the bootstrap is checked against the
        // library's own before it is used. Without this the copy is free to keep an older shape
        // while the lane still attests to the current contract.
        assert(
            POWERSHELL_MEMORY_BOOTSTRAP === library.HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP,
            "hyper-v-library-memory-bootstrap-drift",
        );
        const executor = library.createHyperVWindowsPowerShellExecutor({ executable: trustedExecutables.powershell, run: runner });
        const client = library.createHyperVWindowsClient(executor);
        const selector = { kind: "id", id: fixture.vmId } as const;

        const empty = await library.inspectHyperVVirtualMachine(client, selector, { signal: controller.signal });
        assertInspectionIdentity(empty, fixture);
        assert(empty.hardDiskDrives.length === 0 && empty.dvdDrives.length === 0, "hyper-v-library-empty-attachments-invalid");
        step("compiled library observed exact 0 HDD / 0 DVD");

        await fixtureOperation("attach", fixture, controller.signal);
        const attached = await library.inspectHyperVVirtualMachine(client, selector, { signal: controller.signal });
        assertInspectionIdentity(attached, fixture);
        assert(attached.hardDiskDrives.length === 2 && attached.dvdDrives.length === 2, "hyper-v-library-multiple-attachments-invalid");
        assert(new Set(attached.hardDiskDrives.map((drive) => windowsPath(requiredString(drive.path, "hyper-v-library-hard-disk-pathless")))).size === 2,
            "hyper-v-library-hard-disk-paths-not-distinct");
        assert(fixture.vhdPaths.every((path) => attached.hardDiskDrives.some((drive) => drive.path !== null && windowsPath(drive.path) === windowsPath(path))),
            "hyper-v-library-hard-disk-path-mismatch");
        assert(attached.dvdDrives.every((drive) => drive.path === null), "hyper-v-library-dvd-path-invalid");
        assert(controllerKeys([...attached.hardDiskDrives, ...attached.dvdDrives]).size === 4,
            "hyper-v-library-controller-location-duplicate");
        step("compiled library observed exact 2 HDD / 2 empty DVD");

        const safeExpectation = expectation(fixture);
        const pendingStart = library.reconcileHyperVVirtualMachine(attached, safeExpectation, "start");
        assert(pendingStart.kind === "pending" && pendingStart.action === "start", "hyper-v-library-start-not-pending");
        await client.startVM({ selector }, { signal: controller.signal });
        const running = await library.retryHyperVLifecycle(async () => {
            const inspection = await library.inspectHyperVVirtualMachine(client, selector, { signal: controller.signal });
            return library.reconcileHyperVVirtualMachine(inspection, safeExpectation, "start");
        }, {
            maxAttempts: STATE_ATTEMPTS,
            delayMilliseconds: STATE_DELAY_MILLISECONDS,
            signal: controller.signal,
            ...(dependencies.sleeper ? { sleeper: dependencies.sleeper } : {}),
        });
        assert(running.kind === "settled", "hyper-v-library-start-did-not-settle");
        step("compiled library started VM and settled Running");

        const runningInspection = await library.inspectHyperVVirtualMachine(client, selector, { signal: controller.signal });
        const pendingStop = library.reconcileHyperVVirtualMachine(runningInspection, safeExpectation, "stop");
        assert(pendingStop.kind === "pending" && pendingStop.action === "stop", "hyper-v-library-stop-not-pending");
        await client.stopVM({ selector, mode: "turn-off", force: true }, { signal: controller.signal });
        const stopped = await library.retryHyperVLifecycle(async () => {
            const inspection = await library.inspectHyperVVirtualMachine(client, selector, { signal: controller.signal });
            return library.reconcileHyperVVirtualMachine(inspection, safeExpectation, "stop");
        }, {
            maxAttempts: STATE_ATTEMPTS,
            delayMilliseconds: STATE_DELAY_MILLISECONDS,
            signal: controller.signal,
            ...(dependencies.sleeper ? { sleeper: dependencies.sleeper } : {}),
        });
        assert(stopped.kind === "settled", "hyper-v-library-stop-did-not-settle");
        step("compiled library stopped VM and settled Off");

        const stoppedInspection = await library.inspectHyperVVirtualMachine(client, selector, { signal: controller.signal });
        const safe = library.reconcileHyperVVirtualMachine(stoppedInspection, safeExpectation, "stop");
        assert(safe.kind === "settled", "hyper-v-library-safe-expectation-not-settled");
        assert(safe.drift?.missingExpectedPaths.length === 0, "hyper-v-library-safe-expectation-drifted");
        const restricted = library.reconcileHyperVVirtualMachine(
            stoppedInspection,
            expectation(fixture, [fixture.vhdPaths[0]]),
            "stop",
        );
        assert(restricted.kind === "attachment-conflict"
            && restricted.unexpectedAttachments?.some((item) => item.path !== null
                && windowsPath(item.path) === windowsPath(fixture?.vhdPaths[1] ?? "")),
        "hyper-v-library-restrictive-expectation-not-conflict");
        const wrongNotes = library.reconcileHyperVVirtualMachine(
            stoppedInspection,
            expectation(fixture, fixture.vhdPaths, `${fixture.notes}:wrong`),
            "stop",
        );
        assert(wrongNotes.kind === "identity-conflict" && wrongNotes.reason === "notes-mismatch",
            "hyper-v-library-wrong-notes-not-conflict");
        step("lifecycle safe / attachment-conflict / identity-conflict outcomes");

        // Snapshot primitives, exercised while the VM is Off so a production checkpoint is valid.
        const noSnapshots = await client.getVMSnapshots(selector, { signal: controller.signal });
        assert(noSnapshots.length === 0, "hyper-v-library-unexpected-existing-snapshots");
        const checkpointName = `ccc-library-real-${token}`;
        const checkpoint = await client.checkpointVM({ selector, snapshotName: checkpointName }, { signal: controller.signal });
        assert(checkpoint.name === checkpointName, "hyper-v-library-checkpoint-name-mismatch");
        assert(checkpoint.vmId === fixture.vmId, "hyper-v-library-checkpoint-vm-mismatch");
        assert(checkpoint.parentSnapshotId === null, "hyper-v-library-checkpoint-parent-invalid");
        const listed = await client.getVMSnapshots(selector, { signal: controller.signal });
        assert(listed.length === 1 && listed[0]?.id === checkpoint.id, "hyper-v-library-checkpoint-not-listed");
        step("compiled library created and observed exactly one checkpoint");

        await client.restoreVMSnapshot({ selector, snapshot: { kind: "id", id: checkpoint.id } }, { signal: controller.signal });
        const afterRestore = await library.inspectHyperVVirtualMachine(client, selector, { signal: controller.signal });
        assertInspectionIdentity(afterRestore, fixture);
        assert(afterRestore.hardDiskDrives.length === 2, "hyper-v-library-restore-lost-attachments");
        await client.removeVMSnapshot({ selector, snapshot: { kind: "name", name: checkpointName } }, { signal: controller.signal });
        const afterDelete = await client.getVMSnapshots(selector, { signal: controller.signal });
        assert(afterDelete.length === 0, "hyper-v-library-checkpoint-not-removed");
        step("compiled library restored and removed the checkpoint by id and by name");

        const remove = library.reconcileHyperVVirtualMachine(stoppedInspection, safeExpectation, "remove");
        assert(remove.kind === "pending" && remove.action === "remove", "hyper-v-library-remove-not-pending");
        await client.removeVM({ selector, force: true }, { signal: controller.signal });
        const [byId, byName] = await Promise.all([
            client.getVM(selector, { signal: controller.signal }),
            client.getVM({ kind: "name", name: fixture.vmName }, { signal: controller.signal }),
        ]);
        assert(byId.length === 0 && byName.length === 0, "hyper-v-library-vm-removal-not-observed");
        const fileExists = dependencies.fileExists ?? defaultFileExists;
        assert((await Promise.all(fixture.vhdPaths.map((path) => fileExists(path)))).every(Boolean),
            "hyper-v-library-remove-deleted-vhd");
        step("compiled library removed VM and retained both VHDX files");
    } catch (error) {
        failure = error;
    } finally {
        clearTimeout(timer);
        if (fixture) {
            const cleanup = async () => {
                if (terminationUnconfirmed) throw new Error("hyper-v-library-cleanup-refused-process-termination-unconfirmed");
                await fixtureOperation("cleanup", fixture as Fixture, undefined);
                step("guarded fixture cleanup");
            };
            try {
                await cleanup();
            } catch (cleanupError) {
                failure = failure
                    ? new AggregateError([failure, cleanupError], `scenario failed: ${describeError(failure)}; cleanup failed: ${describeError(cleanupError)}`)
                    : cleanupError;
            }
        }
        dependencies.signal?.removeEventListener("abort", onExternalAbort);
    }

    if (!failure && controller.signal.aborted) failure = new Error("hyper-v-library-scenario-cancelled");
    if (failure) throw failure;
    return steps;
}
