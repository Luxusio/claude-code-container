import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExistsSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock("fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("fs")>();
    return {
        ...actual,
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        statSync: (...args: unknown[]) => mockStatSync(...args),
    };
});

const { _setRuntimeInfoForTest } = await import("../container-runtime.js");
const {
    formatLabRunnerSmoke,
    formatLabRunnerStatus,
    labRunnerSnapshot,
    labsCli,
} = await import("../lab-runner-admin.js");

describe("lab-runner admin CLI helpers", () => {
    beforeEach(() => {
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");
        _setRuntimeInfoForTest({
            runtime: "docker",
            flavor: "docker-native",
            remote: false,
            rootless: false,
        });
        mockExistsSync.mockImplementation((path: string) => path === "/dev/kvm");
        mockStatSync.mockReturnValue({ gid: 108 });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        mockExistsSync.mockReset();
        mockStatSync.mockReset();
    });

    it("reports ready lab-runner KVM wiring without requiring user configuration", () => {
        const snapshot = labRunnerSnapshot("/project/example");

        expect(snapshot).toEqual(expect.objectContaining({
            profile: "lab-runner",
            status: "ready",
            stateContainerDir: "/home/ccc/.ccc/labs",
            kvmDevicePath: "/dev/kvm",
            kvmGroupId: 108,
            networkMode: "user",
            defaultContainerVmCapable: true,
            startCommands: {
                shell: "ccc labs shell",
                run: "ccc labs run <command>",
                status: "ccc labs status",
            },
        }));
        expect(snapshot.defaultContainer).toEqual(expect.objectContaining({
            containerName: expect.stringMatching(/^ccc-/),
            status: "ready",
            stateContainerDir: "/home/ccc/.ccc/labs",
            kvmDevicePath: "/dev/kvm",
            kvmGroupId: 108,
            networkMode: "user",
        }));
        expect(snapshot.defaultContainer.containerName).not.toMatch(/--p--lab-runner$/);
        expect(snapshot.defaultContainer.stateVolumeName).toBe(`${snapshot.defaultContainer.containerName}-lab-state`);
        expect(snapshot.labRunnerProfile).toEqual(expect.objectContaining({
            containerName: snapshot.containerName,
            status: "ready",
            stateVolumeName: snapshot.stateVolumeName,
            kvmDevicePath: "/dev/kvm",
            kvmGroupId: 108,
        }));
        expect(snapshot.containerName).toMatch(/--p--lab-runner$/);
        expect(snapshot.stateVolumeName).toBe(`${snapshot.containerName}-lab-state`);
    });

    it("reports unsupported lab-runner diagnostics clearly when KVM is unavailable", () => {
        mockExistsSync.mockReturnValue(false);
        const snapshot = labRunnerSnapshot("/project/example");

        expect(snapshot.status).toBe("unsupported");
        expect(snapshot.unsupportedReason).toMatch(/\/dev\/kvm/);
        expect(snapshot.kvmDevicePath).toBeNull();
        expect(snapshot.networkMode).toBe("user");
        expect(snapshot.defaultContainer.status).toBe("unsupported");
        expect(snapshot.defaultContainer.unsupportedReason).toMatch(/\/dev\/kvm/);
        expect(snapshot.defaultContainer.kvmDevicePath).toBeNull();
    });

    it("formats non-starting status and smoke output for users and agents", () => {
        const status = formatLabRunnerStatus("/project/example");
        expect(status).toContain("default container: VM-capable when supported");
        expect(status).toContain("default status: ready");
        expect(status).toMatch(/default state volume: ccc-[^\n]*-lab-state/);
        expect(status).toContain("default kvm: /dev/kvm group=108");
        expect(status).toContain("safety: no --privileged and no host TUN exposure");
        expect(status).toContain("vm networking: user (QEMU user-mode; no host TUN exposure)");
        expect(status).toContain("startup policy: lazy; this status check does not start labs or VMs");
        expect(status).toContain("shell: ccc labs shell");
        expect(status).toContain("mcp: call lab_status");

        const smoke = formatLabRunnerSmoke("/project/example");
        expect(smoke).toContain("default-container-vm-config: PASS");
        expect(smoke).toContain("default-container-safety: PASS no --privileged or host TUN exposure");
        expect(smoke).toContain("default-durable-lab-state: PASS");
        expect(smoke).toContain("default-nested-kvm: PASS /dev/kvm group=108");
        expect(smoke).toContain("lab-runner-durable-lab-state: PASS");
        expect(smoke).toContain("lab-runner-nested-kvm: PASS /dev/kvm group=108");
        expect(smoke).toContain("vm-network: PASS user networking (no host TUN exposure)");
        expect(smoke).toContain("vm-startup: not-run");
        expect(smoke).toContain("result: PASS");
    });

    it("marks smoke as SKIP on unsupported hosts without failing the command", () => {
        mockExistsSync.mockReturnValue(false);
        const smoke = formatLabRunnerSmoke("/project/example");

        expect(smoke).toContain("default-durable-lab-state: SKIP /dev/kvm is not available on the container host");
        expect(smoke).toContain("lab-runner-durable-lab-state: SKIP /dev/kvm is not available on the container host");
        expect(smoke).not.toContain("durable-lab-state: PASS");
        const status = formatLabRunnerStatus("/project/example");
        expect(status).toContain("state volume: not mounted for new containers (nested VM unavailable)");
        expect(status).toContain("default state volume: not mounted for new containers (nested VM unavailable)");
        expect(smoke).toContain("default-nested-kvm: SKIP /dev/kvm is not available on the container host");
        expect(smoke).toContain("lab-runner-nested-kvm: SKIP /dev/kvm is not available on the container host");
        expect(smoke).toContain("container-qemu-provider-gate: SKIP");
        expect(smoke).toContain("result: SKIP");
    });

    it("exposes status, smoke, and usage through labsCli", () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        expect(labsCli([], "/project/example")).toBe(0);
        expect(logSpy).toHaveBeenLastCalledWith(expect.stringContaining("=== CCC Lab Runner ==="));
        expect(labsCli(["smoke"], "/project/example")).toBe(0);
        expect(logSpy).toHaveBeenLastCalledWith(expect.stringContaining("=== CCC Lab Runner Smoke ==="));
        expect(labsCli(["unknown"], "/project/example")).toBe(1);
        expect(errorSpy).toHaveBeenLastCalledWith("Usage: ccc labs <status|doctor|smoke|shell|run>");
    });

    it.each([{ args: [] }, { args: [""] }, { args: ["status"] }, { args: ["doctor"] }, { args: ["smoke"] }])("publishes the complete diagnostic output synchronously for %j", ({ args }) => {
        const expected = args[0] === "smoke" ? formatLabRunnerSmoke("/project/example") : formatLabRunnerStatus("/project/example");
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(labsCli(args, "/project/example")).toBe(0);
        expect(logSpy).toHaveBeenCalledExactlyOnceWith(expected);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it.each(["status", "doctor", "smoke", ""])("keeps unsupported %j diagnostics successful and non-starting", command => {
        mockExistsSync.mockReturnValue(false);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        expect(labsCli([command], "/project/example")).toBe(0);
        expect(logSpy).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(command === "smoke"
            ? "result: SKIP" : "this status check does not start labs or VMs"));
    });

    it.each(["unknown", " STATUS ", "shell", "run"])("returns usage for %j without observing native configuration", command => {
        mockExistsSync.mockImplementation(() => { throw new Error("native observation forbidden"); });
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(labsCli([command], "/project/example")).toBe(1);
        expect(errorSpy).toHaveBeenCalledExactlyOnceWith("Usage: ccc labs <status|doctor|smoke|shell|run>");
        expect(logSpy).not.toHaveBeenCalled();
        expect(mockExistsSync).not.toHaveBeenCalled();
        expect(mockStatSync).not.toHaveBeenCalled();
    });

    it("keeps group zero visible in the public snapshot and terminal diagnostics", () => {
        mockStatSync.mockReturnValue({ gid: 0 });
        expect(labRunnerSnapshot("/project/example").kvmGroupId).toBe(0);
        expect(formatLabRunnerStatus("/project/example")).toContain("kvm: /dev/kvm group=0");
        expect(formatLabRunnerSmoke("/project/example")).toContain("nested-kvm: PASS /dev/kvm group=0");
    });

    it("uses the current directory by default for each public diagnostic", () => {
        expect(labRunnerSnapshot()).toEqual(labRunnerSnapshot(process.cwd()));
        expect(formatLabRunnerStatus()).toBe(formatLabRunnerStatus(process.cwd()));
        expect(formatLabRunnerSmoke()).toBe(formatLabRunnerSmoke(process.cwd()));
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        expect(labsCli([])).toBe(0);
        expect(logSpy).toHaveBeenCalledExactlyOnceWith(formatLabRunnerStatus(process.cwd()));
    });

    it("captures the console callee before observing native configuration", () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const replacement = vi.fn();
        mockExistsSync.mockImplementation((path: string) => {
            console.log = replacement;
            return path === "/dev/kvm";
        });
        expect(labsCli(["status"], "/project/example")).toBe(0);
        expect(logSpy).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("=== CCC Lab Runner ==="));
        expect(replacement).not.toHaveBeenCalled();
    });

    it("propagates raw native observation failures without publishing diagnostics", () => {
        const fault = {};
        mockExistsSync.mockImplementation(() => { throw fault; });
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        let caught: unknown;
        try { labsCli(["status"], "/project/example"); } catch (error) { caught = error; }
        expect(caught).toBe(fault);
        expect(logSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });
});
