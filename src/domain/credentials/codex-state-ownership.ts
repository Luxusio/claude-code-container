/** Native runtime observations decoded into ownership facts. */
export type CodexStateMount =
    | { kind: "bind"; source: string; destination: string }
    | { kind: "other"; destination: string };
export interface PreviousCodexStateContainer { image: string; mounts: CodexStateMount[] }
export interface ActiveCodexStateContainer { id: string; mounts: CodexStateMount[] }
export interface CodexStateAccount { uid: number; gid: number }
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
