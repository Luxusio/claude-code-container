export type DesktopRecord = Record<string, unknown>;
export interface DesktopRpcResult {
    status: number;
    payload: unknown;
}
/** Raw request fields retain their input types until the application admits them. */
export interface DesktopArguments {
    incarnationId?: unknown;
    helperTimeoutMs?: unknown;
    command?: unknown;
    key?: unknown;
    text?: unknown;
    x?: unknown;
    y?: unknown;
    x1?: unknown;
    y1?: unknown;
    x2?: unknown;
    y2?: unknown;
    durationMs?: unknown;
    button?: unknown;
    direction?: unknown;
    amount?: unknown;
    handle?: unknown;
    maxFileBytes?: unknown;
    [extension: string]: unknown;
}
/** The native owner record is observed in place; admission narrows reached fields. */
export interface DesktopDevice {
    id?: unknown;
    incarnationId?: unknown;
    vmId?: unknown;
    vmName?: unknown;
    diskPath?: unknown;
    deviceRoot?: unknown;
    privateRoot?: unknown;
    guestCredentialPath?: unknown;
    sshPrivateKeyPath?: unknown;
    sshHostPublicKeyPath?: unknown;
    sshHostKeyFingerprint?: unknown;
    sshKnownHostsPath?: unknown;
    guestUsername?: unknown;
    networkAddress?: unknown;
    [extension: string]: unknown;
}
export interface DesktopWindow {
    handle: string;
    title: string;
    processId?: number;
}
export interface DesktopWindowList {
    windows: DesktopWindow[];
    truncated?: boolean;
}
export interface DesktopRequest {
    tool: string;
    deviceId: string | null;
    localPath: string | null;
    remotePath: string | null;
    params: DesktopArguments;
}
export interface DesktopTarget {
    backend: string | null;
    stateKey: string;
    device: DesktopDevice;
}
export interface DesktopIdentity {
    selector: {
        kind: 'id';
        id: string;
    };
    expectedName: string;
    expectedNotes: string;
}
export interface DesktopFrame {
    incarnationId: string;
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
    capturedAt: string;
}
export interface DesktopCapture {
    pngBase64: string;
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
}
export interface DesktopCursor {
    x: number;
    y: number;
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
}
export interface DesktopVm {
    id: string;
    name: string;
    notes: string | null;
    state: string;
}
export type DesktopPointer = {
    x: number;
    y: number;
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
};
export type DesktopInput = DesktopIdentity & ((DesktopPointer & {
    action: 'click' | 'doubleClick';
    button: 'left' | 'right';
}) | (DesktopPointer & {
    action: 'cursor';
}) | (DesktopPointer & {
    action: 'drag';
    x2: number;
    y2: number;
    durationMs: number;
}) | (DesktopPointer & {
    action: 'scroll';
    direction: 'up' | 'down';
    amount: number;
}) | {
    action: 'key';
    keys: readonly string[];
} | {
    action: 'type';
    text: string;
});
export type DesktopDirectAction = {
    action: 'exec';
    command: string;
} | {
    action: 'upload';
    localPath: string;
    remotePath: string;
} | {
    action: 'download';
    localPath: string;
    remotePath: string;
    maxBytes: number;
};
export type DesktopDirectResult = {
    action: 'exec';
    status: number;
    stdout: string;
    stderr: string;
} | {
    action: 'job';
    output: string;
} | {
    action: 'mkdir';
} | {
    action: 'upload' | 'download';
    localPath: string;
    remotePath: string;
    bytes: number;
};
export type DesktopExecution = {
    mode?: string;
    provider?: string;
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    timedOut?: boolean;
};
export interface DesktopCommand {
    mode: 'exec';
    provider: string;
    executable: string;
    args: string[];
}
export interface DesktopSshFacts {
    deviceRoot: string;
    privateRoot: string;
    sshPrivateKeyPath: string;
    knownHostsPath: string;
    guestUsername: string;
    networkAddress: string;
    timeoutMs: number;
}
export function desktopRecord(value: unknown): value is DesktopRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
export function desktopField(record: DesktopDevice, key: string): string | null { return typeof record[key] === 'string' ? record[key] : null; }
export function desktopSucceeded(result: DesktopExecution) { return result.status === 0 && !result.error; }
export const DESKTOP_CONSOLE_TOOLS: ReadonlySet<string> = new Set(['device_screenshot', 'device_click', 'device_double_click', 'device_drag', 'device_key', 'device_type', 'device_scroll', 'device_cursor_position']);
export function desktopReadOnly(tool: string) { return ['device_screenshot', 'device_cursor_position', 'device_window_list'].includes(tool); }
export function desktopInputFailure(result: DesktopRpcResult, tool: string): DesktopRpcResult {
    const payload = desktopRecord(result.payload) ? result.payload : {
        ok: false
    };
    return {
        ...result, payload: {
            ...payload, tool
        }
    };
}
const keyNames = new Set([
    "CTRL", "ALT", "SHIFT", "WIN", "ENTER", "TAB", "ESC", "SPACE", "BACKSPACE", "DELETE",
    "INSERT", "HOME", "END", "PAGEUP", "PAGEDOWN", "UP", "DOWN", "LEFT", "RIGHT",
]);
const modifiers = new Set(["CTRL", "ALT", "SHIFT", "WIN"]);
export function hyperVConsolePixel(value: unknown, dimension: number): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < dimension
        ? value : null;
}
export function hyperVConsoleKeyTokens(value: unknown): string[] | null {
    if (typeof value !== "string" || value.length < 1 || value.length > 64)
        return null;
    const tokens = value.split("+").map((token) => token.trim().toUpperCase());
    if (tokens.length < 1 || tokens.length > 4 || tokens.some((token) => !token))
        return null;
    const normalized = tokens.map((token) => token === "CONTROL" ? "CTRL" : token === "ESCAPE" ? "ESC" : token);
    const valid = (token: string) => keyNames.has(token) || /^[A-Z0-9]$/.test(token) || /^F(?:[1-9]|1[0-2])$/.test(token);
    if (normalized.some((token) => !valid(token)))
        return null;
    if (normalized.slice(0, -1).some((token) => !modifiers.has(token)))
        return null;
    if (modifiers.has(normalized.at(-1) || ""))
        return null;
    if (new Set(normalized).size !== normalized.length)
        return null;
    return normalized;
}
export function hyperVConsoleText(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 && value.length <= 2048 && !value.includes("\0")
        ? value : null;
}
export function validateWindowHandle(handle: unknown): asserts handle is string {
    if (typeof handle !== "string" || !/^[1-9][0-9]{0,15}$/.test(handle) || !Number.isSafeInteger(Number(handle)))
        throw new Error("window-handle-invalid");
}
export function parseGuestFocusWindow(stdout: string): {
    ok: true;
} {
    if (stdout.length > 2048)
        throw new Error("window-focus-invalid-result");
    let result: unknown;
    try {
        result = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    }
    catch {
        throw new Error("window-focus-invalid-result");
    }
    if (desktopRecord(result) && typeof result.error === "string")
        throw new Error(result.error.slice(0, 512));
    if (!desktopRecord(result) || result.ok !== true)
        throw new Error("window-focus-invalid-result");
    return {
        ok: true
    };
}
export function parseWindowsGuestWindowList(stdout: string, byteLength: number): DesktopWindowList {
    if (byteLength > 1024 * 1024)
        throw new Error("window-list-invalid-result");
    let result: unknown;
    try {
        result = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    }
    catch {
        throw new Error("window-list-invalid-result");
    }
    if (desktopRecord(result) && typeof result.error === "string")
        throw new Error(result.error.slice(0, 512));
    if (!desktopRecord(result) || !Array.isArray(result.windows) || result.windows.length > 128
        || (result.truncated !== undefined && typeof result.truncated !== "boolean"))
        throw new Error("window-list-invalid-result");
    const windows = result.windows.map((row: unknown) => {
        if (!desktopRecord(row))
            throw new Error("window-list-invalid-result");
        const { title, handle, processId } = row;
        if (typeof title !== "string" || title.length > 512 || typeof handle !== "string" || !/^\d+$/.test(handle)
            || typeof processId !== "number" || !Number.isSafeInteger(processId) || Number(processId) <= 0)
            throw new Error("window-list-invalid-result");
        return {
            title, handle, processId
        };
    });
    return {
        windows, ...(result.truncated ? {
            truncated: true
        } : {})
    };
}
