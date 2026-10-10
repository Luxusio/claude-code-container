export type InstallerRuntime = "docker" | "podman";
export interface InstallerBuildResult {
    status: number | null;
    signal?: string | null;
    error?: Error;
    then?: never;
}
export interface InstallerPorts {
    platform(): "windows" | "unix";
    sourceRoot(): string;
    sourceEntry(): string;
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
    fileUrl(path: string): string;
    exists(path: string): boolean;
    isSymlink(path: string): boolean;
    removeFile(path: string): undefined;
    removeDirectory(path: string, force: boolean): undefined;
    ensureDirectory(path: string): undefined;
    copy(source: string, destination: string, recursive: boolean): undefined;
    readPackage(path: string): { version?: unknown; imports?: unknown };
    writeText(path: string, content: string): undefined;
    setMode(path: string, mode: number): undefined;
    readUserPath(): string;
    writeUserPath(value: string): undefined;
    log(message: string): undefined;
    warn(message: string, detail: unknown): undefined;
    error(message: string, detail?: unknown): undefined;
    terminate(code: number): never;
}
