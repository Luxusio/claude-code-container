import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deflateSync } from "zlib";
import { describe, expect, it } from "vitest";
import { compactMessage } from "./compact-message.ts";
import { captureHyperVWindowsConsole, HYPER_V_WINDOWS_CONSOLE_CAPTURE_DIMENSIONS } from "./hyper-v-windows-console-capture.ts";

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
        expect(compacted.length).toBeLessThanOrEqual(700);
        expect(compacted).toContain("profile=windows-server");
        expect(compacted).toContain("guestConsole=results/device-lab-real/hyper-v-windows-console-latest.png");
        expect(compacted).toContain('"diagnosticErrors":["hyper-v-diagnostic-integration-services-incomplete"]');
        expect(compacted).toContain('"services":[["VSS",true,null]]');

        const layoutReason = reason.replace(
            "guestConsole=results/device-lab-real/hyper-v-windows-console-latest.png",
            "guestConsole=unavailable(hyper-v-console-rgb565-invalid[c=async,s=bitmap-stride,k=byte-array,b=614400,t=1279])",
        );
        const compactedLayout = compactMessage(layoutReason);
        expect(compactedLayout.length).toBeLessThanOrEqual(700);
        expect(compactedLayout).toContain("profile=windows-server");
        expect(compactedLayout).toContain("guestConsole=unavailable(hyper-v-console-rgb565-invalid");
        expect(compactedLayout).toContain('"diagnosticErrors":["hyper-v-diagnostic-integration-services-incomplete"]');
        expect(compactedLayout).toContain('"services":[["VSS",true,null]]');
    });

    it("exports the fixed capture dimensions", () => {
        expect(HYPER_V_WINDOWS_CONSOLE_CAPTURE_DIMENSIONS).toEqual({ width: 640, height: 480 });
    });
});
