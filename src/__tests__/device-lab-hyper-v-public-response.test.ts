import { describe, expect, it } from "vitest";
import {
    boundedPowerShellErrorId,
    hyperVProviderDiagnosticCode,
    publicHyperVCreateConfiguration,
    redactHyperVDeviceSecrets,
    redactHyperVResultSecrets,
} from "../device-lab/broker/hyper-v/public-response.js";

describe("Hyper-V bounded PowerShell error id (last-resort diagnostic)", () => {
    it("surfaces a bounded hyper-v-ps-* code from a raw PowerShell FullyQualifiedErrorId", () => {
        const stderr = "Checkpoint-VM : The operation failed.\n"
            + "    + CategoryInfo          : InvalidOperation: (:) [Checkpoint-VM], VirtualizationException\n"
            + "    + FullyQualifiedErrorId : InvalidOperation,Microsoft.HyperV.PowerShell.Commands.NewVMSnapshot";
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: "",
            stderr,
        }, "hyper-v-snapshot-provider-failed"))
            .toBe("hyper-v-ps-invalidoperation-microsoft-hyperv-powershell-commands-newvmsnapshot");
    });

    it("prefers a ccc hyper-v-* code over the FullyQualifiedErrorId", () => {
        const stderr = "hyper-v-snapshot-standard-fallback-failed\n"
            + "    + FullyQualifiedErrorId : InvalidOperation,Microsoft.HyperV.PowerShell.Commands.NewVMSnapshot";
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: "",
            stderr,
        }, "hyper-v-snapshot-provider-failed")).toBe("hyper-v-snapshot-standard-fallback-failed");
    });

    it("returns the generic fallback when no ccc code and no FullyQualifiedErrorId are present", () => {
        expect(hyperVProviderDiagnosticCode({
            error: "",
            stdout: "",
            stderr: "something went wrong with no structured id",
        }, "hyper-v-snapshot-provider-failed")).toBe("hyper-v-snapshot-provider-failed");
    });

    it("beats the generic hyper-v-powershell-execution-failed wrapper with the specific cmdlet id", () => {
        const stderr = "Checkpoint-VM : failed\n"
            + "    + FullyQualifiedErrorId : InvalidOperation,Microsoft.HyperV.PowerShell.Commands.NewVMSnapshot";
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: "",
            stderr,
        }, "hyper-v-snapshot-provider-failed"))
            .toBe("hyper-v-ps-invalidoperation-microsoft-hyperv-powershell-commands-newvmsnapshot");
    });

    it("never surfaces host paths — only the FullyQualifiedErrorId token, not the message", () => {
        const stderr = "Remove-Item : Cannot remove C:\\Users\\Luxus\\.ccc\\devices\\secret\\root.vhdx.\n"
            + "    + FullyQualifiedErrorId : RemoveItemUnauthorizedAccessError,Microsoft.PowerShell.Commands.RemoveItemCommand";
        const code = boundedPowerShellErrorId("", stderr);
        expect(code).toBe("hyper-v-ps-removeitemunauthorizedaccesserror-microsoft-powershell-commands-remov");
        expect(code).not.toContain("luxus");
        expect(code).not.toContain("vhdx");
        expect(code).not.toContain("secret");
        expect(code!.length).toBeLessThanOrEqual(80);
        expect(code).toMatch(/^[a-z0-9-]{1,80}$/);
    });

    it("caps the bounded code at 80 chars and returns undefined without an id", () => {
        expect((boundedPowerShellErrorId("", "FullyQualifiedErrorId : " + "A".repeat(200))!).length).toBeLessThanOrEqual(80);
        expect(boundedPowerShellErrorId("", "no id here")).toBeUndefined();
    });
});

