import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { assertHyperVLinuxCreateContract, HYPER_V_LINUX_PRE_REBOOT_COMMAND, hyperVLinuxBrokerArgs, hyperVLinuxToolPayload, hyperVLinuxVmE2ECapability, prepareHyperVLinuxDownloadDestination, writeHyperVLinuxFailureDiagnostic } from "./hyper-v-linux-vm-e2e.ts";
import {
    createPackagedCccCandidate,
    HYPER_V_WINDOWS_CONSOLE_TIMELINE_DELAYS_MS,
    hyperVWindowsFailureReason,
    hyperVWindowsVmE2ECapability,
    resolveNpmCliPath,
    scheduleHyperVWindowsConsoleTimeline,
    selectHyperVWindowsProfile,
} from "./hyper-v-windows-vm-e2e.ts";
import { captureHyperVWindowsSetupDiagnostics } from "./hyper-v-windows-setup-diagnostics.ts";
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

    it("resolves the pack artifact when npm --json returns an object (Windows) via the deterministic tarball name", () => {
        const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
        const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
        const sanitizedName = String(pkg.name).replace(/^@/, "").replace(/\//g, "-");
        const expectedFilename = `${sanitizedName}-${pkg.version}.tgz`;
        const outputDir = mkdtempSync(join(tmpdir(), "ccc-hyper-v-package-object-test-"));
        const npmExecPath = join(outputDir, "node_modules", "npm", "bin", "npm-cli.js");
        mkdirSync(dirname(npmExecPath), { recursive: true });
        writeFileSync(npmExecPath, "// test npm cli");
        try {
            const candidate = createPackagedCccCandidate(outputDir, {
                nodePath: join(outputDir, "node.exe"),
                spawnSyncImpl: () => {
                    // Windows npm emits `--json` as an object (no top-level filename) and still
                    // writes the tarball to --pack-destination under the deterministic name.
                    writeFileSync(join(outputDir, expectedFilename), "package");
                    return { status: 0, stdout: "{}", stderr: "" };
                },
            });
            expect(candidate.packagePath).toBe(join(outputDir, expectedFilename));
            expect(candidate.version).toBe(String(pkg.version));
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

    it("pre-creates the Linux E2E download destination without replacing an existing path", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-hyper-v-linux-download-"));
        const nested = join(root, "results", "device-lab-real");
        const destination = join(nested, "download.txt");
        mkdirSync(nested, { recursive: true });
        try {
            prepareHyperVLinuxDownloadDestination(destination);
            expect(readFileSync(destination, "utf8")).toBe("");
            expect(() => prepareHyperVLinuxDownloadDestination(destination)).toThrow();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("flushes the validated managed network before the destructive reboot probe", () => {
        expect(HYPER_V_LINUX_PRE_REBOOT_COMMAND).toContain("sudo test -s /etc/netplan/99-ccc-static.yaml");
        expect(HYPER_V_LINUX_PRE_REBOOT_COMMAND).toContain("sudo netplan generate");
        expect(HYPER_V_LINUX_PRE_REBOOT_COMMAND).toContain("sudo sync");
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
                            bootstrapHostKeyObserved: true,
                            bootstrapHostKeyMatchesExpected: false,
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
        expect(message).toContain('"bootstrapHostKeyObserved":true');
        expect(message).toContain('"bootstrapHostKeyMatchesExpected":false');
        expect(message).toContain('"bootstrapAddressCount":1');
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
                            bootstrapHostKeyObserved: "yes",
                            bootstrapHostKeyMatchesExpected: "no",
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
        expect(evidence.boot.readiness.bootstrapHostKeyObserved).toBeUndefined();
        expect(evidence.boot.readiness.bootstrapHostKeyMatchesExpected).toBeUndefined();
        expect(JSON.stringify(evidence)).not.toContain("bootstrapProbeLastStatus");
        expect(JSON.stringify(evidence)).not.toContain("bootstrapProbeLastError");
        expect(evidence.boot.readiness).not.toHaveProperty("networkFinalizeSucceeded");
        expect(evidence.boot.readiness).not.toHaveProperty("guestSignalObserved");
    });

    it("surfaces the bounded broker detail code so masked reconciliation failures stay distinguishable", () => {
        const evidence = brokerToolFailureEvidence({
            error: "hyper-v-delete-reconciliation-failed",
            body: {
                error: "hyper-v-delete-reconciliation-failed",
                detail: "hyper-v-vm-identity-conflict",
            },
        }) as any;
        expect(evidence.error).toBe("hyper-v-delete-reconciliation-failed");
        expect(evidence.bodyError).toBe("hyper-v-delete-reconciliation-failed");
        expect(evidence.detail).toBe("hyper-v-vm-identity-conflict");
    });

    it("omits broker detail that is not a bounded diagnostic code", () => {
        const evidence = brokerToolFailureEvidence({
            error: "hyper-v-delete-reconciliation-failed",
            body: {
                error: "hyper-v-delete-reconciliation-failed",
                detail: "C:\\Users\\private token=secret",
            },
        }) as any;
        expect(evidence).not.toHaveProperty("detail");
        expect(JSON.stringify(evidence)).not.toContain("C:\\Users");
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

    it("keeps guest-readiness diagnosticErrors within the 511-char cap for a large boot observation", () => {
        const services = Array.from({ length: 8 }, (_, index) => ({
            name: `Integration Service Number ${index} With A Fairly Long Name`,
            enabled: index % 2 === 0,
            primaryStatus: 2,
            secondaryStatus: 0,
        }));
        const message = formatBrokerToolFailure({
            error: "broker-operation-failed",
            body: {
                error: "hyper-v-guest-not-ready",
                result: {
                    boot: {
                        provider: "hyper-v-powershell-direct",
                        error: "powershell-direct-session-unavailable",
                        diagnostic: {
                            state: "Running",
                            uptimeMs: 1202182,
                            generation: 2,
                            secureBootEnabled: true,
                            heartbeatEnabled: false,
                            heartbeatPrimaryStatus: null,
                            heartbeatSecondaryStatus: null,
                            integrationServices: services,
                            hardDiskCount: 1,
                            dvdCount: 1,
                            hardDiskControllers: ["scsi", "ide", "scsi"],
                            bootDeviceTypes: ["hard-disk", "dvd", "network", "unknown", "hard-disk", "dvd", "network", "unknown"],
                            diagnosticComplete: false,
                            diagnosticErrors: ["hyper-v-diagnostic-integration-services-unavailable"],
                        },
                    },
                },
            },
        }, "fallback");
        // With a large topology payload the actionable guest-readiness codes must still survive the cap.
        expect(message.slice(0, 511)).toContain('"diagnosticComplete":false');
        expect(message.slice(0, 511)).toContain('"diagnosticErrors":["hyper-v-diagnostic-integration-services-unavailable"]');
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
                            bootstrapHostKeyObserved: true,
                            bootstrapHostKeyMatchesExpected: false,
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
                bootstrapHostKeyObserved: true,
                bootstrapHostKeyMatchesExpected: false,
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

    it("captures the Windows guest console before cleanup while preserving the original failure", () => {
        const calls: any[] = [];
        const base = {
            profile: "windows-server",
            step: "start and wait for PowerShell Direct",
            error: new Error("hyper-v-guest-not-ready: diagnosticErrors=integration-services-incomplete"),
            created: true,
            deviceId: "windows-vm-real-e2e-123",
            incarnationId: "0123456789abcdef0123456789abcdef",
            vmId: "12345678-1234-4123-8123-123456789abc",
            powershell: "powershell.exe",
            ownerId: "0123456789abcdef",
            platform: "win32",
        };
        const success = hyperVWindowsFailureReason({
            ...base,
            captureImpl: (input: any) => {
                calls.push(input);
                return {
                    ok: true,
                    latestRelativePath: "results/device-lab-real/hyper-v-windows-console-latest.png",
                    latestPath: "ignored",
                    timestampedPath: "ignored",
                };
            },
            setupDiagnosticsImpl: () => ({
                ok: true,
                latestRelativePath: "results/device-lab-real/hyper-v-windows-setup-diagnostics-latest.json",
                latestPath: "ignored",
                timestampedPath: "ignored",
            }),
        });
        expect(calls).toEqual([expect.objectContaining({
            ownerId: "0123456789abcdef",
            deviceId: "windows-vm-real-e2e-123",
            incarnationId: "0123456789abcdef0123456789abcdef",
            powershell: "powershell.exe",
            platform: "win32",
        })]);
        expect(success).toBe("profile=windows-server; guestConsole=results/device-lab-real/hyper-v-windows-console-latest.png; guestSetupDiagnostics=results/device-lab-real/hyper-v-windows-setup-diagnostics-latest.json; start and wait for PowerShell Direct: hyper-v-guest-not-ready: diagnosticErrors=integration-services-incomplete");

        const unavailable = hyperVWindowsFailureReason({
            ...base,
            sourceImage: "C:\\images\\windows.vhdx",
            captureImpl: () => ({ ok: false, code: "hyper-v-console-wmi-access-denied" }),
            setupDiagnosticsImpl: () => ({ ok: false, code: "hyper-v-setup-diagnostics-mount-failed" }),
        });
        expect(unavailable).toContain("profile=windows-server sourceImage=set; guestConsole=unavailable(hyper-v-console-wmi-access-denied);");
        expect(unavailable).toContain("guestSetupDiagnostics=unavailable(hyper-v-setup-diagnostics-mount-failed);");
        expect(unavailable).toContain("hyper-v-guest-not-ready: diagnosticErrors=integration-services-incomplete");

        const unexpected = hyperVWindowsFailureReason({
            ...base,
            captureImpl: () => { throw new Error("C:\\Users\\private token=secret"); },
            setupDiagnosticsImpl: () => { throw new Error("C:\\Users\\private token=secret"); },
        });
        expect(unexpected).toContain("guestConsole=unavailable(hyper-v-console-unexpected-failure)");
        expect(unexpected).toContain("guestSetupDiagnostics=unavailable(hyper-v-setup-diagnostics-unexpected-failure)");
        expect(unexpected).not.toContain("token=secret");
        expect(unexpected).toContain("hyper-v-guest-not-ready");
    });

    it("captures bounded, redacted Windows Setup diagnostics from an exact read-only VHD mount", () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-windows-setup-diagnostics-"));
        const decodedPrograms: string[] = [];
        let calls = 0;
        try {
            const captured = captureHyperVWindowsSetupDiagnostics({
                ownerId: "0123456789abcdef",
                deviceId: "windows-vm-real-e2e-123",
                incarnationId: "0123456789abcdef0123456789abcdef",
                vmId: "12345678-1234-4123-8123-123456789abc",
                powershell: "powershell.exe",
                platform: "win32",
                outputRoot,
                now: () => new Date("2026-08-30T00:00:00.000Z"),
                spawnSyncImpl: (_command, args) => {
                    decodedPrograms.push(Buffer.from(args.at(-1) || "", "base64").toString("utf16le"));
                    calls += 1;
                    if (calls === 1) {
                        return { status: 0, stdout: JSON.stringify({ ok: true, diskPath: "C:\\state\\root.vhdx" }) };
                    }
                    return {
                        status: 0,
                        stdout: JSON.stringify({
                            ok: true,
                            logs: [{
                                path: "Windows\\Panther\\UnattendGC\\setuperr.log",
                                lines: [
                                    "Error processing <Value>SuperSecret!</Value> password=AnotherSecret C:\\Users\\Luxus\\private",
                                    "Error password=\"my secret phrase\" token=still-secret HRESULT=0x1",
                                    "Error reading C:\\Users\\Luxus\\private\\unattend.xml",
                                    "Shell-Setup oobeSystem rejected setting 0x8007000d",
                                ],
                            }],
                        }),
                    };
                },
            });
            expect(captured).toMatchObject({
                ok: true,
                latestRelativePath: "results/device-lab-real/hyper-v-windows-setup-diagnostics-latest.json",
            });
            expect(decodedPrograms).toHaveLength(2);
            const [preflightProgram, diagnosticProgram] = decodedPrograms;
            expect(preflightProgram).toContain("Get-VM -Id $ExpectedId -ErrorAction Stop");
            expect(preflightProgram).toContain("$Drives.Count -ne 1");
            expect(preflightProgram).toContain("[string]::IsNullOrWhiteSpace([string]$Drives[0].Path)");
            expect(preflightProgram).not.toContain("Where-Object");
            expect(preflightProgram).not.toContain("Stop-VM");
            expect(preflightProgram).not.toContain("Remove-VMHardDiskDrive");
            expect(diagnosticProgram).toContain("Get-VM -Id $ExpectedId -ErrorAction Stop");
            expect(diagnosticProgram).toContain("$Vm.Name -cne $VmName");
            expect(diagnosticProgram).toContain("[string]$Vm.Notes -cne $ExpectedMarker");
            expect(diagnosticProgram).toContain("ccc-device-lab:0123456789abcdef:windows-vm-real-e2e-123:0123456789abcdef0123456789abcdef");
            expect(diagnosticProgram).toContain("$ExpectedDisk = 'C:\\state\\root.vhdx'");
            expect(diagnosticProgram).toContain("$Drives.Count -ne 1");
            expect(diagnosticProgram).toContain("Stop-VM -VM $Vm -TurnOff -Force");
            expect(diagnosticProgram).toContain("Remove-VMHardDiskDrive -VMHardDiskDrive $Drives[0] -ErrorAction Stop");
            expect(diagnosticProgram).toContain("$RemainingDrives.Count -ne 0");
            expect(diagnosticProgram).toContain("Mount-VHD -Path $DiskPath -ReadOnly -PassThru");
            expect(diagnosticProgram).toContain("for ($Attempt = 1; $Attempt -le 10; $Attempt++)");
            // Backoff to a 15 s ceiling: a flat 1 s gave the detached VHD handle only 10 s to be
            // released, which a real host exhausted on every attempt.
            expect(diagnosticProgram).toContain("$MountSleep = [Math]::Min(15000, 1000 * [Math]::Pow(2, $Attempt - 1))");
            // The sleep is inside the comparison, so the budget is 60 s, not 60 s plus one ceiling.
            expect(diagnosticProgram).toContain("if ($Attempt -lt 10 -and [DateTime]::UtcNow.AddMilliseconds($MountSleep) -lt $MountDeadline) { Start-Sleep -Milliseconds $MountSleep }");
            // The retry budget must stay a known share of the process budget, or overrunning kills
            // the process and the mount detail is never read at all.
            expect(diagnosticProgram).toContain("$MountDeadline = [DateTime]::UtcNow.AddMilliseconds(60000)");
            expect(diagnosticProgram).toContain("elseif ($Attempt -lt 10) { break }");
            expect(diagnosticProgram).toContain("$MountMessage = [string]$_.Exception.Message");
            // Redaction happens on the reading side only. A guest-side user-profile rule split
            // `C:\Users\<name with space>\...` at the first space, so the reader's whole-path rule
            // saw a fragment with no drive letter and the name survived beside a marker that read
            // as complete. This also keeps the fixtures below honest: they feed the reader exactly
            // what the guest emits, so a passing assertion describes the real pipeline.
            // Pins the class, not one spelling: `-replace`, `[Regex]::` (PowerShell is
            // case-insensitive) and a spacing variant all slipped past a literal string check.
            expect(diagnosticProgram.match(/\$MountMessage\s*=[^\n]*/g)).toEqual([
                "$MountMessage = $null",
                "$MountMessage = [string]$_.Exception.Message",
            ]);
            expect(diagnosticProgram).toContain("hresult = $MountHResult; message = $MountMessage");
            expect(diagnosticProgram).toContain("if (-not $Mounted) { throw 'hyper-v-setup-diagnostics-mount-failed' }");
            expect(diagnosticProgram.match(/Mount-VHD -Path/g)).toHaveLength(1);
            const stopCommandIndex = diagnosticProgram.indexOf("Stop-VM -VM $Vm -TurnOff -Force");
            const stopVerificationIndex = diagnosticProgram.indexOf("$Vm.State -ne 'Off'", stopCommandIndex);
            const detachTimeQueryIndex = diagnosticProgram.indexOf("$Drives = @(Get-VMHardDiskDrive", stopVerificationIndex);
            const detachIndex = diagnosticProgram.indexOf("Remove-VMHardDiskDrive");
            const detachPathIndex = diagnosticProgram.indexOf("$DetachPath = [IO.Path]::GetFullPath", detachTimeQueryIndex);
            const detachPathComparisonIndex = diagnosticProgram.indexOf("[string]::Equals($DetachPath", detachTimeQueryIndex);
            expect(stopVerificationIndex).toBeGreaterThan(stopCommandIndex);
            expect(detachTimeQueryIndex).toBeGreaterThan(stopVerificationIndex);
            expect(detachPathIndex).toBeGreaterThan(detachTimeQueryIndex);
            expect(detachPathComparisonIndex).toBeGreaterThan(detachPathIndex);
            expect(detachPathComparisonIndex).toBeLessThan(detachIndex);
            expect(detachTimeQueryIndex).toBeLessThan(detachIndex);
            expect(diagnosticProgram.indexOf("Remove-VMHardDiskDrive")).toBeLessThan(diagnosticProgram.indexOf("Mount-VHD"));
            expect(diagnosticProgram.indexOf("$Mounted = $true")).toBeLessThan(diagnosticProgram.indexOf("Get-Disk -ErrorAction Stop"));
            expect(diagnosticProgram).toContain("Dismount-VHD -Path $DiskPath -ErrorAction Stop");
            expect(diagnosticProgram.indexOf("Dismount-VHD")).toBeLessThan(diagnosticProgram.indexOf("$Result | ConvertTo-Json"));
            expect(diagnosticProgram).not.toContain("Add-VMHardDiskDrive");
            expect(diagnosticProgram).not.toMatch(/Get-VMHardDiskDrive[^\n]*Where-Object/);
            const content = readFileSync((captured as any).latestPath, "utf8");
            expect(content).toContain("Shell-Setup oobeSystem rejected setting 0x8007000d");
            expect(content).toContain("<Value>[redacted]</Value>");
            expect(content).toContain("password=[redacted]");
            expect(content).toContain("[user-profile]");
            expect(content).not.toContain("SuperSecret");
            expect(content).not.toContain("AnotherSecret");
            expect(content).not.toContain("my secret phrase");
            expect(content).not.toContain("still-secret");
            expect(content).not.toContain("Luxus");
        } finally {
            rmSync(outputRoot, { recursive: true, force: true });
        }
    });

    it("contains Windows Setup diagnostic failures and rejects unrestricted log paths", () => {
        const base = {
            ownerId: "0123456789abcdef",
            deviceId: "windows-vm-real-e2e-123",
            incarnationId: "0123456789abcdef0123456789abcdef",
            vmId: "12345678-1234-4123-8123-123456789abc",
            powershell: "powershell.exe",
            platform: "win32",
        };
        const run = (mainResult: object) => {
            let calls = 0;
            const result = captureHyperVWindowsSetupDiagnostics({
                ...base,
                spawnSyncImpl: () => {
                    calls += 1;
                    if (calls === 1) return { status: 0, stdout: JSON.stringify({ ok: true, diskPath: "C:\\state\\root.vhdx" }) };
                    if (calls === 2) return { status: 0, stdout: JSON.stringify(mainResult) };
                    return { status: 0, stdout: JSON.stringify({ ok: true, detached: true }) };
                },
            });
            expect(calls).toBe(3);
            return result;
        };
        expect(run({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed",
            mount: { attempts: 10, category: "ResourceBusy", hresult: 2147024891 },
        })).toEqual({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed[a=10,c=ResourceBusy,h=2147024891]",
        });
        // The message is the only field that ever names the cause: a real host reported
        // NotSpecified/0x80131500, which says nothing. It is appended, and it is redacted.
        expect(run({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed",
            mount: { attempts: 10, category: "ResourceBusy", hresult: 2147024891, message: "The process cannot access the file" },
        })).toEqual({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed[a=10,c=ResourceBusy,h=2147024891,m=The process cannot access the file]",
        });
        // Both orderings: the secret rule is anchored at end-of-input with no multiline flag, so
        // redacting before collapsing newlines would only ever catch a secret on the last line.
        // `a=8` rather than 10 because the retry deadline trips first when mounts fail fast, which
        // is what a real host reports.
        expect(run({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed",
            mount: { attempts: 8, category: "ResourceBusy", hresult: 2147024891, message: "denied for C:\\Users\\Luxus\\disk.vhdx\npassword: hunter2" },
        })).toEqual({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed[a=8,c=ResourceBusy,h=2147024891,m=denied for (host-path) password=(redacted)]",
        });
        expect(run({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed",
            mount: { attempts: 8, category: "ResourceBusy", hresult: 2147024891, message: "password: hunter2\ndenied for C:\\Users\\Luxus\\disk.vhdx" },
        })).toEqual({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed[a=8,c=ResourceBusy,h=2147024891,m=password=(redacted)]",
        });
        // The likeliest real message names the disk by absolute path, which is not under Users and
        // so was invisible to the user-profile rule alone.
        expect(run({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed",
            mount: { attempts: 8, category: "ResourceBusy", hresult: 2147024891, message: "The process cannot access the file 'D:\\device-lab\\owner-9f2\\disk.vhdx' because it is being used." },
        })).toEqual({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed[a=8,c=ResourceBusy,h=2147024891,m=The process cannot access the file '(host-path)' because it is being used.]",
        });
        // A path with a space, and a UNC path. Stopping at the first space left a fragment — here a
        // surname — beside a marker that read as though redaction had completed.
        expect(run({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed",
            mount: { attempts: 8, category: "ResourceBusy", hresult: 2147024891, message: "cannot open C:\\Users\\Kyeong Jae\\device-lab\\disk.vhdx now" },
        })).toEqual({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed[a=8,c=ResourceBusy,h=2147024891,m=cannot open (host-path) now]",
        });
        expect(run({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed",
            mount: { attempts: 8, category: "ResourceBusy", hresult: 2147024891, message: "cannot open \\\\fileserver\\share\\device-lab\\disk.vhdx; retry later" },
        })).toEqual({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed[a=8,c=ResourceBusy,h=2147024891,m=cannot open (host-path), retry later]",
        });
        // The default Hyper-V VHD location has two space-bearing components. Looking ahead only one
        // segment stopped at "Virtual" and left "Hard Disks\..." exposed.
        expect(run({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed",
            mount: { attempts: 8, category: "ResourceBusy", hresult: 2147024891, message: "cannot open C:\\Program Files\\Virtual Hard Disks\\disk.vhdx now" },
        })).toEqual({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed[a=8,c=ResourceBusy,h=2147024891,m=cannot open (host-path) now]",
        });
        // The look-ahead past a space must stay bounded. Unbounded, any later backslash pulled the
        // prose between into the match and the diagnosis vanished into one marker.
        expect(run({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed",
            mount: { attempts: 8, category: "ResourceBusy", hresult: 2147024891, message: "C:\\a is busy and the retry also failed on the second attach\\x" },
        })).toEqual({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed[a=8,c=ResourceBusy,h=2147024891,m=(host-path) is busy and the retry also failed on the second attach\\x]",
        });
        // Longer than the cap, with the path straddling where a guest-side Substring used to cut.
        // Truncating before redacting left the tail of a name behind; the reader truncates after.
        const straddling = `${"X".repeat(180)} C:\\Users\\Kyeong Jae\\device-lab\\disk.vhdx failed`;
        const straddlingResult = run({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed",
            mount: { attempts: 8, category: "ResourceBusy", hresult: 2147024891, message: straddling },
        }) as { ok: false; code: string };
        expect(straddlingResult.code).toContain("(host-path)");
        expect(straddlingResult.code).not.toContain("Jae");
        expect(straddlingResult.code).not.toContain("Kyeong");
        expect(run({ ok: false, code: "hyper-v-setup-diagnostics-mount-failed" }))
            .toEqual({ ok: false, code: "hyper-v-setup-diagnostics-output-invalid" });
        expect(run({
            ok: false,
            code: "hyper-v-setup-diagnostics-mount-failed",
            mount: { attempts: 11, category: "Private C:\\Users\\Luxus", hresult: -1 },
        })).toEqual({ ok: false, code: "hyper-v-setup-diagnostics-output-invalid" });
        expect(run({ ok: true, logs: [{ path: "Windows\\System32\\config\\SAM", lines: ["secret"] }] }))
            .toEqual({ ok: false, code: "hyper-v-setup-diagnostics-output-invalid" });
    });

    it("does not mutate the VM when the Windows Setup diagnostic preflight cannot prove one exact VHD", () => {
        const programs: string[] = [];
        let calls = 0;
        const result = captureHyperVWindowsSetupDiagnostics({
            ownerId: "0123456789abcdef",
            deviceId: "windows-vm-real-e2e-123",
            incarnationId: "0123456789abcdef0123456789abcdef",
            vmId: "12345678-1234-4123-8123-123456789abc",
            powershell: "powershell.exe",
            platform: "win32",
            spawnSyncImpl: (_command, args) => {
                calls += 1;
                programs.push(Buffer.from(args.at(-1) || "", "base64").toString("utf16le"));
                return { status: 0, stdout: JSON.stringify({ ok: false, code: "hyper-v-setup-diagnostics-disk-not-exact" }) };
            },
        });
        expect(result).toEqual({ ok: false, code: "hyper-v-setup-diagnostics-disk-not-exact" });
        expect(calls).toBe(1);
        expect(programs[0]).not.toContain("Stop-VM");
        expect(programs[0]).not.toContain("Remove-VMHardDiskDrive");
        expect(programs[0]).not.toContain("Mount-VHD");
    });

    it("runs an exact-identity bounded dismount recovery after a diagnostic process timeout", () => {
        const programs: string[] = [];
        let calls = 0;
        const result = captureHyperVWindowsSetupDiagnostics({
            ownerId: "0123456789abcdef",
            deviceId: "windows-vm-real-e2e-123",
            incarnationId: "0123456789abcdef0123456789abcdef",
            vmId: "12345678-1234-4123-8123-123456789abc",
            powershell: "powershell.exe",
            platform: "win32",
            spawnSyncImpl: (_command, args, options) => {
                programs.push(Buffer.from(args.at(-1) || "", "base64").toString("utf16le"));
                calls += 1;
                if (calls === 1) {
                    expect(options.timeout).toBe(30000);
                    return { status: 0, stdout: JSON.stringify({ ok: true, diskPath: "C:\\state\\root.vhdx" }) };
                }
                if (calls === 2) {
                    // Raised from 120 s: the mount retry budget alone is 60 s, and the rest of the
                    // program has to fit alongside it — a Stop-VM on the hung VM being diagnosed
                    // most of all. Overrunning kills the process and discards the mount detail.
                    expect(options.timeout).toBe(180000);
                    return { status: null, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
                }
                expect(options.timeout).toBe(30000);
                return { status: 0, stdout: JSON.stringify({ ok: true, detached: true }) };
            },
        });
        expect(result).toEqual({ ok: false, code: "hyper-v-setup-diagnostics-process-timeout" });
        expect(programs).toHaveLength(3);
        expect(programs[2]).toContain("Get-VM -Id $ExpectedId -ErrorAction Stop");
        expect(programs[2]).toContain("[string]$Vm.Notes -cne $ExpectedMarker");
        expect(programs[2]).toContain("$ExpectedDisk = 'C:\\state\\root.vhdx'");
        expect(programs[2]).toContain("if ($Drives.Count -eq 1)");
        expect(programs[2]).toContain("exit 0");
        expect(programs[2]).toContain("Get-DiskImage -ImagePath $ExpectedDisk -ErrorAction Stop");
        expect(programs[2]).toContain("$DiskImages.Count -ne 1");
        expect(programs[2]).toContain("Dismount-VHD -Path $ExpectedDisk -ErrorAction Stop");
        expect(programs[2]).toContain("$VerifiedImages.Count -ne 1 -or [bool]$VerifiedImages[0].Attached");
        expect(programs[2]).not.toContain("Get-DiskImage -ImagePath $ExpectedDisk -ErrorAction SilentlyContinue");
        expect(programs[2]).not.toContain("Stop-VM");
        expect(programs[2]).not.toContain("Add-VMHardDiskDrive");
        expect(programs[2]).not.toMatch(/Get-VMHardDiskDrive[^\n]*Where-Object/);
    });

    it("fails closed when timeout recovery cannot confirm the owned VHD is dismounted", () => {
        let calls = 0;
        const result = captureHyperVWindowsSetupDiagnostics({
            ownerId: "0123456789abcdef",
            deviceId: "windows-vm-real-e2e-123",
            incarnationId: "0123456789abcdef0123456789abcdef",
            vmId: "12345678-1234-4123-8123-123456789abc",
            powershell: "powershell.exe",
            platform: "win32",
            spawnSyncImpl: () => {
                calls += 1;
                if (calls === 1) return { status: 0, stdout: JSON.stringify({ ok: true, diskPath: "C:\\state\\root.vhdx" }) };
                return calls === 2
                    ? { status: null, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }
                    : { status: 1, stderr: "private failure detail" };
            },
        });
        expect(result).toEqual({ ok: false, code: "hyper-v-setup-diagnostics-cleanup-failed" });
    });

    it("reconciles an in-process dismount failure before returning its bounded code", () => {
        let calls = 0;
        const result = captureHyperVWindowsSetupDiagnostics({
            ownerId: "0123456789abcdef",
            deviceId: "windows-vm-real-e2e-123",
            incarnationId: "0123456789abcdef0123456789abcdef",
            vmId: "12345678-1234-4123-8123-123456789abc",
            powershell: "powershell.exe",
            platform: "win32",
            spawnSyncImpl: () => {
                calls += 1;
                if (calls === 1) return { status: 0, stdout: JSON.stringify({ ok: true, diskPath: "C:\\state\\root.vhdx" }) };
                return calls === 2
                    ? { status: 0, stdout: JSON.stringify({ ok: false, code: "hyper-v-setup-diagnostics-dismount-failed" }) }
                    : { status: 0, stdout: JSON.stringify({ ok: true, detached: true }) };
            },
        });
        expect(calls).toBe(3);
        expect(result).toEqual({ ok: false, code: "hyper-v-setup-diagnostics-dismount-failed" });
    });

    it("fails closed when in-process dismount recovery cannot prove detachment", () => {
        let calls = 0;
        const result = captureHyperVWindowsSetupDiagnostics({
            ownerId: "0123456789abcdef",
            deviceId: "windows-vm-real-e2e-123",
            incarnationId: "0123456789abcdef0123456789abcdef",
            vmId: "12345678-1234-4123-8123-123456789abc",
            powershell: "powershell.exe",
            platform: "win32",
            spawnSyncImpl: () => {
                calls += 1;
                if (calls === 1) return { status: 0, stdout: JSON.stringify({ ok: true, diskPath: "C:\\state\\root.vhdx" }) };
                return calls === 2
                    ? { status: 0, stdout: JSON.stringify({ ok: false, code: "hyper-v-setup-diagnostics-dismount-failed" }) }
                    : { status: 0, stdout: JSON.stringify({ ok: false, code: "hyper-v-setup-diagnostics-cleanup-failed" }) };
            },
        });
        expect(calls).toBe(3);
        expect(result).toEqual({ ok: false, code: "hyper-v-setup-diagnostics-cleanup-failed" });
    });

    it("schedules bounded Windows boot timeline captures and clears every timer", () => {
        const scheduled: Array<{ callback: () => void; delayMs: number; handle: object }> = [];
        const cleared: object[] = [];
        const captures: any[] = [];
        const captureInput = {
            ownerId: "0123456789abcdef",
            deviceId: "windows-vm-real-e2e-123",
            incarnationId: "0123456789abcdef0123456789abcdef",
            powershell: "powershell.exe",
            platform: "win32",
        };
        const cancel = scheduleHyperVWindowsConsoleTimeline({
            captureInput,
            captureImpl: (input: any) => {
                captures.push(input);
                if (captures.length === 1) throw new Error("contained timeline capture failure");
                return { ok: false, code: "hyper-v-console-wmi-unavailable" };
            },
            setTimeoutImpl: (callback, delayMs) => {
                const handle = { delayMs };
                scheduled.push({ callback, delayMs, handle });
                return handle;
            },
            clearTimeoutImpl: (handle) => { cleared.push(handle as object); },
        });

        expect(HYPER_V_WINDOWS_CONSOLE_TIMELINE_DELAYS_MS).toEqual([120000, 300000, 600000, 900000]);
        expect(scheduled.map((entry) => entry.delayMs)).toEqual(HYPER_V_WINDOWS_CONSOLE_TIMELINE_DELAYS_MS);
        expect(() => scheduled.forEach((entry) => entry.callback())).not.toThrow();
        expect(captures).toEqual(Array.from({ length: 4 }, () => captureInput));
        cancel();
        cancel();
        expect(cleared).toEqual(scheduled.map((entry) => entry.handle));
    });

    it("skips console capture before Windows VM creation and keeps catch-before-finally ordering", () => {
        let invoked = false;
        const reason = hyperVWindowsFailureReason({
            profile: "windows-server",
            step: "create VM",
            error: new Error("hyper-v-create-failed"),
            created: false,
            deviceId: "windows-vm-real-e2e-123",
            captureImpl: () => {
                invoked = true;
                return { ok: false, code: "hyper-v-console-process-failed" };
            },
            setupDiagnosticsImpl: () => {
                invoked = true;
                return { ok: false, code: "hyper-v-setup-diagnostics-process-failed" };
            },
        });
        expect(invoked).toBe(false);
        expect(reason).toBe("profile=windows-server; create VM: hyper-v-create-failed");

        const source = readFileSync(new URL("hyper-v-windows-vm-e2e.ts", import.meta.url), "utf8");
        const functionIndex = source.indexOf("export async function runHyperVWindowsVmE2E");
        const functionSource = source.slice(functionIndex);
        expect(functionSource).toContain("scheduleHyperVWindowsConsoleTimeline");
        expect(functionSource).toContain("stopConsoleTimeline");
        const catchIndex = functionSource.indexOf("} catch (error: any) {");
        const captureIndex = functionSource.indexOf("reason: hyperVWindowsFailureReason", catchIndex);
        const finallyIndex = functionSource.indexOf("} finally {", captureIndex);
        const stopIndex = functionSource.indexOf('callTool("device_stop"', finallyIndex);
        expect(functionIndex).toBeGreaterThan(-1);
        expect(catchIndex).toBeGreaterThan(-1);
        expect(captureIndex).toBeGreaterThan(catchIndex);
        expect(finallyIndex).toBeGreaterThan(captureIndex);
        expect(stopIndex).toBeGreaterThan(finallyIndex);
    });
});
