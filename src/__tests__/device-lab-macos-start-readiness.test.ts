import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as commands from "@ccc/device-lab/providers/commands.mjs";
import { prepareMacosGuestHelper, waitForMacosGuestHelper } from "@ccc/device-lab/providers/backends/macos-vm.mjs";
import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";

const refused = { ok: false, error: "macos-helper-scp-failed", command: { status: 255, stderr: "ssh: connect to host 10.0.0.2 port 22: Connection refused" } };
describe("macOS start helper provisioning", () => {
    it.each([
        ["SSH connection refusal", refused],
        ["ETIMEDOUT with empty streams", { ...refused, command: { status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } } }],
        ["stdout-only connection failure", { ...refused, command: { status: 255, stdout: "Connection reset by peer", stderr: "" } }],
    ])("retries %s under the original deadline without restarting the VM", async (_diagnostic, failure) => {
        let clock = 700;
        const ready = { ok: true, provisioning: { status: "provisioned" } };
        const provision = vi.fn().mockReturnValueOnce(failure).mockReturnValueOnce(ready);
        const device = { id: "mac-test" };
        const observed = await waitForMacosGuestHelper(device, 2000, {
            provision, now: () => clock, delay: async (ms: number) => { clock += ms; },
        });
        expect(observed).toBe(ready);
        expect(provision.mock.calls).toEqual([[device, { deadlineAt: 2000 }], [device, { deadlineAt: 2000 }]]);
        expect(clock).toBe(1200);
    });
    it("does not reset an exhausted boot budget for provisioning", async () => {
        const provision = vi.fn();
        const observed = await waitForMacosGuestHelper({}, 2000, { provision, now: () => 2000 });
        expect(observed.error).toBe("macos-helper-readiness-timeout");
        expect(provision).not.toHaveBeenCalled();
    });
    it("bounds repeated connection failures by the remaining boot budget", async () => {
        let clock = 700;
        const native = { ...refused, provisioning: { status: "pending", updatedAt: "2020-01-01T00:00:00.000Z", workspaceDir: "/guest/owned-helper", attempt: 3 } };
        const provision = vi.fn(() => native), before = Date.now();
        const observed = await waitForMacosGuestHelper({}, 1000, {
            provision, now: () => clock, delay: async (ms: number) => { clock += ms; },
        });
        expect(observed.error).toBe("macos-helper-readiness-timeout");
        expect(observed.provisioning).toMatchObject({ status: "failed", workspaceDir: "/guest/owned-helper", attempt: 3 });
        const updatedAt = Date.parse(String(observed.provisioning?.updatedAt));
        expect(updatedAt).toBeGreaterThanOrEqual(before);
        expect(updatedAt).toBeLessThanOrEqual(Date.now());
        expect(provision).toHaveBeenCalledTimes(1);
        expect(clock).toBe(1000);
    });
    it("does not retry an unrelated failure stage even when its diagnostics look like a transient network failure", async () => {
        const native = { ...refused, error: "macos-helper-invalid-key" }, provision = vi.fn(() => native), delay = vi.fn();
        expect(await waitForMacosGuestHelper({}, 1000, { provision, now: () => 0, delay })).toBe(native);
        expect(provision).toHaveBeenCalledTimes(1);
        expect(delay).not.toHaveBeenCalled();
    });
    it("does not retry invalid keys or authentication failure", async () => {
        for (const failure of [{ ok: false, error: "invalid-key" }, { ...refused, command: { status: 255, stderr: "Permission denied (publickey,password)." } }]) {
            const provision = vi.fn(() => failure);
            expect(await waitForMacosGuestHelper({}, 1000, { provision, now: () => 0 })).toBe(failure);
            expect(provision).toHaveBeenCalledTimes(1);
        }
    });
    it("rejects provisioning success that arrives after its deadline", async () => {
        let clock = 0;
        const observed = await waitForMacosGuestHelper({}, 1000, {
            provision: () => { clock = 1001; return { ok: true }; }, now: () => clock,
        });
        expect(observed.error).toBe("macos-helper-readiness-timeout");
    });
    it("keeps the exported numeric deadline and injected legacy callback shape as Unix time", async () => {
        const unix = Date.parse("2026-10-17T12:00:00.000Z"), device = { id: "legacy" };
        let clock = unix;
        const delay = vi.fn(async (milliseconds: number) => { clock += milliseconds; });
        const provision = vi.fn().mockReturnValueOnce(refused).mockReturnValueOnce({ ok: true, provisioning: { updatedAt: new Date(unix).toISOString() } });
        const result = await waitForMacosGuestHelper(device, unix + 700, { now: () => clock, provision, delay });
        expect(result.ok).toBe(true);
        expect(provision.mock.calls).toEqual([[device, { deadlineAt: unix + 700 }], [device, { deadlineAt: unix + 700 }]]);
        expect(delay.mock.calls).toEqual([[500]]);
    });
    it("preserves a genuine legacy provisioning failure that arrives after its numeric deadline", async () => {
        let clock = 0;
        const native = { ok: false, error: "macos-helper-chmod-failed", command: { status: 9, stderr: "Permission denied" } };
        const delay = vi.fn();
        const result = await waitForMacosGuestHelper({}, 1000, {
            now: () => clock, provision: () => { clock = 1001; return native; }, delay,
        });
        expect(result).toBe(native);
        expect(delay).not.toHaveBeenCalled();
    });
    it.each(["scp", "chmod"])("keeps legacy transient %s failure at numeric expiry as timeout with its original callback shape", async stage => {
        const unix = Date.parse("2026-10-17T12:00:00.000Z"), device = { id: "legacy-expiry" };
        let clock = unix;
        const native = { ok: false, error: stage === "scp" ? "macos-helper-scp-failed" : "macos-helper-chmod-failed",
            command: { status: 255, stderr: "Connection refused" } };
        const provision = vi.fn(() => { clock = unix + 1001; return native; }), delay = vi.fn();
        const result = await waitForMacosGuestHelper(device, unix + 1000, { now: () => clock, provision, delay });
        expect(result).toMatchObject({ ok: false, error: "macos-helper-readiness-timeout" });
        expect(result).not.toBe(native);
        expect(provision.mock.calls).toEqual([[device, { deadlineAt: unix + 1000 }]]);
        expect(delay).not.toHaveBeenCalled();
    });
});