describe("Hyper-V public response projection", () => {
    it.each([
        "hyper-v-base-image-acl-failed",
        "hyper-v-base-image-final-hash-mismatch",
        "hyper-v-base-image-filesystem-attributes-invalid",
        "hyper-v-base-image-convert-failed",
        "hyper-v-base-image-content-verify-failed",
        "hyper-v-base-image-destination-create-failed",
        "hyper-v-base-image-efi-cleanup-failed",
        "hyper-v-base-image-efi-fallback-failed",
        "hyper-v-base-image-efi-fallback-missing",
        "hyper-v-base-image-efi-loader-copy-failed",
        "hyper-v-base-image-efi-loader-missing",
        "hyper-v-base-image-efi-partition-invalid",
        "hyper-v-base-image-partial-generation-failed",
        "hyper-v-base-image-partial-hash-failed",
        "hyper-v-base-image-partial-inspection-failed",
        "hyper-v-base-image-partial-open-failed",
        "hyper-v-base-image-source-hash-failed",
        "hyper-v-base-image-source-inspection-failed",
        "hyper-v-base-image-source-open-failed",
        "hyper-v-created-disk-format-mismatch",
        "hyper-v-created-disk-hash-mismatch",
        "hyper-v-created-disk-length-mismatch",
        "hyper-v-created-disk-boot-order-mismatch",
        "hyper-v-linux-disk-boot-order-mismatch",
        "hyper-v-device-root-acl-failed",
        "hyper-v-host-capacity-inspection-failed",
        "hyper-v-host-storage-inspection-failed",
        "hyper-v-vm-identity-inspection-failed",
        "hyper-v-vm-path-inspection-failed",
        "hyper-v-base-image-source-mutated",
        "hyper-v-base-image-partial-mutated",
        "hyper-v-qemu-img-unavailable",
        "hyper-v-qemu-img-untrusted",
        "hyper-v-qemu-img-mutated",
    ])("preserves the bounded image mutation diagnostic %s", (diagnosticCode) => {
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: "",
            stderr: diagnosticCode,
        })).toBe(diagnosticCode);
    });

    it.each([
        "hyper-v-network-marker-inspection-failed",
        "hyper-v-network-marker-classification-failed",
        "hyper-v-network-identity-evidence-inspection-failed",
        "hyper-v-network-identity-adoption-failed",
        "hyper-v-network-persisted-marker-repair-failed",
        "hyper-v-network-persisted-marker-rollback-conflict",
        "hyper-v-network-persisted-marker-rollback-failed",
    ])("preserves the bounded network migration diagnostic %s", (diagnosticCode) => {
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: `CCC_HYPER_V_STAGE:${diagnosticCode}`,
            stderr: "",
        })).toBe(diagnosticCode);
    });

    it.each([
        "hyper-v-bootstrap-address-selection-failed",
        "hyper-v-bootstrap-host-prefix-inspection-failed",
        "hyper-v-bootstrap-management-adapter-inspection-failed",
        "hyper-v-bootstrap-neighbor-inspection-failed",
        "hyper-v-bootstrap-network-adapter-ambiguous",
        "hyper-v-bootstrap-network-adapter-identity-mismatch",
        "hyper-v-bootstrap-network-command-failed",
        "hyper-v-bootstrap-vm-adapter-inspection-failed",
    ])("preserves the bounded bootstrap diagnostic %s", (diagnosticCode) => {
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: `CCC_HYPER_V_STAGE:${diagnosticCode}`,
            stderr: "",
        })).toBe(diagnosticCode);
    });

    it.each([
        "hyper-v-reboot-command-failed",
        "hyper-v-reboot-start-failed",
        "hyper-v-snapshot-reconciliation-ambiguous",
        "hyper-v-snapshot-policy-quarantined",
    ])("preserves the bounded lifecycle diagnostic %s", (diagnosticCode) => {
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: "",
            stderr: diagnosticCode,
        })).toBe(diagnosticCode);
    });

    it.each([
        "hyper-v-snapshot-policy-invalid",
        "hyper-v-snapshot-already-exists",
        "hyper-v-snapshot-standard-fallback-failed",
        "hyper-v-snapshot-policy-restore-failed",
        "hyper-v-snapshot-policy-quarantine-failed",
        "hyper-v-snapshot-create-invalid-result",
    ])("surfaces the snapshot-create diagnostic %s instead of the generic provider fallback", (diagnosticCode) => {
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: "",
            stderr: diagnosticCode,
        }, "hyper-v-snapshot-provider-failed")).toBe(diagnosticCode);
    });

    it.each([
        "hyper-v-snapshot-observed-count-invalid",
        "hyper-v-snapshot-observed-none-created",
        "hyper-v-snapshot-observed-name-mismatch",
        "hyper-v-snapshot-observed-duplicate",
        "hyper-v-snapshot-observed-id-invalid",
        "hyper-v-snapshot-observed-name-invalid",
        "hyper-v-snapshot-observed-type-invalid",
    ])("surfaces the snapshot observation diagnostic %s instead of the generic create fallback", (diagnosticCode) => {
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: "",
            stderr: diagnosticCode,
        }, "hyper-v-snapshot-create-invalid-result")).toBe(diagnosticCode);
    });

    it.each([
        "hyper-v-snapshot-name-invalid",
        "hyper-v-vm-identity-ambiguous",
        "hyper-v-vm-not-found",
        "hyper-v-powershell-contract-invalid",
        "hyper-v-powershell-contract-version-unsupported",
    ])("surfaces the snapshot/VM provider-script diagnostic %s instead of the generic fallback", (diagnosticCode) => {
        expect(hyperVProviderDiagnosticCode({
            error: "hyper-v-powershell-execution-failed",
            stdout: "",
            stderr: diagnosticCode,
        }, "hyper-v-snapshot-provider-failed")).toBe(diagnosticCode);
    });

    it.each([
        "hyper-v-vm-identity-conflict",
        "hyper-v-vm-ownership-mismatch",
        "hyper-v-vm-disk-ownership-mismatch",
        "hyper-v-vm-media-ownership-mismatch",
        "hyper-v-vm-delete-stop-timeout",
    ])("preserves the bounded delete reconciliation diagnostic %s", (diagnosticCode) => {
        expect(hyperVProviderDiagnosticCode({
            error: `hyper-v-powershell-execution-failed: ${diagnosticCode}`,
            stdout: "",
            stderr: diagnosticCode,
        }, "hyper-v-delete-reconciliation-failed")).toBe(diagnosticCode);
    });

    it("uses an allowlist for persisted device records", () => {
        const result = redactHyperVDeviceSecrets({
            id: "windows-vm-1",
            backend: "windows-vm",
            provider: "hyper-v",
            vmName: "ccc-owner-windows-vm-1",
            status: "running",
            deviceRoot: "C:\\private\\device",
            diskPath: "C:\\private\\root.vhdx",
            sourceImage: "C:\\images\\base.vhdx",
            futureSecretPath: "C:\\private\\future.secret",
            snapshots: [{
                id: "snapshot-1",
                name: "baseline",
                providerName: "ccc-owner-baseline",
                createdAt: "2026-07-27T00:00:00.000Z",
                diskPath: "C:\\private\\snapshot.vhdx",
            }],
        });

        expect(result).toEqual({
            id: "windows-vm-1",
            backend: "windows-vm",
            provider: "hyper-v",
            vmName: "ccc-owner-windows-vm-1",
            status: "running",
            snapshots: [{
                id: "snapshot-1",
                name: "baseline",
                providerName: "ccc-owner-baseline",
                createdAt: "2026-07-27T00:00:00.000Z",
            }],
        });
    });

    it("reports configured create inputs without exposing source paths or passwords", () => {
        expect(publicHyperVCreateConfiguration({
            name: "Windows VM",
            profile: "windows-11",
            memoryMb: 4096,
            cpus: 2,
            secureBootEnabled: false,
            sourceImage: "C:\\images\\windows.vhdx",
            sshPassword: "secret",
            privateRoot: "C:\\private",
        })).toEqual({
            name: "Windows VM",
            profile: "windows-11",
            memoryMb: 4096,
            cpus: 2,
            secureBootEnabled: false,
            sourceImageConfigured: true,
            sshPasswordConfigured: true,
        });
    });

    it("drops provider commands and unknown result fields", () => {
        expect(redactHyperVResultSecrets({
            ownerId: "owner",
            backend: "linux-vm",
            command: "device_create",
            create: {
                profile: "ubuntu-lts",
                sourceImage: "C:\\images\\ubuntu.vhdx",
            },
            providerCommand: {
                executable: "powershell.exe",
                args: ["-Command", "secret"],
            },
            device: {
                id: "linux-vm-1",
                backend: "linux-vm",
                provider: "hyper-v",
                seedDiskPath: "C:\\private\\cidata.iso",
            },
            futureInternalPayload: "secret",
        })).toEqual({
            ownerId: "owner",
            backend: "linux-vm",
            command: "device_create",
            create: {
                profile: "ubuntu-lts",
                sourceImageConfigured: true,
            },
            device: {
                id: "linux-vm-1",
                backend: "linux-vm",
                provider: "hyper-v",
                snapshots: [],
            },
        });
    });

    it("bounds rollback errors instead of forwarding provider details", () => {
        expect(redactHyperVResultSecrets({
            rollback: {
                ok: false,
                preserved: true,
                error: "C:\\private\\secret.txt",
            },
        })).toEqual({
            rollback: {
                ok: false,
                preserved: true,
                error: "hyper-v-rollback-failed",
            },
        });
    });

    it("bounds persisted boot-check errors instead of forwarding host details", () => {
        expect(redactHyperVDeviceSecrets({
            id: "windows-vm-1",
            backend: "windows-vm",
            provider: "hyper-v",
            lastBootCheck: {
                ready: false,
                provider: "hyper-v-powershell-direct",
                error: "C:\\Users\\Luxus\\secret.txt",
            },
        })).toEqual({
            id: "windows-vm-1",
            backend: "windows-vm",
            provider: "hyper-v",
            snapshots: [],
            lastBootCheck: {
                ready: false,
                provider: "hyper-v-powershell-direct",
                error: "hyper-v-guest-not-ready",
            },
        });
    });

    // The flag was persisted into lastBootCheck and then stripped straight back out by this
    // allowlist, so device_status showed a scrub-failure reason with nothing saying containment had
    // failed to power the guest off. The broker test could not see it: it asserted
    // toContain("scrubContainmentFailed") over the whole response body, which the separate
    // boot.errorDetail copy already satisfied. Persisting it only helps if the projection keeps it —
    // the HTTP reply that carries errorDetail is exactly what gets lost to a caller timeout while
    // containment is still running.
    it("preserves transport reasons instead of flattening them to the generic code", () => {
        // hyperVBoundedErrorCode only admits `hyper-v-*`, so every powershell-direct-* and ssh-*
        // reason was rewritten to hyper-v-guest-not-ready in the persisted record. The reply still
        // carried the truth in `detail`, but device_status has no `detail` — so on the surface that
        // is meant to outlive the reply, a stalled OOBE was indistinguishable from any other
        // not-ready. These are the exact strings hyperVGuestReadinessFailureCode can return.
        for (const reason of [
            "powershell-direct-attempt-timeout",
            "powershell-direct-authentication-failed",
            "powershell-direct-session-unavailable",
            "powershell-direct-unavailable",
            "powershell-direct-timeout",
            "ssh-connection-refused",
            "ssh-connection-timeout",
            "ssh-host-unreachable",
            "ssh-host-key-rejected",
            "ssh-authentication-failed",
            "ssh-unavailable",
            // Refined onto the linux lane after hyperVGuestReadinessFailureCode has run, so it is
            // missing from any set derived from that function alone. It means the guest answered
            // and provisioning is unfinished — the opposite diagnosis to "nothing at that address",
            // which is what flattening produced.
            "ssh-readiness-marker-missing",
        ]) {
            const projected = redactHyperVDeviceSecrets({
                id: "windows-vm-1",
                backend: "windows-vm",
                provider: "hyper-v",
                lastBootCheck: { ready: false, error: reason },
            }) as Record<string, any>;
            expect(projected.lastBootCheck?.error, `${reason} must survive the projection`).toBe(reason);
        }
        // The set is closed: anything outside it still collapses to the bounded fallback, so this
        // is not a hole for arbitrary strings that merely look like a transport code.
        // The four ssh-host-key-* entries in the broker's own bootstrapSshCodes allowlist have no
        // producer, so they stay out: a set that admits codes nothing emits is not closed.
        for (const rejected of [
            "powershell-direct-anything-else",
            "ssh-made-up",
            "C:\\secret",
            "ssh-host-key-mismatch",
        ]) {
            const projected = redactHyperVDeviceSecrets({
                id: "windows-vm-1",
                backend: "windows-vm",
                provider: "hyper-v",
                lastBootCheck: { ready: false, error: rejected },
            }) as Record<string, any>;
            expect(projected.lastBootCheck?.error, `${rejected} must not pass`).toBe("hyper-v-guest-not-ready");
        }
    });

    it("projects scrubContainmentFailed so device_status can see an uncontained guest", () => {
        const projected = redactHyperVDeviceSecrets({
            id: "windows-vm-1",
            backend: "windows-vm",
            provider: "hyper-v",
            lastBootCheck: {
                ready: false,
                provider: "hyper-v-powershell-direct",
                error: "hyper-v-guest-provisioning-not-scrubbed",
                scrubContainmentFailed: true,
            },
        }) as Record<string, any>;
        expect(projected.lastBootCheck).toEqual({
            ready: false,
            provider: "hyper-v-powershell-direct",
            error: "hyper-v-guest-provisioning-not-scrubbed",
            scrubContainmentFailed: true,
        });
        // Literal true only. A stored non-true value must not be echoed back through the projection,
        // and its absence must stay absent rather than becoming a false nobody reads.
        const contained = redactHyperVDeviceSecrets({
            id: "windows-vm-1",
            backend: "windows-vm",
            provider: "hyper-v",
            lastBootCheck: { ready: false, provider: "hyper-v-powershell-direct", scrubContainmentFailed: "C:\\secret" },
        }) as Record<string, any>;
        expect(contained.lastBootCheck).not.toHaveProperty("scrubContainmentFailed");
    });
});
