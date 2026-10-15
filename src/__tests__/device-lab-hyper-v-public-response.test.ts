import { describe, expect, it } from "vitest";
import { renderHyperVCreateRollback, renderHyperVCreateStart } from "@ccc/device-lab/device-lab/broker/hyper-v/lifecycle-outcomes.js";
import { deviceLabHyperVLinuxReadinessObservation, deviceLabHyperVReadinessFailure } from "@ccc/device-lab/device-lab/broker/hyper-v/guest-readiness-adapter.js";
import { HYPER_V_ELEVATED_NETWORK_ERROR_CODES } from "@ccc/device-lab/device-lab/broker/hyper-v/elevated-network-session.js";
import {
    boundedPowerShellErrorId,
    redactProviderCommandInput,
    hyperVProviderDiagnosticCode,
    hyperVTypedErrorCode,
    hyperVTypedErrorOperation,
    hyperVTypedNativeDiagnostics,
    publicHyperVCreateConfiguration,
    redactHyperVDeviceSecrets,
    redactHyperVResultSecrets,
} from "@ccc/device-lab/device-lab/broker/hyper-v/public-response.js";
import {
    HYPER_V_WINDOWS_SESSION_ERROR_CODES,
    HyperVWindowsError,
    type HyperVWindowsErrorCategory,
    type HyperVWindowsOperation,
} from "@ccc/hyper-v/low-level/index.js";

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
            name: "Windows 한글 VM",
            incarnationId: "private-generation",
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
            name: "Windows 한글 VM",
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

