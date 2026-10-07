export interface CccConfigPorts {
    readonly resolveConfigPath: () => string;
    readonly resolveHomePath: () => string;
    readonly createDirectory: (path: string, options: { readonly recursive: true; readonly mode: number }) => undefined;
    readonly fileExists: (path: string) => boolean;
    readonly readText: (path: string) => string;
    readonly processId: () => number;
    readonly writeText: (path: string, data: string | undefined, options: { readonly mode: number }) => undefined;
    readonly replaceFile: (tempPath: string, path: string) => undefined;
}
