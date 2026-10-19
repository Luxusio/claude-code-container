export type InstallerRuntime = "docker" | "podman";
export type InstallerBuildResult =
    | { status: "ready"; then?: never }
    | { status: "failed"; cause: unknown; then?: never };
export type InstallerEvent =
    | { kind: "building" | "runtime-unavailable" | "image-built" | "path-present" | "path-added" | "path-removed" | "cli-installed" | "image-ready" | "image-partial-success" | "not-installed" }
    | { kind: "runtime-selected"; runtime: InstallerRuntime }
    | { kind: "image-current"; hash: string }
    | { kind: "image-rebuilding"; runtime: InstallerRuntime; previousHash: string | null; hash: string }
    | { kind: "image-build-failed"; runtime: InstallerRuntime; cause: unknown }
    | { kind: "path-directory-missing"; installDir: string }
    | { kind: "path-read-failed" | "path-write-failed"; installDir: string; cause: unknown }
    | { kind: "path-too-long"; installDir: string; length: number; limit: number }
    | { kind: "installed" | "removed"; path: string }
    | { kind: "permission-denied"; operation: "install" | "uninstall" }
    | { kind: "image-skipped"; reason: string };
export interface InstallerPorts {
    platform(): "windows" | "unix";
    sourceRoot(): string;
    installDirectory(): string;
    runtimeOverride(): string | undefined;
    githubTokenConfigured(): boolean;
    sourceBuild(): undefined;
    contentHash(files: readonly string[], directories: readonly string[]): string;
    runtimeAvailable(runtime: InstallerRuntime): boolean;
    imageLabel(runtime: InstallerRuntime, label: "content.hash" | "dockerfile.hash"): string | null;
    buildContainer(runtime: InstallerRuntime, hash: string, includeGithubSecret: boolean): InstallerBuildResult;
    resolvePath(path: string): string;
    joinPath(...parts: string[]): string;
    parentPath(path: string): string;
    basePath(path: string): string;
    realPath(path: string): string;
    pathKind(path: string): "missing" | "directory" | "file" | "symlink" | "other";
    createExclusiveDirectory(path: string): undefined;
    createTemporaryDirectory(prefix: string): string;
    removeEmptyDirectory(path: string): undefined;
    renamePath(source: string, destination: string): undefined;
    exists(path: string): boolean;
    removeFile(path: string): undefined;
    removeDirectory(path: string, force: boolean): undefined;
    ensureDirectory(path: string): undefined;
    copy(source: string, destination: string, recursive: boolean): undefined;
    writeUnixPackage(sourceRoot: string, targetDir: string): undefined;
    unixWrapperContent(targetDir: string): string;
    writeUnixLauncher(path: string, targetDir: string): undefined;
    writeWindowsLauncher(path: string): undefined;
    readUserPath(): string;
    writeUserPath(value: string): undefined;
    present(event: InstallerEvent): undefined;
    terminate(code: number): never;
}