describe("Hyper-V typed error code", () => {
    const typed = (
        category: HyperVWindowsErrorCategory,
        code: string,
        operation: HyperVWindowsOperation = "New-VM",
    ) => new HyperVWindowsError({ category, operation, code });

    it.each([
        ["native FullyQualifiedErrorId", typed("native", "InvalidParameter-Microsoft.HyperV.PowerShell.Commands.GetVM", "Get-VM"),
            "hyper-v-ps-invalidparameter-microsoft-hyperv-powershell-commands-getvm"],
        ["native asset code", typed("native", "virtual-machine-create-result-ambiguous"),
            "hyper-v-ps-virtual-machine-create-result-ambiguous"],
        ["native code with separators", typed("native", "ObjectNotFound:Some.Value"), "hyper-v-ps-objectnotfound-some-value"],
        ["native id longer than the bound", typed("native", "RemoveItemUnauthorizedAccessError-Microsoft.PowerShell.Commands.RemoveItemCommand"),
            "hyper-v-ps-removeitemunauthorizedaccesserror-microsoft-powershell-commands-remov"],
        ["native asset hyper-v code", typed("native", "hyper-v-module-missing"), "hyper-v-module-missing"],
        ["transport code", typed("transport", "executor-failed"), "hyper-v-windows-transport-executor-failed"],
        ["forwarded elevation code", typed("transport", "hyper-v-network-elevation-cancelled", "New-VMSwitch"),
            "hyper-v-network-elevation-cancelled"],
        ["protocol code", typed("protocol", "response-envelope-invalid"), "hyper-v-windows-protocol-response-envelope-invalid"],
        ["validation code", typed("validation", "selector-name-invalid", "Get-VM"), "hyper-v-windows-validation-selector-name-invalid"],
    ])("keeps a %s in a bounded family the 502 detail admits", (_label, error, expected) => {
        const code = hyperVTypedErrorCode(error, "hyper-v-vm-create-failed");
        expect(code).toBe(expected);
        expect(code).toMatch(/^[a-z0-9-]{1,80}$/);
        expect(hyperVProviderDiagnosticCode({ error: code, stdout: "", stderr: "" }, "hyper-v-provider-command-failed"))
            .toBe(code);
    });

    it.each([
        ["bounded ccc code", new Error("hyper-v-vm-already-exists"), "hyper-v-vm-already-exists"],
        ["ccc code with host detail", new Error("hyper-v-base-image-hash-mismatch: C:\\Users\\secret\\base.vhdx"),
            "hyper-v-base-image-hash-mismatch"],
        ["host message", new Error("EACCES: permission denied, open 'C:\\Users\\secret\\root.vhdx'"), "hyper-v-vm-create-failed"],
        ["ccc code longer than the bound", new Error(`hyper-v-${"a".repeat(100)}`), "hyper-v-vm-create-failed"],
        ["missing error", undefined, "hyper-v-vm-create-failed"],
        ["typed error with an unknown category", new HyperVWindowsError({
            category: "C:\\Users\\secret" as HyperVWindowsErrorCategory,
            operation: "New-VM",
            code: "executor-failed",
        }), "hyper-v-vm-create-failed"],
    ])("falls back to the bounded projection for a %s", (_label, error, expected) => {
        expect(hyperVTypedErrorCode(error, "hyper-v-vm-create-failed")).toBe(expected);
    });

    it("reports the failing operation only from the library's closed list", () => {
        expect(hyperVTypedErrorOperation(typed("native", "x", "Set-VMFirmware"))).toBe("Set-VMFirmware");
        expect(hyperVTypedErrorOperation(new HyperVWindowsError({
            category: "native",
            operation: "C:\\Users\\secret" as HyperVWindowsOperation,
            code: "x",
        }))).toBeUndefined();
        expect(hyperVTypedErrorOperation(new Error("hyper-v-windows-native:New-VM:x"))).toBeUndefined();
        // A stage error wrapping a typed failure names that failure's primitive, from the same list.
        expect(hyperVTypedErrorOperation(new Error("hyper-v-base-image-inspection-failed", {
            cause: typed("native", "vhd-metadata-read-failed", "Get-VHD"),
        }))).toBe("Get-VHD");
        expect(hyperVTypedErrorOperation(new Error("hyper-v-base-image-inspection-failed", {
            cause: new HyperVWindowsError({ category: "native", operation: "C:\\Users\\secret" as HyperVWindowsOperation, code: "x" }),
        }))).toBeUndefined();
        expect(hyperVTypedErrorOperation(new Error("hyper-v-base-image-inspection-failed", { cause: new Error("Get-VHD") })))
            .toBeUndefined();
    });

    it("admits the minted families only as the whole error field, never from host text", () => {
        const minted = "hyper-v-ps-invalidparameter-microsoft-hyperv-powershell-commands-newvm";
        for (const result of [
            { error: `New-VM failed near ${minted}`, stdout: "", stderr: "" },
            { error: "", stdout: "", stderr: "Remove-Item : C:\\hyper-v-ps-secret-user\\root.vhdx" },
            { error: "hyper-v-windows-shell-escape", stdout: "", stderr: "" },
            { error: `hyper-v-ps-${"a".repeat(80)}`, stdout: "", stderr: "" },
            { error: "hyper-v-ps", stdout: "", stderr: "" },
        ]) {
            expect(hyperVProviderDiagnosticCode(result, "hyper-v-provider-command-failed"))
                .toBe("hyper-v-provider-command-failed");
        }
    });

    it("admits every elevation code the typed network client forwards", () => {
        for (const code of HYPER_V_ELEVATED_NETWORK_ERROR_CODES) {
            expect(hyperVProviderDiagnosticCode({ error: code, stdout: "", stderr: "" }, "hyper-v-provider-command-failed"))
                .toBe(code);
        }
    });

    it("keeps a forwarded session code in the transport family but out of the recorded-execution allowlist", () => {
        for (const code of HYPER_V_WINDOWS_SESSION_ERROR_CODES) {
            const typedCode = hyperVTypedErrorCode(typed("transport", code, "Get-VMSwitch"), "hyper-v-vm-create-failed");
            expect(typedCode).toBe(code.replace(/^hyper-v-windows-/, "hyper-v-windows-transport-"));
            expect(typedCode).toMatch(/^[a-z0-9-]{1,80}$/);
            expect(hyperVProviderDiagnosticCode({ error: typedCode, stdout: "", stderr: "" }, "hyper-v-provider-command-failed"))
                .toBe(typedCode);
            // A recorded execution still cannot report one: the one-shot transport has no such code.
            expect(hyperVProviderDiagnosticCode({ error: code, stdout: "", stderr: "" }, "hyper-v-provider-command-failed"))
                .toBe("hyper-v-provider-command-failed");
        }
    });
});

