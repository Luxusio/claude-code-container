/** @typedef {{host: string, port: number}} BrokerEndpoint */
/** @typedef {{reason?: string, [key: string]: unknown}} BrokerAttempt */
/** @typedef {{pid?: number, kill?: (signal: string) => unknown}} BrokerChild */
/** @typedef {{child?: BrokerChild, pid?: number, processStartToken?: string|null}} OwnedBrokerChild */
/** @typedef {{ownerId: string, pid: number|null, port: number|string, host?: string, managedBy?: string, processStartToken?: string|null, startedAt?: string, logPath?: string, [key: string]: unknown}} BrokerRuntime */
/** @typedef {{protocolVersion?: number, startedAt?: string, process?: {pid?: number, startToken?: string}, [key: string]: unknown}} BrokerStatus */
/** @typedef {{pid: number, processStartToken?: string|null, [key: string]: unknown}} VerifiedBrokerProcess */
/** @typedef {{ok: boolean, reason?: string, pid?: number|null, [key: string]: unknown}} BrokerTermination */
/** @typedef {{ok: boolean, verified?: VerifiedBrokerProcess, [key: string]: unknown}} BrokerProcessVerification */
/** @typedef {({available: true, selected: BrokerEndpoint}|{available: false, selected: null}) & {attempts: BrokerAttempt[], [key: string]: unknown}} BrokerHealth */
/** @typedef {{ok: boolean, body?: {broker?: BrokerStatus}, [key: string]: unknown}} BrokerProtocolProbe */
/** @typedef {({ok: true, ownerId: string}|{ok: false, ownerId?: string}) & {error?: string, selected?: object|null, attempts?: BrokerAttempt[], [key: string]: unknown}} BrokerOwnerResolution */
/** @typedef {{ok: boolean, result?: {failed?: number}, [key: string]: unknown}} BrokerOwnerCleanup */
/** @typedef {{host: string, hostCandidates: string[], port: number, timeoutMs: number, launchTimeoutMs: number, command: string, args: string[]}} BrokerLaunch */
/** @typedef {(port: number) => VerifiedBrokerProcess|null} BrokerPortProcessResolver */
/** @typedef {{timeoutMs?: number, cleanupTimeoutMs?: number, force?: boolean, stopDevices?: boolean, detachPhysical?: boolean, portProcessResolver?: BrokerPortProcessResolver, [key: string]: unknown}} BrokerSupervisionOptions */
/** @typedef {{ok: true, ownerId: string, launched: boolean, reused: boolean, runtime: BrokerRuntime|null, host: string, port: number, attempts: BrokerAttempt[]}} BrokerSetupSuccess */
/** @typedef {{ok: false, ownerId: string, error: string, runtime?: BrokerRuntime|null, attempts: BrokerAttempt[], [key: string]: unknown}} BrokerSetupFailure */
/** @typedef {BrokerSetupSuccess|BrokerSetupFailure} BrokerSetupResult */
/** @typedef {{setups: Map<string, BrokerSetupResult>|null}} BrokerSetupOperation */

/** @param {number|undefined} actual @param {number} supported */
export function mayReplaceBrokerProtocol(actual, supported) {
    return !(Number.isSafeInteger(actual) && /** @type {number} */ (actual) > supported);
}

/** @param {BrokerOwnerCleanup} cleanup */
export function brokerOwnerCleanupSucceeded(cleanup) {
    return cleanup.ok === true && cleanup.result?.failed !== undefined
        ? cleanup.result.failed === 0 : cleanup.ok === true;
}

/** Preserve the native error carrier's existing diagnostic representation.
 * @param {unknown} error
 */
export function supervisionErrorDetail(error) {
    const message = error !== null && (typeof error === "object" || typeof error === "function")
        ? Reflect.get(error, "message") : undefined;
    return message || String(error);
}
