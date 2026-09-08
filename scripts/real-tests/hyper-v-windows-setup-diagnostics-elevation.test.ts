import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join, sep } from "path";
import { describe, expect, it, vi } from "vitest";
import { repoRoot } from "./helpers.ts";
import { buildLevel3Artifacts, HYPER_V_LEVEL3_PROVIDER_CONTRACT } from "./support/level3-host.ts";
import { hyperVWindowsFailureReason } from "./hyper-v-windows-vm-e2e.ts";
import {
    decodePrivilegedResultFrame,
    privilegedProgramPrelude,
    PRIVILEGED_BUNDLE_RELATIVE_PATH,
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
};

const LOGS = [{ path: "Windows\\Panther\\setuperr.log", lines: ["setup failed"] }];
const TRUSTED_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const elevationSource = readFileSync(join(repoRoot, "scripts", "real-tests", "hyper-v-windows-library-elevation.mjs"), "utf8");

// Reachable on an unelevated host for ANY mount failure, transient category included: $MountElevated
// is loop-invariant so the producer breaks at attempt 1 and emits the privilege code with whatever
// category it saw. This is the shape an unelevated operator actually meets.
const PRIVILEGE_CODE_UNELEVATED = "hyper-v-setup-diagnostics-mount-privilege-required[elevate,p=unelevated,a=1,c=ResourceBusy,h=2147024891,m=busy]";
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
        // Present on the parent, deliberately NOT forwarded. Its value comes from `where
        // powershell.exe` on the invoking user's PATH.
        powershell: "C:\\Users\\Someone\\Downloads\\powershell.exe",
        platform: "win32",
        captureImpl: (() => ({ ok: false, code: "hyper-v-console-wmi-method-failed" })) as any,
        setupDiagnosticsImpl: (() => ({ ok: false, code: PRIVILEGE_CODE })) as any,
        publishSetupDiagnosticsImpl: ((logs: unknown) => ({
            ok: true,
            latestRelativePath: "results/device-lab-real/hyper-v-windows-setup-diagnostics-latest.json",
            latestPath: "/repo/results/device-lab-real/hyper-v-windows-setup-diagnostics-latest.json",
            timestampedPath: "/repo/results/device-lab-real/hyper-v-windows-setup-diagnostics-2026.json",
            logs,
        })) as any,
        ...overrides,
    } as any;
}

