import type { DesktopArguments, DesktopOutcome } from '../domain/desktop-control-transfer.mjs';
export interface CommandReceipt { status: number | null; stdout: string; stderr: string }
export interface WindowList { windows: object[]; truncated?: boolean }
export interface HelperPayload {
    ok?: boolean; id?: string; type?: string; error?: string; provider?: string;
    clicked?: object; doubleClicked?: object; key?: object; typed?: object;
    scrolled?: object; cursor?: object | null; windows?: object[];
    downloadPath?: string; hostDownloadPath?: string;
}
export type HelperRequest =
    | { type: 'click' | 'double_click'; x: number; y: number; button: string }
    | { type: 'key'; key: string; keys: string }
    | { type: 'type'; text: string; keys: string }
    | { type: 'scroll'; x: number; y: number; direction: string; amount: number }
    | { type: 'drag'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
    | { type: 'focus_window'; handle: string }
    | { type: 'cursor_position'; x?: number; y?: number }
    | { type: 'window_list' }
    | { type: 'upload'; uploadPath: string; remotePath: string }
    | { type: 'download'; remotePath: string };
export type PathObservation = { ok: true; path: string } | { ok: false; message: string };
export interface InputStage<Handle> { ok: true; path: string; stagedPath: string; handle: Handle }
export interface OutputStage<Handle> { ok: true; path: string; stagedPath: string; handle: Handle }
export interface X11Ports {
    variant: 'x11';
    command(argv: (string | null | undefined)[]): CommandReceipt;
    boundedCommand(argv: string[], timeoutMs: number): CommandReceipt;
    windowList(timeoutMs: number): CommandReceipt;
    parseWindowList(stdout: string): WindowList;
    drag(x1: number, y1: number, x2: number, y2: number, durationMs: number): CommandReceipt;
}
export type WindowsHelperObservation<Helper> =
    | { helper: Helper; response: HelperPayload; error?: undefined }
    | { helper: Helper; error: string; helperDiagnostic?: { stage: string; readyMarkerPresent: boolean }; response?: undefined };
export interface WindowsPorts<Target, Helper, Upload> {
    variant: 'windows';
    target(deviceId: string | undefined): Target | undefined;
    workspace(target: Target): Helper;
    guestPath(path: string | undefined, helper: Helper, label: 'upload' | 'download'): PathObservation;
    inputPath(path: string | undefined): PathObservation;
    outputPath(path: string | undefined): PathObservation;
    stageUpload(helper: Helper, path: string): { ok: true; handle: Upload; guestPath: string } | { ok: false; message: string };
    disposeUpload(handle: Upload): undefined;
    request(target: Target, request: HelperRequest, timeoutMs: number | undefined): Promise<WindowsHelperObservation<Helper>>;
    readyMarkerPresent(helper: Helper): boolean;
    downloadOutput(helper: Helper, response: HelperPayload, remotePath: string): { ok: true; path: string } | { ok: false };
    copyDownload(source: string, destination: string): { ok: true } | { ok: false; error: string };
}
export type SshObservation<Bridge> = { ok: true; bridge: Bridge } | { ok: false; result: object };
export type MacosHelperObservation = { result: CommandReceipt; remoteScriptPath: string; error?: undefined } | { error: object; result?: undefined; remoteScriptPath?: undefined };
export interface MacosPorts<Target, Bridge, Input, Output> {
    variant: 'macos';
    target(deviceId: string | undefined): Target | undefined;
    helper(target: Target, subcommand: 'click' | 'double_click' | 'key' | 'type' | 'scroll' | 'focus_window' | 'drag' | 'move' | 'cursor_position' | 'window_list', argv: string[], timeoutMs: number | undefined): MacosHelperObservation;
    parseHelper(stdout: string): HelperPayload | null;
    bridge(target: Target, operation: 'device_upload' | 'device_download'): SshObservation<Bridge>;
    guestPath(path: string | undefined, label: 'upload' | 'download'): PathObservation;
    stageInput(path: string | undefined): InputStage<Input> | { ok: false; message: string };
    stageOutput(path: string | undefined): OutputStage<Output> | { ok: false; message: string };
    upload(target: Target, bridge: Bridge, stagedPath: string, remotePath: string, timeoutMs: number | undefined): CommandReceipt;
    download(target: Target, bridge: Bridge, remotePath: string, stagedPath: string, timeoutMs: number | undefined): CommandReceipt;
    commitOutput(handle: Output): PathObservation;
    disposeInput(handle: Input): undefined;
    disposeOutput(handle: Output): undefined;
}
export type DesktopControlTransferPorts<Target, Helper, Upload, Bridge, Input, Output> = X11Ports | WindowsPorts<Target, Helper, Upload> | MacosPorts<Target, Bridge, Input, Output>;
export interface DesktopControlTransfer { handle(name: string, args: DesktopArguments): Promise<DesktopOutcome> }
