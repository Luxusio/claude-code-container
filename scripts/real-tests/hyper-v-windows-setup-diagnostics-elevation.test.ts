import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import { fileURLToPath, pathToFileURL } from "url";
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
    invokedAsEntrypoint,
    runPrivilegedSetupDiagnostics,
    validPrivilegedInput,
} from "./hyper-v-windows-setup-diagnostics-privileged.ts";
import { publishHyperVWindowsSetupDiagnostics } from "./hyper-v-windows-setup-diagnostics.ts";

const IDENTITY = {
    ownerId: "0123456789abcdef",
    deviceId: "windows-vm-real-e2e-123",
    incarnationId: "0123456789abcdef0123456789abcdef",
    vmId: "12345678-1234-4123-8123-123456789abc",
};

const LOGS = [{ path: "Windows\\Panther\\setuperr.log", lines: ["setup failed"] }];
const TRUSTED_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const elevationSource = readFileSync(join(repoRoot, "scripts", "real-tests", "hyper-v-windows-library-elevation.mjs"), "utf8");
const publishSource = readFileSync(join(repoRoot, "scripts", "real-tests", "hyper-v-windows-setup-diagnostics.ts"), "utf8");

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
    it("announces the Administrator request immediately before launching UAC", async () => {
        const writeOutput = vi.fn();
        const request = vi.fn(async (options: any) => {
            options.onBeforeElevation();
            return { status: 0, stdout: privilegedResultFrame({ ok: true, logs: LOGS }), stderr: "" };
        });
        const outcome = await requestElevatedSetupDiagnostics(IDENTITY, {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => TRUSTED_POWERSHELL,
            isAdministratorImpl: () => false,
            bundlePath: "bundle.mjs",
            statSyncImpl: () => ({ size: 32 }),
            readFileSyncImpl: () => Buffer.from("export const bundled = 1;\n"),
            nodePath: "C:\\node.exe",
            fileDigestImpl: async () => "a".repeat(64),
            requestAdministratorImpl: request,
            writeOutputImpl: writeOutput,
        });
        expect(outcome).toEqual({ attempted: true, result: { ok: true, logs: LOGS } });
        expect(writeOutput).toHaveBeenCalledOnce();
        expect(writeOutput).toHaveBeenCalledWith(
            "REQUEST Hyper-V Windows setup diagnostics administrator permission via UAC\n",
        );
        expect(request).toHaveBeenCalledOnce();
    });

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
            captureImpl: ((options: any) => { seen = options; return { ok: true, logs: LOGS }; }) as any,
        });
        expect(seen.powershell, "from GLOBALROOT\\SystemRoot, not from the parent").toBe(TRUSTED_POWERSHELL);
        // The elevated side writes nothing at all now: it calls the COLLECT half and hands the
        // payload back. Naming an output root would be the mechanism that caused the original
        // defect, kept alive and merely overridden — and a failed write there would have discarded
        // logs already paid for with a UAC prompt and a full stop/detach/mount cycle.
        expect(seen.outputRoot, "this side does not write, so it must not name a place to write").toBeUndefined();
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
            captureImpl: ((options: any) => { smuggled = options; return { ok: false, code: "hyper-v-setup-diagnostics-mount-failed" }; }) as any,
        });
        expect(smuggled.outputRoot, "an extra embedded field must not steer where an elevated process writes").toBeUndefined();
        expect(smuggled.spawnSyncImpl, "nor hand it something to run").toBeUndefined();
        expect(Object.keys(smuggled).sort()).toEqual(["deviceId", "incarnationId", "ownerId", "platform", "powershell", "vmId"]);
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

    // The one case where the operator paid for a prompt, approved, and the elevated read SUCCEEDED
    // was the case that could lose everything: on a failed publish the code was replaced outright,
    // with no `(elevation=…)` marker, so it rendered byte-identically to a build that never asked.
    // Every other branch in that function keeps both halves; this one did not.
    it("keeps the record when the elevated read succeeded but publishing failed", async () => {
        for (const code of ["hyper-v-setup-diagnostics-artifact-publish-failed", "hyper-v-setup-diagnostics-output-invalid"]) {
            const reason = await hyperVWindowsFailureReason(failureReasonInput({
                elevateSetupDiagnosticsImpl: async () => ({ attempted: true, result: { ok: true, logs: LOGS } }),
                publishSetupDiagnosticsImpl: (() => ({ ok: false, code })) as any,
            }));
            expect(reason).toContain(`${PRIVILEGE_CODE}(elevation=approved,published=${code})`);
        }
    });

    // Both of the comments that justify accepting this payload say the parent's re-validation means
    // a child that skipped redaction cannot get text past it. Measured, both halves were false:
    // redactLine's secret rule is `.*$` with no `m` flag, so one embedded newline let the secret
    // through verbatim; and nothing bounded line length before three regex passes, one of them lazy
    // and quadratic. 400 000 characters took 3.4 s with the event loop blocked, and returned ok.
    it("redacts and bounds the payload the elevated child hands back", () => {
        const out = mkdtempSync(join(tmpdir(), "ccc-elevated-publish-"));
        try {
            const multiline = publishHyperVWindowsSetupDiagnostics(
                [{ path: "Windows\\Panther\\setuperr.log", lines: ["password: hunter2-SECRET\nsecond line"] }],
                { outputRoot: join(out, "a") },
            );
            expect(multiline.ok).toBe(true);
            const line = multiline.ok === true ? multiline.logs[0].lines[0] : "";
            expect(line, "an embedded newline must not carry a secret past redaction").not.toContain("hunter2");
            expect(line).toContain("password=[redacted]");
            expect(line, "and the newline itself must not survive into a single-line reporter field").not.toContain("\n");
            // The RETURNED value being clean is not the property that matters — the artifact is what
            // an operator opens. Asserting only the return left "write raw `logs` to disk while
            // returning `validated`" alive, which is exactly "a child that skipped redaction got
            // text past the parent", the thing the decoder's shape-only check defers to this
            // function for. On the unelevated path the two are the same object; on the elevated
            // path `logs` is the child's unvalidated payload.
            const artifact = multiline.ok === true ? readFileSync(multiline.latestPath, "utf8") : "";
            expect(artifact, "the file is what the operator reads, and it must be redacted too").not.toContain("hunter2");
            expect(artifact).toContain("password=[redacted]");
            expect(multiline.ok === true ? multiline.timestampedPath : "", "both artifacts, not just latest")
                .toSatisfy((p: string) => existsSync(p));

            // Every character JavaScript's `.` refuses to match, not the two that happened to be
            // reported. The first fix collapsed [\r\n\t] and its comment named the mechanism
            // exactly — "`.` stops at a line terminator" — while missing that U+2028 and U+2029 ARE
            // line terminators to `.`, so the same defect with the same cause survived a commit
            // named for closing it. QA found them; enumerating the class is what stops the third
            // round. NEL, VT and FF are included as controls: `.` does match those, so they must
            // have been fine all along, and a test that cannot tell the two groups apart proves
            // less than it looks.
            const terminators = [0x0a, 0x0d, 0x2028, 0x2029];
            const matchedByDot = [0x0085, 0x0b, 0x0c, 0x09];
            for (const code of [...terminators, ...matchedByDot]) {
                const separated = publishHyperVWindowsSetupDiagnostics(
                    [{ path: "Windows\\Panther\\setuperr.log", lines: [`password: hunter2-SECRET${String.fromCharCode(code)}tail`] }],
                    { outputRoot: join(out, `sep-${code}`) },
                );
                const separatedLine = separated.ok === true ? separated.logs[0].lines[0] : "";
                expect(separatedLine, `U+${code.toString(16).padStart(4, "0")} must not carry a secret past redaction`).not.toContain("hunter2");
                expect(separatedLine).toContain("password=[redacted]");
            }
            // The property the loop rests on, asserted rather than assumed: these four really are
            // the characters `.` will not match. If a future runtime adds one, this fails here
            // instead of silently leaking.
            for (const code of terminators) {
                expect(/^a.b$/.test(`a${String.fromCharCode(code)}b`), `U+${code.toString(16)} is a line terminator for .`).toBe(false);
            }
            for (const code of matchedByDot) {
                expect(/^a.b$/.test(`a${String.fromCharCode(code)}b`), `U+${code.toString(16)} is matched by .`).toBe(true);
            }

            const started = Date.now();
            const huge = publishHyperVWindowsSetupDiagnostics(
                [{ path: "Windows\\Panther\\setuperr.log", lines: ["<Value>".repeat(60000)] }],
                { outputRoot: join(out, "b") },
            );
            const elapsed = Date.now() - started;
            expect(huge.ok).toBe(true);
            expect(huge.ok === true ? huge.logs[0].lines[0].length : -1, "bounded before the regex passes, not after").toBeLessThanOrEqual(768);
            expect(elapsed, "a long line must not make the lazy <Value> scan quadratic").toBeLessThan(1000);
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
    });

    // A publish that cannot write must SAY so. Swallowing the failure returns ok with
    // latestPath/timestampedPath naming files that were never created — the precise shape of the
    // original C:\results defect, relocated onto the new path. And the default output root is the
    // whole subject of that defect; every other test passes one explicitly, so nothing looked at it.
    it("fails loudly when it cannot write, and defaults to the repository results root", () => {
        const blocked = join(tmpdir(), `ccc-elevated-publish-blocked-${Date.now()}`);
        writeFileSync(blocked, "not a directory");
        try {
            const result = publishHyperVWindowsSetupDiagnostics(LOGS, { outputRoot: join(blocked, "nested") });
            expect(result).toEqual({ ok: false, code: "hyper-v-setup-diagnostics-artifact-publish-failed" });
        } finally {
            rmSync(blocked, { force: true });
        }
        expect(String(publishSource), "the default is the repository results root, not anywhere else")
            .toContain('options.outputRoot || join(repoRoot, "results", "device-lab-real")');
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

    // The two halves of AC-018a were asserted separately with nothing joining them: the library's
    // mapping text on one side, the reporter rendering a STUBBED outcome on the other. Deleting the
    // branch that carries requestAdministrator's errorCode through left the suite green, and every
    // declined UAC would have reported (elevation=elevation-child-result-invalid). That is the same
    // shape as the `elevation-declined` bug — a value produced by a stub and matched by a test —
    // one layer further out.
    it("carries the real elevation error code through to the reason line", async () => {
        const outcome = await requestElevatedSetupDiagnostics(IDENTITY, {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => TRUSTED_POWERSHELL,
            isAdministratorImpl: () => false,
            bundlePath: "bundle.mjs",
            statSyncImpl: () => ({ size: 32 }),
            readFileSyncImpl: () => Buffer.from("export const bundled = 1;\n"),
            nodePath: "C:\\node.exe",
            fileDigestImpl: async () => "a".repeat(64),
            requestAdministratorImpl: async () => ({ status: 1, stdout: "", errorCode: "elevation-cancelled" }),
        });
        expect(outcome).toEqual({ attempted: true, errorCode: "elevation-cancelled" });
        const reason = await hyperVWindowsFailureReason(failureReasonInput({
            elevateSetupDiagnosticsImpl: async () => outcome,
        }));
        expect(reason).toContain(`${PRIVILEGE_CODE}(elevation=elevation-cancelled)`);
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

        // The other direction, which was unpinned: this is a Windows-only program and
        // buildLevel3Artifacts is the SHARED entry, so an ungated build made every Linux Level 3 run
        // bundle it — and a failure there would fail runs that can never use it.
        const linuxSpawns: Array<{ args: string[] }> = [];
        const linuxStatus = buildLevel3Artifacts("/repo", {
            platform: "linux",
            spawn: (_command: string, args: string[]) => {
                linuxSpawns.push({ args });
                return { status: 0, stdout: "", stderr: "" };
            },
            readFile: (path: string) => (path.endsWith("contracts.js")
                ? `export const c = "${HYPER_V_LEVEL3_PROVIDER_CONTRACT}";`
                : '{"version":"1.0.0"}'),
            writeFile: () => undefined,
        });
        expect(linuxStatus, "and gating it must not fail the build it is gated out of").toBe(0);
        expect(linuxSpawns.some((call) => call.args.some((arg) => arg.includes("setup-diagnostics-privileged"))),
            "a Linux run must not bundle the Windows-only elevated child").toBe(false);
        expect(linuxSpawns.some((call) => call.args.some((arg) => arg.includes("device-lab-mcp"))),
            "but everything before the gate must still be built").toBe(true);
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

    // AC-020 names the realpath + pathToFileURL comparison specifically, and a raw string compare
    // survived because the function was not exported. Its failure mode is silent: on Windows a
    // casing or 8.3 short-name difference between argv[1] and the staged module yields no frame at
    // all, and the operator gets `elevation-child-result-invalid` after already approving.
    it("recognises its own entrypoint through realpath, not string equality", () => {
        const dir = mkdtempSync(join(tmpdir(), "ccc-entrypoint-"));
        try {
            const real = join(dir, "scenario.mjs");
            writeFileSync(real, "export const x = 1;\n");
            const url = pathToFileURL(real).href;
            expect(invokedAsEntrypoint(real, url), "the plain case must still match").toBe(true);
            expect(invokedAsEntrypoint(undefined, url)).toBe(false);
            expect(invokedAsEntrypoint(join(dir, "other.mjs"), url), "a different file is not the entrypoint").toBe(false);
            // The case a raw compare gets wrong: the same file reached by a path that is not
            // byte-identical. A symlink stands in for the Windows short-name and casing divergences
            // this container cannot reproduce; realpath resolves both, string equality resolves
            // neither.
            const link = join(dir, "link.mjs");
            symlinkSync(real, link);
            expect(invokedAsEntrypoint(link, url), "same file, different spelling, still the entrypoint").toBe(true);
            expect(link === fileURLToPath(url), "and a raw string compare would have said no").toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
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
