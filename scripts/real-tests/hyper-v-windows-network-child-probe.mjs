// Diagnostic probe for the elevated Hyper-V network child. Run it on the Windows host from an
// ALREADY ELEVATED terminal (right-click → Run as administrator):
//
//     node scripts/real-tests/hyper-v-windows-network-child-probe.mjs
//
// The production relay launches the child hidden, non-interactive, and through UAC, so nothing the
// child prints ever reaches a person and any failure before the pipe looks like a handshake
// timeout. This probe runs the EXACT generated child program (the same loader -EncodedCommand
// receives) as a visible child of this console, against a pipe server that uses the production
// name, ACL, and handshake, and prints whatever the child prints. No UAC prompt is shown because
// the console is already elevated; no Hyper-V operation is executed — the bootstrap the probe
// hands the child only echoes one line back through the pipe.
import { spawn, spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROBE_TIMEOUT_MILLISECONDS = 90_000;

function encodedPowerShell(source) {
    return Buffer.from(source, "utf16le").toString("base64");
}

function loadChildPrograms() {
    const module = join(repositoryRoot, "src", "device-lab", "broker", "hyper-v", "elevated-network-session.ts");
    const moduleUrl = `file:///${module.replace(/\\/g, "/")}`;
    const probe = spawnSync(process.execPath, [
        "--import", "tsx",
        "-e", `import(${JSON.stringify(moduleUrl)}).then((m) => process.stdout.write(JSON.stringify(m.hyperVElevatedNetworkChildPrograms())))`,
    ], { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
    if (probe.error || probe.status !== 0) {
        throw new Error(`unable to load the child programs: ${probe.stderr || probe.error?.message || "unknown"}`);
    }
    const programs = JSON.parse(probe.stdout);
    if (typeof programs?.loader !== "string" || typeof programs?.child !== "string") {
        throw new Error("child programs did not load");
    }
    return programs;
}

function serverSource(pipeName) {
    return [
        "$ErrorActionPreference='Stop'",
        `$P='${pipeName}'`,
        "$S=[IO.Pipes.PipeSecurity]::new();$A=[Security.Principal.SecurityIdentifier]'S-1-5-32-544';$S.SetAccessRule([IO.Pipes.PipeAccessRule]::new($A,[IO.Pipes.PipeAccessRights]::ReadWrite,[Security.AccessControl.AccessControlType]::Allow))",
        "$Q=[IO.Pipes.NamedPipeServerStream]::new($P,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,4096,4096,$S)",
        "$H=$Q.BeginWaitForConnection($null,$null)",
        "[Console]::Out.WriteLine('PROBE:SERVER-READY');[Console]::Out.Flush()",
        "if(-not $H.AsyncWaitHandle.WaitOne(60000)){[Console]::Out.WriteLine('PROBE:HANDSHAKE-TIMEOUT');[Console]::Out.Flush();exit 2}",
        "$Q.EndWaitForConnection($H);[Console]::Out.WriteLine('PROBE:CONNECTED');[Console]::Out.Flush()",
        "$R=[IO.StreamReader]::new($Q,[Text.UTF8Encoding]::new($false),$false,4096,$true);$W=[IO.StreamWriter]::new($Q,[Text.UTF8Encoding]::new($false),4096,$true)",
        "$AL=$R.ReadLine()",
        "if($AL-and $AL.StartsWith('AUTH:')){$AJ=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($AL.Substring(5)));[Console]::Out.WriteLine('PROBE:AUTH='+$AJ)}else{[Console]::Out.WriteLine('PROBE:AUTH-INVALID='+[string]$AL)}",
        "[Console]::Out.Flush()",
        "$B=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(\"[Console]::Out.WriteLine('PROBE-BOOTSTRAP-RAN')\"))",
        "$W.WriteLine($B);$W.Flush()",
        "$V=$R.ReadLine();[Console]::Out.WriteLine('PROBE:CHILD-SAID='+[string]$V);[Console]::Out.Flush()",
        "$Q.Dispose();exit 0",
    ].join(";");
}

function powerShellPath() {
    const root = process.env.SystemRoot || "C:\\Windows";
    return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function waitForExit(child, label) {
    return new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ label, code, signal }));
        child.once("error", (error) => resolve({ label, code: null, signal: null, error: String(error?.message || error) }));
    });
}

