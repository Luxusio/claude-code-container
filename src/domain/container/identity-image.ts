export const IDENTITY_CONTRACT_VERSION = "1";

export interface ContainerIdentity {
    uid: number;
    gid: number;
    mapping: "host" | "podman-keep-id" | "desktop";
    contractVersion: string;
}

/** Structural input preserves the native runtime's lazy field observations. */
export interface IdentityRuntime {
    runtime: string;
    rootless: boolean;
    flavor: string;
}

export function normalizeImageId(imageId: string): string {
    const match = /^(?:sha256:)?([a-f0-9]{64})$/.exec(imageId);
    if (!match) throw new Error("Container identity requires an immutable sha256 image ID.");
    return `sha256:${match[1]}`;
}

export function validateIdentityId(value: number | undefined, name: string): asserts value is number {
    if (!Number.isSafeInteger(value) || value! <= 0 || value! >= 4294967295) {
        throw new Error(`Invalid host ${name}: ${value}. Run CCC as a non-root user with a valid UID and GID.`);
    }
}

export function resolveIdentity(runtime: IdentityRuntime, platform: string, uid: number | undefined, gid: number | undefined): ContainerIdentity {
    if (runtime.runtime === "docker" && (runtime.rootless || runtime.flavor === "docker-rootless")) {
        throw new Error("Rootless Docker identity mapping is unsupported. Use rootful Docker or rootless Podman to preserve project ownership.");
    }
    if (runtime.runtime === "podman" && (runtime.rootless || runtime.flavor === "podman-machine")) {
        return { uid: 1000, gid: 1000, mapping: "podman-keep-id", contractVersion: IDENTITY_CONTRACT_VERSION };
    }
    if (platform !== "linux") {
        return { uid: 1000, gid: 1000, mapping: "desktop", contractVersion: IDENTITY_CONTRACT_VERSION };
    }
    validateIdentityId(uid, "UID");
    validateIdentityId(gid, "GID");
    return { uid, gid, mapping: "host", contractVersion: IDENTITY_CONTRACT_VERSION };
}

export function getIdentityLabels(identity: ContainerIdentity): Record<string, string> {
    return {
        "ccc.identity.version": identity.contractVersion,
        "ccc.identity.uid": String(identity.uid),
        "ccc.identity.gid": String(identity.gid),
        "ccc.identity.mapping": identity.mapping,
    };
}

export function getIdentityMiseVolumeName(identity: ContainerIdentity): string {
    return `ccc-mise-cache-v${identity.contractVersion}-${identity.mapping}-${identity.uid}-${identity.gid}`;
}

export function getIdentityCodexPackagesVolumeName(identity: ContainerIdentity): string {
    return `ccc-codex-packages-v${identity.contractVersion}-${identity.mapping}-${identity.uid}-${identity.gid}`;
}

export function identityImageLabels(baseImageId: string, identity: ContainerIdentity): Record<string, string> {
    const canonicalBaseId = normalizeImageId(baseImageId);
    validateIdentityId(identity.uid, "UID");
    validateIdentityId(identity.gid, "GID");
    if (!/^[a-zA-Z0-9.-]+$/.test(identity.contractVersion) || !["host", "podman-keep-id", "desktop"].includes(identity.mapping)) {
        throw new Error("Invalid container identity contract.");
    }
    return { ...getIdentityLabels(identity), "ccc.identity.base": canonicalBaseId };
}

/** Fields remain lazy; no eager native decoder can change validation order. */
export interface IdentityImageObservation {
    Id: string;
    Config?: { User?: string; Labels?: Record<string, string> };
}

export function matchesIdentityImage(image: IdentityImageObservation, labels: Record<string, string>): boolean {
    normalizeImageId(image.Id);
    if (image.Config?.User !== "ccc") return false;
    return Object.entries(labels).every(([key, value]) => image.Config!.Labels?.[key] === value);
}
