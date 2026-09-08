import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { pathToFileURL } from "url";
import { ensureWindowsServerEvaluationLicense, hyperVTestFiles, runHyperVLevel3, runHyperVTests, warnIfSetupDiagnosticsWillLackPrivilege } from "./hyper-v.ts";
import { repoRoot } from "./helpers.ts";
import {
    buildLevel3Artifacts,
    ensureHostBrokerReady,
    HYPER_V_LEVEL3_NETWORK_DIAGNOSTICS_CONTRACT,
    HYPER_V_LEVEL3_NETWORK_OWNERSHIP_CONTRACT,
    HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES,
    HYPER_V_LEVEL3_GUEST_DIAGNOSTICS_CONTRACT,
    HYPER_V_LEVEL3_PROVIDER_CONTRACT,
    HYPER_V_LEVEL3_POWERSHELL_DIRECT_BOUNDED_PROBE_CONTRACT,
    HYPER_V_LEVEL3_WINDOWS_UNATTEND_OOBE_SCHEMA_CONTRACT,
    HYPER_V_LEVEL3_WINDOWS_LIBRARY_CONTRACT,
    probeHostBrokerCapabilities,
} from "./support/level3-host.ts";

const verifiedBrokerPid = 4321;
const verifiedBrokerStartedAt = "2026-07-28T00:00:00.000Z";

function brokerStatusOutput(capabilities = HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES) {
    return [
        "port: 17373",
        "brokerReady: true",
        `brokerVerifiedCapabilities: ${capabilities.join(", ")}`,
        `brokerVerifiedPid: ${verifiedBrokerPid}`,
        `brokerVerifiedStartedAt: ${verifiedBrokerStartedAt}`,
    ].join("\n");
}

