import { win32 } from "path";

import { hiddenWindowsPowerShellArgs } from "../../../windows-system-powershell.js";
import {
    createHyperVWindowsClient,
    createHyperVWindowsPowerShellExecutor,
    HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP,
    hyperVWindowsPowerShellMemoryInput,
    inspectHyperVVirtualMachine,
    reconcileHyperVVirtualMachine,
    type HyperVVirtualMachineExpectation,
    type HyperVVirtualMachineIntent,
    type HyperVVirtualMachineReconciliationOutcome,
    type HyperVWindowsClient,
    type HyperVWindowsExecutionResult,
    type HyperVWindowsExecutor,
} from "../../../hyper-v-windows/index.js";
import type { HyperVProviderCommand } from "../../../host-control/hyper-v/index.js";
import type { HyperVOperationJournal } from "./operation-journal.js";

export type DeviceLabHyperVCommandResult = {
    // Named because redactProviderCommandInput reads exactly these two, and JSON.stringify drops
    // them when they are undefined — so a recorded execution missing them silently changes the
    // broker's public snapshot payloads rather than failing anywhere.
    readonly mode?: string;
    readonly provider?: string;
    readonly input?: string;
    readonly status?: number | null;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly error?: string;
    readonly timedOut?: boolean;
    readonly outputLimitExceeded?: boolean;
};

export type DeviceLabHyperVCommandRunner = (
    command: HyperVProviderCommand,
    options: { readonly timeoutMs: number; readonly outputLimit: number },
) => DeviceLabHyperVCommandResult | Promise<DeviceLabHyperVCommandResult>;

export type DeviceLabHyperVWindowsClientOptions = {
    readonly executable: string;
    readonly timeoutMilliseconds: number | (() => number);
    readonly run: DeviceLabHyperVCommandRunner;
    // When supplied, primitives go through one reused PowerShell process instead of one process
    // each. Optional so the real-test scenario and any caller without a session keep the one-shot
    // transport unchanged.
    readonly session?: HyperVWindowsExecutor;
    // Called with every execution this client performs, whichever transport served it. The one-shot
    // branch is observable through `run`; the session branch is not, so a recorder that only wrapped
    // `run` would see nothing at all once a session is in play.
    readonly record?: (result: DeviceLabHyperVCommandResult) => void;
};

// The session failures after which retrying is provably safe: each means the child never came up,
// so no operation reached the host and re-issuing cannot apply a mutation twice. A timeout, an exit
// mid-request and an uncorrelated frame are all deliberately excluded — the request may well have
// run, and a second Remove-VMSnapshot is not the same as the first.
const SESSION_NEVER_RAN_ERRORS = new Set([
    "hyper-v-windows-session-unavailable",
    "hyper-v-windows-session-spawn-failed",
    "hyper-v-windows-session-start-failed",
    // A caller whose deadline expired while it was still waiting for the pipe. Its frame was never
    // written, so this is the same proof as the three above: nothing reached the host. It matters
    // because one session is shared process-wide — without this, a single wedged operation takes
    // every other Hyper-V primitive down with it for the length of the session health floor, where
    // the one-shot transport would have given each of them its own healthy process. A caller whose
    // frame WAS written keeps hyper-v-windows-session-timeout and still fails outright.
    "hyper-v-windows-session-queue-timeout",
]);

export type DeviceLabHyperVExpectationOptions = {
    readonly ownerId: string;
    readonly journal: HyperVOperationJournal;
    readonly auxiliaryMediaPaths?: readonly string[];
};

function providerResult(result: DeviceLabHyperVCommandResult): HyperVWindowsExecutionResult {
    return {
        status: result.status ?? null,
        stdout: result.stdout ?? "",
        ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }),
        ...(result.outputLimitExceeded === undefined ? {} : { outputLimitExceeded: result.outputLimitExceeded }),
    };
}

export type DeviceLabHyperVRecordingClient = {
    readonly client: HyperVWindowsClient;
    // The broker surfaces the raw provider execution in snapshot failure payloads via
    // redactProviderCommandInput. The typed client throws typed errors instead of returning
    // executions, so the adapter keeps the most recent one to preserve that response shape.
    lastExecution(): DeviceLabHyperVCommandResult | null;
};

export function createRecordingDeviceLabHyperVWindowsClient(
    options: DeviceLabHyperVWindowsClientOptions,
): DeviceLabHyperVRecordingClient {
    let lastExecution: DeviceLabHyperVCommandResult | null = null;
    const client = createDeviceLabHyperVWindowsClient({
        ...options,
        run: async (command, runOptions) => {
            const result = await options.run(command, runOptions);
            lastExecution = result;
            return result;
        },
        // Recording only the one-shot runner left lastExecution permanently null once a session was
        // supplied, because the session serves every primitive and run is then never called. The
        // snapshot payloads that exist to carry provider diagnostics silently degraded to stubs.
        record: (result) => { lastExecution = result; },
    });
    return { client, lastExecution: () => lastExecution };
}

