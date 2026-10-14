import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLab, handleLinuxVmTool, inspectLab, ownerId, startLab } from "@ccc/device-lab/providers/backends/linux-vm.mjs";
import { withOwnerDeviceOperation } from "@ccc/device-lab/providers/state/device-store.mjs";

const roots: string[] = [];
let restoreEnvironment: (() => void) | undefined;
beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "ccc-preparation-home-"));
    roots.push(home);
    restoreEnvironment = isolateDeviceLabTestEnvironment(home);
});
afterEach(() => {
    restoreEnvironment?.();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(extra: Record<string, unknown> = {}) {
    const root = mkdtempSync(join(tmpdir(), "ccc-preparation-"));
    roots.push(root);
    const env = { CCC_PROFILE: basename(root), CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "ready" };
    const keys = join(root, "owners", ownerId(env), "keys");
    mkdirSync(keys, { recursive: true });
    const key = join(keys, "id_ed25519");
    writeFileSync(key, "test-key");
    const provision = vi.fn(() => ({ ok: true, status: 0, stdout: "", stderr: "" }));
    const spawn = vi.fn(() => ({ ok: true, pid: 12345 }));
    const options = {
        env, stateRoot: root, qemuPath: "/test/qemu", kvmAvailable: true,
        sshPath: "/test/ssh", commandRunner: spawn, sshCommandRunner: provision,
        processExists: () => true,
    };
    const created = createLab({
        name: "Preparation", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: key,
        guestAgentHealthCommand: "test-agent-health", guestAgentProvisionCommand: "test-agent-setup", ...extra,
    }, options);
    expect(created.ok).toBe(true);
    const labId = created.lab.id;
    return { labId, options, provision, spawn };
}

describe("automatic QEMU preparation and status", () => {
    it("prepares a configured agent on start and does not repeat successful preparation", () => {
        const { labId, options, provision, spawn } = fixture();
        expect(startLab({ labId }, options)).toMatchObject({ ok: true, guestAgentProvision: { ok: true } });
        expect(startLab({ labId }, options)).toMatchObject({ ok: true, reused: true });
        expect(provision).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("retains the running VM on preparation failure and retries without spawning another", () => {
        const { labId, options, provision, spawn } = fixture();
        provision.mockReturnValueOnce({ ok: false, status: 1, stdout: "", stderr: "setup failed" });
        expect(startLab({ labId }, options)).toMatchObject({
            ok: false, error: "lab-guest-agent-provision-failed", lab: { id: labId, runtimeState: "running" },
            guestAgentProvision: { ok: false },
        });
        expect(startLab({ labId }, options)).toMatchObject({ ok: true, reused: true, guestAgentProvision: { ok: true } });
        expect(provision).toHaveBeenCalledTimes(2);
        expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("honors explicit provisioning opt-out and keeps dry-run side-effect free", () => {
        const disabled = fixture({ guestAgentAutoProvision: false });
        expect(startLab({ labId: disabled.labId }, disabled.options).ok).toBe(true);
        expect(disabled.provision).not.toHaveBeenCalled();
        const dry = fixture();
        expect(startLab({ labId: dry.labId, dryRun: true }, dry.options)).toMatchObject({ ok: true, dryRun: true });
        expect(dry.provision).not.toHaveBeenCalled();
        expect(dry.spawn).not.toHaveBeenCalled();
    });

    it("reports stopped state without guest probes and refreshes running readiness without provisioning", () => {
        const { labId, options, provision, spawn } = fixture({ guestAgentAutoProvision: false });
        const probe = vi.fn(() => ({ ok: true, ready: true, checks: [] }));
        const observation = { ...options, readinessProbeRunner: probe };
        expect(inspectLab({ labId }, observation)).toMatchObject({ ok: true, readiness: { state: "stopped" } });
        expect(probe).not.toHaveBeenCalled();
        startLab({ labId }, options);
        expect(inspectLab({ labId }, observation)).toMatchObject({ ok: true, readiness: { state: "ready" } });
        expect(probe).toHaveBeenCalledTimes(1);
        expect(provision).not.toHaveBeenCalled();
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(inspectLab({ labId: "missing" }, observation).ok).toBe(false);
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it("keeps readiness failure visible with the device identity", () => {
        const { labId, options } = fixture({ guestAgentAutoProvision: false });
        startLab({ labId }, options);
        expect(inspectLab({ labId }, { ...options, processExists: () => false })).toMatchObject({
            ok: false, error: "lab-readiness-failed", lab: { id: labId }, readiness: { state: "failed" },
        });
    });

    it("waits for the owner operation lock before refreshing readiness", async () => {
        const { labId, options } = fixture({ guestAgentAutoProvision: false });
        startLab({ labId }, options);
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const acquired = new Promise<void>((resolve) => { entered = resolve; });
        const holder = withOwnerDeviceOperation("linux", labId, async () => { entered(); await gate; });
        await acquired;
        const probe = vi.fn(() => ({ ok: true, ready: true, checks: [] }));
        const pending = handleLinuxVmTool("device_status", { deviceId: labId }, { ...options, readinessProbeRunner: probe });
        try {
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(probe).not.toHaveBeenCalled();
        } finally { release(); }
        await holder;
        const result = await pending;
        expect(result.isError).not.toBe(true);
        expect(probe).toHaveBeenCalledTimes(1);
    });
});
