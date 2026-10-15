import type {
    HyperVElevatedNetworkRelayCompletion,
    HyperVElevatedNetworkRelayFailureEvent,
    HyperVElevatedNetworkRelayProcess,
    HyperVElevatedNetworkRelaySpawnRequest,
    HyperVElevatedNetworkTerminationDiagnostic,
    WithElevatedHyperVNetworkExecutorOptions,
} from "@ccc/device-lab/device-lab/broker/hyper-v/elevated-network-session.js";

declare const relayCompletion: Promise<HyperVElevatedNetworkRelayCompletion>;

const legacyOptions: WithElevatedHyperVNetworkExecutorOptions = {
    executable: "powershell.exe",
    deadlineUnixMilliseconds: 2_000_000_000_000,
};
const durationOptions: WithElevatedHyperVNetworkExecutorOptions = {
    ...legacyOptions,
    maximumDurationMilliseconds: 1_000,
    monotonicNow: () => 12.5,
};
const legacySpawnRequest: HyperVElevatedNetworkRelaySpawnRequest = {
    executable: legacyOptions.executable,
    deadlineUnixMilliseconds: legacyOptions.deadlineUnixMilliseconds,
    sessionBootstrap: "bootstrap",
    onBeforeElevation: () => undefined,
};
const durationSpawnRequest: HyperVElevatedNetworkRelaySpawnRequest = {
    ...legacySpawnRequest,
    maximumDurationMilliseconds: 1_000,
};
const optionalDuration: number | undefined = legacySpawnRequest.maximumDurationMilliseconds;

const relayWithoutDiagnostics: HyperVElevatedNetworkRelayProcess = {
    completion: relayCompletion,
    failureCode: () => null,
    write: () => undefined,
    onLine: () => undefined,
    onExit: () => undefined,
    close: () => undefined,
    kill: () => undefined,
};

declare const relayReadiness: Promise<void>;

const relayWithReadiness: HyperVElevatedNetworkRelayProcess = {
    ...relayWithoutDiagnostics,
    ready: relayReadiness,
};

if (false) {
    const invalidClock: WithElevatedHyperVNetworkExecutorOptions = {
        ...legacyOptions,
        // @ts-expect-error a local elapsed clock returns numbers
        monotonicNow: () => "12.5",
    };
    const invalidSpawnClock: HyperVElevatedNetworkRelaySpawnRequest = {
        ...legacySpawnRequest,
        // @ts-expect-error a process-local clock never crosses the native spawn boundary
        monotonicNow: () => 12.5,
    };
    const invalidDuration: WithElevatedHyperVNetworkExecutorOptions = {
        ...legacyOptions,
        // @ts-expect-error duration metadata is numeric, never a wire-selected string
        maximumDurationMilliseconds: "1000",
    };
    void invalidClock;
    void invalidSpawnClock;
    void invalidDuration;
    const readinessIsNotAProvider: HyperVElevatedNetworkRelayProcess = {
        ...relayWithoutDiagnostics,
        // @ts-expect-error readiness is awaited as a promise, never polled through a callback
        ready: () => undefined,
    };
    void readinessIsNotAProvider;
    const validCompletion: HyperVElevatedNetworkRelayCompletion = {
        errorCode: "hyper-v-network-elevation-termination-unconfirmed",
        terminationStage: "elevated-child",
    };
    // @ts-expect-error termination uncertainty requires its correlated bounded stage
    const missingStage: HyperVElevatedNetworkRelayCompletion = {
        errorCode: "hyper-v-network-elevation-termination-unconfirmed",
        terminationStage: null,
    };
    const unrelatedStage: HyperVElevatedNetworkRelayCompletion = {
        errorCode: "hyper-v-network-elevation-cancelled",
        // @ts-expect-error non-termination failures cannot carry a termination stage
        terminationStage: "relay-terminal-ack-missing",
    };
    const wrapperOnlyStage: HyperVElevatedNetworkRelayCompletion = {
        errorCode: "hyper-v-network-elevation-termination-unconfirmed",
        // @ts-expect-error relay producers cannot report the wrapper-owned completion timeout
        terminationStage: "relay-completion-timeout",
    };
    const invalidFallbackOverride: HyperVElevatedNetworkRelayFailureEvent = {
        kind: "termination",
        stage: "relay-terminal-ack-missing",
        // @ts-expect-error relay fallbacks cannot replace an existing primary failure
        replaceFailure: true,
    };
    const invalidChildPrecedence: HyperVElevatedNetworkRelayFailureEvent = {
        kind: "termination",
        stage: "elevated-child",
        // @ts-expect-error the authenticated child result must replace earlier failures
        replaceFailure: false,
    };
    const uncorrelatedDiagnostic: HyperVElevatedNetworkTerminationDiagnostic = {
        relay: null,
        execution: {
            lastOperation: null,
            // @ts-expect-error a session error requires the operation from that same execution
            lastSessionError: "hyper-v-windows-session-queue-timeout",
            activeExecutions: 1,
            pendingExecutions: 0,
        },
    };
    void uncorrelatedDiagnostic;
    void validCompletion;
    void missingStage;
    void unrelatedStage;
    void wrapperOnlyStage;
    void invalidFallbackOverride;
    void invalidChildPrecedence;
}

void relayWithoutDiagnostics;
void relayWithReadiness;
void durationOptions;
void durationSpawnRequest;
void optionalDuration;
