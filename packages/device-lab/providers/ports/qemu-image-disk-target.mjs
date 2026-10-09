/** Raw metadata stays mutable and retains fields outside these operations.
 * @typedef {{[key: string]: unknown, pid?: unknown, command?: unknown, startedAt?: unknown}} QemuRuntime
 * @typedef {{[key: string]: unknown, id: string, name: string, provider?: string, runtimeState: string,
 * image?: {[key: string]: unknown, sourceImage?: string, diskImage?: string, format?: unknown},
 * paths: {[key: string]: unknown, labDir: string, workspaceDir: string, artifactsDir: string}, runtime?: unknown,
 * readiness?: {[key: string]: unknown, latest?: {[key: string]: unknown, state?: unknown} | null},
 * guest?: {[key: string]: unknown, ssh?: unknown, agent?: unknown}}} QemuLab
 * @typedef {{[key: string]: unknown, ok: false, error: string}} QemuFailure
 * @typedef {{[key: string]: unknown, ok: true, path: string, format: string}} QemuImageSource
 * @typedef {{[key: string]: unknown, available: boolean, qemuImg?: string | null}} QemuProviderStatus
 * @typedef {{[key: string]: unknown, ok?: boolean, args?: unknown}} QemuExecution
 * @typedef {{[key: string]: unknown, labId?: unknown, force?: unknown, dryRun?: unknown}} QemuDiskArguments
 * @typedef {{[key: string]: unknown, labId?: unknown}} QemuTargetArguments
 * @typedef {null | boolean | number | string | QemuImageMetadata[] | {[key: string]: QemuImageMetadata}} QemuImageMetadata
 * @typedef {{kind: string, path: string, backingPath: string, backingFormat: string, materializedAt: string, forced: boolean}} QemuDiskMetadata
 * @typedef {{ok: true, command: string, args: string[], dryRun?: boolean, providerStatus?: QemuProviderStatus, result?: QemuExecution | null}} QemuOverlaySuccess
 * @typedef {QemuOverlaySuccess | QemuFailure} QemuOverlayResult
 * @typedef {{ok: true, ownerId: string, lab: QemuLab, materialized: boolean, diskImage: string,
 * reused?: boolean, dryRun?: boolean, plan?: QemuOverlaySuccess, disk?: QemuDiskMetadata, result?: QemuExecution | null}} QemuDiskSuccess
 * @typedef {QemuDiskSuccess | QemuFailure} QemuDiskResult
 * @typedef {{id: string, labId: string, name: string, targetKind: string, provider: string, runtimeState: string,
 * readiness: string, sessionState: string, attachable: boolean, creatable: boolean,
 * runtime: {pid: unknown, command: unknown, startedAt: unknown} | null,
 * readinessProbe: {[key: string]: unknown, state?: unknown} | null,
 * paths: {workspaceDir: string, artifactsDir: string},
 * sessionHints: {monitor: string, metadata: string, guestSsh: string, guestAgent: string}}} QemuTarget
 * @typedef {{ok: true, ownerId: string, targets: QemuTarget[]} | QemuFailure} QemuTargetResult
 */
/** Synchronous native observation, guarded storage, execution and presentation leaves.
 * @typedef {object} QemuImageDiskTargetPorts
 * @property {string} ownerId
 * @property {unknown} [providerCommandTimeoutMs]
 * @property {() => boolean} imagesRootExists
 * @property {() => Array<{name: string, isDirectory(): boolean}>} imageEntries
 * @property {(name: string) => QemuImageMetadata} readImageMetadata
 * @property {(labId: string) => {ok: true, lab: QemuLab} | QemuFailure} readLab
 * @property {(sourcePath: string | undefined, format: unknown) => QemuImageSource | QemuFailure} validateImageSource
 * @property {(lab: QemuLab) => {ok: true, diskPath: string} | QemuFailure} validateDiskPath
 * @property {(diskPath: string) => boolean} diskExists
 * @property {() => QemuProviderStatus} providerStatus
 * @property {(diskPath: string) => undefined} ensureDiskParent
 * @property {() => (command: string, args: string[], options: {cwd: string, env: Record<string, string | undefined>, timeoutMs: number}) => QemuExecution | null | undefined} qemuImageRunner
 * @property {() => Record<string, string | undefined>} commandEnvironment
 * @property {() => string} now
 * @property {(lab: QemuLab) => undefined} writeLab
 * @property {(lab: QemuLab) => QemuLab} presentLab
 * @property {<T>(execution: T) => T} presentExecution
 * @property {() => QemuLab[]} ownerLabs
 */
export {};
