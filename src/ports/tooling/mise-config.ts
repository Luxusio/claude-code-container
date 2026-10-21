export type MiseConfigEvent =
    | {kind: "missing-config"}
    | {kind: "scanning"}
    | {kind: "skipping"}
    | {kind: "preference-save-failed"}
    | {kind: "created"; path: string}
    | {kind: "remembered"; path: string};

export interface MiseConfigSetupPorts {
    readonly configPath: (projectPath: string, kind: "primary" | "alternate") => string;
    readonly skipMarkerPath: (projectPath: string) => string;
    readonly exists: (path: string) => boolean;
    readonly scanVersionFiles: (projectPath: string) => Map<string, string>;
    readonly chooseCreation: () => Promise<"create" | "skip-once" | "remember-skip">;
    readonly runToolDetection: (projectPath: string, configPath: string, files: Map<string, string>) => undefined;
    readonly writeDefaultConfig: (path: string) => undefined;
    readonly rememberSkip: (path: string) => undefined;
    readonly report: (event: MiseConfigEvent) => undefined;
}
