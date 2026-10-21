import type { ContainerIdentity } from "../domain/container/identity-image.js";
import type {
    ContainerRunContractMountMode,
    ContainerRunContractMountVerification,
    ContainerRunContractPorts,
    ContractInspection,
    HostConfigurationFacts,
    TextFact,
} from "../ports/container-run-contract.js";
import type { InspectedContainerMount } from "./container-mount-observations.js";

const PROJECT_MOUNT_IDENTITY_LABEL = "ccc.project.mount-identity";
const DEVICE_LAB_MOUNT_IDENTITY_LABEL = "ccc.device-lab.mount-identity";

type NativeInspection = {
    Id?: unknown;
    Image?: unknown;
    State?: { Running?: unknown };
    Mounts?: InspectedContainerMount[];
    Config?: { Env?: unknown; Labels?: Record<string, unknown> };
    HostConfig?: unknown;
};

export interface NativeContainerRunContractContext {
    containerId: string;
    projectPath: string;
    brokerAuthContainerPath: string;
    requiredMounts: readonly { containerPath: string }[];
    inspect(): Record<string, unknown> | null;
    selectedRuntime(): string;
    projectPathMatches(observed: string, expected: string): boolean;
    effectiveUserMatches(identity: ContainerIdentity): boolean;
    verifyMounts(observed: InspectedContainerMount[], mode: ContainerRunContractMountMode): ContainerRunContractMountVerification;
    report(reason: string): void;
    debugStrictFailure(reason: string): void;
    isRuntimeUnavailable(error: unknown): boolean;
}

function textFact(value: unknown): TextFact {
    return value === undefined ? { kind: "missing" }
        : typeof value === "string" ? { kind: "text", value }
        : { kind: "invalid" };
}

function labelText(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function envMap(values: unknown): Map<string, string> {
    const map = new Map<string, string>();
    if (!Array.isArray(values)) return map;
    for (const value of values) {
        const text = String(value);
        const index = text.indexOf("=");
        if (index > 0) map.set(text.slice(0, index), text.slice(index + 1));
    }
    return map;
}

function deviceEntries(devices: unknown): Array<{ hostPath: string; containerPath: string }> {
    if (!Array.isArray(devices)) return [];
    return devices.map(device => {
        if (!device || typeof device !== "object") return null;
        const entry = device as { PathOnHost?: unknown; PathInContainer?: unknown };
        return {
            hostPath: String(entry.PathOnHost || ""),
            containerPath: String(entry.PathInContainer || ""),
        };
    }).filter((entry): entry is { hostPath: string; containerPath: string } => Boolean(entry));
}

export function createNativeContainerRunContractPorts(
    context: NativeContainerRunContractContext,
): ContainerRunContractPorts {
    function inspect(): ContractInspection | null {
        const observed = context.inspect() as NativeInspection | null;
        if (!observed) return null;
        let capturedMounts: InspectedContainerMount[] | undefined;
        const mounts = () => capturedMounts ??= observed.Mounts || [];
        return {
            runningState: () => observed.State?.Running === true ? "running"
                : observed.State?.Running === false ? "stopped" : "unknown",
            imageId: () => String(observed.Image),
            identityLabels: () => ({
                version: labelText(observed.Config?.Labels?.["ccc.identity.version"]),
                uid: labelText(observed.Config?.Labels?.["ccc.identity.uid"]),
                gid: labelText(observed.Config?.Labels?.["ccc.identity.gid"]),
                mapping: labelText(observed.Config?.Labels?.["ccc.identity.mapping"]),
            }),
            environment: () => {
                const env = envMap(observed.Config?.Env);
                return {
                    brokerAuthFile: env.get("CCC_DEVICE_BROKER_AUTH_FILE"),
                    labRunner: env.get("CCC_LAB_RUNNER"),
                    labStatus: env.get("CCC_LAB_RUNNER_STATUS"),
                    labStateDirectory: env.get("CCC_LAB_STATE_DIR"),
                    labNetworkMode: env.get("CCC_LAB_NET_MODE"),
                    unsupportedReason: env.get("CCC_LAB_RUNNER_UNSUPPORTED_REASON"),
                };
            },
            hostConfiguration: (): HostConfigurationFacts | null => {
                const value = observed.HostConfig;
                if (!value || typeof value !== "object" || Array.isArray(value)) return null;
                const config = value as Record<string, unknown>;
                if (typeof config.Privileged !== "boolean") return null;
                // Only the trusted selected runtime permits Podman's omitted field.
                const normalized: Record<string, unknown> = !Object.hasOwn(config, "DeviceRequests") && context.selectedRuntime() === "podman"
                    ? { ...config, DeviceRequests: [] } : config;
                for (const key of ["Devices", "DeviceRequests", "GroupAdd"] as const) {
                    if (!Object.hasOwn(normalized, key) || normalized[key] !== null && !Array.isArray(normalized[key])) return null;
                }
                return {
                    privileged: config.Privileged,
                    initEnabled: () => (observed.HostConfig as { Init?: unknown } | undefined)?.Init === true,
                    deviceRequestsPresent: () => Array.isArray(normalized.DeviceRequests) && normalized.DeviceRequests.length > 0,
                    kvmReferencePresent: () => JSON.stringify(normalized.Devices ?? []).includes("/dev/kvm"),
                    devices: () => deviceEntries(normalized.Devices),
                    groups: () => Array.isArray(normalized.GroupAdd) ? normalized.GroupAdd.map(String) : [],
                    groupCount: () => Array.isArray(normalized.GroupAdd) ? normalized.GroupAdd.length : 0,
                };
            },
            managedLabel: () => labelText(observed.Config?.Labels?.["ccc.managed"]),
            projectPathIdentity: () => {
                const path = observed.Config?.Labels?.["ccc.project.path"];
                if (!path) return "missing";
                return context.projectPathMatches(path as string, context.projectPath) ? "matching" : "different";
            },
            projectMountIdentity: () => textFact(observed.Config?.Labels?.[PROJECT_MOUNT_IDENTITY_LABEL]),
            deviceLabMountIdentity: () => textFact(observed.Config?.Labels?.[DEVICE_LAB_MOUNT_IDENTITY_LABEL]),
            containerId: () => typeof observed.Id === "string" ? observed.Id : null,
            brokerAuthMountPresent: () => mounts().some(mount => mount.Destination === context.brokerAuthContainerPath),
            verifyMounts: mode => context.verifyMounts(mounts(), mode),
        };
    }
    return {
        inspect,
        effectiveUserMatches: identity => context.effectiveUserMatches(identity),
        brokerAuthMountRequired: () => context.requiredMounts.some(mount => mount.containerPath === context.brokerAuthContainerPath),
        report: reason => context.report(reason),
        debugStrictFailure: reason => context.debugStrictFailure(reason),
        isRuntimeUnavailable: error => context.isRuntimeUnavailable(error),
    };
}
