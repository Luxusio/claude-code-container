import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { assertHyperVLinuxCreateContract, hyperVLinuxBrokerArgs, hyperVLinuxToolPayload, hyperVLinuxVmE2ECapability, writeHyperVLinuxFailureDiagnostic } from "./hyper-v-linux-vm-e2e.ts";
import {
    createPackagedCccCandidate,
    hyperVWindowsVmE2ECapability,
    resolveNpmCliPath,
    selectHyperVWindowsProfile,
} from "./hyper-v-windows-vm-e2e.ts";
import { brokerToolFailureEvidence, formatBrokerToolFailure } from "./device-lab-mcp-client.ts";
import {
    HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
    HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
    HYPER_V_WINDOWS_SOURCE_TRUST_ID,
    HYPER_V_WINDOWS_SOURCE_URL,
} from "../../src/device-lab/hyper-v-image-contracts.ts";

const readiness = JSON.stringify({
    available: true,
    moduleAvailable: true,
    hypervisorPresent: true,
    vmmsRunning: true,
    rebootPending: false,
    totalMemoryMb: 32768,
    freeMemoryMb: 16384,
    logicalProcessors: 8,
    missing: [],
});

function spawnReady(_command: string, args: string[]) {
    if (args[0] === "ssh.exe" || args[0] === "scp.exe") return { status: 0, stdout: `${args[0]}\n` };
    return { status: 0, stdout: readiness };
}

afterEach(() => {
    delete process.env.CCC_REAL_HYPER_V_WINDOWS_SOURCE_IMAGE;
    delete process.env.CCC_REAL_HYPER_V_LINUX_SOURCE_IMAGE;
});

