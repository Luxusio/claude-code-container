import { canonicalWindowsPowerShellPath } from "@ccc/device-lab/windows-system-powershell.js";
import { directorySymlink } from "./helpers/file-symlink-fixture.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { devicesCliAsync, setupHyperVHost, spawnableWindowsExecutablePath } from "../device-lab-admin.js";
import { hyperVSetupCommand } from "@ccc/device-lab/host-control/hyper-v/index.js";
import {
    HYPER_V_IMAGE_CATALOG,
    HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
    HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
    readHyperVWindowsEvaluationReceipt,
} from "@ccc/device-lab/device-lab/hyper-v-images.js";
import { deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { createDeviceAdminSetup } from "../application/device-admin-setup.js";
import * as setupApplication from "../application/device-admin-setup.js";
import type { DeviceAdminSetupPorts } from "../ports/device-admin-setup.js";
import type { HyperVReadiness } from "../domain/device-admin-diagnostics.js";
import type { SetupObservation, HostNetworkResult } from "../domain/device-admin-setup.js";

vi.mock("../application/device-admin-setup.js", async original => ({ ...await original<typeof import("../application/device-admin-setup.js")>() }));

describe("semantic setup effect ordering", () => {
    function setupTrace() {
        const events: unknown[][] = [];
        let now = 1_000;
        let locked = false;
        const receipt = { marker: "published" };
        const ports: DeviceAdminSetupPorts<typeof receipt> = {
            prepareContext: confirm => { events.push(["context", confirm]); return { ok: true }; },
            prepareMutation: () => { events.push(["mutation-admission"]); return { ok: true }; },
            now: () => now,
            readEvaluationReceipt: () => { events.push(["receipt-read"]); return null; },
            diagnose: timeout => { events.push(["diagnose", timeout]); return { state: "failed" }; },
            linuxImage: () => { throw new Error("unexpected image inspection"); },
            enableFeature: timeout => {
                events.push(["feature", timeout, locked]);
                now += 600_000;
                return { state: "available", value: {
                    ok: true, featureName: "Microsoft-Hyper-V-All", beforeState: "Disabled",
                    afterState: "Enabled", changed: true, rebootRequired: false,
                } };
            },
            withMutationLock: async (operation, options) => {
                events.push(["lock", options]); locked = true;
                try { return await operation(); }
                finally { locked = false; events.push(["unlock"]); }
            },
            ensureHostNetwork: async deadline => {
                events.push(["fabric", deadline, locked]);
                return { ok: true, switchName: "CCC Device Lab", gateway: "172.29.0.1" };
            },
            mutationFailure: () => ({ marker: "failure" }),
            acceptEvaluationLicense: () => { events.push(["accept", locked]); return receipt; },
        };
        return { ports, events, receipt };
    }

    it("uses separate feature and fresh fabric budgets while holding the 10/20-minute lock", async () => {
        const { ports, events, receipt } = setupTrace();
        const result = await createDeviceAdminSetup(ports).setup(true, { acceptWindowsEvaluationLicense: true });
        expect(events).toEqual([
            ["context", true], ["receipt-read"], ["mutation-admission"], ["lock", { waitMs: 600_000, staleMs: 1_200_000 }],
            ["feature", 900_000, true], ["fabric", 1_501_000, true], ["unlock"], ["accept", false],
        ]);
        expect(result.ok).toBe(true);
        if (result.ok && result.mode === "confirmed") expect(result.receipt).toBe(receipt);
    });

    it.each([false, true])("propagates the original initial receipt exception before effects (confirm=%s)", async confirm => {
        const { ports, events } = setupTrace();
        const failure = new Error("initial-receipt-read");
        ports.readEvaluationReceipt = () => { events.push(["receipt-read"]); throw failure; };
        await expect(createDeviceAdminSetup(ports).setup(confirm)).rejects.toBe(failure);
        expect(events).toEqual([["context", confirm], ["receipt-read"]]);
    });

    it("keeps diagnostic work at 30 seconds without entering the mutation lock", async () => {
        const { ports, events } = setupTrace();
        const result = await createDeviceAdminSetup(ports).setup(false);
        expect(result.ok).toBe(false);
        expect(events).toEqual([["context", false], ["receipt-read"], ["diagnose", 30_000]]);
    });
});

describe("Hyper-V host setup CLI", () => {
    const roots: string[] = [];
    // Setup no longer reconciles the network itself; it delegates to the same typed
    // host-fabric path the broker uses on device create. These tests therefore inject
    // that call rather than asserting on an embedded PowerShell ensure — the adoption,
    // repair and rollback policy it used to duplicate is covered by the broker suite.
    const setupNetwork = {
        ok: true as const,
        switchName: "CCC Device Lab",
        gateway: "172.29.0.1",
        prefix: "172.29.0.0/24",
        outboundPolicy: "nat" as const,
    };
    const ensureHostNetwork = () => Promise.resolve(setupNetwork);

    afterEach(() => {
        vi.restoreAllMocks();
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("projects native readiness facts into setup policy while retaining the native receipt and public diagnostic", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-projected-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const raw = {
            available: true, moduleAvailable: true, hypervisorPresent: true, vmmsRunning: true,
            rebootPending: false, missing: [], ok: true, detail: "native-detail-private",
            platform: "native-windows-platform", totalMemoryMb: 123456, freeMemoryMb: 654321, logicalProcessors: 73,
        };
        let observed: HyperVReadiness | undefined;
        let receipt: unknown;
        const originalFactory = setupApplication.createDeviceAdminSetup;
        vi.spyOn(setupApplication, "createDeviceAdminSetup").mockImplementation(<Evidence>(ports: DeviceAdminSetupPorts<Evidence>) => {
            const diagnose = ports.diagnose;
            return originalFactory({ ...ports, diagnose(timeout) {
                const result = diagnose(timeout);
                if (result.state === "available") { observed = result.value; receipt = result.evidence; }
                return result;
            } });
        });
        const execution = { command: "powershell.exe", status: 0, stdout: JSON.stringify(raw), stderr: "" };
        const runner = vi.fn(() => execution);

        const result = await setupHyperVHost(false, {
            platform: "win32", powershell: "powershell.exe", stateRoot: root, commandRunner: runner,
        });

        expect(observed).toMatchObject({ available: true, moduleAvailable: true, hypervisorPresent: true, vmmsRunning: true, rebootPending: false, missing: [] });
        const outwardOnly = observed as HyperVReadiness & Partial<typeof raw>;
        expect(outwardOnly.ok).toBeUndefined();
        expect(outwardOnly.detail).toBeUndefined();
        expect(outwardOnly.platform).toBeUndefined();
        expect(outwardOnly.totalMemoryMb).toBeUndefined();
        expect(outwardOnly.freeMemoryMb).toBeUndefined();
        expect(outwardOnly.logicalProcessors).toBeUndefined();
        expect((receipt as { execution: unknown }).execution).toBe(execution);
        expect(result.ok).toBe(true);
        expect(result.text).toContain("mode: diagnostic");
        expect(result.text).toContain("available: true");
        expect(result.text).toContain("moduleAvailable: true");
        expect(result.text).not.toContain("native-detail-private");
        expect(result.text).not.toContain("native-windows-platform");
        expect(runner).toHaveBeenCalledTimes(1);
        expect(existsSync(join(root, "host-locks", "hyper-v.mutation.lock"))).toBe(false);
        expect(existsSync(join(root, "hyper-v-windows-evaluation-license.json"))).toBe(false);
    });

    it("projects confirmed feature and fabric facts while preserving evidence and manual reboot presentation", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-confirmed-projected-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const nativeNetwork = {
            ...setupNetwork, switchId: "12345678-1234-4234-9234-1234567890ab", natName: "CCCDeviceLab",
            natInstanceId: "native-nat-identity", interfaceIndex: 12, createdSwitch: false, createdNat: false,
        };
        const raw = {
            ok: true, featureName: "Microsoft-Hyper-V-All", beforeState: "Disabled", afterState: "Enabled",
            changed: true, elevated: true, rebootRequired: true, sessionRefreshRequired: true, network: nativeNetwork,
        };
        const execution = { command: "powershell.exe", status: 0, stdout: JSON.stringify(raw), stderr: "" };
        const runner = vi.fn(() => execution);
        const ensure = vi.fn(async () => nativeNetwork);
        let observed: SetupObservation | undefined;
        let network: Extract<HostNetworkResult, { ok: true }> | undefined;
        let receipt: unknown;
        const originalFactory = setupApplication.createDeviceAdminSetup;
        vi.spyOn(setupApplication, "createDeviceAdminSetup").mockImplementation(<Evidence>(ports: DeviceAdminSetupPorts<Evidence>) => {
            const enableFeature = ports.enableFeature;
            const ensureNetwork = ports.ensureHostNetwork;
            return originalFactory({ ...ports,
                enableFeature(timeout) {
                    const result = enableFeature(timeout);
                    if (result.state === "available") { observed = result.value; receipt = result.evidence; }
                    return result;
                },
                async ensureHostNetwork(deadline) {
                    const result = await ensureNetwork(deadline);
                    if (result.ok) network = result;
                    return result;
                },
            });
        });

        const result = await setupHyperVHost(true, {
            platform: "win32", powershell: "powershell.exe", stateRoot: root,
            commandRunner: runner, ensureHostNetwork: ensure,
        });

        expect(observed).toMatchObject({ ok: true, changed: true, rebootRequired: true, sessionRefreshRequired: true });
        expect((observed as SetupObservation & { elevated?: boolean }).elevated).toBeUndefined();
        expect((observed as SetupObservation & { network?: unknown }).network).toBeUndefined();
        expect(network).toMatchObject({ ok: true, switchName: setupNetwork.switchName, gateway: setupNetwork.gateway });
        expect((network as Partial<typeof nativeNetwork>).prefix).toBeUndefined();
        expect((network as Partial<typeof nativeNetwork>).outboundPolicy).toBeUndefined();
        expect((network as Partial<typeof nativeNetwork>).switchId).toBeUndefined();
        expect((network as Partial<typeof nativeNetwork>).natInstanceId).toBeUndefined();
        expect((receipt as { execution: unknown }).execution).toBe(execution);
        expect(result.ok).toBe(true);
        expect(result.text).toContain("mode: confirmed");
        expect(result.text).toContain("rebootRequired: true");
        expect(result.text).toContain("action: reboot Windows manually");
        expect(result.text).toContain(`networkSwitch: ${setupNetwork.switchName}`);
        expect(result.text).toContain(`networkGateway: ${setupNetwork.gateway}`);
        expect(result.text).toContain("hostRebooted: false");
        expect(result.text).not.toContain("action: sign out");
        expect(result.text).not.toContain("native-nat-identity");
        expect(runner).toHaveBeenCalledTimes(1);
        expect(ensure).toHaveBeenCalledTimes(1);
        expect(existsSync(join(root, "host-locks", "hyper-v.mutation.lock"))).toBe(false);
    });

    it("converts a verified extended DOS executable path into a spawn-compatible path", async () => {
        expect(spawnableWindowsExecutablePath("\\\\?\\C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))
            .toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        expect(spawnableWindowsExecutablePath("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))
            .toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        expect(spawnableWindowsExecutablePath("\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))
            .toBeNull();
        expect(spawnableWindowsExecutablePath("\\\\?\\UNC\\server\\share\\powershell.exe")).toBeNull();
    });

    it("advises a manual reboot in diagnostic mode without enabling features or recording acceptance", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-reboot-diagnostic-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const runner = vi.fn((_command: string, _args: string[], _timeoutMs: number, _input?: string) => ({
            command: "powershell.exe", status: 0, stderr: "",
            stdout: JSON.stringify({
                ok: true, available: false, moduleAvailable: true, hypervisorPresent: true,
                vmmsRunning: true, rebootPending: true, totalMemoryMb: 32768,
                freeMemoryMb: 16384, logicalProcessors: 16, missing: ["reboot-pending"],
            }),
        }));
        const ensure = vi.fn(ensureHostNetwork);

        const result = await setupHyperVHost(false, {
            platform: "win32", powershell: "powershell.exe", stateRoot: root,
            commandRunner: runner, ensureHostNetwork: ensure, acceptWindowsEvaluationLicense: true,
        });

        expect(result.ok).toBe(true);
        expect(result.text).toContain("rebootPending: true");
        expect(result.text).toContain("action: reboot Windows manually, then rerun this diagnostic");
        expect(result.text).not.toContain("mode: confirmed");
        expect(ensure).not.toHaveBeenCalled();
        expect(existsSync(join(root, "hyper-v-windows-evaluation-license.json"))).toBe(false);
        const script = Buffer.from(runner.mock.calls[0][1].at(-1) || "", "base64").toString("utf16le");
        expect(script).not.toMatch(/Enable-WindowsOptionalFeature|Restart-Computer|Start-Process/);
    });

    it("runs diagnostics without enabling Windows features when confirmation is absent", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-diagnostic-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const runner = vi.fn((_command: string, _args: string[], _timeoutMs: number, _input?: string) => ({
            command: "powershell.exe",
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                available: false,
                platform: "win32",
                moduleAvailable: false,
                hypervisorPresent: false,
                vmmsRunning: false,
                rebootPending: false,
                totalMemoryMb: 32768,
                freeMemoryMb: 16384,
                logicalProcessors: 16,
                missing: ["hyper-v-powershell-module", "hypervisor", "vmms-service"],
                qemuImgAvailable: false,
                qemuImgTrusted: false,
                linuxImageMissing: ["hyper-v-qemu-img-unavailable"],
            }),
            stderr: "",
        }));

        // The image cache is read beside the setup root, so keep both inside this test's own root.
        const result = await setupHyperVHost(false, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: join(root, "setup"),
            commandRunner: runner,
        });

        expect(result.ok).toBe(true);
        expect(result.text).toContain("mode: diagnostic");
        expect(result.text).toContain("verify that the Windows edition supports Hyper-V and firmware virtualization is enabled");
        expect(result.text).toContain("ccc devices setup hyper-v --confirm");
        expect(result.text).toContain("start the Hyper-V Virtual Machine Management (vmms) service");
        expect(result.text).toContain("windowsEvaluationLicenseAccepted: false");
        expect(result.text).toContain("qemuImgAvailable: false");
        expect(result.text).toContain("linuxImageMissing: hyper-v-qemu-img-unavailable");
        expect(result.text).toContain("Android SDK Emulator package from Google");
        // The probe rejects a junction or symlink anywhere on the fixed path, as acquisition does.
        expect(result.text).toContain("qemu-img.exe is available for Hyper-V Linux images at that exact path, with no junction or symbolic link in any path component");
        expect(result.text).toContain("linuxBaseImage: acquisition-required");
        expect(result.text).not.toContain("SDK Manager");
        const encodedScript = Buffer.from(runner.mock.calls[0][1].at(-1) || "", "base64").toString("utf16le");
        expect(encodedScript).not.toContain("Enable-WindowsOptionalFeature");
    });

    describe("Hyper-V Linux image remedies", () => {
        const cachedImage = Buffer.from("cached-ubuntu-lts-image");

        function readyRunner(qemuImg: Record<string, unknown>) {
            return vi.fn(() => ({
                command: "powershell.exe",
                status: 0,
                stdout: JSON.stringify({
                    ok: true,
                    available: true,
                    platform: "win32",
                    moduleAvailable: true,
                    hypervisorPresent: true,
                    vmmsRunning: true,
                    rebootPending: false,
                    totalMemoryMb: 32768,
                    freeMemoryMb: 16384,
                    logicalProcessors: 16,
                    missing: [],
                    ...qemuImg,
                }),
                stderr: "",
            }));
        }

        const untrusted = {
            qemuImgAvailable: true,
            qemuImgTrusted: false,
            qemuImgSignatureStatus: "HashMismatch",
            linuxImageMissing: ["hyper-v-qemu-img-untrusted"],
        };

        // Setup state sits in <private root>/setup, the same private root create reads images from.
        function privateRoot(label: string) {
            const root = join(tmpdir(), `ccc-hyper-v-linux-image-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
            roots.push(root);
            return root;
        }

        function writeUbuntuCache(profileRoot: string, userProvided = false) {
            const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
            mkdirSync(profileRoot, { recursive: true });
            writeFileSync(join(profileRoot, "base.vhdx"), cachedImage);
            writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
                version: 3,
                profile: "ubuntu-lts",
                catalogId: userProvided ? "user-provided-vhdx" : catalog.catalogId,
                sourceUrl: userProvided ? null : catalog.sourceUrl,
                sourceFormat: userProvided ? "vhdx" : catalog.sourceFormat,
                sourceSha256: userProvided ? null : catalog.sourceSha256,
                licenseId: userProvided ? null : catalog.licenseId,
                generation: catalog.generation,
                secureBootTemplate: catalog.secureBootTemplate,
                preparationVersion: 1,
                imagePath: join(profileRoot, "base.vhdx"),
                sha256: "0".repeat(64),
                sizeBytes: cachedImage.length,
                virtualSizeBytes: catalog.virtualSizeBytes,
                vhdType: "Dynamic",
                preparedAt: new Date().toISOString(),
            }));
        }

        it("tells an untrusted qemu-img to be reinstalled through the SDK Manager when the image must be acquired", async () => {
            const root = privateRoot("untrusted");

            const result = await setupHyperVHost(false, { platform: "win32", powershell: "powershell.exe", stateRoot: join(root, "setup"), commandRunner: readyRunner(untrusted) });

            expect(result.ok).toBe(true);
            expect(result.text).toContain("qemuImgSignatureStatus: HashMismatch");
            expect(result.text).toContain("linuxBaseImage: acquisition-required");
            expect(result.text).toContain("action: reinstall or update the Android Emulator through the Android SDK Manager");
            expect(result.text).toContain("signature status: HashMismatch");
            expect(result.text).toContain("never substitute a qemu-img from another source");
            expect(result.text).not.toContain("Android SDK Emulator package from Google");
            expect(result.text).not.toContain("advisory:");
        });

        it("reports qemu-img as not needed until re-acquisition when the shared cache is valid", async () => {
            const root = privateRoot("cached");
            writeUbuntuCache(join(root, "images", "hyper-v", "ubuntu-lts"));

            const result = await setupHyperVHost(false, { platform: "win32", powershell: "powershell.exe", stateRoot: join(root, "setup"), commandRunner: readyRunner(untrusted) });

            expect(result.text).toContain("linuxBaseImage: valid (global)");
            expect(result.text).toContain("advisory: qemu-img is not needed until the ubuntu-lts image must be re-acquired; before then, reinstall or update the Android Emulator through the Android SDK Manager");
            expect(result.text).not.toMatch(/^action: .*qemu-img/m);
        });

        it("reads the owner's imported image for the owner the CLI resolves", async () => {
            const root = privateRoot("owner");
            const ownerId = deviceLabOwnerId("/project/setup-owner-image-test");
            writeUbuntuCache(join(root, "owners", ownerId, "images", "hyper-v", "ubuntu-lts"), true);
            const runner = readyRunner({ qemuImgAvailable: false, qemuImgTrusted: false, linuxImageMissing: ["hyper-v-qemu-img-unavailable"] });

            const owned = await setupHyperVHost(false, { platform: "win32", powershell: "powershell.exe", stateRoot: join(root, "setup"), commandRunner: runner, ownerId });
            expect(owned.text).toContain("linuxBaseImage: valid (owner)");
            expect(owned.text).toContain("advisory: qemu-img is not needed until the ubuntu-lts image must be re-acquired; before then, install the Android SDK Emulator package from Google");

            const other = await setupHyperVHost(false, { platform: "win32", powershell: "powershell.exe", stateRoot: join(root, "setup"), commandRunner: runner, ownerId: deviceLabOwnerId("/project/setup-other-owner-test") });
            expect(other.text).toContain("linuxBaseImage: acquisition-required");
            expect(other.text).toContain("action: install the Android SDK Emulator package from Google");
        });

        it("names a cache conflict as an action for the operator", async () => {
            const root = privateRoot("conflict");
            const profileRoot = join(root, "images", "hyper-v", "ubuntu-lts");
            mkdirSync(profileRoot, { recursive: true });
            writeFileSync(join(profileRoot, "base.partial.vhdx"), cachedImage);

            const diagnose = () => setupHyperVHost(false, {
                platform: "win32",
                powershell: "powershell.exe",
                stateRoot: join(root, "setup"),
                commandRunner: readyRunner({ qemuImgAvailable: true, qemuImgTrusted: true, qemuImgSignatureStatus: "Valid", linuxImageMissing: [] }),
            });
            const result = await diagnose();

            expect(result.text).toContain("linuxBaseImage: conflict");
            expect(result.text).toContain("action: resolve hyper-v-base-image-artifact-owner-unknown in the ubuntu-lts base image cache");
            // Those artifacts can belong to an acquisition that is still running.
            expect(result.text).toContain("a Hyper-V Linux VM create that is still acquiring the image also leaves these artifacts, so first let any such create finish and rerun this diagnostic");
            expect(result.text).not.toContain("SDK Manager");
            expect(result.text).not.toContain("advisory:");

            rmSync(join(profileRoot, "base.partial.vhdx"));
            writeFileSync(join(profileRoot, "base.vhdx"), cachedImage);
            const unmanaged = await diagnose();
            expect(unmanaged.text).toContain("action: resolve hyper-v-base-image-unmanaged-existing in the ubuntu-lts base image cache");
            expect(unmanaged.text).not.toContain("still acquiring the image");
        });
    });

    it("records explicit Windows evaluation license acceptance and reports it later", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-license-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const mutationLockFile = join(root, "host-locks", "hyper-v.mutation.lock");
        const runner = vi.fn((_command: string, args: string[], _timeoutMs: number, input?: string) => {
            expect(existsSync(mutationLockFile)).toBe(true);
            const outer = input
                ? Buffer.from(input, "base64").toString("utf8")
                : Buffer.from(args.at(-1) || "", "base64").toString("utf16le");
            // The elevated setup script must no longer carry a network program of its own.
            expect(outer).toContain("$NetworkProgramEncoded = ''");
            return {
                command: "powershell.exe",
                status: 0,
                stdout: JSON.stringify({
                    ok: true,
                    featureName: "Microsoft-Hyper-V-All",
                    beforeState: "Enabled",
                    afterState: "Enabled",
                    changed: false,
                    elevated: true,
                    rebootRequired: false,
                }),
                stderr: "",
            };
        });

        const accepted = await setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: runner,
            ensureHostNetwork,
            acceptWindowsEvaluationLicense: true,
        });

        expect(accepted.ok).toBe(true);
        expect(accepted.text).toContain("windowsEvaluationLicenseAccepted: true");
        expect(accepted.text).toContain("windowsEvaluationImageSourceTrust: microsoft-evaluation-https-tofu-v1");
        expect(accepted.text).toContain("networkPrepared: true");
        expect(accepted.text).toContain(`networkSwitch: ${setupNetwork.switchName}`);
        expect(existsSync(mutationLockFile)).toBe(false);
        const receiptPath = join(root, "hyper-v-windows-evaluation-license.json");
        expect(existsSync(receiptPath)).toBe(true);
        expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
            version: 2,
            licenseId: "windows-server-2025-evaluation",
            sourceTrustId: "microsoft-evaluation-https-tofu-v1",
            sourceUrl: "https://go.microsoft.com/fwlink/?clcid=0x409&country=us&culture=en-us&linkid=2345826",
        });
    });

    it("preserves an existing evaluation-license acceptance after the trust label was clarified", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-legacy-license-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "hyper-v-windows-evaluation-license.json"), JSON.stringify({
            version: 2,
            licenseId: HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
            licenseUrl: HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
            sourceTrustId: "microsoft-evaluation-allowlisted-https-v1",
            sourceUrl: "https://go.microsoft.com/fwlink/?clcid=0x409&country=us&culture=en-us&linkid=2345826",
            acceptedAt: "2026-07-01T00:00:00.000Z",
        }));

        expect(readHyperVWindowsEvaluationReceipt(root)).toEqual(expect.objectContaining({
            sourceTrustId: "microsoft-evaluation-https-tofu-v1",
            acceptedAt: "2026-07-01T00:00:00.000Z",
        }));
    });

    it.each([
        ["malformed JSON", "{"],
        ["oversized content", " ".repeat(4097)],
        ["wrong legal fields", JSON.stringify({
            version: 2,
            licenseId: "different-license",
            licenseUrl: "https://example.invalid/license",
            acceptedAt: "2026-01-01T00:00:00.000Z",
        })],
        ["invalid acceptance timestamp", JSON.stringify({
            version: 2,
            licenseId: HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
            licenseUrl: HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
            sourceTrustId: "microsoft-evaluation-https-tofu-v1",
            sourceUrl: "https://go.microsoft.com/fwlink/?clcid=0x409&country=us&culture=en-us&linkid=2345826",
            acceptedAt: "not-a-timestamp",
        })],
    ])("fails closed for a %s receipt", (_case, content) => {
        const root = join(tmpdir(), `ccc-hyper-v-invalid-license-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "hyper-v-windows-evaluation-license.json"), content);

        expect(() => readHyperVWindowsEvaluationReceipt(root)).toThrow(/hyper-v-windows-evaluation-license/);
    });

    it("does not suggest feature installation for a VMMS-only failure", async () => {
        const runner = vi.fn(() => ({
            command: "powershell.exe",
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                available: false,
                platform: "win32",
                moduleAvailable: true,
                hypervisorPresent: true,
                vmmsRunning: false,
                rebootPending: false,
                totalMemoryMb: 32768,
                freeMemoryMb: 16384,
                logicalProcessors: 16,
                missing: ["vmms-service"],
            }),
            stderr: "",
        }));

        const result = await setupHyperVHost(false, { platform: "win32", powershell: "powershell.exe", commandRunner: runner });

        expect(result.ok).toBe(true);
        expect(result.text).toContain("start the Hyper-V Virtual Machine Management (vmms) service");
        expect(result.text).not.toContain("verify that the Windows edition supports Hyper-V");
    });

    // Setup's own network ensure was deleted in favour of the typed host-fabric path.
    // These four pin the replacement contract: the ensure is actually called, it runs
    // while the host mutation lock is held, its failure fails the command, and it never
    // runs when the elevated step that must precede it did not succeed. Without them a
    // setup that silently stopped preparing the network would still pass.
    const confirmedSetupRunner = (overrides: Record<string, unknown> = {}) => vi.fn(() => ({
        command: "powershell.exe",
        status: 0,
        stdout: JSON.stringify({
            ok: true,
            featureName: "Microsoft-Hyper-V-All",
            beforeState: "Enabled",
            afterState: "Enabled",
            changed: false,
            elevated: true,
            rebootRequired: false,
            ...overrides,
        }),
        stderr: "",
    }));

    it("reconciles the host fabric through the typed path after the elevated step", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-fabric-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const runner = confirmedSetupRunner();
        const ensure = vi.fn(() => Promise.resolve(setupNetwork));

        const result = await setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: runner,
            ensureHostNetwork: ensure,
        });

        expect(result.ok).toBe(true);
        expect(ensure).toHaveBeenCalledTimes(1);
        expect(runner.mock.invocationCallOrder[0]).toBeLessThan(ensure.mock.invocationCallOrder[0]);
        expect(result.text).toContain("networkPrepared: true");
        expect(result.text).toContain(`networkSwitch: ${setupNetwork.switchName}`);
        expect(result.text).toContain(`networkGateway: ${setupNetwork.gateway}`);
    });

    it("holds the host mutation lock across the typed fabric reconciliation", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-fabric-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const mutationLockFile = join(root, "host-locks", "hyper-v.mutation.lock");
        let lockedDuringEnsure: boolean | null = null;

        const result = await setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: confirmedSetupRunner(),
            ensureHostNetwork: () => {
                lockedDuringEnsure = existsSync(mutationLockFile);
                return Promise.resolve(setupNetwork);
            },
        });

        expect(result.ok).toBe(true);
        expect(lockedDuringEnsure).toBe(true);
        expect(existsSync(mutationLockFile)).toBe(false);
    });

    it("fails the command with a bounded detail when the typed fabric reconciliation fails", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-fabric-fail-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const mutationLockFile = join(root, "host-locks", "hyper-v.mutation.lock");

        const result = await setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: confirmedSetupRunner(),
            ensureHostNetwork: () => Promise.resolve({
                ok: false as const,
                status: 502,
                error: "hyper-v-network-setup-failed",
                detail: "hyper-v-network-switch-identity-conflict",
            }),
        });

        expect(result.ok).toBe(false);
        expect(result.text).toContain("hyper-v-network-switch-identity-conflict");
        expect(result.text).not.toContain("networkPrepared: true");
        expect(existsSync(mutationLockFile)).toBe(false);
    });

    it("does not reconcile the host fabric when the elevated setup step failed", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-fabric-skip-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const ensure = vi.fn(() => Promise.resolve(setupNetwork));

        const result = await setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: vi.fn(() => ({
                command: "powershell.exe",
                status: 1,
                stdout: "",
                stderr: "hyper-v-setup-enable-failed",
            })),
            ensureHostNetwork: ensure,
        });

        expect(result.ok).toBe(false);
        expect(ensure).not.toHaveBeenCalled();
    });

    it("does not record license acceptance when the confirmed fabric step fails", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-license-network-fail-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);

        const result = await setupHyperVHost(true, {
            platform: "win32", powershell: "powershell.exe", stateRoot: root,
            commandRunner: confirmedSetupRunner(), acceptWindowsEvaluationLicense: true,
            ensureHostNetwork: async () => ({
                ok: false as const, status: 502, error: "hyper-v-network-setup-failed",
                detail: "hyper-v-network-switch-identity-conflict",
            }),
        });

        expect(result.ok).toBe(false);
        expect(result.text).toContain("hyper-v-network-switch-identity-conflict");
        expect(existsSync(join(root, "hyper-v-windows-evaluation-license.json"))).toBe(false);
        expect(existsSync(join(root, "host-locks", "hyper-v.mutation.lock"))).toBe(false);
    });

    it("rejects a receipt publication failure after fabric preparation and releases the host lock", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-license-write-fail-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const receiptPath = join(root, "hyper-v-windows-evaluation-license.json");
        const sentinel = join(receiptPath, "preserved");
        const ensure = vi.fn(async () => {
            mkdirSync(receiptPath);
            writeFileSync(sentinel, "foreign-directory-content");
            return setupNetwork;
        });

        await expect(setupHyperVHost(true, {
            platform: "win32", powershell: "powershell.exe", stateRoot: root,
            commandRunner: confirmedSetupRunner(), ensureHostNetwork: ensure,
            acceptWindowsEvaluationLicense: true,
        })).rejects.toThrow();

        expect(ensure).toHaveBeenCalled();
        expect(readFileSync(sentinel, "utf8")).toBe("foreign-directory-content");
        expect(existsSync(join(root, "host-locks", "hyper-v.mutation.lock"))).toBe(false);
    });

    // Everything above injects the fabric call, so none of it would notice the default
    // wiring being dropped. Left uninjected, setup must reach the real broker entry —
    // With PowerShell discovery isolated to an empty directory, that entry fails
    // closed before host network mutation, even when pwsh is installed on the test host.
    // The existing Windows exclusion keeps this from exercising native host setup.
    it.skipIf(process.platform === "win32")("reaches the real broker fabric entry when no ensure is injected", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-fabric-wiring-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);

        const emptyBin = join(root, "empty-bin");
        mkdirSync(emptyBin, { recursive: true });
        const originalPath = process.env.PATH;
        process.env.PATH = emptyBin;
        try {
            const result = await setupHyperVHost(true, {
                platform: "win32",
                powershell: "powershell.exe",
                stateRoot: root,
                commandRunner: confirmedSetupRunner(),
            });

            expect(result.ok).toBe(false);
            expect(result.text).toContain("powershell");
            expect(result.text).not.toContain("is not a function");
        } finally {
            if (originalPath === undefined) delete process.env.PATH;
            else process.env.PATH = originalPath;
        }
    });

    it("enables Hyper-V only through the confirmed setup path and reports a pending reboot", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-setup-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        mkdirSync(root, { recursive: true });
        const runner = vi.fn((_command: string, _args: string[], _timeoutMs: number, _input?: string) => ({
            command: "powershell.exe",
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                featureName: "Microsoft-Hyper-V-All",
                beforeState: "Disabled",
                afterState: "Enabled",
                changed: true,
                elevated: true,
                rebootRequired: true,
            }),
            stderr: "",
        }));

        const result = await setupHyperVHost(true, { platform: "win32", powershell: "powershell.exe", stateRoot: root, commandRunner: runner, ensureHostNetwork });

        expect(result.ok).toBe(true);
        expect(result.text).toContain("mode: confirmed");
        expect(result.text).toContain("rebootRequired: true");
        expect(result.text).toContain("hostRebooted: false");
        const encodedScript = runner.mock.calls[0][3]
            ? Buffer.from(runner.mock.calls[0][3], "base64").toString("utf8")
            : Buffer.from(runner.mock.calls[0][1].at(-1) || "", "base64").toString("utf16le");
        expect(encodedScript).toContain("Start-Process -FilePath $Executable -Verb RunAs");
        expect(encodedScript).toContain("-WindowStyle Hidden -PassThru");
        expect(encodedScript).not.toContain("Restart-Computer");
    });

    it("reduces raw PowerShell setup failures to bounded categories", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-errors-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const rawFailure = await setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: () => ({
                command: "powershell.exe",
                status: 1,
                stdout: "",
                stderr: "#< CLIXML C:\\Users\\private\\module.psd1 failed",
            }),
        });
        expect(rawFailure).toEqual({ ok: false, text: "CCC Hyper-V setup failed: hyper-v-setup-host-operation-failed" });
        expect(rawFailure.text).not.toContain("C:\\Users\\private");

        const categorized = await setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: () => ({
                command: "powershell.exe",
                status: 1,
                stdout: "",
                stderr: "wrapper: hyper-v-setup-pipe-client-mismatch",
            }),
        });
        expect(categorized).toEqual({ ok: false, text: "CCC Hyper-V setup failed: hyper-v-setup-pipe-client-mismatch" });

        const wrapped = await setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: () => ({
                command: "powershell.exe",
                status: 1,
                stdout: "",
                stderr: "hyper-v-setup-pipe-_x000D__x000A_ handshake-timeout",
            }),
        });
        expect(wrapped).toEqual({ ok: false, text: "CCC Hyper-V setup failed: hyper-v-setup-pipe-handshake-timeout" });

        const partial = await setupHyperVHost(true, {
            platform: "win32",
            powershell: "powershell.exe",
            stateRoot: root,
            commandRunner: () => ({ command: "powershell.exe", status: 1, stdout: "", stderr: "hyper-v-setup-pipe-handshake-" }),
        });
        expect(partial).toEqual({ ok: false, text: "CCC Hyper-V setup failed: hyper-v-setup-host-operation-failed" });

        for (const stderr of ["hyper-v-setup-pipe-handshake-timeout-extra", "prefixhyper-v-setup-enable-failedsuffix"]) {
            const extended = await setupHyperVHost(true, {
                platform: "win32",
                powershell: "powershell.exe",
                stateRoot: root,
                commandRunner: () => ({ command: "powershell.exe", status: 1, stdout: "", stderr }),
            });
            expect(extended).toEqual({ ok: false, text: "CCC Hyper-V setup failed: hyper-v-setup-host-operation-failed" });
        }
    });

    it("pins elevated setup module resolution to the canonical Windows PowerShell modules", async () => {
        const originalModulePath = process.env.PSModulePath;
        process.env.PSModulePath = "C:\\Users\\attacker\\Documents\\WindowsPowerShell\\Modules";
        try {
            const command = hyperVSetupCommand("\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
            const outerScript = command.input
                ? Buffer.from(command.input, "base64").toString("utf8")
                : Buffer.from(command.args.at(-1)!, "base64").toString("utf16le");
            const innerEncoded = /\$InnerEncoded = '([^']+)'/.exec(outerScript)?.[1];
            expect(innerEncoded).toBeTruthy();
            const innerScript = Buffer.from(innerEncoded!, "base64").toString("utf16le");

            expect(innerScript).toContain("$env:PSModulePath = $TrustedModuleRoot");
            expect(innerScript).toContain("Join-Path $PSHOME 'Modules'");
            expect(innerScript).toContain("Microsoft.PowerShell.Core\\Get-Module -ListAvailable -Name $Name");
            expect(innerScript).toContain("$_.Path.StartsWith($TrustedModulePrefix, [StringComparison]::OrdinalIgnoreCase)");
            expect(innerScript).toContain("Microsoft.PowerShell.Core\\Import-Module -Name $DismModule -Force -ErrorAction Stop");
            expect(innerScript).toContain("Microsoft.PowerShell.Core\\Import-Module -Name $LocalAccountsModule -Force -ErrorAction Stop");
            expect(innerScript).not.toContain("Microsoft.PowerShell.LocalAccounts\\Microsoft.PowerShell.LocalAccounts.psd1");
            expect(innerScript).not.toContain(process.env.PSModulePath);
            expect(innerScript).toContain("Dism\\Enable-WindowsOptionalFeature");
            expect(innerScript).toContain("Microsoft.PowerShell.LocalAccounts\\Add-LocalGroupMember");
            expect(innerScript).toContain("Get-CimInstance -ClassName Win32_OptionalFeature");
            expect(innerScript).not.toContain("Dism\\Get-WindowsOptionalFeature");
            expect(outerScript).not.toContain("Dism\\Get-WindowsOptionalFeature");
            expect(outerScript).not.toContain("Microsoft.PowerShell.LocalAccounts\\Get-LocalGroupMember");
            expect(outerScript).not.toContain("Hyper-V\\Get-VM");
            expect(outerScript).toContain("Start-Process -FilePath $Executable -Verb RunAs");
            expect(outerScript.match(/-WindowStyle Hidden -PassThru/g)).toHaveLength(2);
            expect(outerScript).toContain("[IO.Pipes.PipeSecurity]::new()");
            expect(outerScript).toContain("[IO.Pipes.PipeAccessRule]::new($ElevatedAdministratorsSid");
            expect(outerScript).toContain("CCC_HYPER_V_SETUP_PIPE_NAME");
            expect(outerScript).toContain("$InnerSource.Replace('__CCC_HYPER_V_SETUP_PIPE_NAME__', $PipeName)");
            expect(outerScript).not.toContain("$env:CCC_HYPER_V_SETUP_PIPE_NAME");
            expect(outerScript).not.toContain("$env:CCC_HYPER_V_SETUP_USER_SID");
            expect(outerScript).toContain("$Wait.AsyncWaitHandle.WaitOne(30000)");
            expect(outerScript).toContain("GetNamedPipeClientProcessId");
            expect(outerScript).toContain("$ClientProcessId -ne [uint32]$Child.Id");
            expect(outerScript).not.toContain("GetTempFileName");
            expect(innerScript).toContain("[IO.Pipes.NamedPipeClientStream]::new");
            expect(innerScript).toContain("$PipeName = '__CCC_HYPER_V_SETUP_PIPE_NAME__'");
            expect(innerScript).toContain("$SetupUserSid = '__CCC_HYPER_V_SETUP_USER_SID__'");
            expect(innerScript.indexOf("$Pipe.Connect(5000)")).toBeLessThan(innerScript.indexOf("Get-CimInstance -ClassName Win32_OptionalFeature"));
            expect(innerScript).toContain("$SelfStartTicks = (Get-Process -Id $PID");
            expect(innerScript).toContain("$ParentPid = [int]'__CCC_HYPER_V_SETUP_PARENT_PID__'");
            expect(innerScript).toContain("$Parent.StartTime.ToUniversalTime().Ticks -ne $ParentStartTicks");
            expect(innerScript).toContain("$Target.StartTime.ToUniversalTime().Ticks -eq $SelfStartTicks");
            expect(innerScript).toContain("$WatchdogStartTicks = $Watchdog.StartTime.ToUniversalTime().Ticks");
            expect(innerScript).toContain("$ObservedWatchdog.StartTime.ToUniversalTime().Ticks -eq $WatchdogStartTicks");
            expect(innerScript).not.toContain("Set-Content");
            expect(outerScript).toContain("$ChildStartTicks = $Child.StartTime.ToUniversalTime().Ticks");
            expect(outerScript).toContain("-not $OperationCompleted");
            expect(outerScript).toContain("$ObservedChild.StartTime.ToUniversalTime().Ticks -eq $ChildStartTicks");
            expect(outerScript).toContain("$Child.WaitForExit(5000)");
            expect(outerScript).toContain("hyper-v-setup-elevated-child-termination-unconfirmed");
        } finally {
            if (originalModulePath === undefined) delete process.env.PSModulePath;
            else process.env.PSModulePath = originalModulePath;
        }
    });

    it("uses only the canonical system PowerShell path at the UAC elevation boundary", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-system-powershell-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const powershell = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        mkdirSync(join(root, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
        writeFileSync(powershell, "not executed by the injected runner");
        const runner = vi.fn(() => ({
            command: powershell,
            status: 0,
            stdout: JSON.stringify({
                ok: true,
                featureName: "Microsoft-Hyper-V-All",
                beforeState: "Enabled",
                afterState: "Enabled",
                changed: false,
                elevated: false,
                rebootRequired: false,
                hyperVAdministratorsMember: true,
                membershipChanged: false,
                managementAccess: true,
                sessionRefreshRequired: false,
            }),
            stderr: "",
        }));

        const result = await setupHyperVHost(true, {
            platform: "win32",
            systemRoot: root,
            stateRoot: join(root, "state"),
            commandRunner: runner,
            ensureHostNetwork,
        });

        expect(result.ok).toBe(true);
        expect(runner).toHaveBeenCalledWith(powershell, expect.any(Array), 900_000, expect.any(String));
    });

    it("does not trust spoofed SystemRoot or WINDIR values at the UAC elevation boundary", async () => {
        const root = join(tmpdir(), `ccc-hyper-v-spoofed-system-root-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        roots.push(root);
        const fakePowerShell = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        mkdirSync(join(root, "System32", "WindowsPowerShell", "v1.0"), { recursive: true });
        writeFileSync(fakePowerShell, "repository-controlled fake");
        const trustedPowerShell = canonicalWindowsPowerShellPath();
        const originalSystemRoot = process.env.SystemRoot;
        const originalWindir = process.env.WINDIR;
        process.env.SystemRoot = root;
        process.env.WINDIR = root;
        const runner = vi.fn(() => ({ command: trustedPowerShell || "", status: 1, stdout: "", stderr: "fixture refuses execution" }));
        try {
            const result = await setupHyperVHost(true, {
                platform: "win32",
                stateRoot: join(root, "state"),
                commandRunner: runner,
            });
            expect(result.ok).toBe(false);
            if (trustedPowerShell) {
                expect(runner).toHaveBeenCalledWith(trustedPowerShell, expect.any(Array), expect.any(Number), expect.any(String));
                expect(trustedPowerShell).not.toBe(fakePowerShell);
            } else {
                expect(result).toEqual({ ok: false, text: "CCC Hyper-V setup failed: PowerShell was not found." });
                expect(runner).not.toHaveBeenCalled();
            }
        } finally {
            if (originalSystemRoot === undefined) delete process.env.SystemRoot;
            else process.env.SystemRoot = originalSystemRoot;
            if (originalWindir === undefined) delete process.env.WINDIR;
            else process.env.WINDIR = originalWindir;
        }
    });

    it("rejects a reparse-like setup root before elevated execution", async () => {
        const parent = join(tmpdir(), `ccc-hyper-v-reparse-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const target = join(parent, "target");
        const linked = join(parent, "linked");
        roots.push(parent);
        mkdirSync(target, { recursive: true });
        directorySymlink(target, linked);
        const runner = vi.fn();

        const result = await setupHyperVHost(true, { platform: "win32", powershell: "powershell.exe", stateRoot: linked, commandRunner: runner });

        expect(result).toEqual(expect.objectContaining({ ok: false }));
        expect(result.text).toContain("hyper-v-setup-root-path-invalid");
        expect(runner).not.toHaveBeenCalled();
    });

    it("routes the public CLI confirmation and rejects malformed setup commands", async () => {
        const setupHyperV = vi.fn(async (_confirm: boolean, _options?: Parameters<typeof setupHyperVHost>[1]) => ({ ok: true, text: "setup-ok" }));
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(await devicesCliAsync(["setup", "hyper-v", "--confirm"], "/project/setup-test", undefined, { setupHyperV })).toBe(0);
        const ownerId = deviceLabOwnerId("/project/setup-test");
        expect(setupHyperV).toHaveBeenCalledWith(true, { acceptWindowsEvaluationLicense: false, ownerId });
        expect(log).toHaveBeenCalledWith("setup-ok");

        expect(await devicesCliAsync(["setup", "hyper-v", "--confirm", "--accept-windows-evaluation-license"], "/project/setup-test", undefined, { setupHyperV })).toBe(0);
        expect(setupHyperV).toHaveBeenLastCalledWith(true, { acceptWindowsEvaluationLicense: true, ownerId });

        expect(await devicesCliAsync(["setup", "hyper-v", "--force"], "/project/setup-test", undefined, { setupHyperV })).toBe(1);
        expect(await devicesCliAsync(["setup", "hyper-v", "--accept-windows-evaluation-license"], "/project/setup-test", undefined, { setupHyperV })).toBe(1);
        expect(error).toHaveBeenCalledWith("Usage: ccc devices setup hyper-v [--confirm [--accept-windows-evaluation-license]]");
    });
});
