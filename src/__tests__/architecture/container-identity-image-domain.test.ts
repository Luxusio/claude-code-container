import { describe, expect, it } from "vitest";
import { getIdentityCodexPackagesVolumeName, getIdentityMiseVolumeName, identityImageLabels, normalizeImageId, resolveIdentity, type ContainerIdentity } from "../../domain/container/identity-image.js";

const base = "a".repeat(64);
const identity: ContainerIdentity = { uid: 1234, gid: 2345, mapping: "host", contractVersion: "1" };

describe("identity image domain", () => {
    it("normalizes only immutable lowercase digests and preserves ordered label serialization", () => {
        expect(normalizeImageId(base)).toBe(`sha256:${base}`);
        expect(JSON.stringify(identityImageLabels(base, identity))).toBe(`{"ccc.identity.version":"1","ccc.identity.uid":"1234","ccc.identity.gid":"2345","ccc.identity.mapping":"host","ccc.identity.base":"sha256:${base}"}`);
        expect(getIdentityMiseVolumeName(identity)).toBe("ccc-mise-cache-v1-host-1234-2345");
        expect(getIdentityCodexPackagesVolumeName(identity)).toBe("ccc-codex-packages-v1-host-1234-2345");
        expect(() => normalizeImageId(base.toUpperCase())).toThrow("immutable sha256");
    });

    it.each([0, -1, 1.5, NaN, Infinity, 4294967295])("rejects invalid UID/GID %s before labels", value => {
        expect(() => identityImageLabels(base, { ...identity, uid: value })).toThrow("Invalid host UID");
        expect(() => identityImageLabels(base, { ...identity, gid: value })).toThrow("Invalid host GID");
    });

    it("keeps refusal and contract validation precedence", () => {
        expect(() => identityImageLabels("tag:latest", { ...identity, uid: 0 })).toThrow("immutable sha256");
        expect(() => identityImageLabels(base, { ...identity, contractVersion: "unsafe/contract" })).toThrow("Invalid container identity contract");
        expect(() => resolveIdentity({ runtime: "docker", rootless: true, flavor: "docker-native" }, "darwin", 0, 0)).toThrow("Rootless Docker");
    });

    it("preserves platform and runtime identity mapping", () => {
        const runtime = { runtime: "podman", rootless: true, flavor: "podman-rootless" };
        expect(resolveIdentity(runtime, "linux", 0, 0)).toEqual({ uid: 1000, gid: 1000, mapping: "podman-keep-id", contractVersion: "1" });
        expect(resolveIdentity({ runtime: "docker", rootless: false, flavor: "docker-native" }, "win32", 0, 0).mapping).toBe("desktop");
        expect(resolveIdentity({ runtime: "podman", rootless: false, flavor: "podman-rootful" }, "linux", 1234, 2345)).toEqual(identity);
    });
});
