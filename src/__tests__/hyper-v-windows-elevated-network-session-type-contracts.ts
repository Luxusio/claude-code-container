import type {
    HyperVElevatedNetworkRelayCompletion,
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
}

void relayWithoutDiagnostics;
