import { getIdentityLabels, normalizeImageId } from "../domain/container/identity-image.js";
import type {
    ContainerRunContract,
    ContainerRunContractOptions,
    ContainerRunContractPorts,
    TextFact,
} from "../ports/container-run-contract.js";

/** Persisted fingerprints are hints; current bind proof decides stale values. */
export function mountIdentityLabelIsWellFormed(value: unknown): boolean {
    return value === undefined || value === ""
        || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}

function fingerprintIsWellFormed(fact: TextFact): boolean {
    return fact.kind === "missing"
        || fact.kind === "text" && mountIdentityLabelIsWellFormed(fact.value);
}

export function createContainerRunContract(
    options: ContainerRunContractOptions,
    ports: ContainerRunContractPorts,
): ContainerRunContract {
    const { containerId, identity, labRunner, brokerAuthContainerPath } = options;

    function matches(desiredImageId: string, phase: "preflight" | "live"): boolean | null {
        const inspected = ports.inspect();
        if (!inspected) {
            ports.report("container contract inspection failed");
            return null;
        }
        try {
            const failContract = (reason: string) => {
                ports.report(reason);
                ports.debugStrictFailure(reason);
                return false;
            };
            const state = inspected.runningState();
            if (phase === "preflight" && state === "unknown") {
                ports.report("container running state inspection failed");
                return null;
            }
            if (phase === "live" && state !== "running") {
                ports.report("container is not confirmed running during live verification");
                return null;
            }
            if (normalizeImageId(inspected.imageId()) !== normalizeImageId(desiredImageId)) {
                return failContract("image or user identity changed");
            }
            const expectedLabels = getIdentityLabels(identity);
            const labels = inspected.identityLabels();
            if (labels.version !== expectedLabels["ccc.identity.version"]
                || labels.uid !== expectedLabels["ccc.identity.uid"]
                || labels.gid !== expectedLabels["ccc.identity.gid"]
                || labels.mapping !== expectedLabels["ccc.identity.mapping"]) {
                return failContract("image or user identity changed");
            }
            const env = inspected.environment();
            const host = inspected.hostConfiguration();
            if (!host) return failContract("container host configuration is malformed");
            if (inspected.managedLabel() !== "true") return failContract("container is not CCC-managed");
            if (inspected.projectPathIdentity() !== "matching") return failContract("project path identity changed");
            if (!fingerprintIsWellFormed(inspected.projectMountIdentity())) {
                return failContract("project mount identity is malformed");
            }
            if (!fingerprintIsWellFormed(inspected.deviceLabMountIdentity())) {
                return failContract("device-lab mount identity is malformed");
            }
            const observedId = inspected.containerId();
            if (observedId === null) return failContract("bind mount identities could not be verified");
            if (observedId !== containerId) return failContract("container identity changed during contract inspection");
            const mounts = inspected.verifyMounts(phase === "preflight" && state === "stopped"
                ? "stopped-preflight" : "strict");
            if (mounts.kind === "retryable") {
                ports.report(mounts.reason);
                return null;
            }
            if (mounts.kind !== "verified" && mounts.kind !== "preflight-verified") {
                return failContract(mounts.reason);
            }
            const authRequired = ports.brokerAuthMountRequired();
            const authMounted = inspected.brokerAuthMountPresent();
            if (authRequired !== authMounted) return failContract("stale isolated device broker auth mount");
            if (authRequired && env.brokerAuthFile !== brokerAuthContainerPath) {
                return failContract("missing isolated device broker auth file environment");
            }
            if (!authRequired && env.brokerAuthFile !== undefined) {
                return failContract("stale isolated device broker auth file environment");
            }
            if (host.privileged) return failContract("stale privileged container");
            if (!host.initEnabled()) return failContract("missing init process");
            if (host.deviceRequestsPresent()) return failContract("unexpected host device requests");
            if (env.labRunner !== "1") return failContract("missing CCC_LAB_RUNNER=1");
            if (env.labStatus !== labRunner.status) return failContract(`CCC_LAB_RUNNER_STATUS is ${env.labStatus || "unset"}, expected ${labRunner.status}`);
            if (env.labStateDirectory !== labRunner.stateContainerDir) return failContract(`CCC_LAB_STATE_DIR is ${env.labStateDirectory || "unset"}, expected ${labRunner.stateContainerDir}`);
            if (env.labNetworkMode !== labRunner.networkMode) return failContract(`CCC_LAB_NET_MODE is ${env.labNetworkMode || "unset"}, expected ${labRunner.networkMode}`);
            if (labRunner.unsupportedReason && env.unsupportedReason !== labRunner.unsupportedReason) return failContract("unsupported reason changed");
            if (!labRunner.unsupportedReason && env.unsupportedReason !== undefined) return failContract("stale unsupported reason env");
            if (labRunner.status === "ready") {
                if (!host.kvmReferencePresent()) return failContract("missing /dev/kvm device");
                if (!labRunner.kvmDevicePath) return failContract("unexpected VM device set");
                const devices = host.devices();
                if (devices.length !== 1 || devices[0].hostPath !== labRunner.kvmDevicePath
                    || devices[0].containerPath !== labRunner.kvmDevicePath) {
                    return failContract("unexpected VM device set");
                }
                if (labRunner.kvmGroupId !== undefined && !host.groups().includes(String(labRunner.kvmGroupId))) {
                    return failContract(`missing kvm group ${labRunner.kvmGroupId}`);
                }
                const groups = host.groups();
                const expectedGroups = labRunner.kvmGroupId === undefined ? [] : [String(labRunner.kvmGroupId)];
                if (groups.length !== expectedGroups.length || !expectedGroups.every(value => groups.includes(value))) {
                    return failContract("unexpected extra VM group-add");
                }
            } else {
                if (host.devices().length > 0) return failContract("stale device on unsupported config");
                if (host.groupCount() > 0) return failContract("stale group-add on unsupported config");
            }
            return true;
        } catch (error) {
            if (ports.isRuntimeUnavailable(error)) throw error;
            ports.report("container contract inspection failed");
            return null;
        }
    }

    function safeToDefer(): boolean {
        const unsafe = (reason: string) => {
            ports.report(reason);
            return false;
        };
        const inspected = ports.inspect();
        if (!inspected) return unsafe("container contract inspection failed");
        try {
            if (inspected.managedLabel() !== "true") return unsafe("container is not CCC-managed");
            if (inspected.projectPathIdentity() !== "matching") return unsafe("project path identity changed");
            if (!fingerprintIsWellFormed(inspected.projectMountIdentity())) {
                return unsafe("project mount identity is malformed");
            }
            const host = inspected.hostConfiguration();
            if (!host) return unsafe("container host configuration is malformed");
            if (host.privileged) return unsafe("stale privileged container");
            const observedId = inspected.containerId();
            if (observedId === null) return unsafe("bind mount identities could not be verified");
            if (observedId !== containerId) return unsafe("container identity changed during contract inspection");
            if (inspected.runningState() !== "running") return unsafe("container is not confirmed running for safe defer");
            if (!ports.effectiveUserMatches(identity)) return unsafe("container UID/GID does not match the host identity");
            const mounts = inspected.verifyMounts("safe-defer");
            if (mounts.kind === "retryable" || mounts.kind === "mismatch") return unsafe(mounts.reason);
            const devices = host.devices();
            if (host.deviceRequestsPresent()) return unsafe("unexpected host device requests");
            const groups = host.groups();
            if (labRunner.status === "ready") {
                const expectedDevices = labRunner.kvmDevicePath ? [labRunner.kvmDevicePath] : [];
                if (devices.some(device => !expectedDevices.includes(device.hostPath) || device.hostPath !== device.containerPath)) {
                    return unsafe("unexpected VM device set");
                }
                const expectedGroups = labRunner.kvmGroupId === undefined ? [] : [String(labRunner.kvmGroupId)];
                if (groups.some(group => !expectedGroups.includes(group))) return unsafe("unexpected extra VM group-add");
            } else if (devices.length > 0 || groups.length > 0) {
                return unsafe("stale VM device or group on unsupported config");
            }
            return true;
        } catch (error) {
            if (ports.isRuntimeUnavailable(error)) throw error;
            return unsafe("container contract inspection failed");
        }
    }

    return { matches, safeToDefer };
}
