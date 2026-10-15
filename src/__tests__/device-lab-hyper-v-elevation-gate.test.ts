import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    createHyperVWindowsNetworkClient,
    HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX,
    HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX,
    type HyperVWindowsExecutionContext,
    type HyperVWindowsExecutor,
    type HyperVWindowsSessionErrorCode,
} from "@ccc/hyper-v/index.js";
import {
    HyperVElevatedNetworkSessionError,
    withElevatedHyperVNetworkExecutor,
    type HyperVElevatedNetworkErrorCode,
    type HyperVElevatedNetworkAcquisitionSettlement,
    type HyperVElevatedNetworkRelayCompletion,
    type HyperVElevatedNetworkRelayProcess,
    type HyperVElevatedNetworkRelaySpawn,
} from "@ccc/device-lab/device-lab/broker/hyper-v/elevated-network-session.js";
import {
    HYPER_V_ELEVATION_SUPPRESSED_EXECUTOR,
    hyperVElevationGateStatus,
    resetHyperVElevationGateForTest,
    withHyperVElevationGate,
} from "@ccc/device-lab/device-lab/broker/hyper-v/elevation-gate.js";
import { deviceBrokerStatus, withHyperVAdministratorExecutorForTest } from "@ccc/device-lab/device-lab-broker.js";

const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const context: HyperVWindowsExecutionContext = { timeoutMilliseconds: 5_000, maximumOutputBytes: 64 * 1024 };

type ScriptedRelay = {
    readonly process: HyperVElevatedNetworkRelayProcess;
    // The elevated child authenticated: the relay announces readiness and serves requests.
    approve(): void;
    // The relay's bootstrap failed before readiness, the way a declined UAC prompt ends.
    fail(code: HyperVElevatedNetworkErrorCode): void;
};

// Shaped like the real relay where the gate can observe it: `ready` settles on readiness or on
// the relay finishing, and a relay that finishes unready has recorded its failure first.
function scriptedRelay(): ScriptedRelay {
    const lineListeners: Array<(line: string) => void> = [];
    const exitListeners: Array<(reason: HyperVWindowsSessionErrorCode) => void> = [];
    const held: Array<{ readonly line: string; readonly settled?: (error?: unknown) => void }> = [];
    let failure: HyperVElevatedNetworkErrorCode | null = null;
    let isReady = false;
    let finished = false;
    let resolveReady = () => undefined as void;
    const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
    });
    let resolveCompletion = (_value: HyperVElevatedNetworkRelayCompletion) => undefined as void;
    const completion = new Promise<HyperVElevatedNetworkRelayCompletion>((resolve) => {
        resolveCompletion = resolve;
    });
    const deliver = (line: string, settled?: (error?: unknown) => void) => {
        settled?.();
        if (!line.startsWith(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX)) return;
        const frame = JSON.parse(Buffer.from(
            line.slice(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX.length),
            "base64",
        ).toString("utf8")) as { readonly id: string; readonly input: string };
        const request = JSON.parse(frame.input) as { readonly operation: string };
        const reply = Buffer.from(JSON.stringify({
            id: frame.id,
            code: 0,
            stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items: [] }),
        }), "utf8").toString("base64");
        queueMicrotask(() => {
            for (const listener of [...lineListeners]) listener(`${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}${reply}`);
        });
    };
    const finish = () => {
        if (finished) return;
        finished = true;
        for (const entry of held.splice(0)) entry.settled?.(new Error("relay-finished"));
        for (const listener of [...exitListeners]) listener("hyper-v-windows-session-start-failed");
        resolveReady();
        resolveCompletion({ errorCode: failure, terminationStage: null });
    };
    return {
        process: {
            completion,
            ready,
            failureCode: () => failure,
            write(line, settled) {
                if (finished) {
                    settled?.(new Error("relay-finished"));
                    return;
                }
                if (!isReady) {
                    held.push({ line, ...(settled ? { settled } : {}) });
                    return;
                }
                deliver(line, settled);
            },
            onLine(listener) {
                lineListeners.push(listener);
            },
            onExit(listener) {
                exitListeners.push(listener);
                if (finished) queueMicrotask(() => listener("hyper-v-windows-session-start-failed"));
            },
            close: finish,
            kill: finish,
        },
        approve() {
            isReady = true;
            resolveReady();
            for (const entry of held.splice(0)) deliver(entry.line, entry.settled);
        },
        fail(code) {
            failure = code;
            finish();
        },
    };
}

