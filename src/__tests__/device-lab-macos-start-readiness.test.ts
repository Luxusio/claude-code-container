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
        expect(observed).not.toHaveProperty("command");
        expect(provision).not.toHaveBeenCalled();
    });
    it("bounds repeated connection failures by the remaining boot budget", async () => {
        let clock = 700;
        const native = { ...refused, command: { status: 255, signal: null, stdout: "PRIVATE-STDOUT", stderr: "Connection refused PRIVATE-STDERR",
            executable: "/PRIVATE-PATH", args: ["PRIVATE-ARG"], error: { code: "PRIVATE-CODE", message: "PRIVATE-ERROR", path: "/PRIVATE-ERROR-PATH" } },
            provisioning: { status: "pending", updatedAt: "2020-01-01T00:00:00.000Z", workspaceDir: "/guest/owned-helper", attempt: 3 } };
        const provision = vi.fn(() => native), before = Date.now();
        const observed = await waitForMacosGuestHelper({}, 1000, {
            provision, now: () => clock, delay: async (ms: number) => { clock += ms; },
        });
        expect(observed.error).toBe("macos-helper-readiness-timeout");
        expect(observed.command).toEqual({ status: 255, signal: null, stdout: "", stderr: "" });
        expect(JSON.stringify(observed)).not.toContain("PRIVATE");
        expect(observed.provisioning).toMatchObject({ status: "failed", workspaceDir: "/guest/owned-helper", attempt: 3 });
        const updatedAt = Date.parse(String(observed.provisioning?.updatedAt));
        expect(updatedAt).toBeGreaterThanOrEqual(before);
        expect(updatedAt).toBeLessThanOrEqual(Date.now());
        expect(provision).toHaveBeenCalledTimes(1);
        expect(clock).toBe(1000);
    });
    it("omits malformed native metadata and raw output from a synthesized timeout receipt", async () => {
        let clock = 0;
        const native = { ...refused, command: { status: -1, signal: "PRIVATE-SIGNAL", stdout: "PRIVATE-STDOUT", stderr: "Connection refused PRIVATE-STDERR",
            error: { code: "PRIVATE-CODE", message: "PRIVATE-ERROR" }, output: [null, "PRIVATE-OUTPUT"], args: ["PRIVATE-ARG"] } };
        const provision = vi.fn(() => native);
        const result = await waitForMacosGuestHelper({}, 100, { provision, now: () => clock, delay: async (ms: number) => { clock += ms; } });
        expect(result).toMatchObject({ ok: false, error: "macos-helper-readiness-timeout" });
        expect(result.command).toEqual({ status: null, signal: null, stdout: "", stderr: "" });
        expect(JSON.stringify(result)).not.toContain("PRIVATE");
        expect(provision).toHaveBeenCalledTimes(1);
        expect(clock).toBe(100);
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
            command: { status: 255, signal: "SIGTERM", stdout: "PRIVATE-STDOUT", stderr: "Connection refused PRIVATE-STDERR",
                error: { code: "ETIMEDOUT", message: "PRIVATE-ERROR", path: "/PRIVATE-PATH", args: ["PRIVATE-ARG"] } } };
        const provision = vi.fn(() => { clock = unix + 1001; return native; }), delay = vi.fn();
        const result = await waitForMacosGuestHelper(device, unix + 1000, { now: () => clock, provision, delay });
        expect(result).toMatchObject({ ok: false, error: "macos-helper-readiness-timeout" });
        expect(result.command).toEqual({ status: 255, signal: "SIGTERM", stdout: "", stderr: "", error: { code: "ETIMEDOUT" } });
        expect(JSON.stringify(result)).not.toContain("PRIVATE");
        expect(result).not.toBe(native);
        expect(provision.mock.calls).toEqual([[device, { deadlineAt: unix + 1000 }]]);
        expect(delay).not.toHaveBeenCalled();
    });
});