describe("Hyper-V Level 3 launcher", () => {
    it("requires the current Hyper-V network ownership contract", () => {
        expect(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES).toContain(HYPER_V_LEVEL3_NETWORK_OWNERSHIP_CONTRACT);
        expect(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES).toContain(HYPER_V_LEVEL3_GUEST_DIAGNOSTICS_CONTRACT);
        expect(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES).toContain(HYPER_V_LEVEL3_WINDOWS_UNATTEND_OOBE_SCHEMA_CONTRACT);
        expect(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES).toContain(HYPER_V_LEVEL3_POWERSHELL_DIRECT_BOUNDED_PROBE_CONTRACT);
        expect(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES).toContain(HYPER_V_LEVEL3_WINDOWS_LIBRARY_CONTRACT);
        expect(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES).toContain(HYPER_V_LEVEL3_PROVIDER_CONTRACT);
        expect(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES).toContain(HYPER_V_LEVEL3_NETWORK_DIAGNOSTICS_CONTRACT);
    });

    it("rejects a build whose compiled Hyper-V provider lacks the current contract", () => {
        const reads = new Map([
            ["/repo/dist/host-control/hyper-v/contracts.js", "export const oldContract = true;"],
        ]);
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = buildLevel3Artifacts("/repo", {
                spawn: () => ({ status: 0, stdout: "", stderr: "" }),
                readFile: (path: string) => reads.get(path) || "{}",
                writeFile: () => undefined,
            });
            expect(status).toBe(1);
            expect(diagnostic).toContain(HYPER_V_LEVEL3_PROVIDER_CONTRACT);
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("selects both Hyper-V providers by default", () => {
        expect(hyperVTestFiles("all").map((file) => basename(file))).toEqual([
            "level2-hyper-v-windows-vm.ts",
            "level2-hyper-v-linux-vm.ts",
        ]);
    });

    it("selects one Hyper-V provider when requested", () => {
        expect(hyperVTestFiles("windows").map((file) => basename(file))).toEqual(["level2-hyper-v-windows-vm.ts"]);
        expect(hyperVTestFiles("linux").map((file) => basename(file))).toEqual(["level2-hyper-v-linux-vm.ts"]);
    });

    it("loads split TypeScript host-control modules in the standalone real-test runner", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-hyper-v-source-loader-"));
        const fixture = join(tempDir, "level2-hyper-v-linux-vm.ts");
        const hostControlUrl = pathToFileURL(join(repoRoot, "src", "host-control", "hyper-v", "index.ts")).href;
        writeFileSync(fixture, [
            `import { HYPER_V_PROVIDER_IMAGE_FINALIZATION_CONTRACT } from ${JSON.stringify(hostControlUrl)};`,
            "export const name = 'host-control source loader';",
            "export async function run() {",
            "  return HYPER_V_PROVIDER_IMAGE_FINALIZATION_CONTRACT",
            "    ? { status: 'PASS' }",
            "    : { status: 'FAIL', reason: 'missing Hyper-V contract' };",
            "}",
        ].join("\n"));
        try {
            const sourceLoader = pathToFileURL(join(repoRoot, "scripts", "real-tests", "typescript-source-loader.mjs")).href;
            const result = spawnSync(process.execPath, [
                "--import",
                sourceLoader,
                join(repoRoot, "scripts", "real-tests", "run.ts"),
                "--compact",
                fixture,
            ], {
                cwd: tempDir,
                encoding: "utf8",
                timeout: 60_000,
            });
            expect(result.status, result.stderr || result.stdout).toBe(0);
            expect(result.stdout).toContain("SUMMARY real-tests total=1 pass=1 skip=0 fail=0");
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("rejects unknown targets", () => {
        expect(() => hyperVTestFiles("macos")).toThrow(/all, windows, linux/);
    });

    it("rejects unknown targets before taking the exclusive run lock", async () => {
        const calls: string[] = [];
        await expect(runHyperVLevel3(["--target", "macos"], {
            withExclusiveRealProviderRunImpl: async () => {
                calls.push("exclusive");
                return 0;
            },
            buildLevel3ArtifactsImpl: () => {
                calls.push("build");
                return 0;
            },
            ensureHostBrokerReadyImpl: () => {
                calls.push("broker");
                return 0;
            },
        })).rejects.toThrow("--target must be one of: all, windows, linux");
        expect(calls).toEqual([]);
    });

    it("rejects unknown targets before building when invoked directly", async () => {
        const calls: string[] = [];
        await expect(runHyperVTests("macos", {
            buildLevel3ArtifactsImpl: () => {
                calls.push("build");
                return 0;
            },
            ensureHostBrokerReadyImpl: () => {
                calls.push("broker");
                return 0;
            },
        })).rejects.toThrow("--target must be one of: all, windows, linux");
        expect(calls).toEqual([]);
    });

    it("builds artifacts and prepares the broker before running the selected provider", async () => {
        const calls: string[] = [];
        let runnerArgs: string[] = [];
        const warnSetupDiagnosticsPrivilegeImpl = vi.fn(() => false);
        const status = await runHyperVTests("windows", {
            // This caller goes through the SEAM and asserts it below; the two further down use
            // `platform: "linux"`, which is read by exactly one collaborator —
            // warnIfSetupDiagnosticsWillLackPrivilege; the license gate takes its own `licenseDeps`
            // bag. Either way, without one of them all three reach the production elevation probe
            // on a Windows dev host: a real powershell.exe spawn with a 10s timeout, and a write to
            // real stderr, from a unit test. The seam was added for exactly this and these callers
            // were left behind.
            //
            // At least one of the three has to use the seam rather than the platform guard, or
            // nothing defends the fix: deleting all three platform keys leaves this file green on
            // Linux, and the regression shows only on a Windows host — which is how it survived the
            // first time.
            warnSetupDiagnosticsPrivilegeImpl,
            env: { TEST_ENV: "1" },
            buildLevel3ArtifactsImpl: () => {
                calls.push("build");
                return 0;
            },
            ensureHostBrokerReadyImpl: () => {
                calls.push("broker");
                return 0;
            },
            runSupervisedProcessImpl: async (_command: string, args: string[]) => {
                runnerArgs = args;
                calls.push(`run:${basename(args.at(-1) || "")}`);
                return { status: 0 };
            },
        });
        expect(status).toBe(0);
        expect(warnSetupDiagnosticsPrivilegeImpl, "drop this key and the production probe spawns a real powershell.exe on Windows").toHaveBeenCalledWith("windows", expect.anything());
        expect(calls).toEqual(["build", "broker", "run:level2-hyper-v-windows-vm.ts"]);
        expect(runnerArgs.slice(0, 3)).toEqual([
            "--import",
            pathToFileURL(join(repoRoot, "scripts", "real-tests", "typescript-source-loader.mjs")).href,
            join(repoRoot, "scripts", "real-tests", "run.ts"),
        ]);
    });

    it("does not prepare the broker or run providers when the build fails", async () => {
        const calls: string[] = [];
        const status = await runHyperVTests("linux", {
            buildLevel3ArtifactsImpl: () => {
                calls.push("build");
                return 7;
            },
            ensureHostBrokerReadyImpl: () => {
                calls.push("broker");
                return 0;
            },
            runSupervisedProcessImpl: async () => {
                calls.push("run");
                return { status: 0 };
            },
        });
        expect(status).toBe(7);
        expect(calls).toEqual(["build"]);
    });

    it("does not run providers when broker attestation fails", async () => {
        const calls: string[] = [];
        const status = await runHyperVTests("windows", {
            platform: "linux", // see above: keeps the production elevation probe out of a unit test
            buildLevel3ArtifactsImpl: () => {
                calls.push("build");
                return 0;
            },
            ensureHostBrokerReadyImpl: async () => {
                calls.push("broker");
                return 1;
            },
            runSupervisedProcessImpl: async () => {
                calls.push("run");
                return { status: 0 };
            },
        });

        expect(status).toBe(1);
        expect(calls).toEqual(["build", "broker"]);
    });

    it("attests the repaired broker Hyper-V capability generation", async () => {
        const status = await ensureHostBrokerReady("/repo", {
            spawn: () => ({
                status: 0,
                stdout: brokerStatusOutput(),
                stderr: "",
            }),
            probeHostBrokerCapabilitiesImpl: async () => ({
                ok: true,
                capabilities: HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES,
                pid: verifiedBrokerPid,
                startedAt: verifiedBrokerStartedAt,
            }),
        });

        expect(status).toBe(0);
    });

    it("bounds the complete Windows broker repair and preserves spawn failures after partial output", async () => {
        let diagnostic = "";
        const observedTimeouts: number[] = [];
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                repairTimeoutMs: 123456,
                spawn: (_command: string, _args: string[], options: { timeout?: number }) => {
                    observedTimeouts.push(Number(options.timeout));
                    return {
                        status: null,
                        signal: "SIGTERM",
                        stdout: "partial broker output",
                        stderr: "",
                        error: Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" }),
                    };
                },
            });

            expect(status).toBe(1);
            expect(observedTimeouts).toHaveLength(1);
            expect(observedTimeouts[0]).toBeGreaterThan(123000);
            expect(observedTimeouts[0]).toBeLessThanOrEqual(123456);
            expect(diagnostic).toContain("partial broker output");
            expect(diagnostic).toContain("CCC host broker repair preflight failed");
            expect(diagnostic).toContain("spawn timed out");
            expect(diagnostic).toContain("timeoutMs=123456");
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("shares one repair deadline across initial status, remote attestation, and confirmation", async () => {
        const observedStatusTimeouts: number[] = [];
        let observedProbeTimeout = 0;
        const now = vi.spyOn(Date, "now")
            .mockReturnValueOnce(1000)
            .mockReturnValueOnce(1000)
            .mockReturnValueOnce(1040)
            .mockReturnValueOnce(1060);
        try {
            const status = await ensureHostBrokerReady("/repo", {
                repairTimeoutMs: 100,
                spawn: (_command: string, _args: string[], options: { timeout?: number }) => {
                    observedStatusTimeouts.push(Number(options.timeout));
                    return {
                        status: 0,
                        signal: null,
                        stdout: brokerStatusOutput(),
                        stderr: "",
                    };
                },
                probeHostBrokerCapabilitiesImpl: async (_port: number, options: { timeoutMs?: number }) => {
                    observedProbeTimeout = Number(options.timeoutMs);
                    return {
                        ok: true,
                        capabilities: HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES,
                        pid: verifiedBrokerPid,
                        startedAt: verifiedBrokerStartedAt,
                    };
                },
            });

            expect(status).toBe(0);
            expect(observedStatusTimeouts).toEqual([100, 40]);
            expect(observedProbeTimeout).toBe(60);
        } finally {
            now.mockRestore();
        }
    });

    it("rejects a healthy broker that did not attest the candidate Hyper-V generation", async () => {
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                spawn: () => ({
                    status: 0,
                    stdout: brokerStatusOutput([
                        "hyper-v-vm-managed-auto-images-v19",
                        "hyper-v-windows-boot-contract-v1",
                    ]),
                    stderr: "",
                }),
            });

            expect(status).toBe(1);
            expect(diagnostic).toContain("hyper-v-vm-managed-auto-images-v20");
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("rejects a broker that predates the Windows boot contract", async () => {
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                spawn: () => ({
                    status: 0,
                    stdout: brokerStatusOutput([
                        "hyper-v-vm-managed-auto-images-v20",
                        "hyper-v-windows-iso-unattend-v1",
                    ]),
                    stderr: "",
                }),
            });

            expect(status).toBe(1);
            expect(diagnostic).toContain("hyper-v-windows-boot-contract-v1");
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("rejects a broker that predates the Windows unattend oobe schema contract", async () => {
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                spawn: () => ({
                    status: 0,
                    stdout: brokerStatusOutput(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES
                        .filter((capability) => capability !== HYPER_V_LEVEL3_WINDOWS_UNATTEND_OOBE_SCHEMA_CONTRACT)),
                    stderr: "",
                }),
            });

            expect(status).toBe(1);
            expect(diagnostic).toContain(HYPER_V_LEVEL3_WINDOWS_UNATTEND_OOBE_SCHEMA_CONTRACT);
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("rejects a broker that predates bounded PowerShell Direct probes", async () => {
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                spawn: () => ({
                    status: 0,
                    stdout: brokerStatusOutput(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES
                        .filter((capability) => capability !== HYPER_V_LEVEL3_POWERSHELL_DIRECT_BOUNDED_PROBE_CONTRACT)),
                    stderr: "",
                }),
            });

            expect(status).toBe(1);
            expect(diagnostic).toContain(HYPER_V_LEVEL3_POWERSHELL_DIRECT_BOUNDED_PROBE_CONTRACT);
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("rejects a broker that predates the internal Hyper-V Windows library", async () => {
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                spawn: () => ({
                    status: 0,
                    stdout: brokerStatusOutput(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES
                        .filter((capability) => capability !== HYPER_V_LEVEL3_WINDOWS_LIBRARY_CONTRACT)),
                    stderr: "",
                }),
            });

            expect(status).toBe(1);
            expect(diagnostic).toContain(HYPER_V_LEVEL3_WINDOWS_LIBRARY_CONTRACT);
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("rejects a stale broker observed after CLI repair attestation", async () => {
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                spawn: () => ({
                    status: 0,
                    stdout: brokerStatusOutput(),
                    stderr: "",
                }),
                probeHostBrokerCapabilitiesImpl: async () => ({
                    ok: true,
                    capabilities: [
                        "hyper-v-vm-managed-auto-images-v18",
                        "hyper-v-windows-boot-contract-v1",
                    ],
                    pid: verifiedBrokerPid,
                    startedAt: verifiedBrokerStartedAt,
                }),
            });

            expect(status).toBe(1);
            expect(diagnostic).toContain("remote capability attestation failed");
            expect(diagnostic).toContain("hyper-v-vm-managed-auto-images-v20");
            expect(diagnostic).toContain("hyper-v-vm-managed-auto-images-v18");
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("reads capabilities directly from the running loopback broker", async () => {
        const capabilities = [
            ...HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES,
            "http-health",
        ];
        const observed = await probeHostBrokerCapabilities(17373, {
            fetchImpl: async (url: string) => {
                expect(url).toBe("http://127.0.0.1:17373/status");
                return new Response(JSON.stringify({
                    ok: true,
                    broker: {
                        implemented: capabilities,
                        process: { pid: verifiedBrokerPid },
                        startedAt: verifiedBrokerStartedAt,
                    },
                }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            },
        });

        expect(observed).toEqual({
            ok: true,
            capabilities,
            pid: verifiedBrokerPid,
            startedAt: verifiedBrokerStartedAt,
        });
    });

    it("rejects an oversized direct broker status response before reading it", async () => {
        let bodyRead = false;
        const observed = await probeHostBrokerCapabilities(17373, {
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                headers: {
                    get: (name: string) => name === "content-length" ? String(256 * 1024 + 1) : null,
                },
                text: async () => {
                    bodyRead = true;
                    return "{}";
                },
            }),
        });

        expect(observed).toEqual({ ok: false, error: "response-too-large", capabilities: [] });
        expect(bodyRead).toBe(false);
    });

    it("cancels a chunked broker status response at the byte limit", async () => {
        let cancelled = false;
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(200 * 1024));
                controller.enqueue(new Uint8Array(100 * 1024));
            },
            cancel() {
                cancelled = true;
            },
        });
        const observed = await probeHostBrokerCapabilities(17373, {
            fetchImpl: async () => new Response(body, { status: 200 }),
        });

        expect(observed).toEqual({ ok: false, error: "response-too-large", capabilities: [] });
        expect(cancelled).toBe(true);
    });

    it("rejects a broker process identity change between repair and confirmation", async () => {
        let statusCalls = 0;
        const status = await ensureHostBrokerReady("/repo", {
            spawn: () => {
                statusCalls += 1;
                return {
                    status: 0,
                    stdout: statusCalls === 1
                        ? brokerStatusOutput()
                        : brokerStatusOutput().replace(
                            `brokerVerifiedPid: ${verifiedBrokerPid}`,
                            `brokerVerifiedPid: ${verifiedBrokerPid + 1}`,
                        ),
                    stderr: "",
                };
            },
            probeHostBrokerCapabilitiesImpl: async () => ({
                ok: true,
                capabilities: HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES,
                pid: verifiedBrokerPid,
                startedAt: verifiedBrokerStartedAt,
            }),
        });

        expect(status).toBe(1);
        expect(statusCalls).toBe(2);
    });

    it("fails when the broker status command exits zero without readiness", async () => {
        const status = await ensureHostBrokerReady("/repo", {
            spawn: () => ({
                status: 0,
                stdout: "brokerReady: false\n",
                stderr: "",
            }),
        });

        expect(status).toBe(1);
    });
});

