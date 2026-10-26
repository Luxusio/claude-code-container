import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContainerRestartRequiredError, formatContainerLifecycleCommandHint, formatContainerStartupError } from "../container-restart-guidance.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function posixCommand(message: unknown): string {
    expect(typeof message).toBe("string");
    const commands = [...String(message).matchAll(/(?:^|\n)(`{3,})[^\n]*\n([\s\S]*?)\n\1(?=\n|$)/g)];
    expect(commands).toHaveLength(1);
    expect(commands[0]![2]).toMatch(/^\(cd [\s\S]+ && [\s\S]+\)$/);
    return commands[0]![2]!;
}

function shellFixture(workspaceName = "workspace") {
    const root = mkdtempSync(join(tmpdir(), "ccc-restart-guidance-")); roots.push(root);
    const bin = join(root, "bin"); const wrongCwd = join(root, "other-workspace");
    const workspace = join(root, workspaceName); const calls = join(root, "calls.jsonl");
    for (const path of [bin, wrongCwd, workspace]) mkdirSync(path, { mode: 0o700 });
    const recorder = join(root, "record.cjs");
    writeFileSync(recorder, `const fs = require("node:fs");
fs.appendFileSync(process.env.CCC_RESTART_TEST_CALLS, JSON.stringify({
    kind: process.argv[2], cwd: fs.realpathSync(process.cwd()),
    profile: process.env.CCC_PROFILE ?? null, argv: process.argv.slice(3),
}) + "\\n");\n`);
    writeFileSync(join(bin, "ccc"), '#!/bin/sh\nexec "$CCC_RESTART_TEST_NODE" "$CCC_RESTART_TEST_RECORDER" ccc "$@"\n', { mode: 0o700 });
    const run = (command: string, profile: string | undefined) => {
        const result = spawnSync("/bin/sh", ["-s"], {
            cwd: wrongCwd, encoding: "utf8", timeout: 5000,
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, CCC_PROFILE: profile,
                CCC_RESTART_TEST_NODE: process.execPath, CCC_RESTART_TEST_RECORDER: recorder, CCC_RESTART_TEST_CALLS: calls },
            input: `${command}\nccc_restart_status=$?\n"$CCC_RESTART_TEST_NODE" "$CCC_RESTART_TEST_RECORDER" caller\nexit "$ccc_restart_status"\n`,
        });
        const events = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as {
            kind: string; cwd: string; profile: string | null; argv: string[];
        });
        return { result, events };
    };
    return { root, wrongCwd, workspace, run };
}

describe("container restart guidance", () => {
    it("gives a supported stop command for the exact workspace without a stack or force flag", () => {
        const error = new ContainerRestartRequiredError("bind identity changed at /home/ccc/.claude.json", "/projects/PAY--DEV-208-28", "docker");
        const message = formatContainerStartupError(error, false, "linux");
        expect(typeof message).toBe("string");
        expect(message).toContain("Container restart required: bind identity changed at /home/ccc/.claude.json");
        expect(message).toContain("Close the other CCC sessions");
        expect(posixCommand(message)).toContain("/projects/PAY--DEV-208-28");
        expect(posixCommand(message)).toContain("CCC_PROFILE='default'");
        expect(message).toContain("retry your original command");
        expect(message).not.toContain("--force");
        expect(message).not.toContain("\n    at ");
        expect(message).not.toContain("[cause]");
    });

    it("labels PowerShell and statically preserves literal location, profile presence/value and finally restoration", () => {
        const workspace = "C:\\Work Space\\repo's $env:USERPROFILE";
        const message = String(formatContainerStartupError(new ContainerRestartRequiredError("project path identity changed", workspace, "podman", "work"), false, "win32"));
        expect(message).toContain("PowerShell");
        expect(message).toContain("Push-Location -LiteralPath 'C:\\Work Space\\repo''s $env:USERPROFILE' -ErrorAction Stop");
        expect(message).toContain("$env:CCC_PROFILE = 'work'");
        expect(message).toContain("ccc --runtime podman stop");
        expect(message).toMatch(/Test-Path\s+(?:-LiteralPath\s+)?['"]?Env:CCC_PROFILE['"]?/i);
        const beforePush = message.slice(0, message.indexOf("Push-Location"));
        expect(beforePush).toMatch(/=\s*\$env:CCC_PROFILE/);
        expect(message).toMatch(/try\s*\{/);
        const finallyAt = message.indexOf("finally");
        expect(finallyAt).toBeGreaterThan(message.indexOf("Push-Location"));
        const restoration = message.slice(finallyAt);
        expect(restoration).toMatch(/\$env:CCC_PROFILE\s*=/);
        expect(restoration).toMatch(/Remove-Item\s+(?:-LiteralPath\s+)?['"]?Env:CCC_PROFILE['"]?/i);
        expect(restoration).toContain("Pop-Location");
        const defaultMessage = String(formatContainerStartupError(new ContainerRestartRequiredError("bind mismatch", workspace, "docker"), false, "win32"));
        expect(defaultMessage).toContain("$env:CCC_PROFILE = 'default'");
        expect(message).not.toContain("--force");
    });

    it.each([
        { codePoint: "U+0027", delimiter: "\u0027" },
        { codePoint: "U+2018", delimiter: "\u2018" },
        { codePoint: "U+2019", delimiter: "\u2019" },
        { codePoint: "U+201A", delimiter: "\u201A" },
        { codePoint: "U+201B", delimiter: "\u201B" },
    ])("statically doubles $codePoint in a literal PowerShell workspace without changing its codepoint", ({ delimiter }) => {
        const suffix = "; Write-Output injected; $(Get-Date) `whoami` & #";
        const workspace = "C:\\Work Space\\repo" + delimiter + suffix;
        const escapedWorkspace = "C:\\Work Space\\repo" + delimiter + delimiter + suffix;
        const message = String(formatContainerStartupError(new ContainerRestartRequiredError("bind mismatch", workspace, "docker"), false, "win32"));
        expect(message).toContain(`Push-Location -LiteralPath '${escapedWorkspace}' -ErrorAction Stop`);
    });

    it("statically preserves and doubles every recognized delimiter in the PowerShell profile literal", () => {
        const profile = "work\u0027; \u2018$(Get-Date)\u2019; \u201A`whoami`\u201B & #";
        const escapedProfile = "work\u0027\u0027; \u2018\u2018$(Get-Date)\u2019\u2019; \u201A\u201A`whoami`\u201B\u201B & #";
        const message = String(formatContainerStartupError(new ContainerRestartRequiredError("bind mismatch", "C:\\Work Space\\repo", "podman", profile), false, "win32"));
        expect(message).toContain(`$env:CCC_PROFILE = '${escapedProfile}'; ccc --runtime podman stop`);
    });

    it("retains original errors in debug mode and for unexpected failures", () => {
        const expected = new ContainerRestartRequiredError("bind mismatch", "/workspace", "docker");
        expect(formatContainerStartupError(expected, true)).toBe(expected);
        const unexpected = new Error("unrelated setup failure");
        expect(formatContainerStartupError(unexpected)).toBe(unexpected);
        expect(formatContainerStartupError("unknown failure")).toBe("unknown failure");
    });
});

describe.runIf(process.platform !== "win32")("copyable POSIX restart command", () => {
    it.each([
        { runtime: "docker", profile: undefined, callerProfile: "other-profile", expectedProfile: "default" },
        { runtime: "podman", profile: "work", callerProfile: undefined, expectedProfile: "work" },
        { runtime: "docker", profile: "", callerProfile: "", expectedProfile: "default" },
    ] as const)("pins $runtime and $expectedProfile from the wrong cwd without changing the caller", ({ runtime, profile, callerProfile, expectedProfile }) => {
        const f = shellFixture("workspace with spaces");
        const command = posixCommand(formatContainerStartupError(new ContainerRestartRequiredError("bind mismatch", f.workspace, runtime, profile), false, "linux"));
        const { result, events } = f.run(command, callerProfile);
        expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
        expect(events).toEqual([
            { kind: "ccc", cwd: realpathSync(f.workspace), profile: expectedProfile, argv: ["--runtime", runtime, "stop"] },
            { kind: "caller", cwd: realpathSync(f.wrongCwd), profile: callerProfile ?? null, argv: [] },
        ]);
    });

    it("passes apostrophes and shell metacharacters literally without executing them", () => {
        const f = shellFixture("workspace ' ; touch injected-semicolon ; $(touch injected-substitution) `touch injected-backtick` & $HOME");
        const profile = "work ' ; touch injected-profile ; $(touch injected-profile-substitution)";
        const command = posixCommand(formatContainerStartupError(new ContainerRestartRequiredError("bind mismatch", f.workspace, "podman", profile), false, "linux"));
        const { result, events } = f.run(command, "caller-profile");
        expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
        expect(events).toEqual([
            { kind: "ccc", cwd: realpathSync(f.workspace), profile, argv: ["--runtime", "podman", "stop"] },
            { kind: "caller", cwd: realpathSync(f.wrongCwd), profile: "caller-profile", argv: [] },
        ]);
        for (const directory of [f.root, f.wrongCwd, f.workspace]) {
            for (const marker of ["injected-semicolon", "injected-substitution", "injected-backtick", "injected-profile", "injected-profile-substitution"]) {
                expect(existsSync(join(directory, marker))).toBe(false);
            }
        }
    });

    it("does not dispatch when the exact workspace is missing and preserves the caller", () => {
        const f = shellFixture(); const missing = join(f.root, "missing workspace");
        const command = posixCommand(formatContainerStartupError(new ContainerRestartRequiredError("bind mismatch", missing, "docker"), false, "linux"));
        const { result, events } = f.run(command, "caller-profile");
        expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0);
        expect(events).toEqual([{ kind: "caller", cwd: realpathSync(f.wrongCwd), profile: "caller-profile", argv: [] }]);
    });
});

describe("explicit lifecycle force guidance", () => {
    it("quotes the PowerShell operation, location and profile while retaining caller restoration", () => {
        const message = formatContainerLifecycleCommandHint({
            workspacePath: "C:\\Work Space\\repo's $env:USERPROFILE", runtime: "podman",
            profile: "work's $(Get-Date)", operation: "rm", force: true,
        }, "win32");
        expect(message).toContain("PowerShell:");
        expect(message).toContain("Push-Location -LiteralPath 'C:\\Work Space\\repo''s $env:USERPROFILE' -ErrorAction Stop");
        expect(message).toContain("try { $env:CCC_PROFILE = 'work''s $(Get-Date)'; ccc --runtime podman rm --force }");
        expect(message).toContain("finally { if ($cccHadProfile) { $env:CCC_PROFILE = $cccPreviousProfile }");
        expect(message).toContain("Remove-Item Env:CCC_PROFILE -ErrorAction SilentlyContinue }; Pop-Location");
    });
});

describe.runIf(process.platform !== "win32")("copyable POSIX force command", () => {
    it.each([
        { runtime: "docker", operation: "stop", profile: undefined, expectedProfile: "default" },
        { runtime: "podman", operation: "stop", profile: "work", expectedProfile: "work" },
        { runtime: "docker", operation: "rm", profile: "work", expectedProfile: "work" },
        { runtime: "podman", operation: "rm", profile: "", expectedProfile: "default" },
    ] as const)("pins $runtime $operation and $expectedProfile without changing the caller", ({ runtime, operation, profile, expectedProfile }) => {
        const f = shellFixture("workspace with spaces");
        const command = posixCommand(formatContainerLifecycleCommandHint({
            workspacePath: f.workspace, runtime, profile, operation, force: true,
        }, "linux"));
        const { result, events } = f.run(command, "caller-profile");
        expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
        expect(events).toEqual([
            { kind: "ccc", cwd: realpathSync(f.workspace), profile: expectedProfile, argv: ["--runtime", runtime, operation, "--force"] },
            { kind: "caller", cwd: realpathSync(f.wrongCwd), profile: "caller-profile", argv: [] },
        ]);
    });

    it.each(["stop", "rm"] as const)("passes metacharacters literally in a fenced %s command", operation => {
        const f = shellFixture("workspace ' ; touch injected-workspace ; $(touch injected-substitution) ``` & $HOME");
        const profile = "work ' ; touch injected-profile ; $(touch injected-profile-substitution)";
        const command = posixCommand(formatContainerLifecycleCommandHint({
            workspacePath: f.workspace, runtime: "podman", profile, operation, force: true,
        }, "linux"));
        const { result, events } = f.run(command, "caller-profile");
        expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
        expect(events).toEqual([
            { kind: "ccc", cwd: realpathSync(f.workspace), profile, argv: ["--runtime", "podman", operation, "--force"] },
            { kind: "caller", cwd: realpathSync(f.wrongCwd), profile: "caller-profile", argv: [] },
        ]);
        for (const directory of [f.root, f.wrongCwd, f.workspace]) {
            for (const marker of ["injected-workspace", "injected-substitution", "injected-profile", "injected-profile-substitution"]) {
                expect(existsSync(join(directory, marker))).toBe(false);
            }
        }
    });
});