describe("broker relative macOS guest helper adapter", () => {
    it.each(["0", "-1", "1.5", "PRIVATE-DEADLINE", "1".repeat(25), 1000])("refuses invalid or expired inherited deadline %s before native admission", async deadlineNs => {
        const discovery = vi.spyOn(commands, "commandPath").mockImplementation(() => { throw Error("expired discovery"); });
        const native = vi.spyOn(commands, "runWithTimeout").mockImplementation(() => { throw Error("expired native call"); });
        const onFirstFailure = vi.fn();
        try {
            const result = await prepareMacosGuestHelper({ id: "expired-parent", ssh: { host: "192.0.2.4", user: "guest" } }, 1000, true,
                { deadlineNs: deadlineNs as string, onFirstFailure });
            expect(result).toMatchObject({ ok: false, error: "macos-helper-readiness-timeout" });
            expect(discovery).not.toHaveBeenCalled();
            expect(native).not.toHaveBeenCalled();
            expect(onFirstFailure).not.toHaveBeenCalled();
        } finally { discovery.mockRestore(); native.mockRestore(); }
    });

    it.each([250, 1000])("caps every native command by both the inherited and local %sms allowance", async allowanceMs => {
        const home = mkdtempSync(join(tmpdir(), "ccc-macos-inherited-helper-")), restoreEnvironment = isolateDeviceLabTestEnvironment(home);
        let monotonic = 50, nanoseconds = 1_000_000_000_000n;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const sharedClock = vi.spyOn(process.hrtime, "bigint").mockImplementation(() => nanoseconds);
        const discovery = vi.spyOn(commands, "commandPath").mockImplementation(tool => `/owned/${tool}`);
        const native = vi.spyOn(commands, "runWithTimeout").mockImplementation(() => {
            monotonic += 100; nanoseconds += 100_000_000n;
            return { status: 0, signal: null, stdout: "PRIVATE-OUTPUT", stderr: "", pid: 0, output: [null, "PRIVATE-OUTPUT", ""] };
        });
        try {
            const result = await prepareMacosGuestHelper({ id: "two-clocks", ssh: { host: "192.0.2.4", user: "guest" } }, allowanceMs, false,
                { deadlineNs: String(nanoseconds + 700_000_000n) });
            expect(result.ok).toBe(true);
            expect(native.mock.calls.map(call => call[2])).toEqual([Math.min(allowanceMs, 700), Math.min(allowanceMs - 100, 600)]);
            expect(JSON.stringify(result)).not.toContain("PRIVATE");
        } finally {
            sharedClock.mockRestore(); clock.mockRestore(); discovery.mockRestore(); native.mockRestore();
            restoreEnvironment(); rmSync(home, { recursive: true, force: true });
        }
    });

    it("reports the first completed native failure once before retry sleep while retaining later success", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-macos-first-failure-")), restoreEnvironment = isolateDeviceLabTestEnvironment(home);
        const discovery = vi.spyOn(commands, "commandPath").mockImplementation(tool => `/owned/${tool}`);
        const events: string[] = [], onFirstFailure = vi.fn(value => { events.push("first-failure"); expect(value).toEqual({
            provider: "scp", execution: { status: 255, signal: null, timedOut: false }, connection: "refused",
        }); });
        const native = vi.spyOn(commands, "runWithTimeout").mockImplementation(() => {
            events.push("native");
            return native.mock.calls.length < 3
                ? { status: 255, signal: null, stdout: "PRIVATE-STDOUT", stderr: "Connection refused PRIVATE-STDERR", pid: 0,
                    output: [null, "PRIVATE-STDOUT", "Connection refused PRIVATE-STDERR"] }
                : { status: 0, signal: null, stdout: "", stderr: "", pid: 0, output: [null, "", ""] };
        });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const pacing = vi.spyOn(globalThis, "setTimeout");
        try {
            const pending = prepareMacosGuestHelper({ id: "retry-then-ready", ssh: { host: "192.0.2.4", user: "guest", password: "PRIVATE-PASSWORD" } }, 5000, true,
                { onFirstFailure });
            expect(events).toEqual(["native", "first-failure"]);
            expect(pacing).toHaveBeenCalledTimes(1);
            expect(pacing.mock.invocationCallOrder[0]).toBeGreaterThan(onFirstFailure.mock.invocationCallOrder[0]);
            await vi.advanceTimersByTimeAsync(1000);
            const result = await pending;
            expect(result).toMatchObject({ ok: true, helper: { status: "provisioned" } });
            expect(onFirstFailure).toHaveBeenCalledTimes(1);
            expect(native).toHaveBeenCalledTimes(4);
            expect(result).not.toHaveProperty("firstFailure");
            expect(JSON.stringify(result)).not.toContain("PRIVATE");
        } finally {
            pacing.mockRestore(); vi.useRealTimers(); discovery.mockRestore(); native.mockRestore();
            restoreEnvironment(); rmSync(home, { recursive: true, force: true });
        }
    });

    it.each([
        ["scp", "Permission denied (publickey,password). PRIVATE-DETAIL", "authentication"],
        ["ssh", "No route to host PRIVATE-HOST", "unreachable"],
    ])("keeps the bounded first %s failure when the callback throws", async (provider, stderr, connection) => {
        const home = mkdtempSync(join(tmpdir(), "ccc-macos-first-failure-once-")), restoreEnvironment = isolateDeviceLabTestEnvironment(home);
        const discovery = vi.spyOn(commands, "commandPath").mockImplementation(tool => `/owned/${tool}`);
        const native = vi.spyOn(commands, "runWithTimeout").mockImplementation(executable => ({
            status: executable.endsWith(`/${provider}`) ? 255 : 0, signal: null, stdout: "", stderr: executable.endsWith(`/${provider}`) ? stderr : "", pid: 0, output: [],
        }));
        const onFirstFailure = vi.fn(() => { throw Error("PRIVATE-CALLBACK-ERROR"); });
        try {
            const result = await prepareMacosGuestHelper({ id: "callback-error", ssh: { host: "192.0.2.4", user: "guest" } }, 1000, false, { onFirstFailure });
            expect(result).toMatchObject({ ok: false, error: provider === "scp" ? "macos-helper-scp-failed" : "macos-helper-chmod-failed" });
            expect(onFirstFailure.mock.calls).toEqual([[{ provider, execution: { status: 255, signal: null, timedOut: false }, connection }]]);
            expect(JSON.stringify(result) + JSON.stringify(onFirstFailure.mock.calls)).not.toContain("PRIVATE");
        } finally { discovery.mockRestore(); native.mockRestore(); restoreEnvironment(); rmSync(home, { recursive: true, force: true }); }
    });

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

    it("retains the last native receipt when transient helper polling exhausts the original relative budget", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-macos-expired-helper-")), restoreEnvironment = isolateDeviceLabTestEnvironment(home);
        let monotonic = 0;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const clock = vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const discovery = vi.spyOn(commands, "commandPath").mockImplementation(tool => `/owned/${tool}`);
        const native = vi.spyOn(commands, "runWithTimeout").mockImplementation(() => {
            monotonic += native.mock.calls.length === 1 ? 100 : 50;
            return native.mock.calls.length === 1
                ? { status: 255, signal: null, pid: 0, output: [null, "", "Connection refused"], stdout: "", stderr: "Connection refused" }
                : { status: null, signal: "SIGTERM", pid: 0, output: [null, "PRIVATE-NATIVE-STDOUT", "PRIVATE-NATIVE-STDERR"],
                    stdout: "PRIVATE-NATIVE-STDOUT", stderr: "PRIVATE-NATIVE-STDERR", executable: "/PRIVATE-NATIVE-PATH", args: ["PRIVATE-NATIVE-ARG"],
                    error: Object.assign(new Error("PRIVATE-NATIVE-ERROR"), { code: "ETIMEDOUT", path: "/PRIVATE-NATIVE-ERROR-PATH", spawnargs: ["PRIVATE-NATIVE-ERROR-ARG"] }) };
        });
        const pacing = vi.spyOn(globalThis, "setTimeout");
        try {
            const pending = prepareMacosGuestHelper({ id: "expires-after-retry", ssh: { host: "192.0.2.4", user: "guest", password: "PRIVATE-PASSWORD" } }, 700);
            expect(native).toHaveBeenCalledTimes(1);
            monotonic = 600;
            await vi.advanceTimersByTimeAsync(500);
            expect(native).toHaveBeenCalledTimes(2);
            monotonic = 700;
            await vi.advanceTimersByTimeAsync(50);
            const result = await pending;
            expect(result).toMatchObject({ ok: false, skipped: false, error: "macos-helper-readiness-timeout",
                helper: { status: "failed", provisioning: { status: "failed", provider: "scp" } } });
            expect(result.execution).toEqual({ status: null, signal: "SIGTERM", timedOut: true });
            expect(native.mock.calls.map(call => [call[0], call[2]])).toEqual([["/owned/scp", 700], ["/owned/scp", 100]]);
            expect(pacing.mock.calls.map(call => call[1])).toEqual([500, 50]);
            expect(JSON.stringify(result)).not.toMatch(/PRIVATE-NATIVE|PRIVATE-PASSWORD/);
        } finally {
            pacing.mockRestore(); clock.mockRestore(); discovery.mockRestore(); native.mockRestore(); vi.useRealTimers();
            restoreEnvironment(); rmSync(home, { recursive: true, force: true });
        }
    });
});