export function createDeviceLabHyperVWindowsClient(
    options: DeviceLabHyperVWindowsClientOptions,
): HyperVWindowsClient {
    const oneShot = createHyperVWindowsPowerShellExecutor({
        executable: options.executable,
        run: async (request, context) => {
            const timeoutMilliseconds = typeof options.timeoutMilliseconds === "function"
                ? options.timeoutMilliseconds()
                : options.timeoutMilliseconds;
            return providerResult(await options.run({
                mode: "exec",
                provider: "hyper-v",
                executable: request.executable,
                args: hiddenWindowsPowerShellArgs([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP,
                ]),
                input: hyperVWindowsPowerShellMemoryInput(request),
            }, {
                timeoutMs: Math.min(context.timeoutMilliseconds, timeoutMilliseconds),
                outputLimit: context.maximumOutputBytes,
            }));
        },
    });
    const session = options.session;
    if (!session) return createHyperVWindowsClient(oneShot);
    return createHyperVWindowsClient({
        async execute(request, context) {
            // The same clamp the one-shot branch applies. options.timeoutMilliseconds is passed as a
            // function by the broker so each primitive is bounded by what is left of the operation's
            // deadline; without this a session call with three seconds of budget left would block
            // for the library's full per-execution ceiling instead.
            const budget = typeof options.timeoutMilliseconds === "function"
                ? options.timeoutMilliseconds()
                : options.timeoutMilliseconds;
            const bounded = { ...context, timeoutMilliseconds: Math.min(context.timeoutMilliseconds, budget) };
            const result = await session.execute(request, bounded);
            if (!result.error || !SESSION_NEVER_RAN_ERRORS.has(result.error)) {
                // The session bypasses options.run, so this is the only place a recorder can see the
                // execution that actually served the primitive. Everything the redactor reads has to
                // be restated here, because the broker's snapshot payloads are built straight off
                // the recorded execution and a missing key silently changes the public response:
                // mode/provider become the literal keys, input becomes inputConfigured, and a
                // session timeout has to present as timedOut the way a one-shot timeout does.
                // Anything less makes the payload depend on which transport happened to serve it.
                options.record?.({
                    mode: "exec",
                    provider: "hyper-v",
                    // What the session actually writes to the child as this request's input, so the
                    // field is accurate rather than a marker fabricated to satisfy the redactor.
                    input: JSON.stringify(request),
                    ...(result.error === "hyper-v-windows-session-timeout" ? { timedOut: true } : {}),
                    ...result,
                });
                return result;
            }
            // The session could not be established at all. Rather than fail the operation, serve it
            // the way this broker served it before sessions existed. Anything else — a timeout, an
            // uncorrelated frame, an exit mid-request — is returned as-is, because those can mean
            // the host already did the work. The one-shot branch applies its own clamp against a
            // freshly read budget, so it takes the caller's context rather than this one.
            return await oneShot.execute(request, context);
        },
    });
}

export function deviceLabHyperVOperationIntent(
    command: HyperVOperationJournal["command"],
): HyperVVirtualMachineIntent {
    switch (command) {
        case "device_start": return "start";
        case "device_stop": return "stop";
        case "device_reboot": return "restart";
        case "device_delete": return "remove";
    }
}

export function deviceLabHyperVExpectation(
    options: DeviceLabHyperVExpectationOptions,
): HyperVVirtualMachineExpectation {
    const { journal } = options;
    const auxiliaryMediaPaths = options.auxiliaryMediaPaths ?? [];
    return {
        id: journal.vmId,
        name: journal.vmName,
        notes: `ccc-device-lab:${options.ownerId}:${journal.deviceId}:${journal.incarnationId}`,
        attachments: {
            allowedPaths: [journal.diskPath, ...auxiliaryMediaPaths],
            allowedHardDiskRoots: [win32.dirname(journal.diskPath)],
            expectedPaths: [journal.diskPath],
        },
    };
}

export async function reconcileDeviceLabHyperVOperation(
    client: HyperVWindowsClient,
    options: DeviceLabHyperVExpectationOptions,
): Promise<HyperVVirtualMachineReconciliationOutcome> {
    let inspection = await inspectHyperVVirtualMachine(client, {
        kind: "id",
        id: options.journal.vmId,
    });
    if (inspection.virtualMachines.length === 0) {
        inspection = await inspectHyperVVirtualMachine(client, {
            kind: "name",
            name: options.journal.vmName,
        });
    }
    return reconcileHyperVVirtualMachine(
        inspection,
        deviceLabHyperVExpectation(options),
        deviceLabHyperVOperationIntent(options.journal.command),
    );
}