describe("Hyper-V memory admission evidence", () => {
    const capacity = { requestedMb: 4096, availableMb: 6000, reserveMb: 6553, shortfallMb: 4649 };
    const execution = { mode: "exec", provider: "hyper-v", error: "hyper-v-host-memory-capacity-exceeded" };
    it("preserves only numeric capacity fields for a memory refusal", () => {
        expect(redactProviderCommandInput({ ...execution, capacity: { ...capacity, secret: "hidden" } }, true).capacity).toEqual(capacity);
        expect(redactProviderCommandInput({ ...execution, error: "hyper-v-host-cpu-capacity-exceeded", capacity }, true)).not.toHaveProperty("capacity");
    });
    it.each([null, [], {}, { ...capacity, availableMb: "6000" }, { ...capacity, reserveMb: -1 },
        { ...capacity, shortfallMb: Infinity }, { ...capacity, requestedMb: Number.MAX_SAFE_INTEGER + 1 }])("omits malformed capacity %j", (value) => {
        expect(redactProviderCommandInput({ ...execution, capacity: value }, true)).not.toHaveProperty("capacity");
    });
});


describe("bounded native error diagnostics", () => {
    const typed = (fields: Record<string, unknown> = {}) => new HyperVWindowsError({
        category: "native", operation: "Set-VMFirmware", code: "InvalidParameter", ...fields,
    });
    it("preserves signed HRESULT and numeric category for direct and wrapped native failures", () => {
        const error = typed({ nativeHResult: -2147024809, nativeErrorCategory: 5 });
        for (const failure of [error, new Error("host secret", { cause: error })]) {
            expect(hyperVTypedNativeDiagnostics(failure)).toEqual({ nativeHResult: -2147024809, nativeErrorCategory: 5 });
        }
    });
    it.each([
        typed(), new Error("host secret"), { nativeHResult: -1, nativeErrorCategory: 5 },
        typed({ nativeHResult: "secret", nativeErrorCategory: "InvalidArgument" }),
        typed({ nativeHResult: -2147483649, nativeErrorCategory: -1 }),
        typed({ nativeHResult: 2147483648, nativeErrorCategory: 32 }),
        typed({ nativeHResult: 0.5, nativeErrorCategory: 0.5 }),
        typed({ category: "transport", nativeHResult: -1, nativeErrorCategory: 5 }),
        typed({ operation: "host secret", nativeHResult: -1, nativeErrorCategory: 5 }),
    ])("omits absent, untyped, out-of-range or non-native facts", (failure) => {
        expect(hyperVTypedNativeDiagnostics(failure)).toEqual({});
    });
});

