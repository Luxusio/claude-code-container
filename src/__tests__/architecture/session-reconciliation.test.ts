import { beforeEach, describe, expect, it, vi } from "vitest";
import { stopNativeSessionContainer } from "../../adapters/session-cleanup.js";
import { NATIVE_RUNTIME_SELECTOR_KEYS, type NativeRuntimeInvocation, type NativeRuntimeSelectors } from "../../ports/container-runtime-invocation.js";

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn }));
vi.mock("../../device-lab-cleanup.js", () => ({ cleanupOwnerDevices: () => { throw new Error("unexpected device cleanup"); } }));
const id = "a".repeat(64), otherId = "b".repeat(64);
const invocation: NativeRuntimeInvocation = {
    version: 1, runtime: "docker", executable: "/fixture/docker",
    transport: { kind: "docker", host: "unix:///fixture/captured.sock", configDirectory: "/fixture/config",
        tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
    selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])) as NativeRuntimeSelectors,
};
const prefix = ["--config", "/fixture/config", "--host", "unix:///fixture/captured.sock", "--tls=false", "--tlscacert=", "--tlscert=", "--tlskey="];
const enumeration = ["ps", "-aq", "--no-trunc", "-f", `id=${id}`];
const enumerateOptions = { encoding: "utf8", stdio: "pipe", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096,
    shell: false, env: expect.any(Object) };
const stopOptions = { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL", shell: false, env: expect.any(Object) };
beforeEach(() => { vi.resetAllMocks(); });

describe("native session target reconciliation", () => {
    it("settles positively enumerated exact-ID absence without dispatching stop", () => {
        native.spawn.mockReturnValue({ status: 0, stdout: " \n", stderr: "" });
        expect(stopNativeSessionContainer(() => id, invocation)).toBeUndefined();
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith(invocation.executable, [...prefix, ...enumeration], enumerateOptions);
    });
    it("enumerates the pinned full ID before stopping and keeps both commands on the captured authority", () => {
        native.spawn.mockReturnValueOnce({ status: 0, stdout: `${id}\n`, stderr: "" }).mockReturnValue({ status: 0 });
        expect(stopNativeSessionContainer(() => id, invocation)).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual([
            [invocation.executable, [...prefix, ...enumeration], enumerateOptions],
            [invocation.executable, [...prefix, "stop", id], stopOptions],
        ]);
    });
    it.each([
        { status: 9, stdout: "", stderr: "PRIVATE_ENGINE_CONFIG" },
        { status: null, stdout: "", error: Object.assign(new Error("PRIVATE_CERT_PATH"), { code: "ETIMEDOUT" }) },
        { status: 0, stdout: "", signal: "SIGTERM" },
        { status: 0 },
        { status: 0, stdout: Buffer.from("") },
        { status: 0, stdout: id.slice(0, 12) },
        { status: 0, stdout: otherId },
        { status: 0, stdout: `${id}\n${id}\n` },
        { status: 0, stdout: `${id}\n${otherId}\n` },
    ])("does not mistake a failed or ambiguous enumeration for absence: %j", result => {
        native.spawn.mockReturnValue(result);
        let failure: unknown;
        try { stopNativeSessionContainer(() => id, invocation); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/state (could not be verified|is ambiguous)/);
        expect((failure as Error).message).not.toMatch(/PRIVATE_ENGINE_CONFIG|PRIVATE_CERT_PATH/);
        expect(native.spawn).toHaveBeenCalledTimes(1);
        expect(native.spawn.mock.calls.every(call => !(call[1] as string[]).includes("stop"))).toBe(true);
    });
    it.each([null, "", id.slice(0, 12), "not-an-id"])("rejects an unqualified target %j before native effects", target => {
        expect(() => stopNativeSessionContainer(() => target, invocation)).toThrow(/full container ID/);
        expect(native.spawn).not.toHaveBeenCalled();
    });
    it.each(["", `${id}\n`])("rechecks authorization after enumeration before settling or stopping (%j)", stdout => {
        let current: string | null = id;
        native.spawn.mockImplementation(() => { current = otherId; return { status: 0, stdout }; });
        expect(() => stopNativeSessionContainer(() => current, invocation)).toThrow(/target changed/);
        expect(native.spawn).toHaveBeenCalledTimes(1);
    });
    it("a target revoked during the final authorization read cannot stop the originally observed container", () => {
        native.spawn.mockReturnValue({ status: 0, stdout: `${id}\n` });
        const readId = vi.fn().mockReturnValueOnce(id).mockReturnValueOnce(id).mockReturnValue(null);
        expect(() => stopNativeSessionContainer(readId, invocation)).toThrow(/target changed/);
        expect(native.spawn).toHaveBeenCalledTimes(1);
    });
    it("does not mask a failed stop with another observation, while a later call may confirm absence", () => {
        native.spawn.mockReturnValueOnce({ status: 0, stdout: `${id}\n` })
            .mockReturnValueOnce({ status: 9, stderr: "PRIVATE_NATIVE_ERROR" })
            .mockReturnValue({ status: 0, stdout: "" });
        expect(() => stopNativeSessionContainer(() => id, invocation)).toThrow(/Container shutdown failed/);
        expect(native.spawn).toHaveBeenCalledTimes(2);
        expect(stopNativeSessionContainer(() => id, invocation)).toBeUndefined();
        expect(native.spawn.mock.calls.map(call => (call[1] as string[]).slice(prefix.length)))
            .toEqual([enumeration, ["stop", id], enumeration]);
    });
    it("does not substitute ambient Docker authority when recovery captured local Podman", () => {
        const podman: NativeRuntimeInvocation = { ...invocation, runtime: "podman", executable: "/fixture/podman",
            transport: { kind: "podman-local", graphRoot: "/fixture/graph", runRoot: "/fixture/run",
                storageDriver: "overlay", storageOptions: [], transientStore: false } };
        native.spawn.mockReturnValueOnce({ status: 0, stdout: `${id}\n` }).mockReturnValue({ status: 0 });
        stopNativeSessionContainer(() => id, podman);
        const podmanPrefix = ["--remote=false", "--root", "/fixture/graph", "--runroot", "/fixture/run", "--storage-driver", "overlay", "--transient-store=false"];
        expect(native.spawn.mock.calls.map(call => [call[0], call[1]])).toEqual([
            [podman.executable, [...podmanPrefix, ...enumeration]], [podman.executable, [...podmanPrefix, "stop", id]],
        ]);
    });
});
