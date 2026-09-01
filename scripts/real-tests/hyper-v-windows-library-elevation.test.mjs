import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { createHash } from "crypto";
import { connect } from "net";
import { PassThrough } from "stream";

import {
    HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP,
    elevationPowerShellScripts,
    isAdministrator,
    requestAdministrator,
    resolveTrustedWindowsPowerShell,
} from "./hyper-v-windows-library-elevation.mjs";

const token = "aa".repeat(32);
const pipeSuffix = "bb".repeat(16);
const pipeName = `ccc-hyper-v-windows-library-${process.pid}-${pipeSuffix}`;
const pipePath = `\\\\.\\pipe\\${pipeName}`;
const programBytes = Buffer.from("self-contained-program", "utf8");
const programDigest = createHash("sha256").update(programBytes).digest("hex");
const nodeDigest = "cc".repeat(32);

function randomBytesImpl(size) {
    return Buffer.from(size === 32 ? token : pipeSuffix, "hex");
}

function fakeLauncher({ launcherStdout, pipeLines = [], onProgram = () => {}, closeBeforeProgram = false, raceUnauthenticated = false, holdUnauthenticated = false, finishBeforePipeResponse = false }) {
    return vi.fn((_executable, args) => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = vi.fn();
        setImmediate(() => {
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                child.stdout.end(launcherStdout);
                child.stderr.end();
                setImmediate(() => child.emit("close", 0));
            };
            if (pipeLines.length > 0) {
                if (raceUnauthenticated) {
                    const unauthenticated = connect(pipePath);
                    unauthenticated.on("error", () => {});
                    unauthenticated.once("connect", () => unauthenticated.end("not-authenticated\n"));
                }
                if (holdUnauthenticated) {
                    const holding = connect(pipePath);
                    holding.on("error", () => {});
                }
                const socket = connect(pipePath);
                socket.on("error", () => finish());
                socket.once("connect", () => {
                    socket.write(`CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_PIPE:${token}:AUTH:\n`);
                    if (closeBeforeProgram) socket.destroy();
                    else if (finishBeforePipeResponse) finish();
                });
                socket.once("close", finish);
                socket.setEncoding("utf8");
                let input = "";
                socket.on("data", (chunk) => {
                    input += chunk;
                    if (input.includes("\n")) {
                        onProgram(input);
                        socket.end(`${pipeLines.join("\n")}\n`);
                    }
                });
            } else finish();
        });
        child.args = args;
        return child;
    });
}

function decodeCommand(args) {
    const index = args.indexOf("-EncodedCommand");
    return Buffer.from(args[index + 1], "base64").toString("utf16le");
}

