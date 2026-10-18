export interface AndroidAvdStorageOptions {
    env?: NodeJS.ProcessEnv;
    home?: string;
    root?: string;
    platform?: NodeJS.Platform;
    mountPoints?: Set<string>;
    suffixPattern?: string;
    onArtifactQuarantined?: (artifact: {
        name: string;
        originalPath: string;
        quarantinePath: string;
    }) => void;
    verifyInactive?: (name: string) => boolean;
}

export interface AndroidAvdArtifactCleanup {
    name: string;
    root: string;
    removed: number;
}

export interface AndroidAvdStorageAsyncOptions extends Omit<AndroidAvdStorageOptions, "verifyInactive" | "onArtifactQuarantined"> {
    onArtifactQuarantined?: (artifact: {
        name: string;
        originalPath: string;
        quarantinePath: string;
    }) => void | PromiseLike<void>;
    verifyInactive?: (name: string) => boolean | PromiseLike<boolean>;
}

export function androidAvdHome(options?: AndroidAvdStorageOptions): string;
export function ownedAndroidAvdName(name: unknown, ownerId: unknown, suffixPattern?: string): boolean;
export function listOwnedAndroidAvdArtifacts(ownerId: string, options?: AndroidAvdStorageOptions): Array<{
    name: string;
    root: string;
    rootIdentity: { dev: number; ino: number };
    dataPath: string | null;
    dataIdentity: { dev: number; ino: number } | null;
    iniPath: string | null;
    iniIdentity: { dev: number; ino: number } | null;
    quarantines: Array<{
        path: string;
        identity: { dev: number; ino: number };
    }>;
}>;
export function removeOwnedAndroidAvdArtifacts(
    name: string,
    ownerId: string,
    options?: AndroidAvdStorageOptions,
): AndroidAvdArtifactCleanup;

export function listOwnedAndroidAvdArtifactsAsync(
    ownerId: string,
    options?: AndroidAvdStorageAsyncOptions,
): Promise<ReturnType<typeof listOwnedAndroidAvdArtifacts>>;
export function removeOwnedAndroidAvdArtifactsAsync(
    name: string,
    ownerId: string,
    options?: AndroidAvdStorageAsyncOptions,
): Promise<AndroidAvdArtifactCleanup>;
