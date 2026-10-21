import type { ContainerIdentity } from "../domain/container/identity-image.js";
import type { ContainerLaunchLabConfig } from "../domain/container-launch-arguments.js";
import type { MountVerification } from "../domain/container/mount-verification.js";
import type { StoppedMountPreflight } from "./container-mount-verification.js";

export type RunningState = "running" | "stopped" | "unknown";
export type TextFact =
    | { kind: "missing" }
    | { kind: "text"; value: string }
    | { kind: "invalid" };
export type ContainerRunContractMountMode = "stopped-preflight" | "strict" | "safe-defer";
export type ContainerRunContractMountVerification = MountVerification | StoppedMountPreflight;

export interface ContractIdentityLabels {
    version: string | null;
    uid: string | null;
    gid: string | null;
    mapping: string | null;
}

export interface ContractEnvironment {
    brokerAuthFile?: string;
    labRunner?: string;
    labStatus?: string;
    labStateDirectory?: string;
    labNetworkMode?: string;
    unsupportedReason?: string;
}

export interface HostConfigurationFacts {
    privileged: boolean;
    initEnabled(): boolean;
    deviceRequestsPresent(): boolean;
    kvmReferencePresent(): boolean;
    devices(): readonly { hostPath: string; containerPath: string }[];
    groups(): readonly string[];
    groupCount(): number;
}

/** Staged observations from one fresh inspection of one bound container. */
export interface ContractInspection {
    runningState(): RunningState;
    imageId(): string;
    identityLabels(): ContractIdentityLabels;
    environment(): ContractEnvironment;
    hostConfiguration(): HostConfigurationFacts | null;
    managedLabel(): string | null;
    projectPathIdentity(): "missing" | "matching" | "different";
    projectMountIdentity(): TextFact;
    deviceLabMountIdentity(): TextFact;
    containerId(): string | null;
    brokerAuthMountPresent(): boolean;
    verifyMounts(mode: ContainerRunContractMountMode): ContainerRunContractMountVerification;
}

export interface ContainerRunContractPorts {
    inspect(): ContractInspection | null;
    effectiveUserMatches(identity: ContainerIdentity): boolean;
    brokerAuthMountRequired(): boolean;
    report(reason: string): void;
    debugStrictFailure(reason: string): void;
    isRuntimeUnavailable(error: unknown): boolean;
}

export interface ContainerRunContractOptions {
    containerId: string;
    identity: ContainerIdentity;
    labRunner: ContainerLaunchLabConfig;
    brokerAuthContainerPath: string;
}

export interface ContainerRunContract {
    matches(desiredImageId: string, phase: "preflight" | "live"): boolean | null;
    safeToDefer(): boolean;
}
