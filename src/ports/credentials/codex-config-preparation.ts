import type { CodexConfigPreparationObservation, CodexConfigPreparationResult } from "../codex-config-preparation.js";

export interface CodexPreparationParent {
    readonly uid: number;
    readonly isDirectory: () => boolean;
}

export interface CodexPreparationConfig {
    readonly nlink: number;
    readonly isFile: () => boolean;
}

export type CodexPreparationConfigObservation =
    | { readonly kind: "present"; readonly metadata: CodexPreparationConfig }
    | { readonly kind: "missing"; readonly failure: unknown };

export type CodexPreparationConfigInspection = "allow-missing" | "required";

export type CodexPreparationObservation = CodexConfigPreparationObservation;
export type CodexPreparationResult = CodexConfigPreparationResult;

export interface CodexPreparationPorts {
    readonly resolveConfig: (profile?: string) => string;
    readonly hasHostIdentity: () => boolean;
    readonly inspectParent: (config: string) => CodexPreparationParent;
    readonly inspectConfig: (config: string, inspection: CodexPreparationConfigInspection) => CodexPreparationConfigObservation;
    readonly currentHostUid: () => number;
    readonly mappedContainerUid: (target: string) => string;
    readonly probeDirectory: (target: string, configFile: string) => CodexPreparationObservation;
    readonly repairDirectory: (target: string, configFile: string, mappedUid: string) => CodexPreparationResult;
    readonly verifyDirectory: (target: string, configFile: string) => CodexPreparationResult;
    readonly probeConfig: (target: string, configFile: string) => CodexPreparationObservation;
    readonly repairConfig: (target: string, configFile: string, mappedUid: string) => CodexPreparationResult;
    readonly verifyConfig: (target: string, configFile: string) => CodexPreparationResult;
}