async function run() {
    if (process.platform !== "win32") {
        process.stdout.write("SKIP child probe: Windows host required\n");
        return 0;
    }
    const programs = loadChildPrograms();
    const pipeName = /\$P='([^']+)'/.exec(programs.child)?.[1];
    if (!pipeName) throw new Error("child program has no pipe name");
    const childEncoded = encodedPowerShell(programs.loader);
    const executable = powerShellPath();
    process.stdout.write(`INFO child probe pipe=${pipeName} loaderChars=${programs.loader.length} encodedChars=${childEncoded.length}\n`);
    process.stdout.write("INFO this console must already be elevated; the child inherits its token\n");

    const serverLines = [];
    const server = spawn(executable, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encodedPowerShell(serverSource(pipeName)),
    ], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    const serverExit = waitForExit(server, "server");
    let serverBuffer = "";
    const serverReady = new Promise((resolve) => {
        server.stdout.setEncoding("utf8");
        server.stdout.on("data", (chunk) => {
            serverBuffer += chunk;
            let index = serverBuffer.indexOf("\n");
            while (index >= 0) {
                const line = serverBuffer.slice(0, index).replace(/\r$/, "");
                serverBuffer = serverBuffer.slice(index + 1);
                serverLines.push(line);
                process.stdout.write(`SERVER ${line}\n`);
                if (line === "PROBE:SERVER-READY") resolve(true);
                index = serverBuffer.indexOf("\n");
            }
        });
        server.stdout.once("end", () => resolve(false));
    });

    const timeout = setTimeout(() => {
        process.stdout.write("FAIL child probe: timed out; killing server and child\n");
        try { server.kill(); } catch { /* best effort */ }
    }, PROBE_TIMEOUT_MILLISECONDS);
    timeout.unref();

    if (!(await serverReady)) {
        process.stdout.write("FAIL child probe: pipe server did not start (its error is printed above)\n");
        return 1;
    }

    process.stdout.write("INFO launching the child visibly with the exact production loader\n");
    const child = spawn(executable, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", childEncoded,
    ], { stdio: "inherit", windowsHide: false });
    const childResult = await waitForExit(child, "child");
    process.stdout.write(`CHILD exit code=${String(childResult.code)} signal=${String(childResult.signal)}${childResult.error ? ` error=${childResult.error}` : ""}\n`);
    const serverResult = await serverExit;
    clearTimeout(timeout);
    process.stdout.write(`SERVER exit code=${String(serverResult.code)}\n`);

    const connected = serverLines.includes("PROBE:CONNECTED");
    const bootstrapRan = serverLines.includes("PROBE:CHILD-SAID=PROBE-BOOTSTRAP-RAN");
    const auth = serverLines.find((line) => line.startsWith("PROBE:AUTH="));
    if (connected && bootstrapRan && auth?.includes('"administrator":true')) {
        process.stdout.write("PASS child probe: the child connected, authenticated as administrator, and ran the bootstrap\n");
        return 0;
    }
    if (!connected) {
        process.stdout.write("FAIL child probe: the child never connected; its PowerShell error is printed above under CHILD\n");
    } else if (auth && !auth.includes('"administrator":true')) {
        process.stdout.write("FAIL child probe: connected but not administrator; run this from an elevated console\n");
    } else {
        process.stdout.write("FAIL child probe: connected but the bootstrap did not echo; see SERVER and CHILD lines above\n");
    }
    return 1;
}

process.exitCode = await run();
