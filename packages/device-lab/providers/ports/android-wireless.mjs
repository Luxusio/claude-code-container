/** Raw mutable observations retain the native result fields and identities.
 * @typedef {{status: any, stdout: any, stderr: any, signal?: any, error?: {message?: any} | null}} AndroidWirelessCommandResult
 */
/** Required synchronous leaf capabilities; the application owns every decision.
 * Publisher selection captures the existing bare callee before projection.
 * @typedef {{
 * discover: () => {adb: any, then?: never},
 * listDevices: (discovery: {adb: any}) => AndroidWirelessCommandResult,
 * tcpip: (adb: any, argv: any[], timeoutMs: any) => AndroidWirelessCommandResult,
 * pair: (adb: any, argv: any[], timeoutMs: any) => AndroidWirelessCommandResult,
 * connect: (adb: any, argv: any[], timeoutMs: any) => AndroidWirelessCommandResult,
 * selectJsonPublisher: () => ((value: any) => any),
 * selectTextPublisher: () => ((ok: boolean, text: string) => any)
 * }} AndroidWirelessPorts
 */
export {};