describe("Hyper-V create rollback public presentation", () => {
    const recovered = { recoveredVm: true, removedDisk: true };
    const result = {
        mode: "exec", provider: "hyper-v", status: 0, stdoutPresent: true, stderrPresent: false,
        outputRedacted: true, diagnosticCode: "hyper-v-rollback-command-failed",
    };

    it("preserves the complete successful recovery summary without exposing its internal pair", () => {
        expect(renderHyperVCreateRollback({
            attempted: true, ok: true, providerRecovery: recovered, observation: recovered,
            allocation: { ok: true, released: true }, artifacts: { ok: true, removed: true },
        })).toEqual({
            attempted: true, ok: true, observation: recovered, result,
            allocation: { ok: true, released: true }, artifacts: { ok: true, removed: true },
        });
    });

    it("retains successful provider evidence after artifact cleanup fails without a success observation", () => {
        expect(renderHyperVCreateRollback({
            attempted: true, ok: false, providerRecovery: recovered,
            allocation: { ok: true, released: true }, artifacts: { ok: false, removed: false, error: "hyper-v-artifact-cleanup-failed" },
        })).toEqual({
            attempted: true, ok: false, result,
            allocation: { ok: true, released: true }, artifacts: { ok: false, removed: false, error: "hyper-v-artifact-cleanup-failed" },
        });
    });

    it("retains successful provider evidence and unattempted artifacts after network release fails", () => {
        expect(renderHyperVCreateRollback({
            attempted: true, ok: false, stage: "network-release", providerRecovery: recovered,
            allocation: { ok: false, released: false, error: "hyper-v-network-elevation-cancelled" },
            artifacts: { ok: false, attempted: false, removed: false },
        })).toEqual({
            attempted: true, ok: false, stage: "network-release", result,
            allocation: { ok: false, released: false, error: "hyper-v-network-elevation-cancelled" },
            artifacts: { ok: false, attempted: false, removed: false },
        });
    });

    it("preserves a captured status-zero receipt while the current diagnostic takes precedence", () => {
        const receipt = Object.freeze({
            mode: "exec", provider: "hyper-v", status: 0, error: "hyper-v-vm-create-failed", signal: "SIGTERM", timedOut: true,
            stdout: "C:\\private\\root.vhdx", stderr: "host failure at C:\\private\\credential.xml", input: "private credential",
        });
        const rendered = renderHyperVCreateRollback({
            attempted: true, ok: false, reason: "hyper-v-rollback-command-failed", providerRecovery: recovered,
            execution: {
                required: true, dispatched: true, ok: false, failureCode: "hyper-v-operation-deadline-exceeded", receipt,
            },
        });
        expect(rendered).toEqual({
            attempted: true, ok: false, reason: "hyper-v-rollback-command-failed",
            result: {
                mode: "exec", provider: "hyper-v", status: 0, signal: "SIGTERM", timedOut: true,
                stdoutPresent: true, stderrPresent: true, outputRedacted: true, inputConfigured: true,
                diagnosticCode: "hyper-v-operation-deadline-exceeded",
            },
        });
        expect(JSON.stringify(rendered)).not.toContain("private");
        expect(receipt.error).toBe("hyper-v-vm-create-failed");
        expect(receipt.status).toBe(0);
    });

    it("renders a caught typed rollback failure as a synthetic status-one summary", () => {
        const execution = { required: true, dispatched: true, ok: false,
            failureCode: "hyper-v-ps-removeitemioerror-microsoft-powershell-commands-removeitemcommand" };
        expect(renderHyperVCreateRollback({ attempted: true, ok: false, reason: "hyper-v-rollback-command-failed", execution })).toEqual({
            attempted: true, ok: false, reason: "hyper-v-rollback-command-failed",
            result: {
                mode: "exec", provider: "hyper-v", status: 1,
                stdoutPresent: false, stderrPresent: false, outputRedacted: true,
                diagnosticCode: "hyper-v-ps-removeitemioerror-microsoft-powershell-commands-removeitemcommand",
            },
        });
    });

    it("retains a captured status-zero receipt when its observation is invalid", () => {
        const execution = { required: true, dispatched: true, ok: false, failureCode: "hyper-v-rollback-invalid-result" };
        const receipt = Object.freeze({ mode: "exec", provider: "hyper-v", status: 0, stdout: "invalid observation", stderr: "" });
        expect(renderHyperVCreateRollback({ attempted: true, ok: false, reason: "hyper-v-rollback-invalid-result", execution: { ...execution, receipt } })).toEqual({
            attempted: true, ok: false, reason: "hyper-v-rollback-invalid-result",
            result: {
                mode: "exec", provider: "hyper-v", status: 0,
                stdoutPresent: true, stderrPresent: false, outputRedacted: true,
                diagnosticCode: "hyper-v-rollback-command-failed",
            },
        });
        expect(receipt.stdout).toBe("invalid observation");
    });
});

