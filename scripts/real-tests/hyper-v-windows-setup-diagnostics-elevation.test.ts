import { createHash } from "crypto";
import { describe, expect, it, vi } from "vitest";
import { hyperVWindowsFailureReason } from "./hyper-v-windows-vm-e2e.ts";
import {
    decodePrivilegedResultFrame,
    privilegedProgramPrelude,
    requestElevatedSetupDiagnostics,
} from "./hyper-v-windows-setup-diagnostics-elevation.ts";
import {
    PRIVILEGED_RESULT_MARKER,
    privilegedResultFrame,
    runPrivilegedSetupDiagnostics,
    validPrivilegedInput,
} from "./hyper-v-windows-setup-diagnostics-privileged.ts";

const IDENTITY = {
    ownerId: "0123456789abcdef",
    deviceId: "windows-vm-real-e2e-123",
    incarnationId: "0123456789abcdef0123456789abcdef",
    vmId: "12345678-1234-4123-8123-123456789abc",
    powershell: "powershell.exe",
};

const PRIVILEGE_CODE = "hyper-v-setup-diagnostics-mount-privilege-required[elevate,p=code,a=1,c=NotSpecified,h=2146233088,m=denied]";

function failureReasonInput(overrides: Record<string, unknown> = {}) {
    return {
        profile: "windows-server",
        step: "start and wait for PowerShell Direct",
        error: new Error("hyper-v-guest-not-ready"),
        created: true,
        deviceId: IDENTITY.deviceId,
        incarnationId: IDENTITY.incarnationId,
        vmId: IDENTITY.vmId,
        ownerId: IDENTITY.ownerId,
        powershell: "powershell.exe",
        platform: "win32",
        captureImpl: (() => ({ ok: false, code: "hyper-v-console-wmi-method-failed" })) as any,
        setupDiagnosticsImpl: (() => ({ ok: false, code: PRIVILEGE_CODE })) as any,
        ...overrides,
    } as any;
}

