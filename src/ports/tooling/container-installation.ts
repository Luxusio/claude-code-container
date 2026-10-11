export type ContainerToolFailureReason = "timeout" | "failure";
export type ContainerToolEffect<Evidence> =
    | { kind: "succeeded" }
    | { kind: "failed"; reason: ContainerToolFailureReason; evidence: Evidence };
export type ClaudeProbeObservation<Evidence> =
    | { kind: "valid" }
    | { kind: "restored"; version: string }
    | { kind: "install-needed" }
    | { kind: "invalid" }
    | { kind: "failed"; reason: ContainerToolFailureReason; evidence: Evidence };
export type ClaudeConfirmation<Evidence> =
    | { kind: "usable" }
    | { kind: "unusable"; evidence: Evidence };
export type NpmWrapperObservation<Evidence> =
    | { kind: "present" }
    | { kind: "missing" }
    | { kind: "failed"; reason: ContainerToolFailureReason; evidence: Evidence };
export type NpmCacheObservation<Evidence> =
    | { kind: "ready" }
    | { kind: "missing" }
    | { kind: "invalid" }
    | { kind: "failed"; reason: ContainerToolFailureReason; evidence: Evidence };
export type DependencyObservation<Evidence> =
    | { kind: "available" }
    | { kind: "missing" }
    | { kind: "failed"; reason: ContainerToolFailureReason; evidence: Evidence };

export interface NpmInstallationDefinition {
    readonly cmd: string;
    readonly pkg: string;
}
export interface BubblewrapSession<Evidence> {
    probe(): DependencyObservation<Evidence>;
    updatePackageIndex(): ContainerToolEffect<Evidence>;
    install(): ContainerToolEffect<Evidence>;
}
export type ContainerToolMutation =
    | "claude-install" | "npm-cache" | "npm-cleanup" | "npm-shim-cleanup"
    | "npm-install" | "npm-reshim" | "npm-wrapper"
    | "bubblewrap-probe" | "bubblewrap-update" | "bubblewrap-install"
    | "bubblewrap-confirmation" | "uv-install";
export type ContainerToolFailure =
    | { kind: "claude-probe-failed"; reason: ContainerToolFailureReason }
    | { kind: "claude-probe-invalid" }
    | { kind: "claude-confirmation-failed" }
    | { kind: "npm-definition-missing"; toolName: string }
    | { kind: "npm-wrapper-failed"; reason: ContainerToolFailureReason }
    | { kind: "npm-cache-invalid"; command: string }
    | { kind: "uv-probe-failed"; reason: ContainerToolFailureReason }
    | { kind: "mutation-failed"; mutation: ContainerToolMutation; reason: ContainerToolFailureReason; command?: string };
export type ContainerToolEvent =
    | { kind: "claude-restored"; version: string }
    | { kind: "claude-installing" }
    | { kind: "npm-installing"; command: string }
    | { kind: "bubblewrap-installing" }
    | { kind: "uv-installing" };

/** Native handles and evidence are opaque; applications consume finite facts. */
export interface ContainerToolInstallationPorts<ProbeHandle, Evidence = unknown> {
    prepareClaudeProbe(): ProbeHandle;
    probeClaude(target: string, probe: ProbeHandle): ClaudeProbeObservation<Evidence>;
    confirmClaude(target: string, probe: ProbeHandle): ClaudeConfirmation<Evidence>;
    installClaude(target: string): ContainerToolEffect<Evidence>;
    getNpmTools(): NpmInstallationDefinition[];
    probeNpmWrapper(target: string, tool: NpmInstallationDefinition): NpmWrapperObservation<Evidence>;
    probeNpmCache(target: string, tool: NpmInstallationDefinition): NpmCacheObservation<Evidence>;
    cleanupNpmPackage(target: string, tool: NpmInstallationDefinition): ContainerToolEffect<Evidence>;
    cleanupNpmShim(target: string, tool: NpmInstallationDefinition): ContainerToolEffect<Evidence>;
    installNpm(target: string, tool: NpmInstallationDefinition): ContainerToolEffect<Evidence>;
    reshimNpm(target: string): ContainerToolEffect<Evidence>;
    writeNpmWrapper(target: string, tool: NpmInstallationDefinition): ContainerToolEffect<Evidence>;
    createBubblewrapSession(target: string): BubblewrapSession<Evidence>;
    probeUv(target: string): DependencyObservation<Evidence>;
    installUv(target: string): ContainerToolEffect<Evidence>;
    report(event: ContainerToolEvent): undefined;
    fail(failure: ContainerToolFailure, evidence?: Evidence): never;
}