describe("Hyper-V readiness diagnostic presentation", () => {
    it("renders a later containment failure without reviving the captured SSH timeout", () => {
        const receipt = Object.freeze({ mode: "exec", provider: "hyper-v-ssh", status: 255,
            stdout: "private native guest signal absent", stderr: "private native diagnostic é", timedOut: true });
        const originalBytes = Buffer.from(JSON.stringify(receipt), "utf8");
        const first = deviceLabHyperVReadinessFailure("linux-vm", "hyper-v-guest-boot-signal-timeout", {
            previous: deviceLabHyperVLinuxReadinessObservation(receipt), deadlineExpired: false,
        });
        const contained = deviceLabHyperVReadinessFailure("linux-vm", "hyper-v-bootstrap-network-containment-failed", { previous: first });
        const readiness = { provider: "hyper-v-ssh", error: contained.failureCode, errorDetail: contained.failureDetail };
        const rendered = renderHyperVCreateStart({
            kind: "operation-failed", reason: "provider-failed", journalDisposition: "retain", recoveryDisposition: "required",
            ownerId: "owner", backend: "linux-vm", command: "device_start", deviceId: "owned", error: "hyper-v-guest-not-ready",
            execution: { required: true, dispatched: true, mutatesHost: true,
                command: { required: true, dispatched: true, ok: true,
                    receipt: { mode: "exec", provider: "hyper-v", status: 0 }, guestReadiness: readiness } },
            boot: { ready: false, ...readiness },
        });
        const expected = { error: "hyper-v-bootstrap-network-containment-failed", errorDetail: { status: 255, timedOut: false } };
        expect(rendered).toMatchObject({ status: 502, payload: { error: "hyper-v-guest-not-ready", result: {
            boot: { ready: false, ...expected }, execution: { command: { guestReadiness: expected } },
        } } });
        expect(JSON.stringify(rendered)).not.toContain('"evidence"');
        expect(JSON.stringify(rendered)).not.toContain("private");
        expect(contained.execution.receipt).toBe(receipt);
        expect(Buffer.from(JSON.stringify(receipt), "utf8")).toEqual(originalBytes);
    });

    it("renders opaque failure and bootstrap evidence into the established public fields", () => {
        const evidence = Object.freeze({ status: 255, timedOut: false, stdoutBytes: 3, stderrBytes: 4,
            stdout: "private-command-output", input: "private-key", credentialPath: "C:\\private\\guest.xml" });
        const bootstrapProbeEvidence = Object.freeze({ status: 23, stdout: "private-bootstrap-command" });
        const bootstrapSshEvidence = Object.freeze({ status: 255, stderr: "private-ssh-key" });
        const rendered = renderHyperVCreateStart({
            kind: "operation-failed", reason: "provider-failed", journalDisposition: "retain", recoveryDisposition: "required",
            ownerId: "owner", backend: "linux-vm", command: "device_start", deviceId: "owned", error: "hyper-v-linux-guest-ready-failed",
            execution: { required: true, dispatched: true, mutatesHost: true,
                command: { required: true, dispatched: true, ok: true,
                    receipt: { mode: "exec", provider: "hyper-v", status: 0 } } },
            boot: { ready: false, provider: "hyper-v-ssh", error: "ssh-unavailable", errorDetail: { evidence },
                readiness: { managedSshAttempts: 1, bootstrapProbeAttempts: 1, bootstrapProbeSuccesses: 0,
                    bootstrapProbeEvidence, bootstrapProbeLastError: "hyper-v-bootstrap-neighbor-inspection-failed",
                    bootstrapAddressCount: 0, bootstrapSshAttempts: 1, bootstrapSshEvidence, bootstrapSshLastError: "ssh-unavailable",
                    networkFinalizeAttempts: 0, networkFinalizeSucceeded: false, guestSignalObserved: false, elapsedMs: 1000 } },
        });
        expect(rendered).toMatchObject({ status: 502, payload: { result: { boot: {
            ready: false, errorDetail: { status: 255, timedOut: false, stdoutBytes: 3, stderrBytes: 4 },
            readiness: { bootstrapProbeLastStatus: 23, bootstrapSshLastStatus: 255, managedSshAttempts: 1 },
        } } } });
        expect(JSON.stringify(rendered)).not.toContain("Evidence");
        expect(JSON.stringify(rendered)).not.toContain('"evidence"');
        expect(JSON.stringify(rendered)).not.toContain("private");
        expect(evidence.stdout).toBe("private-command-output");
        expect(bootstrapProbeEvidence.status).toBe(23);
    });
});
