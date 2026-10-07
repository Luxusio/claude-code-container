import { describe, expect, it } from "vitest";
import {
    combineMountVerification,
    verifyMountSet,
    type LiveSourceProof,
    type MountEvidence,
    type RequiredMountContract,
} from "../bind-mount-verification.js";

const regularBind: RequiredMountContract = {
    containerPath: "/home/ccc/.claude",
    readonly: false,
    type: "bind",
    presence: "additive",
    sourceKind: "filesystem",
};

function verifyRegularBind(
    sourcePathMatches: boolean,
    liveProof?: LiveSourceProof,
) {
    const evidence = new Map<string, MountEvidence>([[
        regularBind.containerPath,
        { sourcePathMatches, liveProof },
    ]]);
    return verifyMountSet(
        [regularBind],
        [{
            Source: "/Users/me/.claude",
            Destination: regularBind.containerPath,
            Type: "bind",
            RW: true,
        }],
        evidence,
        { policy: "strict" },
    );
}

describe("bind mount verification", () => {
    it.each(["strict", "safe-defer"] as const)("honors mandatory daemon identity evidence even for an exact source under %s", policy => {
        const path = "/var/run/docker.sock";
        const contract: RequiredMountContract = { containerPath: path, readonly: false, type: "bind", presence: "core", sourceKind: "daemon" };
        const observed = { Source: "/daemon-profile/docker.sock", Destination: path, Type: "bind", RW: true };
        for (const proof of [
            { kind: "verified", via: "daemon" },
            { kind: "mismatch", reason: "foreign daemon" },
            { kind: "retryable", reason: "daemon unavailable" },
        ] as const) {
            const result = verifyMountSet([contract], [observed], new Map([[path, { sourcePathMatches: true, liveProof: proof }]]), { policy });
            expect(result).toEqual(proof.kind === "verified" ? proof : { ...proof, containerPath: path });
        }
    });
    it("accepts a recognized lexical source alias only after live identity proof", () => {
        expect(verifyRegularBind(true, { kind: "verified", via: "identity" }))
            .toEqual({ kind: "verified", via: "identity" });
    });

    it("rejects an arbitrary source mismatch even when file contents match", () => {
        expect(verifyRegularBind(false, { kind: "verified", via: "identity" }))
            .toEqual({
                kind: "mismatch",
                reason: `bind source changed for ${regularBind.containerPath}`,
                containerPath: regularBind.containerPath,
            });
    });

    it("rejects a lexical source alias when the live marker is wrong", () => {
        expect(verifyRegularBind(true, { kind: "mismatch", reason: "bind marker content changed" }))
            .toEqual({
                kind: "mismatch",
                reason: "bind marker content changed",
                containerPath: regularBind.containerPath,
            });
    });

    it("keeps transient proof unavailability distinct from mismatch", () => {
        expect(verifyRegularBind(true, { kind: "retryable", reason: "container exec unavailable" }))
            .toEqual({
                kind: "retryable",
                reason: "container exec unavailable",
                containerPath: regularBind.containerPath,
            });
    });

    it("does not let a live proof override changed host filesystem identity", () => {
        const result = verifyMountSet(
            [regularBind],
            [{ Source: "/Users/me/.claude", Destination: regularBind.containerPath, Type: "bind", RW: true }],
            new Map([[regularBind.containerPath, {
                authoritativeMismatch: `bind source identity changed for ${regularBind.containerPath}`,
                sourcePathMatches: true,
                liveProof: { kind: "verified", via: "identity" } as const,
            }]]),
            { policy: "strict" },
        );
        expect(result).toEqual({
            kind: "mismatch",
            reason: `bind source identity changed for ${regularBind.containerPath}`,
            containerPath: regularBind.containerPath,
        });
    });

    it.each([
        ["type", { Type: "volume", RW: true }, "mount type changed"],
        ["access", { Type: "bind", RW: false }, "mount access changed"],
    ])("does not let identity proof override %s mismatch", (_name, shape, reason) => {
        const result = verifyMountSet(
            [regularBind],
            [{ Source: "/Users/me/.claude", Destination: regularBind.containerPath, ...shape }],
            new Map([[regularBind.containerPath, {
                sourcePathMatches: true,
                liveProof: { kind: "verified", via: "identity" } as const,
            }]]),
            { policy: "strict" },
        );
        expect(result.kind).toBe("mismatch");
        expect("reason" in result ? result.reason : "").toContain(reason);
    });

    it("prioritizes a later substitution over an earlier missing additive mount", () => {
        const missing = { ...regularBind, containerPath: "/home/ccc/.gemini" };
        const result = verifyMountSet(
            [missing, regularBind],
            [{ Source: "/foreign/.claude", Destination: regularBind.containerPath, Type: "bind", RW: true }],
            new Map([[regularBind.containerPath, {
                sourcePathMatches: true,
                liveProof: { kind: "mismatch", reason: "bind marker content changed" },
            }]]),
            { policy: "safe-defer" },
        );
        expect(result.kind).toBe("mismatch");
    });

    it("uses explicit aggregation precedence", () => {
        const deferred = { kind: "deferred", reason: "missing", containerPath: "/a" } as const;
        const retryable = { kind: "retryable", reason: "not ready", containerPath: "/b" } as const;
        const mismatch = { kind: "mismatch", reason: "wrong", containerPath: "/c" } as const;
        expect(combineMountVerification(deferred, retryable)).toBe(retryable);
        expect(combineMountVerification(retryable, mismatch)).toBe(mismatch);
        expect(combineMountVerification(mismatch, deferred)).toBe(mismatch);
    });
});

describe("optional volume mounts", () => {
    const optionalVolume: RequiredMountContract = {
        containerPath: "/home/ccc/.ccc/labs",
        readonly: false,
        type: "volume",
        presence: "optional",
        sourceKind: "volume",
    };
    const verify = (
        observed: Array<Record<string, unknown>>,
        volumeSourceMatches: boolean,
        policy: "strict" | "safe-defer",
    ) => verifyMountSet(
        [optionalVolume],
        observed,
        new Map<string, MountEvidence>(observed.length ? [[optionalVolume.containerPath, { volumeSourceMatches }]] : []),
        { policy },
    );

    it.each(["strict", "safe-defer"] as const)("accepts an absent optional volume under %s", (policy) => {
        expect(verify([], false, policy)).toEqual({ kind: "verified", via: "shape" });
    });

    it.each(["strict", "safe-defer"] as const)("accepts the exact optional volume when present under %s", (policy) => {
        // Podman-shaped: Name carries the volume, Source is a host storage path.
        expect(verify([{ Name: "ccc-p-lab-state", Source: "/var/lib/containers/storage/volumes/ccc-p-lab-state/_data", Destination: "/home/ccc/.ccc/labs", Type: "volume", RW: true }], true, policy))
            .toEqual({ kind: "verified", via: "source" });
    });

    it.each(["strict", "safe-defer"] as const)("rejects a different volume, a bind, or read-only access at that path under %s", (policy) => {
        expect(verify([{ Source: "foreign", Destination: "/home/ccc/.ccc/labs", Type: "volume", RW: true }], false, policy).kind).toBe("mismatch");
        expect(verify([{ Source: "/host/labs", Destination: "/home/ccc/.ccc/labs", Type: "bind", RW: true }], false, policy).kind).toBe("mismatch");
        expect(verify([{ Source: "ccc-p-lab-state", Destination: "/home/ccc/.ccc/labs", Type: "volume", RW: false }], true, policy).kind).toBe("mismatch");
    });
});
