/** Structural facts only; native references and their getters remain intact. */
export interface CodexStateMount { Type?: string; Source?: string; Destination?: string }
export interface PreviousCodexStateContainer { Image?: string; Mounts?: CodexStateMount[] }
export interface CodexStatePrincipal {
    uid: number;
    gid: number;
    mapping: "host" | "podman-keep-id" | "desktop";
    contractVersion: string;
}
export interface CodexStateRuntime { rootless: boolean; flavor: string }
export interface CodexStateDirectory {
    mode: bigint;
    uid: bigint;
    gid: bigint;
    dev: bigint;
    ino: bigint;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}
export interface CodexStateRootReceipt { dev: string; ino: string }