describe("Hyper-V Windows library command elevation", () => {
    it("resolves Windows PowerShell beneath the kernel system-root alias", () => {
        const realpath = vi.fn(() => "C:\\Windows");
        expect(resolveTrustedWindowsPowerShell(realpath)).toBe(
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        );
        expect(realpath).toHaveBeenCalledWith("\\\\?\\GLOBALROOT\\SystemRoot");
    });

    it("distinguishes an administrator token from a filtered token", () => {
        const elevatedSpawn = vi.fn(() => ({ status: 0 }));
        const filteredSpawn = vi.fn(() => ({ status: 3 }));
        expect(isAdministrator({ powerShellPath: "trusted-powershell.exe", spawnSyncImpl: elevatedSpawn })).toBe(true);
        expect(isAdministrator({ powerShellPath: "trusted-powershell.exe", spawnSyncImpl: filteredSpawn })).toBe(false);
        expect(decodeCommand(elevatedSpawn.mock.calls[0][1])).toContain("WindowsBuiltInRole]::Administrator");
    });

    it("builds one encoded RunAs launch with a named-pipe output channel", () => {
        const { elevatedScript, elevatedBootstrap, launcherInput, launcherScript } = elevationPowerShellScripts({
            powerShellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            nodePath: "C:\\Program Files\\nodejs\\node.exe",
            nodeDigest,
            programDigest,
            pipeName,
            token,
        });
        expect(launcherScript).toContain("Start-Process");
        expect(launcherScript).toContain("-Verb RunAs");
        expect(launcherScript).toContain("-Wait -PassThru");
        expect(launcherScript).not.toContain("C:\\Program Files");
        expect(launcherScript).toContain("[Console]::In.ReadLine()");
        const payload = JSON.parse(Buffer.from(launcherInput, "base64").toString("utf8"));
        const elevated = Buffer.from(payload.elevatedCommand, "base64").toString("utf16le");
        expect(elevated).not.toContain("hyper-v-windows-library-command.mjs");
        expect(elevated).toContain("GZipStream");
        expect(elevated).toContain("ScriptBlock]::Create($Source)");
        expect(elevatedScript).toContain("NamedPipeClientStream");
        expect(elevatedScript).toContain(":AUTH:");
        expect(elevatedBootstrap).toContain("elevation-bootstrap-watchdog-start-failed");
        expect(elevatedBootstrap).toContain("StartTime.ToFileTimeUtc()");
        expect(elevatedBootstrap).toContain("$Handle = $Target.Handle");
        expect(elevatedBootstrap).toContain("$Target.WaitForExit(540000)");
        expect(elevatedBootstrap).not.toContain("[Threading.Thread]::Sleep(540000)");
        expect(elevatedBootstrap.indexOf("$BootstrapWatchdog = [Diagnostics.Process]::Start"))
            .toBeLessThan(elevatedBootstrap.indexOf("GZipStream"));
        expect(elevatedScript.indexOf("$Pipe.Connect(15000)"))
            .toBeLessThan(elevatedScript.indexOf("Add-Type -TypeDefinition $CaptureSource"));
        expect(elevatedScript).not.toContain("$Pipe.ReadTimeout");
        expect(elevatedScript).toContain("CccHyperVWindowsLibraryBoundedProcess");
        expect(elevatedScript).toContain("PROGRAM:");
        expect(elevatedScript).toContain("ccc-hyper-v-library-elevated-");
        expect(elevatedScript).toContain("elevation-program-integrity-failed");
        expect(elevatedScript).toContain("elevation-node-integrity-failed");
        expect(elevatedScript).toContain("$env:TEMP = $Root");
        expect(elevatedScript).toContain("$env:TMP = $Root");
        expect(elevatedScript.indexOf("$RootInfo.Create($Security)"))
            .toBeLessThan(elevatedScript.indexOf("$env:TEMP = $Root"));
        expect(elevatedScript.indexOf("$env:TEMP = $Root"))
            .toBeLessThan(elevatedScript.indexOf("Add-Type -TypeDefinition $CaptureSource"));
        expect(elevatedScript).toContain("function Remove-CccProtectedStagingRoot");
        expect(elevatedScript).toContain("elevation-staging-cleanup-boundary-invalid");
        expect(elevatedScript).toContain("elevation-staging-cleanup-reparse-refused");
        expect(elevatedScript).toContain("[IO.SearchOption]::TopDirectoryOnly");
        expect(elevatedScript).toContain("[Collections.Generic.Stack[string]]::new()");
        expect(elevatedScript).not.toContain("[IO.SearchOption]::AllDirectories");
        expect(elevatedScript).not.toContain("[IO.Directory]::Delete($Root, $true)");
        expect(elevatedScript.indexOf("Remove-CccProtectedStagingRoot $Root", elevatedScript.indexOf("$Capture =")))
            .toBeLessThan(elevatedScript.indexOf(":STDOUT:"));
        expect(elevatedScript).toContain("TerminationUnconfirmed");
        expect(elevatedScript).not.toContain("ReadToEndAsync");
        expect(elevatedScript).not.toContain("2>&1 | ForEach-Object");
        expect(elevatedScript).toContain("$ProgressPreference = 'SilentlyContinue'");
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain("new byte[8192]");
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain("state.Total > state.Limit - read");
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain("TerminateJobObject(state.Job, 1)");
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain("JobObjectLimitKillOnJobClose");
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain("AssignProcessToJobObject");
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain("ContainCurrentProcess");
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain("EnvironmentVariables.Clear()");
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain('EnvironmentVariables["SystemRoot"] = systemRoot');
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain('EnvironmentVariables["SystemDrive"] = systemDrive');
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain('EnvironmentVariables["COMPUTERNAME"] = Environment.MachineName');
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain('EnvironmentVariables["COMSPEC"] = Path.Combine(system32, "cmd.exe")');
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain('EnvironmentVariables["PATH"] = String.Join');
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain('EnvironmentVariables["PATHEXT"] = ".COM;.EXE;.BAT;.CMD"');
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain('EnvironmentVariables["PSModulePath"] = Path.Combine(powershellRoot, "Modules")');
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain("startInfo.WorkingDirectory = workingDirectory");
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).not.toContain('EnvironmentVariables["NODE_OPTIONS"]');
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).toContain("WaitForExit(5000)");
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).not.toContain("process.WaitForExit();");
        expect(HYPER_V_WINDOWS_LIBRARY_BOUNDED_CAPTURE_CSHARP).not.toContain("ReadToEnd");
        expect(launcherScript).toBeTruthy();
        expect(Buffer.from(launcherScript, "utf16le").toString("base64").length).toBeLessThan(32_767);
        expect(payload.elevatedCommand.length).toBeLessThan(32_767);
    });

    it("returns named-pipe Vitest output and propagates the elevated status", async () => {
        const output = "RUN v4.1.2\r\nPASS real host\r\n";
        const errorOutput = "failure stack\r\n";
        const onProgram = vi.fn();
        const spawnImpl = fakeLauncher({
            launcherStdout: "CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_RESULT:EXIT:7\r\n",
            pipeLines: [
                `CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_PIPE:${token}:STDOUT:${Buffer.from(output).toString("base64")}`,
                `CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_PIPE:${token}:STDERR:${Buffer.from(errorOutput).toString("base64")}`,
                `CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_PIPE:${token}:RESULT:7`,
            ],
            onProgram,
        });
        await expect(requestAdministrator({
            powerShellPath: "trusted-powershell.exe",
            nodePath: "node.exe",
            nodeDigest,
            programBytes,
            programDigest,
            spawnImpl,
            randomBytesImpl,
        })).resolves.toEqual({ status: 7, stdout: output, stderr: errorOutput });
        expect(decodeCommand(spawnImpl.mock.calls[0][1])).toContain("-Verb RunAs");
        expect(onProgram).toHaveBeenCalledWith(expect.stringContaining(
            `CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_PIPE:${token}:PROGRAM:${programBytes.toString("base64")}`,
        ));
    });

    it("ignores an unauthenticated pipe client before serving the token holder", async () => {
        await expect(requestAdministrator({
            powerShellPath: "trusted-powershell.exe",
            nodePath: "node.exe",
            nodeDigest,
            programBytes,
            programDigest,
            spawnImpl: fakeLauncher({
                launcherStdout: "CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_RESULT:EXIT:0\r\n",
                pipeLines: [`CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_PIPE:${token}:RESULT:0`],
                raceUnauthenticated: true,
            }),
            randomBytesImpl,
        })).resolves.toEqual({ status: 0, stdout: "", stderr: "" });
    });

    it("destroys a silent unauthenticated socket instead of waiting during shutdown", async () => {
        await expect(requestAdministrator({
            powerShellPath: "trusted-powershell.exe",
            nodePath: "node.exe",
            nodeDigest,
            programBytes,
            programDigest,
            spawnImpl: fakeLauncher({
                launcherStdout: "CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_RESULT:EXIT:0\r\n",
                pipeLines: [`CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_PIPE:${token}:RESULT:0`],
                holdUnauthenticated: true,
            }),
            randomBytesImpl,
        })).resolves.toEqual({ status: 0, stdout: "", stderr: "" });
    });

    it("waits for the authenticated terminal frame after the launcher closes", async () => {
        await expect(requestAdministrator({
            powerShellPath: "trusted-powershell.exe",
            nodePath: "node.exe",
            nodeDigest,
            programBytes,
            programDigest,
            spawnImpl: fakeLauncher({
                launcherStdout: "CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_RESULT:EXIT:0\r\n",
                pipeLines: [`CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_PIPE:${token}:RESULT:0`],
                finishBeforePipeResponse: true,
            }),
            randomBytesImpl,
        })).resolves.toEqual({ status: 0, stdout: "", stderr: "" });
    });

    it("reports UAC cancellation without accepting a missing pipe result", async () => {
        await expect(requestAdministrator({
            powerShellPath: "trusted-powershell.exe",
            nodePath: "node.exe",
            nodeDigest,
            programBytes,
            programDigest,
            spawnImpl: fakeLauncher({
                launcherStdout: "CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_RESULT:CANCELLED\r\n",
            }),
            randomBytesImpl,
        })).resolves.toEqual({ status: 1, stdout: "", stderr: "", errorCode: "elevation-cancelled" });
    });

    it("fails when the bounded elevated capture terminates an over-limit child", async () => {
        await expect(requestAdministrator({
            powerShellPath: "trusted-powershell.exe",
            nodePath: "node.exe",
            nodeDigest,
            programBytes,
            programDigest,
            spawnImpl: fakeLauncher({
                launcherStdout: "CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_RESULT:EXIT:1\r\n",
                pipeLines: [`CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_PIPE:${token}:LIMIT:`],
            }),
            randomBytesImpl,
        })).resolves.toEqual({
            status: 1,
            stdout: "",
            stderr: "",
            errorCode: "elevation-output-limit-exceeded",
        });
    });

    it("rejects a program whose bytes do not match the pre-UAC digest", async () => {
        const spawnImpl = vi.fn();
        await expect(requestAdministrator({
            powerShellPath: "trusted-powershell.exe",
            nodePath: "node.exe",
            nodeDigest,
            programBytes,
            programDigest: "dd".repeat(32),
            spawnImpl,
            randomBytesImpl,
        })).resolves.toEqual({
            status: 1,
            stdout: "",
            stderr: "",
            errorCode: "elevation-program-integrity-failed",
        });
        expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("turns an early elevated pipe close into a bounded transport failure", async () => {
        await expect(requestAdministrator({
            powerShellPath: "trusted-powershell.exe",
            nodePath: "node.exe",
            nodeDigest,
            programBytes,
            programDigest,
            spawnImpl: fakeLauncher({
                launcherStdout: "CCC_HYPER_V_WINDOWS_LIBRARY_ELEVATION_RESULT:EXIT:1\r\n",
                pipeLines: ["unused"],
                closeBeforeProgram: true,
            }),
            randomBytesImpl,
        })).resolves.toMatchObject({
            status: 1,
            errorCode: "elevation-pipe-write-failed",
        });
    });
});
