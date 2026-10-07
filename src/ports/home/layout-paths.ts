export interface HomePathPorts {
    readonly homeDirectory: () => string;
    readonly joinHostPath: (...parts: string[]) => string;
    readonly entryExists: (path: string) => boolean;
    readonly createDirectory: (path: string, options: { readonly recursive: true; readonly mode: number }) => undefined;
    readonly writeMarker: (path: string, content: string, options: { readonly mode: number }) => undefined;
}
