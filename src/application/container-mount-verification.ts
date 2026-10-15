import {
    validateObservedMountSet,
    verifyMountSet,
    type MountEvidence,
    type MountPresencePolicy,
    type MountVerification,
    type ObservedMountContract,
    type RequiredMountContract,
} from "../bind-mount-verification.js";
import type {
    ContainerMountVerification,
    ContainerMountVerificationPorts,
    StoppedMountPreflight,
} from "../ports/container-mount-verification.js";

/** Admission policy consumes facts; native source interpretation stays outward. */
export function createContainerMountVerification(
    requiredMounts: RequiredMountContract[],
    ports: ContainerMountVerificationPorts,
): ContainerMountVerification {
    function evidenceFor(
        required: RequiredMountContract,
        observed: ObservedMountContract | undefined,
        policy: MountPresencePolicy,
        finalAttempt: boolean,
    ): MountEvidence {
        if (!observed || required.sourceKind === "none") return {};
        const path = required.containerPath;
        if (required.sourceKind === "filesystem") {
            const hostIdentity = ports.observeHostIdentity(path);
            if (hostIdentity.kind === "mismatch") {
                return { authoritativeMismatch: `bind source identity changed for ${path}` };
            }
            const source = ports.observeSource(path);
            if (source.kind !== "filesystem") return {};
            if (source.pathMatch === "unavailable") return { sourcePathUnavailable: true };
            const sourcePathMatches = source.pathMatch === "match";
            const liveProof = hostIdentity.kind === "retryable"
                ? hostIdentity
                : sourcePathMatches
                    ? ports.proveFilesystem(path, finalAttempt)
                    : { kind: "mismatch", reason: `bind source changed for ${path}` } as const;
            return { sourcePathMatches, liveProof };
        }
        const source = ports.observeSource(path);
        if (source.kind === "volume") return { volumeSourceMatches: source.matches };
        if (source.kind !== "path" && source.kind !== "daemon") return {};
        if (source.requireLiteralSource) {
            // Custom daemon mounts must pass the shape gate before any live probe.
            if ((required.type !== undefined && observed.type !== required.type)
                || (required.readonly !== undefined && observed.writable !== !required.readonly)) return {};
            if (!source.literalSourceMatch) {
                return { authoritativeMismatch: `bind source changed for ${path}` };
            }
            return { sourcePathMatches: true, liveProof: ports.proveDaemon() };
        }
        if (source.generalPathMatch === "unavailable") return { sourcePathUnavailable: true };
        const sourcePathMatches = source.generalPathMatch === "match";
        if (source.kind === "daemon" && !sourcePathMatches) {
            return {
                sourcePathMatches,
                liveProof: policy === "strict"
                    ? { kind: "mismatch", reason: `bind source changed for ${path}` }
                    : ports.proveDaemon(),
            };
        }
        return {
            sourcePathMatches,
            ...(source.kind === "daemon" && sourcePathMatches && source.requireDaemonProofOnMatch
                ? { liveProof: ports.proveDaemon() }
                : {}),
        };
    }

    function verifyOnce(
        observed: ObservedMountContract[],
        policy: MountPresencePolicy,
        allowUnexpected: boolean,
        finalAttempt: boolean,
    ): MountVerification {
        ports.resetAttempt();
        const shape = validateObservedMountSet(requiredMounts, observed, allowUnexpected);
        if (shape.kind === "mismatch") return shape;
        const byPath = new Map(observed.map(mount => [mount.containerPath, mount]));
        const evidence = new Map<string, MountEvidence>();
        for (const required of requiredMounts) {
            evidence.set(required.containerPath, evidenceFor(
                required,
                byPath.get(required.containerPath),
                policy,
                finalAttempt,
            ));
        }
        return verifyMountSet(requiredMounts, observed, evidence, { policy, allowUnexpected });
    }

    function withVerificationRetry(operation: (finalAttempt: boolean) => MountVerification): MountVerification {
        try {
            return ports.withRetry(operation, result => result.kind === "retryable");
        } finally {
            ports.cleanup();
        }
    }

    return {
        verifyExisting: (observed, policy, allowUnexpected = false) => withVerificationRetry(
            finalAttempt => verifyOnce(observed, policy, allowUnexpected, finalAttempt),
        ),
        preflightStopped(observed): StoppedMountPreflight {
            const shape = validateObservedMountSet(requiredMounts, observed);
            if (shape.kind === "mismatch") return shape;
            const byPath = new Map(observed.map(mount => [mount.containerPath, mount]));
            for (const required of requiredMounts) {
                const path = required.containerPath;
                const mount = byPath.get(path);
                const mismatch = (reason: string): StoppedMountPreflight => ({
                    kind: "mismatch", reason: `${reason} for ${path}`,
                });
                if (!mount) {
                    if (required.presence === "optional") continue;
                    return { kind: "mismatch", reason: `missing mount ${path}` };
                }
                if (required.type !== undefined && mount.type !== required.type) return mismatch("mount type changed");
                if (required.readonly !== undefined && mount.writable !== !required.readonly) return mismatch("mount access changed");
                if (required.sourceKind === "none") continue;
                if (required.sourceKind === "volume") {
                    const source = ports.observeSource(path);
                    if (source.kind !== "volume" || !source.matches) return mismatch("volume source changed");
                    continue;
                }
                if (mount.type !== "bind" || mount.sourceState !== "present") return mismatch("bind source missing");
                if (required.sourceKind === "filesystem") {
                    const host = ports.observeHostIdentity(path);
                    if (host.kind !== "verified") {
                        return {
                            kind: host.kind,
                            reason: `bind source identity ${host.kind === "mismatch" ? "changed" : "unavailable"} for ${path}`,
                        };
                    }
                    const source = ports.observeSource(path);
                    if (source.kind !== "filesystem") return mismatch("bind source changed");
                    if (source.pathMatch === "unavailable") return { kind: "retryable", reason: `bind source unreadable for ${path}` };
                    if (source.pathMatch !== "match") return mismatch("bind source changed");
                } else {
                    const source = ports.observeSource(path);
                    if (source.kind !== "path" && source.kind !== "daemon") return mismatch("bind source changed");
                    if (source.generalPathMatch === "unavailable") return { kind: "retryable", reason: `bind source unreadable for ${path}` };
                    if (source.generalPathMatch !== "match") return mismatch("bind source changed");
                }
            }
            return { kind: "preflight-verified" };
        },
        verifyCreated: (expectedId, expectedProjectIdentity) => withVerificationRetry(finalAttempt => {
            const observed = ports.inspectCreated();
            if (observed.kind === "unavailable") {
                return { kind: "retryable", reason: "created container inspection is temporarily unavailable" };
            }
            if (observed.containerId !== expectedId) {
                return { kind: "mismatch", reason: "created container identity changed during inspection" };
            }
            if (observed.projectMountIdentity !== expectedProjectIdentity) {
                return { kind: "mismatch", reason: "created container project mount identity label changed" };
            }
            const verification = verifyOnce(observed.mounts, "strict", false, finalAttempt);
            if (verification.kind !== "verified") return verification;
            return ports.requiresFinalDaemonProof() ? ports.proveDaemon() : verification;
        }),
    };
}
