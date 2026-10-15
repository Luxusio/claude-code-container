/** Raw owner records retain fields outside this operation's policy.
 * @typedef {{[key: string]: unknown, runtimeId?: string, operation?: string, claimedAt?: string}} PhysicalLifecycle
 * @typedef {{[key: string]: unknown, active?: boolean, pid?: number | null, runtimeId?: string, processIdentity?: object | null, endedAt?: string}} PhysicalRecording
 * @typedef {{[key: string]: unknown, id: string, status?: string, serial?: string | null, udid?: string, pid?: number | null, appium?: object | null, recording?: PhysicalRecording | null, lifecycle?: PhysicalLifecycle | null, updatedAt?: string}} PhysicalDevice
 * @typedef {{matched: boolean, found: boolean, device: PhysicalDevice | null, currentDevice: PhysicalDevice | null}} PhysicalTransition
 * @typedef {{attempted: boolean, signaled: boolean, exited?: boolean, reason?: string}} PhysicalSignalResult
 * @typedef {{ok: boolean, detail: string}} PhysicalCommandResult
 * @typedef {{exited: boolean, signaled?: boolean, reason?: string, error?: string, recordingStopped?: boolean}} PhysicalExitResult
 * @typedef {{kind:"missing"}|{kind:"failure",error:string|undefined}|{kind:"conflict",backend:"android-device"|"ios-device",deviceId:string,operation:string,found:boolean}|{kind:"stopped",device:PhysicalDevice}} PhysicalStopOutcome
 */
/** Native storage and identity observations remain synchronous.
 * @typedef {{
 * find: (deviceId: string) => PhysicalDevice | null,
 * transition: (deviceId: string, expected: PhysicalDevice, replacement: PhysicalDevice | null) => PhysicalTransition,
 * now: () => string,
 * runtimeId: () => string,
 * signalRecording: (recording: PhysicalRecording, signal: "SIGINT") => PhysicalSignalResult
 * }} PhysicalStopCommonPorts
 */
/** The native backend classifies the selected ADB fallback and its diagnostic.
 * @typedef {PhysicalStopCommonPorts & {
 * backend: "android-device",
 * discoverAdb: () => string | null | undefined,
 * stopAdbRecording: (adb: string, serial: string) => PhysicalCommandResult,
 * waitRecordingExit: (pid: number | null | undefined, timeoutMs: number) => Promise<boolean>
 * }} AndroidPhysicalStopPorts
 */
/** Owned Appium session/process cleanup retains its existing native workflow.
 * @typedef {PhysicalStopCommonPorts & {
 * backend: "ios-device",
 * waitRecordingExit: (recording: PhysicalRecording, timeoutMs: number) => Promise<boolean>,
 * stopOwnedAppium: (appium: object | null | undefined, label: string) => Promise<PhysicalExitResult>
 * }} IosPhysicalStopPorts
 * @typedef {AndroidPhysicalStopPorts | IosPhysicalStopPorts} PhysicalStopPorts
 */
export {};
