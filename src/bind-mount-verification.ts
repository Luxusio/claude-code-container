export type MountVerification =
    | { kind: "verified"; via: "shape" | "source" | "identity" | "daemon" }
    | { kind: "deferred"; reason: string; containerPath: string }
    | { kind: "retryable"; reason: string; containerPath?: string }
    | { kind: "mismatch"; reason: string; containerPath?: string };

export type LiveSourceProof =
    | { kind: "verified"; via: "identity" | "daemon" }
    | { kind: "retryable"; reason: string }
    | { kind: "mismatch"; reason: string };

export type MountPresence = "core" | "additive";
export type MountPresencePolicy = "strict" | "safe-defer";

export interface RequiredMountContract {
    containerPath: string;
    readonly?: boolean;
    type?: "bind" | "tmpfs" | "volume";
    presence: MountPresence;
    sourceKind: "none" | "filesystem" | "path" | "daemon" | "volume";
}

export interface ObservedMountContract {
    Source?: unknown;
    Destination?: unknown;
    RW?: unknown;
    Type?: unknown;
    Name?: unknown;
}

export interface MountEvidence {
    authoritativeMismatch?: string;
    sourcePathMatches?: boolean;
    sourcePathUnavailable?: boolean;
    liveProof?: LiveSourceProof;
    volumeSourceMatches?: boolean;
}

const verificationPriority: Record<MountVerification["kind"], number> = {
    verified: 0,
    deferred: 1,
    retryable: 2,
    mismatch: 3,
};

/** Aggregate without allowing an early missing-additive result to hide a later mismatch. */
export function combineMountVerification(
    current: MountVerification,
    candidate: MountVerification,
): MountVerification {
    return verificationPriority[candidate.kind] > verificationPriority[current.kind]
        || (candidate.kind === "verified" && current.kind === "verified")
        ? candidate
        : current;
}

function withPath(
    result: LiveSourceProof,
    containerPath: string,
): MountVerification {
    if (result.kind === "verified") return result;
    return { ...result, containerPath };
}

export function classifyRequiredMount(
    required: RequiredMountContract,
    observed: ObservedMountContract | undefined,
    evidence: MountEvidence,
    policy: MountPresencePolicy,
): MountVerification {
    const path = required.containerPath;
    if (evidence.authoritativeMismatch) {
        return { kind: "mismatch", reason: evidence.authoritativeMismatch, containerPath: path };
    }
    if (!observed) {
        return policy === "safe-defer" && required.presence === "additive"
            ? { kind: "deferred", reason: `missing mount ${path}`, containerPath: path }
            : { kind: "mismatch", reason: `missing mount ${path}`, containerPath: path };
    }
    if (required.readonly !== undefined && observed.RW !== !required.readonly) {
        return { kind: "mismatch", reason: `mount access changed for ${path}`, containerPath: path };
    }
    if (required.type !== undefined && observed.Type !== required.type) {
        return { kind: "mismatch", reason: `mount type changed for ${path}`, containerPath: path };
    }
    if (required.sourceKind === "volume") {
        return evidence.volumeSourceMatches
            ? { kind: "verified", via: "source" }
            : { kind: "mismatch", reason: `volume source changed for ${path}`, containerPath: path };
    }
    if (required.sourceKind === "none") return { kind: "verified", via: "shape" };
    if (observed.Type !== "bind" || typeof observed.Source !== "string" || observed.Source.length === 0) {
        return { kind: "mismatch", reason: `bind source missing for ${path}`, containerPath: path };
    }
    if (evidence.sourcePathUnavailable) {
        return { kind: "retryable", reason: `bind source unreadable for ${path}`, containerPath: path };
    }
    const sourceMatches = evidence.sourcePathMatches === true;
    if (required.sourceKind === "filesystem") {
        if (!sourceMatches) {
            return { kind: "mismatch", reason: `bind source changed for ${path}`, containerPath: path };
        }
        if (!evidence.liveProof) {
            return { kind: "retryable", reason: `bind source proof unavailable for ${path}`, containerPath: path };
        }
        return withPath(evidence.liveProof, path);
    }
    if (required.sourceKind === "daemon" && !sourceMatches) {
        if (!evidence.liveProof) {
            return { kind: "retryable", reason: `bind source proof unavailable for ${path}`, containerPath: path };
        }
        return withPath(evidence.liveProof, path);
    }
    return sourceMatches
        ? { kind: "verified", via: "source" }
        : { kind: "mismatch", reason: `bind source changed for ${path}`, containerPath: path };
}

export function verifyMountSet(
    requiredMounts: RequiredMountContract[],
    observedMounts: ObservedMountContract[],
    evidence: ReadonlyMap<string, MountEvidence>,
    options: { policy: MountPresencePolicy; allowUnexpected?: boolean },
): MountVerification {
    const shape = validateObservedMountSet(requiredMounts, observedMounts, options.allowUnexpected);
    if (shape.kind === "mismatch") return shape;
    const observedByPath = new Map<string, ObservedMountContract>();
    for (const mount of observedMounts) {
        observedByPath.set(mount.Destination as string, mount);
    }

    let result: MountVerification = { kind: "verified", via: "shape" };
    for (const required of requiredMounts) {
        result = combineMountVerification(
            result,
            classifyRequiredMount(
                required,
                observedByPath.get(required.containerPath),
                evidence.get(required.containerPath) ?? {},
                options.policy,
            ),
        );
    }
    return result;
}

export function validateObservedMountSet(
    requiredMounts: RequiredMountContract[],
    observedMounts: ObservedMountContract[],
    allowUnexpected = false,
): MountVerification {
    const requiredByPath = new Map(requiredMounts.map((mount) => [mount.containerPath, mount]));
    const destinations = new Set<string>();
    for (const mount of observedMounts) {
        if (!mount || typeof mount !== "object"
            || typeof mount.Destination !== "string" || mount.Destination.length === 0) {
            return { kind: "mismatch", reason: "unexpected mount <malformed-destination>" };
        }
        if (typeof mount.Source !== "string"
            || typeof mount.Type !== "string" || mount.Type.length === 0
            || typeof mount.RW !== "boolean") {
            return { kind: "mismatch", reason: `unexpected mount <malformed:${mount.Destination}>`, containerPath: mount.Destination };
        }
        if (destinations.has(mount.Destination)) {
            return { kind: "mismatch", reason: `unexpected mount <duplicate:${mount.Destination}>`, containerPath: mount.Destination };
        }
        if (!allowUnexpected && !requiredByPath.has(mount.Destination)) {
            return { kind: "mismatch", reason: `unexpected mount ${mount.Destination}`, containerPath: mount.Destination };
        }
        destinations.add(mount.Destination);
    }
    return { kind: "verified", via: "shape" };
}
