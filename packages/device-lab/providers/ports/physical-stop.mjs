/** Raw owner records retain fields outside this operation's policy.
 * @typedef {{[key: string]: unknown, runtimeId?: string, operation?: string, claimedAt?: string}} PhysicalLifecycle
 * @typedef {{[key: string]: unknown, active?: boolean, pid?: number | null, runtimeId?: string, processIdentity?: object | null, endedAt?: string}} PhysicalRecording
 * @typedef {{[key: string]: unknown, id: string, status?: string, serial?: string | null, udid?: string, pid?: number | null, appium?: object | null, recording?: PhysicalRecording | null, lifecycle?: PhysicalLifecycle | null, updatedAt?: string}} PhysicalDevice
 * @typedef {{matched: boolean, found: boolean, device: PhysicalDevice | null, currentDevice: PhysicalDevice | null}} PhysicalTransition
 * @typedef {{attempted: boolean, signaled: boolean, exited?: boolean, reason?: string}} PhysicalSignalResult
 * @typedef {{status: number | null, stdout: string, stderr: string}} PhysicalCommandResult
 * @typedef {{exited: boolean, signaled?: boolean, reason?: string, error?: string, recordingStopped?: boolean}} PhysicalExitResult
 * @typedef {{content: Array<{type: string, text: string}>, isError: boolean}} PhysicalStopResponse
 */
/** Native storage and presentation remain synchronous.
 * @typedef {{
 * find: (deviceId: string) => PhysicalDevice | null,
 * transition: (deviceId: string, expected: PhysicalDevice, replacement: PhysicalDevice | null) => PhysicalTransition,
 * now: () => string,
 * runtimeId: () => string,
 * signalRecording: (recording: PhysicalRecording, signal: "SIGINT") => PhysicalSignalResult,
 * textResult: (ok: boolean, text: string | undefined) => PhysicalStopResponse,
 * jsonResult: (value: object) => PhysicalStopResponse,
 * withTargetStatus: (device: PhysicalDevice) => object
 * }} PhysicalStopCommonPorts
 */
/** Selected ADB commands use the existing native runner's default UTF-8 result.
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
