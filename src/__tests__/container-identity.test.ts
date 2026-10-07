import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncReturns } from "child_process";
import type { RuntimeInfo } from "../container-runtime.js";
import type { ContainerIdentity } from "../container-identity.js";

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    lock: vi.fn(),
    locked: false,
}));
vi.mock("child_process", async (original) => ({
    ...await original<typeof import("child_process")>(),
    spawnSync: mocks.spawn,
}));
vi.mock("@ccc/device-lab/device-lab-shared-state.js", () => ({ withSharedMutationLock: mocks.lock }));

const {
    IDENTITY_CONTRACT_VERSION,
    resolveContainerIdentity,
    ensureIdentityImage,
    getIdentityLabels,
    getIdentityMiseVolumeName,
    getIdentityCodexPackagesVolumeName,
} = await import("../container-identity.js");
const { _setRuntimeInfoForTest } = await import("../container-runtime.js");

const native: RuntimeInfo = {
    runtime: "docker", flavor: "docker-native", version: "27.0.0",
    socketPath: "/var/run/docker.sock", rootless: false, remote: false,
};

function result(status = 0, stdout = "", stderr = ""): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr, status, signal: null };
}

beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.lock.mockReset().mockImplementation((_file: string, operation: () => unknown) => {
        expect(mocks.locked).toBe(false);
        mocks.locked = true;
        try { return operation(); } finally { mocks.locked = false; }
    });
    mocks.locked = false;
    _setRuntimeInfoForTest(native);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("container identity policy", () => {
    it("separates both writable caches by mapping and numeric owner", () => {
        const identities = [[1000, 1000], [1001, 1001], [1000, 2000]].map(([uid, gid]) => resolveContainerIdentity(native, "linux", uid, gid));
        identities.push(resolveContainerIdentity(native, "darwin", 1000, 1000));
        expect(new Set(identities.map(getIdentityCodexPackagesVolumeName)).size).toBe(identities.length);
        expect(new Set(identities.map(getIdentityMiseVolumeName)).size).toBe(identities.length);
        expect(getIdentityCodexPackagesVolumeName(identities[0])).toBe("ccc-codex-packages-v1-host-1000-1000");
    });

    it.each([[1000, 1000], [1001, 1001], [12345, 23456], [1000, 4000]])(
        "uses effective native Linux UID %i and primary GID %i", (uid, gid) => {
            expect(resolveContainerIdentity(native, "linux", uid, gid)).toEqual({
                uid, gid, mapping: "host", contractVersion: IDENTITY_CONTRACT_VERSION,
            });
            expect(mocks.spawn).not.toHaveBeenCalled();
        },
    );

    it("reads effective IDs rather than real IDs by default", () => {
        vi.spyOn(process, "geteuid").mockReturnValue(2002);
        vi.spyOn(process, "getegid").mockReturnValue(3003);
        vi.spyOn(process, "getuid").mockReturnValue(1000);
        vi.spyOn(process, "getgid").mockReturnValue(1000);
        expect(resolveContainerIdentity(native, "linux")).toMatchObject({ uid: 2002, gid: 3003 });
    });

    it.each([0, -1, 1.5, NaN, Infinity, 4294967295])("rejects invalid/root native UID %s", (uid) => {
        expect(() => resolveContainerIdentity(native, "linux", uid, 1000)).toThrow(/uid|identity|root/i);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, NaN, Infinity, 4294967295])("rejects invalid/root native GID %s", (gid) => {
        expect(() => resolveContainerIdentity(native, "linux", 1000, gid)).toThrow(/gid|identity|root/i);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it("retains rootless Podman keep-id mapping to the stable ccc account", () => {
        const runtime: RuntimeInfo = { ...native, runtime: "podman", flavor: "podman-rootless", rootless: true };
        expect(resolveContainerIdentity(runtime, "linux", 2002, 3003)).toMatchObject({
            uid: 1000, gid: 1000, mapping: "podman-keep-id",
        });
    });

    it("maps rootful Podman to native host IDs", () => {
        const runtime: RuntimeInfo = { ...native, runtime: "podman", flavor: "podman-rootful" };
        expect(resolveContainerIdentity(runtime, "linux", 2002, 3003)).toMatchObject({
            uid: 2002, gid: 3003, mapping: "host",
        });
    });

    it("rejects rootless Docker with an actionable runtime error before mutation", () => {
        const runtime: RuntimeInfo = { ...native, flavor: "docker-rootless", rootless: true };
        expect(() => resolveContainerIdentity(runtime, "linux", 1000, 1000)).toThrow(/rootless.*docker|docker.*rootless/i);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it.each(["darwin", "win32"] as const)("keeps desktop identity stable on %s", (platform) => {
        const runtime: RuntimeInfo = { ...native, flavor: "docker-desktop", remote: true };
        expect(resolveContainerIdentity(runtime, platform, 501, 20)).toMatchObject({
            uid: 1000, gid: 1000, mapping: "desktop",
        });
    });

    it("does not mistake WSL networking remoteness for desktop file sharing", () => {
        expect(resolveContainerIdentity({ ...native, remote: true }, "linux", 2002, 3003))
            .toMatchObject({ uid: 2002, gid: 3003, mapping: "host" });
    });

    it("separates writable caches by UID, GID, mapping, and contract version", () => {
        const identity = resolveContainerIdentity(native, "linux", 1000, 1000);
        const variants = [identity, { ...identity, uid: 2002 }, { ...identity, gid: 3003 },
            { ...identity, mapping: "podman-keep-id" as const }, { ...identity, contractVersion: "2" }];
        const names = variants.map(getIdentityMiseVolumeName);
        expect(new Set(names).size).toBe(variants.length);
        expect(names.every((name) => name !== "ccc-mise-cache")).toBe(true);
        expect(getIdentityMiseVolumeName(identity)).toBe(names[0]);
    });
});

describe("validated derived image cache", () => {
    const baseId = `sha256:${"a".repeat(64)}`;
    const builtId = `sha256:${"b".repeat(64)}`;
    const staleId = `sha256:${"c".repeat(64)}`;
    const identity = { uid: 2002, gid: 3003, mapping: "host" as const, contractVersion: "1" };
    type Image = { Id: string; Config: { User: string; Labels: Record<string, string> } };

    function imageFor(target: ContainerIdentity = identity, base = baseId, id = builtId): Image {
        return { Id: id, Config: { User: "ccc", Labels: { ...getIdentityLabels(target), "ccc.identity.base": base } } };
    }

    function fakeRuntime(options: {
        cached?: Image;
        invalidRunIds?: Set<string>;
        cachedAccountOutput?: string;
        buildFailure?: boolean;
        invalidBuild?: boolean;
        target?: ContainerIdentity;
        base?: string;
        builtId?: string;
    } = {}) {
        const images = new Map<string, Image>();
        let built = false;
        mocks.spawn.mockImplementation((_command: string, args: string[]) => {
            if (args[0] === "image" && args[1] === "inspect") {
                const image = images.get(args[2]) ?? (!built ? options.cached : undefined);
                return image ? result(0, JSON.stringify([image])) : result(1, "", "No such image");
            }
            if (args[0] === "run") {
                const imageId = args.find((arg) => /^(?:sha256:)?[a-f0-9]{64}$/.test(arg));
                if (options.invalidRunIds?.has(imageId!) || (built && options.invalidBuild)) return result(1, "", "invalid account");
                if (imageId === staleId && options.cachedAccountOutput !== undefined) return result(0, options.cachedAccountOutput);
                const target = options.target ?? identity;
                return result(0, `${target.uid}:${target.gid}:/home/ccc:ccc\n`);
            }
            if (args[0] === "build") {
                expect(mocks.locked).toBe(true);
                if (options.buildFailure) return result(1, "", "identity build failed");
                built = true;
                images.set(args[args.indexOf("-t") + 1], imageFor(options.target, options.base, options.builtId));
                return result();
            }
            if (args[0] === "tag") return result();
            if (args[0] === "image" && args[1] === "rm") {
                for (const arg of args.slice(2)) images.delete(arg);
                return result();
            }
            throw new Error(`Unexpected container mutation: ${args.join(" ")}`);
        });
        return images;
    }

    function buildCalls() {
        return mocks.spawn.mock.calls.filter(([, args]) => args[0] === "build");
    }

    it.each(["explicit", "nested"])("honors %s Podman cgroup policy in mandatory identity probes", (mode) => {
        _setRuntimeInfoForTest({ ...native, runtime: "podman", flavor: "podman-rootless", rootless: true });
        vi.stubEnv("CCC_PODMAN_CGROUPS", mode === "explicit" ? "disabled" : "");
        vi.stubEnv("container", mode === "nested" ? "docker" : "");
        const target = { ...identity, uid: 1000, gid: 1000, mapping: "podman-keep-id" as const };
        fakeRuntime({ target, cached: imageFor(target) });
        const normal = mocks.spawn.getMockImplementation()!;
        mocks.spawn.mockImplementation((command, args, options) => {
            if (args[0] === "run" && !args.includes("--cgroups=disabled")) return result(1, "", "cgroup creation denied");
            return normal(command, args, options);
        });
        expect(ensureIdentityImage(baseId, target)).toBe(builtId);
        expect(buildCalls()).toHaveLength(0);
        const probe = mocks.spawn.mock.calls.find(([, args]) => args[0] === "run")![1];
        expect(probe).toContain("--userns=keep-id:uid=1000,gid=1000");
        expect(probe[probe.indexOf("--user") + 1]).toBe("ccc");
    });

    it("builds and reuses Podman bare image IDs with one canonical base cache", () => {
        _setRuntimeInfoForTest({ ...native, runtime: "podman", flavor: "podman-rootless", rootless: true });
        const target = { ...identity, uid: 1000, gid: 1000, mapping: "podman-keep-id" as const };
        const bareBuiltId = builtId.slice(7);
        fakeRuntime({ target, builtId: bareBuiltId });
        expect(ensureIdentityImage(baseId.slice(7), target)).toBe(bareBuiltId);
        expect(ensureIdentityImage(baseId, target)).toBe(bareBuiltId);
        expect(buildCalls()).toHaveLength(1);
        expect(mocks.lock.mock.calls[0][0]).toBe(mocks.lock.mock.calls[1][0]);
        const build = buildCalls()[0];
        expect(build[2].input).toContain(`LABEL ccc.identity.base="${baseId}"`);
        expect(mocks.spawn.mock.calls.every(([command]) => command === "podman")).toBe(true);
        expect(mocks.spawn.mock.calls.filter(([, args]) => args[0] === "run").every(([, args]) => args.includes(bareBuiltId))).toBe(true);
    });

    it.each(["ccc:latest", "a".repeat(12), "a".repeat(63), "g".repeat(64), `sha512:${"a".repeat(64)}`])(
        "rejects malformed base image ID %s before mutation", (invalidId) => {
            expect(() => ensureIdentityImage(invalidId, identity)).toThrow(/immutable|sha256|image ID/i);
            expect(mocks.spawn).not.toHaveBeenCalled();
            expect(mocks.lock).not.toHaveBeenCalled();
        },
    );

    it.each(["ccc:latest", "b".repeat(12), `sha256:${"g".repeat(64)}`])(
        "rejects malformed cached image ID %s and builds a validated image", (invalidId) => {
            fakeRuntime({ cached: imageFor(identity, baseId, invalidId) });
            expect(ensureIdentityImage(baseId, identity)).toBe(builtId);
            expect(buildCalls()).toHaveLength(1);
            expect(mocks.spawn.mock.calls.filter(([, args]) => args[0] === "run").every(([, args]) => !args.includes(invalidId))).toBe(true);
        },
    );

    it("reuses only a validated cached image and returns its immutable ID", () => {
        fakeRuntime({ cached: imageFor() });
        expect(ensureIdentityImage(baseId, identity)).toBe(builtId);
        expect(buildCalls()).toHaveLength(0);
        expect(mocks.spawn.mock.calls.some(([, args]) => args[0] === "run" && args.includes(builtId))).toBe(true);
    });

    it("builds once, validates, then reuses the image on the next request", () => {
        fakeRuntime();
        expect(ensureIdentityImage(baseId, identity)).toBe(builtId);
        expect(ensureIdentityImage(baseId, identity)).toBe(builtId);
        expect(buildCalls()).toHaveLength(1);
        expect(mocks.lock).toHaveBeenCalledTimes(2);
        expect(mocks.lock.mock.calls[0][0]).toBe(mocks.lock.mock.calls[1][0]);
        expect(mocks.locked).toBe(false);
        for (const [, args] of mocks.spawn.mock.calls) {
            expect(args).not.toContain("-v");
            expect(args).not.toContain("--volume");
            expect(args).not.toContain("--mount");
            expect(args[0]).not.toBe("exec");
            expect(args[0]).not.toBe("stop");
            expect(args[0]).not.toBe("rm");
        }
    });

    it.each(["uid", "gid", "mapping", "version", "base", "user"])(
        "rejects cached image with stale %s contract", (field) => {
            const cached = imageFor(identity, baseId, staleId);
            if (field === "user") cached.Config.User = "root";
            else cached.Config.Labels[`ccc.identity.${field}`] = "stale";
            fakeRuntime({ cached });
            expect(ensureIdentityImage(baseId, identity)).toBe(builtId);
            expect(buildCalls()).toHaveLength(1);
        },
    );

    it("rejects a cache whose labels match but actual account validation fails", () => {
        fakeRuntime({ cached: imageFor(identity, baseId, staleId), invalidRunIds: new Set([staleId]) });
        expect(ensureIdentityImage(baseId, identity)).toBe(builtId);
        expect(buildCalls()).toHaveLength(1);
    });

    it.each([
        "1001:3003:/home/ccc:ccc",
        "2002:1001:/home/ccc:ccc",
        "2002:3003:/root:ccc",
        "2002:3003:/home/ccc:root",
        "",
    ])("rejects a successful account probe with incompatible output %j", (cachedAccountOutput) => {
        fakeRuntime({ cached: imageFor(identity, baseId, staleId), cachedAccountOutput });
        expect(ensureIdentityImage(baseId, identity)).toBe(builtId);
        expect(buildCalls()).toHaveLength(1);
    });

    it("does not accept a failed build and releases its lock for a retry", () => {
        fakeRuntime({ buildFailure: true });
        expect(() => ensureIdentityImage(baseId, identity)).toThrow(/build|identity/i);
        expect(mocks.locked).toBe(false);
        fakeRuntime();
        expect(ensureIdentityImage(baseId, identity)).toBe(builtId);
        expect(buildCalls()).toHaveLength(2);
    });

    it("allows cold builds twenty minutes without extending other command budgets or stealing a live lock", () => {
        fakeRuntime();
        expect(ensureIdentityImage(baseId, identity)).toBe(builtId);
        expect(buildCalls()[0][2].timeout).toBe(1_200_000);
        for (const [, args, options] of mocks.spawn.mock.calls) {
            if (args[0] === "build") continue;
            expect(options.timeout).toBe(args[0] === "image" && args[1] === "inspect" ? 30_000 : 600_000);
        }
        expect(mocks.lock.mock.calls[0][2]).toEqual({ waitMs: 1_260_000, reclaimStale: false });
    });

    it("reports a timed-out build's recent phase, rejects it, and permits a validated retry", () => {
        const images = fakeRuntime();
        const normal = mocks.spawn.getMockImplementation()!;
        mocks.spawn.mockImplementation((command, args, options) => {
            if (args[0] === "build") {
                return { ...result(1, "", `old-build-output${"x".repeat(5000)}\n#6 exporting layers`),
                    error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }) };
            }
            return normal(command, args, options);
        });
        let failure: unknown;
        try { ensureIdentityImage(baseId, identity); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain("ETIMEDOUT");
        expect(message).toContain("#6 exporting layers");
        expect(message).not.toContain("old-build-output");
        expect(message.length).toBeLessThan(4200);
        expect(images.size).toBe(0);
        expect(mocks.spawn.mock.calls.some(([, args]) => args[0] === "run")).toBe(false);
        expect(mocks.locked).toBe(false);
        fakeRuntime();
        expect(ensureIdentityImage(baseId, identity)).toBe(builtId);
        expect(buildCalls()).toHaveLength(2);
    });

    it("removes a newly built image that fails validation and permits a clean retry", () => {
        fakeRuntime({ invalidBuild: true });
        expect(() => ensureIdentityImage(baseId, identity)).toThrow(/valid|identity/i);
        const buildTag = buildCalls()[0][1][buildCalls()[0][1].indexOf("-t") + 1];
        expect(mocks.spawn.mock.calls.some(([, args]) => args[0] === "image" && args[1] === "rm" && args.includes(buildTag))).toBe(true);
        expect(mocks.locked).toBe(false);
        fakeRuntime();
        expect(ensureIdentityImage(baseId, identity)).toBe(builtId);
    });

    it("keys image tags and locks by base digest, UID, GID, and contract version", () => {
        const variants = [
            { base: baseId, target: identity },
            { base: `sha256:${"d".repeat(64)}`, target: identity },
            { base: baseId, target: { ...identity, uid: 2003 } },
            { base: baseId, target: { ...identity, gid: 3004 } },
            { base: baseId, target: { ...identity, contractVersion: "2" } },
        ];
        for (const { base, target } of variants) {
            fakeRuntime({ target, base });
            expect(ensureIdentityImage(base, target)).toBe(builtId);
        }
        const tags = buildCalls().map(([, args]) => args[args.indexOf("-t") + 1]);
        expect(new Set(tags).size).toBe(variants.length);
        expect(new Set(mocks.lock.mock.calls.map(([file]) => file)).size).toBe(variants.length);
    });

    it("rechecks the cache after acquiring the build lock", () => {
        let cacheReady = false;
        fakeRuntime();
        mocks.lock.mockImplementation((_file: string, operation: () => unknown) => {
            cacheReady = true; // A competing process finished while this request waited.
            fakeRuntime({ cached: imageFor() });
            return operation();
        });
        expect(ensureIdentityImage(baseId, identity)).toBe(builtId);
        expect(cacheReady).toBe(true);
        expect(buildCalls()).toHaveLength(0);
    });
});
