import { HyperVWindowsError } from "@ccc/hyper-v/low-level/index.js";
export { inspectHyperVCreateVhd } from "../../domain/hyper-v-image-preparation.js";
export type { HyperVCreateVhdTarget } from "../../domain/hyper-v-image-preparation.js";

/**
 * Keeps the existing bounded creation-stage diagnostic when a typed read fails. The typed failure
 * stays attached as `cause`, so the create's 502 still names Get-VHD as the failing operation;
 * its native code is not carried into the stage code.
 */
export function hyperVCreateVhdReadError(kind: "base" | "clone", error: unknown): Error {
    if (!(error instanceof HyperVWindowsError)) return error instanceof Error ? error : new Error("hyper-v-vm-disk-inspection-failed");
    if (error.category === "native" && error.code === "vhd-not-found") {
        return new Error(kind === "base" ? "hyper-v-base-image-not-found" : "hyper-v-created-disk-not-found", { cause: error });
    }
    if (error.category === "native" && error.code === "vhd-path-reparse-point-rejected") {
        return new Error("hyper-v-path-reparse-point-rejected", { cause: error });
    }
    return new Error(kind === "base" ? "hyper-v-base-image-inspection-failed" : "hyper-v-vm-disk-create-failed", { cause: error });
}
