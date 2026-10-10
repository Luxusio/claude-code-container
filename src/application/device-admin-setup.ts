import { hyperVSetupFailureDetail, type SetupRequest, type HyperVSetupHostResult, type SetupObservation, type HostNetworkResult } from "../domain/device-admin-setup.js";
import type { CommandResult } from "../domain/device-admin-diagnostics.js";
import type { DeviceAdminSetupPorts } from "../ports/device-admin-setup.js";
export function createDeviceAdminSetup(ports: DeviceAdminSetupPorts) {
    async function setup(confirm: boolean, options: SetupRequest = {}): Promise<HyperVSetupHostResult> {
        const platform = ports.platform();
        if (platform !== "win32") {
            return { ok: false, text: "CCC Hyper-V setup is only available on a Windows host." };
        }
        const injectedPowerShell = options.injectedPowerShell && options.powershell !== undefined ? options.powershell : undefined;
        const powershell = confirm
            ? injectedPowerShell ?? ports.canonicalPowerShell(options.injectedPowerShell ? options.systemRoot : undefined)
            : options.powershell === undefined
                ? ports.commandPath("powershell.exe") || ports.commandPath("pwsh") || ports.commandPath("powershell")
                : options.powershell;
        if (!powershell) return { ok: false, text: "CCC Hyper-V setup failed: PowerShell was not found." };
        const runner = ports.runCommand;
        const setupRoot = ports.resolvePath(options.stateRoot || ports.joinPath(ports.homeDirectory(), ".ccc/device-broker-private/setup"));
        try {
            ports.assertPlainDirectory(setupRoot, "hyper-v-setup-root");
        } catch (error) {
            return { ok: false, text: `CCC Hyper-V setup failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        const licenseAccepted = Boolean(ports.readEvaluationReceipt(setupRoot));
        if (!confirm) {
            const readinessCommand = ports.readinessCommand(powershell);
            const execution = runner(readinessCommand.executable, readinessCommand.args, 30_000);
            const readiness = execution?.status === 0 ? ports.parseReadiness(execution.stdout || "") : null;
            if (!readiness) {
                const detail = hyperVSetupFailureDetail(execution);
                return { ok: false, text: `CCC Hyper-V setup diagnostic failed: ${detail}` };
            }
            const actions: string[] = [];
            if (!readiness.moduleAvailable || !readiness.hypervisorPresent) {
                actions.push("action: verify that the Windows edition supports Hyper-V and firmware virtualization is enabled, then run 'ccc devices setup hyper-v --confirm'");
            }
            if (!readiness.vmmsRunning) {
                actions.push("action: start the Hyper-V Virtual Machine Management (vmms) service, then rerun this diagnostic");
            }
            if (readiness.rebootPending) {
                actions.push("action: reboot Windows manually, then rerun this diagnostic");
            }
            if (readiness.managementAccess === false) {
                actions.push(readiness.sessionRefreshRequired
                    ? "action: sign out of Windows and sign in once to activate Hyper-V Administrators membership, then rerun this diagnostic"
                    : "action: grant the current user Hyper-V management access with 'ccc devices setup hyper-v --confirm', then rerun this diagnostic");
            }
            // Setup state lives in <private root>/setup, where create also reads the evaluation receipt,
            // so the image cache is read from the same private root create resolves images from.
            const linuxImage = ports.linuxImageBlockers(readiness, ports.inspectLinuxImageCache(ports.parentDirectory(setupRoot), options.ownerId || ""));
            const qemuImgMissing = readiness.linuxImageMissing || [];
            const qemuImgRemedy = qemuImgMissing.includes("hyper-v-qemu-img-unavailable")
                ? "install the Android SDK Emulator package from Google so %LOCALAPPDATA%\\Android\\Sdk\\emulator\\qemu-img.exe is available for Hyper-V Linux images at that exact path, with no junction or symbolic link in any path component"
                : qemuImgMissing.includes("hyper-v-qemu-img-untrusted")
                    ? `reinstall or update the Android Emulator through the Android SDK Manager until %LOCALAPPDATA%\\Android\\Sdk\\emulator\\qemu-img.exe has a Valid Google LLC signature (signature status: ${readiness.qemuImgSignatureStatus ?? "unknown"}); never substitute a qemu-img from another source`
                    : null;
            const linuxImageActions: string[] = [];
            if (linuxImage.baseImage.state === "conflict") {
                // Partial and acquire-work artifacts also exist while a create is still acquiring the image.
                const acquisitionMayBeRunning = linuxImage.blockers.includes("hyper-v-base-image-artifact-owner-unknown")
                    ? "; a Hyper-V Linux VM create that is still acquiring the image also leaves these artifacts, so first let any such create finish and rerun this diagnostic"
                    : "";
                linuxImageActions.push(`action: resolve ${linuxImage.blockers.join(", ")} in the ubuntu-lts base image cache under %USERPROFILE%\\.ccc\\device-broker-private\\images\\hyper-v\\ubuntu-lts before creating a Hyper-V Linux VM; CCC does not repair or replace it automatically${acquisitionMayBeRunning}`);
            }
            if (qemuImgRemedy) {
                linuxImageActions.push(linuxImage.baseImage.state === "valid"
                    ? `advisory: qemu-img is not needed until the ubuntu-lts image must be re-acquired; before then, ${qemuImgRemedy}`
                    : `action: ${qemuImgRemedy}`);
            }
            return {
                ok: true,
                text: [
                    "=== CCC Hyper-V Setup ===",
                    "",
                    "mode: diagnostic",
                    `available: ${readiness.available}`,
                    `moduleAvailable: ${readiness.moduleAvailable}`,
                    `hypervisorPresent: ${readiness.hypervisorPresent}`,
                    `vmmsRunning: ${readiness.vmmsRunning}`,
                    `hyperVAdministratorsMember: ${readiness.hyperVAdministratorsMember ?? "unknown"}`,
                    `managementAccess: ${readiness.managementAccess ?? "unknown"}`,
                    `sessionRefreshRequired: ${readiness.sessionRefreshRequired ?? false}`,
                    `rebootPending: ${readiness.rebootPending}`,
                    `missing: ${readiness.missing.join(", ")}`,
                    `qemuImgAvailable: ${readiness.qemuImgAvailable ?? false}`,
                    `qemuImgTrusted: ${readiness.qemuImgTrusted ?? false}`,
                    `qemuImgSignatureStatus: ${readiness.qemuImgSignatureStatus ?? "unknown"}`,
                    `linuxImageMissing: ${(readiness.linuxImageMissing || []).join(", ")}`,
                    `linuxBaseImage: ${linuxImage.baseImage.state}${linuxImage.baseImage.source ? ` (${linuxImage.baseImage.source})` : ""}`,
                    `windowsEvaluationLicenseAccepted: ${licenseAccepted}`,
                    ...(!licenseAccepted ? ["action: accept the Windows Server evaluation terms once with 'ccc devices setup hyper-v --confirm --accept-windows-evaluation-license'"] : []),
                    ...linuxImageActions,
                    ...actions,
                ].join("\n"),
            };
        }
        ports.createDirectory(setupRoot);
        try {
            ports.assertPlainDirectory(setupRoot, "hyper-v-setup-root");
        } catch (error) {
            return { ok: false, text: `CCC Hyper-V setup failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        const mutationLockFile = ports.resolvePath(options.mutationLockFile
            || (options.stateRoot
                ? ports.joinPath(setupRoot, "host-locks", "hyper-v.mutation.lock")
                : ports.joinPath(ports.homeDirectory(), ".ccc/devices/host-locks/hyper-v.mutation.lock")));
        let prepared: {
            execution: CommandResult | null;
            observation: SetupObservation | null;
            network: HostNetworkResult | null;
        };
        try {
            ports.createDirectory(ports.parentDirectory(mutationLockFile));
            ports.assertPlainDirectory(ports.parentDirectory(mutationLockFile), "hyper-v-setup-mutation-lock-root");
            // Setup no longer carries its own network ensure. It enables the feature and
            // grants group membership — the two things only it can do — and then takes the
            // same typed host-fabric path the broker takes on device create, against the
            // same state file. The elevation that path needs is its own, so a confirmed
            // setup prompts twice: once here for the feature, once for the fabric.
            const ensureHostNetwork = ports.ensureHostNetwork;
            prepared = await ports.withMutationLock(mutationLockFile, async () => {
                const setupCommand = ports.setupCommand(powershell);
                const execution = runner(setupCommand.executable, setupCommand.args, 15 * 60_000, setupCommand.input);
                const observation = execution?.status === 0 ? ports.parseSetupObservation(execution.stdout || "") : null;
                if (!observation?.ok) return { execution, observation, network: null };
                const network = await ensureHostNetwork(ports.now() + 15 * 60_000);
                return { execution, observation, network };
            }, { waitMs: 10 * 60_000, staleMs: 20 * 60_000 });
        } catch (error) {
            const code = (error as Error & { code?: string }).code;
            const detail = code === "shared-mutation-lock-timeout"
                ? "hyper-v-setup-lock-timeout"
                : error instanceof Error ? error.message : String(error);
            return { ok: false, text: `CCC Hyper-V setup failed: ${detail}` };
        }
        const { execution, observation, network } = prepared;
        if (!observation?.ok) {
            const detail = hyperVSetupFailureDetail(execution);
            return { ok: false, text: `CCC Hyper-V setup failed: ${detail}` };
        }
        if (!network) {
            return { ok: false, text: "CCC Hyper-V setup failed: hyper-v-setup-network-result-invalid" };
        }
        if (!network.ok) {
            const detail = network.detail || network.error;
            return { ok: false, text: `CCC Hyper-V setup failed: ${detail}` };
        }
        const receipt = options.acceptWindowsEvaluationLicense
            ? ports.acceptEvaluationLicense(setupRoot)
            : ports.readEvaluationReceipt(setupRoot);
        return {
            ok: true,
            text: [
                "=== CCC Hyper-V Setup ===",
                "",
                "mode: confirmed",
                `feature: ${observation.featureName}`,
                `beforeState: ${observation.beforeState}`,
                `afterState: ${observation.afterState}`,
                `changed: ${observation.changed}`,
                `hyperVAdministratorsMember: ${observation.hyperVAdministratorsMember ?? "unknown"}`,
                `membershipChanged: ${observation.membershipChanged ?? false}`,
                `managementAccess: ${observation.managementAccess ?? "unknown"}`,
                `sessionRefreshRequired: ${observation.sessionRefreshRequired ?? false}`,
                `rebootRequired: ${observation.rebootRequired}`,
                "networkPrepared: true",
                `networkSwitch: ${network.switchName}`,
                `networkGateway: ${network.gateway}`,
                `windowsEvaluationLicenseAccepted: ${Boolean(receipt)}`,
                ...(receipt ? [`windowsEvaluationLicense: ${ports.evaluationLicenseUrl}`] : []),
                ...(receipt ? [`windowsEvaluationImageSourceTrust: ${receipt.sourceTrustId}`] : []),
                ...(observation.rebootRequired
                    ? ["action: reboot Windows manually, then run 'ccc devices smoke --real-provider'"]
                    : observation.sessionRefreshRequired
                        ? ["action: sign out of Windows and sign in once to activate Hyper-V Administrators membership, then run 'ccc devices smoke --real-provider'"]
                        : ["action: run 'ccc devices smoke --real-provider'"]),
                "hostRebooted: false",
            ].join("\n"),
        };
    }
    return { setup };
}
