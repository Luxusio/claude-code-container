import type { DesktopDevice, DesktopWindowList, DesktopIdentity, DesktopFrame, DesktopCapture, DesktopCursor, DesktopVm, DesktopInput, DesktopDirectAction, DesktopDirectResult, DesktopExecution, DesktopCommand, DesktopSshFacts } from '../domain/hyper-v-desktop-transfer.js';
export interface DesktopRoots {
    deviceRoot: string;
    privateRoot: string;
    credentialPath: string;
    sshPrivateKeyPath: string;
    sshHostPublicKeyPath: string;
    knownHostsPath: string;
}
export interface DesktopRepair {
    ok: true;
    device: DesktopDevice;
    reconciled: boolean;
}
export interface DesktopRepairFailure {
    ok: false;
    status: number;
    error: string;
    detail?: unknown;
}
export interface HyperVDesktopTransferPorts<Console, Stage, Bytes extends {
    readonly length: number;
}> {
    executable(name: string): string | null;
    incarnation(device: DesktopDevice): string | null;
    validIncarnation(value: unknown): value is string;
    pendingJournal(ownerId: string, stateKey: string, deviceId: string): boolean;
    repair(ownerId: string, stateKey: string, deviceId: string, device: DesktopDevice, powershell: string): Promise<DesktopRepair | DesktopRepairFailure>;
    ownershipNotes(ownerId: string, deviceId: string, incarnationId: string): string;
    createConsole(executable: string): Console;
    withConsoleLock<T>(ownerId: string, backend: string, deviceId: string, operation: () => Promise<T>): Promise<T>;
    capture(console: Console, identity: DesktopIdentity): Promise<DesktopCapture>;
    cursor(console: Console, identity: DesktopIdentity): Promise<DesktopCursor>;
    vms(console: Console, id: string): Promise<readonly DesktopVm[]>;
    input(console: Console, input: DesktopInput): Promise<void>;
    frame(ownerId: string, backend: string, deviceId: string, incarnationId: string): DesktopFrame | null;
    rememberFrame(ownerId: string, backend: string, deviceId: string, frame: DesktopFrame): undefined;
    timestamp(): string;
    windowCommand(backend: string, handle: string | null): string;
    linuxWindows(stdout: string): DesktopWindowList;
    utf8Length(text: string): number;
    linuxTypeCommand(text: string): string;
    linuxScrollCommand(direction: 'up' | 'down', amount: number): string;
    roots(ownerId: string, backend: 'windows-vm' | 'linux-vm', deviceId: string): DesktopRoots;
    assertPrivateRoot(ownerId: string, backend: 'windows-vm' | 'linux-vm', deviceId: string, privateRoot: string): undefined;
    readableSecret(path: string, label: 'hyper-v-linux-ssh-private-key' | 'hyper-v-guest-credential'): boolean;
    sshIdentity(ownerId: string, deviceId: string, hostPublicKeyPath: string, knownHostsPath: string, address: string, fingerprint: string): boolean;
    localPath(raw: string, label: 'hyper-v-linux-guest-transfer' | 'hyper-v-guest-transfer'): string;
    readSource(path: string, label: 'hyper-v-linux-guest-upload' | 'hyper-v-guest-upload', maxBytes: number): Bytes | null;
    allocateStage(privateRoot: string, direction: 'upload' | 'download', label: 'hyper-v-linux-guest-transfer-staging' | 'hyper-v-guest-upload-staging' | 'hyper-v-guest-download-staging'): {
        handle: Stage;
        path: string;
    };
    writeStage(privateRoot: string, stage: Stage, bytes: Bytes, label: 'hyper-v-linux-guest-upload-staging' | 'hyper-v-guest-upload-staging'): undefined;
    readStage(stage: Stage, maxBytes: number): Bytes | null;
    disposeStage(stage: Stage): undefined;
    writeDestination(path: string, bytes: Bytes, label: 'hyper-v-linux-guest-download' | 'hyper-v-guest-download'): undefined;
    base64Text(text: string): string;
    decodeBase64(encoded: string): Bytes;
    sshCommand(facts: DesktopSshFacts, executable: string, command: string): DesktopCommand;
    uploadCommand(facts: DesktopSshFacts, executable: string, path: string, remotePath: string): DesktopCommand;
    execute(command: DesktopCommand, timeoutMs: number, outputLimit: number): Promise<DesktopExecution>;
    direct(executable: string, timeoutMs: number, identity: DesktopIdentity & {
        credentialPath: string;
    }, action: DesktopDirectAction): Promise<DesktopDirectResult>;
    stateErrorCode(error: unknown): string | null;
    providerError(error: unknown): {
        code: string;
        validation: boolean;
    } | null;
    boundedErrorCode(error: unknown, fallback: string): string;
    redactExecution(execution: DesktopExecution, fallback: string): unknown;
}
