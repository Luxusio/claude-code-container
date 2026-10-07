export interface VersionScanEntry {
    readonly name: string;
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
}

export interface VersionFileScanningPorts {
    readonly listDirectoryEntries: (directory: string) => readonly VersionScanEntry[];
    readonly observeFileByteSize: (file: string) => number;
    readonly readVersionFileText: (file: string) => string;
    readonly childPath: (directory: string, name: string) => string;
    readonly sourcePath: (baseDirectory: string, file: string) => string;
}

export interface VersionFileScanRequest {
    readonly baseDirectory: string;
    readonly directory: string;
    readonly depth: number;
    readonly maxDepth: number;
}