describe("broker relative macOS guest helper adapter", () => {
    it("preserves missing SSH as a skip without discovery or native SSH/SCP", async () => {
        const discovery = vi.spyOn(commands, "commandPath").mockImplementation(() => { throw Error("no-SSH must not discover commands"); });
        const native = vi.spyOn(commands, "runWithTimeout").mockImplementation(() => { throw Error("no-SSH must not dispatch commands"); });
        try {
            expect(await prepareMacosGuestHelper({ id: "no-ssh" }, 1000)).toMatchObject({
                ok: true, skipped: true, helper: { status: "skipped-missing-ssh", provisioning: { status: "skipped-missing-ssh" } },
            });
            expect(discovery).not.toHaveBeenCalled();
            expect(native).not.toHaveBeenCalled();
        } finally { discovery.mockRestore(); native.mockRestore(); }
    });

    it.each([0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses %sms before any native admission", async allowanceMs => {
        const discovery = vi.spyOn(commands, "commandPath").mockImplementation(() => { throw Error("expired discovery"); });
        const native = vi.spyOn(commands, "runWithTimeout").mockImplementation(() => { throw Error("expired native call"); });
        try {
            expect(await prepareMacosGuestHelper({ id: "expired", ssh: { host: "192.0.2.4", user: "guest" } }, allowanceMs))
                .toMatchObject({ ok: false, error: "macos-helper-readiness-timeout", helper: { status: "failed" } });
            expect(discovery).not.toHaveBeenCalled();
            expect(native).not.toHaveBeenCalled();
        } finally { discovery.mockRestore(); native.mockRestore(); }
    });

    it("uses a relative monotonic allowance and decreases each SCP/SSH cap without exposing native output", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-macos-relative-helper-")), restoreEnvironment = isolateDeviceLabTestEnvironment(home);
        let monotonic = 17.25;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const discovery = vi.spyOn(commands, "commandPath").mockImplementation(tool => `/owned/${tool}`);
        const native = vi.spyOn(commands, "runWithTimeout").mockImplementation((_executable, _args, _timeoutMs) => {
            monotonic += native.mock.calls.length === 1 ? 125 : 75;
            return { status: 0, signal: null, pid: 0, output: [null, "private-native-stdout", "private-native-stderr"],
                stdout: "private-native-stdout", stderr: "private-native-stderr" };
        });
        try {
            const result = await prepareMacosGuestHelper({ id: "relative", ssh: { host: "192.0.2.4", user: "guest", password: "private-password" } }, 700);
            expect(result).toMatchObject({ ok: true, skipped: false, helper: { status: "provisioned", provisioning: { provider: "ssh-scp" } } });
            expect(native.mock.calls.map(call => [call[0], call[2]])).toEqual([["/owned/scp", 700], ["/owned/ssh", 575]]);
            expect(JSON.stringify(result)).not.toMatch(/private-native|private-password/);
        } finally { clock.mockRestore(); discovery.mockRestore(); native.mockRestore(); restoreEnvironment(); rmSync(home, { recursive: true, force: true }); }
    });

    it("performs one configured preparation attempt with waitForReady false even after a transient refusal", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-macos-one-shot-helper-")), restoreEnvironment = isolateDeviceLabTestEnvironment(home);
        const discovery = vi.spyOn(commands, "commandPath").mockImplementation(tool => `/owned/${tool}`);
        const native = vi.spyOn(commands, "runWithTimeout").mockReturnValue({ status: 255, signal: null, pid: 0, output: [null, "", "Connection refused"], stdout: "", stderr: "Connection refused" });
        const pacing = vi.spyOn(globalThis, "setTimeout");
        try {
            expect(await prepareMacosGuestHelper({ id: "one-shot", ssh: { host: "192.0.2.4", user: "guest" } }, 1000, false))
                .toMatchObject({ ok: false, error: "macos-helper-scp-failed", execution: { status: 255, timedOut: false }, helper: { status: "failed" } });
            expect(native).toHaveBeenCalledTimes(1);
            expect(native.mock.calls[0][0]).toBe("/owned/scp");
            expect(native.mock.calls[0][2]).toBeGreaterThan(0);
            expect(native.mock.calls[0][2]).toBeLessThanOrEqual(1000);
            expect(pacing).not.toHaveBeenCalled();
        } finally { pacing.mockRestore(); discovery.mockRestore(); native.mockRestore(); restoreEnvironment(); rmSync(home, { recursive: true, force: true }); }
    });
});