// Composed exactly the way the broker's withAdministratorClient composes it.
function administratorTransaction<T>(
    options: {
        readonly spawnRelay: HyperVElevatedNetworkRelaySpawn;
        readonly onBeforeElevation: () => void;
    },
    operation: (executor: HyperVWindowsExecutor) => T | Promise<T>,
): Promise<T> {
    return withHyperVElevationGate((onAcquisitionSettled) => withElevatedHyperVNetworkExecutor({
        executable,
        deadlineUnixMilliseconds: Date.now() + 30_000,
        onBeforeElevation: options.onBeforeElevation,
        onAcquisitionSettled,
        spawnRelay: options.spawnRelay,
    }, operation), operation);
}

function listSwitches(executor: HyperVWindowsExecutor) {
    return createHyperVWindowsNetworkClient(executor).getVMSwitches({ kind: "all" });
}

// A relay that asks for approval and is then declined, the way a cancelled UAC prompt reports.
function decliningSpawn(code: HyperVElevatedNetworkErrorCode = "hyper-v-network-elevation-cancelled") {
    return vi.fn<HyperVElevatedNetworkRelaySpawn>(async (request) => {
        request.onBeforeElevation();
        const relay = scriptedRelay();
        queueMicrotask(() => relay.fail(code));
        return relay.process;
    });
}

function approvingSpawn() {
    return vi.fn<HyperVElevatedNetworkRelaySpawn>(async (request) => {
        request.onBeforeElevation();
        const relay = scriptedRelay();
        queueMicrotask(() => relay.approve());
        return relay.process;
    });
}

