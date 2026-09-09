import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deflateSync } from "zlib";
import { describe, expect, it } from "vitest";
import { compactMessage } from "./compact-message.ts";
import { captureHyperVWindowsConsole, HYPER_V_WINDOWS_CONSOLE_CAPTURE_DIMENSIONS } from "./hyper-v-windows-console-capture.ts";
import { captureHyperVWindowsSetupDiagnostics, MOUNT_MESSAGE_MAX_CHARS, SETUP_DIAGNOSTICS_SAFE_CODES } from "./hyper-v-windows-setup-diagnostics.ts";

const IDENTITY = {
    ownerId: "0123456789abcdef",
    deviceId: "windows-vm-real-e2e-123",
    incarnationId: "0123456789abcdef0123456789abcdef",
};

function pngFixture(width = 640, height = 480): Buffer {
    function crc32(input: Buffer): number {
        let crc = 0xffffffff;
        for (const byte of input) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
        return (crc ^ 0xffffffff) >>> 0;
    }
    function chunk(type: string, data: Buffer): Buffer {
        const typeBytes = Buffer.from(type, "ascii");
        const header = Buffer.alloc(8);
        header.writeUInt32BE(data.length, 0);
        typeBytes.copy(header, 4);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
        return Buffer.concat([header, data, checksum]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const rows = Buffer.alloc((width * 3 + 1) * height);
    for (let row = 0; row < height; row++) rows[row * (width * 3 + 1)] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function successRunner(png = pngFixture()) {
    return () => ({
        status: 0,
        stdout: JSON.stringify({ ok: true, pngBase64: png.toString("base64") }),
        stderr: "",
    });
}

describe("captureHyperVWindowsConsole", () => {
    it("builds a bounded exact-identity WMI program with sync/async and stride guards", () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-windows-console-command-"));
        let invocation: any;
        try {
            const result = captureHyperVWindowsConsole({
                ...IDENTITY,
                powershell: "powershell.exe",
                platform: "win32",
                outputRoot,
                now: () => new Date("2026-08-28T01:02:03.004Z"),
                spawnSyncImpl: (command, args, options) => {
                    invocation = { command, args, options };
                    return successRunner()();
                },
            });
            expect(result.ok).toBe(true);
            expect(invocation.command).toBe("powershell.exe");
            expect(invocation.args.slice(0, 6)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
            expect(invocation.options).toMatchObject({ encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
            const program = Buffer.from(invocation.args[6], "base64").toString("utf16le");
            expect(program).toContain("$VmName = 'ccc-0123456789abcdef-windows-vm-real-e2e-123-0123456789abcdef0123456789abcdef'");
            expect(program).toContain("WHERE ElementName = '$VmName'");
            expect(program).toContain("if ($Vms.Count -ne 1)");
            expect(program).toContain("VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized'");
            expect(program).toContain("if ($Settings.Count -ne 1)");
            expect(program).toContain("GetVirtualSystemThumbnailImage");
            expect(program).toContain("$ReturnValue -eq 4096");
            expect(program).toContain("elseif ($ReturnValue -ne 0)");
            expect(program).toContain("if ($JobState -eq 7)");
            expect(program).toContain("$JobState -in @(8,9,10)");
            expect(program).toContain("AddSeconds(10)");
            expect(program).toContain("hyper-v-console-wmi-job-timeout");
            expect(program).toContain("$Job['ErrorCode']");
            expect(program).toContain("$Output.Properties['ImageData']");
            expect(program).toContain("$ImageValue = $null");
            expect(program).toContain("if ($null -ne $ImageProperty) {");
            expect(program).toContain("$ImageValue = $ImageProperty.Value");
            expect(program).toContain("$ImageValue -isnot [byte[]]");
            expect(program).toContain("[byte[]]$Raw = $ImageValue");
            expect(program).toContain("$Completion = 'async'");
            expect(program).toContain("$RgbStage = 'byte-count'");
            expect(program).toContain("$RgbStage = 'bitmap-stride'");
            expect(program).toContain("$CompatibilitySurplusBytes = 4");
            expect(program).toContain("$ExpectedBytes = $RowBytes * $Height");
            expect(program).toContain("$Raw.Length -ne $ExpectedBytes -and $Raw.Length -ne ($ExpectedBytes + $CompatibilitySurplusBytes)");
            expect(program).toContain("$Failure['layout'] = $Layout");
            expect(program).toContain("ConvertTo-Json -Compress -Depth 3");
            expect(program).not.toContain("$ImageValue = if (");
            expect(program).not.toContain("[byte[]]$ImageValue");
            expect(program).not.toContain("[byte[]]$Raw = @($Output['ImageData'])");
            const extractionOrder = [
                "$ImageProperty = $Output.Properties['ImageData']",
                "$ImageValue = $null",
                "if ($null -ne $ImageProperty) {",
                "$ImageValue = $ImageProperty.Value",
                "if ($null -eq $ImageValue)",
                "if ($ImageValue -isnot [byte[]])",
                "[byte[]]$Raw = $ImageValue",
            ].map((needle) => program.indexOf(needle));
            expect(extractionOrder.every((position) => position >= 0)).toBe(true);
            expect(extractionOrder).toEqual([...extractionOrder].sort((a, b) => a - b));
            expect(program).not.toContain("$Raw.Length -ge $ExpectedBytes");
            expect(program).not.toContain("$Raw.Length -gt $ExpectedBytes");
            expect(program).not.toContain("[Runtime.InteropServices.Marshal]::Copy($Raw, 4,");
            expect(program).toContain("[Runtime.InteropServices.Marshal]::Copy($Raw, $Row * $RowBytes, $Destination, $RowBytes)");
            expect(program).toContain("$Row * [int]$BitmapData.Stride");
            expect(program).toContain("$Bitmap.UnlockBits($BitmapData)");
            expect(program).toContain("$Stream.Dispose()");
            expect(program).toContain("$Bitmap.Dispose()");
            expect(program).not.toContain(outputRoot);
        } finally {
            rmSync(outputRoot, { recursive: true, force: true });
        }
    });

    it("publishes validated timestamped and latest PNGs with fixed privacy-safe names", () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-windows-console-success-"));
        try {
            const result = captureHyperVWindowsConsole({
                ...IDENTITY,
                powershell: "powershell.exe",
                platform: "win32",
                outputRoot,
                now: () => new Date("2026-08-28T01:02:03.004Z"),
                spawnSyncImpl: successRunner(),
            });
            expect(result).toMatchObject({
                ok: true,
                latestRelativePath: "results/device-lab-real/hyper-v-windows-console-latest.png",
            });
            if (result.ok !== true) throw new Error(result.code);
            expect(result.timestampedPath).toBe(join(outputRoot, "hyper-v-windows-console-2026-08-28T01-02-03-004Z.png"));
            expect(readFileSync(result.timestampedPath)).toEqual(pngFixture());
            expect(readFileSync(result.latestPath)).toEqual(pngFixture());
            expect(readdirSync(outputRoot).sort()).toEqual([
                "hyper-v-windows-console-2026-08-28T01-02-03-004Z.png",
                "hyper-v-windows-console-latest.png",
            ]);
        } finally {
            rmSync(outputRoot, { recursive: true, force: true });
        }
    });

    it("rejects invalid identity, host, PowerShell, process, WMI, and PNG outcomes with bounded codes", () => {
        const base = { ...IDENTITY, powershell: "powershell.exe", platform: "win32" };
        expect(captureHyperVWindowsConsole({ ...base, ownerId: "bad", spawnSyncImpl: successRunner() })).toEqual({ ok: false, code: "hyper-v-console-identity-invalid" });
        expect(captureHyperVWindowsConsole({ ...base, platform: "linux", spawnSyncImpl: successRunner() })).toEqual({ ok: false, code: "hyper-v-console-host-not-windows" });
        expect(captureHyperVWindowsConsole({ ...base, powershell: "", spawnSyncImpl: successRunner() })).toEqual({ ok: false, code: "hyper-v-console-powershell-unavailable" });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: () => ({ status: null, error: Object.assign(new Error("secret"), { code: "ETIMEDOUT" }) }) })).toEqual({ ok: false, code: "hyper-v-console-process-timeout" });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: () => ({ status: null, error: Object.assign(new Error("secret"), { code: "ENOBUFS" }) }) })).toEqual({ ok: false, code: "hyper-v-console-output-too-large" });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: () => ({ status: 1, stderr: "C:\\Users\\private token=secret" }) })).toEqual({ ok: false, code: "hyper-v-console-process-failed" });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ ok: false, code: "hyper-v-console-wmi-access-denied", detail: "private" }) }) })).toEqual({ ok: false, code: "hyper-v-console-wmi-access-denied" });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ ok: false, code: "not-allowlisted", detail: "private" }) }) })).toEqual({ ok: false, code: "hyper-v-console-output-invalid" });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ ok: false, code: { toString: "private" } }) }) })).toEqual({ ok: false, code: "hyper-v-console-output-invalid" });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ pngBase64: pngFixture().toString("base64") }) }) })).toEqual({ ok: false, code: "hyper-v-console-png-invalid" });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: successRunner(pngFixture(320, 240)) })).toEqual({ ok: false, code: "hyper-v-console-png-invalid" });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ ok: true, pngBase64: "" }) }) })).toEqual({ ok: false, code: "hyper-v-console-png-invalid" });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ ok: true, pngBase64: "not+canonical==" }) }) })).toEqual({ ok: false, code: "hyper-v-console-png-invalid" });
        const wrongSignature = pngFixture();
        wrongSignature[0] = 0;
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: successRunner(wrongSignature) })).toEqual({ ok: false, code: "hyper-v-console-png-invalid" });
        const missingIhdr = pngFixture();
        missingIhdr.write("NOPE", 12, "ascii");
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: successRunner(missingIhdr) })).toEqual({ ok: false, code: "hyper-v-console-png-invalid" });
        const oversizedPng = Buffer.alloc(4 * 1024 * 1024 + 1);
        pngFixture().subarray(0, 33).copy(oversizedPng);
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: successRunner(oversizedPng) })).toEqual({ ok: false, code: "hyper-v-console-png-invalid" });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: () => ({ status: 0, stdout: "x".repeat(8 * 1024 * 1024 + 1) }) })).toEqual({ ok: false, code: "hyper-v-console-output-too-large" });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: () => ({ status: 0, stdout: "not-json" }) })).toEqual({ ok: false, code: "hyper-v-console-output-invalid" });
    });

    it("formats only schema-valid RGB565 layout diagnostics", () => {
        const base = { ...IDENTITY, powershell: "powershell.exe", platform: "win32" };
        const failure = (layout: Record<string, unknown>, extra: Record<string, unknown> = {}) => () => ({
            status: 0,
            stdout: JSON.stringify({
                ok: false,
                code: "hyper-v-console-rgb565-invalid",
                layout,
                ...extra,
            }),
            stderr: "",
        });

        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: failure({ completion: "sync", stage: "extract", rawKind: "missing" }) })).toEqual({
            ok: false,
            code: "hyper-v-console-rgb565-invalid[c=sync,s=extract,k=missing]",
        });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: failure({ completion: "async", stage: "extract", rawKind: "other" }, { detail: "C:\\Users\\private token=secret" }) })).toEqual({
            ok: false,
            code: "hyper-v-console-rgb565-invalid[c=async,s=extract,k=other]",
        });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: failure({ completion: "async", stage: "byte-count", rawKind: "byte-array", observedBytes: 153600, rawType: "System.Private.Secret" }) })).toEqual({
            ok: false,
            code: "hyper-v-console-rgb565-invalid[c=async,s=byte-count,k=byte-array,b=153600]",
        });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: failure({ completion: "sync", stage: "byte-count", rawKind: "byte-array", observedBytes: 8 * 1024 * 1024 }) })).toEqual({
            ok: false,
            code: "hyper-v-console-rgb565-invalid[c=sync,s=byte-count,k=byte-array,b=8388608]",
        });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: failure({ completion: "sync", stage: "bitmap-stride", rawKind: "byte-array", observedBytes: 614400, observedStride: 1279 }) })).toEqual({
            ok: false,
            code: "hyper-v-console-rgb565-invalid[c=sync,s=bitmap-stride,k=byte-array,b=614400,t=1279]",
        });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: failure({ completion: "sync", stage: "bitmap-stride", rawKind: "byte-array", observedBytes: 614404, observedStride: 1279 }) })).toEqual({
            ok: false,
            code: "hyper-v-console-rgb565-invalid[c=sync,s=bitmap-stride,k=byte-array,b=614404,t=1279]",
        });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: failure({ completion: "sync", stage: "byte-count", rawKind: "byte-array", observedBytes: 614403 }) })).toEqual({
            ok: false,
            code: "hyper-v-console-rgb565-invalid[c=sync,s=byte-count,k=byte-array,b=614403]",
        });
        expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: failure({ completion: "sync", stage: "byte-count", rawKind: "byte-array", observedBytes: 614405 }) })).toEqual({
            ok: false,
            code: "hyper-v-console-rgb565-invalid[c=sync,s=byte-count,k=byte-array,b=614405]",
        });

        const invalidLayouts = [
            undefined,
            { completion: "later", stage: "extract", rawKind: "missing" },
            { completion: "sync", stage: "unknown", rawKind: "missing" },
            { completion: "sync", stage: "extract", rawKind: "byte-array" },
            { completion: "sync", stage: "extract", rawKind: "missing", observedBytes: 0 },
            { completion: "sync", stage: "extract", rawKind: "missing", observedBytes: 1 },
            { completion: "sync", stage: "byte-count", rawKind: "other", observedBytes: 1 },
            { completion: "sync", stage: "byte-count", rawKind: "byte-array", observedBytes: 614400 },
            { completion: "sync", stage: "byte-count", rawKind: "byte-array", observedBytes: 614404 },
            { completion: "sync", stage: "byte-count", rawKind: "byte-array", observedBytes: -1 },
            { completion: "sync", stage: "byte-count", rawKind: "byte-array", observedBytes: 1.5 },
            { completion: "sync", stage: "byte-count", rawKind: "byte-array", observedBytes: "1" },
            { completion: "sync", stage: "byte-count", rawKind: "byte-array", observedBytes: 8 * 1024 * 1024 + 1 },
            { completion: "sync", stage: "bitmap-stride", rawKind: "byte-array", observedBytes: 614399, observedStride: 1279 },
            { completion: "sync", stage: "bitmap-stride", rawKind: "byte-array", observedBytes: 614403, observedStride: 1279 },
            { completion: "sync", stage: "bitmap-stride", rawKind: "byte-array", observedBytes: 614405, observedStride: 1279 },
            { completion: "sync", stage: "bitmap-stride", rawKind: "byte-array", observedBytes: 614400, observedStride: 1280 },
            { completion: "sync", stage: "bitmap-stride", rawKind: "byte-array", observedBytes: 614400, observedStride: -1 },
            { completion: "sync", stage: "bitmap-stride", rawKind: "byte-array", observedBytes: 614400, observedStride: 1024 * 1024 + 1 },
        ];
        for (const layout of invalidLayouts) {
            expect(captureHyperVWindowsConsole({ ...base, spawnSyncImpl: failure(layout as any) })).toEqual({ ok: false, code: "hyper-v-console-output-invalid" });
        }
    });

    it("does not advertise stale latest evidence when the new latest publication fails", () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-windows-console-stale-"));
        const latestPath = join(outputRoot, "hyper-v-windows-console-latest.png");
        mkdirSync(latestPath);
        try {
            const result = captureHyperVWindowsConsole({
                ...IDENTITY,
                powershell: "powershell.exe",
                platform: "win32",
                outputRoot,
                now: () => new Date("2026-08-28T01:02:03.004Z"),
                spawnSyncImpl: successRunner(),
            });
            expect(result).toEqual({ ok: false, code: "hyper-v-console-artifact-publish-failed" });
            expect(existsSync(join(outputRoot, "hyper-v-windows-console-2026-08-28T01-02-03-004Z.png"))).toBe(true);
        } finally {
            rmSync(outputRoot, { recursive: true, force: true });
        }
    });

    it("keeps the console field and bounded readiness tail inside the compact reporter limit", () => {
        const diagnostic = `boot={"state":"Running","heartbeat":null,"diagnosticComplete":false,"diagnosticErrors":["hyper-v-diagnostic-integration-services-incomplete"],"services":[["VSS",true,null]],"padding":"${"x".repeat(265)}"}`;
        const reason = `profile=windows-server; guestConsole=results/device-lab-real/hyper-v-windows-console-latest.png; start and wait for PowerShell Direct: hyper-v-guest-not-ready: ${diagnostic}`;
        const compacted = compactMessage(reason);
        // Not-truncated, not length. `toBeLessThanOrEqual(700)` cannot fail — compactMessage returns
        // at most its limit by construction — so it read as a budget check and asserted nothing.
        // Equality with the input is the assertion that matches this test's name: it fails the
        // moment the shape outgrows the reporter, which is the regression worth catching.
        expect(compacted).toBe(reason);
        expect(compacted).toContain("profile=windows-server");
        expect(compacted).toContain("guestConsole=results/device-lab-real/hyper-v-windows-console-latest.png");
        expect(compacted).toContain('"diagnosticErrors":["hyper-v-diagnostic-integration-services-incomplete"]');
        expect(compacted).toContain('"services":[["VSS",true,null]]');

        const layoutReason = reason.replace(
            "guestConsole=results/device-lab-real/hyper-v-windows-console-latest.png",
            "guestConsole=unavailable(hyper-v-console-rgb565-invalid[c=async,s=bitmap-stride,k=byte-array,b=614400,t=1279])",
        );
        const compactedLayout = compactMessage(layoutReason);
        // 650 of 700 raw. The narrowest headroom of the three shapes here, and until now it was
        // guarded only incidentally by a toContain on the last field.
        expect(compactedLayout).toBe(layoutReason);
        expect(compactedLayout).toContain("profile=windows-server");
        expect(compactedLayout).toContain("guestConsole=unavailable(hyper-v-console-rgb565-invalid");
        expect(compactedLayout).toContain('"diagnosticErrors":["hyper-v-diagnostic-integration-services-incomplete"]');
        expect(compactedLayout).toContain('"services":[["VSS",true,null]]');

        // The widest real shape, which this test predated: BOTH failure fields present, with the
        // setup-diagnostics one carrying the privilege code and a full-width redacted message.
        //
        // compactMessage KEEPS the head and drops the tail, so what a breach costs is the end of
        // the line — `originalReason`, the step name and the actual error, the only part an
        // operator can act on. That is why the assertions below are on content and not on length:
        // `expect(length).toBeLessThanOrEqual(700)` can never fail, because compactMessage returns
        // at most 700 by construction. It reads like a budget check and is a tautology. The two
        // toContain assertions are the whole test.
        //
        // This shape IS over budget — asserted below, not stated here — and that is expected. The
        // `"services"` field the two narrower cases assert does not survive here; the remedy and
        // the failure do, with roughly 170 characters of headroom past the real message cap.
        // Derived from the cap, not hardcoded against it. A literal filler made this a snapshot of
        // one moment: raise MOUNT_MESSAGE_MAX_CHARS — which the redaction comment in that module
        // explicitly invites — and the real widest line grows past the reporter's cut while this
        // case, frozen at its old width, keeps passing. Measured blind band with the literal: the
        // assertions only began failing at filler 329, ~170 characters of undetected room, exactly
        // where a cap increase lands.
        // Message, category and HResult kept coherent: a ResourceUnavailable mount failure naming
        // ERROR_NOT_READY (0x80070015) in its text, beside the generic .NET HResult the real host
        // produced. The hex in the message and `h=` differ on purpose — that split is the observed
        // behaviour AC-003 exists for, and it is why detection reads the message rather than h=.
        // (My first attempt used 0x80070015 as the HResult too and the reader rejected the whole
        // mount object: it bounds hresult at 2147483648, below every real 0x8007xxxx value. Filed
        // below as a pre-existing gap, not fixed here.)
        const messagePrefix = "The device is not ready: ";
        const messageSuffix = " (0x80070015).";
        const privilegeMessage = `${messagePrefix}${"y".repeat(MOUNT_MESSAGE_MAX_CHARS - messagePrefix.length - messageSuffix.length)}${messageSuffix}`;
        expect(privilegeMessage).toHaveLength(MOUNT_MESSAGE_MAX_CHARS);
        // The bracket comes from the producer, not from this file. Hand-typing it made the same
        // mistake the paragraph above argues against, one scale down: the literal was written
        // before `p=` existed and still read `[elevate,a=1,...]`, so the guard measured a shape the
        // producer no longer emits — and the ~170 characters of headroom hid that too. Driving
        // captureHyperVWindowsSetupDiagnostics means a new field, a longer value, or a renamed code
        // widens this fixture by itself. Inputs are the widest REACHABLE combination, not the
        // widest imaginable, and the first version of this comment got that wrong twice while
        // arguing against exactly that mistake:
        //   - `p=unelevated` with `a=10` cannot happen. $MountElevated is loop-invariant, so an
        //     unelevated host breaks on its FIRST mount failure; p=unelevated always carries a=1.
        //     hyper-v-vm-e2e.test.ts pins that pairing, and this file had contradicted it.
        //   - `ResourceBusy` is not the longest category. MOUNT_ERROR_CATEGORIES holds
        //     `ResourceUnavailable` and `AuthenticationError` at 19 characters against its 12.
        // So the widest reachable shape is `p=unelevated` (11 chars against 4 for `code`, which
        // more than pays for the a=1) with the longest category. The message is a non-privilege
        // one, because a 0x80070522 message would make the producer say `p=code` and the fixture
        // would stop describing a state any host can be in.
        let mountCalls = 0;
        const produced = captureHyperVWindowsSetupDiagnostics({
            ...IDENTITY,
            vmId: "12345678-1234-4123-8123-123456789abc",
            powershell: "powershell.exe",
            platform: "win32",
            spawnSyncImpl: () => {
                mountCalls += 1;
                if (mountCalls === 1) return { status: 0, stdout: JSON.stringify({ ok: true, diskPath: "C:\\state\\root.vhdx" }) };
                if (mountCalls === 2) {
                    return {
                        status: 0,
                        stdout: JSON.stringify({
                            ok: false,
                            code: "hyper-v-setup-diagnostics-mount-failed",
                            mount: { attempts: 1, category: "ResourceUnavailable", hresult: 2146233088, message: privilegeMessage, privilege: "unelevated" },
                        }),
                    };
                }
                return { status: 0, stdout: JSON.stringify({ ok: true, detached: true }) };
            },
        });
        expect(mountCalls).toBe(3);
        expect(produced.ok).toBe(false);
        const producedCode = "code" in produced ? produced.code : "";
        expect(producedCode, "the fixture is only the widest shape if the producer really emits it").toBe(
            `hyper-v-setup-diagnostics-mount-privilege-required[elevate,p=unelevated,a=1,c=ResourceUnavailable,h=2146233088,m=${privilegeMessage}]`,
        );
        // The elevation retry appends a suffix whenever it does not recover the logs, so the widest
        // reachable value of this field is the privilege code PLUS the longest of those suffixes.
        // Derived rather than typed, because it has already moved once: the `still=` form (77 chars
        // at its longest name) was widest until `published=` was added, and `published=` carries a
        // longer keyword, so the fixture was silently measuring against the second-widest shape
        // within one commit of being written.
        //
        // `still=` carries only the code NAME (split at `[`); `published=` carries a publish failure
        // code, which has no bracket. Both draw from SAFE_CODES, whose longest members are 49
        // characters — asserted below, so this stops being true-by-inspection.
        const longestSafeCode = [...SETUP_DIAGNOSTICS_SAFE_CODES].reduce((a, b) => (b.length > a.length ? b : a));
        const widestElevationSuffix = `(elevation=approved,published=${longestSafeCode})`;
        expect(widestElevationSuffix, "the suffix must be DERIVED from the code set, not typed — typing it is how it went stale")
            .toContain(longestSafeCode);
        expect(widestElevationSuffix.length, "and it must still beat the other suffix family, which was widest until published= arrived")
            .toBeGreaterThan("(elevation=approved,still=hyper-v-setup-diagnostics-mount-privilege-required)".length);
        const widestReason = [
            "profile=windows-server",
            "guestConsole=unavailable(hyper-v-console-rgb565-invalid[c=async,s=bitmap-stride,k=byte-array,b=614400,t=1279])",
            `guestSetupDiagnostics=unavailable(${producedCode}${widestElevationSuffix})`,
            `start and wait for PowerShell Direct: hyper-v-guest-not-ready: ${diagnostic}`,
        ].join("; ");
        // The premise of this case, asserted rather than asserted-in-a-comment: the shape must
        // actually exceed the budget, or the two checks below prove nothing about truncation. A
        // frozen raw length here would go stale the same way the bracket did.
        expect(widestReason.length, "if this ever fits, the case stopped testing truncation").toBeGreaterThan(700);
        const compactedWidest = compactMessage(widestReason);
        expect(compactedWidest, "the remedy must survive, it is the whole point of the code").toContain("mount-privilege-required[elevate");
        expect(compactedWidest, "and so must the failure the operator has to act on").toContain("hyper-v-guest-not-ready");
        // Producing the fixture MOVED the blind band, it did not close it, and the paragraph above
        // implied otherwise. The cut is at 697, not 700: compactMessage returns
        // `slice(0, limit - 3) + "..."`, so content survives only while it ends at or before 697.
        // Measured at HEAD: 69 characters sit between the end of the marker and that cut, so
        // MOUNT_MESSAGE_MAX_CHARS can rise by that much and the two assertions above still pass —
        // against ~170 for the hand-typed literal, and 149 before the elevation suffix widened the
        // shape. It is still not "raise the cap and this fails", which the first version implied.
        // (That first version also said 152 by measuring against 700, overclaiming precision in the
        // very comment that exists to stop numbers nobody has looked at since.)
        //
        // And be exact about what the assertion below does and does not catch, because the first
        // version overclaimed that too. Raising the cap makes this distance SHRINK monotonically
        // (149, 148, ...) until the marker is cut at cap 350, where it jumps to 675 — the same cap
        // at which the toContain above already fails. So it gives no earlier warning for a cap
        // increase. What it does catch is the band GROWING for a structural reason: shorten a field
        // ahead of the marker and the room reappears silently. Measured: 10 characters off the
        // guestConsole field moves it 149 -> 158, 12 characters trips it. That is the blind spot
        // worth a tripwire, and it is the one this guards.
        const marker = "hyper-v-guest-not-ready";
        const markerEnd = compactedWidest.indexOf(marker) + marker.length;
        expect(697 - markerEnd, "the undetected band must not grow: something ahead of the marker got shorter").toBeLessThan(80);
    });

    it("exports the fixed capture dimensions", () => {
        expect(HYPER_V_WINDOWS_CONSOLE_CAPTURE_DIMENSIONS).toEqual({ width: 640, height: 480 });
    });
});