describe("Windows Setup diagnostics elevation request", () => {
    it("retries elevated and publishes the recovered logs from the unelevated side", async () => {
        const elevate = vi.fn(async (_input: unknown, _dependencies?: unknown) => ({ attempted: true, result: { ok: true, logs: LOGS } }));
        const publish = vi.fn((logs: unknown) => ({ ok: true, latestRelativePath: "results/device-lab-real/setup-latest.json", latestPath: "/repo/x", timestampedPath: "/repo/y", logs }));
        const reason = await hyperVWindowsFailureReason(failureReasonInput({ elevateSetupDiagnosticsImpl: elevate, publishSetupDiagnosticsImpl: publish }));
        expect(elevate).toHaveBeenCalledOnce();
        expect(reason).toContain("guestSetupDiagnostics=results/device-lab-real/setup-latest.json");
        expect(reason, "the recovered run replaces the privilege code entirely").not.toContain("mount-privilege-required");
        expect(reason, "and the failure being diagnosed still survives").toContain("hyper-v-guest-not-ready");
        // The artifacts are written by the UNELEVATED parent. When the elevated child published
        // them itself, its repoRoot came from import.meta.url under the elevation staging
        // directory, which is two levels below the drive root: the logs went to C:\results and the
        // operator was handed a repo-relative path pointing at nothing.
        expect(publish, "the parent writes the artifacts, under a root only it knows").toHaveBeenCalledWith(LOGS);
    });

    // The path this side sends would be an executable an unelevated user can choose: it comes from
    // `where powershell.exe` against the invoking user's PATH, and `where` searches the current
    // directory first. Handing it to a process running as Administrator is the escalation. The
    // digest does not help — it faithfully carries whatever this side picked.
    it("never sends a PowerShell path to the elevated child", async () => {
        const elevate = vi.fn(async (_input: unknown, _dependencies?: unknown) => ({ attempted: true, result: { ok: true, logs: LOGS } }));
        await hyperVWindowsFailureReason(failureReasonInput({ elevateSetupDiagnosticsImpl: elevate }));
        const sent = elevate.mock.calls[0][0] as Record<string, unknown>;
        expect(sent).toEqual(IDENTITY);
        expect(Object.keys(sent), "an extra key here is a new thing crossing a privilege boundary").toEqual(["ownerId", "deviceId", "incarnationId", "vmId"]);
        expect(JSON.stringify(sent)).not.toContain("powershell");
        // The dependency bag was never asserted, so dropping it entirely survived. It carries the
        // platform, and without it the requester falls back to process.platform — which on a Linux
        // CI box happens to be harmless and on a Windows one is the difference between honouring an
        // injected platform and not.
        expect(elevate.mock.calls[0][1], "the platform must reach the requester, not be re-derived").toEqual({ platform: "win32" });
    });

    it("resolves its own trusted PowerShell inside the elevated child", () => {
        let seen: any;
        const out = runPrivilegedSetupDiagnostics(IDENTITY, {
            resolvePowerShellImpl: (() => TRUSTED_POWERSHELL) as any,
            collectRoot: "C:\\ProgramData\\ccc-staging\\collect",
            captureImpl: ((options: any) => { seen = options; return { ok: true, latestRelativePath: "x", latestPath: "y", timestampedPath: "z", logs: LOGS }; }) as any,
        });
        expect(seen.powershell, "from GLOBALROOT\\SystemRoot, not from the parent").toBe(TRUSTED_POWERSHELL);
        // Inside the staging root the elevation library created: protected DACL, SYSTEM and
        // Administrators only, reparse points refused. Anywhere else and an unelevated user can
        // pre-create or junction the target and steer an Administrator write.
        expect(seen.outputRoot).toBe("C:\\ProgramData\\ccc-staging\\collect");
        expect(seen.platform, "the elevated child only ever runs on Windows and must not infer it").toBe("win32");
        expect(decodePrivilegedResultFrame(out.frame), "and no path crosses back").toEqual({ ok: true, logs: LOGS });
        // The WHITELISTED object has to be what reaches the capture, not the raw embedded one.
        // Passing the raw object through still validated, and still returned the right answer, so
        // nothing caught it — but HyperVWindowsSetupDiagnosticsInput accepts `outputRoot`, and the
        // whole point of validPrivilegedInput returning a rebuilt object is that an extra field
        // cannot ride along into an elevated Mount-VHD.
        let smuggled: any;
        runPrivilegedSetupDiagnostics({ ...IDENTITY, outputRoot: "C:\\", spawnSyncImpl: "x" }, {
            resolvePowerShellImpl: (() => TRUSTED_POWERSHELL) as any,
            collectRoot: "C:\\ProgramData\\ccc-staging\\collect",
            captureImpl: ((options: any) => { smuggled = options; return { ok: false, code: "hyper-v-setup-diagnostics-mount-failed" }; }) as any,
        });
        expect(smuggled.outputRoot, "an extra embedded field must not steer where an elevated process writes").toBe("C:\\ProgramData\\ccc-staging\\collect");
        expect(smuggled.spawnSyncImpl, "nor hand it something to run").toBeUndefined();
        expect(Object.keys(smuggled).sort()).toEqual(["deviceId", "incarnationId", "outputRoot", "ownerId", "platform", "powershell", "vmId"]);
        const unresolved = runPrivilegedSetupDiagnostics(IDENTITY, {
            resolvePowerShellImpl: (() => { throw new Error("no system root"); }) as any,
        });
        expect(decodePrivilegedResultFrame(unresolved.frame)).toEqual({ ok: false, code: "hyper-v-setup-diagnostics-powershell-unavailable" });
    });

    // Declining UAC is a legitimate answer and must not cost the operator the diagnosis they had.
    //
    // `elevation-cancelled` is the REAL code — a UAC decline surfaces as Win32 1223, which the
    // elevation library maps to CANCELLED. An earlier version of this test and of the durable doc
    // both said `elevation-declined`, which exists nowhere in the repository: a stub produced the
    // invented value, the assertion matched it, and the doc told an operator to grep for a string
    // that can never appear. So the value is taken from the library rather than typed here.
    it("keeps the unelevated code and names why elevation did not land", async () => {
        expect(String(elevationSource), "the decline mapping this test depends on").toContain('return { errorCode: "elevation-cancelled" }');
        for (const [outcome, suffix] of [
            [{ attempted: true, errorCode: "elevation-cancelled" }, "elevation-cancelled"],
            [{ attempted: false, reason: "already-elevated" }, "already-elevated"],
            [{ attempted: false, reason: "identity-invalid" }, "identity-invalid"],
            [{ attempted: false, reason: "bundle-missing" }, "bundle-missing"],
            [{ attempted: false, reason: "probe-failed" }, "probe-failed"],
        ] as const) {
            const reason = await hyperVWindowsFailureReason(failureReasonInput({ elevateSetupDiagnosticsImpl: async () => outcome }));
            expect(reason).toContain(`${PRIVILEGE_CODE}(elevation=${suffix})`);
        }
        const threw = await hyperVWindowsFailureReason(failureReasonInput({
            elevateSetupDiagnosticsImpl: async () => { throw new Error("pipe exploded"); },
        }));
        expect(threw, "a throw out of the elevation path must not lose the diagnosis either").toContain(`${PRIVILEGE_CODE}(elevation=elevation-request-failed)`);
    });

    // The state the whole "asserted, not measured" question turns on: the operator approved, the
    // diagnostic ran with full rights, and Windows refused anyway. Replacing the code outright made
    // that render byte-identically to a build that never asked — so the report could not tell the
    // two apart, and the run that was supposed to settle the premise settled nothing.
    it("marks an elevated run that still failed, and keeps the original code beside it", async () => {
        const reason = await hyperVWindowsFailureReason(failureReasonInput({
            elevateSetupDiagnosticsImpl: async () => ({ attempted: true, result: { ok: false, code: PRIVILEGE_CODE } }),
        }));
        expect(reason).toContain(`${PRIVILEGE_CODE}(elevation=approved,still=hyper-v-setup-diagnostics-mount-privilege-required)`);
        // Name only. The elevated failure can be another full privilege bracket, and nesting one
        // bracket inside another spends the reporter budget on a field nobody parses.
        expect(reason.match(/m=denied/g), "the elevated bracket's body must not be pasted in too").toHaveLength(1);
        const rejected = await hyperVWindowsFailureReason(failureReasonInput({
            elevateSetupDiagnosticsImpl: async () => ({ attempted: true, result: { ok: false, code: "hyper-v-setup-diagnostics-privileged-input-invalid" } }),
        }));
        expect(rejected, "a child that rejects its own input must not cost the operator the mount diagnosis")
            .toContain(`${PRIVILEGE_CODE}(elevation=approved,still=hyper-v-setup-diagnostics-privileged-input-invalid)`);
    });

    // A prompt is requested for the privilege code, INCLUDING p=unelevated with a transient
    // category. On an unelevated host Mount-VHD cannot succeed whatever else is also true, so
    // elevation is a genuine prerequisite there and this is the shape most operators will meet.
    // An earlier AC claimed "a transient failure never raises a dialog", which was false: the
    // fixture that appeared to pin it fed mount-failed[c=ResourceBusy], reachable only when already
    // elevated, where the requester short-circuits anyway. Unreachable by construction.
    it("requests elevation for p=unelevated with a transient category, which is reachable", async () => {
        const elevate = vi.fn(async (_input: unknown, _dependencies?: unknown) => ({ attempted: true, result: { ok: true, logs: LOGS } }));
        const reason = await hyperVWindowsFailureReason(failureReasonInput({
            setupDiagnosticsImpl: (() => ({ ok: false, code: PRIVILEGE_CODE_UNELEVATED })) as any,
            elevateSetupDiagnosticsImpl: elevate,
        }));
        expect(elevate).toHaveBeenCalledOnce();
        expect(reason).toContain("guestSetupDiagnostics=results/device-lab-real/hyper-v-windows-setup-diagnostics-latest.json");
    });

    it("never requests elevation for a code elevation cannot fix", async () => {
        const elevate = vi.fn(async () => ({ attempted: true, errorCode: "must-not-happen" }));
        // mount-failed without the privilege prefix: an elevated host's genuinely transient failure.
        await hyperVWindowsFailureReason(failureReasonInput({
            setupDiagnosticsImpl: (() => ({ ok: false, code: "hyper-v-setup-diagnostics-mount-failed[a=10,c=ResourceBusy,h=2147024891]" })) as any,
            elevateSetupDiagnosticsImpl: elevate,
        }));
        await hyperVWindowsFailureReason(failureReasonInput({
            setupDiagnosticsImpl: (() => ({ ok: false, code: "hyper-v-setup-diagnostics-cleanup-failed" })) as any,
            elevateSetupDiagnosticsImpl: elevate,
        }));
        await hyperVWindowsFailureReason(failureReasonInput({
            setupDiagnosticsImpl: (() => ({ ok: true, latestRelativePath: "results/device-lab-real/ok.json", latestPath: "a", timestampedPath: "b", logs: LOGS })) as any,
            elevateSetupDiagnosticsImpl: elevate,
        }));
        expect(elevate, "no dialog for a transient failure, a cleanup failure, or a success").not.toHaveBeenCalled();
    });

    it("short-circuits before any prompt off Windows, when already elevated, and on a bad identity", async () => {
        const request = vi.fn(async () => ({ status: 0, stdout: "", stderr: "" }));
        const win32 = { platform: "win32", resolveTrustedWindowsPowerShellImpl: () => TRUSTED_POWERSHELL, requestAdministratorImpl: request };
        expect(await requestElevatedSetupDiagnostics(IDENTITY, { platform: "linux", requestAdministratorImpl: request }))
            .toEqual({ attempted: false, reason: "not-windows" });
        expect(await requestElevatedSetupDiagnostics({ ...IDENTITY, vmId: "nope" }, win32))
            .toEqual({ attempted: false, reason: "identity-invalid" });
        expect(await requestElevatedSetupDiagnostics(IDENTITY, { ...win32, isAdministratorImpl: () => true }))
            .toEqual({ attempted: false, reason: "already-elevated" });
        expect(await requestElevatedSetupDiagnostics(IDENTITY, {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => { throw new Error("no system root"); },
            requestAdministratorImpl: request,
        })).toEqual({ attempted: false, reason: "probe-failed" });
        expect(request, "no UAC dialog may be raised on any of these paths").not.toHaveBeenCalled();
    });

    it("digests the embedded identity together with the program", async () => {
        let seen: any;
        const bundle = Buffer.from("export const bundled = 1;\n", "utf8");
        const outcome = await requestElevatedSetupDiagnostics(IDENTITY, {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => TRUSTED_POWERSHELL,
            isAdministratorImpl: () => false,
            bundlePath: "bundle.mjs",
            statSyncImpl: () => ({ size: bundle.length }),
            readFileSyncImpl: () => bundle,
            nodePath: "C:\\node.exe",
            fileDigestImpl: async () => "a".repeat(64),
            requestAdministratorImpl: async (options: any) => {
                seen = options;
                return { status: 0, stdout: privilegedResultFrame({ ok: true, logs: LOGS }) };
            },
        });
        const program = seen.programBytes as Buffer;
        expect(program.subarray(0, privilegedProgramPrelude(IDENTITY).length).toString("utf8")).toBe(privilegedProgramPrelude(IDENTITY));
        expect(program.includes(bundle), "the bundle must be sent whole, not summarized").toBe(true);
        expect(seen.programDigest, "the digest must cover the identity, not just the code").toBe(createHash("sha256").update(program).digest("hex"));
        expect(createHash("sha256").update(bundle).digest("hex"), "so it cannot equal the bundle's own digest").not.toBe(seen.programDigest);
        expect(seen.powerShellPath, "the LAUNCHER is the trusted one; the child resolves its own separately").toBe(TRUSTED_POWERSHELL);
        expect(outcome).toEqual({ attempted: true, result: { ok: true, logs: LOGS } });
    });

    it("refuses a result frame it cannot vouch for", async () => {
        expect(decodePrivilegedResultFrame(""), "silence is not success").toBeNull();
        expect(decodePrivilegedResultFrame(
            `${privilegedResultFrame({ ok: true, logs: LOGS })}${privilegedResultFrame({ ok: false, code: "x" })}`,
        ), "two frames means something else can imitate the marker; picking one lets it choose").toBeNull();
        expect(decodePrivilegedResultFrame(`${PRIVILEGED_RESULT_MARKER}not-base64!!\n`)).toBeNull();
        // The base64 SHAPE check, which that case does not exercise — `not-base64!!` is rejected by
        // the JSON parse, not by the regex, so deleting the regex left it green. Node's decoder is
        // lenient and silently skips characters outside the alphabet, so a valid payload with junk
        // spliced in still decodes. Without the shape check this side accepts a frame whose bytes
        // are not the bytes the child sent.
        const clean = privilegedResultFrame({ ok: true, logs: LOGS }).slice(PRIVILEGED_RESULT_MARKER.length).trim();
        const spliced = `${clean.slice(0, 8)}!! \t${clean.slice(8)}`;
        expect(JSON.parse(Buffer.from(spliced, "base64").toString("utf8")).ok,
            "the fixture must be one the lenient decoder still accepts, or it proves nothing").toBe(true);
        expect(decodePrivilegedResultFrame(`${PRIVILEGED_RESULT_MARKER}${spliced}\n`)).toBeNull();
        expect(decodePrivilegedResultFrame(privilegedResultFrame({ ok: true, logs: "not-an-array" }))).toBeNull();
        expect(decodePrivilegedResultFrame(privilegedResultFrame({ ok: false, code: "Bad Code With Spaces" }))).toBeNull();
        expect(decodePrivilegedResultFrame(privilegedResultFrame({ ok: "yes" }))).toBeNull();
        // This string is printed to an operator's terminal by way of an Administrator process. The
        // bracket body used to exclude only `]` and newline, which let ESC, CR, BEL and bidi
        // overrides through — the path field on this same boundary had an allowlist and this did not.
        for (const hostile of ["\u001b[2J", "\u0007", "\r", "\b", "\u202e", "\u0000"]) {
            expect(decodePrivilegedResultFrame(privilegedResultFrame({ ok: false, code: `hyper-v-setup-diagnostics-mount-failed[a=1,m=${hostile}]` })),
                `control character ${JSON.stringify(hostile)} must not reach the terminal`).toBeNull();
        }
        expect(decodePrivilegedResultFrame(privilegedResultFrame({ ok: false, code: "hyper-v-setup-diagnostics-mount-failed[a=1,c=ResourceBusy,h=1]" })))
            .toEqual({ ok: false, code: "hyper-v-setup-diagnostics-mount-failed[a=1,c=ResourceBusy,h=1]" });
    });

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
            { ...IDENTITY, ownerId: 1 },
        ]) {
            expect(validPrivilegedInput(bad), `${JSON.stringify(bad)} must not reach an elevated Mount-VHD`).toBeNull();
        }
        // An extra key is dropped rather than forwarded — notably a powershell path, which is the
        // field this boundary stopped carrying.
        expect(validPrivilegedInput({ ...IDENTITY, powershell: "C:\\Users\\Someone\\evil.exe" })).toEqual(IDENTITY);
    });

    // Nothing pinned the build at all: deleting the whole privileged-bundle block from
    // buildLevel3Artifacts left the suite green, and on a real host that degrades the feature to
    // (elevation=bundle-missing) after the guest has already failed. The outfile and
    // PRIVILEGED_BUNDLE_RELATIVE_PATH were also two independent literals with nothing tying them
    // together — the same "invisible to tsc, surfaces first on Windows CI" shape this task already
    // records against the PowerShell parse gate.
    it("builds the privileged bundle where the requester will look for it", () => {
        const spawns: Array<{ args: string[] }> = [];
        buildLevel3Artifacts("/repo", {
            platform: "win32",
            spawn: (_command: string, args: string[]) => {
                spawns.push({ args });
                return { status: 0, stdout: "", stderr: "" };
            },
            readFile: (path: string) => (path.endsWith("contracts.js")
                ? `export const c = "${HYPER_V_LEVEL3_PROVIDER_CONTRACT}";`
                : '{"version":"1.0.0"}'),
            writeFile: () => undefined,
        });
        const bundling = spawns.find((call) => call.args.some((arg) => arg.includes("hyper-v-windows-setup-diagnostics-privileged.ts")));
        expect(bundling, "the elevated child has to exist before a guest fails, not be built inside a failing diagnostic").toBeDefined();
        const outfile = (bundling?.args || []).find((arg) => arg.startsWith("--outfile="))?.slice("--outfile=".length);
        expect(outfile, "the builder's outfile and the requester's lookup path must be the same file")
            .toBe(PRIVILEGED_BUNDLE_RELATIVE_PATH.split(sep).join("/"));
    });

    it("bounds the bundle it is willing to digest, and the frame it is willing to decode", async () => {
        const request = vi.fn(async () => ({ status: 0, stdout: "" }));
        const win32 = {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => TRUSTED_POWERSHELL,
            isAdministratorImpl: () => false,
            bundlePath: "bundle.mjs",
            readFileSyncImpl: () => Buffer.from("x"),
            requestAdministratorImpl: request,
        };
        for (const size of [0, -1, 9 * 1024 * 1024, Number.NaN]) {
            expect(await requestElevatedSetupDiagnostics(IDENTITY, { ...win32, statSyncImpl: () => ({ size }) }),
                `a bundle reported as ${size} bytes is not something to hand an elevated process`)
                .toEqual({ attempted: false, reason: "bundle-missing" });
        }
        expect(await requestElevatedSetupDiagnostics(IDENTITY, { ...win32, statSyncImpl: () => { throw new Error("ENOENT"); } }))
            .toEqual({ attempted: false, reason: "bundle-missing" });
        expect(request, "none of these may reach a UAC prompt").not.toHaveBeenCalled();
        // The frame cap. It has to be exercised with a payload that would otherwise DECODE — my
        // first attempt used 3 MiB of "A", which is valid base64 but not valid JSON, so the parse
        // threw and the test passed with the cap deleted. The cap is what stops an elevated child
        // from making this side base64-decode and JSON-parse an arbitrary amount.
        const oversized = privilegedResultFrame({ ok: true, logs: [{ path: "Windows\\Panther\\setupact.log", lines: ["x".repeat(2 * 1024 * 1024)] }] });
        expect(oversized.length, "the fixture has to actually exceed the cap or it proves nothing").toBeGreaterThan(2 * 1024 * 1024);
        expect(JSON.parse(Buffer.from(oversized.slice(PRIVILEGED_RESULT_MARKER.length).trim(), "base64").toString("utf8")).ok,
            "and it has to be a frame that would otherwise decode").toBe(true);
        expect(decodePrivilegedResultFrame(oversized)).toBeNull();
    });

    it("emits exactly one frame and no host paths", () => {
        const ok = runPrivilegedSetupDiagnostics(IDENTITY, {
            resolvePowerShellImpl: (() => TRUSTED_POWERSHELL) as any,
            captureImpl: (() => ({
                ok: true,
                latestRelativePath: "results/device-lab-real/setup-latest.json",
                latestPath: "C:\\ProgramData\\ccc-staging\\collect\\setup-latest.json",
                timestampedPath: "C:\\ProgramData\\ccc-staging\\collect\\setup-2026.json",
                logs: LOGS,
            })) as any,
        });
        expect(ok.status).toBe(0);
        expect(ok.frame.match(new RegExp(PRIVILEGED_RESULT_MARKER, "g"))).toHaveLength(1);
        expect(JSON.parse(Buffer.from(ok.frame.slice(PRIVILEGED_RESULT_MARKER.length).trim(), "base64").toString("utf8")))
            .toEqual({ ok: true, logs: LOGS });
        expect(ok.frame, "the staging paths are the child's business, not the operator's").not.toContain("ProgramData");

        const threw = runPrivilegedSetupDiagnostics(IDENTITY, {
            resolvePowerShellImpl: (() => TRUSTED_POWERSHELL) as any,
            captureImpl: (() => { throw new Error("C:\\Users\\Someone\\leak"); }) as any,
        });
        expect(threw.status).toBe(1);
        expect(decodePrivilegedResultFrame(threw.frame), "a throw must still be one frame, and must not carry the message")
            .toEqual({ ok: false, code: "hyper-v-setup-diagnostics-unexpected-failure" });
        expect(threw.frame).not.toContain("Users");

        expect(decodePrivilegedResultFrame(runPrivilegedSetupDiagnostics({ ...IDENTITY, vmId: "nope" }).frame))
            .toEqual({ ok: false, code: "hyper-v-setup-diagnostics-privileged-input-invalid" });
    });
});
