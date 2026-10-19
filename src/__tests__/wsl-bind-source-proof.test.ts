import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, writeFileSync } from "fs";
import { proveWslBindSourceIdentity } from "../wsl-bind-source-proof.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), info: vi.fn(), kernel: "6.6.87.2-microsoft-standard-WSL2" }));
vi.mock("child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("../container-runtime.js", async () => {
    const { validateNativeRuntimeInvocation } = await import("../adapters/container-runtime-invocation.js");
    const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import("../ports/container-runtime-invocation.js");
    const invocation = validateNativeRuntimeInvocation({
        version: 1, runtime: "docker", executable: "/fixture/runtime/docker",
        transport: { kind: "docker", host: "unix:///fixture/engine.sock", configDirectory: "/fixture/config",
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
    });
    // This unit owner supplies the process leaf explicitly; emitted integration owns native routing.
    const runner = () => { const capturedCli = "docker"; return { invocation,
        spawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => mocks.spawn(capturedCli, args, options),
    }; };
    return { ...({ getRuntimeInfo: mocks.info, runtimeCli: () => "docker" }), getRuntimeInvocation: () => invocation, bindNativeRuntimeInvocation: runner,
        runtimeSpawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => runner().spawnSync(args, options),
        runWithNativeRuntimeInvocation: <T>(_invocation: unknown, operation: () => T): T => operation() };
});
vi.mock("fs", async original => {
    const actual = await original<typeof import("fs")>();
    return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => args[0] === "/proc/sys/kernel/osrelease" ? mocks.kernel : actual.readFileSync(...args) };
});
const source = `/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu-24.04/${"a".repeat(64)}`;
const image = `sha256:${"b".repeat(64)}`;
const expected = { dev: "2096", ino: "85186" };
beforeEach(() => {
    mocks.spawn.mockReset().mockReturnValue({ status: 0, stdout: "2096:85186\n" });
    mocks.info.mockReset().mockReturnValue({ runtime: "docker", dockerDesktop: true, rootless: false });
    mocks.kernel = "6.6.87.2-microsoft-standard-WSL2";
});
afterEach(() => vi.restoreAllMocks());

describe.runIf(process.platform === "linux")("WSL daemon bind source proof", () => {
    it("proves the exact readonly source identity with a pinned stat helper", () => {
        expect(proveWslBindSourceIdentity(source, expected, image)).toBe(true);
        const args = mocks.spawn.mock.calls[0][1] as string[];
        expect(args).toContain(`type=bind,source=${source},target=/ccc-bind-proof,readonly`);
        expect(args).toContain("--read-only");
        expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual(["--network", "none"]);
        expect(args.slice(args.indexOf("--entrypoint"))).toEqual(["--entrypoint", "/usr/bin/stat", image, "-c", "%d:%i", "--", "/ccc-bind-proof"]);
        expect(existsSync(args[args.indexOf("--cidfile") + 1])).toBe(false);
    });
    it("distinguishes a proven mismatch from an unavailable proof", () => {
        mocks.spawn.mockReturnValue({ status: 0, stdout: "2096:85187\n" });
        expect(proveWslBindSourceIdentity(source, expected, image)).toBe(false);
    });
    it.each([{ runtime: "podman", dockerDesktop: true }, { runtime: "docker", dockerDesktop: false }, { runtime: "docker", dockerDesktop: true, rootless: true }])("rejects unsupported runtime %j", info => {
        mocks.info.mockReturnValue(info);
        expect(proveWslBindSourceIdentity(source, expected, image)).toBeNull();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it("rejects a non-WSL kernel", () => {
        mocks.kernel = "6.8.0-generic";
        expect(proveWslBindSourceIdentity(source, expected, image)).toBeNull();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it.each(["/home/me/.ccc/codex", `${source}/../other`, `${source},readonly=false`, source.replace("Ubuntu-24.04", "../Ubuntu")])("rejects unrecognized or malformed sources %s", value => {
        expect(proveWslBindSourceIdentity(value, expected, image)).toBeNull();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it("requires an immutable image and precise host identity", () => {
        expect(proveWslBindSourceIdentity(source, expected, "ccc:latest")).toBeNull();
        expect(proveWslBindSourceIdentity(source, { dev: Number.MAX_SAFE_INTEGER + 1, ino: 1 }, image)).toBeNull();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it.each([{ status: 1, stdout: "" }, { status: null, error: new Error("timeout") }, { status: 0, stdout: "2096:85186\n2096:85186" }, { status: 0, stdout: "invalid" }])("reports incomplete proof as unknown %j", result => {
        mocks.spawn.mockReturnValue(result);
        expect(proveWslBindSourceIdentity(source, expected, image)).toBeNull();
    });
    it("cleans up only its own helper ID after a timeout", () => {
        const cid = "c".repeat(64);
        let cidfile = "";
        mocks.spawn.mockImplementationOnce((_runtime: string, args: string[]) => {
            cidfile = args[args.indexOf("--cidfile") + 1];
            writeFileSync(cidfile, cid);
            return { status: null, error: new Error("timeout") };
        });
        expect(proveWslBindSourceIdentity(source, expected, image)).toBeNull();
        expect(mocks.spawn.mock.calls[1][1]).toEqual(["rm", "-f", cid]);
        expect(existsSync(cidfile)).toBe(false);
    });
});
