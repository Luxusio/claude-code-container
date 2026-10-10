import { win32 } from "path";

export type HyperVImageProfile = "windows-11" | "windows-server" | "ubuntu-lts";

export type HyperVImageManifest = {
    version: 3;
    profile: HyperVImageProfile;
    catalogId: string;
    sourceUrl: string | null;
    sourceFormat: "vhdx" | "vhd-tar-gz" | "vhdx-zip" | "qcow2" | "vmdk";
    sourceSha256: string | null;
    licenseId: string | null;
    generation: 1 | 2;
    secureBootTemplate: "MicrosoftWindows" | "MicrosoftUEFICertificateAuthority";
    preparationVersion: 1;
    imagePath: string;
    sha256: string;
    sizeBytes: number;
    virtualSizeBytes: number;
    vhdType: string;
    preparedAt: string;
};

export type HyperVImageResolution =
    | { ok: true; params: Record<string, unknown>; imagePath: string; prepared: boolean }
    | { ok: false; status: number; error: string; detail?: string; remedy?: string };

export type HyperVImageCommandResult = {
    mode: string;
    provider: string;
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
};

export type HyperVImageCreateRequest = {
    backend: string;
    dryRun: boolean;
    create?: Record<string, unknown>;
};

export type HyperVImageVhd = {
    readonly path: string;
    readonly vhdFormat: string;
    readonly vhdType: string;
    readonly parentPath: string | null;
    readonly virtualSizeBytes: number;
    readonly fileSizeBytes: number;
};
export type HyperVBaseImageObservation = {
    ok: boolean; profile: HyperVImageProfile; imagePath: string; sha256: string;
    sizeBytes: number; virtualSizeBytes: number; vhdType: string; generation: 1 | 2; reused: boolean;
};
export type HyperVImageCatalog = {
    catalogId: string; sourceUrl: string; sourceFormat: HyperVImageManifest["sourceFormat"];
    licenseId: string | null; generation: 1 | 2;
} & ({ sourceSha256: string } | { sourceSha256?: never });
export type HyperVAutomaticImageCatalogs = {
    "windows-server": HyperVImageCatalog;
    "ubuntu-lts": HyperVImageCatalog & { virtualSizeBytes: number };
};
export function hyperVImageProfile(value: unknown): HyperVImageProfile | null {
    return value === "windows-11" || value === "windows-server" || value === "ubuntu-lts" ? value : null;
}

export type HyperVCreateVhdTarget =
    | { readonly kind: "base"; readonly path: string }
    | { readonly kind: "clone"; readonly path: string; readonly expectedVirtualSizeBytes: number };

function sameWindowsPath(left: string, right: string): boolean {
    return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

/** Applies Device Lab image policy to native Get-VHD metadata. */
export function inspectHyperVCreateVhd(
    target: HyperVCreateVhdTarget,
    vhd: HyperVImageVhd,
): number {
    const mismatch = target.kind === "base"
        ? "hyper-v-base-image-parent-invalid"
        : "hyper-v-created-disk-format-mismatch";
    if (!sameWindowsPath(vhd.path, target.path)
        || vhd.vhdFormat !== "VHDX"
        || vhd.vhdType === "Differencing"
        || vhd.parentPath !== null
        || !Number.isSafeInteger(vhd.virtualSizeBytes)
        || vhd.virtualSizeBytes <= 0
        || (target.kind === "clone" && vhd.virtualSizeBytes !== target.expectedVirtualSizeBytes)) {
        throw new Error(mismatch);
    }
    return vhd.virtualSizeBytes;
}

/** Acquisition accepts a fixed VHD source or a standalone VHDX with its exact file size. */
export function inspectHyperVAcquiredVhd(
    path: string,
    vhd: HyperVImageVhd,
    fileSizeBytes: number,
    format: "VHD" | "VHDX",
    expectedType?: "Fixed" | "Dynamic",
): undefined {
    if (!sameWindowsPath(vhd.path, path)
        || vhd.vhdFormat !== format || vhd.parentPath !== null
        || (vhd.vhdType !== "Fixed" && vhd.vhdType !== "Dynamic")
        || (expectedType && vhd.vhdType !== expectedType)
        || !Number.isSafeInteger(vhd.virtualSizeBytes) || vhd.virtualSizeBytes <= 0
        || vhd.fileSizeBytes !== fileSizeBytes) {
        throw new Error("hyper-v-base-image-vhd-invalid");
    }
    return undefined;
}

export function hyperVImageManifest(
    profile: HyperVImageProfile,
    imagePath: string,
    observation: HyperVBaseImageObservation,
    automatic: boolean,
    catalog: HyperVImageCatalog | null,
    preparedAt: string,
): HyperVImageManifest {
    return {
        version: 3,
        profile,
        catalogId: automatic && catalog ? catalog.catalogId : "user-provided-vhdx",
        sourceUrl: automatic && catalog ? catalog.sourceUrl : null,
        sourceFormat: automatic && catalog ? catalog.sourceFormat : "vhdx",
        sourceSha256: automatic && catalog && "sourceSha256" in catalog ? catalog.sourceSha256 ?? null : null,
        licenseId: automatic && catalog ? catalog.licenseId : null,
        generation: observation.generation,
        secureBootTemplate: profile === "ubuntu-lts" ? "MicrosoftUEFICertificateAuthority" : "MicrosoftWindows",
        preparationVersion: 1,
        imagePath,
        sha256: observation.sha256,
        sizeBytes: observation.sizeBytes,
        virtualSizeBytes: observation.virtualSizeBytes,
        vhdType: observation.vhdType,
        preparedAt,
    };
}
