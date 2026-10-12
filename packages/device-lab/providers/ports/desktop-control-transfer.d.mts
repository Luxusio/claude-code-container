import type { DesktopArguments, DesktopOutcome } from '../domain/desktop-control-transfer.mjs';
// DesktopDeviceAccess still consumes this alias; control/transfer leaves use observations.
export interface CommandReceipt { status: number | null; stdout: string; stderr: string }
export interface NativeObservation { ok: boolean; evidence: unknown }
export interface ActiveWindowObservation extends NativeObservation { handle: string }
export interface FocusObservation extends NativeObservation { verified: boolean }
export interface DragArguments { x1: number; y1: number; x2: number; y2: number; durationMs: number }
export type PathObservation = { ok: true; path: string } | { ok: false; message: string };
export interface InputStage<Handle> { ok: true; path: string; stagedPath: string; handle: Handle }
export interface OutputStage<Handle> { ok: true; path: string; stagedPath: string; handle: Handle }
export interface X11Ports {
    variant: 'x11';
    windowList(timeoutMs: number): NativeObservation;
    activateWindow(handle: string, timeoutMs: number): NativeObservation;
    activeWindow(timeoutMs: number): ActiveWindowObservation;
    movePointer(x: number, y: number): NativeObservation;
    click(x: number | undefined, y: number | undefined, button: string): NativeObservation;
    doubleClick(x: number | undefined, y: number | undefined, button: string): NativeObservation;
    key(key: string | undefined): NativeObservation;
    type(text: string | null | undefined): NativeObservation;
    scroll(x: number | undefined, y: number | undefined, direction: string, amount: number): NativeObservation;
    cursorPosition(): NativeObservation;
    drag(args: DragArguments): NativeObservation;
}
export interface WindowsPorts<Target, Helper, Upload> {
    variant: 'windows';
    target(deviceId: string | undefined): Target | undefined;
    workspace(target: Target): Helper;
    guestPath(path: string | undefined, helper: Helper, label: 'upload' | 'download'): PathObservation;
    inputPath(path: string | undefined): PathObservation;
    outputPath(path: string | undefined): PathObservation;
    stageUpload(helper: Helper, path: string): { ok: true; handle: Upload; guestPath: string } | { ok: false; message: string };
    disposeUpload(handle: Upload): undefined;
    click(target: Target, x: number, y: number, button: string, timeoutMs: number | undefined): Promise<NativeObservation>;
    doubleClick(target: Target, x: number, y: number, button: string, timeoutMs: number | undefined): Promise<NativeObservation>;
    key(target: Target, key: string, timeoutMs: number | undefined): Promise<NativeObservation>;
    type(target: Target, text: string, timeoutMs: number | undefined): Promise<NativeObservation>;
    scroll(target: Target, x: number, y: number, direction: string, amount: number, timeoutMs: number | undefined): Promise<NativeObservation>;
    drag(target: Target, args: DragArguments, timeoutMs: number | undefined): Promise<NativeObservation>;
    focusWindow(target: Target, handle: string, timeoutMs: number | undefined): Promise<NativeObservation>;
    cursorPosition(target: Target, x: number | undefined, y: number | undefined, timeoutMs: number | undefined): Promise<NativeObservation>;
    windowList(target: Target, timeoutMs: number | undefined): Promise<NativeObservation>;
    upload(target: Target, guestPath: string, remotePath: string, timeoutMs: number | undefined): Promise<NativeObservation>;
    download(target: Target, remotePath: string, timeoutMs: number | undefined): Promise<NativeObservation>;
    downloadOutput(evidence: unknown, remotePath: string): { ok: true; path: string } | { ok: false };
    copyDownload(source: string, destination: string): NativeObservation;
}
export type SshObservation<Bridge> = { ok: true; bridge: Bridge } | { ok: false; evidence: unknown };
export interface MacosPorts<Target, Bridge, Stage> {
    variant: 'macos';
    target(deviceId: string | undefined): Target | undefined;
    supportsKey(key: string): boolean;
    click(target: Target, x: number, y: number, button: string, timeoutMs: number | undefined): NativeObservation;
    doubleClick(target: Target, x: number, y: number, button: string, timeoutMs: number | undefined): NativeObservation;
    key(target: Target, key: string, timeoutMs: number | undefined): NativeObservation;
    type(target: Target, text: string, timeoutMs: number | undefined): NativeObservation;
    scroll(target: Target, direction: string, amount: number, timeoutMs: number | undefined): NativeObservation;
    drag(target: Target, args: DragArguments, timeoutMs: number | undefined): NativeObservation;
    focusWindow(target: Target, handle: string, timeoutMs: number | undefined): FocusObservation;
    movePointer(target: Target, x: number, y: number, timeoutMs: number | undefined): NativeObservation;
    cursorPosition(target: Target, timeoutMs: number | undefined): NativeObservation;
    windowList(target: Target, timeoutMs: number | undefined): NativeObservation;
    bridge(target: Target, operation: 'device_upload' | 'device_download'): SshObservation<Bridge>;
    guestPath(path: string | undefined, label: 'upload' | 'download'): PathObservation;
    stageInput(path: string | undefined): InputStage<Stage> | { ok: false; message: string };
    stageOutput(path: string | undefined): OutputStage<Stage> | { ok: false; message: string };
    upload(target: Target, bridge: Bridge, stagedPath: string, remotePath: string, timeoutMs: number | undefined): NativeObservation;
    download(target: Target, bridge: Bridge, remotePath: string, stagedPath: string, timeoutMs: number | undefined): NativeObservation;
    commitOutput(handle: Stage): PathObservation;
    disposeInput(handle: Stage): undefined;
    disposeOutput(handle: Stage): undefined;
}
export type DesktopControlTransferPorts<Target, Helper, Upload, Bridge, Stage> = X11Ports | WindowsPorts<Target, Helper, Upload> | MacosPorts<Target, Bridge, Stage>;
export interface DesktopControlTransfer { handle(name: string, args: DesktopArguments): Promise<DesktopOutcome> }
