import { describe, expect, it } from "vitest";
import {
    combineMountVerification,
    verifyMountSet,
    type LiveSourceProof,
    type MountEvidence,
    type ObservedMountContract,
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
            sourceState: "present" as const,
            containerPath: regularBind.containerPath,
            type: "bind",
            writable: true,
        }],
        evidence,
        { policy: "strict" },
    );
}

describe("bind mount verification", () => {
    it.each(["strict", "safe-defer"] as const)("honors mandatory daemon identity evidence even for an exact source under %s", policy => {
        const path = "/var/run/docker.sock";
        const contract: RequiredMountContract = { containerPath: path, readonly: false, type: "bind", presence: "core", sourceKind: "daemon" };
        const observed = { sourceState: "present" as const, containerPath: path, type: "bind", writable: true };
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
            [{ sourceState: "present" as const, containerPath: regularBind.containerPath, type: "bind", writable: true }],
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
        ["type", { type: "volume", writable: true }, "mount type changed"],
        ["access", { type: "bind", writable: false }, "mount access changed"],
    ])("does not let identity proof override %s mismatch", (_name, shape, reason) => {
        const result = verifyMountSet(
            [regularBind],
            [{ sourceState: "present" as const, containerPath: regularBind.containerPath, ...shape }],
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
            [{ sourceState: "present" as const, containerPath: regularBind.containerPath, type: "bind", writable: true }],
            new Map([[regularBind.containerPath, {
                sourcePathMatches: true,
                liveProof: { kind: "mismatch", reason: "bind marker content changed" },
            }]]),
            { policy: "safe-defer" },
        );
        expect(result.kind).toBe("mismatch");
    });


    it.each(["empty", "invalid"] as const)("keeps %s normalized source distinct from a valid filesystem bind", sourceState => {
        const result = verifyMountSet(
            [regularBind],
            [{ sourceState, containerPath: regularBind.containerPath, type: "bind", writable: true }],
            new Map([[regularBind.containerPath, {
                sourcePathMatches: true,
                liveProof: { kind: "verified", via: "identity" } as const,
            }]]),
            { policy: "strict" },
        );
        expect(result).toEqual({
            kind: "mismatch",
            reason: sourceState === "empty"
                ? "bind source missing for " + regularBind.containerPath
                : "unexpected mount <malformed:" + regularBind.containerPath + ">",
            containerPath: regularBind.containerPath,
        });
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
        observed: ObservedMountContract[],
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
        // The native binding has already established the exact named volume match.
        expect(verify([{ sourceState: "present" as const, containerPath: "/home/ccc/.ccc/labs", type: "volume", writable: true }], true, policy))
            .toEqual({ kind: "verified", via: "source" });
    });

    it.each(["strict", "safe-defer"] as const)("rejects a different volume, a bind, or read-only access at that path under %s", (policy) => {
        expect(verify([{ sourceState: "present" as const, containerPath: "/home/ccc/.ccc/labs", type: "volume", writable: true }], false, policy).kind).toBe("mismatch");
        expect(verify([{ sourceState: "present" as const, containerPath: "/home/ccc/.ccc/labs", type: "bind", writable: true }], false, policy).kind).toBe("mismatch");
        expect(verify([{ sourceState: "present" as const, containerPath: "/home/ccc/.ccc/labs", type: "volume", writable: false }], true, policy).kind).toBe("mismatch");
    });
});
