export interface LifecyclePreviewRequest {
    backend: string; stateKey: string; command: string; deviceId: string;
    expectedIncarnationId?: string; force: boolean; dryRun: boolean; create?: Record<string, unknown>;
}

export function hyperVPreviewConflicts(device: Record<string, unknown>, parsed: LifecyclePreviewRequest, secureBoot: () => Record<string, unknown>): string[] {
    const create = parsed.create || {};
    const linuxGuest = parsed.backend === "linux-vm";
    const expected: Record<string, unknown> = {
        name: String(create.name || parsed.deviceId),
        profile: typeof create.profile === "string" ? create.profile : linuxGuest ? "ubuntu-lts" : "windows-server",
        memoryMb: typeof create.memoryMb === "number" ? create.memoryMb : 4096,
        cpus: typeof create.cpus === "number" ? create.cpus : 2,
        networking: create.networking !== false,
        ...(create.nestedVirtualization === true || device.nestedVirtualization === true ? { nestedVirtualization: create.nestedVirtualization === true } : {}),
        ...secureBoot(),
    };
    if (typeof create.diskMaxBytes === "number") expected.diskMaxBytes = create.diskMaxBytes;
    if (typeof create.baseImageSha256 === "string") expected.baseImageSha256 = create.baseImageSha256.toLowerCase();
    if (typeof create.sourceImage === "string") expected.sourceImage = create.sourceImage;
    return Object.entries(expected).filter(([key, value]) => device[key] !== value).map(([key]) => key);
}

export type AndroidPreviewAllocation =
    | { kind: "allocated"; port: number }
    | { kind: "invalid" }
    | { kind: "inventory-failed"; detail: string }
    | { kind: "conflict"; port: number }
    | { kind: "exhausted" };