describe("Hyper-V E2E zero-config image selection", () => {
    it("finds the npm CLI beside the active Windows Node installation during direct invocation", () => {
        const nodeRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-node-install-"));
        const npmExecPath = join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js");
        mkdirSync(join(nodeRoot, "node_modules", "npm", "bin"), { recursive: true });
        writeFileSync(npmExecPath, "// test npm cli");
        try {
            expect(resolveNpmCliPath({
                nodePath: join(nodeRoot, "node.exe"),
            })).toBe(npmExecPath);
            expect(resolveNpmCliPath({
                env: { npm_execpath: join(nodeRoot, "attacker.js") },
                nodePath: join(nodeRoot, "node.exe"),
            })).toBe(npmExecPath);
        } finally {
            rmSync(nodeRoot, { recursive: true, force: true });
        }
    });

    it("builds the guest probe from an npm package artifact without invoking package scripts", () => {
        const outputDir = mkdtempSync(join(tmpdir(), "ccc-hyper-v-package-test-"));
        const npmExecPath = join(outputDir, "node_modules", "npm", "bin", "npm-cli.js");
        mkdirSync(dirname(npmExecPath), { recursive: true });
        writeFileSync(npmExecPath, "// test npm cli");
        try {
            const candidate = createPackagedCccCandidate(outputDir, {
                nodePath: join(outputDir, "node.exe"),
                spawnSyncImpl: (command: string, args: string[]) => {
                    expect(command).toBe(join(outputDir, "node.exe"));
                    expect(args).toEqual(expect.arrayContaining([npmExecPath, "pack", "--json", "--ignore-scripts", "--pack-destination", outputDir]));
                    writeFileSync(join(outputDir, "claude-code-container-test.tgz"), "package");
                    return { status: 0, stdout: JSON.stringify([{ filename: "claude-code-container-test.tgz" }]), stderr: "" };
                },
            });
            expect(candidate.packagePath).toBe(join(outputDir, "claude-code-container-test.tgz"));
            expect(candidate.version).toMatch(/^\d+\.\d+\.\d+$/);
        } finally {
            rmSync(outputDir, { recursive: true, force: true });
        }
    });

    it("rejects package artifact paths reported outside the pack destination", () => {
        const outputDir = mkdtempSync(join(tmpdir(), "ccc-hyper-v-package-path-test-"));
        const npmExecPath = join(outputDir, "node_modules", "npm", "bin", "npm-cli.js");
        mkdirSync(dirname(npmExecPath), { recursive: true });
        writeFileSync(npmExecPath, "// test npm cli");
        try {
            expect(() => createPackagedCccCandidate(outputDir, {
                nodePath: join(outputDir, "node.exe"),
                spawnSyncImpl: () => ({
                    status: 0,
                    stdout: JSON.stringify([{ filename: "../outside.tgz" }]),
                    stderr: "",
                }),
            })).toThrow(/unsafe package artifact filename/);
        } finally {
            rmSync(outputDir, { recursive: true, force: true });
        }
    });

    it("rejects a reported package artifact that is not a regular file", () => {
        const outputDir = mkdtempSync(join(tmpdir(), "ccc-hyper-v-package-type-test-"));
        const npmExecPath = join(outputDir, "node_modules", "npm", "bin", "npm-cli.js");
        mkdirSync(dirname(npmExecPath), { recursive: true });
        writeFileSync(npmExecPath, "// test npm cli");
        mkdirSync(join(outputDir, "not-a-package.tgz"));
        try {
            expect(() => createPackagedCccCandidate(outputDir, {
                nodePath: join(outputDir, "node.exe"),
                spawnSyncImpl: () => ({
                    status: 0,
                    stdout: JSON.stringify([{ filename: "not-a-package.tgz" }]),
                    stderr: "",
                }),
            })).toThrow(/regular package artifact/);
        } finally {
            rmSync(outputDir, { recursive: true, force: true });
        }
    });

    it("selects the official Windows Server profile when no override or Windows 11 cache exists", () => {
        expect(selectHyperVWindowsProfile({ existsSyncImpl: () => false })).toBe("windows-server");
        expect(hyperVWindowsVmE2ECapability({
            platform: "win32",
            powershell: "powershell.exe",
            spawnSyncImpl: spawnReady,
            existsSyncImpl: () => false,
            readEvaluationReceiptImpl: () => ({ acceptedAt: "2026-01-01T00:00:00.000Z" }),
        })).toMatchObject({ available: true, sourceImage: "", profile: "windows-server" });
    });

    it("reports the one-time Windows evaluation acceptance as a prerequisite", () => {
        expect(hyperVWindowsVmE2ECapability({
            platform: "win32",
            powershell: "powershell.exe",
            spawnSyncImpl: spawnReady,
            existsSyncImpl: () => false,
            readEvaluationReceiptImpl: () => null,
        })).toEqual({
            available: false,
            reason: "Windows evaluation license acceptance not recorded; run ccc devices setup hyper-v --confirm --accept-windows-evaluation-license",
        });
    });

    it("accepts the version 2 receipt written by Hyper-V setup", () => {
        const setupRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-setup-test-"));
        try {
            writeFileSync(join(setupRoot, "hyper-v-windows-evaluation-license.json"), JSON.stringify({
                version: 2,
                licenseId: HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
                licenseUrl: HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
                sourceTrustId: HYPER_V_WINDOWS_SOURCE_TRUST_ID,
                sourceUrl: HYPER_V_WINDOWS_SOURCE_URL,
                acceptedAt: "2026-01-01T00:00:00.000Z",
            }));
            expect(hyperVWindowsVmE2ECapability({
                platform: "win32",
                powershell: "powershell.exe",
                spawnSyncImpl: spawnReady,
                existsSyncImpl: () => false,
                setupRoot,
            })).toMatchObject({ available: true, profile: "windows-server" });
        } finally {
            rmSync(setupRoot, { recursive: true, force: true });
        }
    });

    it("selects Windows 11 for an explicit source override", () => {
        process.env.CCC_REAL_HYPER_V_WINDOWS_SOURCE_IMAGE = "C:\\images\\windows-11.vhdx";
        expect(selectHyperVWindowsProfile({ existsSyncImpl: () => false })).toBe("windows-11");
    });

    it("selects Windows 11 when its cached manifest exists", () => {
        expect(selectHyperVWindowsProfile({
            existsSyncImpl: () => true,
            readFileSyncImpl: () => JSON.stringify({ version: 3, profile: "windows-11", imagePath: "C:\\cache\\base.vhdx" }),
        })).toBe("windows-11");
        expect(selectHyperVWindowsProfile({
            existsSyncImpl: () => true,
            readFileSyncImpl: () => JSON.stringify({ version: 2, profile: "windows-11", imagePath: "C:\\cache\\base.vhdx" }),
        })).toBe("windows-server");
    });

    it("checks the owner-scoped Windows 11 cache before the shared catalog cache", () => {
        const checked: string[] = [];
        const ownerId = "0123456789abcdef";
        expect(selectHyperVWindowsProfile({
            ownerId,
            existsSyncImpl: (path: string) => { checked.push(path); return true; },
            readFileSyncImpl: () => JSON.stringify({ version: 3, profile: "windows-11", imagePath: "C:\\cache\\base.vhdx" }),
        })).toBe("windows-11");
        expect(checked[0]).toBe(join(homedir(), ".ccc", "device-broker-private", "owners", ownerId, "images", "hyper-v", "windows-11", "manifest.json"));
        expect(checked).not.toContain(join(homedir(), ".ccc", "devices", "owners", ownerId, "images", "hyper-v", "windows-11", "manifest.json"));
    });

    it("falls back to the private shared Windows 11 catalog cache", () => {
        const ownerId = "0123456789abcdef";
        const ownerManifest = join(homedir(), ".ccc", "device-broker-private", "owners", ownerId, "images", "hyper-v", "windows-11", "manifest.json");
        const sharedManifest = join(homedir(), ".ccc", "device-broker-private", "images", "hyper-v", "windows-11", "manifest.json");
        const imagePath = "C:\\cache\\base.vhdx";
        const checked: string[] = [];
        expect(selectHyperVWindowsProfile({
            ownerId,
            existsSyncImpl: (path: string) => {
                checked.push(path);
                return path === sharedManifest || path === imagePath;
            },
            readFileSyncImpl: () => JSON.stringify({ version: 3, profile: "windows-11", imagePath }),
        })).toBe("windows-11");
        expect(checked.slice(0, 2)).toEqual([ownerManifest, sharedManifest]);
    });

    it("keeps Linux E2E available without a source override so the broker can auto-acquire Ubuntu", () => {
        expect(hyperVLinuxVmE2ECapability({
            platform: "win32",
            powershell: "powershell.exe",
            ssh: "ssh.exe",
            scp: "scp.exe",
            spawnSyncImpl: spawnReady,
        })).toMatchObject({ available: true, sourceImage: "" });
    });

    it("reports the exact missing Hyper-V Linux create response field", () => {
        const device = {
            id: "linux-hyper-v-real-e2e-contract",
            guestTransport: "ssh",
            switchName: "CCC Device Lab",
            networkAddress: "172.29.0.10",
        };
        expect(() => assertHyperVLinuxCreateContract(device, device.id)).toThrow(
            "hyper-v-linux-create-response-invalid: guestProvisioned expected true, received missing",
        );
    });

    it("accepts the complete sanitized Hyper-V Linux create response", () => {
        const device = {
            id: "linux-hyper-v-real-e2e-contract",
            guestProvisioned: true,
            guestTransport: "ssh",
            switchName: "CCC Device Lab",
            networkAddress: "172.29.0.10",
        };
        expect(() => assertHyperVLinuxCreateContract(device, device.id)).not.toThrow();
    });

    it("forces every Hyper-V Linux E2E operation through the broker", () => {
        expect(hyperVLinuxBrokerArgs("device_create", {
            backend: "linux-vm",
            provider: "container-qemu",
            viaBroker: false,
        })).toEqual({
            backend: "linux-vm",
            provider: "hyper-v",
            viaBroker: true,
        });
        expect(hyperVLinuxBrokerArgs("device_status", {
            backend: "linux-vm",
            viaBroker: false,
        })).toEqual({
            backend: "linux-vm",
            viaBroker: true,
        });
    });

    it("bounds Hyper-V Linux create response diagnostics", () => {
        const hugeField = "x".repeat(10_000);
        let diagnostic = "";
        try {
            assertHyperVLinuxCreateContract({ [hugeField]: true }, "linux-hyper-v-real-e2e-contract");
        } catch (error) {
            diagnostic = error instanceof Error ? error.message : String(error);
        }
        expect(diagnostic).toContain("hyper-v-linux-create-response-invalid");
        expect(diagnostic.length).toBeLessThan(1_500);
        expect(diagnostic).not.toContain("x".repeat(65));
    });

    it("keeps broker transport timeout fields out of public device_create calls", () => {
        for (const file of ["hyper-v-windows-vm-e2e.ts", "hyper-v-linux-vm-e2e.ts"]) {
            const source = readFileSync(new URL(file, import.meta.url), "utf8");
            expect(source).not.toContain("rpcTimeoutMs:");
        }
    });

    it("reports nested broker provisioning diagnostics without dumping unbounded output", () => {
        const message = formatBrokerToolFailure({
            ok: false,
            error: "broker-operation-failed",
            transportRecovery: {
                attempted: true,
                recovered: false,
                initial: { endpoint: "https://token@host/C:\\Users\\Luxus\\private" },
                retry: { stderr: "token=secret" },
            },
            body: {
                error: "hyper-v-linux-seed-failed",
                provisioning: {
                    status: 1,
                    diagnosticCode: "hyper-v-provisioning-media-stream-invalid",
                    signal: "token=secret C:\\Users\\Luxus\\private",
                    error: "token=secret C:\\Users\\Luxus\\private",
                    stdout: `prefix-${"x".repeat(2000)}`,
                    stderr: `prefix-${"y".repeat(3000)}`,
                },
            },
        }, "fallback");
        expect(message).toContain("broker-operation-failed");
        expect(message).toContain("hyper-v-linux-seed-failed");
        expect(message).toContain("hyper-v-provisioning-media-stream-invalid");
        expect(message).not.toContain("prefix-");
        expect(message).not.toContain("token=secret");
        expect(message).not.toContain("C:\\Users");
        expect(message.length).toBeLessThan(512);
    });

    it("preserves structured evidence from MCP isError responses", () => {
        const brokerPayload = {
            ok: false,
            error: "broker-operation-failed",
            body: {
                error: "hyper-v-guest-not-ready",
                result: {
                    boot: {
                        provider: "hyper-v-ssh",
                        error: "ssh-connection-timeout",
                    },
                },
            },
        };
        let failure: any;
        try {
            hyperVLinuxToolPayload({
                isError: true,
                content: [{ type: "text", text: JSON.stringify(brokerPayload) }],
            });
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect(failure.brokerPayload).toEqual(brokerPayload);
        expect(failure.message).toContain("hyper-v-guest-not-ready");
        expect(failure.message).toContain("ssh-connection-timeout");
    });

    it("reports redacted Hyper-V network execution diagnostics", () => {
        const message = formatBrokerToolFailure({
            ok: false,
            error: "hyper-v-network-setup-failed",
            body: {
                error: "hyper-v-network-setup-failed",
                detail: "hyper-v-network-pipe-handshake-timeout",
                execution: {
                    mode: "exec",
                    provider: "hyper-v",
                    status: 1,
                    stdoutPresent: true,
                    stderrPresent: true,
                    outputRedacted: true,
                    diagnosticCode: "hyper-v-network-pipe-handshake-timeout",
                    error: "token=secret-error",
                    stdout: "token=secret-stdout",
                    stderr: "token=secret-stderr",
                },
            },
            attempts: [{
                port: 17373,
                status: 502,
                durationMs: 35120,
                timeoutMs: 21615000,
            }],
        }, "fallback");
        expect(message).toContain("hyper-v-network-setup-failed");
        expect(message).toContain("hyper-v-network-pipe-handshake-timeout");
        expect(message).toContain('"diagnosticCode":"hyper-v-network-pipe-handshake-timeout"');
        expect(message).not.toContain("stdoutPresent");
        expect(message).not.toContain("stderrPresent");
        expect(message).not.toContain("token=secret");
        expect(message.length).toBeLessThan(1024);
    });

    it("ignores unredacted network execution objects", () => {
        const message = formatBrokerToolFailure({
            ok: false,
            error: "hyper-v-network-setup-failed",
            body: {
                execution: {
                    outputRedacted: false,
                    diagnosticCode: "hyper-v-network-pipe-handshake-timeout",
                    stdout: "token=secret-stdout",
                    stderr: "token=secret-stderr",
                },
            },
        }, "fallback");
        expect(message).toBe("hyper-v-network-setup-failed");
        expect(message).not.toContain("diagnosticCode");
        expect(message).not.toContain("token=secret");
    });

    it("reports the bounded final broker transport attempt without exposing endpoints or bodies", () => {
        const message = formatBrokerToolFailure({
            ok: false,
            error: "broker-rpc-unavailable",
            attempts: [
                {
                    host: "https://token@host/C:\\Users\\Luxus/private/home/secret",
                    port: 17373,
                    endpoint: "http://127.0.0.1:17373/v1/owners/secret/rpc",
                    body: { ownerToken: "secret" },
                    error: `fetch failed token=secret C:\\Users\\Luxus\\private ${"x".repeat(1000)}`,
                    durationMs: 630010,
                    timeoutMs: 630000,
                },
            ],
        }, "fallback");
        expect(message).toContain("broker-rpc-unavailable");
        expect(message).toContain('"error":"fetch-failed"');
        expect(message).toContain('"durationMs":630010');
        expect(message).toContain('"timeoutMs":630000');
        expect(message).not.toContain("/v1/owners");
        expect(message).not.toContain("ownerToken");
        expect(message).not.toContain("token=secret");
        expect(message).not.toContain("token@host");
        expect(message).not.toContain("C:\\Users");
        expect(message).not.toContain("/home/");
        expect(message.length).toBeLessThan(1024);
    });

    it("reports bounded Hyper-V transport recovery without exposing raw transport details", () => {
        const message = formatBrokerToolFailure({
            ok: false,
            error: "broker-rpc-unavailable",
            transportRecovery: {
                attempted: true,
                recovered: false,
                initial: {
                    port: 17373,
                    error: "connection-reset",
                    brokerPid: 29744,
                    brokerDiagnostics: ["hyper-v-network-setup-failed"],
                },
                retry: {
                    port: 17373,
                    error: "connection-refused",
                    brokerDiagnostics: [],
                },
            },
            attempts: [{
                port: 17373,
                transportCode: "connection-refused",
                error: "socket detail token=secret C:\\Users\\Luxus\\private",
                durationMs: 4426,
                timeoutMs: 21615000,
            }],
        }, "fallback");

        expect(message).toContain('"attempted":true');
        expect(message).toContain('"recovered":false');
        expect(message).toContain('"error":"connection-reset"');
        expect(message).toContain("hyper-v-network-setup-failed");
        expect(message).not.toContain("brokerPid");
        expect(message).not.toContain("token=secret");
        expect(message).not.toContain("C:\\Users");
    });

    it("reports bounded broker process verification diagnostics", () => {
        const message = formatBrokerToolFailure({
            ok: false,
            error: "broker-runtime-process-unverified",
            host: "https://token@host/C:\\Users\\Luxus\\private\\secret",
            port: 17373,
            runtime: {
                pid: 4321,
                command: "C:\\private\\node.exe",
                args: ["C:\\private\\dist\\index.js"],
            },
            attempts: [{
                reason: "broker-reuse-process-unverified",
                processVerification: { ok: false, source: "unverified-broker-port-process" },
            }],
        }, "fallback");

        expect(message).toContain("broker-runtime-process-unverified");
        expect(message).toContain('"reason":"broker-reuse-process-unverified"');
        expect(message).toContain('"source":"unverified-broker-port-process"');
        expect(message).not.toContain('"runtimePid"');
        expect(message).not.toContain("token@host");
        expect(message).not.toContain("C:\\private");
        expect(message).not.toContain("C:\\Users");
    });

    it("reports bounded Hyper-V guest readiness diagnostics without exposing command output", () => {
        const message = formatBrokerToolFailure({
            ok: false,
            error: "broker-operation-failed",
            body: {
                error: "hyper-v-guest-not-ready",
                result: {
                    boot: {
                        ready: false,
                        provider: "hyper-v-ssh",
                        error: "ssh-readiness-marker-missing",
                        readiness: {
                            managedSshAttempts: 3,
                            bootstrapProbeAttempts: 2,
                            bootstrapProbeSuccesses: 2,
                            bootstrapAddressCount: 1,
                            bootstrapSshAttempts: 2,
                            bootstrapSshLastStatus: 0,
                            bootstrapSshLastError: "ssh-readiness-marker-missing",
                            networkFinalizeAttempts: 0,
                            networkFinalizeSucceeded: false,
                            guestSignalObserved: true,
                            elapsedMs: 12345,
                            privateAddress: "172.16.0.2",
                        },
                        diagnosticAvailable: false,
                        diagnosticError: "hyper-v-guest-boot-diagnostic-command-failed",
                    },
                    execution: {
                        command: {
                            hyperVGuestReady: {
                                stderr: "token=secret C:\\Users\\Luxus\\private",
                            },
                        },
                    },
                },
            },
        }, "fallback");
        expect(message).toContain("hyper-v-guest-not-ready");
        expect(message).toContain('"error":"ssh-readiness-marker-missing"');
        expect(message).toContain('"bootstrapSshLastStatus":0');
        expect(message).toContain('"bootstrapSshLastError":"ssh-readiness-marker-missing"');
        expect(message).toContain('"bootstrapAddressCount":1');
        expect(message).toContain('"guestSignalObserved":true');
        expect(message).toContain('"diagnosticError":"hyper-v-guest-boot-diagnostic-');
        expect(message).not.toContain("private-vm-name");
        expect(message).not.toContain("172.16.0.2");
        expect(message).not.toContain("diskPath");
        expect(message).not.toContain("token=secret");
        expect(message).not.toContain("C:\\Users");
        expect(message).not.toContain("172.16.0.2");
        expect(message.length).toBeLessThan(600);
    });

    it("does not invent missing Hyper-V readiness booleans", () => {
        const evidence = brokerToolFailureEvidence({
            body: {
                result: {
                    boot: {
                        provider: "hyper-v-ssh",
                        error: "ssh-unavailable",
                        readiness: {
                            managedSshAttempts: 1,
                            bootstrapProbeLastStatus: -1,
                            bootstrapProbeLastError: "C:\\Users\\private token=secret",
                            bootstrapSshLastStatus: -1,
                            bootstrapSshLastError: "C:\\Users\\private token=secret",
                        },
                    },
                },
            },
        }) as any;
        expect(evidence.boot.readiness).toEqual(expect.objectContaining({ managedSshAttempts: 1 }));
        expect(evidence.boot.readiness.bootstrapProbeLastStatus).toBeUndefined();
        expect(evidence.boot.readiness.bootstrapProbeLastError).toBeUndefined();
        expect(evidence.boot.readiness.bootstrapSshLastStatus).toBeUndefined();
        expect(evidence.boot.readiness.bootstrapSshLastError).toBeUndefined();
        expect(JSON.stringify(evidence)).not.toContain("bootstrapProbeLastStatus");
        expect(JSON.stringify(evidence)).not.toContain("bootstrapProbeLastError");
        expect(evidence.boot.readiness).not.toHaveProperty("networkFinalizeSucceeded");
        expect(evidence.boot.readiness).not.toHaveProperty("guestSignalObserved");
    });

    it("keeps Hyper-V boot diagnostics ahead of long nested wrapper details", () => {
        const message = formatBrokerToolFailure({
            error: "broker-operation-failed",
            detail: `hyper-v-guest-not-ready: ${"outer".repeat(200)}`,
            body: {
                error: "hyper-v-guest-not-ready",
                detail: `powershell-direct-session-unavailable: ${"inner".repeat(200)}`,
                result: {
                    boot: {
                        provider: "hyper-v-powershell-direct",
                        error: "powershell-direct-session-unavailable",
                        diagnosticAvailable: true,
                        diagnostic: {
                            state: "Running",
                            uptimeMs: 600123,
                            generation: 1,
                            secureBootEnabled: null,
                            heartbeatEnabled: true,
                            heartbeatPrimaryStatus: 2,
                            heartbeatSecondaryStatus: 0,
                            integrationServices: [{ name: "Heartbeat", enabled: true, primaryStatus: 2, secondaryStatus: 0 }],
                            hardDiskCount: 1,
                            dvdCount: 1,
                            hardDiskControllers: ["ide"],
                            bootDeviceTypes: ["hard-disk", "dvd", "network", "unknown", "hard-disk", "dvd", "network", "unknown"],
                            diagnosticComplete: false,
                            diagnosticErrors: ["hyper-v-diagnostic-integration-services-unavailable"],
                        },
                    },
                },
            },
        }, "fallback");
        expect(message.slice(0, 600)).toContain('boot={"provider":"hyper-v-powershell-direct"');
        expect(message.slice(0, 600)).toContain('"heartbeat":true');
        expect(message.slice(0, 600)).toContain('"diagnosticComplete":false');
        expect(message.slice(0, 600)).toContain('"diagnosticErrors":["hyper-v-diagnostic-integration-services-unavailable"]');
        expect(message.slice(0, 600)).toContain('"boot":["hard-disk","dvd","network"]');
        expect(message).not.toContain("outerouter");
        expect(message).not.toContain("innerinner");
        expect(message.length).toBeLessThan(600);
    });

    it("preserves full safe Hyper-V boot topology in a durable failure diagnostic", () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-diagnostic-"));
        const failure = {
            error: "broker-operation-failed",
            endpoint: "http://127.0.0.1/private?token=secret",
            body: {
                error: "hyper-v-guest-not-ready",
                result: {
                    boot: {
                        provider: "hyper-v-ssh",
                        error: "ssh-connection-timeout",
                        readiness: {
                            managedSshAttempts: 4,
                            bootstrapProbeAttempts: 4,
                            bootstrapProbeSuccesses: 4,
                            bootstrapProbeLastStatus: 0,
                            bootstrapProbeLastError: "hyper-v-bootstrap-neighbor-inspection-failed",
                            bootstrapAddressCount: 1,
                            bootstrapSshAttempts: 4,
                            bootstrapSshLastStatus: 255,
                            bootstrapSshLastError: "ssh-connection-timeout",
                            networkFinalizeAttempts: 0,
                            networkFinalizeSucceeded: false,
                            guestSignalObserved: true,
                            elapsedMs: 300000,
                            privateAddress: "172.16.0.2",
                        },
                        diagnosticAvailable: true,
                        diagnostic: {
                            state: "Running",
                            uptimeMs: 1200000,
                            generation: 2,
                            secureBootEnabled: false,
                            heartbeatEnabled: null,
                            heartbeatPrimaryStatus: null,
                            heartbeatSecondaryStatus: null,
                            integrationServices: [{ name: "Heartbeat", enabled: true, primaryStatus: 2, secondaryStatus: 0 }],
                            hardDiskCount: 1,
                            dvdCount: 1,
                            hardDiskControllers: ["scsi"],
                            bootDeviceTypes: ["hard-disk", "dvd", "network", "unknown"],
                            bootEntries: [{ bootType: "Drive", deviceType: "HardDiskDrive", controllerType: "SCSI", controllerNumber: 0, controllerLocation: 0, diskPath: "C:\\Users\\Luxus\\private.vhdx" }],
                            hardDisks: [{ controllerType: "scsi", controllerNumber: 0, controllerLocation: 0, vhdFormat: "VHDX", vhdType: "Dynamic", sizeBytes: 34359738368, fileSizeBytes: 4294967296, minimumSizeBytes: 3221225472, logicalSectorSize: 512, physicalSectorSize: 4096, path: "C:\\Users\\Luxus\\private.vhdx" }],
                            dvdDrives: [{ controllerType: "scsi", controllerNumber: 0, controllerLocation: 1, mediaAttached: true, path: "C:\\Users\\Luxus\\seed.iso" }],
                            diagnosticComplete: true,
                            diagnosticErrors: [],
                        },
                    },
                },
            },
        };
        const error = new Error("unsafe C:\\Users\\Luxus\\private token=secret");
        Object.defineProperty(error, "brokerPayload", { value: failure });
        try {
            const paths = writeHyperVLinuxFailureDiagnostic({ outputRoot, step: "start and wait for SSH", created: true, error });
            const content = readFileSync(paths.latestPath, "utf8");
            const record = JSON.parse(content);
            expect(record.failure.boot.readiness).toEqual({
                managedSshAttempts: 4,
                bootstrapProbeAttempts: 4,
                bootstrapProbeSuccesses: 4,
                bootstrapProbeLastStatus: 0,
                bootstrapProbeLastError: "hyper-v-bootstrap-neighbor-inspection-failed",
                bootstrapAddressCount: 1,
                bootstrapSshAttempts: 4,
                bootstrapSshLastStatus: 255,
                bootstrapSshLastError: "ssh-connection-timeout",
                networkFinalizeAttempts: 0,
                networkFinalizeSucceeded: false,
                guestSignalObserved: true,
                elapsedMs: 300000,
            });
            expect(record.failure.boot.diagnostic.bootEntries).toHaveLength(1);
            expect(record.failure.boot.diagnostic.hardDisks[0]).toEqual(expect.objectContaining({ vhdFormat: "VHDX", logicalSectorSize: 512, physicalSectorSize: 4096 }));
            expect(record.failure.boot.diagnostic.dvdDrives[0]).toEqual(expect.objectContaining({ mediaAttached: true }));
            expect(content).not.toContain("token=secret");
            expect(content).not.toContain("C:\\Users");
            expect(content).not.toContain("172.16.0.2");
            expect(content).not.toContain('"endpoint":');
            expect(content).not.toContain("diskPath");
            expect(content).not.toContain("deviceId");
            expect(readFileSync(paths.timestampedPath, "utf8")).toBe(content);
            const generic = writeHyperVLinuxFailureDiagnostic({ outputRoot, step: "assert contract", created: false, error: new Error("authentication failed token=secret") });
            const genericContent = readFileSync(generic.latestPath, "utf8");
            expect(genericContent).toContain("failure-message-redacted");
            expect(genericContent).not.toContain("token=secret");
        } finally {
            rmSync(outputRoot, { recursive: true, force: true });
        }
    });

    it("keeps the Windows E2E receipt contract free of product file-I/O imports", () => {
        const source = readFileSync(new URL("hyper-v-windows-vm-e2e.ts", import.meta.url), "utf8");
        expect(source).toContain("hyper-v-image-contracts.ts");
        expect(source).not.toContain("hyper-v-images.ts");
    });
});