describe("Windows Server evaluation license prompt", () => {
    const baseDeps = (overrides: any = {}) => ({
        platform: "win32",
        selectHyperVWindowsProfileImpl: () => "windows-server",
        readReceiptImpl: () => null,
        acceptLicenseImpl: vi.fn(),
        stdout: { write: vi.fn() },
        isInteractive: true,
        promptYesNoImpl: async () => true,
        ...overrides,
    });

    it("is a no-op off Windows without prompting or accepting", async () => {
        const deps = baseDeps({ platform: "linux", promptYesNoImpl: vi.fn(async () => true) });
        const result = await ensureWindowsServerEvaluationLicense("windows", deps);
        expect(result).toEqual({ ok: true, reason: "non-windows-host" });
        expect(deps.acceptLicenseImpl).not.toHaveBeenCalled();
        expect(deps.promptYesNoImpl).not.toHaveBeenCalled();
    });

    it("is a no-op for a linux-only target on Windows", async () => {
        const deps = baseDeps();
        expect(await ensureWindowsServerEvaluationLicense("linux", deps)).toEqual({ ok: true, reason: "linux-target" });
        expect(deps.acceptLicenseImpl).not.toHaveBeenCalled();
    });

    it("is a no-op when the selected profile is not windows-server", async () => {
        const deps = baseDeps({ selectHyperVWindowsProfileImpl: () => "windows-11" });
        expect(await ensureWindowsServerEvaluationLicense("windows", deps)).toEqual({ ok: true, reason: "not-windows-server-profile" });
        expect(deps.acceptLicenseImpl).not.toHaveBeenCalled();
    });

    it("is a no-op when the evaluation receipt already exists (no prompt)", async () => {
        const deps = baseDeps({ readReceiptImpl: () => ({ version: 2 }), promptYesNoImpl: vi.fn(async () => true) });
        expect(await ensureWindowsServerEvaluationLicense("all", deps)).toEqual({ ok: true, reason: "already-accepted" });
        expect(deps.promptYesNoImpl).not.toHaveBeenCalled();
        expect(deps.acceptLicenseImpl).not.toHaveBeenCalled();
    });

    it("does not hang when acceptance is missing on a non-interactive run", async () => {
        const deps = baseDeps({ isInteractive: false, promptYesNoImpl: vi.fn(async () => true) });
        const result = await ensureWindowsServerEvaluationLicense("windows", deps);
        expect(result).toEqual({ ok: false, reason: "license-required-non-interactive" });
        expect(deps.promptYesNoImpl).not.toHaveBeenCalled();
        expect(deps.acceptLicenseImpl).not.toHaveBeenCalled();
    });

    it("records acceptance once when the user answers yes interactively", async () => {
        const deps = baseDeps({ promptYesNoImpl: async () => true });
        const result = await ensureWindowsServerEvaluationLicense("windows", deps);
        expect(result).toEqual({ ok: true, reason: "accepted-now" });
        expect(deps.acceptLicenseImpl).toHaveBeenCalledTimes(1);
    });

    it("declines without recording acceptance when the user answers no", async () => {
        const deps = baseDeps({ promptYesNoImpl: async () => false });
        const result = await ensureWindowsServerEvaluationLicense("windows", deps);
        expect(result).toEqual({ ok: false, reason: "license-declined" });
        expect(deps.acceptLicenseImpl).not.toHaveBeenCalled();
    });

    it("stops runHyperVTests before the provider run when the license gate is not ok", async () => {
        const runSupervisedProcessImpl = vi.fn(async () => ({ status: 0 }));
        const status = await runHyperVTests("windows", {
            platform: "linux", // see above: keeps the production elevation probe out of a unit test
            buildLevel3ArtifactsImpl: () => 0,
            ensureWindowsEvaluationLicenseImpl: async () => ({ ok: false, reason: "license-declined" }),
            ensureHostBrokerReadyImpl: async () => 0,
            runSupervisedProcessImpl,
        });
        expect(status).toBe(1);
        expect(runSupervisedProcessImpl).not.toHaveBeenCalled();
    });
    // The warning exists because a real host only revealed the missing privilege after two minutes
    // of booting a VM, and then reported it as an unreadable host-locale blob. Warning before the
    // wait is the whole point, so the placement matters as much as the text.
    it("warns before the run when Windows Setup diagnostics will lack the privilege they need", () => {
        const lines: string[] = [];
        // The resolver's return value is asserted to reach the probe. resolveTrustedWindowsPowerShell
        // exists to stop a bare PATH lookup for powershell.exe; replacing the call-site argument
        // with the literal "powershell.exe" — reintroducing exactly that — left the whole suite
        // green. Both impls were injected and nothing checked the wiring between them, so the
        // hardening could be deleted in a cleanup with no test objecting.
        const trustedPowerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        const isAdministratorImpl = vi.fn(() => false);
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("windows", {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => trustedPowerShell,
            isAdministratorImpl,
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(true);
        expect(isAdministratorImpl, "the probe must get the resolved trusted path, not a PATH lookup").toHaveBeenCalledWith({ powerShellPath: trustedPowerShell });
        const output = lines.join("");
        expect(output, "must name the code the operator will actually see").toContain("hyper-v-setup-diagnostics-mount-privilege-required");
        expect(output, "must say what to do").toContain("elevated terminal");
        expect(output, "must not imply the VM lifecycle is broken").toContain("lifecycle itself is unaffected");
    });

    // The other half of the same mutation, and the half the call-site assertion above does NOT
    // close. Every one of the five warn tests injects both impls, so neither production default is
    // ever executed by this suite: replacing only the default binding with
    // `|| (() => "powershell.exe")` leaves 40/40 green, and tsc says nothing because the now-unused
    // import is not flagged. So the hardening could still be removed from the live path with
    // nothing objecting. Executing the real defaults is not an option — on Windows that spawns the
    // powershell.exe this whole change exists to keep out of unit tests — so the binding is pinned
    // as source text instead, which is what the mutation actually edits.
    it("keeps the trusted resolver and the real probe as the production defaults", () => {
        const source = readFileSync(join(repoRoot, "scripts", "real-tests", "hyper-v.ts"), "utf8");
        expect(source).toContain("dependencies.resolveTrustedWindowsPowerShellImpl || resolveTrustedWindowsPowerShell");
        expect(source).toContain("dependencies.isAdministratorImpl || isAdministrator");
    });

    it("stays silent when the run is already elevated", () => {
        const lines: string[] = [];
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("windows", {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => "C:\\Windows\\System32\\powershell.exe",
            isAdministratorImpl: () => true,
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(false);
        expect(lines).toEqual([]);
    });

    // Off Windows there is no privilege to lack, and probing would spawn a PowerShell that is not
    // there. This is also what keeps the linux suite from printing a Windows warning.
    it("does not probe for elevation off Windows", () => {
        const lines: string[] = [];
        const isAdministratorImpl = vi.fn(() => false);
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("windows", {
            platform: "linux",
            isAdministratorImpl,
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(false);
        expect(isAdministratorImpl).not.toHaveBeenCalled();
        expect(lines).toEqual([]);
    });

    // A probe that throws must not be reported as "not elevated" — that would tell an operator to
    // re-run elevated when they may already be. Say only what is known.
    it("reports an undetermined probe as undetermined, not as unelevated", () => {
        const lines: string[] = [];
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("windows", {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => { throw new Error("hyper-v-library-elevation-system-root-invalid"); },
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(false);
        expect(lines.join("")).toContain("Could not determine whether this run is elevated");
    });
    // D3: the diagnostic is Windows-only. captureHyperVWindowsSetupDiagnostics is reached solely
    // through level2-hyper-v-windows-vm.ts, so a linux target never captures it — warning there
    // would send the operator to redo a run for something that target does not collect.
    it("does not warn about Windows Setup diagnostics for a linux target", () => {
        const lines: string[] = [];
        const isAdministratorImpl = vi.fn(() => false);
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("linux", {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => "C:\\Windows\\System32\\powershell.exe",
            isAdministratorImpl,
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(false);
        expect(isAdministratorImpl, "must not even probe for a target that never mounts").not.toHaveBeenCalled();
        expect(lines).toEqual([]);
    });

    // The inclusion the exclusion above is carved out of, and the one that was untested: `all` is
    // what runHyperVLevel3 defaults to, so `npm run test:level3:hyper-v` with no --target lands
    // here. Narrowing the guard to `target !== "windows"` left the whole suite green, which means
    // the most-used invocation silently lost its warning and nothing said so.
    it("warns for the default all target, which includes the Windows provider", () => {
        const lines: string[] = [];
        const isAdministratorImpl = vi.fn(() => false);
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("all", {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => "C:\\Windows\\System32\\powershell.exe",
            isAdministratorImpl,
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(true);
        expect(isAdministratorImpl).toHaveBeenCalledOnce();
        expect(lines.join("")).toContain("hyper-v-setup-diagnostics-mount-privilege-required");
    });

    // D2: every other collaborator in runHyperVTests is injectable. Before this was, three existing
    // tests reached the production probe and spawned a real powershell.exe on a Windows dev host —
    // a unit test making a 10s process call, three times, and writing to real stderr.
    it("takes the elevation probe as an injectable dependency, and warns before paying for a build", async () => {
        const calls: string[] = [];
        const warnSetupDiagnosticsPrivilegeImpl = vi.fn((target: string) => {
            calls.push(`warn:${target}`);
            return true;
        });
        await runHyperVTests("windows", {
            warnSetupDiagnosticsPrivilegeImpl,
            buildLevel3ArtifactsImpl: () => {
                calls.push("build");
                return 0;
            },
            ensureWindowsEvaluationLicenseImpl: async () => {
                calls.push("license");
                return { ok: true };
            },
            ensureHostBrokerReadyImpl: () => {
                calls.push("broker");
                return 0;
            },
            runSupervisedProcessImpl: async () => {
                calls.push("run");
                return { status: 0 };
            },
        });
        expect(warnSetupDiagnosticsPrivilegeImpl).toHaveBeenCalledOnce();
        // Order is the assertion. The NOTE asks for a re-run, and a re-run costs another build, so
        // warning after the build makes the operator pay for it twice.
        expect(calls).toEqual(["warn:windows", "build", "license", "broker", "run"]);
    });
});