async function flush(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Hyper-V elevation gate", () => {
    beforeEach(() => {
        resetHyperVElevationGateForTest();
    });

    afterEach(() => {
        resetHyperVElevationGateForTest();
    });

    it("asks once after a declined prompt: the next transaction starts no relay and logs no REQUEST", async () => {
        const spawnRelay = decliningSpawn();
        const request = vi.fn();

        await expect(administratorTransaction({ spawnRelay, onBeforeElevation: request }, listSwitches))
            .rejects.toMatchObject({ category: "transport", code: "hyper-v-network-elevation-cancelled" });
        expect(hyperVElevationGateStatus()).toEqual({
            state: "refused",
            code: "hyper-v-network-elevation-cancelled",
            at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        });

        await expect(administratorTransaction({ spawnRelay, onBeforeElevation: request }, listSwitches))
            .rejects.toMatchObject({ category: "transport", code: "hyper-v-network-elevation-suppressed" });
        expect(spawnRelay).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("keeps one spawn across two administrator transactions after a refusal", async () => {
        const spawnRelay = decliningSpawn("hyper-v-network-elevation-handshake-timeout");
        const request = vi.fn();
        await expect(administratorTransaction({ spawnRelay, onBeforeElevation: request }, listSwitches))
            .rejects.toMatchObject({ code: "hyper-v-network-elevation-handshake-timeout" });

        for (let transaction = 0; transaction < 2; transaction += 1) {
            const calls: string[] = [];
            await expect(administratorTransaction({ spawnRelay, onBeforeElevation: request }, async (executor) => {
                const client = createHyperVWindowsNetworkClient(executor);
                for (const call of [
                    () => client.getVMSwitches({ kind: "all" }),
                    () => client.getNetNats({ kind: "all" }),
                ]) {
                    await call().catch((error: unknown) => {
                        calls.push(String(Reflect.get(Object(error), "code")));
                    });
                }
                return calls;
            })).resolves.toEqual([
                "hyper-v-network-elevation-suppressed",
                "hyper-v-network-elevation-suppressed",
            ]);
        }
        expect(spawnRelay).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
        expect(hyperVElevationGateStatus()).toMatchObject({
            state: "refused",
            code: "hyper-v-network-elevation-handshake-timeout",
        });
    });

    it("keeps a relay that could not be started retryable", async () => {
        const spawnRelay = vi.fn<HyperVElevatedNetworkRelaySpawn>(async () => {
            throw new Error("spawn EACCES");
        });
        const request = vi.fn();

        for (let attempt = 0; attempt < 2; attempt += 1) {
            await expect(administratorTransaction({ spawnRelay, onBeforeElevation: request }, listSwitches))
                .rejects.toMatchObject({ code: "hyper-v-network-elevation-relay-spawn-failed" });
        }
        expect(spawnRelay).toHaveBeenCalledTimes(2);
        expect(request).not.toHaveBeenCalled();
        expect(hyperVElevationGateStatus()).toEqual({ state: "never-asked" });
    });

    it.each([
        "hyper-v-network-elevation-request-failed",
        "hyper-v-network-elevation-launch-failed",
        "hyper-v-network-elevation-relay-spawn-failed",
        "hyper-v-network-elevation-executable-rejected",
    ] satisfies HyperVElevatedNetworkErrorCode[])(
        "does not spend the attempt on %s, which settles before any prompt",
        async (code) => {
            const spawnRelay = decliningSpawn(code);
            const request = vi.fn();

            for (let attempt = 0; attempt < 2; attempt += 1) {
                await expect(administratorTransaction({ spawnRelay, onBeforeElevation: request }, listSwitches))
                    .rejects.toMatchObject({ code });
            }
            expect(spawnRelay).toHaveBeenCalledTimes(2);
            expect(hyperVElevationGateStatus()).toEqual({ state: "never-asked" });
        },
    );

    it("keeps a refused PowerShell path retryable when the relay rejects it before asking", async () => {
        const spawnRelay = vi.fn<HyperVElevatedNetworkRelaySpawn>(async () => {
            throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-executable-rejected");
        });

        await expect(administratorTransaction({ spawnRelay, onBeforeElevation: vi.fn() }, listSwitches))
            .rejects.toMatchObject({ code: "hyper-v-network-elevation-executable-rejected" });
        expect(hyperVElevationGateStatus()).toEqual({ state: "never-asked" });
    });

    it("does not remember an approval: the gate can only deny", async () => {
        const spawnRelay = approvingSpawn();
        const request = vi.fn();

        for (let attempt = 0; attempt < 2; attempt += 1) {
            await expect(administratorTransaction({ spawnRelay, onBeforeElevation: request }, listSwitches))
                .resolves.toEqual([]);
        }
        expect(spawnRelay).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenCalledTimes(2);
        expect(hyperVElevationGateStatus()).toEqual({ state: "never-asked" });
    });

    it("does not touch the gate when a transaction needs no administrator call", async () => {
        const spawnRelay = decliningSpawn();

        await expect(administratorTransaction({ spawnRelay, onBeforeElevation: vi.fn() }, () => "no-op"))
            .resolves.toBe("no-op");
        expect(spawnRelay).not.toHaveBeenCalled();
        expect(hyperVElevationGateStatus()).toEqual({ state: "never-asked" });
    });

    it("makes a concurrent transaction wait for the first verdict instead of prompting beside it", async () => {
        const relay = scriptedRelay();
        const spawnRelay = vi.fn<HyperVElevatedNetworkRelaySpawn>(async (request) => {
            request.onBeforeElevation();
            return relay.process;
        });
        const request = vi.fn();

        const first = administratorTransaction({ spawnRelay, onBeforeElevation: request }, listSwitches)
            .then(() => null, (error: unknown) => error);
        const second = administratorTransaction({ spawnRelay, onBeforeElevation: request }, listSwitches)
            .then(() => null, (error: unknown) => error);
        await flush();
        expect(spawnRelay).toHaveBeenCalledTimes(1);

        relay.fail("hyper-v-network-elevation-cancelled");
        expect(await first).toMatchObject({ code: "hyper-v-network-elevation-cancelled" });
        expect(await second).toMatchObject({ code: "hyper-v-network-elevation-suppressed" });
        expect(spawnRelay).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([-86_400_000, 86_400_000])("expires only a waiting transaction's turn despite a %i ms wall jump", async (wallJump) => {
        vi.useFakeTimers();
        let releaseFirst = () => undefined as void;
        const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
        let settleFirst = (_settlement: HyperVElevatedNetworkAcquisitionSettlement) => undefined as void;
        const firstElevate = vi.fn(async (settled: (settlement: HyperVElevatedNetworkAcquisitionSettlement) => void) => {
            settleFirst = settled;
            await held;
            return "first";
        });
        const secondElevate = vi.fn(async () => "expired transaction elevated");
        const thirdElevate = vi.fn(async (settled: (settlement: HyperVElevatedNetworkAcquisitionSettlement) => void) => {
            settled({ prompted: false, ready: false, code: null });
            return "third";
        });
        let remaining = 100;
        let secondOutcome: unknown;
        const first = withHyperVElevationGate(firstElevate, () => "unused");
        const second = withHyperVElevationGate(secondElevate, () => "unused", {
            remainingMilliseconds: () => remaining,
        }).then((value) => { secondOutcome = value; }, (error: unknown) => { secondOutcome = error; });
        const third = withHyperVElevationGate(thirdElevate, () => "unused");
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(firstElevate).toHaveBeenCalledTimes(1);
            vi.setSystemTime(Date.now() + wallJump);
            remaining = 0;
            await vi.advanceTimersByTimeAsync(100);
            expect(secondOutcome).toMatchObject({ code: "hyper-v-network-elevation-deadline-exceeded" });
            expect(secondElevate).not.toHaveBeenCalled();
            expect(thirdElevate).not.toHaveBeenCalled();
            settleFirst({ prompted: false, ready: false, code: null });
            releaseFirst();
            await expect(first).resolves.toBe("first");
            await expect(third).resolves.toBe("third");
            expect(secondElevate).not.toHaveBeenCalled();
            expect(hyperVElevationGateStatus()).toEqual({ state: "never-asked" });
        } finally {
            releaseFirst();
            await Promise.all([first, second, third]);
            vi.useRealTimers();
        }
    });

    it("refuses when a prompt was raised and the scope closed before the relay answered", async () => {
        const relay = scriptedRelay();
        const controller = new AbortController();
        const spawnRelay = vi.fn<HyperVElevatedNetworkRelaySpawn>(async (request) => {
            request.onBeforeElevation();
            return relay.process;
        });

        const attempt = administratorTransaction(
            { spawnRelay, onBeforeElevation: vi.fn() },
            (executor) => executor.execute(
                { schemaVersion: 1, operation: "Get-VMSwitch", selector: { kind: "all" } },
                { ...context, signal: controller.signal },
            ),
        );
        await flush();
        controller.abort();

        await expect(attempt).resolves.toMatchObject({ error: "hyper-v-network-elevation-cancelled" });
        expect(hyperVElevationGateStatus()).toMatchObject({
            state: "refused",
            code: "hyper-v-network-elevation-scope-closed",
        });
    });

    it("holds the next transaction until a prompt raised by a still-starting relay is counted", async () => {
        const relay = scriptedRelay();
        const controller = new AbortController();
        let releaseSpawn = () => undefined as void;
        const spawnReleased = new Promise<void>((resolve) => {
            releaseSpawn = resolve;
        });
        const spawnRelay = vi.fn<HyperVElevatedNetworkRelaySpawn>(async (request) => {
            request.onBeforeElevation();
            await spawnReleased;
            return relay.process;
        });
        const request = vi.fn();

        const first = administratorTransaction(
            { spawnRelay, onBeforeElevation: request },
            (executor) => executor.execute(
                { schemaVersion: 1, operation: "Get-VMSwitch", selector: { kind: "all" } },
                { ...context, signal: controller.signal },
            ),
        );
        await flush();
        const second = administratorTransaction({ spawnRelay, onBeforeElevation: request }, listSwitches)
            .then(() => null, (error: unknown) => error);
        controller.abort();
        try {
            await flush();
            expect(await second).toMatchObject({ code: "hyper-v-network-elevation-suppressed" });
            expect(spawnRelay).toHaveBeenCalledTimes(1);
            expect(request).toHaveBeenCalledTimes(1);
            expect(hyperVElevationGateStatus()).toMatchObject({
                state: "refused",
                code: "hyper-v-network-elevation-scope-closed",
            });
            releaseSpawn();
            await flush();
            await expect(first).resolves.toMatchObject({ error: "hyper-v-network-elevation-cancelled" });
            expect(spawnRelay).toHaveBeenCalledTimes(1);
            expect(request).toHaveBeenCalledTimes(1);
        } finally {
            releaseSpawn();
            await Promise.allSettled([first, second]);
        }
    });

    it("fails every call on the suppressed executor without starting anything", async () => {
        for (let call = 0; call < 2; call += 1) {
            expect(await HYPER_V_ELEVATION_SUPPRESSED_EXECUTOR.execute(
                { schemaVersion: 1, operation: "Get-VMSwitch", selector: { kind: "all" } },
                context,
            )).toEqual({ status: null, stdout: "", error: "hyper-v-network-elevation-suppressed" });
        }
    });

    it("composes the broker's administrator client through the gate", () => {
        const source = readFileSync(join(__dirname, "..", "..", "packages", "device-lab", "src", "device-lab-broker.ts"), "utf8");
        const start = source.indexOf("withAdministratorClient: async <Result>");
        const composition = source.slice(start, source.indexOf("kind: \"unavailable\"", start));
        const helperStart = source.indexOf("function withHyperVAdministratorExecutor<Result>(");
        const helper = source.slice(helperStart, source.indexOf("\n}\n", helperStart));
        const gate = helper.indexOf("withHyperVElevationGate(");
        const elevation = helper.indexOf("withElevatedHyperVNetworkExecutor({");
        const request = helper.indexOf("`REQUEST ${");
        const settled = helper.indexOf("onAcquisitionSettled(settlement);");

        const runtimeStart = source.indexOf("function hyperVNetworkRuntime(");
        const runtime = source.slice(runtimeStart, source.indexOf("\n}\n", runtimeStart));

        expect(start).toBeGreaterThanOrEqual(0);
        expect(composition).toContain("purpose?: DeviceLabHyperVAdministratorPurpose) => normalized.usesDefaultCommandRunner");
        expect(composition).toContain("withHyperVAdministratorExecutor(purpose, () => {");
        expect(composition).toContain("Math.floor(deadlineAt - normalized.hyperVMonotonicNow())");
        expect(composition).toContain("deadlineUnixMilliseconds: Date.now() + maximumDurationMilliseconds");
        expect(composition).toContain("remainingMilliseconds: () => deadlineAt - normalized.hyperVMonotonicNow()");
        expect(composition).toContain("monotonicNow: normalized.hyperVMonotonicNow");
        // The forwarded `purpose` can only be the adapter's own argument: nothing else in the
        // runtime binds or uses that name, so a rename cannot leave the log line unspecified.
        expect(runtimeStart).toBeGreaterThanOrEqual(0);
        expect(runtime.match(/\bpurpose\b/g)).toHaveLength(2);
        expect(composition).not.toContain("withElevatedHyperVNetworkExecutor");
        expect(helperStart).toBeGreaterThanOrEqual(0);
        expect(gate).toBeGreaterThanOrEqual(0);
        expect(elevation).toBeGreaterThan(gate);
        expect(request).toBeGreaterThan(elevation);
        expect(settled).toBeGreaterThan(elevation);
        expect(source.match(/withElevatedHyperVNetworkExecutor\(/g)).toHaveLength(1);
    });
});

// The broker's own composition, so these lines are the ones a host-broker log will carry.
describe("Hyper-V elevation log lines", () => {
    const iso = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z";
    const requestSentence = "Windows is asking for Administrator permission via UAC to configure Hyper-V host networking";
    let written: string[] = [];
    let monotonic = 0;

    beforeEach(() => {
        resetHyperVElevationGateForTest();
        written = [];
        monotonic = 0;
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-27T09:15:00.000Z"));
        vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
            written.push(String(chunk));
            return true;
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        resetHyperVElevationGateForTest();
    });

    function brokerTransaction<T>(
        purpose: "ensure" | "cleanup" | undefined,
        spawnRelay: HyperVElevatedNetworkRelaySpawn,
        operation: (executor: HyperVWindowsExecutor) => T | Promise<T>,
    ): Promise<T> {
        return withHyperVAdministratorExecutorForTest(purpose, () => ({
            executable,
            deadlineUnixMilliseconds: Date.now() + 180_000,
            spawnRelay,
        }), operation, { monotonicNow: () => monotonic });
    }

    // A relay that takes 750 ms to ask, then `waitMs` of the person's time before it settles.
    function timedSpawn(waitMs: number, settle: (relay: ScriptedRelay) => void) {
        return vi.fn<HyperVElevatedNetworkRelaySpawn>(async (request) => {
            vi.setSystemTime(Date.now() + 750);
            monotonic += 750;
            request.onBeforeElevation();
            const relay = scriptedRelay();
            queueMicrotask(() => {
                vi.setSystemTime(Date.now() + waitMs);
                monotonic += waitMs;
                settle(relay);
            });
            return relay.process;
        });
    }

    it("attributes a declined prompt, then writes SUPPRESSED instead of a second REQUEST", async () => {
        const spawnRelay = timedSpawn(41_250, (relay) => relay.fail("hyper-v-network-elevation-cancelled"));

        await expect(brokerTransaction("ensure", spawnRelay, listSwitches))
            .rejects.toMatchObject({ code: "hyper-v-network-elevation-cancelled" });
        expect(written).toEqual([
            `REQUEST 2026-09-27T09:15:00.750Z pid=${process.pid} purpose=ensure ${requestSentence}\n`,
            "ELEVATION 2026-09-27T09:15:42.000Z outcome=hyper-v-network-elevation-cancelled elapsedMs=41250\n",
        ]);

        written = [];
        await expect(brokerTransaction("cleanup", spawnRelay, listSwitches))
            .rejects.toMatchObject({ code: "hyper-v-network-elevation-suppressed" });
        expect(written).toEqual([
            "SUPPRESSED 2026-09-27T09:15:42.000Z purpose=cleanup code=hyper-v-network-elevation-suppressed\n",
        ]);
        expect(spawnRelay).toHaveBeenCalledTimes(1);
    });

    it("records a ready outcome for an approved prompt", async () => {
        const spawnRelay = timedSpawn(2_000, (relay) => relay.approve());

        await expect(brokerTransaction("cleanup", spawnRelay, listSwitches)).resolves.toEqual([]);
        expect(written).toEqual([
            `REQUEST 2026-09-27T09:15:00.750Z pid=${process.pid} purpose=cleanup ${requestSentence}\n`,
            "ELEVATION 2026-09-27T09:15:02.750Z outcome=ready elapsedMs=2000\n",
        ]);
    });

    it("writes only the outcome, timed from the attempt, when the relay could not be started", async () => {
        const spawnRelay = vi.fn<HyperVElevatedNetworkRelaySpawn>(async () => {
            vi.setSystemTime(Date.now() + 300);
            monotonic += 300;
            throw new Error("spawn EACCES C:\\Users\\someone\\secret");
        });

        await expect(brokerTransaction("ensure", spawnRelay, listSwitches))
            .rejects.toMatchObject({ code: "hyper-v-network-elevation-relay-spawn-failed" });
        expect(written).toEqual([
            "ELEVATION 2026-09-27T09:15:00.300Z outcome=hyper-v-network-elevation-relay-spawn-failed elapsedMs=300\n",
        ]);
    });

    it("writes nothing for a transaction that needed no administrator call", async () => {
        await expect(brokerTransaction("ensure", timedSpawn(0, (relay) => relay.approve()), () => "no-op"))
            .resolves.toBe("no-op");
        expect(written).toEqual([]);
    });

    it.each([-86_400_000, 86_400_000])("keeps elapsed logging local and audit timestamps wall based across a %i ms jump", async (wallJump) => {
        const spawnRelay = vi.fn<HyperVElevatedNetworkRelaySpawn>(async (request) => {
            monotonic = 25;
            request.onBeforeElevation();
            const relay = scriptedRelay();
            queueMicrotask(() => {
                monotonic = 150;
                vi.setSystemTime(Date.now() + wallJump);
                relay.approve();
            });
            return relay.process;
        });
        await expect(withHyperVAdministratorExecutorForTest("ensure", () => ({
            executable,
            deadlineUnixMilliseconds: Date.now() + 1_000,
            maximumDurationMilliseconds: 1_000,
            spawnRelay,
        }), listSwitches, { monotonicNow: () => monotonic, remainingMilliseconds: () => 1_000 - monotonic }))
            .resolves.toEqual([]);
        expect(written).toEqual([
            `REQUEST 2026-09-27T09:15:00.000Z pid=${process.pid} purpose=ensure ${requestSentence}\n`,
            `ELEVATION ${new Date(Date.parse("2026-09-27T09:15:00.000Z") + wallJump).toISOString()} outcome=ready elapsedMs=125\n`,
        ]);
    });

    it("materializes the current remaining allowance only after the gate admits the broker's lazy elevation options", async () => {
        let releaseFirst = () => undefined as void;
        const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const first = withHyperVElevationGate(async (settled) => {
            await held;
            settled({ prompted: false, ready: false, code: null });
            return "first";
        }, () => "unused");
        let remaining = 1_000;
        const spawnRelay = vi.fn<HyperVElevatedNetworkRelaySpawn>(async (request) => {
            expect(request.maximumDurationMilliseconds).toBe(250);
            request.onBeforeElevation();
            const relay = scriptedRelay();
            queueMicrotask(() => relay.approve());
            return relay.process;
        });
        const elevation = vi.fn(() => ({
            executable,
            deadlineUnixMilliseconds: Date.now() + remaining,
            maximumDurationMilliseconds: remaining,
            spawnRelay,
        }));
        const second = withHyperVAdministratorExecutorForTest("ensure", elevation, listSwitches, {
            remainingMilliseconds: () => remaining,
            monotonicNow: () => monotonic,
        });
        try {
            await flush();
            expect(elevation).not.toHaveBeenCalled();
            expect(spawnRelay).not.toHaveBeenCalled();
            remaining = 250;
            monotonic = 750;
            vi.setSystemTime(Date.now() - 86_400_000);
            releaseFirst();
            await expect(first).resolves.toBe("first");
            await expect(second).resolves.toEqual([]);
            expect(elevation).toHaveBeenCalledTimes(1);
            expect(spawnRelay).toHaveBeenCalledTimes(1);
        } finally {
            releaseFirst();
            await Promise.all([first, second]);
        }
    });

    it("bounds every line to fixed words, times and enums, whatever the caller passes", async () => {
        const spawnRelay = timedSpawn(5, (relay) => relay.fail("hyper-v-network-elevation-handshake-timeout"));
        await brokerTransaction("C:\\Users\\someone vm-name" as never, spawnRelay, listSwitches).catch(() => undefined);
        await brokerTransaction(undefined, spawnRelay, listSwitches).catch(() => undefined);

        expect(written).toHaveLength(3);
        for (const line of written) {
            expect(line).toMatch(new RegExp([
                `^REQUEST ${iso} pid=\\d+ purpose=(ensure|cleanup|unspecified) ${requestSentence}\n$`,
                `^ELEVATION ${iso} outcome=(ready|hyper-v-network-elevation-[a-z-]+) elapsedMs=\\d+\n$`,
                `^SUPPRESSED ${iso} purpose=(ensure|cleanup|unspecified) code=hyper-v-network-elevation-suppressed\n$`,
            ].join("|")));
            expect(line).not.toContain("someone");
            expect(line).not.toContain(executable);
        }
        expect(written[0]).toContain("purpose=unspecified");
        expect(written[2]).toContain("purpose=unspecified");
    });
});

describe("Hyper-V elevation gate in broker status", () => {
    let originalHomeRestore: (() => void) | undefined;
    let fixtureHome: string | undefined;

    beforeEach(() => {
        resetHyperVElevationGateForTest();

        fixtureHome = mkdtempSync(join(tmpdir(), "ccc-elevation-gate-test-home-"));
        originalHomeRestore = isolateDeviceLabTestEnvironment(fixtureHome);
    });

    afterEach(() => {
        resetHyperVElevationGateForTest();
        if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
        originalHomeRestore?.();
    });

    it("reports only the bounded gate state, code and time", async () => {
        const status = () => deviceBrokerStatus({ cwd: "/project/elevation-gate-status-test" }).hyperVElevationGate;
        expect(status()).toEqual({ state: "never-asked" });

        await administratorTransaction({ spawnRelay: decliningSpawn(), onBeforeElevation: vi.fn() }, listSwitches)
            .catch(() => undefined);

        const refused = status();
        expect(refused).toEqual({
            state: "refused",
            code: "hyper-v-network-elevation-cancelled",
            at: expect.any(String),
        });
        expect(Object.keys(refused)).toEqual(["state", "code", "at"]);
        expect(new Date(String(Reflect.get(refused, "at"))).toISOString()).toBe(Reflect.get(refused, "at"));
    });
});
