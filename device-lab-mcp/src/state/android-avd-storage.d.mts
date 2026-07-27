export interface AndroidAvdStorageOptions {
    env?: NodeJS.ProcessEnv;
    home?: string;
    suffixPattern?: string;
}

export interface AndroidAvdArtifactCleanup {
    name: string;
    root: string;
    removed: number;
}

export function androidAvdHome(options?: AndroidAvdStorageOptions): string;
export function ownedAndroidAvdName(name: unknown, ownerId: unknown, suffixPattern?: string): boolean;
export function listOwnedAndroidAvdArtifacts(ownerId: string, options?: AndroidAvdStorageOptions): Array<{
    name: string;
    root: string;
    dataPath: string | null;
    iniPath: string | null;
}>;
export function removeOwnedAndroidAvdArtifacts(
    name: string,
    ownerId: string,
    options?: AndroidAvdStorageOptions,
): AndroidAvdArtifactCleanup;
