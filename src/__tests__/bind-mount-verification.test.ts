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
