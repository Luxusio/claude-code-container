import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { proveWslBindSourceIdentity } from "../wsl-bind-source-proof.js";
import { prepareRuntimeBindHome, readRuntimeBindAuthority, withRuntimeBindGuard } from "../adapters/runtime-bind-authority.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), info: vi.fn(), kernel: "6.6.87.2-microsoft-standard-WSL2", home: "", writeCid: true }));
vi.mock("child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("../home-layout.js", () => ({cccHome: () => mocks.home}));
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
        spawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => {
            if (args[0] === "run" && args.includes("--cidfile") && mocks.writeCid) {
                writeFileSync(args[args.indexOf("--cidfile") + 1], "c".repeat(64));
            }
            return mocks.spawn(capturedCli, args, options);
        },
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
let fixture: string;
beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "ccc-wsl-publication-"));
    mocks.home = join(fixture, "home");
    withRuntimeBindGuard(prepareRuntimeBindHome(mocks.home), () => undefined);
    mocks.writeCid = true;
    mocks.spawn.mockReset().mockReturnValue({ status: 0, stdout: "2096:85186\n" });
    mocks.info.mockReset().mockReturnValue({ runtime: "docker", dockerDesktop: true, rootless: false });
    mocks.kernel = "6.6.87.2-microsoft-standard-WSL2";
});
afterEach(() => { vi.restoreAllMocks(); rmSync(fixture, {recursive: true, force: true}); });

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
        withRuntimeBindGuard(mocks.home, guard => expect(readRuntimeBindAuthority(guard).pending).toBe(true));
    });
    it("durably publishes authority and pending effect before the helper can observe its bind", () => {
        mocks.spawn.mockImplementation((_runtime: string, args: string[]) => {
            const history = JSON.parse(readFileSync(join(mocks.home, "runtime-bind-authority", "history.json"), "utf8"));
            expect(history.authorities).toHaveLength(1);
            expect(history.authorities[0]).toMatchObject({executable: "/fixture/runtime/docker", transport: {host: "unix:///fixture/engine.sock"}});
            expect(history.pending).toMatch(/^[a-f0-9]{32}$/);
            expect(existsSync(join(mocks.home, "codex-state.lock"))).toBe(true);
            return {status: 0, stdout: args[0] === "run" ? "2096:85186\n" : ""};
        });
        withRuntimeBindGuard(mocks.home, guard => {
            expect(proveWslBindSourceIdentity(source, expected, image, guard)).toBe(true);
            expect(readRuntimeBindAuthority(guard)).toMatchObject({coverage: "complete", pending: false});
        });
        expect(mocks.spawn.mock.calls.map(call => (call[1] as string[])[0])).toEqual(["run", "rm"]);
    });
    it("returns unproven without native effects when standalone admission would reenter a held guard", () => {
        withRuntimeBindGuard(mocks.home, () => {
            const before = readFileSync(join(mocks.home, "runtime-bind-authority", "history.json"));
            const started = performance.now();
            expect(proveWslBindSourceIdentity(source, expected, image)).toBeNull();
            expect(performance.now() - started).toBeLessThan(1000);
            expect(readFileSync(join(mocks.home, "runtime-bind-authority", "history.json"))).toEqual(before);
            expect(mocks.spawn).not.toHaveBeenCalled();
        });
    });
    it("does not use a valid held capability for a different CCC home", () => {
        const other = prepareRuntimeBindHome(join(fixture, "other-home"));
        withRuntimeBindGuard(other, guard => {
            expect(proveWslBindSourceIdentity(source, expected, image, guard)).toBeNull();
            expect(readRuntimeBindAuthority(guard)).toMatchObject({coverage: "complete", pending: false, authorities: []});
        });
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it.each(["no CID", "failed cleanup"] as const)("keeps a pending veto after a failed client and %s", mode => {
        mocks.writeCid = mode !== "no CID";
        mocks.spawn.mockImplementation((_runtime: string, args: string[]) => ({
            status: args[0] === "rm" ? 1 : null, stdout: "",
            ...(args[0] === "run" ? {error: new Error("native client timed out")} : {}),
        }));
        expect(proveWslBindSourceIdentity(source, expected, image)).toBeNull();
        withRuntimeBindGuard(mocks.home, guard => expect(readRuntimeBindAuthority(guard)).toMatchObject({coverage: "complete", pending: true}));
        expect(mocks.spawn.mock.calls.map(call => (call[1] as string[])[0])).toEqual(mode === "no CID" ? ["run"] : ["run", "rm"]);
    });
    it("a later successful helper cannot erase an earlier unsettled creation", () => {
        mocks.writeCid = false;
        mocks.spawn.mockReturnValueOnce({status: null, stdout: "", error: new Error("native client timed out")});
        expect(proveWslBindSourceIdentity(source, expected, image)).toBeNull();
        mocks.writeCid = true;
        expect(proveWslBindSourceIdentity(source, expected, image)).toBe(true);
        withRuntimeBindGuard(mocks.home, guard => {
            expect(readRuntimeBindAuthority(guard)).toMatchObject({coverage: "incomplete", pending: false});
        });
    });
    it("settles a positively completed captured --rm request even if no CID was published", () => {
        mocks.writeCid = false;
        expect(proveWslBindSourceIdentity(source, expected, image)).toBe(true);
        withRuntimeBindGuard(mocks.home, guard => expect(readRuntimeBindAuthority(guard)).toMatchObject({coverage: "complete", pending: false}));
        expect(mocks.spawn.mock.calls.map(call => (call[1] as string[])[0])).toEqual(["run"]);
    });
    it("a history publication failure refuses helper creation and preserves the original file", () => {
        const history = join(mocks.home, "runtime-bind-authority", "history.json");
        writeFileSync(history, "unparseable private history", {mode: 0o600});
        const before = readFileSync(history);
        expect(proveWslBindSourceIdentity(source, expected, image)).toBeNull();
        expect(readFileSync(history)).toEqual(before);
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
});
