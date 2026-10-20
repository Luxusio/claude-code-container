/** @typedef {import('../domain/broker-supervision.mjs').BrokerRuntime} Runtime */
/** @typedef {import('../domain/broker-supervision.mjs').BrokerStatus} Status */
/** @typedef {import('../domain/broker-supervision.mjs').VerifiedBrokerProcess} Verified */
/** @typedef {import('../domain/broker-supervision.mjs').BrokerTermination} Termination */
/** @typedef {import('../domain/broker-supervision.mjs').BrokerProcessVerification} Verification */
/** @typedef {import('../domain/broker-supervision.mjs').BrokerHealth} Health */
/** @typedef {import('../domain/broker-supervision.mjs').BrokerOwnerResolution} OwnerResolution */
/** @typedef {import('../domain/broker-supervision.mjs').BrokerLaunch} Launch */
/** @typedef {import('../domain/broker-supervision.mjs').BrokerChild} Child */
/** @typedef {import('../domain/broker-supervision.mjs').OwnedBrokerChild} OwnedChild */
/** @typedef {import('../domain/broker-supervision.mjs').BrokerSupervisionOptions} Options */
/** @typedef {import('../domain/broker-supervision.mjs').BrokerPortProcessResolver} PortResolver */
/** @typedef {{hostCandidates: string[], port: number|string, timeoutMs: number}} ProbeOptions */
/**
 * Native broker authorities. Every method names an observation, guarded native
 * action or operation-local cache step; no supervision workflow is injected.
 * @typedef {object} BrokerSupervisionPorts
 * @property {number} protocolVersion
 * @property {() => string} ownerId
 * @property {(options: Options) => Launch} normalizeLaunchOptions
 * @property {(options: ProbeOptions) => Promise<Health>} probeBrokerHealth
 * @property {() => Runtime|null} readBrokerRuntime
 * @property {(host: string, port: number, timeoutMs: number) => Promise<import('../domain/broker-supervision.mjs').BrokerProtocolProbe>} probeCccHostBrokerProtocol
 * @property {(options: ProbeOptions) => Promise<OwnerResolution>} resolveBrokerOwner
 * @property {(runtime: Runtime|null, port: number, host: string, options: {statusBroker?: Status}) => Verification} reusableBrokerProcessVerification
 * @property {(runtime: Runtime|null, verification: Verification, status?: Status) => Runtime|null} persistVerifiedBrokerRuntime
 * @property {(result: import('../domain/broker-supervision.mjs').BrokerSetupSuccess, health: Health, owner: OwnerResolution) => import('../domain/broker-supervision.mjs').BrokerSetupSuccess} withSetupEvidence
 * @property {(pid: number|null|undefined) => boolean} pidAlive
 * @property {(runtime: Runtime, timeoutMs: number, options: {statusBroker?: Status|null}) => Promise<Termination>} terminateVerifiedBrokerRuntime
 * @property {(expected: Runtime|null) => boolean} removeBrokerRuntime
 * @property {(options: {host: string, port: number|string, timeoutMs: number}) => Promise<Health>} waitForBrokerHealth
 * @property {(host: string, port: number, timeoutMs: number) => Promise<OwnerResolution>} waitForBrokerOwnerResolve
 * @property {(owner: string, launch: Launch) => Promise<import('../domain/broker-supervision.mjs').BrokerLaunchResult>} launchOwnedBroker
 * @property {(pid: number) => string|null} readBrokerProcessStartToken
 * @property {(pid: number|null|undefined, timeoutMs: number, token: string|null|undefined) => Promise<Termination>} terminateBrokerProcess
 * @property {(pid: number, timeoutMs: number) => Promise<boolean>} waitForProcessExit
 * @property {(runtime: Runtime, expected: Runtime|null) => boolean} writeBrokerRuntime
 * @property {(runtime: Runtime, port: number, host: string, status?: Status) => {verification: Verification, runtime: Runtime}} launchedBrokerProcessVerification
 * @property {(runtime: Runtime, timeoutMs: number) => Promise<Termination>} cleanupLaunchedBrokerRuntime
 * @property {(path: string) => string} brokerLogTail
 * @property {(runtime: Runtime, port: number, status: Status|null) => Verified|null} verifiedBrokerProcess
 * @property {() => undefined} invalidateBrokerSetup
 * @property {(runtime: Runtime, port: number, status: Status|undefined, resolver?: PortResolver) => Verified|null} verifiedOwnedLegacyBrokerProcess
 * @property {() => import('../domain/broker-supervision.mjs').BrokerSetupOperation|undefined} currentOperation
 * @property {(options: Options) => string} setupCacheKey
 * @property {() => IterableIterator<[number, OwnedChild]>} ownedChildrenEntries
 * @property {(pid: number|null|undefined) => undefined} deleteOwnedChild
 * @property {(child: Child, signal: 'SIGTERM'|'SIGKILL') => undefined} signalChild
 * @property {(runtime: Runtime, params: {reason: string, stopDevices: boolean, detachPhysical: boolean}, timeoutMs: number, status: Status|null, verified: Verified|null) => Promise<import('../domain/broker-supervision.mjs').BrokerOwnerCleanup>} cleanupOwner
 */
export {};