describe("Windows Setup diagnostics elevation request", () => {
    // The privilege is requested for the one operation that needs it, at the moment it is missing.
    // The alternative this replaces was telling the operator to re-run: another build, another
    // two-minute boot, to arrive at the same failure with one more right.
    it("retries the diagnostic elevated and reports the recovered logs, not the privilege code", async () => {
        const elevate = vi.fn(async (_input: unknown, _dependencies?: unknown) => ({ attempted: true, result: { ok: true, latestRelativePath: "results/device-lab-real/setup-latest.json" } }));
        const reason = await hyperVWindowsFailureReason(failureReasonInput({ elevateSetupDiagnosticsImpl: elevate }));
        expect(elevate).toHaveBeenCalledOnce();
        expect(elevate.mock.calls[0][0], "the elevated child mounts THIS VM, so it gets the full identity").toEqual(IDENTITY);
        expect(reason).toContain("guestSetupDiagnostics=results/device-lab-real/setup-latest.json");
        expect(reason, "the recovered run replaces the privilege code entirely").not.toContain("mount-privilege-required");
        expect(reason, "and the failure being diagnosed still survives").toContain("hyper-v-guest-not-ready");
    });

    // Declining UAC is a legitimate answer and must not cost the operator the diagnosis they had.
    // The unelevated code is kept and the elevation outcome appended, so "we did not ask" and "we
    // asked and it failed" stay distinguishable — they call for different next steps.
    it("keeps the unelevated code and names why elevation did not land", async () => {
        const declined = await hyperVWindowsFailureReason(failureReasonInput({
            elevateSetupDiagnosticsImpl: async () => ({ attempted: true, errorCode: "elevation-declined" }),
        }));
        expect(declined).toContain(`${PRIVILEGE_CODE}(elevation=elevation-declined)`);
        const threw = await hyperVWindowsFailureReason(failureReasonInput({
            elevateSetupDiagnosticsImpl: async () => { throw new Error("pipe exploded"); },
        }));
        expect(threw, "a throw out of the elevation path must not lose the diagnosis either").toContain(`${PRIVILEGE_CODE}(elevation=elevation-request-failed)`);
    });

    // This is the state the plan previously recorded as an unfixed gap: elevated, and Windows still
    // names the privilege. The old code told that operator to elevate when they already had. Now
    // the reason says so, and no UAC dialog is raised to ask for a right already held.
    it("does not prompt when the run is already elevated, and says that is why", async () => {
        const reason = await hyperVWindowsFailureReason(failureReasonInput({
            elevateSetupDiagnosticsImpl: async () => ({ attempted: false, reason: "already-elevated" }),
        }));
        expect(reason).toContain(`${PRIVILEGE_CODE}(elevation=already-elevated)`);
    });

    // A transient mount failure is not a privilege problem, and a UAC dialog cannot fix one. Asking
    // anyway would spend the operator's attention on the wrong thing and train them to click through.
    it("never requests elevation for a failure elevation cannot fix", async () => {
        const elevate = vi.fn(async () => ({ attempted: true, errorCode: "must-not-happen" }));
        const reason = await hyperVWindowsFailureReason(failureReasonInput({
            setupDiagnosticsImpl: (() => ({ ok: false, code: "hyper-v-setup-diagnostics-mount-failed[a=10,c=ResourceBusy,h=2147024891]" })) as any,
            elevateSetupDiagnosticsImpl: elevate,
        }));
        expect(elevate).not.toHaveBeenCalled();
        expect(reason).toContain("mount-failed[a=10,c=ResourceBusy,h=2147024891]");
        const succeeded = vi.fn(async () => ({ attempted: true, errorCode: "must-not-happen" }));
        await hyperVWindowsFailureReason(failureReasonInput({
            setupDiagnosticsImpl: (() => ({ ok: true, latestRelativePath: "results/device-lab-real/ok.json" })) as any,
            elevateSetupDiagnosticsImpl: succeeded,
        }));
        expect(succeeded, "and certainly not when the diagnostic already worked").not.toHaveBeenCalled();
    });

    it("short-circuits before any prompt off Windows and when already elevated", async () => {
        const request = vi.fn(async () => ({ status: 0, stdout: "", stderr: "" }));
        expect(await requestElevatedSetupDiagnostics(IDENTITY, { platform: "linux", requestAdministratorImpl: request }))
            .toEqual({ attempted: false, reason: "not-windows" });
        expect(await requestElevatedSetupDiagnostics(IDENTITY, {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => "C:\\ps.exe",
            isAdministratorImpl: () => true,
            requestAdministratorImpl: request,
        })).toEqual({ attempted: false, reason: "already-elevated" });
        expect(await requestElevatedSetupDiagnostics(IDENTITY, {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => { throw new Error("no system root"); },
            requestAdministratorImpl: request,
        })).toEqual({ attempted: false, reason: "probe-failed" });
        expect(request, "no UAC dialog may be raised on any of these paths").not.toHaveBeenCalled();
    });

    // The identity is embedded in the digested program rather than passed as argv, so the VM the
    // elevated child mounts is covered by the same integrity check as the code that mounts it.
    // Losing that would let anything able to influence argv point a privileged Mount-VHD elsewhere.
    it("digests the embedded identity together with the program", async () => {
        let seen: any;
        const bundle = Buffer.from("export const bundled = 1;\n", "utf8");
        const outcome = await requestElevatedSetupDiagnostics(IDENTITY, {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => "C:\\ps.exe",
            isAdministratorImpl: () => false,
            bundlePath: "bundle.mjs",
            statSyncImpl: () => ({ size: bundle.length }),
            readFileSyncImpl: () => bundle,
            nodePath: "C:\\node.exe",
            fileDigestImpl: async () => "a".repeat(64),
            requestAdministratorImpl: async (options: any) => {
                seen = options;
                return { status: 0, stdout: privilegedResultFrame({ ok: true, latestRelativePath: "results/device-lab-real/x.json" }) };
            },
        });
        const program = seen.programBytes as Buffer;
        expect(program.subarray(0, privilegedProgramPrelude(IDENTITY).length).toString("utf8")).toBe(privilegedProgramPrelude(IDENTITY));
        expect(program.includes(bundle), "the bundle must be sent whole, not summarized").toBe(true);
        expect(seen.programDigest, "the digest must cover the identity, not just the code").toBe(createHash("sha256").update(program).digest("hex"));
        expect(createHash("sha256").update(bundle).digest("hex"), "so it cannot equal the bundle's own digest").not.toBe(seen.programDigest);
        expect(outcome).toEqual({ attempted: true, result: { ok: true, latestRelativePath: "results/device-lab-real/x.json" } });
    });

    // The child runs as Administrator and its stdout reaches an operator's terminal. Everything
    // crossing back is re-checked on this side of the boundary.
    it("refuses a result frame it cannot vouch for", async () => {
        expect(decodePrivilegedResultFrame(""), "silence is not success").toBeNull();
        expect(decodePrivilegedResultFrame(
            `${privilegedResultFrame({ ok: true, latestRelativePath: "results/a.json" })}${privilegedResultFrame({ ok: false, code: "x" })}`,
        ), "two frames means something else can imitate the marker; picking one lets it choose").toBeNull();
        expect(decodePrivilegedResultFrame(`${PRIVILEGED_RESULT_MARKER}not-base64!!\n`)).toBeNull();
        expect(decodePrivilegedResultFrame(privilegedResultFrame({ ok: true, latestRelativePath: "C:\\Users\\Someone\\secret.json" })),
            "an absolute host path is not a relative artifact path").toBeNull();
        expect(decodePrivilegedResultFrame(privilegedResultFrame({ ok: true, latestRelativePath: "../../etc/passwd" })),
            "and neither is a traversal").toBeNull();
        expect(decodePrivilegedResultFrame(privilegedResultFrame({ ok: false, code: "Bad Code With Spaces" }))).toBeNull();
        expect(decodePrivilegedResultFrame(privilegedResultFrame({ ok: "yes" }))).toBeNull();
        expect(decodePrivilegedResultFrame(privilegedResultFrame({ ok: false, code: "hyper-v-setup-diagnostics-mount-failed[a=1,c=ResourceBusy,h=1]" })))
            .toEqual({ ok: false, code: "hyper-v-setup-diagnostics-mount-failed[a=1,c=ResourceBusy,h=1]" });
    });

    // Re-validated on the elevated side even though the unelevated parent already validated. A
    // check that only ever ran on the weaker side of a privilege boundary is not a check.
    it("re-validates the embedded identity where the privilege actually is", () => {
        expect(validPrivilegedInput(IDENTITY)).toEqual(IDENTITY);
        for (const bad of [
            null,
            [IDENTITY],
            { ...IDENTITY, ownerId: "0123456789ABCDEF" },
            { ...IDENTITY, ownerId: "0123456789abcde" },
            { ...IDENTITY, deviceId: ".." },
            { ...IDENTITY, incarnationId: "short" },
            { ...IDENTITY, vmId: "12345678-1234-4123-8123-123456789ab" },
            { ...IDENTITY, vmId: "" },
            { ...IDENTITY, powershell: "" },
            { ...IDENTITY, powershell: "x".repeat(513) },
            { ...IDENTITY, ownerId: 1 },
        ]) {
            expect(validPrivilegedInput(bad), `${JSON.stringify(bad)} must not reach an elevated Mount-VHD`).toBeNull();
        }
    });

    it("emits exactly one frame and withholds the absolute paths the parent does not need", () => {
        const ok = runPrivilegedSetupDiagnostics(IDENTITY, (() => ({
            ok: true,
            latestRelativePath: "results/device-lab-real/setup-latest.json",
            latestPath: "C:\\Users\\Someone\\results\\setup-latest.json",
            timestampedPath: "C:\\Users\\Someone\\results\\setup-2026.json",
        })) as any);
        expect(ok.status).toBe(0);
        expect(ok.frame.match(new RegExp(PRIVILEGED_RESULT_MARKER, "g"))).toHaveLength(1);
        const decoded = JSON.parse(Buffer.from(ok.frame.slice(PRIVILEGED_RESULT_MARKER.length).trim(), "base64").toString("utf8"));
        expect(decoded).toEqual({ ok: true, latestRelativePath: "results/device-lab-real/setup-latest.json" });
        expect(ok.frame, "an elevated child should not put host paths on the operator's terminal").not.toContain("Users");

        const failed = runPrivilegedSetupDiagnostics(IDENTITY, (() => ({ ok: false, code: "hyper-v-setup-diagnostics-mount-failed[a=1,c=ResourceBusy,h=1]" })) as any);
        expect(failed.status).toBe(1);
        expect(decodePrivilegedResultFrame(failed.frame)).toEqual({ ok: false, code: "hyper-v-setup-diagnostics-mount-failed[a=1,c=ResourceBusy,h=1]" });

        const threw = runPrivilegedSetupDiagnostics(IDENTITY, (() => { throw new Error("C:\\Users\\Someone\\leak"); }) as any);
        expect(threw.status).toBe(1);
        expect(decodePrivilegedResultFrame(threw.frame), "a throw must still be one frame, and must not carry the message")
            .toEqual({ ok: false, code: "hyper-v-setup-diagnostics-unexpected-failure" });
        expect(threw.frame).not.toContain("Users");

        expect(decodePrivilegedResultFrame(runPrivilegedSetupDiagnostics({ ...IDENTITY, vmId: "nope" }).frame))
            .toEqual({ ok: false, code: "hyper-v-setup-diagnostics-privileged-input-invalid" });
    });
});
