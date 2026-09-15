import type {
    HyperVElevatedNetworkRelayCompletion,
    HyperVElevatedNetworkRelayFailureEvent,
    HyperVElevatedNetworkRelayProcess,
    HyperVElevatedNetworkTerminationDiagnostic,
} from "../device-lab/broker/hyper-v/elevated-network-session.js";

declare const relayCompletion: Promise<HyperVElevatedNetworkRelayCompletion>;

const relayWithoutDiagnostics: HyperVElevatedNetworkRelayProcess = {
    completion: relayCompletion,
    failureCode: () => null,
    write: () => undefined,
    onLine: () => undefined,
    onExit: () => undefined,
    close: () => undefined,
    kill: () => undefined,
};

if (false) {
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
        },
    };
    void uncorrelatedDiagnostic;
    void validCompletion;
    void missingStage;
    void unrelatedStage;
    void invalidFallbackOverride;
    void invalidChildPrecedence;
}

void relayWithoutDiagnostics;
