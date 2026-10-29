import { waitForExpectedRuntimeExitSync, waitForExpectedRuntimeExitAsync } from "./device-lab/adapters/process/runtime-exit.js";
import { readBrokerOwnerSecret } from "@ccc/device-lab/providers/state/broker-owner-secret.mjs";
import {planBrokerAndroidCreate, planBrokerAndroidExisting} from "./device-lab/application/lifecycle/android-emulator-lifecycle.js";
import {planBrokerIosCreateCommand as semanticIosCreate, planBrokerIosExistingCommand as semanticIosExisting} from "./device-lab/application/lifecycle/ios-simulator-lifecycle.js";
import { iosExecInputError } from "@ccc/device-lab/providers/domain/ios-observation-access.mjs";
import {planBrokerMacosCreateCommand as semanticMacosCreate, planBrokerMacosExistingCommand as semanticMacosExisting} from "./device-lab/application/lifecycle/macos-vm-lifecycle.js";
import type {BrokerAndroidPreparationPorts} from "./device-lab/ports/lifecycle/android-emulator-lifecycle.js";
import {NativeProviderLifecycleEffect, renderBrokerAndroidLifecycle, renderBrokerIosMacosLifecycle, renderBrokerSandboxLifecycle, renderBrokerProviderRollback} from "./device-lab/broker/broker-outcomes-codec.js";
import {renderBrokerOwnerResolution, renderBrokerDeviceStatus, renderBrokerRecording, renderBrokerAppium, NativeBrokerExecutionReceipt, NativeRecordingSignalReceipt, NativeAppiumResponseReceipt, NativeAppiumTerminationReceipt, NativeAppiumVerificationReceipt, NativeAppiumRuntimeReceipt, NativeAppiumInstrumentationReceipt, type NativeStatusConnection} from "./device-lab/broker/broker-outcomes-codec.js";
import { recordingRuntimeMatches, recordingTargetMatches, recordingSerial, type BrokerRecordingRefusal, type BrokerRecordingRequest, type BrokerRecordingTarget } from "./device-lab/domain/broker-recording.js";
import type {BrokerRecordingArtifactContext} from "./device-lab/ports/broker-recording.js";
import type {BrokerAppiumRefusal} from "./device-lab/domain/broker-appium.js";
import type {BrokerAppiumInstrumentationStep} from "./device-lab/ports/broker-appium.js";
import type {DeviceStatusPreparation, DeviceStatusPhysicalAdmission} from "./device-lab/domain/broker-observation.js";
import { renderHyperVCreateStart, renderHyperVCreateRollback, renderHyperVStopDelete, renderHyperVSnapshot, renderHyperVSnapshotRepair, nativeHyperVExecutionReceipt, publicHyperVReadinessTrace, type NativeHyperVConnection } from "./device-lab/broker/hyper-v/lifecycle-outcomes.js";
import { normalizePhysicalExecution, normalizeAppleInventory, renderLeaseOutcome, renderLeaseFailure as leaseParamError, renderCleanupRollback, renderPhysicalAttachOutcome, renderPhysicalDetachOutcome, renderAppleTrustOutcome, renderPhysicalStopOutcome, renderOwnerCleanupOutcome } from './device-lab/broker/physical-outcomes.js';
import type { NativePhysicalReceipt } from './device-lab/broker/physical-outcomes.js';
import {hyperVLinuxGuestReadyTraceFailureCode as coreLinuxTraceFailure,compareHyperVLinuxEd25519HostKeyFingerprint as coreLinuxFingerprint,hyperVLinuxGuestSignalDeadlineAt as coreLinuxSignalDeadline,hyperVLinuxGuestSignalTimedOut as coreLinuxSignalTimedOut,type HyperVLinuxGuestReadyTrace} from "./device-lab/domain/lifecycle/hyper-v-create-start.js";
import {hyperVCreateUniqueFields,hyperVDeviceDefinition,hyperVSecureBootConfiguration} from "./device-lab/domain/lifecycle/hyper-v-create-start.js";
import type {HyperVLifecycleOutcome, HyperVLifecyclePlan, HyperVPowerObservation, HyperVNativeExecution} from "./device-lab/domain/lifecycle/hyper-v-create-start.js";
import { createHyperVStopDeleteApplication } from "./device-lab/application/lifecycle/hyper-v-stop-delete.js";
import type { HyperVStopDeletePorts } from "./device-lab/ports/lifecycle/hyper-v-stop-delete.js";
import type { HyperVOperationEvidence, HyperVTerminalResult } from "./device-lab/domain/lifecycle/hyper-v-stop-delete.js";
import { createBrokerPhysicalDevicesApplication } from './device-lab/application/broker-physical-devices.js';
import { createBrokerOwnerCleanupApplication } from './device-lab/application/broker-owner-cleanup.js';
import { validateAttachParams as validatePhysicalAttachParams } from './device-lab/domain/broker-physical-devices.js';
import { createBrokerOwnerRepository } from './device-lab/application/broker-owner-repository.js';
import { cleanupRecord, type CleanupLeaseGuard, type CleanupTermination, type AuxiliaryOutcome, type CleanupStopOutcome } from './device-lab/domain/broker-owner-cleanup.js';
import type { BrokerPhysicalDevicesPorts } from './device-lab/ports/broker-physical-devices.js';
import type { BrokerOwnerCleanupPorts } from './device-lab/ports/broker-owner-cleanup.js';
import { createHyperVDesktopTransferApplication } from "./device-lab/application/hyper-v-desktop-transfer.js";
import type { HyperVDesktopTransferPorts } from "./device-lab/ports/hyper-v-desktop-transfer.js";
import { desktopRecord, type DesktopOutcome, type DesktopFailureCategory } from "./device-lab/domain/hyper-v-desktop-transfer.js";
import type { BrokerHyperVSnapshotPorts } from "./device-lab/ports/lifecycle/hyper-v-snapshots.js";
import { createBrokerHyperVSnapshotApplication } from "./device-lab/application/lifecycle/hyper-v-snapshots.js";
import { isSnapshotTool, snapshotInvocationLimits, type SnapshotAllowance } from "./device-lab/domain/lifecycle/hyper-v-snapshots.js";
import { createBrokerRecordingApplication } from "./device-lab/application/broker-recording.js";
type BrokerAppiumVerification = {ok: true; serverUrl: string; port?: number; [field: string]: unknown} | {ok: false; error: string; [field: string]: unknown};
import { createBrokerAppiumApplication } from "./device-lab/application/broker-appium.js";
import { validateAppiumParams, appiumParamError, brokerOwnedAppiumPid, brokerOwnedAppiumEndpoint, brokerOwnedAppiumPort, brokerOwnedAppiumRuntime } from "./device-lab/domain/broker-appium.js";
import { createBrokerOwnerApplication } from "./device-lab/application/broker-owner.js";
import type { BrokerOwnerRegistration as DeviceBrokerOwnerRegistration } from "./device-lab/domain/broker-owner.js";
import type { BrokerAuthQuarantine } from "./device-lab/ports/broker-owner.js";
import { createBrokerPhysicalLeasesApplication } from "./device-lab/application/broker-physical-leases.js";
import { validateLeaseParams, type LeaseParamSuccess, type LeaseFailure } from "./device-lab/domain/broker-physical-leases.js";
import { createBrokerWindowsSandboxLifecycle } from "./device-lab/application/lifecycle/windows-sandbox-lifecycle.js";
import { brokerWindowsSandboxReplacement } from "./device-lab/domain/lifecycle/windows-sandbox-lifecycle.js";
import type { BrokerWindowsSandboxLifecyclePorts } from "./device-lab/ports/lifecycle/windows-sandbox-lifecycle.js";
import { createBrokerIosSimulatorLifecycle, createBrokerIosRecord, rollbackBrokerIosCreate } from "./device-lab/application/lifecycle/ios-simulator-lifecycle.js";
import { createBrokerMacosVmLifecycle, createBrokerMacosRecord, rollbackBrokerMacosCreate } from "./device-lab/application/lifecycle/macos-vm-lifecycle.js";
import { brokerIosReplacement, brokerIosUniqueFields, type BrokerIosConditionalShutdownExecution } from "./device-lab/domain/lifecycle/ios-simulator-lifecycle.js";
import { brokerMacosReplacement, brokerMacosUniqueFields, isBrokerMacosTartImageCreate, BROKER_MACOS_TART_CLONE_TIMEOUT_MS, BROKER_MACOS_TART_CREATE_TIMEOUT_MS, type BrokerMacosMetadataPurpose, type BrokerMacosHelperPreparation } from "./device-lab/domain/lifecycle/macos-vm-lifecycle.js";
import type { BrokerIosSimulatorLifecyclePorts } from "./device-lab/ports/lifecycle/ios-simulator-lifecycle.js";
import type { BrokerMacosVmLifecyclePorts } from "./device-lab/ports/lifecycle/macos-vm-lifecycle.js";
import { allocateBrokerAndroidCreatePort, createBrokerAndroidEmulatorLifecycle, createBrokerAndroidRecord } from "./device-lab/application/lifecycle/android-emulator-lifecycle.js";
import type { BrokerAndroidEmulatorLifecyclePorts } from "./device-lab/ports/lifecycle/android-emulator-lifecycle.js";
import { createBrokerWindowsSandboxCreate } from "./device-lab/application/lifecycle/windows-sandbox-create.js";
import { brokerWindowsSandboxRecord } from "./device-lab/domain/lifecycle/windows-sandbox-create.js";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { createFocusedInventory, createOwnerInventory } from "./device-lab/application/broker-observation-inventory.js";
import { createLeaseDatePolicy, createLeaseDirectoryScan, createLeaseList, createPhysicalComposite } from "./device-lab/application/broker-observation-leases.js";
import { createAppiumObservations } from "./device-lab/application/broker-observation-appium.js";
import { createBrokerService, createBrokerStatus, createBrokerDeviceStatus } from "./device-lab/application/broker-observation-status.js";
import { createAndroidPreviewPortAllocation, createLifecyclePreview } from "./device-lab/application/broker-observation-command-plan.js";
import { hyperVPreviewConflicts } from "./device-lab/domain/broker-observation-command-plan.js";
import { desktopGuestCommand, desktopRemoteReadCommand, desktopRemoteReadOutputLimit, observeDesktopExecution, observeDesktopDirect, observeDesktopDirectFailure, desktopReceiptPresentation } from "./device-lab/broker/hyper-v/desktop-native.js";
import { spawn, spawnSync } from "child_process";
import { accessSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "http";
import { constants as osConstants, homedir, hostname, uptime } from "os";
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { isDeepStrictEqual } from "util";
import { Worker } from "worker_threads";
import { androidAvdHome, listOwnedAndroidAvdArtifactsAsync, ownedAndroidAvdName, removeOwnedAndroidAvdArtifactsAsync } from "@ccc/device-lab/providers/state/android-avd-storage.mjs";
import { readAndroidAvdIdentityAsync } from "@ccc/device-lab/providers/state/android-avd-identity.mjs";
import { androidCreationChoices } from "@ccc/device-lab/providers/backends/android-sdk-inventory.mjs";
import { DEVICE_BROKER_PROTOCOL_VERSION, isCompatibleBrokerProtocol } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import { configuredDeviceBrokerPort, deviceBrokerRuntimeFilename } from "@ccc/device-lab/providers/contracts/broker-endpoint.mjs";
import { deviceLabOwnerFromProjectMountPath, deviceLabOwnerId as canonicalDeviceLabOwnerId, deviceLabProjectMountPath } from "./device-lab-owner.js";
import { assertOwnerDeviceStateWritable, ownerDeviceStateErrorCode, readOwnerDeviceStateFile } from "./device-lab-owner-state.js";
import { readPhysicalLeaseStateFile, readWindowsSandboxLockStateFile, validatePhysicalLease, validateWindowsSandboxLock } from "./device-lab-ownership-state.js";
import { deviceLabProjectEnumerationErrorCode, enumerateDeviceProjectIds } from "./device-lab-project-state.js";
import { assertDeviceLabPathWithinRoot, deviceLabStateFileErrorCode, readDeviceLabBinaryFile, readDeviceLabBinaryFileWithinRoot, readDeviceLabStateFile, readDeviceLabTextFile, withDeviceLabReadableFile, writeDeviceLabBinaryFile } from "./device-lab-state-file.js";
import { deviceRuntimeProcessIdentityMatches, inspectDeviceRuntimeProcessIdentity, inspectDeviceRuntimeProcessIdentityAsync, probeDeviceRuntimeProcessLiveness, readDeviceRuntimeProcessIdentity, readDeviceRuntimeProcessIdentityAsync, readDeviceRuntimeProcessStartToken, signalDeviceRuntimeProcess, signalDeviceRuntimeProcessAsync, type DeviceRuntimeProcessIdentity } from "./device-lab-process-identity.js";
import { withSharedMutationLock, withSharedMutationLockAsync, writeFileAtomically, writeJsonFileAtomically } from "./device-lab-shared-state.js";
import { canonicalWindowsPowerShellPath, canonicalWindowsPowerShellPathAsync, canonicalWindowsSystemExecutablePath, canonicalWindowsSystemExecutablePathAsync, hiddenWindowsPowerShellArgs, terminateWindowsProcessByStartToken, terminateWindowsProcessByStartTokenAsync, windowsHandleBoundTerminationScript, windowsStartTokenExpression } from "./windows-system-powershell.js";
import { assertHyperVOperationDeadline, HyperVOperationDeadlineError, hyperVOperationDeadlineExpired, hyperVRemainingTimeout } from "./device-lab/broker/hyper-v/deadline.js";
import { hyperVCreateVhdReadError, inspectHyperVCreateVhd } from "./device-lab/broker/hyper-v/vhd-create-inspection.js";
import {
    assertNoSymlinkPathComponents,
    hyperVImageProfile,
    hyperVImageRoot as hyperVImageStoreRoot,
    inspectHyperVUbuntuImageCache,
    readHyperVImageManifestMetadata as readHyperVImageManifestMetadataFromStore,
    resolveHyperVImageForCreateOutcome as resolveHyperVImageForCreateFromStore,
    type HyperVImageProfile,
} from "./device-lab/broker/hyper-v/image-store.js";
import { createHostBackendDiscovery } from "./device-lab/application/broker-observation-discovery.js";
import { decodeHyperVNetworkState } from "./device-lab/broker/hyper-v/network-state.js";
import {
    cachedHyperVOwnerDevicesReader,
    ensureHyperVHostNetworkFabric as ensureHyperVHostNetworkFabricWithRuntime,
    ensureHyperVNetworkAllocationOutcome as ensureHyperVNetworkAllocationWithRuntime,
    hyperVNetworkAllocationReferenced,
    type HyperVNetworkFabricResult,
    reconcileHyperVLinuxSshHostIdentity as reconcileHyperVLinuxSshHostIdentityWithRuntime,
    releaseHyperVNetworkAllocationAndCleanupOutcome as releaseHyperVNetworkAllocationAndCleanupWithRuntime,
    validateHyperVLinuxSshHostIdentity as validateHyperVLinuxSshHostIdentityWithRuntime,
    type HyperVNetworkRuntime,
    type HyperVNetworkStateRuntime,
} from "./device-lab/broker/hyper-v/network.js";
import {
    clearHyperVOperationJournal as clearHyperVOperationJournalFile,
    clearHyperVSnapshotJournal,
    hyperVOperationJournalPath as hyperVOperationJournalFilePath,
    hyperVSnapshotJournalPath as hyperVSnapshotJournalFilePath,
    readHyperVOperationJournal as readHyperVOperationJournalFile,
    readHyperVSnapshotJournal as readHyperVSnapshotJournalFile,
    recordHyperVSnapshotCreatedId,
    writeHyperVOperationJournal as writeHyperVOperationJournalFile,
    writeHyperVSnapshotJournal as writeHyperVSnapshotJournalFile,
    type HyperVJournalPersistenceRuntime,
    type HyperVOperationJournal,
    type HyperVSnapshotJournal,
} from "./device-lab/broker/hyper-v/operation-journal.js";
import {
    createDeviceLabHyperVWindowsClient,
    reconcileDeviceLabHyperVOperation,
} from "./device-lab/broker/hyper-v/lifecycle-adapter.js";
import { createDeviceLabHyperVWindowsNetworkClient, type DeviceLabHyperVAdministratorPurpose } from "./device-lab/broker/hyper-v/network-adapter.js";
import { invokeDeviceLabHyperVGuestDirect } from "./device-lab/broker/hyper-v/guest-direct-adapter.js";
import { deviceLabWindowsReadinessPorts, deviceLabWindowsReadinessObservation, deviceLabHyperVReadinessFailure,
    deviceLabHyperVLinuxReadinessObservation, deviceLabHyperVLinuxGuiReadinessObservation,
    parseHyperVLinuxEd25519HostKeyFingerprints } from "./device-lab/broker/hyper-v/guest-readiness-adapter.js";
import { provisionDeviceLabHyperVWindowsGuest } from "./device-lab/broker/hyper-v/windows-guest-provisioning.js";
import { attachDeviceLabHyperVLinuxSeedMedia, inspectDeviceLabHyperVLinuxSeedTarget, linuxSeedFailureCode } from "./device-lab/broker/hyper-v/linux-seed-provisioning.js";
import { readDeviceLabHyperVGuestBootDiagnostic } from "./device-lab/broker/hyper-v/guest-boot-diagnostic-adapter.js";
import { observeDeviceLabHyperVStatus } from "./device-lab/broker/hyper-v/status.js";
import { executeDeviceLabHyperVPower, type DeviceLabHyperVPowerOptions, type HyperVMemoryCapacity } from "./device-lab/broker/hyper-v/power.js";
import { currentHyperVConsoleFrame, forgetHyperVConsoleFrame, hyperVConsoleFrameKey, rememberHyperVConsoleFrame, withHyperVConsoleLock } from "./device-lab/broker/hyper-v/console.js";
import { deleteDeviceLabHyperVVm } from "./device-lab/broker/hyper-v/delete.js";
import { assertHyperVHostCapacity, cloneHyperVBaseImage } from "./device-lab/broker/hyper-v/vm-create-preflight.js";
import { planHyperVVirtualMachineCreationCompensation } from "@ccc/hyper-v/lifecycle/index.js";
import { createHyperVCreateStartApplication } from "./device-lab/application/lifecycle/hyper-v-create-start.js";
import type { HyperVCreateStartPorts } from "./device-lab/ports/lifecycle/hyper-v-create-start.js";
import { deviceLabVmCreationPorts } from "./device-lab/broker/hyper-v/vm-create-adapter.js";
import { cleanupDeviceLabHyperVBootstrapNetwork, probeDeviceLabHyperVBootstrapNetwork } from "./device-lab/broker/hyper-v/bootstrap-network-adapter.js";
import type { DeviceLabHyperVOwnedVm } from "./device-lab/broker/hyper-v/vm-network-adapter.js";

import type { HyperVWindowsOperation } from "@ccc/hyper-v/low-level/index.js";
import { withElevatedHyperVNetworkExecutor, type WithElevatedHyperVNetworkExecutorOptions } from "./device-lab/broker/hyper-v/elevated-network-session.js";
import { hyperVElevationGateStatus, withHyperVElevationGate } from "./device-lab/broker/hyper-v/elevation-gate.js";
import { hyperVBoundedErrorCode, hyperVProviderDiagnosticCode, hyperVTypedErrorCode, hyperVTypedErrorOperation, hyperVTypedNativeDiagnostics, publicHyperVCreateConfiguration, redactHyperVDeviceSecrets, redactHyperVResultSecrets, redactProviderCommandInput } from "./device-lab/broker/hyper-v/public-response.js";
export { redactProviderCommandInput } from "./device-lab/broker/hyper-v/public-response.js";
import { type DeviceLabHyperVCommandResult, type DeviceLabHyperVWindowsClientOptions, createRecordingDeviceLabHyperVWindowsClient } from "./device-lab/broker/hyper-v/lifecycle-adapter.js";
import { brokerHyperVWindowsSession, retainBrokerHyperVWindowsSessions } from "./device-lab/broker/hyper-v/session-pool.js";
import { createHyperVWindowsNetworkClient, HyperVWindowsError, type HyperVWindowsExecutor } from "@ccc/hyper-v/index.js";
import {
    createDeviceLabHyperVSnapshot,
    hyperVSnapshotObservationMismatch,
    deleteDeviceLabHyperVSnapshot,
    repairDeviceLabHyperVSnapshotState,
    restoreDeviceLabHyperVSnapshot,
} from "./device-lab/broker/hyper-v/snapshots.js";
import { assertHyperVPrivateDeviceRoot, cleanupHyperVDeviceArtifacts, ensureHyperVPrivateDeviceRoot, hyperVDeviceIncarnationId, hyperVDeviceRoot, hyperVPrivateDeviceRoot, readHyperVIncarnationRecord, validHyperVIncarnationId, writeHyperVIncarnationRecord } from "./device-lab/broker/hyper-v/state.js";
import { decodeHyperVLinuxSeedObservation, hyperVCreateCommand, hyperVCreateCompensationCommand, hyperVCreatePrologueCommand, hyperVDeleteCommand, hyperVGuestProvisionMediaCommand, hyperVLinuxGuiPrepareCommand, hyperVLinuxGuiReadyCommand, hyperVLinuxNetworkFinalizeCommand, hyperVLinuxScpUploadCommand, hyperVLinuxSeedCommand, hyperVLinuxSshExecCommand, hyperVLinuxSshReadyCommand, hyperVReadinessCommand, hyperVRebootCommand, hyperVSnapshotName, hyperVStartCommand, hyperVStatusCommand, hyperVStopCommand, hyperVVmName, parseHyperVCreatePrologueFailure, parseHyperVCreatePrologueObservation, parseHyperVDeleteObservation, parseHyperVReadiness, parseHyperVVmObservation, ownershipMarker } from "./host-control/hyper-v/index.js";
import { iosSimulatorCreateCommand, iosSimulatorCreatedUdid, iosSimulatorDeleteCommand } from "@ccc/device-lab/device-lab/providers/ios-simulator.js";
import { DEVICE_LAB_VERSION } from "./version.js";

export const DEVICE_BROKER_DEFAULT_HOST = "127.0.0.1";
export const DEVICE_BROKER_DEFAULT_PORT = 17373;
export const DEVICE_BROKER_NAME = "ccc-device-broker";
export const DEVICE_BROKER_RPC_BODY_LIMIT = 64 * 1024;
export const DEVICE_BROKER_REQUEST_BODY_TIMEOUT_MS = 5000;
export const DEVICE_BROKER_ERROR_RESPONSE_LIMIT = 256 * 1024;
export const DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES = 1024 * 1024;
export const DEVICE_BROKER_RPC_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const DEVICE_BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES = 32 * 1024;
export const DEVICE_BROKER_INVENTORY_FILE_LIMIT = 256 * 1024;
export const DEVICE_BROKER_INVENTORY_DEVICE_LIMIT = 200;
export const DEVICE_BROKER_PHYSICAL_LEASE_DIRECTORY_ENTRY_LIMIT = 1024;
export const DEVICE_BROKER_AUTH_DIRECTORY_ENTRY_LIMIT = 1024;
export const DEVICE_BROKER_COMMAND_TIMEOUT_MS = 5000;
export const DEVICE_BROKER_ANDROID_INVENTORY_TIMEOUT_MS = 15000;
const DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_MS = 30000;
const DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_BUFFER_MS = 15000;
export const DEVICE_BROKER_MAX_HELPER_TIMEOUT_MS = 300000;
export const DEVICE_BROKER_MAX_OPERATION_TIMEOUT_MS = 600000;
export const DEVICE_BROKER_HYPER_V_HOST_LOCK_WAIT_MS = 10 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_MAX_BOOT_TIMEOUT_MS = 20 * 60 * 1000;
const DEVICE_BROKER_HYPER_V_WINDOWS_NO_PROGRESS_TIMEOUT_MS = 5 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS = 5 * 60 * 1000;

export function hyperVLinuxGuestSignalDeadlineAt(startedAt: number): number {
    return coreLinuxSignalDeadline(startedAt);
}

export function hyperVLinuxGuestSignalTimedOut(startedAt: number, observedAt: number, guestSignalObserved: boolean): boolean {
    return coreLinuxSignalTimedOut(startedAt,observedAt,guestSignalObserved);
}
export const DEVICE_BROKER_HYPER_V_IMAGE_PREPARE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_IMAGE_LOCK_WAIT_MS = DEVICE_BROKER_HYPER_V_IMAGE_PREPARE_TIMEOUT_MS + 15000;
export const DEVICE_BROKER_HYPER_V_IMAGE_ACQUIRE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS = 5 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_CREATE_POST_ACQUIRE_BUDGET_MS = 80 * 60 * 1000 - 15000;
export const DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS = DEVICE_BROKER_HYPER_V_HOST_LOCK_WAIT_MS
    + DEVICE_BROKER_HYPER_V_IMAGE_LOCK_WAIT_MS
    + DEVICE_BROKER_HYPER_V_IMAGE_ACQUIRE_TIMEOUT_MS
    + DEVICE_BROKER_HYPER_V_CREATE_POST_ACQUIRE_BUDGET_MS;
export const DEVICE_BROKER_MAX_RPC_TIMEOUT_MS = DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS + 15000;
export const DEVICE_BROKER_HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS = 2 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_LINUX_GUI_TIMEOUT_MS = 17 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_LIFECYCLE_TIMEOUT_MS = DEVICE_BROKER_HYPER_V_HOST_LOCK_WAIT_MS
    + DEVICE_BROKER_HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS;

export function hyperVProviderDeadlineAt(
    backend: string,
    command: string,
    cleanupDeadlineAt: number,
): number {
    // windows-vm joins linux-vm here because it now has containment of its own to run after
    // readiness. Without the reserve, a bootTimeoutMs near the residual budget lets
    // assertHyperVOperationDeadline throw right after the readiness runner returns, which REPLACES
    // hyperVGuestReadyExecution with hyper-v-operation-deadline-exceeded. The un-scrubbed reason is
    // gone by the time containment reads it, so containment never runs, scrubContainmentFailed is
    // never set either, and a guest with a live autologon stays up with nothing saying so.
    const needsCleanupReserve = command === "device_create"
        || ((backend === "linux-vm" || backend === "windows-vm")
            && (command === "device_start" || command === "device_reboot"));
    return needsCleanupReserve && Number.isFinite(cleanupDeadlineAt)
        ? cleanupDeadlineAt - DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS
        : cleanupDeadlineAt;
}

export function hyperVLifecycleCleanupTimeoutMs(
    backend: string,
    command: string,
    operationTimeoutMs: number,
): number {
    return operationTimeoutMs + ((backend === "linux-vm" || backend === "windows-vm")
        && (command === "device_start" || command === "device_reboot")
        ? DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS
        : 0);
}

function hyperVLifecycleOperationTimeoutMs(parsed: CommandParamSuccess): number {
    if ((parsed.command !== "device_start" && parsed.command !== "device_reboot") || parsed.waitForBoot === false) {
        return DEVICE_BROKER_HYPER_V_LIFECYCLE_TIMEOUT_MS;
    }
    const bootTimeoutMs = Number.isFinite(parsed.bootTimeoutMs)
        ? Math.min(DEVICE_BROKER_HYPER_V_MAX_BOOT_TIMEOUT_MS, Math.max(1000, Number(parsed.bootTimeoutMs)))
        : 5 * 60 * 1000;
    return DEVICE_BROKER_HYPER_V_LIFECYCLE_TIMEOUT_MS + bootTimeoutMs
        + (parsed.backend === "linux-vm" ? DEVICE_BROKER_HYPER_V_LINUX_GUI_TIMEOUT_MS : 0);
}
const DEVICE_BROKER_BOUNDED_WAIT_TOOLS = new Set(["mobile_wait_for_text", "mobile_wait_for_app"]);


const DEVICE_BROKER_APPIUM_FETCH_MAX_TIMEOUT_MS = 300000;

export const DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;

export const DEVICE_BROKER_COMMAND_OUTPUT_LIMIT = 32 * 1024;
export const DEVICE_BROKER_AUTO_START_TIMEOUT_MS = 30000;
const DEVICE_BROKER_STARTUP_ATTEMPT_HISTORY_LIMIT = 8;
const DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS = 180000;
const DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_CONFIRM_TIMEOUT_MS = 30000;
const DEVICE_BROKER_MACOS_PROVIDER_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
// The identity probe's wall-clock budget, unchanged from the fixed 25ms × 20 it replaces —
// what changed is how many launches fit inside it. Doubling from 25ms spends it across five
// sleeps (25+50+100+200+125) rather than twenty flat ones, and the loop still exits the instant
// both values are known, which is the ordinary case.
const DEVICE_BROKER_IDENTITY_PROBE_SLEEP_BUDGET_MS = 500;
// Six, down from twenty. "One probe per attempt" is true of the PRE-LOOP read and NOT of the
// loop, which is the arithmetic an earlier version of this comment got backwards: entering the
// loop requires `!identity || !token`, and `identity()` refuses to build an identity without a
// token, so loop entry implies identity is null and the standalone fallback fires on every
// attempt. Six attempts therefore cost twelve launches where the old twenty cost forty — a real
// reduction, but not the "fewer than the old three" this used to claim. The number is chosen so
// a slow host keeps six chances at a transient WMI failure; a wall-clock bound gave it none.
const DEVICE_BROKER_IDENTITY_PROBE_ATTEMPTS = 6;
const DEVICE_BROKER_IDENTITY_PROBE_FIRST_DELAY_MS = 25;
const DEVICE_BROKER_IDENTITY_PROBE_MAX_DELAY_MS = 200;
const DEVICE_BROKER_DETACHED_READY_MS = 150;
const DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS = 3000;
const DEVICE_BROKER_PHYSICAL_LEASE_TTL_MS = 60 * 60 * 1000;
const DEVICE_BROKER_AUTH_LOCK_WAIT_MS = 5000;
const DEVICE_BROKER_AUTH_LOCK_STALE_MS = 30000;
const DEVICE_BROKER_HYPER_V_HOST_LOCK_STALE_MS = 30 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_OWNER_QUOTA = Object.freeze({
    maxDefinedVms: 16,
    maxConfiguredMemoryMb: 256 * 1024,
    maxConfiguredCpus: 128,
    maxConfiguredDiskBytes: 2 * 1024 * 1024 * 1024 * 1024,
    maxRunningVms: 4,
    maxRunningMemoryMb: 128 * 1024,
    maxRunningCpus: 64,
});
const DEVICE_BROKER_OWNER_REGISTRATION_FILE_LIMIT_BYTES = 16 * 1024;
const DEVICE_BROKER_RUNTIME_FILE_LIMIT_BYTES = 64 * 1024;
const DEVICE_BROKER_SERVICE_OWNER_FILE_LIMIT_BYTES = 16 * 1024;
const DEVICE_BROKER_APPIUM_RUNTIME_MARKER_LIMIT_BYTES = 16 * 1024;
const DEVICE_BROKER_HYPER_V_OPERATION_JOURNAL_LIMIT_BYTES = 16 * 1024;
export const DEVICE_BROKER_APPIUM_PACKAGE_MANIFEST_LIMIT_BYTES = 64 * 1024;
export const DEVICE_BROKER_APPIUM_LOCK_MANIFEST_LIMIT_BYTES = 8 * 1024 * 1024;
const DEVICE_BROKER_APPIUM_ENTRY_LIMIT_BYTES = 16 * 1024 * 1024;
const DEVICE_BROKER_WINDOWS_CONFIG_LIMIT_BYTES = 256 * 1024;
const DEVICE_BROKER_WINDOWS_MINIMIZE_RESULT_LIMIT_BYTES = 64;
const ANDROID_EMULATOR_PORT_MIN = 5554;
const ANDROID_EMULATOR_PORT_MAX = 5682;
const DEVICE_BROKER_ANDROID_PORT_LOCK_WAIT_MS = 30000;
const DEVICE_BROKER_ANDROID_PORT_LOCK_STALE_MS = 15 * 60 * 1000;
const DEVICE_BROKER_BACKEND_STATE_KEYS = ["android", "android-device", "ios", "ios-device", "windows", "windows-vm", "linux-vm", "macos"];
const DEVICE_BROKER_PHYSICAL_BACKENDS = new Set(["android-device", "ios-device"]);
const DEVICE_BROKER_MACOS_PROVIDER_NAMES = ["tart", "vz", "utmctl"] as const;
const DEVICE_BROKER_MACOS_PROVIDERS = new Set<string>(DEVICE_BROKER_MACOS_PROVIDER_NAMES);
const ANDROID_EMULATOR_CAPABILITIES = [
    "device_list_files",
    "device_inventory", "device_create", "device_delete", "device_start", "device_stop",
    "device_status", "device_exec", "device_screenshot",
    "device_record_video_start", "device_record_video_stop", "device_record_video_status",
    "device_upload", "device_download",
    "device_install_app", "device_launch_app",
    "mobile_session_status", "mobile_dump_ui", "mobile_tap",
    "mobile_double_tap", "mobile_long_press", "mobile_swipe",
    "mobile_drag",
    "mobile_type_text", "mobile_key", "mobile_home", "mobile_back",
    "mobile_forward", "mobile_recents", "mobile_power", "mobile_lock",
    "mobile_unlock", "mobile_rotate_left", "mobile_rotate_right",
    "mobile_set_orientation", "mobile_open_url", "mobile_install_app",
    "mobile_launch_app", "mobile_uninstall_app", "mobile_stop_app",
    "mobile_clear_app_data", "mobile_grant_permission", "mobile_revoke_permission",
    "mobile_set_location", "mobile_set_battery", "mobile_set_network",
    "mobile_toggle_airplane_mode", "mobile_set_clipboard",
    "mobile_get_clipboard", "mobile_wait_for_text", "mobile_wait_for_app",
    "mobile_screenshot",
];
const ANDROID_REAL_CAPABILITIES = [
    "device_list_files",
    "device_inventory", "device_attach", "device_detach", "device_start", "device_stop",
    "device_status", "device_wireless", "device_exec", "device_screenshot",
    "device_record_video_start", "device_record_video_stop", "device_record_video_status",
    "device_upload", "device_download",
    "device_install_app", "device_launch_app",
    "mobile_session_status", "mobile_dump_ui", "mobile_tap",
    "mobile_double_tap", "mobile_long_press", "mobile_swipe",
    "mobile_drag", "mobile_type_text", "mobile_key", "mobile_home",
    "mobile_back", "mobile_forward", "mobile_recents", "mobile_power",
    "mobile_lock", "mobile_unlock", "mobile_rotate_left", "mobile_rotate_right",
    "mobile_set_orientation", "mobile_open_url", "mobile_install_app",
    "mobile_launch_app", "mobile_uninstall_app", "mobile_stop_app",
    "mobile_clear_app_data", "mobile_grant_permission", "mobile_revoke_permission",
    "mobile_set_clipboard",
    "mobile_get_clipboard", "mobile_wait_for_text", "mobile_wait_for_app",
    "mobile_screenshot",
];
const IOS_SIMULATOR_CAPABILITIES = [
    "device_list_files",
    "device_inventory", "device_create", "device_delete", "device_start", "device_stop",
    "device_status", "device_exec", "device_screenshot",
    "device_record_video_start", "device_record_video_stop", "device_record_video_status",
    "device_upload", "device_download", "device_reset",
    "device_install_app", "device_launch_app", "mobile_open_url", "mobile_install_app",
    "mobile_launch_app", "mobile_screenshot", "mobile_session_status", "mobile_dump_ui",
    "mobile_tap", "mobile_double_tap", "mobile_long_press", "mobile_swipe",
    "mobile_drag", "mobile_type_text", "mobile_key", "mobile_home", "mobile_lock",
    "mobile_unlock", "mobile_rotate_left", "mobile_rotate_right", "mobile_set_orientation",
    "mobile_uninstall_app", "mobile_stop_app", "mobile_clear_app_data",
    "mobile_grant_permission", "mobile_revoke_permission", "mobile_set_location",
    "mobile_set_clipboard", "mobile_get_clipboard", "mobile_wait_for_text", "mobile_wait_for_app",
];
const IOS_REAL_CAPABILITIES = [
    "device_inventory", "device_attach", "device_detach", "device_start", "device_stop",
    "device_status", "device_wireless", "mobile_session_status", "mobile_dump_ui",
    "device_screenshot", "device_install_app", "device_launch_app",
    "mobile_install_app", "mobile_launch_app", "mobile_screenshot",
    "mobile_tap", "mobile_double_tap", "mobile_long_press", "mobile_swipe",
    "mobile_drag", "mobile_type_text", "mobile_key", "mobile_home",
    "mobile_lock", "mobile_unlock", "mobile_rotate_left", "mobile_rotate_right",
    "mobile_set_orientation", "mobile_wait_for_text", "mobile_wait_for_app",
    "mobile_stop_app",
];
const DESKTOP_DEVICE_CAPABILITIES = [
    "device_list_files",
    "device_inventory", "device_create", "device_delete", "device_start", "device_stop",
    "device_status", "device_exec", "device_screenshot", "device_click",
    "device_double_click", "device_drag", "device_focus_window", "device_key", "device_type", "device_scroll",
    "device_cursor_position", "device_window_list", "device_accessibility_snapshot",
    "device_record_video_start", "device_record_video_stop", "device_record_video_status",
    "device_upload", "device_download",
];
const MACOS_VM_CAPABILITIES = [
    ...DESKTOP_DEVICE_CAPABILITIES,
    "device_base_image_create", "device_base_image_clone",
    "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete",
];
const HYPER_V_VM_CAPABILITIES = [
    "device_window_list",
    "device_list_files",
    "device_inventory", "device_create", "device_delete", "device_start", "device_stop", "device_reboot", "device_status",
    "device_exec", "device_upload", "device_download",
    "device_screenshot", "device_click", "device_double_click", "device_drag", "device_focus_window", "device_key", "device_type", "device_scroll", "device_cursor_position",
    "device_snapshot_list", "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete",
];
const HYPER_V_LINUX_VM_CAPABILITIES = [...HYPER_V_VM_CAPABILITIES];
const DEVICE_BROKER_COMMAND_BACKENDS = new Map([
    ["android-emulator", "android"],
    ["android-device", "android-device"],
    ["ios-simulator", "ios"],
    ["ios-device", "ios-device"],
    ["windows-sandbox", "windows"],
    ["windows-vm", "windows-vm"],
    ["linux-vm", "linux-vm"],
    ["macos-vm", "macos"],
]);
const DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS = [
    "windows-sandbox",
    "windows-vm",
    "linux-vm",
    "macos-vm",
    "android-emulator",
    "android-device",
    "ios-simulator",
    "ios-device",
];
const DEVICE_BROKER_CREATABLE_BACKENDS = new Set(["android-emulator", "ios-simulator", "windows-sandbox", "windows-vm", "linux-vm", "macos-vm"]);
const DEVICE_BROKER_APPIUM_BACKENDS = new Map([
    ["android-emulator", "android"],
    ["android-device", "android-device"],
    ["ios-simulator", "ios"],
    ["ios-device", "ios-device"],
]);
const DEVICE_BROKER_STATE_BACKENDS = new Map([...DEVICE_BROKER_COMMAND_BACKENDS].map(([backend, stateKey]) => [stateKey, backend]));
const DEVICE_BROKER_HYPER_V_BACKENDS = new Set(["windows-vm", "linux-vm"]);

function isHyperVBackend(backend: string | null | undefined): boolean {
    return typeof backend === "string" && DEVICE_BROKER_HYPER_V_BACKENDS.has(backend);
}


const DEVICE_BROKER_LIFECYCLE_COMMANDS = new Set(["device_create", "device_status", "device_start", "device_stop", "device_reboot", "device_delete"]);
const LIFECYCLE_METHOD_RE = /^(device|mobile)\./;
const DEVICE_BROKER_DESKTOP_TOOL_METHODS = new Set([
    "device_exec",
    "device_screenshot",
    "device_click",
    "device_double_click",
    "device_drag",
    "device_focus_window",
    "device_key",
    "device_type",
    "device_scroll",
    "device_cursor_position",
    "device_window_list",
    "device_accessibility_snapshot",
]);
const DEVICE_BROKER_DESKTOP_FILE_TOOL_METHODS = new Set([
    "device_upload",
    "device_download",
]);
const DEVICE_BROKER_ANDROID_TOOL_METHODS = new Set([
    "device_status",
    "device_exec",
    "device_screenshot",
    "device_upload",
    "device_download",
    "device_reset",
    "device_install_app",
    "device_launch_app",
    "mobile_session_status",
    "mobile_dump_ui",
    "mobile_tap",
    "mobile_double_tap",
    "mobile_long_press",
    "mobile_swipe",
    "mobile_drag",
    "mobile_type_text",
    "mobile_key",
    "mobile_home",
    "mobile_back",
    "mobile_forward",
    "mobile_recents",
    "mobile_power",
    "mobile_lock",
    "mobile_unlock",
    "mobile_rotate_left",
    "mobile_rotate_right",
    "mobile_set_orientation",
    "mobile_open_url",
    "mobile_install_app",
    "mobile_launch_app",
    "mobile_uninstall_app",
    "mobile_stop_app",
    "mobile_clear_app_data",
    "mobile_grant_permission",
    "mobile_revoke_permission",
    "mobile_set_location",
    "mobile_set_battery",
    "mobile_set_network",
    "mobile_toggle_airplane_mode",
    "mobile_set_clipboard",
    "mobile_get_clipboard",
    "mobile_wait_for_text",
    "mobile_wait_for_app",
    "mobile_screenshot",
]);
const DEVICE_BROKER_ANDROID_PHYSICAL_UNSAFE_BASE_TOOLS = new Set([
    "mobile_set_location",
    "mobile_set_battery",
    "mobile_set_network",
    "mobile_toggle_airplane_mode",
]);
const DEVICE_BROKER_ANDROID_DEVICE_TOOL_METHODS = new Set(
    ["device_wireless", ...DEVICE_BROKER_ANDROID_TOOL_METHODS].filter((tool) => !DEVICE_BROKER_ANDROID_PHYSICAL_UNSAFE_BASE_TOOLS.has(tool)),
);
const DEVICE_BROKER_IOS_SIMULATOR_TOOL_METHODS = new Set([
    "device_list_files",
    "device_status",
    "device_exec",
    "device_screenshot",
    "device_upload",
    "device_download",
    "device_reset",
    "device_install_app",
    "device_launch_app",
    "mobile_open_url",
    "mobile_install_app",
    "mobile_launch_app",
    "mobile_screenshot",
    "mobile_session_status",
    "mobile_dump_ui",
    "mobile_tap",
    "mobile_double_tap",
    "mobile_long_press",
    "mobile_swipe",
    "mobile_drag",
    "mobile_type_text",
    "mobile_key",
    "mobile_home",
    "mobile_lock",
    "mobile_unlock",
    "mobile_rotate_left",
    "mobile_rotate_right",
    "mobile_set_orientation",
    "mobile_uninstall_app",
    "mobile_stop_app",
    "mobile_clear_app_data",
    "mobile_grant_permission",
    "mobile_revoke_permission",
    "mobile_set_location",
    "mobile_set_clipboard",
    "mobile_get_clipboard",
    "mobile_wait_for_text",
    "mobile_wait_for_app",
]);
const DEVICE_BROKER_IOS_DEVICE_TOOL_METHODS = new Set([
    "device_wireless",
    "device_status",
    "device_screenshot",
    "device_install_app",
    "device_launch_app",
    "mobile_install_app",
    "mobile_launch_app",
    "mobile_screenshot",
    "mobile_session_status",
    "mobile_dump_ui",
    "mobile_tap",
    "mobile_double_tap",
    "mobile_long_press",
    "mobile_swipe",
    "mobile_drag",
    "mobile_type_text",
    "mobile_key",
    "mobile_home",
    "mobile_lock",
    "mobile_unlock",
    "mobile_rotate_left",
    "mobile_rotate_right",
    "mobile_set_orientation",
    "mobile_wait_for_text",
    "mobile_wait_for_app",
    "mobile_stop_app",
]);
const DEVICE_BROKER_BACKEND_TOOL_METHODS = new Set([
    ...DEVICE_BROKER_DESKTOP_TOOL_METHODS,
    ...DEVICE_BROKER_DESKTOP_FILE_TOOL_METHODS,
    ...DEVICE_BROKER_ANDROID_TOOL_METHODS,
    ...DEVICE_BROKER_IOS_SIMULATOR_TOOL_METHODS,
    ...DEVICE_BROKER_IOS_DEVICE_TOOL_METHODS,
    "device_snapshot_list",
    "device_snapshot_create",
    "device_snapshot_restore",
    "device_snapshot_delete",
]);
const DEVICE_BROKER_UNATTACHED_TOOL_METHODS = new Set(["device_wireless"]);
const DEVICE_BROKER_TOOL_METHODS = new Set(["device_inventory", "device_record_video_status", "device_record_video_start", "device_record_video_stop", ...DEVICE_BROKER_BACKEND_TOOL_METHODS]);
const DEVICE_BROKER_READ_ONLY_TOOL_METHODS = new Set([
    "device_list_files",
    "device_inventory",
    "device_status",
    "device_snapshot_list",
    "device_screenshot",
    "device_cursor_position",
    "device_window_list",
    "device_accessibility_snapshot",
    "device_record_video_status",
    "mobile_session_status",
    "mobile_dump_ui",
    "mobile_get_clipboard",
    "mobile_wait_for_text",
    "mobile_wait_for_app",
    "mobile_screenshot",
]);
const DEVICE_BROKER_MUTATING_RPC_METHODS = new Set([
    "broker.cleanup.owner",
    "broker.lease.claim",
    "broker.lease.heartbeat",
    "broker.lease.prune",
    "broker.lease.release",
    "broker.physical.attach",
    "broker.physical.detach",
    "broker.apple.trust",
    "broker.command.invoke",
    "broker.appium.record",
    "broker.appium.clear",
    "broker.appium.start",
    "broker.appium.stop",
    "broker.appium.session.ensure",
    "broker.appium.session.delete",
    "broker.appium.request",
]);
const brokerOwnerMutationTails = new Map<string, Promise<void>>();
const brokerAuthNonces = new Map<string, number>();
const DEVICE_BROKER_SERVICE_ACTIONS = new Set(["status"]);


export interface DeviceBrokerOptions {
    cwd?: string;
    profile?: string;
    host?: string;
    port?: number;
    env?: NodeJS.ProcessEnv;
    startedAt?: string;
    ownerId?: string;
    providerPaths?: Record<string, string>;
    commandTimeoutMs?: number;
    requestBodyTimeoutMs?: number;
    hyperVMonotonicNow?: () => number;
    commandRunner?: ProviderCommandRunner;
    deviceToolRunner?: BrokerDeviceToolRunner;
    windowsDeviceArtifactCleaner?: (ownerId: string, deviceId: string) => WindowsSandboxDeviceArtifactCleanup;
    platform?: NodeJS.Platform;
    cliPath?: string;
    trustedCliPaths?: string[];
    portProcessResolver?: BrokerPortProcessResolver;
}

type BrokerRpcResult = { status: number; payload: unknown };
type NormalizedBrokerOptions = {
    cwd: string;
    profile?: string;
    host: string;
    port: number;
    env: NodeJS.ProcessEnv;
    runtimeFile: string;
    startedAt: string;
    providerPaths: Record<string, string>;
    commandTimeoutMs: number;
    explicitCommandTimeoutMs?: number;
    macosCreateRemainingMs?: () => number;
    macosStartRemainingMs?: () => number;
    requestBodyTimeoutMs: number;
    hyperVMonotonicNow: () => number;
    commandRunner: ProviderCommandRunner;
    deviceToolRunner: BrokerDeviceToolRunner;
    windowsDeviceArtifactCleaner: (ownerId: string, deviceId: string) => WindowsSandboxDeviceArtifactCleanup;
    usesDefaultCommandRunner: boolean;
    platform: NodeJS.Platform;
    cliPath: string;
    trustedCliPaths: string[];
    portProcessResolver: BrokerPortProcessResolver;
    strictAppiumPortOwnership: boolean;
    cleanupObservation?: { changed: boolean; auxiliary?: AuxiliaryOutcome; execution?: ProviderCommandResult };
    cleanupDeadlineAt?: number;
};
type CommandParamError = { ok: false; status: number; error: string; allowed?: string[]; detail?: string };
type CommandParamSuccess = {
    ok: true;
    backend: string;
    stateKey: string;
    command: string;
    deviceId: string;
    force: boolean;
    startIfStopped?: boolean;
    dryRun: boolean;
    headless?: boolean;
    minimized?: boolean;
    waitForBoot?: boolean;
    bootTimeoutMs?: number;
    deleteAvd?: boolean;
    deleteSimulator?: boolean;
    preserveNetwork?: boolean;
    create?: Record<string, unknown>;
};
type AppiumParamError = { ok: false; status: number; error: string; allowed?: string[] };

type AppiumListParamSuccess = {
    ok: true;
    backend: string;
    stateKey: string;
};

type DeviceToolParamError = { ok: false; status: number; error: string; detail?: string; allowed?: string[]; supported?: string[] };
type DeviceToolParamSuccess = {
    ok: true;
    tool: string;
    backend: string | null;
    stateKey: string | null;
    deviceId: string | null;
    remotePath: string | null;
    localPath: string | null;
    timeLimitSec: number | null;
    params: Record<string, unknown>;
};
type AttachParamError = { ok: false; status: number; error: string; allowed?: string[] };
type AttachParamSuccess = {
    ok: true;
    backend: string;
    stateKey: string;
    deviceId: string;
    name: string | null;
    serial: string | null;
    udid: string | null;
    connection: string;
    connectionProvided: boolean;
    host: string | null;
    port: number | null;
};
export type ProviderCommand = {
    mode: "exec" | "detached" | "noop";
    provider: string;
    executable?: string;
    args?: string[];
    input?: string;
    reason?: string;
    sandboxId?: string;
    requestedSandboxId?: string;
    windowStyle?: "minimized";
    waitForExit?: boolean;
    windowsHiddenLauncher?: boolean;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
};
export type ProviderCommandResult = {
    mode: string;
    provider: string;
    executable?: string;
    args?: string[];
    input?: string;
    status?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    pid?: number;
    processIdentity?: DeviceRuntimeProcessIdentity;
    timedOut?: boolean;
    outputLimitExceeded?: boolean;
    cleanup?: BrokerProcessTreeCleanup;
    capacity?: HyperVMemoryCapacity;
    typedCreateInvalidResult?: boolean;
    typedCreateOperation?: HyperVWindowsOperation;
    typedCreateNativeDiagnostics?: ReturnType<typeof hyperVTypedNativeDiagnostics>;
};
type ProviderCommandRunnerOptions = {
    timeoutMs: number;
    outputLimit: number;
    wrapperTimeoutMs?: number;
    cleanupGraceMs?: number;
    remainingMs?: () => number;
};
type ProviderCommandRunner = (command: ProviderCommand, options: ProviderCommandRunnerOptions) => ProviderCommandResult;
type BrokerDeviceToolRunner = (ownerId: string, parsed: DeviceToolParamSuccess, match: DeviceToolMatch, normalized: NormalizedBrokerOptions) => BrokerRpcResult | Promise<BrokerRpcResult>;
type ServiceAction = "status";
type ServicePlan = {
    supported: boolean;
    platform: NodeJS.Platform;
    manager: string;
    serviceName: string;
    definitionPath: string | null;
    command: string[];
    diagnostics: string[];
    files: { path: string; content: string }[];
    commands: ProviderCommand[];
};
type ServiceOwnerRecord = {
    ownerId: string;
    serviceName: string;
    manager: string;
    installedAt: string;
    updatedAt: string;
};
type BrokerSpawn = typeof spawn;
export type BrokerPortProcess = {
    pid: number;
    commandLine?: string | null;
    processIdentity?: DeviceRuntimeProcessIdentity | null;
    processStartToken?: string | null;
};
export type BrokerPortProcessResolver = (port: number, platform: NodeJS.Platform, remainingMs?: () => number) => BrokerPortProcess | null;

/** Host-process effect dependency; invoked only after the caller verifies the process generation. */
export type HostBrokerProcessTerminator = (
    pid: number,
    expectedIdentity: DeviceRuntimeProcessIdentity | undefined,
    expectedStartToken: string | undefined,
) => { ok: boolean; error?: string };

export interface HostDeviceBrokerOptions extends DeviceBrokerOptions {
    bindHost?: string;
    probeHost?: string;
    timeoutMs?: number;
    startupTimeoutMs?: number;
    spawnImpl?: BrokerSpawn;
    portProcessResolver?: BrokerPortProcessResolver;
    processIdentityReader?: (pid: number, platform: NodeJS.Platform) => DeviceRuntimeProcessIdentity | null;
    processStartTokenReader?: (pid: number, platform: NodeJS.Platform) => string | null;
    terminateProcess?: HostBrokerProcessTerminator;
    enabled?: boolean;
}

export type HostDeviceBrokerOwnerRpcResult = {
    ok: boolean;
    status: number | null;
    ownerId: string;
    host: string;
    port: number;
    body: Record<string, unknown> | null;
    error?: string;
    detail?: string;
};

function brokerRoot(): string {
    return join(homedir(), ".ccc/devices");
}

function brokerPrivateRoot(): string {
    return join(homedir(), ".ccc/device-broker-private");
}

function brokerRuntimeFile(env: NodeJS.ProcessEnv): string {
    return join(brokerRoot(), "broker", deviceBrokerRuntimeFilename(env));
}

function writeHostBrokerRuntime(file: string, runtime: Record<string, unknown>): void {
    writeJsonFileAtomically(file, runtime);
}

function readHostBrokerRuntime(file: string): Record<string, unknown> | null {
    try {
        return readDeviceLabStateFile(file, (parsed) => {
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-broker-runtime");
            return parsed as Record<string, unknown>;
        }, "broker-runtime", DEVICE_BROKER_RUNTIME_FILE_LIMIT_BYTES);
    } catch {
        return null;
    }
}

function removeHostBrokerRuntime(file: string): void {
    try {
        unlinkSync(file);
    } catch {
        // Stale metadata cleanup is best-effort.
    }
}

function hostBrokerRuntimeMatchesRequiredBindHost(runtime: Record<string, unknown> | null, port: number, bindHost: string): boolean {
    if (bindHost === DEVICE_BROKER_DEFAULT_HOST) return true;
    return runtime?.managedBy === "ccc-host"
        && runtime.port === port
        && runtime.host === bindHost;
}

function hostBrokerStatusMatchesRequiredBindHost(compatibility: unknown, port: number, bindHost: string): boolean {
    const broker = compatibilityBrokerRecord(compatibility);
    return broker?.port === port && broker?.host === bindHost;
}

function hostBrokerProbeCandidates(bindHost: string, probeHost: string): string[] {
    const candidates = [
        probeHost,
        "127.0.0.1",
        "host.docker.internal",
        "host.containers.internal",
        "gateway.docker.internal",
        "172.17.0.1",
        "10.0.2.2",
        bindHost,
    ];
    return [...new Set(candidates.filter((host) => host && host !== "0.0.0.0" && host !== "::"))];
}

function brokerWindowsSandboxLockPath(): string {
    return join(brokerRoot(), "host-locks", "windows-sandbox.json");
}

function brokerWindowsSandboxMutationLockPath(): string {
    return join(brokerRoot(), "host-locks", "windows-sandbox.mutation.lock");
}

function brokerHyperVMutationLockPath(): string {
    return join(brokerRoot(), "host-locks", "hyper-v.mutation.lock");
}

function currentBootId(): string {
    try {
        return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    } catch {
        return `${hostname()}:${Math.floor((Date.now() - uptime() * 1000) / 1000)}`;
    }
}

function sameBootIdentity(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    const leftMatch = typeof left === "string" ? left.match(/^(.*):(\d+)$/) : null;
    const rightMatch = typeof right === "string" ? right.match(/^(.*):(\d+)$/) : null;
    return Boolean(leftMatch && rightMatch
        && leftMatch[1] === rightMatch[1]
        && Math.abs(Number(leftMatch[2]) - Number(rightMatch[2])) <= 5);
}

function readBrokerWindowsSandboxLock(): Record<string, unknown> | null {
    return readWindowsSandboxLockStateFile(brokerWindowsSandboxLockPath());
}

function staleBrokerWindowsSandboxLock(lock: Record<string, unknown> | null): boolean {
    return Boolean(lock?.bootId && !sameBootIdentity(lock.bootId, currentBootId()));
}

function sameBrokerWindowsSandboxLockOwner(lock: Record<string, unknown> | null, ownerId: string, device: unknown, sandboxId?: string): boolean {
    const deviceId = field(device, "id");
    return lock?.ownerId === ownerId
        && lock?.deviceId === deviceId
        && (!lock?.sandboxId || !sandboxId || lock.sandboxId === sandboxId);
}

function brokerWindowsSandboxIdForStop(ownerId: string, device: unknown): string | null {
    const recorded = field(device, "sandboxId");
    if (isGuid(recorded)) return recorded;
    if (field(device, "status") !== "stopped") return null;
    const lock = readBrokerWindowsSandboxLock();
    const sandboxId = field(lock, "sandboxId");
    const claimId = field(lock, "claimId");
    return lock?.provider === "windows-sandbox"
        && lock?.host === hostname()
        && sameBootIdentity(lock?.bootId, currentBootId())
        && Boolean(claimId && /^[a-f0-9]{16,128}$/i.test(claimId))
        && isGuid(sandboxId)
        && sameBrokerWindowsSandboxLockOwner(lock, ownerId, device, sandboxId)
        ? sandboxId
        : null;
}

function claimBrokerWindowsSandboxLock(ownerId: string, device: unknown, sandboxId?: string): { ok: true } | { ok: false; error: string; lock: Record<string, unknown> | null } {
    return withSharedMutationLock(brokerWindowsSandboxMutationLockPath(), () => {
        const lockPath = brokerWindowsSandboxLockPath();
        const existing = readBrokerWindowsSandboxLock();
        if (staleBrokerWindowsSandboxLock(existing)) {
            try { unlinkSync(lockPath); } catch { /* retry handles persistent failure */ }
        }
        const current = staleBrokerWindowsSandboxLock(existing) ? null : existing;
        const sameOwner = sameBrokerWindowsSandboxLockOwner(current, ownerId, device, sandboxId);
        const lock = {
            provider: "windows-sandbox",
            host: hostname(),
            bootId: currentBootId(),
            ownerId,
            deviceId: field(device, "id") || "unknown",
            sandboxId: sandboxId || null,
            claimId: sameOwner && typeof current?.claimId === "string" ? current.claimId : randomBytes(16).toString("hex"),
            pid: process.pid,
            acquiredAt: sameOwner && typeof current?.acquiredAt === "string" ? current.acquiredAt : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        if (!current || sameOwner) {
            validateWindowsSandboxLock(lock);
            writeJsonFileAtomically(lockPath, lock);
            return { ok: true };
        }
        return {
            ok: false,
            error: `Windows Sandbox is already claimed on this host by owner ${String(current?.ownerId || "unknown")} device ${String(current?.deviceId || "unknown")}. Windows Sandbox supports one running instance per host.`,
            lock: current,
        };
    });
}

function releaseBrokerWindowsSandboxLock(ownerId: string, device: unknown, sandboxId?: string, beforeRelease?: () => void): void {
    withSharedMutationLock(brokerWindowsSandboxMutationLockPath(), () => {
        const existing = readBrokerWindowsSandboxLock();
        if (!sameBrokerWindowsSandboxLockOwner(existing, ownerId, device, sandboxId)) return;
        beforeRelease?.();
        try { unlinkSync(brokerWindowsSandboxLockPath()); } catch { /* ignore missing lock */ }
    });
}

function updateBrokerWindowsSandboxLockRuntimeId(ownerId: string, device: unknown, claimedSandboxId: string | undefined, runtimeSandboxId: string): void {
    withSharedMutationLock(brokerWindowsSandboxMutationLockPath(), () => {
        const existing = readBrokerWindowsSandboxLock();
        if (!sameBrokerWindowsSandboxLockOwner(existing, ownerId, device, claimedSandboxId)) return;
        const updated = {
            ...existing,
            sandboxId: runtimeSandboxId,
            requestedSandboxId: claimedSandboxId || null,
            updatedAt: new Date().toISOString(),
        };
        validateWindowsSandboxLock(updated);
        writeJsonFileAtomically(brokerWindowsSandboxLockPath(), updated);
    });
}

function deviceBrokerPersistence(ownerId: string, runtimeFile: string) {
    const root = brokerRoot();
    const ownerRoot = join(root, "owners", ownerId);
    const backendRoots = Object.fromEntries(DEVICE_BROKER_BACKEND_STATE_KEYS.map((stateKey) => [stateKey, join(ownerRoot, stateKey)]));
    return {
        root,
        durableAcrossContainerRecreation: true,
        environmentVariablesRequired: false,
        ownerScoped: {
            ownerRoot,
            backendRoots,
            deviceDefinitions: Object.fromEntries(DEVICE_BROKER_BACKEND_STATE_KEYS.map((stateKey) => [stateKey, join(ownerRoot, stateKey, "devices.json")])),
            appiumMetadata: "stored on owner device records as appium; host-broker-owned server processes include processOwner=host-broker and startedBy=broker.appium.start",
            recordings: {
                android: join(ownerRoot, "android", "<device-id>", "recordings"),
                ios: join(ownerRoot, "ios", "<device-id>", "recordings"),
                windows: join(ownerRoot, "windows", "<device-id>", "recordings"),
                macos: join(ownerRoot, "macos", "<device-id>", "recordings"),
                metadata: "stored on owner device records as recording",
            },
            helpers: {
                windows: join(ownerRoot, "windows", "<device-id>", "tools"),
                macos: join(ownerRoot, "macos", "<device-id>", "tools"),
            },
            images: {
                androidAvd: "host Android SDK AVD storage; CCC stores only owner-prefixed avdName metadata in owner devices",
                iosSimulator: "host CoreSimulator storage; CCC stores only owner-prefixed simulatorName/UDID metadata in owner devices",
                macosVm: "provider-owned VM instances named from ccc-<owner-id>-<device-id>; metadata is stored under the macos owner root",
                windowsSandbox: "ephemeral Windows Sandbox instances; CCC stores owner-scoped .wsb/helper/scratch metadata under the windows owner root",
            },
            snapshots: {
                macosVm: "Tart snapshots are represented by owner-scoped provider clones recorded on the macos device definition",
            },
        },
        brokerScoped: {
            brokerRoot: join(root, "broker"),
            authRoot: join(root, "broker", "auth"),
            locksRoot: join(root, "broker", "locks"),
            logsRoot: join(root, "broker", "logs"),
            serviceRoot: join(root, "broker", "service"),
            runtimeFile,
        },
        hostToolchains: {
            ownership: "host-owned",
            discovery: "PATH plus explicit providerPaths supplied by CCC tests or host integrations",
            appium: "host Appium executable is discovered through PATH/providerPaths; broker stores only owner-scoped process/session metadata",
            androidSdk: "host Android SDK/emulator/adb/avdmanager state is not deleted by owner cleanup",
            xcode: "host Xcode/xcrun/simctl/xctrace/devicectl state is not deleted by owner cleanup",
            windowsSandbox: "host Windows Sandbox feature and wsb command are not deleted by owner cleanup",
            macosVmProviders: "host tart/vz/utmctl installations and provider image catalogs are not deleted by owner cleanup",
        },
        cleanupBoundary: {
            ownerCleanupMayMutate: [ownerRoot, join(root, "physical-leases", "<backend>", "locks", "<hardware-id>.json")],
            ownerCleanupPreserves: [
                join(root, "owners", "<foreign-owner-id>"),
                join(root, "broker", "auth"),
                join(root, "broker", "service"),
                join(root, "broker", "logs"),
                "host SDKs, Appium packages, Xcode, Windows Sandbox, and VM provider installations",
                "shared/base VM images and host provider catalogs",
            ],
            staleMetadataPolicy: "owner cleanup clears stale owner appium/recording metadata and retries provider stops without deleting shared toolchain caches or foreign owner state",
        },
        diagnostics: [
            "If a CCC container is recreated, broker state remains under the host user home at ~/.ccc/devices.",
            "If host toolchains are missing after recreation, status/smoke commands report missing prerequisites instead of silently recreating devices.",
            "Owner cleanup is scoped to the current owner namespace and physical leases for that owner.",
        ],
    };
}

function deviceBrokerOwnerId(cwd: string, profile?: string): string {
    return canonicalDeviceLabOwnerId(cwd || "/project", profile);
}

function deviceBrokerOwnerRegistrationDirectoryChain(): string[] {
    const root = brokerRoot();
    return [root, join(root, "broker"), join(root, "broker", "owners")];
}

function inspectDeviceBrokerOwnerRegistrationDirectory(): boolean {
    for (const directory of deviceBrokerOwnerRegistrationDirectoryChain()) {
        let stat;
        try {
            stat = lstatSync(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw new Error("device-broker-owner-registration-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("device-broker-owner-registration-directory-invalid");
        }
    }
    return true;
}

function ensureDeviceBrokerOwnerRegistrationDirectory(): void {
    const [root, ...children] = deviceBrokerOwnerRegistrationDirectoryChain();
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("device-broker-owner-registration-directory-create-failed");
    }
    for (const directory of [root, ...children]) {
        if (directory !== root) {
            try {
                mkdirSync(directory, { mode: 0o700 });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("device-broker-owner-registration-directory-create-failed");
            }
        }
        try {
            const stat = lstatSync(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("device-broker-owner-registration-directory-invalid");
        } catch (error) {
            if (error instanceof Error && error.message === "device-broker-owner-registration-directory-invalid") throw error;
            throw new Error("device-broker-owner-registration-directory-read-failed");
        }
    }
}

export function deviceBrokerOwnerRegistrationFile(ownerId: string): string {
    if (!/^[a-f0-9]{16}$/.test(ownerId)) throw new Error("invalid-owner-id");
    return join(brokerRoot(), "broker", "owners", `${ownerId}.json`);
}

export function deviceBrokerHostProjectMountPath(hostProjectPath: string): string | null {
    if (deviceLabOwnerFromProjectMountPath(hostProjectPath)) return hostProjectPath;
    const windowsStyle = /^[a-zA-Z]:[\\/]/.test(hostProjectPath) || /^\\\\/.test(hostProjectPath);
    const pathApi = windowsStyle && win32.isAbsolute(hostProjectPath)
        ? win32
        : posix.isAbsolute(hostProjectPath) ? posix : null;
    if (!pathApi) return null;
    const normalized = pathApi.resolve(hostProjectPath);
    if (normalized !== hostProjectPath) return null;
    const name = pathApi.basename(normalized).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
    return `/project/${name}-${hash}`;
}

function validateDeviceBrokerOwnerRegistration(value: unknown, expectedOwnerId: string): DeviceBrokerOwnerRegistration {
    return brokerOwners.validateRegistration(value, expectedOwnerId);
}

function readDeviceBrokerOwnerRegistration(ownerId: string): DeviceBrokerOwnerRegistration | null {
    if (!inspectDeviceBrokerOwnerRegistrationDirectory()) return null;
    return readDeviceLabStateFile(
        deviceBrokerOwnerRegistrationFile(ownerId),
        (value) => validateDeviceBrokerOwnerRegistration(value, ownerId),
        "device-broker-owner-registration",
        DEVICE_BROKER_OWNER_REGISTRATION_FILE_LIMIT_BYTES,
    );
}

export function registerDeviceBrokerOwner(cwd: string, profile?: string, expectedOwnerId?: string): DeviceBrokerOwnerRegistration {
    return brokerOwners.register(cwd, profile, expectedOwnerId);
}

export function deviceBrokerOwnerToken(ownerId: string): string {
    const secret = deviceBrokerOwnerSecret(ownerId);
    return createHash("sha256").update(`${DEVICE_BROKER_NAME}:owner:${ownerId}:secret:${secret}`).digest("hex");
}

function readDeviceBrokerOwnerSecret(ownerId: string): string | null {
    const file = deviceBrokerAuthSecretFile(ownerId);
    try {
        if (!inspectDeviceBrokerAuthDirectory()) return null;
    } catch {
        return null;
    }
    return readBrokerOwnerSecret(file, ownerId, descriptor => {
        try { fchmodSync(descriptor, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    });
}

function existingDeviceBrokerOwnerToken(ownerId: string): string | null {
    const secret = readDeviceBrokerOwnerSecret(ownerId);
    return secret
        ? createHash("sha256").update(`${DEVICE_BROKER_NAME}:owner:${ownerId}:secret:${secret}`).digest("hex")
        : null;
}

function deviceBrokerAuthDirectoryChain(): string[] {
    const root = brokerRoot();
    return [root, join(root, "broker"), join(root, "broker", "auth")];
}

function inspectDeviceBrokerAuthDirectory(): boolean {
    for (const directory of deviceBrokerAuthDirectoryChain()) {
        let stat;
        try {
            stat = lstatSync(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw new Error("device-broker-auth-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("device-broker-auth-directory-invalid");
        }
    }
    return true;
}

function ensureDeviceBrokerAuthDirectory(): void {
    const [root, ...children] = deviceBrokerAuthDirectoryChain();
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("device-broker-auth-directory-create-failed");
    }
    for (const directory of [root, ...children]) {
        if (directory !== root) {
            try {
                mkdirSync(directory, { mode: 0o700 });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("device-broker-auth-directory-create-failed");
            }
        }
        let stat;
        try {
            stat = lstatSync(directory);
        } catch {
            throw new Error("device-broker-auth-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("device-broker-auth-directory-invalid");
        }
    }
}

function deviceBrokerLogDirectoryChain(): string[] {
    const root = brokerRoot();
    return [root, join(root, "broker"), join(root, "broker", "logs")];
}

function ensureDeviceBrokerLogDirectory(): void {
    const [root, ...children] = deviceBrokerLogDirectoryChain();
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("host-broker-log-directory-create-failed");
    }
    for (const directory of [root, ...children]) {
        if (directory !== root) {
            try {
                mkdirSync(directory, { mode: 0o700 });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("host-broker-log-directory-create-failed");
            }
        }
        try {
            const stat = lstatSync(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("host-broker-log-directory-invalid");
        } catch (error) {
            if (error instanceof Error && error.message === "host-broker-log-directory-invalid") throw error;
            throw new Error("host-broker-log-directory-read-failed");
        }
    }
}

function createHostBrokerLogFile(): { path: string; descriptor: number } {
    ensureDeviceBrokerLogDirectory();
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const path = join(brokerRoot(), "broker", "logs", `host-broker-${Date.now()}-${randomBytes(8).toString("hex")}.log`);
        let descriptor: number | null = null;
        try {
            descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
            const opened = fstatSync(descriptor);
            const current = lstatSync(path);
            if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.nlink !== 1 || current.nlink !== 1
                || (opened.dev !== 0 && current.dev !== 0 && opened.dev !== current.dev)
                || (opened.ino !== 0 && current.ino !== 0 && opened.ino !== current.ino)) {
                throw new Error("host-broker-log-file-invalid");
            }
            try { fchmodSync(descriptor, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
            return { path, descriptor };
        } catch (error) {
            if (descriptor !== null) closeSync(descriptor);
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            if (error instanceof Error && error.message === "host-broker-log-file-invalid") throw error;
            throw new Error("host-broker-log-file-create-failed");
        }
    }
    throw new Error("host-broker-log-file-create-failed");
}

function removeAbandonedDeviceBrokerAuthArtifacts(file: string): void {
    if (!inspectDeviceBrokerAuthDirectory()) return;
    const prefix = `${basename(file)}.`;
    let directory: ReturnType<typeof opendirSync> | null = null;
    try {
        directory = opendirSync(dirname(file));
        let entryCount = 0;
        while (entryCount < DEVICE_BROKER_AUTH_DIRECTORY_ENTRY_LIMIT) {
            const entry = directory.readSync();
            if (!entry) break;
            entryCount += 1;
            if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.startsWith(prefix) || !/\.(?:tmp|invalid)$/.test(entry.name)) continue;
            const artifact = join(dirname(file), entry.name);
            const current = lstatSync(artifact);
            if ((!current.isFile() && !current.isSymbolicLink())
                || (typeof process.getuid === "function" && current.uid !== process.getuid())) continue;
            // unlink removes this bounded non-directory entry without following it.
            unlinkSync(artifact);
        }
    } catch {
        // Auth provisioning can continue when stale-artifact cleanup is unavailable.
    } finally {
        if (directory) {
            try { directory.closeSync(); } catch { /* best effort after cleanup */ }
        }
    }
}

function quarantineInvalidDeviceBrokerAuthFile(file: string): BrokerAuthQuarantine | null {
    const quarantined = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.invalid`;
    if (!inspectDeviceBrokerAuthDirectory()) throw new Error("device-broker-auth-quarantine-invalid");
    let before: {dev: number; ino: number; uid: number};
    try { before = lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) throw new Error("device-broker-auth-quarantine-invalid");
    try { renameSync(file, quarantined); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const moved = lstatSync(quarantined);
    if (before.dev !== moved.dev || before.ino !== moved.ino || before.uid !== moved.uid) throw new Error("device-broker-auth-quarantine-changed");
    return {path: quarantined, dev: moved.dev, ino: moved.ino, uid: moved.uid, nlink: moved.nlink,
        kind: moved.isFile() ? "file" : moved.isSymbolicLink() ? "symlink" : "other"};
}

function removeDeviceBrokerAuthQuarantine(quarantine: BrokerAuthQuarantine): undefined {
    const directory = join(brokerRoot(), "broker", "auth");
    if (!inspectDeviceBrokerAuthDirectory() || dirname(quarantine.path) !== directory
        || !/^[a-f0-9]{16}\.json\.[0-9]+\.[a-f0-9]{16}\.invalid$/.test(basename(quarantine.path))) throw new Error("device-broker-auth-quarantine-invalid");
    const current = lstatSync(quarantine.path);
    const kind = current.isFile() ? "file" : current.isSymbolicLink() ? "symlink" : "other";
    if (quarantine.kind === "other" || current.dev !== quarantine.dev || current.ino !== quarantine.ino
        || current.uid !== quarantine.uid || current.nlink !== quarantine.nlink || kind !== quarantine.kind
        || (typeof process.getuid === "function" && current.uid !== process.getuid())) throw new Error("device-broker-auth-quarantine-changed");
    unlinkSync(quarantine.path);
    return undefined;
}

export function deviceBrokerAuthSecretFile(ownerId: string): string {
    if (!/^[a-f0-9]{16}$/.test(ownerId)) throw new Error("invalid-owner-id");
    return join(brokerRoot(), "broker", "auth", `${ownerId}.json`);
}

export function deviceBrokerOwnerSecret(ownerId: string): string { return brokerOwners.secret(ownerId); }

const brokerOwners = createBrokerOwnerApplication({
    resolveHostPath: cwd => resolve(cwd), projectMountPath: host => deviceLabProjectMountPath(host),
    identity: (mount, profile) => deviceLabOwnerFromProjectMountPath(mount, profile),
    hostProjectMountPath: host => deviceBrokerHostProjectMountPath(host),
    prepareRegistrations: () => { ensureDeviceBrokerOwnerRegistrationDirectory(); return undefined; },
    registrationFile: owner => deviceBrokerOwnerRegistrationFile(owner), readRegistration: owner => readDeviceBrokerOwnerRegistration(owner),
    writeRegistration: (file, registration) => { writeJsonFileAtomically(file, registration); return undefined; },
    withRegistrationLock: (file, operation) => withSharedMutationLock(`${file}.lock`, operation, {waitMs: DEVICE_BROKER_AUTH_LOCK_WAIT_MS, staleMs: DEVICE_BROKER_AUTH_LOCK_STALE_MS}),
    timestamp: () => new Date().toISOString(), authFile: owner => deviceBrokerAuthSecretFile(owner),
    inspectAuthDirectory: () => inspectDeviceBrokerAuthDirectory(),
    prepareAuthDirectory: () => { ensureDeviceBrokerAuthDirectory(); return undefined; },
    readSecret: owner => readDeviceBrokerOwnerSecret(owner),
    withAuthLock: (file, operation) => withSharedMutationLock(`${file}.lock`, operation, {waitMs: DEVICE_BROKER_AUTH_LOCK_WAIT_MS, staleMs: DEVICE_BROKER_AUTH_LOCK_STALE_MS}),
    removeAbandonedAuthArtifacts: file => { removeAbandonedDeviceBrokerAuthArtifacts(file); return undefined; },
    quarantineAuth: file => quarantineInvalidDeviceBrokerAuthFile(file), newSecret: () => randomBytes(32).toString("hex"),
    publishSecret: (file, record) => { writeJsonFileAtomically(file, record); return undefined; },
    removeQuarantine: quarantine => removeDeviceBrokerAuthQuarantine(quarantine),
});

function normalizeBrokerOptions(options: DeviceBrokerOptions = {}): NormalizedBrokerOptions {
    const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env || {}) };
    const configuredPort = configuredDeviceBrokerPort(env);
    const cwd = options.cwd || process.cwd();
    const host = options.host || DEVICE_BROKER_DEFAULT_HOST;
    const port = Number.isInteger(options.port) ? Number(options.port) : configuredPort ?? DEVICE_BROKER_DEFAULT_PORT;
    // An explicit API port selects its own namespace only in configured mode.
    // Keep absence explicit so a later status projection cannot inherit a new override.
    env.CCC_DEVICE_BROKER_PORT = configuredPort === undefined ? undefined : String(port);
    const runtimeFile = brokerRuntimeFile(env);
    const startedAt = options.startedAt || new Date().toISOString();
    const commandTimeoutMs = Number.isFinite(options.commandTimeoutMs)
        ? Math.min(30000, Math.max(1, Number(options.commandTimeoutMs)))
        : DEVICE_BROKER_COMMAND_TIMEOUT_MS;
    const requestBodyTimeoutMs = Number.isFinite(options.requestBodyTimeoutMs)
        ? Math.min(30000, Math.max(1, Number(options.requestBodyTimeoutMs)))
        : DEVICE_BROKER_REQUEST_BODY_TIMEOUT_MS;
    const cliPath = options.cliPath || fileURLToPath(new URL("./broker-entry.js", import.meta.url));
    return {
        cwd,
        profile: options.profile,
        host,
        port,
        env,
        runtimeFile,
        startedAt,
        providerPaths: options.providerPaths || {},
        commandTimeoutMs,
        ...(Number.isFinite(options.commandTimeoutMs) ? {explicitCommandTimeoutMs: commandTimeoutMs} : {}),
        requestBodyTimeoutMs,
        hyperVMonotonicNow: options.hyperVMonotonicNow || (() => performance.now()),
        commandRunner: options.commandRunner || defaultProviderCommandRunner,
        deviceToolRunner: options.deviceToolRunner || defaultBrokerDeviceToolRunner,
        windowsDeviceArtifactCleaner: options.windowsDeviceArtifactCleaner || cleanupBrokerWindowsDeviceArtifacts,
        usesDefaultCommandRunner: !options.commandRunner,
        platform: options.platform || process.platform,
        cliPath,
        trustedCliPaths: [cliPath, ...(options.trustedCliPaths || [])],
        portProcessResolver: options.portProcessResolver || discoverBrokerPortProcess,
        strictAppiumPortOwnership: !options.commandRunner || options.portProcessResolver !== undefined,
    };
}

function boundedHostBrokerRawText(text: string): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= DEVICE_BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES) return text;
    const suffix = "...[truncated]";
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    let prefix = bytes.subarray(0, DEVICE_BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES - suffixBytes).toString("utf8");
    while (Buffer.byteLength(prefix, "utf8") + suffixBytes > DEVICE_BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES) {
        prefix = prefix.slice(0, -1);
    }
    return `${prefix}${suffix}`;
}

export type HostBrokerHttpResponse = Pick<Response, "status" | "headers" | "body">;

export async function readHostBrokerHttpJson(response: HostBrokerHttpResponse, maxBytes: number) {
    if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false as const, error: "broker-redirect-disallowed", body: null, maxBytes };
    }
    // For the RPC lane this precheck and the streaming counter below measure the same bytes; for
    // the three probe callers still on `fetch` they do not. undici sends its own accept-encoding
    // and decompresses, so there a declared length is compressed bytes while `total` counts
    // decompressed ones — measured at 115 against 50,032 for one reply. Never a hole, since the
    // streaming counter is the real bound and catches what the precheck lets through, but on those
    // callers the cheap early rejection cannot fire on a response that would expand past the cap.
    // Nothing diverges today either way: the broker sets no content-encoding anywhere, and
    // compression additionally needs the server to opt in, which it never does.
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
        if (BigInt(declaredLength) > BigInt(maxBytes)) {
            await response.body?.cancel().catch(() => undefined);
            return { ok: false as const, error: "broker-response-too-large", body: null, declaredBytes: declaredLength, maxBytes };
        }
    }
    if (!response.body) {
        return { ok: false as const, error: "invalid-broker-json", body: null, receivedBytes: 0, maxBytes };
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return { ok: false as const, error: "broker-response-too-large", body: null, receivedBytes: total, maxBytes };
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }

    const text = Buffer.concat(chunks, total).toString("utf8");
    try {
        const body: unknown = text ? JSON.parse(text) : null;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("broker response is not an object");
        return { ok: true as const, body: body as Record<string, unknown>, receivedBytes: total, maxBytes };
    } catch {
        return {
            ok: false as const,
            error: "invalid-broker-json",
            body: { raw: boundedHostBrokerRawText(text) },
            receivedBytes: total,
            maxBytes,
        };
    }
}

// The runtime `fetch` enforces a header deadline of its own — undici aborts with
// UND_ERR_HEADERS_TIMEOUT after 300s and no request option raises it. Every RPC
// budget above five minutes (a Hyper-V create is measured in hours) would be cut
// there and surface as `broker-rpc-unavailable`: the caller's own clock never
// gets to speak. This transport carries no deadline, so the caller's abort
// signal is the only one.
//
// The trade, stated because it is easy to miss: undici enforced a body-inactivity
// timeout alongside the header one, and dropping the header deadline drops that
// too. A broker that sends headers and then dribbles now holds the socket for the
// caller's whole budget — up to hours on a Hyper-V create — where it used to be
// cut at five minutes. That is accepted rather than overlooked: the peer has
// already been fenced by pid and process start token above, so it is the broker
// this caller launched or nothing, and a long create legitimately looks like a
// long silence. It is the same reason the header deadline had to go.
// `Readable.toWeb` would be the one-liner here, but it is experimental below Node 22.17.0 and this
// package declares `engines.node: ">=20.19.0"`, so the repo's own lint gate rejects it.
//
// Driven from the async iterator inside pull(), NOT from 'data' events, and the difference is a
// crash. An event-driven version enqueues from a listener, and `cancel()` -> `response.destroy()`
// does not suppress 'data': chunks already buffered in the IncomingMessage still arrive after the
// destroy. Measured — 130,929 bytes buffered, two 'data' events after destroy() — and each one
// reaches enqueue on a stream the cancel already closed, which throws a TypeError inside an
// EventEmitter handler where nothing catches it. Nothing on this path installs an
// uncaughtException handler, so the CLI dies.
//
// The cap path is exactly where that lands: the byte counter cancels one read after it crosses the
// limit, while the socket is still a read ahead. A tight consumer keeps the buffer empty and never
// sees it, which is why a green cap test proves nothing here — it only appears when the consumer
// lags. Pulling from the iterator removes the listeners entirely, so there is no uncatchable throw
// to have, and backpressure is inherent: pull() is called only when the queue wants a chunk.
//
// THE try/catch BELOW IS THE SAFETY MECHANISM, not defensive decoration. The stream never CALLS
// pull() again after cancel, but a pull already in flight still resolves afterwards, and its
// enqueue lands on a closed controller and throws the same TypeError the listener version died
// on. It survives only because the throw is inside our own try and the catch routes it to
// controller.error(), a no-op on an already-closed stream. Measured on the cap path: at lag 0 it
// never fires, at lag >= 50ms it fires every run — one enqueue-after-cancel, one caught
// TypeError, zero uncaught. Removing the catch on the reasoning that pull is not re-entered after
// cancel restores the process kill; that reasoning is true and is not the hazard.
// Exported as a test seam. The invariant worth pinning is structural — that this registers no
// listeners — and that cannot be observed through invokeHostDeviceBrokerOwnerRpc.
export function incomingMessageBody(response: IncomingMessage): ReadableStream<Uint8Array> {
    const iterator = response[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const next = await iterator.next();
                if (next.done === true) {
                    controller.close();
                    return;
                }
                controller.enqueue(new Uint8Array(next.value as Buffer));
            } catch (error) {
                controller.error(error);
            }
        },
        async cancel() {
            // destroy() FIRST, and the order is the whole point. Node's Readable async iterator is
            // an async generator: when a pull is parked in `await iterator.next()` the generator is
            // mid-execution, so `return()` queues behind that pending next() and its teardown never
            // runs. Awaiting return() before destroy() therefore deadlocks whenever the peer goes
            // silent after the byte counter crossed the cap — measured HUNG past 12s, where
            // destroying first returns in 59ms. destroy() fires 'close', the iterator's own
            // end-of-stream watcher rejects the parked next(), and the queued return() then runs.
            // The event-driven adapter this replaced cancelled synchronously and always freed the
            // socket at once; this restores that property.
            response.destroy();
            await iterator.return?.(undefined).catch(() => undefined);
        },
    });
}

async function hostBrokerHttpRequest(url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
}): Promise<HostBrokerHttpResponse> {
    const payload = Buffer.from(init.body, "utf8");
    return await new Promise<HostBrokerHttpResponse>((resolveResponse, rejectResponse) => {
        const request = httpRequest(url, {
            method: init.method,
            headers: { ...init.headers, "content-length": String(payload.byteLength) },
            // A one-off agent: nothing is pooled, so a finished CLI process is not
            // held open by a keep-alive socket waiting on the next request.
            agent: false,
            signal: init.signal,
        }, (response) => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
                if (Array.isArray(value)) {
                    for (const entry of value) headers.append(name, entry);
                } else if (typeof value === "string") {
                    headers.append(name, value);
                }
            }
            resolveResponse({
                status: response.statusCode || 0,
                headers,
                body: incomingMessageBody(response) as HostBrokerHttpResponse["body"],
            });
        });
        request.on("error", rejectResponse);
        request.end(payload);
    });
}

async function probeHostBrokerHealth(host: string, port: number, timeoutMs: number) {
    const endpoint = `http://${host}:${port}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const startedAt = Date.now();
    try {
        const response = await fetch(endpoint, { signal: controller.signal, redirect: "manual" });
        const parsed = await readHostBrokerHttpJson(response, DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES);
        const body = parsed.body as Record<string, unknown> | null;
        return {
            endpoint,
            available: parsed.ok && response.ok && body?.ok === true && body?.name === DEVICE_BROKER_NAME,
            status: response.status,
            body,
            ...(!parsed.ok ? { error: parsed.error, maxBytes: parsed.maxBytes } : {}),
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            endpoint,
            available: false,
            status: null,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function probeHostBrokerOwnerResolve(host: string, port: number, timeoutMs: number, cwd: string, expectedOwnerId: string, profile?: string) {
    const endpoint = `http://${host}:${port}/v1/owner/resolve`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const startedAt = Date.now();
    try {
        const response = await fetch(endpoint, {
            method: "POST",
            signal: controller.signal,
            redirect: "manual",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                projectMountPath: deviceLabProjectMountPath(cwd),
                profile: profile ?? null,
            }),
        });
        const parsed = await readHostBrokerHttpJson(response, DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES);
        const body = parsed.body as Record<string, unknown> | null;
        const resolvedOwnerId = parsed.ok && body?.result && typeof body.result === "object"
            ? (body.result as { ownerId?: unknown }).ownerId
            : null;
        const ownerCompatible = resolvedOwnerId === expectedOwnerId;
        return {
            endpoint,
            available: parsed.ok && response.ok && body?.ok === true,
            compatible: parsed.ok && response.ok && typeof resolvedOwnerId === "string" && /^[a-f0-9]{16}$/.test(resolvedOwnerId) && ownerCompatible,
            status: response.status,
            body,
            ownerId: typeof resolvedOwnerId === "string" ? resolvedOwnerId : null,
            expectedOwnerId,
            ownerCompatible,
            ...(!parsed.ok ? { error: parsed.error, maxBytes: parsed.maxBytes } : {}),
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            endpoint,
            available: false,
            compatible: false,
            status: null,
            body: null,
            ownerId: null,
            expectedOwnerId,
            ownerCompatible: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function probeHostBrokerStatus(host: string, port: number, timeoutMs: number, cwd: string, expectedOwnerId: string, profile?: string) {
    const endpoint = `http://${host}:${port}/status`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const startedAt = Date.now();
    let ownerResolve: Awaited<ReturnType<typeof probeHostBrokerOwnerResolve>> | null = null;
    try {
        const response = await fetch(endpoint, { signal: controller.signal, redirect: "manual" });
        const parsed = await readHostBrokerHttpJson(response, DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES);
        const body = parsed.body as Record<string, unknown> | null;
        const protocolVersion = parsed.ok && body?.broker && typeof body.broker === "object"
            ? (body.broker as { protocolVersion?: unknown }).protocolVersion ?? null : null;
        const versionCompatible = isCompatibleBrokerProtocol(protocolVersion);
        ownerResolve = await probeHostBrokerOwnerResolve(host, port, timeoutMs, cwd, expectedOwnerId, profile);
        return {
            endpoint,
            available: parsed.ok && response.ok && body?.ok === true,
            compatible: parsed.ok && response.ok && body?.ok === true && versionCompatible && ownerResolve.compatible,
            status: response.status,
            body,
            protocolVersion,
            expectedProtocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
            versionCompatible,
            brokerNewerThanCli: Number.isSafeInteger(protocolVersion) && Number(protocolVersion) > DEVICE_BROKER_PROTOCOL_VERSION,
            ownerResolve,
            ...(!parsed.ok ? { error: parsed.error, maxBytes: parsed.maxBytes } : {}),
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            endpoint,
            available: false,
            compatible: false,
            status: null,
            body: null,
            protocolVersion: null,
            expectedProtocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
            versionCompatible: false,
            ownerResolve,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function stopIncompatibleHostBroker(
    ownerId: string,
    port: number,
    compatibility: unknown,
    runtimeFile: string,
    platform: NodeJS.Platform = process.platform,
    portProcessResolver: BrokerPortProcessResolver = discoverBrokerPortProcess,
    expectedCliPath?: string | readonly string[],
    terminateProcess?: HostBrokerProcessTerminator,
) {
    if (compatibility && typeof compatibility === "object"
        && (compatibility as { brokerNewerThanCli?: unknown }).brokerNewerThanCli === true) {
        return {
            stopped: false,
            restartable: false,
            reason: "broker-newer-than-cli",
            compatibility,
        };
    }
    const persistedRuntime = readHostBrokerRuntime(runtimeFile);
    const statusRuntime = hostBrokerRuntimeFromStatus(ownerId, port, compatibility);
    if (typeof statusRuntime?.platform === "string" && statusRuntime.platform !== platform) {
        return {
            stopped: false,
            restartable: false,
            reason: "runtime-host-platform-mismatch",
            runtime: statusRuntime,
            compatibility,
            currentPlatform: platform,
            hostPlatform: statusRuntime.platform,
        };
    }
    const verification: { failure?: HostBrokerProcessVerificationFailure } = {};
    const portRuntime = hostBrokerRuntimeFromPortProcess(
        ownerId,
        port,
        compatibility,
        platform,
        portProcessResolver,
        persistedRuntime,
        statusRuntime,
        expectedCliPath,
        false,
        verification,
    );
    if (!portRuntime) {
        return {
            stopped: false,
            restartable: false,
            reason: "unverified-broker-port-process",
            verificationFailure: verification.failure,
            persistedRuntime,
            statusRuntime,
            compatibility,
        };
    }
    const pid = Number(portRuntime.pid);
    const persistedMatchesPort = Number(persistedRuntime?.pid) === pid && Number(persistedRuntime?.port) === port;
    const statusMatchesPort = Number(statusRuntime?.pid) === pid && Number(statusRuntime?.port) === port;
    const runtime = {
        ...(persistedMatchesPort ? persistedRuntime : {}),
        ...(statusMatchesPort ? statusRuntime : {}),
        ...portRuntime,
    };
    const usedStatusRuntime = statusMatchesPort && !persistedMatchesPort;
    if (typeof runtime.platform === "string" && runtime.platform !== platform) {
        return {
            stopped: false,
            restartable: false,
            reason: "runtime-host-platform-mismatch",
            runtime,
            compatibility,
            currentPlatform: platform,
            hostPlatform: runtime.platform,
        };
    }
    if (probeDeviceRuntimeProcessLiveness(pid) === "exited") {
        removeHostBrokerRuntime(runtimeFile);
        return { stopped: true, restartable: true, reason: "runtime-pid-not-alive", runtime, compatibility };
    }
    const expectedIdentity = runtime.processIdentity as DeviceRuntimeProcessIdentity | undefined;
    const expectedStartToken = typeof runtime.processStartToken === "string"
        ? runtime.processStartToken
        : null;
    const readCurrentIdentity = (value: number) => {
        const current = portProcessResolver(port, platform);
        if (!current || current.pid !== value) return null;
        return current.processIdentity || readDeviceRuntimeProcessIdentity(value, { platform });
    };
    const readCurrentStartToken = (value: number) => {
        const current = portProcessResolver(port, platform);
        if (!current || current.pid !== value) return null;
        return current.processStartToken
            || current.processIdentity?.startToken
            || readDeviceRuntimeProcessStartToken(value, { platform });
    };
    const identityOptions = { platform, readIdentity: readCurrentIdentity };
    const initialIdentity = expectedIdentity
        ? inspectDeviceRuntimeProcessIdentity(expectedIdentity, pid, identityOptions)
        : null;
    const initialStartToken = expectedStartToken ? readCurrentStartToken(pid) : null;
    if ((initialIdentity && initialIdentity.status !== "match")
        || (!initialIdentity && (!expectedStartToken || initialStartToken !== expectedStartToken))) {
        const status = initialIdentity?.status || (initialStartToken ? "mismatch" : "unavailable");
        return {
            stopped: false,
            restartable: false,
            reason: status === "exited"
                ? "runtime-pid-not-alive"
                : status === "mismatch"
                    ? "runtime-process-identity-mismatch"
                    : "runtime-process-identity-unavailable",
            runtime,
            compatibility,
            observation: initialIdentity || { status, currentStartToken: initialStartToken },
        };
    }
    if (terminateProcess || process.platform === "win32") {
        const windowsIdentity = expectedIdentity
            ? inspectDeviceRuntimeProcessIdentity(expectedIdentity, pid, identityOptions)
            : null;
        const windowsStartToken = expectedStartToken ? readCurrentStartToken(pid) : null;
        if ((windowsIdentity && windowsIdentity.status !== "match")
            || (!windowsIdentity && windowsStartToken !== expectedStartToken)) {
            const status = windowsIdentity?.status || (windowsStartToken ? "mismatch" : "unavailable");
            return {
                stopped: false,
                restartable: false,
                reason: `runtime-process-identity-${status}`,
                runtime,
                compatibility,
                observation: windowsIdentity || { status, currentStartToken: windowsStartToken },
            };
        }
        const stopped = terminateProcess
            ? terminateProcess(pid, expectedIdentity, expectedStartToken || undefined)
            : terminateWindowsProcessTree(pid, expectedIdentity, false, expectedStartToken || undefined);
        if (!stopped.ok) {
            return { stopped: false, restartable: false, reason: "runtime-stop-failed", runtime, compatibility, detail: stopped.error };
        }
        removeHostBrokerRuntime(runtimeFile);
        return {
            stopped: true,
            restartable: true,
            reason: usedStatusRuntime
                ? "status-runtime-incompatible-contract"
                : portRuntime
                    ? "port-runtime-incompatible-contract"
                    : "runtime-incompatible-contract",
            runtime,
            compatibility,
            detail: stopped,
        };
    }
    const revalidatePosixBrokerIdentity = () => {
        // A captured command identity must never downgrade to token-only proof.
        if (expectedIdentity) return inspectDeviceRuntimeProcessIdentity(expectedIdentity, pid, identityOptions);
        const currentStartToken = runtime.managedBy === "ccc-host-port-metadata" && expectedStartToken
            ? readCurrentStartToken(pid) : null;
        const status = currentStartToken
            ? currentStartToken === expectedStartToken ? "match" as const : "mismatch" as const
            : probeDeviceRuntimeProcessLiveness(pid) === "exited" ? "exited" as const : "unavailable" as const;
        return { status, current: null, currentStartToken };
    };
    const brokerExited = () => probeDeviceRuntimeProcessLiveness(pid) === "exited";
    try {
        const termIdentity = revalidatePosixBrokerIdentity();
        if (termIdentity.status !== "match") {
            return { stopped: false, restartable: false, reason: `runtime-process-identity-${termIdentity.status}`, runtime, compatibility, observation: termIdentity };
        }
        process.kill(pid, "SIGTERM");
        const exited = await waitForProcessExit(pid, 1500, brokerExited);
        if (!exited) {
            const killIdentity = revalidatePosixBrokerIdentity();
            if (killIdentity.status !== "match") {
                if (killIdentity.status === "exited") {
                    removeHostBrokerRuntime(runtimeFile);
                    return { stopped: true, restartable: true, reason: "runtime-pid-gone-after-signal", runtime, compatibility };
                }
                return { stopped: false, restartable: false, reason: `runtime-process-identity-${killIdentity.status}`, runtime, compatibility, observation: killIdentity };
            }
            process.kill(pid, "SIGKILL");
        }
        const killed = exited || await waitForProcessExit(pid, 500, brokerExited);
        if (!killed) {
            return { stopped: false, restartable: false, reason: "runtime-pid-still-alive", runtime, compatibility };
        }
        removeHostBrokerRuntime(runtimeFile);
        return {
            stopped: true,
            restartable: true,
            reason: usedStatusRuntime
                ? "status-runtime-incompatible-contract"
                : portRuntime
                    ? "port-runtime-incompatible-contract"
                    : "runtime-incompatible-contract",
            runtime,
            compatibility,
        };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { stopped: false, restartable: false, reason: "runtime-stop-failed", runtime, compatibility, detail };
    }
}

function compatibilityBrokerRecord(compatibility: unknown): Record<string, unknown> | null {
    if (!compatibility || typeof compatibility !== "object") return null;
    const body = (compatibility as { body?: unknown }).body;
    const broker = body && typeof body === "object" ? (body as { broker?: unknown }).broker : null;
    return broker && typeof broker === "object" ? broker as Record<string, unknown> : null;
}

function hostBrokerRuntimeFromStatus(ownerId: string, port: number, compatibility: unknown): Record<string, unknown> | null {
    const record = compatibilityBrokerRecord(compatibility);
    if (!record) return null;
    const processRecord = record.process && typeof record.process === "object"
        ? record.process as Record<string, unknown>
        : {};
    const serviceManager = record.serviceManager && typeof record.serviceManager === "object"
        ? record.serviceManager as Record<string, unknown>
        : {};
    const serviceCommand = Array.isArray(serviceManager.command) ? serviceManager.command.map(String) : [];
    const cliPath = serviceCommand[1] || null;
    const cwd = cliPath ? cliPath.replace(/[\\/]+dist[\\/]+index\.js$/i, "") : null;
    const pid = Number(processRecord.pid ?? record.pid);
    if (record.name !== DEVICE_BROKER_NAME) return null;
    if (record.mode !== "host-broker-daemon") return null;
    if (record.port !== port) return null;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
        name: DEVICE_BROKER_NAME,
        managedBy: "ccc-host-status",
        ownerId: typeof record.ownerId === "string" ? record.ownerId : ownerId,
        pid,
        host: typeof record.host === "string" ? record.host : null,
        probeHost: DEVICE_BROKER_DEFAULT_HOST,
        hostCandidates: hostBrokerProbeCandidates(
            typeof record.host === "string" ? record.host : DEVICE_BROKER_DEFAULT_HOST,
            DEVICE_BROKER_DEFAULT_HOST,
        ),
        port,
        version: typeof record.version === "string" ? record.version : null,
        platform: typeof serviceManager.platform === "string" ? serviceManager.platform : null,
        command: serviceCommand[0] || null,
        args: serviceCommand.slice(1),
        cwd,
        startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
        processStartToken: typeof processRecord.startToken === "string" ? processRecord.startToken : null,
        source: "broker-status",
    };
}

const HOST_BROKER_PROCESS_VERIFICATION_FAILURES = [
    "listener-unavailable", "status-pid-mismatch", "command-or-entry-unverified", "process-start-unavailable",
    "process-generation-mismatch", "runtime-metadata-unverified", "process-identity-unavailable",
] as const;
type HostBrokerProcessVerificationFailure = typeof HOST_BROKER_PROCESS_VERIFICATION_FAILURES[number];

function hostBrokerRuntimeFromPortProcess(
    ownerId: string,
    port: number,
    compatibility: unknown,
    platform: NodeJS.Platform,
    portProcessResolver: BrokerPortProcessResolver,
    persistedRuntime: Record<string, unknown> | null,
    statusRuntime: Record<string, unknown> | null,
    expectedCliPath?: string | readonly string[],
    allowParentManagedRuntime = false,
    verification?: { failure?: HostBrokerProcessVerificationFailure },
): Record<string, unknown> | null {
    const deny = (failure: HostBrokerProcessVerificationFailure) => {
        if (verification) verification.failure = failure;
        return null;
    };
    const record = compatibilityBrokerRecord(compatibility);
    const process = portProcessResolver(port, platform);
    if (!process || !Number.isInteger(process.pid) || process.pid <= 0) return deny("listener-unavailable");
    if (statusRuntime && Number(statusRuntime.pid) !== process.pid) return deny("status-pid-mismatch");
    const commandLine = process.commandLine?.trim() || "";
    const commandLineVerified = isBrokerServeCommandLine(commandLine, port, expectedCliPath);
    const observedStartToken = process.processStartToken
        || process.processIdentity?.startToken
        || readDeviceRuntimeProcessStartToken(process.pid, { platform });
    const persistedStartToken = typeof persistedRuntime?.processStartToken === "string"
        ? persistedRuntime.processStartToken
        : null;
    const statusStartToken = typeof statusRuntime?.processStartToken === "string"
        ? statusRuntime.processStartToken
        : null;
    const persistedMetadataMatches = persistedRuntime?.name === DEVICE_BROKER_NAME
        && (persistedRuntime?.managedBy === "ccc-host"
            || (allowParentManagedRuntime && persistedRuntime?.managedBy === "device-lab-mcp"))
        && Number(persistedRuntime?.pid) === process.pid
        && Number(persistedRuntime?.port) === port;
    const persistedContinuity = !persistedRuntime
        || (persistedMetadataMatches
            && observedStartToken !== null
            && (observedStartToken === persistedStartToken
                || (!persistedStartToken
                    && persistedRuntime.managedBy === "ccc-host"
                    && typeof persistedRuntime.startedAt === "string"
                    && persistedRuntime.startedAt === statusRuntime?.startedAt)));
    const statusMetadataMatches = statusRuntime?.name === DEVICE_BROKER_NAME
        && statusRuntime?.managedBy === "ccc-host-status"
        && Number(statusRuntime?.pid) === process.pid
        && Number(statusRuntime?.port) === port;
    const statusIdentityVerified = statusMetadataMatches
        && observedStartToken !== null
        && observedStartToken === statusStartToken;
    const legacyStatusWithoutToken = (!statusRuntime || statusMetadataMatches)
        && !statusStartToken;
    const legacyPersistedCommandContinuity = !persistedRuntime
        || (persistedRuntime.managedBy === "ccc-host" && persistedMetadataMatches);
    // A second broker can leave the shared runtime file pointing at another port.
    // That record is neither evidence for nor a veto on this listener. Recovery
    // still requires the trusted command and matching OS/status generation;
    // same-port or same-PID conflicts keep their original fail-closed behavior.
    const persistedOtherPort = persistedRuntime?.name === DEVICE_BROKER_NAME
        && (persistedRuntime.managedBy === "ccc-host" || persistedRuntime.managedBy === "device-lab-mcp")
        && Number.isInteger(persistedRuntime.port)
        && Number(persistedRuntime.port) > 0 && Number(persistedRuntime.port) <= 65535
        && Number(persistedRuntime.port) !== port
        && Number.isInteger(persistedRuntime.pid) && Number(persistedRuntime.pid) > 0
        && Number(persistedRuntime.pid) !== process.pid;
    const commandLineTrusted = commandLineVerified
        && (persistedContinuity || (persistedOtherPort && statusIdentityVerified))
        && (statusIdentityVerified || (legacyPersistedCommandContinuity && legacyStatusWithoutToken));
    const metadataVerified = commandLine.length === 0
        && persistedRuntime?.managedBy === "ccc-host"
        && persistedContinuity
        && statusIdentityVerified;
    if (!commandLineTrusted && !metadataVerified) {
        if (commandLine && !commandLineVerified) return deny("command-or-entry-unverified");
        if (!observedStartToken) return deny("process-start-unavailable");
        if ((statusMetadataMatches && statusStartToken && observedStartToken !== statusStartToken)
            || (persistedMetadataMatches && persistedStartToken && observedStartToken !== persistedStartToken)) {
            return deny("process-generation-mismatch");
        }
        return deny("runtime-metadata-unverified");
    }
    const processIdentity = process.processIdentity || readDeviceRuntimeProcessIdentity(process.pid, { platform });
    if (!processIdentity && !metadataVerified) return deny("process-identity-unavailable");
    return {
        name: DEVICE_BROKER_NAME,
        managedBy: commandLineVerified ? "ccc-host-port" : "ccc-host-port-metadata",
        ownerId,
        pid: process.pid,
        host: typeof record?.host === "string" ? record.host : null,
        port,
        commandLine: commandLine || null,
        ...(processIdentity ? { processIdentity } : {}),
        processStartToken: observedStartToken,
        identitySource: commandLineVerified ? "port-command-line" : "port-pid-plus-runtime-and-status",
    };
}

export const hostBrokerRuntimeFromPortProcessForTest = hostBrokerRuntimeFromPortProcess;

function isBrokerServeCommandLine(commandLine: string, port: number, expectedCliPath?: string | readonly string[]): boolean {
    const normalized = commandLine.replace(/["']/g, " ").replace(/\s+/g, " ").trim();
    const normalizedPath = (value: string) => value.replace(/["']/g, "").replace(/\\/g, "/").toLowerCase();
    const commandTokens = Array.from(commandLine.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g), (match) => match[1] ?? match[2] ?? match[3]);
    const expectedPathVerified = !expectedCliPath || (commandTokens.length > 1
        && /(?:^|\/)node(?:\.exe)?$/i.test(normalizedPath(commandTokens[0]))
        && (typeof expectedCliPath === "string" ? [expectedCliPath] : expectedCliPath).some(path => normalizedPath(commandTokens[1]) === normalizedPath(path)));
    return /\bdevices\s+broker\s+serve\b/i.test(normalized)
        && (/\bccc(?:\.cmd|\.exe)?\b/i.test(normalized) || /\bnode(?:\.exe)?\b.*\bindex\.js\b/i.test(normalized)
            || Boolean(expectedCliPath && expectedPathVerified && /(?:^|\/)broker-entry\.js$/i.test(normalizedPath(commandTokens[1]))))
        && new RegExp(`(?:^|\\s)--port(?:=|\\s+)${port}(?:\\s|$)`).test(normalized)
        && expectedPathVerified;
}

function captureBrokerNativeRemainingMs(parentRemainingMs?: () => number): (() => number) | undefined {
    if (!parentRemainingMs) return undefined;
    let deadline = Infinity;
    const remainingMs = () => {
        const observedAt = performance.now();
        const parent = parentRemainingMs();
        deadline = Number.isFinite(parent) && parent > 0 ? Math.min(deadline, observedAt + parent) : -Infinity;
        return Math.max(0, Math.floor(deadline - performance.now()));
    };
    remainingMs();
    return remainingMs;
}

function discoverBrokerPortProcess(port: number, platform: NodeJS.Platform, parentRemainingMs?: () => number): BrokerPortProcess | null {
    const remainingMs = captureBrokerNativeRemainingMs(parentRemainingMs);
    if (!brokerProcessRemainingMs(remainingMs)) return null;
    if (platform === "linux") return discoverLinuxBrokerPortProcess(port, remainingMs);
    if (platform === "darwin") return discoverCommandBrokerPortProcess("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], "darwin", remainingMs);
    if (platform === "win32") return discoverWindowsBrokerPortProcess(port, remainingMs);
    return null;
}

export const discoverBrokerPortProcessForTest = discoverBrokerPortProcess;

function discoverLinuxBrokerPortProcess(port: number, remainingMs?: () => number): BrokerPortProcess | null {
    const portHex = port.toString(16).toUpperCase().padStart(4, "0");
    const inodes = new Set<string>();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        if (!brokerProcessRemainingMs(remainingMs)) return null;
        try {
            const lines = readFileSync(file, "utf8").trim().split(/\n/).slice(1);
            for (const line of lines) {
                const fields = line.trim().split(/\s+/);
                const localAddress = fields[1] || "";
                const state = fields[3] || "";
                const inode = fields[9] || "";
                if (state === "0A" && localAddress.split(":").pop() === portHex && inode) inodes.add(inode);
            }
        } catch {
            // /proc may be unavailable from containers or restricted hosts.
        }
    }
    if (inodes.size === 0) return null;
    try {
        for (const pidText of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
            if (!brokerProcessRemainingMs(remainingMs)) return null;
            const fdRoot = `/proc/${pidText}/fd`;
            let fds: string[] = [];
            try { fds = readdirSync(fdRoot); } catch { continue; }
            for (const fd of fds) {
                if (!brokerProcessRemainingMs(remainingMs)) return null;
                let target = "";
                try { target = readlinkSync(join(fdRoot, fd)); } catch { continue; }
                const match = /^socket:\[(\d+)\]$/.exec(target);
                if (!match || !inodes.has(match[1])) continue;
                const pid = Number(pidText);
                let commandLine = "";
                if (!brokerProcessRemainingMs(remainingMs)) return { pid, commandLine };
                try { commandLine = readFileSync(`/proc/${pidText}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch { /* ignore */ }
                if (!brokerProcessRemainingMs(remainingMs)) return { pid, commandLine };
                const processIdentity = readDeviceRuntimeProcessIdentity(pid, { platform: "linux", ...(remainingMs ? { remainingMs } : {}) });
                return { pid, commandLine, processIdentity };
            }
        }
    } catch {
        return null;
    }
    return null;
}

function discoverCommandBrokerPortProcess(command: string, args: string[], platform: NodeJS.Platform, remainingMs?: () => number): BrokerPortProcess | null {
    const timeout = Math.min(5000, brokerProcessRemainingMs(remainingMs));
    if (!timeout) return null;
    const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout });
    if (result.status !== 0 || result.error || result.signal || !result.stdout) return null;
    const pid = platform === "darwin"
        ? Number((result.stdout.match(/^p(\d+)$/m) || [])[1])
        : NaN;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const psTimeout = Math.min(5000, brokerProcessRemainingMs(remainingMs));
    if (!psTimeout) return { pid, commandLine: "" };
    const ps = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", windowsHide: true, timeout: psTimeout });
    if (ps.status !== 0 || ps.error || ps.signal) return remainingMs && !brokerProcessRemainingMs(remainingMs) ? { pid, commandLine: "" } : null;
    const commandLine = ps.stdout.trim();
    if (!brokerProcessRemainingMs(remainingMs)) return { pid, commandLine };
    const processIdentity = readDeviceRuntimeProcessIdentity(pid, { platform, ...(remainingMs ? { remainingMs } : {}) });
    return { pid, commandLine, processIdentity };
}

export function parseWindowsBrokerNetstatListenerForTest(output: string, port: number): BrokerPortProcess | null {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    for (const line of output.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 5 || fields[0]?.toUpperCase() !== "TCP") continue;
        const localPort = Number(/:(\d+)$/.exec(fields[1] || "")?.[1]);
        const remotePort = Number(/:(\d+)$/.exec(fields[2] || "")?.[1]);
        const pid = Number(fields.at(-1));
        if (localPort === port && remotePort === 0 && Number.isInteger(pid) && pid > 0) {
            return { pid, commandLine: "" };
        }
    }
    return null;
}

function discoverWindowsBrokerPortProcess(port: number, remainingMs?: () => number): BrokerPortProcess | null {
    const netstatPath = canonicalWindowsSystemExecutablePath("netstat.exe");
    const netstatTimeout = Math.min(5000, brokerProcessRemainingMs(remainingMs));
    if (!netstatTimeout) return null;
    const netstat = netstatPath ? spawnSync(netstatPath, ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: netstatTimeout,
    }) : { status: null, stdout: "" };
    const listener = netstat.status === 0
        ? parseWindowsBrokerNetstatListenerForTest(netstat.stdout || "", port)
        : null;
    if (!listener) return null;
    const powershell = canonicalWindowsPowerShellPath();
    const script = windowsBrokerPortProcessProbeScript(listener.pid);
    const timeout = Math.min(10000, brokerProcessRemainingMs(remainingMs));
    if (!timeout) return listener;
    const result = powershell ? spawnSync(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]), {
        encoding: "utf8",
        windowsHide: true,
        timeout,
    }) : { status: null, stdout: "" };
    if (result.status === 0 && result.stdout) {
        const observed = parseWindowsBrokerPortProcessProbe(listener, result.stdout);
        if (observed) return observed;
    }
    // One probe, not two, and one PRODUCER rather than two. `readDeviceRuntimeProcessIdentity`
    // returns the start token it derived; asking `readDeviceRuntimeProcessStartToken` for the
    // same pid launched a second powershell.exe AND produced the value from a second script,
    // so the two could drift. `discoverBrokerPortProcess` is called from about ten sites, and
    // the token it returns is persisted and later compared for equality to decide whether ccc
    // may terminate its own broker — a comparison that must not straddle two producers.
    if (!brokerProcessRemainingMs(remainingMs)) return listener;
    const processIdentity = readDeviceRuntimeProcessIdentity(listener.pid, { platform: "win32", ...(remainingMs ? { remainingMs } : {}) });
    const processStartToken = processIdentity?.startToken
        ?? (brokerProcessRemainingMs(remainingMs) ? readDeviceRuntimeProcessStartToken(listener.pid, { platform: "win32", ...(remainingMs ? { remainingMs } : {}) }) : null);
    return {
        ...listener,
        processIdentity,
        processStartToken,
    };
}

function hostBrokerCompatibilityDiagnostics(attempts: unknown[]): string[] {
    const diagnostics: string[] = [];
    for (const attempt of attempts) {
        if (!attempt || typeof attempt !== "object") continue;
        const record = attempt as Record<string, unknown>;
        if (record.reason === "missing-runtime") {
            diagnostics.push("existing broker is not restartable from this container because broker runtime metadata is missing");
        } else if (record.reason === "unverified-broker-port-process") {
            diagnostics.push("existing broker port owner could not be verified as the current CCC broker process");
            if ((HOST_BROKER_PROCESS_VERIFICATION_FAILURES as readonly unknown[]).includes(record.verificationFailure)) {
                diagnostics.push(`broker process verification: ${record.verificationFailure}`);
            }
        } else if (record.reason === "runtime-not-current-ccc-host-port") {
            diagnostics.push("existing broker runtime belongs to a different port");
        } else if (record.reason === "runtime-pid-still-alive") {
            diagnostics.push("existing broker did not stop after automatic restart request");
        } else if (record.reason === "runtime-stop-failed") {
            diagnostics.push(`existing broker restart failed: ${String(record.detail || "unknown error")}`);
        } else if (record.reason === "runtime-host-platform-mismatch") {
            diagnostics.push(`existing broker runs on ${String(record.hostPlatform || "another host platform")} and must be restarted by host CCC, not ${String(record.currentPlatform || "this container")}`);
        } else if (record.reason === "broker-newer-than-cli") {
            diagnostics.push("existing broker is newer than this CCC CLI and will not be downgraded");
        }
        if ("versionCompatible" in record && record.versionCompatible === false) {
            diagnostics.push(`existing broker protocol ${String(record.protocolVersion ?? "unknown")} does not match required protocol ${DEVICE_BROKER_PROTOCOL_VERSION}`);
        }
        const ownerResolve = record.ownerResolve;
        if (ownerResolve && typeof ownerResolve === "object") {
            const ownerRecord = ownerResolve as Record<string, unknown>;
            if (ownerRecord.status === 405) {
                diagnostics.push("existing broker does not support the current owner-resolve POST contract");
            } else if (ownerRecord.ownerCompatible === false && ownerRecord.ownerId) {
                diagnostics.push(`existing broker resolved owner ${String(ownerRecord.ownerId)} instead of ${String(ownerRecord.expectedOwnerId || "current owner")}`);
            } else if (ownerRecord.available === false) {
                diagnostics.push("existing broker owner resolution is unavailable");
            }
        }
    }
    return [...new Set(diagnostics)];
}

function verifiedHostBrokerProtocol(status: unknown): number | null {
    const value = (status as { body?: { broker?: { protocolVersion?: unknown } } } | null)?.body?.broker?.protocolVersion;
    return isCompatibleBrokerProtocol(value) ? DEVICE_BROKER_PROTOCOL_VERSION : null;
}

function verifiedHostBrokerIdentity(status: unknown): { pid: number; startedAt: string; processStartToken: string | null } | null {
    if (!status || typeof status !== "object") return null;
    const body = (status as { body?: unknown }).body;
    if (!body || typeof body !== "object") return null;
    const broker = (body as { broker?: unknown }).broker;
    if (!broker || typeof broker !== "object") return null;
    const record = broker as { process?: unknown; startedAt?: unknown };
    const processRecord = record.process && typeof record.process === "object"
        ? record.process as { pid?: unknown; startToken?: unknown }
        : null;
    const pid = Number(processRecord?.pid);
    const startedAt = typeof record.startedAt === "string" ? record.startedAt : "";
    const processStartToken = typeof processRecord?.startToken === "string"
        ? processRecord.startToken
        : "";
    return Number.isInteger(pid) && pid > 0 && startedAt && processStartToken
        ? { pid, startedAt, processStartToken }
        : null;
}

export const verifiedHostBrokerIdentityForTest = verifiedHostBrokerIdentity;

export function verifySpawnedHostBrokerListenerForTest(
    pid: number | null,
    spawnedIdentity: DeviceRuntimeProcessIdentity | null,
    listener: BrokerPortProcess | null,
    listenerIdentity: DeviceRuntimeProcessIdentity | null,
    port: number,
    cliPath: string | readonly string[],
    startTokens: {
        spawned?: string | null;
        listener?: string | null;
        status?: string | null;
    } = {},
): boolean {
    const tokenEvidenceProvided = Boolean(startTokens.spawned || startTokens.listener || startTokens.status);
    const startTokensVerified = !tokenEvidenceProvided || Boolean(
        startTokens.spawned
        && startTokens.spawned === startTokens.listener
        && startTokens.spawned === startTokens.status,
    );
    const commandLineIdentityVerified = Boolean(
        pid
        && spawnedIdentity
        && listener?.pid === pid
        && listenerIdentity
        && deviceRuntimeProcessIdentityMatches(spawnedIdentity, listenerIdentity)
        && isBrokerServeCommandLine(listener.commandLine?.trim() || "", port, cliPath)
        && startTokensVerified,
    );
    const redactedStartTokenVerified = Boolean(
        pid
        && listener?.pid === pid
        && !listener.commandLine?.trim()
        && startTokens.spawned
        && startTokens.spawned === startTokens.listener
        && startTokens.spawned === startTokens.status,
    );
    return commandLineIdentityVerified || redactedStartTokenVerified;
}

function retainRecentBrokerAttempt(attempts: unknown[], attempt: unknown) {
    attempts.push(attempt);
    if (attempts.length > DEVICE_BROKER_STARTUP_ATTEMPT_HISTORY_LIMIT) attempts.shift();
}

export const retainRecentBrokerAttemptForTest = retainRecentBrokerAttempt;

async function waitForHostBrokerReady(host: string, port: number, timeoutMs: number, cwd: string, expectedOwnerId: string, profile?: string) {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const attempts: unknown[] = [];
    while (Date.now() <= deadline) {
        const remaining = Math.min(250, Math.max(1, deadline - Date.now()));
        const health = await probeHostBrokerHealth(host, port, remaining);
        retainRecentBrokerAttempt(attempts, health);
        if (health.available) {
            const status = await probeHostBrokerStatus(host, port, remaining, cwd, expectedOwnerId, profile);
            retainRecentBrokerAttempt(attempts, status);
            if (status.compatible) return { available: true, compatible: true, attempts, selected: status };
        }
        await sleep(50);
    }
    return { available: false, compatible: false, attempts, selected: null };
}

export async function ensureHostDeviceBroker(options: HostDeviceBrokerOptions = {}) {
    const bindHost = options.bindHost || options.host || DEVICE_BROKER_DEFAULT_HOST;
    const initial = normalizeBrokerOptions({ ...options, host: bindHost });
    const env = initial.env;
    const runtimeFile = initial.runtimeFile;
    if (options.enabled === false || env.CCC_DEVICE_BROKER_AUTO_START === "0") {
        return { ok: true, skipped: true, reason: "disabled" };
    }

    const ownerId = options.ownerId || deviceBrokerOwnerId(initial.cwd, options.profile);
    const runtime = readHostBrokerRuntime(runtimeFile);
    const runtimePort = (runtime?.managedBy === "ccc-host" || runtime?.managedBy === "device-lab-mcp")
        && Number.isInteger(runtime.port)
        ? Number(runtime.port)
        : null;
    const nativeTokenFamily = process.platform === "linux" ? "linux:"
        : process.platform === "win32" ? "windows:" : process.platform === "darwin" ? "ps:" : null;
    const nativeToken = typeof runtime?.processStartToken === "string" ? runtime.processStartToken : null;
    const runtimeIsLocal = runtime?.platform === process.platform
        || ((runtime?.platform === undefined || runtime?.platform === null) && nativeTokenFamily !== null
            && nativeToken !== null && nativeToken.startsWith(nativeTokenFamily)
            && nativeToken.slice(nativeTokenFamily.length).trim().length > 0);
    const explicitPort = Number.isInteger(options.port) || configuredDeviceBrokerPort(env) !== undefined;
    const exitedLocalHint = !explicitPort && runtimePort !== null && runtimePort !== initial.port
        && runtimePort > 0 && runtimePort <= 65535 && Number.isInteger(runtime?.pid) && Number(runtime?.pid) > 0 && runtimeIsLocal
        && probeDeviceRuntimeProcessLiveness(runtime?.pid) === "exited";
    const port = !explicitPort && runtimePort !== null && !exitedLocalHint ? runtimePort : initial.port;
    const normalized = port === initial.port ? initial : { ...initial, port };
    const probeHost = options.probeHost || DEVICE_BROKER_DEFAULT_HOST;
    const probeTimeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Number(options.timeoutMs)) : 250;
    const startupTimeoutMs = Number.isFinite(options.startupTimeoutMs)
        ? Math.max(1, Number(options.startupTimeoutMs))
        : DEVICE_BROKER_AUTO_START_TIMEOUT_MS;

    registerDeviceBrokerOwner(normalized.cwd, options.profile);
    deviceBrokerOwnerToken(ownerId);

    const before = await probeHostBrokerHealth(probeHost, port, probeTimeoutMs);
    const prelaunchAttempts: unknown[] = [before];
    const portProcessResolver = options.portProcessResolver || discoverBrokerPortProcess;
    const processIdentityReader = options.processIdentityReader
        || ((pid: number, platform: NodeJS.Platform) => readDeviceRuntimeProcessIdentity(pid, { platform }));
    const processStartTokenReader = options.processStartTokenReader
        || ((pid: number, platform: NodeJS.Platform) => readDeviceRuntimeProcessStartToken(pid, { platform }));
    if (before.available) {
        const compatibility = await probeHostBrokerStatus(probeHost, port, probeTimeoutMs, normalized.cwd, ownerId, options.profile);
        prelaunchAttempts.push(compatibility);
        const runtime = readHostBrokerRuntime(runtimeFile);
        const statusRuntime = hostBrokerRuntimeFromStatus(ownerId, port, compatibility);
        const verifiedRuntime = compatibility.compatible
            ? hostBrokerRuntimeFromPortProcess(
                ownerId,
                port,
                compatibility,
                normalized.platform,
                portProcessResolver,
                runtime,
                statusRuntime,
                normalized.trustedCliPaths,
                true,
            )
            : null;
        const verifiedIdentity = verifiedHostBrokerIdentity(compatibility);
        prelaunchAttempts.push({ reason: verifiedRuntime ? "compatible-broker-process-verified" : "compatible-broker-process-unverified", runtime: verifiedRuntime });
        if (compatibility.compatible && (hostBrokerRuntimeMatchesRequiredBindHost(runtime, port, bindHost)
            || hostBrokerStatusMatchesRequiredBindHost(compatibility, port, bindHost))
            && verifiedRuntime
            && verifiedIdentity?.pid === Number(verifiedRuntime.pid)) {
            if (runtime?.managedBy !== "device-lab-mcp") writeHostBrokerRuntime(runtimeFile, {
                ...(runtime || {}),
                ...(statusRuntime || {}),
                ...verifiedRuntime,
                name: DEVICE_BROKER_NAME,
                managedBy: "ccc-host",
                ownerId,
                pid: verifiedIdentity.pid,
                host: typeof verifiedRuntime.host === "string" ? verifiedRuntime.host : bindHost,
                probeHost,
                port,
                startedAt: verifiedIdentity.startedAt,
                processStartToken: verifiedIdentity.processStartToken,
            });
            return {
                ok: true,
                ownerId,
                launched: false,
                reused: true,
                host: bindHost,
                probeHost,
                port,
                verifiedProtocolVersion: verifiedHostBrokerProtocol(compatibility),
                verifiedBrokerPid: verifiedIdentity.pid,
                verifiedBrokerStartedAt: verifiedIdentity.startedAt,
                verifiedBrokerProcessStartToken: verifiedIdentity.processStartToken,
                attempts: prelaunchAttempts,
            };
        }
        const restartReason = compatibility.compatible
            ? { ...(compatibility as Record<string, unknown>), runtimeBindHostMismatch: true, expectedHost: bindHost, runtimeHost: runtime?.host ?? null }
            : compatibility;
        const stopped = await stopIncompatibleHostBroker(ownerId, port, restartReason, runtimeFile, normalized.platform, portProcessResolver, normalized.trustedCliPaths, options.terminateProcess);
        prelaunchAttempts.push(stopped);
        if (!stopped.restartable) {
            return {
                ok: false,
                ownerId,
                launched: false,
                reused: false,
                error: "host-broker-incompatible",
                host: bindHost,
                probeHost,
                port,
                attempts: prelaunchAttempts,
                diagnostics: hostBrokerCompatibilityDiagnostics(prelaunchAttempts),
            };
        }
    } else {
        const listener = portProcessResolver(port, normalized.platform);
        if (listener) {
            const stopped = await stopIncompatibleHostBroker(
                ownerId,
                port,
                { ...before, reason: "unhealthy-broker-port-owner" },
                runtimeFile,
                normalized.platform,
                portProcessResolver,
                normalized.trustedCliPaths,
                options.terminateProcess,
            );
            prelaunchAttempts.push(stopped);
            if (!stopped.restartable) {
                return {
                    ok: false,
                    ownerId,
                    launched: false,
                    reused: false,
                    error: "host-broker-incompatible",
                    host: bindHost,
                    probeHost,
                    port,
                    attempts: prelaunchAttempts,
                    diagnostics: hostBrokerCompatibilityDiagnostics(prelaunchAttempts),
                };
            }
        }
    }

    const command = process.execPath;
    const args = [normalized.cliPath, "devices", "broker", "serve", "--host", bindHost, "--port", String(port)];
    let logPath = join(brokerRoot(), "broker", "logs", "host-broker-pending.log");
    const spawnImpl = options.spawnImpl || spawn;
    if (options.profile && !env.CCC_PROFILE) env.CCC_PROFILE = options.profile;

    let logFd: number | null = null;
    try {
        const log = createHostBrokerLogFile();
        logPath = log.path;
        logFd = log.descriptor;
        const child = spawnImpl(command, args, {
            cwd: normalized.cwd,
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env,
            windowsHide: true,
        });
        child.once("error", () => { /* readiness probe below reports startup failure */ });
        child.once("exit", () => { /* readiness probe below reports early exit as timeout */ });
        const pid = child.pid || null;
        // ONE probe per attempt, not two, and a budget rather than a drumbeat.
        //
        // `readDeviceRuntimeProcessIdentity` already returns `startToken`, and it is
        // byte-identical to what the standalone reader produces — both prefix it
        // (`windows:`, `linux:`, `ps:`) in the same place — so asking for it separately
        // launched a SECOND `powershell.exe` on Windows for a value already in hand.
        // With the old fixed 25ms × 20 that was up to 40 PowerShell processes inside half
        // a second, every time `Preparing device broker...` runs. The standalone reader is
        // kept as the fallback because identity needs BOTH a start token and a command
        // line: a process whose command line cannot be read yields no identity but still
        // has a readable token.
        // The retry bound is an ATTEMPT count, not wall clock. A wall-clock bound charges the
        // probe's own cost against the retry budget, and these probes are synchronous
        // `spawnSync` powershell launches: measured, once one probe costs ~475ms the loop body
        // never runs at all. That is precisely the slow, loaded Windows host the retries exist
        // for — `Get-CimInstance Win32_Process` behind a cold powershell.exe is routinely that
        // slow, WMI fails transiently under exactly that load, and losing the retry there means
        // no identity, which makes the launch unverifiable and kills a broker that came up
        // healthy. The budget below bounds only how long this SLEEPS; when it is spent the
        // remaining attempts run back to back.
        const identitySleepDeadline = Date.now() + DEVICE_BROKER_IDENTITY_PROBE_SLEEP_BUDGET_MS;
        let spawnedProcessIdentity = pid ? processIdentityReader(pid, normalized.platform) : null;
        let spawnedProcessStartToken = spawnedProcessIdentity?.startToken
            ?? (pid ? processStartTokenReader(pid, normalized.platform) : null);
        for (
            let attempt = 0, delay = DEVICE_BROKER_IDENTITY_PROBE_FIRST_DELAY_MS;
            pid
                && (!spawnedProcessIdentity || !spawnedProcessStartToken)
                && attempt < DEVICE_BROKER_IDENTITY_PROBE_ATTEMPTS;
            attempt += 1, delay = Math.min(delay * 2, DEVICE_BROKER_IDENTITY_PROBE_MAX_DELAY_MS)
        ) {
            // Clamped, not refused: the old guard declined to START a sleep that would end past
            // the deadline, so it left the last ~125ms of its own budget unused.
            const sleep = Math.max(0, Math.min(delay, identitySleepDeadline - Date.now()));
            if (sleep > 0) await new Promise((resolve) => setTimeout(resolve, sleep));
            spawnedProcessIdentity ||= processIdentityReader(pid, normalized.platform);
            spawnedProcessStartToken ||= spawnedProcessIdentity?.startToken
                ?? processStartTokenReader(pid, normalized.platform);
        }
        child.unref();

        const ready = await waitForHostBrokerReady(probeHost, port, startupTimeoutMs, normalized.cwd, ownerId, options.profile);
        if (!ready.available) {
            let startupCleanup: Record<string, unknown> = { attempted: false, reason: "spawned-process-identity-unavailable" };
            if (pid) {
                const observation = inspectDeviceRuntimeProcessIdentity(spawnedProcessIdentity, pid, {
                    platform: normalized.platform,
                    readIdentity: (value) => processIdentityReader(value, normalized.platform),
                });
                // The observation above already read the CURRENT identity, and its start token
                // is the same value this asked a second process for — same prefix, same
                // source. Only fall back to a separate read when the observation produced no
                // identity at all, which is the case where a command line is unreadable but a
                // start token is not.
                const currentStartToken = spawnedProcessStartToken
                    ? observation.current?.startToken ?? processStartTokenReader(pid, normalized.platform)
                    : null;
                if (observation.status === "match"
                    || (spawnedProcessStartToken && currentStartToken === spawnedProcessStartToken)) {
                    try {
                        const result = options.terminateProcess
                            ? options.terminateProcess(pid, spawnedProcessIdentity || undefined, spawnedProcessStartToken || undefined)
                            : process.platform === "win32"
                                ? terminateWindowsProcessTree(pid, spawnedProcessIdentity || undefined, false, spawnedProcessStartToken || undefined)
                                : currentStartToken === spawnedProcessStartToken
                                    ? (process.kill(pid, "SIGTERM"), { ok: true })
                                    : { ok: false, error: "runtime-process-start-token-mismatch" };
                        startupCleanup = {
                            attempted: true,
                            ok: result.ok,
                            pid,
                            signal: "SIGTERM",
                            ...("error" in result && result.error ? { error: result.error } : {}),
                        };
                    } catch (error) {
                        startupCleanup = { attempted: true, ok: false, pid, signal: "SIGTERM", error: error instanceof Error ? error.message : String(error) };
                    }
                } else {
                    startupCleanup = { attempted: false, reason: `spawned-process-identity-${observation.status}`, observation };
                }
            }
            return {
                ok: false,
                ownerId,
                launched: true,
                reused: false,
                error: "host-broker-health-timeout",
                host: bindHost,
                probeHost,
                port,
                command,
                args,
                logPath,
                startupCleanup,
                attempts: [...prelaunchAttempts, ...ready.attempts],
            };
        }

        const listener = portProcessResolver(port, normalized.platform);
        const listenerIdentity = listener?.processIdentity
            || (listener?.pid ? processIdentityReader(listener.pid, normalized.platform) : null);
        const listenerStartToken = listener?.processStartToken
            || listenerIdentity?.startToken
            || (listener?.pid ? processStartTokenReader(listener.pid, normalized.platform) : null);
        const verifiedIdentity = verifiedHostBrokerIdentity(ready.selected);
        const listenerVerified = verifySpawnedHostBrokerListenerForTest(
            pid,
            spawnedProcessIdentity,
            listener,
            listenerIdentity,
            port,
            normalized.trustedCliPaths,
            {
                spawned: spawnedProcessStartToken,
                listener: listenerStartToken,
                status: verifiedIdentity?.processStartToken,
            },
        );
        if (!listenerVerified || !verifiedIdentity || verifiedIdentity.pid !== pid) {
            const observation = pid
                ? inspectDeviceRuntimeProcessIdentity(spawnedProcessIdentity, pid, {
                    platform: normalized.platform,
                    readIdentity: (value) => processIdentityReader(value, normalized.platform),
                })
                : { status: "unavailable", current: null };
            // Same substitution as the readiness path, and here it is CORRECTNESS rather than
            // a saved launch. `spawnedProcessStartToken` now comes from the identity probe,
            // so reading the current token with the standalone reader compares two DIFFERENT
            // producers of the same value on every execution of this path — and this
            // comparison decides whether ccc may terminate the process it just launched. The
            // observation above already read the current identity, from the same producer, and
            // it is read fresh every time rather than echoed back. It is read EARLIER than a second
            // read would be, so marginally staler — not fresher, as this once claimed; what matters
            // is that it is a real observation of the current process, not the expected value.
            const currentStartToken = pid && spawnedProcessStartToken
                ? observation.current?.startToken ?? processStartTokenReader(pid, normalized.platform)
                : null;
            if (pid && (observation.status === "match"
                || (spawnedProcessStartToken && currentStartToken === spawnedProcessStartToken))) {
                try {
                    if (options.terminateProcess) {
                        options.terminateProcess(pid, spawnedProcessIdentity || undefined, spawnedProcessStartToken || undefined);
                    } else if (process.platform === "win32") {
                        terminateWindowsProcessTree(pid, spawnedProcessIdentity || undefined, false, spawnedProcessStartToken || undefined);
                    } else if (currentStartToken === spawnedProcessStartToken) {
                        process.kill(pid, "SIGTERM");
                    }
                } catch { /* bounded failure below is sufficient */ }
            }
            return {
                ok: false,
                ownerId,
                launched: true,
                reused: false,
                error: "host-broker-launch-process-unverified",
                host: bindHost,
                probeHost,
                port,
                command,
                args,
                logPath,
                listener: listener ? { pid: listener.pid, processIdentity: listenerIdentity } : null,
                attempts: [...prelaunchAttempts, ...ready.attempts],
            };
        }

        const runtime = {
            name: DEVICE_BROKER_NAME,
            managedBy: "ccc-host",
            version: DEVICE_LAB_VERSION,
            ownerId,
            pid,
            host: bindHost,
            probeHost,
            hostCandidates: hostBrokerProbeCandidates(bindHost, probeHost),
            port,
            command,
            args,
            cwd: normalized.cwd,
            profile: options.profile || null,
            logPath,
            startedAt: verifiedIdentity.startedAt,
            processStartToken: verifiedIdentity.processStartToken || listenerStartToken || null,
        };
        writeHostBrokerRuntime(runtimeFile, runtime);
        return {
            ok: true,
            ownerId,
            launched: true,
            reused: false,
            runtime,
            host: bindHost,
            probeHost,
            port,
            verifiedProtocolVersion: verifiedHostBrokerProtocol(ready.selected),
            ...(verifiedIdentity ? {
                verifiedBrokerPid: verifiedIdentity.pid,
                verifiedBrokerStartedAt: verifiedIdentity.startedAt,
                verifiedBrokerProcessStartToken: verifiedIdentity.processStartToken,
            } : {}),
            attempts: [...prelaunchAttempts, ...ready.attempts],
        };
    } catch (error) {
        return {
            ok: false,
            ownerId,
            launched: false,
            reused: false,
            error: "host-broker-launch-failed",
            detail: error instanceof Error ? error.message : String(error),
            host: bindHost,
            probeHost,
            port,
            command,
            args,
            logPath,
            attempts: prelaunchAttempts,
        };
    } finally {
        if (logFd !== null) {
            try { closeSync(logFd); } catch { /* ignore close failure */ }
        }
    }
}

export async function invokeHostDeviceBrokerOwnerRpc(
    method: string,
    params: Record<string, unknown>,
    options: HostDeviceBrokerOptions & { rpcTimeoutMs?: number; ensureHostBroker?: typeof ensureHostDeviceBroker } = {},
): Promise<HostDeviceBrokerOwnerRpcResult> {
    const readiness = await (options.ensureHostBroker || ensureHostDeviceBroker)(options);
    const readinessRecord = readiness as Record<string, unknown>;
    const ownerId = typeof readinessRecord.ownerId === "string"
        ? readinessRecord.ownerId
        : deviceBrokerOwnerId(options.cwd || process.cwd(), options.profile);
    const host = typeof readinessRecord.probeHost === "string"
        ? readinessRecord.probeHost
        : DEVICE_BROKER_DEFAULT_HOST;
    const port = Number.isInteger(readinessRecord.port)
        ? Number(readinessRecord.port)
        : DEVICE_BROKER_DEFAULT_PORT;
    if (!("ok" in readiness) || readiness.ok !== true) {
        return {
            ok: false,
            status: null,
            ownerId,
            host,
            port,
            body: null,
            error: "error" in readiness && typeof readiness.error === "string" ? readiness.error : "host-broker-unavailable",
            ...(typeof readinessRecord.detail === "string" ? { detail: readinessRecord.detail } : {}),
        };
    }

    const verifiedBrokerPid = Number(readinessRecord.verifiedBrokerPid);
    const verifiedBrokerProcessStartToken = typeof readinessRecord.verifiedBrokerProcessStartToken === "string"
        ? readinessRecord.verifiedBrokerProcessStartToken
        : "";
    const platform = options.platform || process.platform;
    const portProcessResolver = options.portProcessResolver || discoverBrokerPortProcess;
    const processStartTokenReader = options.processStartTokenReader
        || ((pid: number, targetPlatform: NodeJS.Platform) => readDeviceRuntimeProcessStartToken(pid, { platform: targetPlatform }));
    const listener = Number.isInteger(verifiedBrokerPid) && verifiedBrokerPid > 0
        ? portProcessResolver(port, platform)
        : null;
    const listenerStartToken = listener?.processStartToken
        || (listener?.pid ? processStartTokenReader(listener.pid, platform) : null);
    if (!listener
        || listener.pid !== verifiedBrokerPid
        || !verifiedBrokerProcessStartToken
        || listenerStartToken !== verifiedBrokerProcessStartToken) {
        return {
            ok: false,
            status: null,
            ownerId,
            host,
            port,
            body: null,
            error: "broker-runtime-process-unverified",
        };
    }

    const timeoutMs = Number.isFinite(options.rpcTimeoutMs)
        ? Math.min(DEVICE_BROKER_MAX_RPC_TIMEOUT_MS, Math.max(1, Number(options.rpcTimeoutMs)))
        : 300000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // Node's http client never follows redirects, so the 3xx rejection in
        // readHostBrokerHttpJson stays the only redirect policy this lane has.
        const response = await hostBrokerHttpRequest(`http://${host}:${port}/v1/owners/${encodeURIComponent(ownerId)}/rpc`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-ccc-device-token": deviceBrokerOwnerToken(ownerId),
            },
            body: JSON.stringify({ method, params }),
            signal: controller.signal,
        });
        const responseBody = await readHostBrokerHttpJson(response, DEVICE_BROKER_RPC_RESPONSE_LIMIT_BYTES);
        const parsed = responseBody.body as Record<string, unknown> | null;
        // What `Response.ok` meant, spelled out: this transport reports a status, not a verdict.
        const httpOk = response.status >= 200 && response.status < 300;
        return {
            ok: responseBody.ok && httpOk && parsed?.ok === true,
            status: response.status,
            ownerId,
            host,
            port,
            body: parsed,
            ...(!responseBody.ok || !httpOk || parsed?.ok !== true
                ? { error: !responseBody.ok ? responseBody.error : typeof parsed?.error === "string" ? parsed.error : `broker-rpc-http-${response.status}` }
                : {}),
        };
    } catch (error) {
        // The signal, not the error's shape. Node raises a real AbortError only when the abort
        // lands before response headers; abort it mid-body and the socket is destroyed with a bare
        // `Error: aborted` (code ECONNRESET), which read as `broker-rpc-unavailable` — the broker
        // is gone — when the truth is that it is alive and slow. `fetch` classified both phases as
        // AbortError, so this is parity being restored rather than a new guard.
        //
        // On how a mid-body abort is reached, since the obvious story is wrong: writeJson is the
        // only response writer and it is a writeHead immediately followed by res.end, so there is
        // no application-level pause between headers and body to land in. The window is TCP flush
        // time and it scales with the reply, which nothing on the server caps — a success reply
        // passes through boundedBrokerErrorPayload unchanged, and the only bound is this client's
        // 64 MiB. Measured against that exact write shape: a 2 KB reply never lands mid-body, a
        // 60 MB one does. Small replies take the pre-headers path; the branch below is what keeps
        // the large ones honest.
        const timedOut = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
        return {
            ok: false,
            status: null,
            ownerId,
            host,
            port,
            body: null,
            error: timedOut ? "broker-rpc-timeout" : "broker-rpc-unavailable",
            detail: error instanceof Error ? error.message : String(error),
        };
    } finally {
        clearTimeout(timeout);
    }
}

export function deviceBrokerStatus(options: DeviceBrokerOptions = {}) {
    const normalized = normalizeBrokerOptions(options);
    const ownerId = options.ownerId || deviceBrokerOwnerId(normalized.cwd, options.profile);
    const facts = observeBrokerStatus(ownerId, normalized);
    return {
        name: DEVICE_BROKER_NAME, version: DEVICE_LAB_VERSION,
        ...facts.address, ownerId, hostId: facts.hostId, mode: "host-broker-daemon", lazy: true,
        process: facts.currentProcess,
        startupPolicy: "host ccc auto-starts the broker for containers; daemon startup never starts device providers",
        startedAt: facts.startedAt,
        state: { ...facts.paths, runtimeFile: facts.runtimeFile, rootExists: facts.rootExists },
        runtime: facts.runtimeFacts,
        containerContract: { environmentRequired: false, ownerResolution: "host-broker-resolve", deviceStateMounted: facts.deviceStateMounted },
        persistence: facts.persistence,
        serviceManager: { ...facts.serviceFacts, owner: facts.serviceOwner, ownedByCurrentOwner: facts.ownedByCurrentOwner, actions: ["status"] },
        hyperVElevationGate: facts.elevation, protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
    };
}

const observeBrokerStatus = (ownerId: string, normalized: NormalizedBrokerOptions) => createBrokerStatus({
    root: () => brokerRoot(),
    service: (normalized: NormalizedBrokerOptions) => deviceBrokerServicePlan(normalized),
    serviceOwner: () => readServiceOwner(),
    runtimeFile: () => normalized.runtimeFile,
    runtime: () => readHostBrokerRuntime(normalized.runtimeFile),
    address: normalized => ({ host: normalized.host, port: normalized.port, url: `http://${normalized.host}:${normalized.port}` }),
    hostId: () => hostname(),
    pid: () => process.pid,
    startToken: () => readDeviceRuntimeProcessStartToken(process.pid),
    startedAt: normalized => normalized.startedAt,
    paths: (root, ownerId) => ({ root, ownerRoot: join(root, "owners", ownerId), brokerRoot: join(root, "broker"), locksRoot: join(root, "broker", "locks"), logsRoot: join(root, "broker", "logs") }),
    exists: root => existsSync(root),
    persistence: ownerId => deviceBrokerPersistence(ownerId, normalized.runtimeFile),
    serviceFacts: service => ({ supported: service.supported, platform: service.platform, manager: service.manager, serviceName: service.serviceName, definitionPath: service.definitionPath, command: service.command, diagnostics: service.diagnostics }),
    elevation: () => hyperVElevationGateStatus(),
})(ownerId, normalized);

function serviceNameForPlatform(platform: NodeJS.Platform): string {
    if (platform === "darwin") return "com.ccc.device-broker";
    if (platform === "win32") return "CCC Device Broker";
    return "ccc-device-broker";
}

function serviceCommand(normalized: NormalizedBrokerOptions): string[] {
    return [
        process.execPath,
        normalized.cliPath,
        "devices",
        "broker",
        "serve",
        "--host",
        normalized.host,
        "--port",
        String(normalized.port),
    ];
}

function serviceLogPath(name: "out" | "err"): string {
    return join(brokerRoot(), "broker", "logs", `service.${name}.log`);
}

function serviceOwnerFile(): string {
    return join(brokerRoot(), "broker", "service", "owner.json");
}

function readServiceOwner(): ServiceOwnerRecord | null {
    try {
        return readDeviceLabStateFile(serviceOwnerFile(), (value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-service-owner");
            const parsed = value as Partial<ServiceOwnerRecord>;
            if (
                typeof parsed.ownerId !== "string"
                || !/^[a-f0-9]{16}$/.test(parsed.ownerId)
                || typeof parsed.serviceName !== "string"
                || typeof parsed.manager !== "string"
            ) throw new Error("invalid-service-owner");
            return {
                ownerId: parsed.ownerId,
                serviceName: parsed.serviceName,
                manager: parsed.manager,
                installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : new Date(0).toISOString(),
                updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
            };
        }, "broker-service-owner", DEVICE_BROKER_SERVICE_OWNER_FILE_LIMIT_BYTES);
    } catch {
        // Invalid service owner metadata is treated as absent.
    }
    return null;
}

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function systemdQuote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function brokerAppiumRuntimeRoot() {
    return join(brokerRoot(), "broker", "appium-runtime");
}

function brokerAppiumRuntimeDirectoryChain(): string[] {
    const root = brokerRoot();
    return [root, join(root, "broker"), brokerAppiumRuntimeRoot()];
}

function brokerAppiumRuntimeInstallLockFile(): string {
    return join(brokerRoot(), "broker", "appium-runtime.install.lock");
}

function inspectBrokerAppiumRuntimeDirectory(): boolean {
    for (const directory of brokerAppiumRuntimeDirectoryChain()) {
        let stat;
        try {
            stat = lstatSync(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw new Error("appium-runtime-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("appium-runtime-directory-invalid");
        }
    }
    return true;
}

function ensureBrokerAppiumRuntimeDirectory(): void {
    const [root, ...children] = brokerAppiumRuntimeDirectoryChain();
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("appium-runtime-directory-create-failed");
    }
    for (const directory of [root, ...children]) {
        if (directory !== root) {
            try {
                mkdirSync(directory, { mode: 0o700 });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("appium-runtime-directory-create-failed");
            }
        }
        let stat;
        try {
            stat = lstatSync(directory);
        } catch {
            throw new Error("appium-runtime-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("appium-runtime-directory-invalid");
        }
    }
}

function inspectBrokerAppiumNodeModulesDirectory(): boolean {
    const nodeModules = join(brokerAppiumRuntimeRoot(), "node_modules");
    try {
        const stat = lstatSync(nodeModules);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("appium-runtime-directory-invalid");
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        if (error instanceof Error && error.message === "appium-runtime-directory-invalid") throw error;
        throw new Error("appium-runtime-directory-read-failed");
    }
}

function brokerAppiumRuntimeEntryIsValid(entry: string): boolean {
    try {
        assertDeviceLabPathWithinRoot(brokerAppiumRuntimeRoot(), entry, "appium-runtime-entry");
        return withDeviceLabReadableFile(
            entry,
            "appium-runtime-entry",
            DEVICE_BROKER_APPIUM_ENTRY_LIMIT_BYTES,
            () => true,
        ) === true;
    } catch {
        return false;
    }
}

function brokerAppiumRuntimeExecutable(normalized: NormalizedBrokerOptions) {
    const binary = normalized.platform === "win32" ? "appium.cmd" : "appium";
    return join(brokerAppiumRuntimeRoot(), "node_modules", ".bin", binary);
}

function brokerAppiumRuntimeEntry() {
    return join(brokerAppiumRuntimeRoot(), "node_modules", "appium", "index.js");
}

function providerExecutable(name: string, normalized: NormalizedBrokerOptions): string | null {
    const injected = normalized.providerPaths[name];
    if (injected) return injected;
    if (["adb", "emulator", "avdmanager"].includes(name)) return findAndroidTool(name, normalized);
    if (normalized.platform === "darwin" && DEVICE_BROKER_MACOS_PROVIDERS.has(name)) return findMacosProvider(name);
    if (name === "appium") {
        const runtimeExecutable = brokerAppiumRuntimeExecutable(normalized);
        if (existsSync(runtimeExecutable)) return runtimeExecutable;
    }
    return resolveExecutablePath(name);
}

const WINDOWS_SYSTEM_POWERSHELL_PATH = "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function canonicalWindowsPowerShellForElevation(): string | null {
    if (process.platform !== "win32") return null;
    try {
        assertNoSymlinkPathComponents(dirname(WINDOWS_SYSTEM_POWERSHELL_PATH), "hyper-v-system-powershell");
        const source = lstatSync(WINDOWS_SYSTEM_POWERSHELL_PATH);
        if (!source.isFile() || source.isSymbolicLink()) return null;
        const resolved = realpathSync.native(WINDOWS_SYSTEM_POWERSHELL_PATH);
        const executable = /^\\\\\?\\[A-Za-z]:\\/.test(resolved) ? resolved.slice(4) : resolved;
        if (!/^[A-Za-z]:\\/.test(executable)) return null;
        assertNoSymlinkPathComponents(dirname(executable), "hyper-v-system-powershell");
        const target = lstatSync(executable);
        return target.isFile() && !target.isSymbolicLink() ? executable : null;
    } catch {
        return null;
    }
}

function hyperVElevationExecutable(standardExecutable: string): string {
    if (process.platform !== "win32") return standardExecutable;
    const canonical = canonicalWindowsPowerShellForElevation();
    if (!canonical) throw new Error("hyper-v-system-powershell-unavailable");
    return canonical;
}

function serviceProviderCommand(provider: string, executable: string | null, args: string[]): ProviderCommand {
    if (!executable) return { mode: "noop", provider, reason: `${provider} unavailable` };
    return { mode: "exec", provider, executable, args };
}

function linuxServicePlan(normalized: NormalizedBrokerOptions): ServicePlan {
    const executable = providerExecutable("systemctl", normalized);
    const serviceName = `${serviceNameForPlatform("linux")}.service`;
    const definitionPath = join(homedir(), ".config", "systemd", "user", serviceName);
    const command = serviceCommand(normalized);
    const content = [
        "[Unit]",
        "Description=CCC Device Broker",
        "Documentation=https://github.com/anthropics/claude-code",
        "",
        "[Service]",
        "Type=simple",
        `WorkingDirectory=${systemdQuote(normalized.cwd)}`,
        `ExecStart=${command.map(systemdQuote).join(" ")}`,
        "Restart=on-failure",
        "RestartSec=2",
        `StandardOutput=append:${serviceLogPath("out")}`,
        `StandardError=append:${serviceLogPath("err")}`,
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");
    return {
        supported: Boolean(executable),
        platform: "linux",
        manager: "systemd-user",
        serviceName,
        definitionPath,
        command,
        diagnostics: executable ? [] : ["systemctl not found; user systemd service management is unavailable"],
        files: [{ path: definitionPath, content }],
        commands: [],
    };
}

function macosServicePlan(normalized: NormalizedBrokerOptions): ServicePlan {
    const executable = providerExecutable("launchctl", normalized);
    const label = serviceNameForPlatform("darwin");
    const definitionPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const command = serviceCommand(normalized);
    const array = command.map((arg) => `        <string>${xmlEscape(arg)}</string>`).join("\n");
    const content = [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
        "<plist version=\"1.0\">",
        "<dict>",
        "    <key>Label</key>",
        `    <string>${xmlEscape(label)}</string>`,
        "    <key>ProgramArguments</key>",
        "    <array>",
        array,
        "    </array>",
        "    <key>WorkingDirectory</key>",
        `    <string>${xmlEscape(normalized.cwd)}</string>`,
        "    <key>EnvironmentVariables</key>",
        "    <dict>",
        "        <key>PATH</key>",
        `        <string>${xmlEscape([...DEVICE_BROKER_MACOS_PROVIDER_PATHS, "/usr/sbin", "/sbin"].join(":"))}</string>`,
        "    </dict>",
        "    <key>RunAtLoad</key>",
        "    <false/>",
        "    <key>KeepAlive</key>",
        "    <false/>",
        "    <key>StandardOutPath</key>",
        `    <string>${xmlEscape(serviceLogPath("out"))}</string>`,
        "    <key>StandardErrorPath</key>",
        `    <string>${xmlEscape(serviceLogPath("err"))}</string>`,
        "</dict>",
        "</plist>",
        "",
    ].join("\n");
    return {
        supported: Boolean(executable),
        platform: "darwin",
        manager: "launchd-user",
        serviceName: label,
        definitionPath,
        command,
        diagnostics: executable ? [] : ["launchctl not found; launchd service management is unavailable"],
        files: [{ path: definitionPath, content }],
        commands: [],
    };
}

function windowsServicePlan(normalized: NormalizedBrokerOptions): ServicePlan {
    const executable = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
    const serviceName = serviceNameForPlatform("win32");
    const command = serviceCommand(normalized);
    return {
        supported: Boolean(executable),
        platform: "win32",
        manager: "scheduled-task",
        serviceName,
        definitionPath: null,
        command,
        diagnostics: executable ? [] : ["PowerShell not found; Windows scheduled task service management is unavailable"],
        files: [],
        commands: [],
    };
}

function unsupportedServicePlan(normalized: NormalizedBrokerOptions): ServicePlan {
    const platform = normalized.platform;
    return {
        supported: false,
        platform,
        manager: "unsupported",
        serviceName: serviceNameForPlatform(platform),
        definitionPath: null,
        command: serviceCommand(normalized),
        diagnostics: [`unsupported host platform for broker service management: ${platform}`],
        files: [],
        commands: [],
    };
}

function deviceBrokerServicePlan(normalized: NormalizedBrokerOptions): ServicePlan {
    if (normalized.platform === "darwin") return macosServicePlan(normalized);
    if (normalized.platform === "win32") return windowsServicePlan(normalized);
    if (normalized.platform === "linux") return linuxServicePlan(normalized);
    return unsupportedServicePlan(normalized);
}

function serviceCommandsFor(action: ServiceAction, plan: ServicePlan, normalized: NormalizedBrokerOptions): ProviderCommand[] {
    if (!plan.supported) return [];
    if (plan.platform === "linux") {
        const executable = providerExecutable("systemctl", normalized);
        return [
            serviceProviderCommand("systemctl", executable, ["--user", "is-active", plan.serviceName]),
            serviceProviderCommand("systemctl", executable, ["--user", "is-enabled", plan.serviceName]),
        ];
    }
    if (plan.platform === "darwin") {
        const executable = providerExecutable("launchctl", normalized);
        const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
        const target = `${domain}/${plan.serviceName}`;
        void action;
        return [serviceProviderCommand("launchctl", executable, ["print", target])];
    }
    if (plan.platform === "win32") {
        const executable = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
        const task = psQuote(plan.serviceName);
        void action;
        return [serviceProviderCommand("powershell", executable, hiddenWindowsPowerShellArgs(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Get-ScheduledTask -TaskName ${task} | Select-Object TaskName,State | ConvertTo-Json -Compress`]))];
    }
    return [];
}

export function deviceBrokerService(action: string = "status", options: DeviceBrokerOptions & { dryRun?: boolean } = {}) {
    const normalized = normalizeBrokerOptions(options);
    const ownerId = options.ownerId || deviceBrokerOwnerId(normalized.cwd, options.profile);
    const observation = observeBrokerService(ownerId, action, { normalized, options });
    if (observation.kind === "invalid-action") return { ok: false, error: "invalid-service-action", action: observation.action, allowed: observation.allowed };
    if (observation.kind === "unsupported") {
        const value = observation.value;
        return { ok: false, ownerId: value.ownerId, action: value.action, dryRun: value.dryRun,
            service: value.service, serviceOwner: value.serviceOwner, ownedByCurrentOwner: value.ownedByCurrentOwner,
            installed: value.installed, running: value.running, results: value.results, changed: value.changed,
            error: "service-manager-unsupported", diagnostics: value.diagnostics };
    }
    if (observation.kind === "dry-run") {
        const value = observation.value;
        return { ok: true, ownerId: value.ownerId, action: value.action, dryRun: value.dryRun,
            service: value.service, serviceOwner: value.serviceOwner, ownedByCurrentOwner: value.ownedByCurrentOwner,
            installed: value.installed, running: value.running, results: value.results, changed: value.changed,
            diagnostics: value.diagnostics };
    }
    const value = observation.value;
    return { ok: true, ownerId: value.ownerId, action: value.action, dryRun: value.dryRun,
        service: value.service, serviceOwner: value.serviceOwner, ownedByCurrentOwner: value.ownedByCurrentOwner,
        installed: value.installed, installedBefore: value.installedBefore, running: value.running,
        results: value.results, changed: value.changed, diagnostics: value.diagnostics };
}

const observeBrokerService = createBrokerService({
    plan: (context: { normalized: NormalizedBrokerOptions; options: DeviceBrokerOptions & { dryRun?: boolean } }) => deviceBrokerServicePlan(context.normalized),
    commands: (action: ServiceAction, plan: ServicePlan, context) => serviceCommandsFor(action, plan, context.normalized),
    dryRun: context => context.options.dryRun === true,
    owner: () => readServiceOwner(),
    installed: plan => existsSync(plan.definitionPath!),
    query: (context, command: ProviderCommand) => context.normalized.commandRunner(command, { timeoutMs: context.normalized.commandTimeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT }),
    succeeded: result => commandSucceeded(result),
    projection: (plan, commands) => ({ ...plan, commands }),
    diagnostics: plan => plan.diagnostics,
}, DEVICE_BROKER_SERVICE_ACTIONS);

const BROKER_ERROR_SUMMARY_KEYS = ["ok", "error", "code", "ownerId", "method", "backend", "deviceId", "tool", "status"];

function truncateBrokerDiagnostic(value: unknown, limitBytes = 4096): string {
    const text = String(value ?? "");
    if (Buffer.byteLength(text, "utf8") <= limitBytes) return text;
    const suffix = "\n...[truncated]";
    const prefixBudget = Math.max(0, limitBytes - Buffer.byteLength(suffix));
    let prefix = Buffer.from(text, "utf8").subarray(0, prefixBudget).toString("utf8");
    while (prefix && Buffer.byteLength(prefix, "utf8") > prefixBudget) prefix = prefix.slice(0, -1);
    return `${prefix}${suffix}`;
}

export function boundedBrokerErrorPayload(status: number, body: unknown): unknown {
    if (status < 400) return body;
    let originalBytes: number;
    try {
        originalBytes = Buffer.byteLength(JSON.stringify(body, null, 2), "utf8");
    } catch (error) {
        return {
            ok: false,
            error: "broker-response-serialization-failed",
            detail: truncateBrokerDiagnostic(error instanceof Error ? error.message : String(error)),
        };
    }
    if (originalBytes <= DEVICE_BROKER_ERROR_RESPONSE_LIMIT) return body;
    const source = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const summary: Record<string, unknown> = {};
    for (const key of BROKER_ERROR_SUMMARY_KEYS) {
        const value = source[key];
        if (value === null || typeof value === "boolean" || typeof value === "number") summary[key] = value;
        else if (typeof value === "string") summary[key] = truncateBrokerDiagnostic(value);
    }
    if (summary.ok === undefined) summary.ok = false;
    if (typeof summary.error !== "string") summary.error = "broker-error-response-too-large";
    return {
        ...summary,
        diagnosticTruncated: true,
        originalBytes,
        maxBytes: DEVICE_BROKER_ERROR_RESPONSE_LIMIT,
    };
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    let responseStatus = status;
    let responseBody = boundedBrokerErrorPayload(status, body);
    let payload: string;
    try {
        payload = JSON.stringify(responseBody, null, 2);
    } catch (error) {
        responseStatus = 500;
        responseBody = {
            ok: false,
            error: "broker-response-serialization-failed",
            detail: truncateBrokerDiagnostic(error instanceof Error ? error.message : String(error)),
        };
        payload = JSON.stringify(responseBody, null, 2);
    }
    res.writeHead(responseStatus, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        ...headers,
    });
    res.end(payload);
}

function readRequestJson(req: IncomingMessage, limit = DEVICE_BROKER_RPC_BODY_LIMIT, timeoutMs = DEVICE_BROKER_REQUEST_BODY_TIMEOUT_MS): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let resolved = false;
        const timer = setTimeout(() => {
            req.pause();
            finish({ ok: false, status: 408, error: "request-body-timeout" });
        }, timeoutMs);

        function finish(result: { ok: true; body: unknown } | { ok: false; status: number; error: string }) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve(result);
        }

        req.on("data", (chunk: Buffer) => {
            if (resolved) return;
            total += chunk.length;
            if (total > limit) {
                finish({ ok: false, status: 413, error: "request-too-large" });
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (resolved) return;
            try {
                const text = Buffer.concat(chunks).toString("utf8");
                finish({ ok: true, body: text ? JSON.parse(text) : {} });
            } catch {
                finish({ ok: false, status: 400, error: "invalid-json" });
            }
        });
        req.on("error", () => finish({ ok: false, status: 400, error: "request-read-failed" }));
    });
}

function ownerInventory(ownerId: string, redactSecrets = false) {
    return observeOwnerInventory(ownerId, redactSecrets);
}

const observeOwnerInventory = createOwnerInventory({
    root: () => brokerRoot(),
    file: (root, ownerId, stateKey) => join(root, "owners", ownerId, stateKey, "devices.json"),
    exists: file => existsSync(file),
    stat: file => statSync(file),
    read: (file, maxBytes) => readOwnerDeviceStateFile(file, maxBytes),
    redact: redactBrokerDeviceSecrets,
    errorCode: error => ownerDeviceStateErrorCode(error),
    ownerRoot: (root, ownerId) => join(root, "owners", ownerId),
}, { stateKeys: DEVICE_BROKER_BACKEND_STATE_KEYS, maxBytes: DEVICE_BROKER_INVENTORY_FILE_LIMIT, maxDevices: DEVICE_BROKER_INVENTORY_DEVICE_LIMIT });

async function hostBackends(ownerId: string, normalized: NormalizedBrokerOptions) {
    const discover = createHostBackendDiscovery({
        executable: name => providerExecutable(name, normalized),
        hostId: hostname,
        async hyperVReadiness(powershell, timeoutMs) {
            const result = await hyperVProviderCommandRunner(normalized, hyperVReadinessCommand(powershell), {
                timeoutMs,
                outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
            });
            return commandSucceeded(result) ? parseHyperVReadiness(result.stdout || "") : null;
        },
        ubuntuImageCache: owner => inspectHyperVUbuntuImageCache(brokerPrivateRoot(), owner),
    }, {
        macosProviders: DEVICE_BROKER_MACOS_PROVIDER_NAMES,
        capabilities: {
            androidEmulator: ANDROID_EMULATOR_CAPABILITIES,
            androidDevice: ANDROID_REAL_CAPABILITIES,
            iosSimulator: IOS_SIMULATOR_CAPABILITIES,
            iosDevice: IOS_REAL_CAPABILITIES,
            windowsSandbox: DESKTOP_DEVICE_CAPABILITIES,
            windowsVm: HYPER_V_VM_CAPABILITIES,
            linuxVm: HYPER_V_LINUX_VM_CAPABILITIES,
            macosVm: MACOS_VM_CAPABILITIES,
        },
    });
    return discover({ ownerId, platform: normalized.platform, commandTimeoutMs: normalized.commandTimeoutMs });
}

function backendForStateKey(stateKey: string): string | null {
    return typeof DEVICE_BROKER_STATE_BACKENDS.get(stateKey) === "string" ? DEVICE_BROKER_STATE_BACKENDS.get(stateKey) as string : null;
}

function validateDeviceToolParams(params: unknown): DeviceToolParamError | DeviceToolParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-device-tool-params", supported: [...DEVICE_BROKER_TOOL_METHODS] };
    }
    const record = params as Record<string, unknown>;
    const tool = typeof record.tool === "string" ? record.tool : "";
    if (!tool) return { ok: false, status: 400, error: "missing-device-tool", supported: [...DEVICE_BROKER_TOOL_METHODS] };
    if (!DEVICE_BROKER_TOOL_METHODS.has(tool)) {
        return { ok: false, status: 501, error: "broker-device-tool-not-supported", supported: [...DEVICE_BROKER_TOOL_METHODS] };
    }
    if (tool === "device_exec") {
        const error = iosExecInputError(record);
        if (error) return { ok: false, status: 400, error: "device-exec-input-invalid", detail: error };
    }
    const backend = typeof record.backend === "string" && record.backend ? record.backend : null;
    const stateKey = backend ? DEVICE_BROKER_COMMAND_BACKENDS.get(backend) : null;
    if (backend && !stateKey) {
        return { ok: false, status: 400, error: "invalid-device-tool-backend", allowed: [...DEVICE_BROKER_COMMAND_BACKENDS.keys()] };
    }
    const deviceId = typeof record.deviceId === "string" && record.deviceId ? record.deviceId : null;
    if (deviceId && (deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId))) {
        return { ok: false, status: 400, error: "invalid-device-id" };
    }
    if ((tool === "device_record_video_status" || tool === "device_record_video_start" || tool === "device_record_video_stop" || DEVICE_BROKER_BACKEND_TOOL_METHODS.has(tool))
        && !DEVICE_BROKER_UNATTACHED_TOOL_METHODS.has(tool)
        && !deviceId) {
        return { ok: false, status: 400, error: "missing-device-id" };
    }
    if (tool === "device_drag" && (["x1", "y1", "x2", "y2"].some(key => !Number.isSafeInteger(record[key]) || Number(record[key]) < 0)
        || (record.durationMs !== undefined && (!Number.isSafeInteger(record.durationMs) || Number(record.durationMs) < 1 || Number(record.durationMs) > 10000)))) {
        return { ok: false, status: 400, error: "device-drag-invalid" };
    }
    if (tool === "device_focus_window" && (typeof record.handle !== "string" || !(
        (/^[1-9][0-9]{0,15}$/.test(record.handle) && Number.isSafeInteger(Number(record.handle)))
        || (record.handle.length <= 2048 && /^macos:[1-9][0-9]{0,9}:[1-9][0-9]{0,15}:[^\r\n]+$/.test(record.handle))
    ))) {
        return { ok: false, status: 400, error: "window-handle-invalid" };
    }
    const remotePath = typeof record.remotePath === "string" && record.remotePath ? record.remotePath : null;
    const localPath = typeof record.localPath === "string" && record.localPath ? record.localPath : null;
    if (tool === "device_record_video_start" && record.timeLimitSec !== undefined
        && (typeof record.timeLimitSec !== "number" || !Number.isInteger(record.timeLimitSec) || record.timeLimitSec < 1 || record.timeLimitSec > 1800)) {
        return { ok: false, status: 400, error: "recording-time-limit-invalid" };
    }
    const timeLimitSec = typeof record.timeLimitSec === "number" ? record.timeLimitSec : null;
    return { ok: true, tool, backend, stateKey: stateKey || null, deviceId, remotePath, localPath, timeLimitSec, params: record };
}

function invokeDeviceInventory(ownerId: string, parsed: DeviceToolParamSuccess, normalized: NormalizedBrokerOptions) {
    const result = observeFocusedInventory(ownerId, parsed, normalized);
    return { status: 200, payload: { ok: true, result: { ...result, source: "host-broker-owner-state", startsDevices: false } } };
}

const observeFocusedInventory = createFocusedInventory<unknown, NormalizedBrokerOptions, ReturnType<typeof androidHostDeviceInventory>, NonNullable<ReturnType<typeof androidCreationChoices>>>({
    inventory: ownerId => ownerInventory(ownerId),
    androidHost: normalized => androidHostDeviceInventory(normalized),
    androidChoices: normalized => androidCreationChoices({
        avdmanager: findAndroidTool("avdmanager", normalized),
        emulator: findAndroidTool("emulator", normalized),
        adb: findAndroidTool("adb", normalized),
    }, androidSdkCandidates(), (executable: string, args: string[], options: { timeout: number; maxBuffer: number }) => normalized.commandRunner({
        mode: "exec", provider: "avdmanager", executable, args,
    }, { timeoutMs: options.timeout, outputLimit: options.maxBuffer })),
    backend: entry => backendForStateKey(entry.stateKey),
});

type DeviceToolMatch = { stateKey: string; backend: string | null; device: Record<string, unknown> };

function findOwnerDeviceForTool(ownerId: string, parsed: { stateKey: string | null; deviceId: string | null; backend: string | null }): DeviceToolMatch | BrokerRpcResult {
    const stateKeys = parsed.stateKey ? [parsed.stateKey] : DEVICE_BROKER_BACKEND_STATE_KEYS;
    const matches: DeviceToolMatch[] = [];
    for (const stateKey of stateKeys) {
        const devices = readOwnerDevices(ownerId, stateKey);
        const found = devices.find((device) => device && typeof device === "object" && (device as Record<string, unknown>).id === parsed.deviceId);
        if (found && typeof found === "object") matches.push({ stateKey, backend: backendForStateKey(stateKey), device: found as Record<string, unknown> });
    }
    if (matches.length === 0) {
        return { status: 404, payload: { ok: false, error: "owner-device-not-found", deviceId: parsed.deviceId, backend: parsed.backend } };
    }
    if (matches.length > 1) {
        return { status: 409, payload: { ok: false, error: "ambiguous-device-backend", deviceId: parsed.deviceId, matches: matches.map((match) => match.backend) } };
    }
    return matches[0];
}

function recordingNativeTarget(ownerId: string, request: BrokerRecordingRequest): BrokerRecordingTarget | BrokerRecordingRefusal {
    const keys = request.stateKey ? [request.stateKey] : DEVICE_BROKER_BACKEND_STATE_KEYS;
    const matches: BrokerRecordingTarget[] = [];
    for (const stateKey of keys) {
        const found = readOwnerDevices(ownerId, stateKey).find(device => cleanupRecord(device) && device.id === request.deviceId);
        if (cleanupRecord(found))
            matches.push({ stateKey, backend: backendForStateKey(stateKey), device: found });
    }
    if (!matches.length)
        return { kind: "refused", reason: "missing", error: "owner-device-not-found", deviceId: request.deviceId, backend: request.backend };
    if (matches.length > 1)
        return { kind: "refused", reason: "conflict", error: "ambiguous-device-backend", deviceId: request.deviceId, matches: matches.map(match => match.backend) };
    return matches[0];
}

function recordingExpectedProcessIdentityValid(identity: unknown, pid: unknown): boolean {
    return cleanupRecord(identity) && typeof pid === "number" && Number.isInteger(pid) && pid > 0 && identity.pid === pid
        && typeof identity.startToken === "string" && identity.startToken.length > 0
        && typeof identity.commandHash === "string" && /^[a-f0-9]{64}$/i.test(identity.commandHash);
}

function observeBrokerRecordingProcess(identity: unknown, pid: number): {status: "match" | "mismatch" | "exited" | "unavailable"} {
    return recordingExpectedProcessIdentityValid(identity, pid)
        ? inspectDeviceRuntimeProcessIdentity(identity, pid) : {status: "unavailable"};
}

function brokerRecordingApplication(normalized: NormalizedBrokerOptions) {
    const observed = (receipt: ProviderCommandResult) => ({
        ok: commandSucceeded(receipt),
        refusal: ["recording-runtime-state-conflict", "physical-device-not-attached", "recording-process-identity-unavailable", "recording-process-not-broker-owned"].includes(receipt.error || "")
            ? "guard-refused" as const : null,
        pid: receipt.pid, processIdentity: receipt.processIdentity, receipt: new NativeBrokerExecutionReceipt(receipt),
    });
    const launch = async (command: ProviderCommand, label: string) => observed(normalized.usesDefaultCommandRunner
        ? await startDetachedProviderCommand(command, normalized, label)
        : normalized.commandRunner(command, { timeoutMs: normalized.commandTimeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT }));
    const adbEffect = (serial: string, args: string[]) => observed(normalized.commandRunner({ mode: "exec", provider: "adb", executable: executableFor("adb", normalized), args: ["-s", serial, ...args] }, { timeoutMs: normalized.commandTimeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT }));
    const recordingEffect = <T>(context: BrokerRecordingArtifactContext, refuse: (error: string) => T, effect: () => T): T => {
        const {ownerId, target, recording} = context;
        if (recording.authority !== "host-broker" || recording.processOwner !== "host-broker" || recording.startedBy !== "broker.device.recording.start")
            return refuse("recording-process-not-broker-owned");
        if (!recordingExpectedProcessIdentityValid(recording.processIdentity, recording.pid)) return refuse("recording-process-identity-unavailable");
        const deviceId = String(target.device.id);
        const run = () => {
            if (target.stateKey === "android-device" && !physicalDeviceLeaseMatches(ownerId, target.stateKey, deviceId, target.device))
                return refuse("physical-device-not-attached");
            const current = withSharedMutationLock(ownerDevicesMutationLockFile(ownerId, target.stateKey), () =>
                readOwnerDevices(ownerId, target.stateKey).find(candidate => cleanupRecord(candidate) && candidate.id === deviceId));
            if (!cleanupRecord(current) || !recordingRuntimeMatches(recording, current.recording)
                || !cleanupRecord(current.recording) || !isDeepStrictEqual(recording.processIdentity, current.recording.processIdentity)
                || !recordingTargetMatches(target, current))
                return refuse("recording-runtime-state-conflict");
            return effect();
        };
        if (target.stateKey !== "android-device") return run();
        const serial = recordingSerial(target.device);
        return serial ? withSharedMutationLock(physicalLeaseMutationLockFile(target.stateKey, serial), run) : refuse("physical-device-not-attached");
    };
    const refusedAdb = (error: string) => observed({mode: "exec", provider: "adb", status: 1, error});
    const artifactEffect = (context: BrokerRecordingArtifactContext, serial: string, remote: string | null, effect: () => ReturnType<typeof adbEffect>) =>
        recordingEffect(context, refusedAdb, () => recordingSerial(context.target.device) === serial
            && (remote === null || context.recording.remotePath === remote) ? effect() : refusedAdb("recording-runtime-state-conflict"));
    return createBrokerRecordingApplication({
        findTarget: recordingNativeTarget,
        heartbeat: (owner, target, id) => {
            const admission = nativePhysicalAdmission(owner, target, id);
            return admission.kind === "admitted" ? null : { kind: "refused", reason: "conflict", error: "physical-device-not-attached", ownerId: owner, backend: target.backend, deviceId: id,
                ...(admission.failure ? { leaseError: admission.failure.error } : {}), remedy: "attach the physical device before using host-backed device tools" };
        },
        observeProcess: observeBrokerRecordingProcess, publish: transitionOwnerRecordingRuntime,
        resolveIosTarget: (owner, device) => resolveBrokerOwnedIosSimulatorTarget(owner, device, normalized), localPath: ownerRecordingLocalPath,
        prepareOutput: path => { mkdirSync(dirname(path), {recursive: true}); return undefined; },
        launchAndroidRecording: (serial, remote, limit, _local, label) => launch({ mode: "detached", provider: "adb", executable: executableFor("adb", normalized), args: ["-s", serial, "shell", "screenrecord", "--time-limit", String(limit), remote] }, label),
        launchIosRecording: (udid, local, label) => launch({ mode: "detached", provider: "xcrun", executable: executableFor("xcrun", normalized), args: ["simctl", "io", udid, "recordVideo", local] }, label),
        stopAndroidRecording: (context, serial) => artifactEffect(context, serial, null, () => {
            const observation = observeBrokerRecordingProcess(context.recording.processIdentity, Number(context.recording.pid));
            if (observation.status === "unavailable") return refusedAdb("recording-process-identity-unavailable");
            // A process-name command must never stop a successor after the captured host recorder ended.
            return observation.status === "match" ? adbEffect(serial, ["shell", "pkill", "-2", "screenrecord"])
                : observed({mode: "exec", provider: "adb", status: 0});
        }),
        pullAndroidRecording: (context, serial, remote, local) => artifactEffect(context, serial, remote, () =>
            context.recording.localPath === local ? adbEffect(serial, ["pull", remote, local]) : refusedAdb("recording-runtime-state-conflict")),
        removeAndroidRecording: (context, serial, remote) => artifactEffect(context, serial, remote, () => adbEffect(serial, ["shell", "rm", "-f", remote])),
        signal: (recording, signal, context) => {
            const refuse = (error: string) => ({attempted: false, ok: false, reason: error});
            const stop = () => {
                const observation = observeBrokerRecordingProcess(recording.processIdentity, Number(recording.pid));
                if (observation.status === "unavailable") return refuse("recording-process-identity-unavailable");
                return observation.status === "mismatch" || observation.status === "exited"
                    ? {attempted: false, ok: true, stale: true, reason: "recording-process-ended"}
                    : signalBrokerOwnedRecording(recording, normalized, signal);
            };
            const receipt = context ? recordingEffect<{attempted: boolean; ok: boolean; stale?: boolean}>(context, refuse, stop) : signalBrokerOwnedRecording(recording, normalized, signal);
            return {attempted: receipt.attempted, ok: receipt.ok, ...("stale" in receipt ? {stale: receipt.stale === true} : {}), receipt: new NativeRecordingSignalReceipt(receipt)};
        },
        waitForExit: (pid, timeout) => normalized.usesDefaultCommandRunner ? waitForProcessExit(pid, timeout) : Promise.resolve(true),
        timestamp: () => new Date().toISOString(), runtimeId: () => randomBytes(16).toString("hex"),
    });
}

function ownerRecordingDir(ownerId: string, stateKey: string, deviceId: string) {
    return join(brokerRoot(), "owners", ownerId, stateKey, deviceId, "recordings");
}

function ownerRecordingLocalPath(ownerId: string, stateKey: string, deviceId: string, extension: string) {
    return join(ownerRecordingDir(ownerId, stateKey, deviceId), `recording-${Date.now()}.${extension}`);
}

async function sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: unknown) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid: unknown, timeoutMs = DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS,
    exited: () => boolean = () => !processIsAlive(pid)) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
        if (exited()) return true;
        await sleep(50);
    }
    return exited();
}

async function startDetachedProviderCommand(command: ProviderCommand, normalized: NormalizedBrokerOptions, label: string, parentRemainingMs?: () => number): Promise<ProviderCommandResult> {
    const remainingMs = captureBrokerNativeRemainingMs(parentRemainingMs);
    if (command.mode !== "detached") {
        return normalized.commandRunner(command, {
            timeoutMs: normalized.commandTimeoutMs,
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        });
    }
    if (!command.executable) {
        return { mode: "detached", provider: command.provider, error: "missing-executable", status: null };
    }
    const executable = command.executable;
    if (!executableExists(executable)) {
        return { mode: "detached", provider: command.provider, executable, args: command.args || [], status: null, error: "executable-not-found" };
    }
    return await new Promise<ProviderCommandResult>((resolve) => {
        let settled = false;
        let child: ReturnType<typeof spawn> | null = null;
        let processIdentity: DeviceRuntimeProcessIdentity | null = null;
        let timer: NodeJS.Timeout | undefined;
        const done = (result: ProviderCommandResult) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (remainingMs && child && (result.error || result.status !== 0)) {
                result = {
                    ...result,
                    pid: child.pid,
                    ...(processIdentity ? { processIdentity } : {}),
                    cleanup: terminateBrokerSpawnedProcessTree(child.pid, { expectedIdentity: processIdentity, requireIdentity: true, remainingMs }),
                };
                child.unref();
            }
            resolve(result);
        };
        const expired = () => done({ mode: "detached", provider: command.provider, executable, args: command.args || [], status: null, timedOut: true, error: `${label} timed out before it was ready` });
        const earlyExit = () => {
            if (!child || (child.exitCode === null && child.signalCode === null)) return false;
            done({ mode: "detached", provider: command.provider, executable, args: command.args || [], pid: child.pid, status: child.exitCode, signal: child.signalCode, error: `${label} exited before it was ready: ${child.signalCode || `exit ${child.exitCode}`}` });
            return true;
        };
        const ready = () => {
            if (settled || !child) return;
            if (remainingMs && earlyExit()) return;
            if (!brokerProcessRemainingMs(remainingMs)) { expired(); return; }
            // Preserve completed identity evidence separately from timely launch authority.
            processIdentity = remainingMs
                ? inspectDeviceRuntimeProcessIdentity(null, child.pid, { remainingMs }).current
                : readDeviceRuntimeProcessIdentity(child.pid);
            if (remainingMs && earlyExit()) return;
            if (!brokerProcessRemainingMs(remainingMs)) { expired(); return; }
            if (!processIdentity) {
                if (!remainingMs) {
                    try { child.kill("SIGTERM"); } catch { /* already exited */ }
                }
                done({ mode: "detached", provider: command.provider, executable, args: command.args || [], pid: child.pid, status: null, error: `${label} process identity could not be established` });
                return;
            }
            child.unref();
            done({ mode: "detached", provider: command.provider, executable, args: command.args || [], pid: child.pid, processIdentity, status: 0 });
        };
        const settleMs = Math.min(DEVICE_BROKER_DETACHED_READY_MS, brokerProcessRemainingMs(remainingMs));
        if (!settleMs) { expired(); return; }
        timer = setTimeout(ready, settleMs);
        let launcherCleanupPath: string | undefined;
        try {
            const invocation = detachedProviderCommandSpawn(command);
            launcherCleanupPath = invocation.cleanupPath;
            const commandEnv = hiddenProviderCommandEnv(command.env);
            const spawnOptions = hiddenChildProcessOptions({
                detached: true,
                stdio: "ignore" as const,
                ...(commandEnv ? { env: { ...process.env, ...commandEnv } } : {}),
                ...(command.cwd ? { cwd: command.cwd } : {}),
            });
            if (!brokerProcessRemainingMs(remainingMs)) {
                removeWindowsLauncher(launcherCleanupPath);
                expired();
                return;
            }
            const spawned = spawn(invocation.executable || executable, invocation.args, spawnOptions);
            child = spawned;
            spawned.once("error", (error) => done({ mode: "detached", provider: command.provider, executable, args: command.args || [], status: null, error: `${label} failed to start: ${error.message}` }));
            spawned.once("exit", (code, signal) => done({ mode: "detached", provider: command.provider, executable, args: command.args || [], pid: spawned.pid, status: code, signal, error: `${label} exited before it was ready: ${signal || `exit ${code}`}` }));
            scheduleWindowsLauncherCleanup(launcherCleanupPath, spawned);
            if (!brokerProcessRemainingMs(remainingMs)) {
                // Node queues spawn errors before this handoff, while exitCode can still be null.
                process.nextTick(() => { if (!settled && !earlyExit()) expired(); });
            }
        } catch (error) {
            removeWindowsLauncher(launcherCleanupPath);
            done({ mode: "detached", provider: command.provider, executable, args: command.args || [], status: null, error: error instanceof Error ? error.message : String(error) });
        }
    });
}

function transitionOwnerRecordingRuntime(
    ownerId: string,
    stateKey: string,
    deviceId: string,
    expected: unknown,
    replacement: Record<string, unknown> | null,
    target: BrokerRecordingTarget,
) {
    return ownerRepository.transitionRecording(ownerId, stateKey, deviceId, expected, replacement, target);
}

function brokerDeviceToolSupportedMethods(backend: string | null): Set<string> {
    const recordingTools = ["device_record_video_status", "device_record_video_start", "device_record_video_stop"];
    if (isHyperVBackend(backend)) {
        return new Set(["device_exec", "device_upload", "device_download", "device_screenshot", "device_click", "device_double_click", "device_drag", "device_focus_window", "device_key", "device_type", "device_scroll", "device_cursor_position", "device_window_list", "device_snapshot_list", "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete"]);
    }
    if (backend === "macos-vm") {
        return new Set([...DEVICE_BROKER_DESKTOP_TOOL_METHODS, ...DEVICE_BROKER_DESKTOP_FILE_TOOL_METHODS, ...recordingTools,
            "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete"]);
    }
    if (backend === "windows-sandbox") {
        return new Set([...DEVICE_BROKER_DESKTOP_TOOL_METHODS, ...DEVICE_BROKER_DESKTOP_FILE_TOOL_METHODS, ...recordingTools]);
    }
    if (backend === "android-emulator") return new Set([...DEVICE_BROKER_ANDROID_TOOL_METHODS, ...recordingTools]);
    if (backend === "android-device") return new Set([...DEVICE_BROKER_ANDROID_DEVICE_TOOL_METHODS, ...recordingTools]);
    if (backend === "ios-simulator") return new Set([...DEVICE_BROKER_IOS_SIMULATOR_TOOL_METHODS, ...recordingTools]);
    if (backend === "ios-device") return new Set([...DEVICE_BROKER_IOS_DEVICE_TOOL_METHODS]);
    return new Set();
}

function brokerDeviceToolSupportedByBackend(backend: string | null, tool: string) {
    return brokerDeviceToolSupportedMethods(backend).has(tool);
}

export function deviceBrokerToolContractForTest() {
    const capabilities = new Map<string, string[]>([
        ["android-emulator", ANDROID_EMULATOR_CAPABILITIES],
        ["android-device", ANDROID_REAL_CAPABILITIES],
        ["ios-simulator", IOS_SIMULATOR_CAPABILITIES],
        ["ios-device", IOS_REAL_CAPABILITIES],
        ["windows-sandbox", DESKTOP_DEVICE_CAPABILITIES],
        ["windows-vm", HYPER_V_VM_CAPABILITIES],
        ["linux-vm", HYPER_V_LINUX_VM_CAPABILITIES],
        ["macos-vm", MACOS_VM_CAPABILITIES],
    ]);
    return {
        backends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS.map((backend) => ({
            backend,
            capabilities: [...(capabilities.get(backend) || [])],
            supportedTools: [...brokerDeviceToolSupportedMethods(backend)],
        })),
    };
}

function joinHostProjectPath(root: string, rel: string): string {
    const parts = rel.split("/").filter(Boolean);
    if (/^[A-Za-z]:[\\/]/.test(root)) return [root.replace(/[\\/]+$/, ""), ...parts].join("\\");
    return join(root, ...parts);
}

type BrokerHostPathTranslation = { ok: true; value: unknown } | { ok: false };

function translateContainerProjectPathForHost(value: unknown, normalized: NormalizedBrokerOptions): BrokerHostPathTranslation {
    if (typeof value !== "string") return { ok: true, value };
    const absolute = posix.isAbsolute(value) || win32.isAbsolute(value);
    if (!absolute) return { ok: true, value };
    const projectMount = deviceLabProjectMountPath(normalized.cwd);
    if (posix.isAbsolute(value) && (value === projectMount || value.startsWith(`${projectMount}/`))) {
        const rel = value.slice(projectMount.length).replace(/^\/+/, "");
        const parts = rel.split("/").filter(Boolean);
        if (parts.some((part) => part === "." || part === ".." || part.includes("\\"))) return { ok: false };
        return { ok: true, value: joinHostProjectPath(normalized.cwd, rel) };
    }
    if (isAbsolute(value) && pathWithin(normalized.cwd, value)) {
        return { ok: true, value: resolve(value) };
    }
    return { ok: false };
}

function translateDeviceToolPathsForHost(parsed: DeviceToolParamSuccess, normalized: NormalizedBrokerOptions): DeviceToolParamSuccess | BrokerRpcResult {
    const params = { ...parsed.params };
    for (const key of parsed.tool === "device_list_files" ? ["localPath"] : ["localPath", "path"]) {
        if (typeof params[key] === "string") {
            const translated = translateContainerProjectPathForHost(params[key], normalized);
            if (!translated.ok) {
                return {
                    status: 400,
                    payload: { ok: false, error: "device-tool-path-outside-project-mount", field: key },
                };
            }
            params[key] = translated.value;
        }
    }
    return {
        ...parsed,
        localPath: typeof params.localPath === "string" && params.localPath ? params.localPath : null,
        params,
    };
}



function hyperVJournalPersistenceRuntime(): HyperVJournalPersistenceRuntime {
    return {
        deviceRoot: hyperVDeviceRoot,
        ensurePrivateDeviceRoot: ensureHyperVPrivateDeviceRoot,
        readDevices: readOwnerDevices,
        journalLimitBytes: DEVICE_BROKER_HYPER_V_OPERATION_JOURNAL_LIMIT_BYTES,
    };
}

function hyperVSnapshotJournalPath(ownerId: string, backend: string, deviceId: string): string {
    return hyperVSnapshotJournalFilePath(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        backend,
        deviceId,
    );
}

function readHyperVSnapshotJournal(ownerId: string, backend: string, deviceId: string): HyperVSnapshotJournal | null {
    return readHyperVSnapshotJournalFile(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        backend,
        deviceId,
    );
}

function writeHyperVSnapshotJournal(ownerId: string, backend: string, deviceId: string, incarnationId: string, tool: HyperVSnapshotJournal["tool"], snapshotName: string, providerName: string, snapshotId?: string, expectedCheckpointPolicy?: "Production" | "ProductionOnly"): void {
    writeHyperVSnapshotJournalFile(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        backend,
        deviceId,
        incarnationId,
        tool,
        snapshotName,
        providerName,
        snapshotId,
        expectedCheckpointPolicy,
    );
}

function brokerHyperVSnapshotApplication(normalized: NormalizedBrokerOptions, parentDeadlineAt?: number) {
    let lastExecution: DeviceLabHyperVCommandResult | null = null;
    const now = normalized.hyperVMonotonicNow;
    function recording(executable: string, timeoutMilliseconds: number | (() => number)) {
        let dispatchDeadlineError: HyperVOperationDeadlineError | null = null;
        const effect = createRecordingDeviceLabHyperVWindowsClient({
            executable, now, timeoutMilliseconds: () => {
                try { return typeof timeoutMilliseconds === "function" ? timeoutMilliseconds() : timeoutMilliseconds; }
                catch (error) {
                    if (error instanceof HyperVOperationDeadlineError) dispatchDeadlineError = error;
                    throw error;
                }
            },
            run: (command, options) => hyperVProviderCommandRunner(normalized, command, options),
            ...(normalized.usesDefaultCommandRunner ? { session: brokerHyperVWindowsSession(executable) } : {}),
        });
        return { ...effect, dispatchDeadlineError: () => dispatchDeadlineError };
    }
    const clearJournal: BrokerHyperVSnapshotPorts<NativeHyperVConnection, DeviceLabHyperVCommandResult>["clearJournal"] = (ownerId, backend, deviceId, expectedDevice, expectedJournal, beforeClear) =>
        ownerRepository.withSnapshotRepairTarget(ownerId, backend, deviceId, expectedDevice, () => {
            let currentJournal: HyperVSnapshotJournal | null;
            try { currentJournal = readHyperVSnapshotJournal(ownerId, backend, deviceId); }
            catch { return false; }
            if (!isDeepStrictEqual(currentJournal, expectedJournal)) return false;
            beforeClear();
            clearHyperVSnapshotJournal(hyperVJournalPersistenceRuntime(), ownerId, backend, deviceId);
            return true;
        });
    const ports: BrokerHyperVSnapshotPorts<NativeHyperVConnection, DeviceLabHyperVCommandResult> = {
        connection: provider => nativeHyperVConnection(normalized, provider),
        incarnation: hyperVDeviceIncarnationId,
        validIncarnation: validHyperVIncarnationId,
        providerName: hyperVSnapshotName,
        ownershipNotes: ownershipMarker,
        journalExists: (ownerId, backend, deviceId) => existsSync(hyperVSnapshotJournalPath(ownerId, backend, deviceId)),
        readJournal: readHyperVSnapshotJournal,
        writeJournal: (...args) => {
            writeHyperVSnapshotJournal(...args);
            const journal = readHyperVSnapshotJournal(args[0], args[1], args[2]);
            if (!journal) throw new Error("hyper-v-snapshot-journal-write-failed");
            return journal;
        },
        recordCreatedId: (ownerId, backend, deviceId, expectedDevice, expectedJournal, snapshotId) => {
            let recorded: HyperVSnapshotJournal | null = null;
            const target = ownerRepository.withSnapshotRepairTarget(ownerId, backend, deviceId, expectedDevice, () => {
                let currentJournal: HyperVSnapshotJournal | null;
                try { currentJournal = readHyperVSnapshotJournal(ownerId, backend, deviceId); }
                catch { return false; }
                if (!isDeepStrictEqual(currentJournal, expectedJournal)) return false;
                recordHyperVSnapshotCreatedId(hyperVJournalPersistenceRuntime(), ownerId, backend, deviceId,
                    expectedJournal.incarnationId, expectedJournal.providerName, snapshotId);
                recorded = readHyperVSnapshotJournal(ownerId, backend, deviceId);
                return recorded !== null;
            });
            return target.matched ? recorded : null;
        },
        clearJournal,
        removeRepairJournal: clearJournal,
        status: async (connection, identity, deadlineAt, timeoutMs) => {
            const parent = parentDeadlineAt ?? deadlineAt;
            hyperVRemainingTimeout(parent, timeoutMs, now);
            const receipt = await hyperVTypedStatusExecution(normalized, {executable: connection.executable, ...identity}, deadlineAt, timeoutMs, true, now, parent);
            const ok = commandSucceeded(receipt);
            if (ok) hyperVRemainingTimeout(parent, timeoutMs, now);
            return { execution: { ok, receipt }, observation: ok ? parseHyperVVmObservation(receipt.stdout || "") : null };
        },
        observationMismatch: hyperVSnapshotObservationMismatch,
        create: async (connection, target, options) => {
            const confirmationTimeoutMilliseconds = 10000;
            let confirmationDeadlineAt: number | undefined;
            const effect = recording(connection.executable, () => {
                const operationTimeout = options.timeoutMilliseconds();
                return confirmationDeadlineAt === undefined ? operationTimeout
                    : Math.min(operationTimeout, hyperVRemainingTimeout(confirmationDeadlineAt, confirmationTimeoutMilliseconds, now));
            });
            try { return await createDeviceLabHyperVSnapshot(effect.client, target, {
                ...options,
                confirmationTimeoutMilliseconds,
                onCreatedId: snapshotId => {
                    options.onCreatedId(snapshotId);
                    confirmationDeadlineAt = now() + Math.min(confirmationTimeoutMilliseconds, options.remainingMilliseconds());
                },
            }); }
            catch (error) { throw effect.dispatchDeadlineError() ?? error; }
            finally { lastExecution = effect.lastExecution(); }
        },
        restore: async (connection, target, options) => {
            const effect = recording(connection.executable, () => hyperVRemainingTimeout(options.deadlineAt, 120000, now));
            try { return await restoreDeviceLabHyperVSnapshot(effect.client, target, options); }
            catch (error) { throw effect.dispatchDeadlineError() ?? error; }
            finally { lastExecution = effect.lastExecution(); }
        },
        delete: async (connection, target, deadlineAt) => {
            const effect = recording(connection.executable, () => hyperVRemainingTimeout(deadlineAt, 120000, now));
            try { return await deleteDeviceLabHyperVSnapshot(effect.client, target); }
            catch (error) { throw effect.dispatchDeadlineError() ?? error; }
            finally { lastExecution = effect.lastExecution(); }
        },
        repairPolicy: async (connection, target, deadlineAt) => {
            const effect = recording(connection.executable, deadlineAt === undefined ? 30000 : () => hyperVRemainingTimeout(deadlineAt, 30000, now));
            try { return await repairDeviceLabHyperVSnapshotState(effect.client, target); }
            catch (error) { throw effect.dispatchDeadlineError() ?? error; }
            finally { lastExecution = effect.lastExecution(); }
        },
        lastExecution: () => lastExecution ? { ok: lastExecution.status === 0 && !lastExecution.error, receipt: lastExecution } : null,
        providerErrorKind: error => error instanceof HyperVWindowsError
            ? error.category === "validation" ? "validation"
                : error.category === "protocol" || error.category === "transport" ? "untrusted-response" : null
            : null,
        isDeadlineError: error => error instanceof HyperVOperationDeadlineError,
        providerErrorCode: error => error instanceof HyperVWindowsError ? error.code : undefined,
        errorCode: hyperVBoundedErrorCode,
        diagnosticCode: (execution, fallback, providerErrorCode) => hyperVProviderDiagnosticCode({
            error: providerErrorCode ?? execution?.receipt?.error,
            stdout: execution?.receipt?.stdout,
            stderr: execution?.receipt?.stderr,
        }, fallback),
        publish: transitionHyperVSnapshotState,
        mergeRepair: (ownerId, backend, deviceId, original, patch, beforePublish) => ownerRepository.mergeSnapshotRepair(ownerId, backend, deviceId, original, patch, beforePublish),
        forgetConsole: (ownerId, backend, deviceId) => { forgetHyperVConsoleFrame(hyperVConsoleFrameKey(ownerId, backend, deviceId)); return undefined; },
        sshReady: async (connection, target, deadlineAt) => {
            const timeoutMs = hyperVRemainingTimeout(deadlineAt, 20000, now);
            const receipt = await hyperVProviderCommandRunner(normalized, hyperVLinuxSshReadyCommand({
                executable: connection.executable, ...target, timeoutMs: Math.min(15000, timeoutMs),
            }), { timeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
            const observation = deviceLabHyperVLinuxReadinessObservation(receipt);
            return { ready: observation.ready, execution: { ok: observation.ok, receipt } };
        },
        remainingTimeout: (deadlineAt, maximumMs) => hyperVRemainingTimeout(deadlineAt, maximumMs, now),
        now,
        timestamp: () => new Date().toISOString(),
        sleep,
    };
    return createBrokerHyperVSnapshotApplication(ports);
}

function observeHyperVSnapshotJournal(ownerId: string, backend: string, deviceId: string, device: Record<string, unknown>, powershell: string, normalized: NormalizedBrokerOptions, retryRestoreSnapshotId?: string, parentDeadlineAt?: number) {
    return brokerHyperVSnapshotApplication(normalized, parentDeadlineAt).repair(ownerId, { backend, deviceId, device, connection: {executable: powershell} }, retryRestoreSnapshotId, parentDeadlineAt);
}

function reconcileHyperVSnapshotJournal(ownerId: string, backend: string, deviceId: string, device: Record<string, unknown>, powershell: string, normalized: NormalizedBrokerOptions, retryRestoreSnapshotId?: string) {
    return observeHyperVSnapshotJournal(ownerId, backend, deviceId, device, powershell, normalized, retryRestoreSnapshotId).then(renderHyperVSnapshotRepair);
}



function transitionHyperVSnapshotState(ownerId: string, backend: string, deviceId: string, expected: Record<string, unknown>, replacement: Record<string, unknown>, beforePublish?: () => undefined) {
    return ownerRepository.transitionSnapshot(ownerId, backend, deviceId, expected, replacement, beforePublish);
}



type HyperVDesktopStage = { path: string };
type HyperVGuestConnection = { executable: string };
function brokerHyperVDesktopTransferApplication(normalized: NormalizedBrokerOptions) {
    const ports: HyperVDesktopTransferPorts<ReturnType<typeof createDeviceLabHyperVWindowsClient>, HyperVDesktopStage, Buffer, HyperVGuestConnection> = {
        executable: name => providerExecutable(name, normalized),
        incarnation: hyperVDeviceIncarnationId,
        validIncarnation: validHyperVIncarnationId,
        pendingJournal: (ownerId, stateKey, deviceId) => existsSync(hyperVSnapshotJournalPath(ownerId, stateKey, deviceId)),
        repair: async (ownerId, stateKey, deviceId, device, powershell) => {
            const repaired = await reconcileHyperVSnapshotJournal(ownerId, stateKey, deviceId, device, powershell, normalized);
            if (repaired.ok) return repaired;
            return { ok: false, category: repaired.status === 409 ? 'conflict' : 'provider-failed', error: repaired.error, ...(repaired.detail ? { detail: repaired.detail } : {}) };
        },
        ownershipNotes: ownershipMarker,
        createConsole: executable => createDeviceLabHyperVWindowsClient({
            executable,
            timeoutMilliseconds: 30000,
            run: (command, options) => hyperVProviderCommandRunner(normalized, command, options),
            ...(normalized.usesDefaultCommandRunner ? { session: brokerHyperVWindowsSession(executable) } : {}),
        }),
        withConsoleLock: (ownerId, backend, deviceId, operation) => withHyperVConsoleLock(hyperVConsoleFrameKey(ownerId, backend, deviceId), operation),
        capture: (client, identity) => client.captureVMConsole(identity),
        cursor: (client, identity) => client.getVMConsoleCursor(identity),
        vms: (client, id) => client.getVM({ kind: "id", id }),
        input: (client, input) => client.sendVMConsoleInput(input),
        frame: (ownerId, backend, deviceId, incarnationId) => currentHyperVConsoleFrame(hyperVConsoleFrameKey(ownerId, backend, deviceId), incarnationId),
        rememberFrame: (ownerId, backend, deviceId, frame) => { rememberHyperVConsoleFrame(hyperVConsoleFrameKey(ownerId, backend, deviceId), frame); },
        timestamp: () => new Date().toISOString(),
        roots: (ownerId, backend, deviceId) => {
            const deviceRoot = hyperVDeviceRoot(ownerId, backend, deviceId);
            const privateRoot = hyperVPrivateDeviceRoot(ownerId, backend, deviceId);
            return {
                deviceRoot, privateRoot,
                credentialPath: join(privateRoot, "secrets", "guest.credential.xml"),
                sshPrivateKeyPath: join(privateRoot, "secrets", "id_ed25519"),
                sshHostPublicKeyPath: join(privateRoot, "secrets", "ssh_host_ed25519_key.pub"),
                knownHostsPath: join(privateRoot, "secrets", "known_hosts"),
            };
        },
        assertPrivateRoot: (ownerId, backend, deviceId, privateRoot) => { assertHyperVPrivateDeviceRoot(ownerId, backend, deviceId, privateRoot); },
        readableSecret: (path, label) => Boolean(withDeviceLabReadableFile(path, label, 64 * 1024, () => true)),
        sshIdentity: validateHyperVLinuxSshHostIdentity,
        localPath: (raw, label) => {
            const path = isAbsolute(raw) ? resolve(raw) : resolve(normalized.cwd, raw);
            assertDeviceLabPathWithinRoot(normalized.cwd, path, label);
            return path;
        },
        readSource: (path, label, maxBytes) => readDeviceLabBinaryFileWithinRoot(normalized.cwd, path, label, maxBytes),
        allocateStage: (privateRoot, direction, label) => {
            const stagingRoot = join(privateRoot, direction === "upload" ? "transfers" : "downloads");
            mkdirSync(stagingRoot, { recursive: true });
            assertNoSymlinkPathComponents(stagingRoot, label);
            const path = join(stagingRoot, `${direction}-${randomBytes(16).toString("hex")}.tmp`);
            return { handle: { path }, path };
        },
        writeStage: (privateRoot, stage, bytes, label) => { writeDeviceLabBinaryFile(privateRoot, stage.path, bytes, label, { allowNestedCreate: true }); },
        readStage: (stage, maxBytes) => readDeviceLabBinaryFile(stage.path, "hyper-v-guest-download-staging", maxBytes),
        disposeStage: stage => { rmSync(stage.path, { force: true }); },
        writeDestination: (path, bytes, label) => { writeDeviceLabBinaryFile(normalized.cwd, path, bytes, label); },
        guestConnection: operation => {
            const executable = operation === 'upload'
                ? providerExecutable('scp.exe', normalized) || providerExecutable('scp', normalized)
                : providerExecutable('ssh.exe', normalized) || providerExecutable('ssh', normalized);
            return executable ? { executable } : null;
        },
        prepareGuestExec: (facts, connection, intent) => {
            const guestCommand = desktopGuestCommand("linux-vm", intent);
            const command = hyperVLinuxSshExecCommand({ ...facts, executable: connection.executable, guestCommand });
            return async budget => observeDesktopExecution(await hyperVProviderCommandRunner(normalized, command, budget), "exec", intent);
        },
        prepareUpload: (facts, connection, localPath, remotePath) => {
            const command = hyperVLinuxScpUploadCommand({ ...facts, executable: connection.executable, localPath, remotePath });
            return async budget => observeDesktopExecution(await hyperVProviderCommandRunner(normalized, command, budget), "upload");
        },
        prepareRemoteRead: (facts, connection, remotePath, maxBytes) => {
            const guestCommand = desktopRemoteReadCommand(remotePath, maxBytes);
            const command = hyperVLinuxSshExecCommand({ ...facts, executable: connection.executable, guestCommand });
            return async budget => observeDesktopExecution(await hyperVProviderCommandRunner(normalized, command, { ...budget, outputLimit: desktopRemoteReadOutputLimit(maxBytes) }), "download");
        },
        direct: async (executable, timeoutMs, identity, action, intent) => {
            try {
                const nativeAction = action.action === "exec" && intent
                    ? { ...action, command: desktopGuestCommand("windows-vm", intent) }
                    : action;
                const result = await invokeDeviceLabHyperVGuestDirect({ executable, timeoutMilliseconds: timeoutMs, run: (command, options) => hyperVProviderCommandRunner(normalized, command, options), identity, action: nativeAction });
                return observeDesktopDirect(result, nativeAction, intent);
            } catch (error) {
                return observeDesktopDirectFailure(error instanceof HyperVWindowsError ? error.code : "guest-executor-failed", error instanceof HyperVWindowsError && error.category === "validation");
            }
        },
        stateErrorCode: error => deviceLabStateFileErrorCode(error) || null,
        providerError: error => error instanceof HyperVWindowsError ? { code: error.code, validation: error.category === "validation" } : null,
        boundedErrorCode: hyperVBoundedErrorCode,
    };
    return createHyperVDesktopTransferApplication(ports);
}

/** Presentation follows application decisions and frame publication. */
function hyperVDesktopPayload(outcome: DesktopOutcome): Record<string, unknown> {
    if (outcome.kind === 'failure' && outcome.cleanup) {
        const primary = hyperVDesktopPayload(outcome.cleanup.primary);
        return {...primary,...outcome.facts,detail:{primary,cleanupError:outcome.cleanup.error,publicationCompleted:outcome.cleanup.publicationCompleted}};
    }
    const payload: Record<string, unknown> = {...outcome.facts};
    const error = outcome.facts.error;
    if (["hyper-v-console-screenshot-required", "hyper-v-console-geometry-changed"].includes(error || ""))
        payload.remedy = "Call device_screenshot again, then use its image coordinates.";
    else if (error === "hyper-v-display-unavailable")
        payload.remedy = "Start the VM and wait for its desktop, then call device_screenshot.";
    else if (error === "hyper-v-console-identity-mismatch")
        payload.remedy = "Call device_inventory for the current owner VM, then take a new screenshot.";
    if (outcome.kind === 'failure' && outcome.receipt) {
        const presentation = desktopReceiptPresentation(outcome.receipt);
        if (presentation?.kind === 'execution') payload.execution = redactProviderCommandInput({...presentation.execution}, true, error || "hyper-v-guest-provider-failed");
    }
    const completion = outcome.completion;
    if (!completion) return payload;
    if (completion.kind === 'focus') payload.result = {deviceId:completion.deviceId,tool:'device_focus_window',ok:true};
    else if (completion.kind === 'window-list') payload.result = {deviceId:completion.deviceId,tool:'device_window_list',...completion.listing};
    else if (completion.kind === 'guest') {
        const presentation = desktopReceiptPresentation(completion.receipt);
        const linux = completion.target.backend === 'linux-vm';
        const nativeResult = presentation?.kind === 'direct' ? presentation.result : presentation?.kind === 'execution'
            ? {status:0,stdout:presentation.execution.stdout || '',stderr:presentation.execution.stderr || ''} : {};
        const transfer = completion.transfer;
        payload.result = {...completion.target,stateKey:completion.stateKey,
            provider:linux ? completion.action === 'upload' ? 'hyper-v-scp' : 'hyper-v-ssh' : 'hyper-v-powershell-direct',
            ...nativeResult,...(completion.windows?{windows:completion.windows}:{}),...(completion.focused?{focused:true}:{}),
            ...(transfer?{localPath:transfer.localPath,...(linux && transfer.remotePath?{remotePath:transfer.remotePath}:{}),...(transfer.bytes!==null?{bytes:transfer.bytes}:{})}:{}),startsDevices:false};
    } else if (completion.kind === 'input') payload.result = {...completion.target,provider:completion.method === 'guest-x11'?'hyper-v-ssh-x11':'hyper-v-console',applied:true};
    else if (completion.kind === 'cursor') payload.result = {...completion.target,provider:'hyper-v-console',...completion.position};
    else if (outcome.kind === 'success' && outcome.capture) {
        const capture = outcome.capture;
        payload.result = {...completion.target,provider:'hyper-v-console',width:capture.width,height:capture.height,capturedAt:completion.capturedAt,mcpResult:{content:[
            {type:'image',data:capture.pngBase64,mimeType:'image/png'},
            {type:'text',text:JSON.stringify({backend:completion.target.backend,deviceId:completion.target.deviceId,width:capture.width,height:capture.height,capturedAt:completion.capturedAt})},
        ]}};
    }
    return payload;
}
function renderHyperVDesktopOutcome(outcome: DesktopOutcome): BrokerRpcResult {
    const statuses: Record<DesktopFailureCategory, number> = {
        invalid: 400, denied: 403, missing: 404, conflict: 409, 'too-large': 413,
        'guest-failed': 422, unsupported: 501, 'provider-failed': 502, unavailable: 503,
    };
    return {status:outcome.kind === 'failure'?statuses[outcome.category]:200,payload:hyperVDesktopPayload(outcome)};
}

async function invokeHyperVDeviceTool(ownerId: string, parsed: DeviceToolParamSuccess, match: DeviceToolMatch, normalized: NormalizedBrokerOptions, snapshotAllowance?: SnapshotAllowance): Promise<BrokerRpcResult> {
    if (isSnapshotTool(parsed.tool)) return renderHyperVSnapshot(await brokerHyperVSnapshotApplication(normalized).invoke(ownerId, { tool: parsed.tool, deviceId: parsed.deviceId, params: parsed.params }, match, snapshotAllowance));
    return renderHyperVDesktopOutcome(await brokerHyperVDesktopTransferApplication(normalized).invoke(ownerId, parsed, match));
}

async function invokeBackendDeviceTool(ownerId: string, parsed: DeviceToolParamSuccess, normalized: NormalizedBrokerOptions, snapshotAllowance?: SnapshotAllowance): Promise<BrokerRpcResult> {
    const match = findOwnerDeviceForTool(ownerId, parsed);
    if ("status" in match) return match;
    if (parsed.tool === "device_exec" && Object.hasOwn(parsed.params, "argv") && match.backend !== "ios-simulator") {
        return { status: 501, payload: { ok: false, error: "device-exec-argv-unsupported", backend: match.backend } };
    }
    if (!brokerDeviceToolSupportedByBackend(match.backend, parsed.tool)) {
        return {
            status: 501,
            payload: {
                ok: false,
                error: "broker-device-tool-backend-not-supported",
                backend: match.backend,
                tool: parsed.tool,
                deviceId: parsed.deviceId,
                supportedTools: [...brokerDeviceToolSupportedMethods(match.backend)],
                supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
            },
        };
    }
    if (match.backend === "macos-vm"
        && (parsed.tool === "device_snapshot_restore" || parsed.tool === "device_snapshot_delete")
        && parsed.params.confirmDestructive !== true) {
        return { status: 400, payload: { ok: false, error: "destructive-confirmation-required", ownerId,
            backend: match.backend, deviceId: parsed.deviceId, tool: parsed.tool } };
    }
    const leaseFailure = refreshPhysicalDeviceLeaseForOperation(ownerId, match, String(parsed.deviceId));
    if (leaseFailure) return leaseFailure;
    if (isHyperVBackend(match.backend)) return await invokeHyperVDeviceTool(ownerId, parsed, match, normalized, snapshotAllowance);
    return await normalized.deviceToolRunner(ownerId, parsed, match, normalized);
}

type BrokerExecutorDescriptor = {
    workflow: () => BrokerRpcResult | Promise<BrokerRpcResult>;
} & (
    | { acquisitionOwner: "broker"; stateKey: string; backend: string; nestedStateKey?: string; waitBudget?: AppiumRequestBudget }
    | { acquisitionOwner: "backend" | "specialized" }
);

async function invokeBrokerExecutor(ownerId: string, deviceId: string, executor: BrokerExecutorDescriptor): Promise<BrokerRpcResult> {
    if (executor.acquisitionOwner !== "broker") return executor.workflow();
    const nestedStateKey = executor.nestedStateKey;
    const workflow = nestedStateKey
        ? () => withOwnerDeviceOperation(ownerId, nestedStateKey, deviceId, executor.workflow, executor.waitBudget)
        : executor.workflow;
    return withOwnerDeviceOperation(ownerId, executor.stateKey, deviceId, workflow, executor.waitBudget);
}

function deviceToolExecutor(ownerId: string, parsed: DeviceToolParamSuccess, normalized: NormalizedBrokerOptions): BrokerExecutorDescriptor | BrokerRpcResult {
    if (parsed.tool === "device_exec" && Object.hasOwn(parsed.params, "argv")) {
        const match = findOwnerDeviceForTool(ownerId, parsed);
        if ("status" in match) return match;
        if (match.backend !== "ios-simulator") {
            return { status: 501, payload: { ok: false, error: "device-exec-argv-unsupported", backend: match.backend } };
        }
    }
    let snapshotAllowance: SnapshotAllowance | undefined;
    const backendWorkflow = () => invokeBackendDeviceTool(ownerId, parsed, normalized, snapshotAllowance);
    const hyperVExecutor = (stateKey: string, backend: string, nestedStateKey?: string): BrokerExecutorDescriptor => {
        if (isSnapshotTool(parsed.tool)) {
            const admittedAt = normalized.hyperVMonotonicNow();
            const limits = snapshotInvocationLimits(parsed.tool);
            const operationDeadlineAt = admittedAt + limits.operationMilliseconds;
            snapshotAllowance = { operationDeadlineAt, cleanupDeadlineAt: operationDeadlineAt + limits.cleanupReserveMilliseconds };
        }
        const allowance = snapshotAllowance;
        return { acquisitionOwner: "broker", stateKey, backend, nestedStateKey, workflow: backendWorkflow,
            ...(allowance ? { waitBudget: { remaining: () => allowance.operationDeadlineAt - normalized.hyperVMonotonicNow() } } : {}) };
    };
    if (parsed.tool === "device_inventory") {
        return { acquisitionOwner: "specialized", workflow: () => invokeDeviceInventory(ownerId, parsed, normalized) };
    }
    if (DEVICE_BROKER_UNATTACHED_TOOL_METHODS.has(parsed.tool)) {
        if (parsed.backend !== "android-device" && parsed.backend !== "ios-device") {
            return {
                status: 400,
                payload: {
                    ok: false,
                    error: "invalid-unattached-device-tool-backend",
                    backend: parsed.backend,
                    tool: parsed.tool,
                    allowed: ["android-device", "ios-device"],
                },
            };
        }
        if (!brokerDeviceToolSupportedByBackend(parsed.backend, parsed.tool)) {
            return { status: 501, payload: { ok: false, error: "broker-device-tool-backend-not-supported", backend: parsed.backend, tool: parsed.tool } };
        }
        return { acquisitionOwner: "specialized", workflow: () => normalized.deviceToolRunner(ownerId, parsed, {
            stateKey: String(parsed.stateKey), backend: parsed.backend, device: {},
        }, normalized) };
    }
    if (parsed.tool === "device_record_video_status" || parsed.tool === "device_record_video_start" || parsed.tool === "device_record_video_stop") {
        const match = findOwnerDeviceForTool(ownerId, parsed);
        if ("status" in match) return match;
        if (match.stateKey === "windows" || match.stateKey === "macos") {
            return { acquisitionOwner: "backend", workflow: backendWorkflow };
        }
        if (parsed.tool === "device_record_video_status") {
            return { acquisitionOwner: "specialized", workflow: () => renderBrokerRecording(brokerRecordingApplication(normalized).status(ownerId, parsed)) };
        }
        return {
            acquisitionOwner: "broker", stateKey: match.stateKey, backend: match.backend || match.stateKey,
            workflow: () => parsed.tool === "device_record_video_start"
                ? brokerRecordingApplication(normalized).start(ownerId, parsed).then(renderBrokerRecording)
                : brokerRecordingApplication(normalized).stop(ownerId, parsed).then(renderBrokerRecording),
        };
    }
    if (DEVICE_BROKER_BACKEND_TOOL_METHODS.has(parsed.tool)) {
        if (isHyperVBackend(parsed.backend) && parsed.stateKey) {
            return hyperVExecutor(parsed.stateKey, String(parsed.backend));
        }
        const match = findOwnerDeviceForTool(ownerId, parsed);
        if ("status" in match) {
            if (parsed.backend || match.status !== 404) return match;
            return hyperVExecutor("windows-vm", "windows-vm", "linux-vm");
        }
        if (isHyperVBackend(match.backend)) {
            return hyperVExecutor(match.stateKey, String(match.backend));
        }
        return { acquisitionOwner: "backend", workflow: backendWorkflow };
    }
    return { status: 501, payload: { ok: false, error: "broker-device-tool-not-supported", supported: [...DEVICE_BROKER_TOOL_METHODS] } };
}

async function invokeDeviceTool(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions): Promise<BrokerRpcResult> {
    const validation = validateDeviceToolParams(params);
    if (!validation.ok) {
        const { status, ...payload } = validation;
        return { status, payload };
    }
    const parsed = translateDeviceToolPathsForHost(validation, normalized);
    if ("status" in parsed) return parsed;
    const executor = deviceToolExecutor(ownerId, parsed, normalized);
    if ("status" in executor) return executor;
    try {
        return await invokeBrokerExecutor(ownerId, String(parsed.deviceId), executor);
    } catch (error) {
        if (executor.acquisitionOwner === "broker" && isHyperVBackend(executor.backend)
            && isSnapshotTool(parsed.tool)) {
            const deadlineError = error instanceof HyperVOperationDeadlineError ? error
                : isDeviceOperationLockTimeout(error) && executor.waitBudget && Math.floor(executor.waitBudget.remaining()) <= 0
                    ? new HyperVOperationDeadlineError() : null;
            if (deadlineError) return { status: 504, payload: { ok: false, error: deadlineError.code, ownerId, backend: executor.backend, deviceId: parsed.deviceId } };
        }
        if (executor.acquisitionOwner !== "broker" || !isDeviceOperationLockTimeout(error)) throw error;
        return deviceOperationLockFailure(ownerId, executor.backend, String(parsed.deviceId), error);
    }
}

function ownerDevicesFile(ownerId: string, stateKey: string) {
    return join(brokerRoot(), "owners", ownerId, stateKey, "devices.json");
}

function ownerDevicesMutationLockFile(ownerId: string, stateKey: string) {
    return join(brokerRoot(), "owners", ownerId, stateKey, "devices.mutation.lock");
}

function ownerDeviceOperationLockFile(ownerId: string, stateKey: string, deviceId: string) {
    const key = createHash("sha256").update(deviceId).digest("hex").slice(0, 32);
    return join(brokerRoot(), "owners", ownerId, stateKey, "operations", `${key}.lock`);
}

function withOwnerDeviceOperation<T>(ownerId: string, stateKey: string, deviceId: string, operation: () => Promise<T> | T, waitBudget?: AppiumRequestBudget) {
    return withSharedMutationLockAsync(ownerDeviceOperationLockFile(ownerId, stateKey, deviceId), operation, {
        waitMs: 30000,
        waitBudget,
        staleMs: 15 * 60 * 1000,
    });
}

function isDeviceOperationLockTimeout(error: unknown): error is Error & { code: "shared-mutation-lock-timeout" } {
    return error instanceof Error && (error as Error & { code?: string }).code === "shared-mutation-lock-timeout";
}

function deviceOperationLockFailure(ownerId: string, backend: string, deviceId: string, error: unknown): BrokerRpcResult {
    return {
        status: 409,
        payload: {
            ok: false,
            error: "device-operation-lock-failed",
            ownerId,
            backend,
            deviceId,
            detail: isHyperVBackend(backend)
                ? hyperVBoundedErrorCode(
                    error,
                    "hyper-v-device-operation-lock-failed",
                )
                : "device-operation-lock-failed",
        },
    };
}

function readOwnerDevices(ownerId: string, stateKey: string) {
    return readOwnerDeviceStateFile(ownerDevicesFile(ownerId, stateKey), DEVICE_BROKER_INVENTORY_FILE_LIMIT);
}

const ownerRepositoryPorts: Parameters<typeof createBrokerOwnerRepository>[0] = {
    withLock: (ownerId, stateKey, operation) => withSharedMutationLock(ownerDevicesMutationLockFile(ownerId, stateKey), operation),
    read: readOwnerDevices,
    validate: devices => { assertOwnerDeviceStateWritable(devices, DEVICE_BROKER_INVENTORY_FILE_LIMIT); return undefined; },
    publish: (ownerId, stateKey, devices) => { writeJsonFileAtomically(ownerDevicesFile(ownerId, stateKey), { devices }); return undefined; },
    equal: isDeepStrictEqual,
    timestamp: () => new Date().toISOString(),
};
const ownerRepository = createBrokerOwnerRepository(ownerRepositoryPorts);

function ownerDeviceStateFailure(error: unknown, context: { backend?: string; stateKey?: string } = {}): { status: number; payload: Record<string, unknown> } {
    const code = ownerDeviceStateErrorCode(error);
    if (!code) throw error;
    return {
        status: code === "owner-devices-file-too-large" ? 413 : code === "owner-devices-state-read-failed" ? 503 : 409,
        payload: { ok: false, error: code, ...context },
    };
}


// Selected lifecycle publications share the native owner inventory authority.
function transitionOwnerLifecycleDevice(ownerId: string, stateKey: string, deviceId: string, expected: unknown, replace: (current: Record<string, unknown>) => unknown) {
    return ownerRepository.transitionLifecycle(ownerId, stateKey, deviceId, expected, replace);
}

function publishLifecycleDevice(normalized: NormalizedBrokerOptions, ...args: Parameters<typeof transitionOwnerLifecycleDevice>) {
    assertCleanupDeadline(normalized);
    const [ownerId, stateKey, deviceId, expected, replace] = args;
    const publication = transitionOwnerLifecycleDevice(ownerId, stateKey, deviceId, expected, current => {
        assertCleanupDeadline(normalized);
        return replace(current);
    });
    if (normalized.cleanupObservation && publication.matched) normalized.cleanupObservation.changed = true;
    return publication;
}

function claimOwnerDevice(ownerId: string, stateKey: string, device: Record<string, unknown>, uniqueFields: Array<string | string[]>) {
    return ownerRepository.claim(ownerId, stateKey, device, uniqueFields);
}

function escapeXml(value: unknown): string {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function brokerWindowsConfigPath(ownerId: string, deviceId: string): string {
    return join(brokerWindowsDeviceRoot(ownerId, deviceId), `${deviceId}.wsb`);
}

function brokerWindowsDeviceRoot(ownerId: string, deviceId: string): string {
    return join(brokerRoot(), "owners", ownerId, "windows", deviceId);
}

function pathWithin(root: string, candidate: string): boolean {
    const child = relative(resolve(root), resolve(candidate));
    return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function brokerWindowsToolsDir(ownerId: string, deviceId: string): string {
    return join(brokerWindowsDeviceRoot(ownerId, deviceId), "tools");
}

function brokerWindowsHelperPaths(ownerId: string, deviceId: string) {
    const scratch = brokerWindowsDeviceRoot(ownerId, deviceId);
    const tools = brokerWindowsToolsDir(ownerId, deviceId);
    const downloads = join(scratch, "downloads");
    return {
        scratch,
        tools,
        downloads,
        hostHelperScript: join(tools, "ccc-guest-helper.ps1"),
        hostBootstrapScript: join(tools, "ccc-guest-helper-bootstrap.ps1"),
        hostBootstrapLauncherScript: join(tools, "ccc-guest-helper-bootstrap.vbs"),
        readyMarkerPath: join(downloads, "ccc-guest-helper-bootstrap.ready.txt"),
        minimizeWatchdogCancelPath: join(downloads, "ccc-minimize-watchdog.cancel"),
        minimizeWatchdogResultPath: join(downloads, "ccc-minimize-watchdog.result.txt"),
        guestBootstrapScript: "C:\\ccc\\tools\\ccc-guest-helper-bootstrap.ps1",
        guestBootstrapLauncherScript: "C:\\ccc\\tools\\ccc-guest-helper-bootstrap.vbs",
        guestHelperScript: "C:\\ccc\\scratch\\ccc-guest-helper.ps1",
        guestToolsHelperScript: "C:\\ccc\\tools\\ccc-guest-helper.ps1",
        guestDownloadsDir: "C:\\ccc\\scratch\\downloads",
    };
}

type WindowsSandboxDeviceArtifactCleanup = {
    ok: boolean;
    removed: boolean;
    deviceRoot: string;
    error?: string;
};

export function cleanupBrokerWindowsDeviceArtifacts(
    ownerId: string,
    deviceId: string,
    options: {
        removeTree?: typeof rmSync;
        pathExists?: typeof existsSync;
    } = {},
): WindowsSandboxDeviceArtifactCleanup {
    const windowsRoot = join(brokerRoot(), "owners", ownerId, "windows");
    const deviceRoot = brokerWindowsDeviceRoot(ownerId, deviceId);
    const pathExists = options.pathExists || existsSync;
    try {
        assertDeviceLabPathWithinRoot(windowsRoot, deviceRoot, "windows-sandbox-device-artifacts");
        if (!pathExists(deviceRoot)) return { ok: true, removed: false, deviceRoot };
        if (lstatSync(deviceRoot).isSymbolicLink()) {
            return { ok: false, removed: false, deviceRoot, error: "windows-sandbox-device-artifacts-path-invalid" };
        }
        (options.removeTree || rmSync)(deviceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (pathExists(deviceRoot)) {
            return { ok: false, removed: false, deviceRoot, error: "windows-sandbox-device-artifacts-remained" };
        }
        return { ok: true, removed: true, deviceRoot };
    } catch (error) {
        return {
            ok: false,
            removed: false,
            deviceRoot,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function brokerWindowsHelperAssetPath(_normalized: NormalizedBrokerOptions): string {
    const asset = fileURLToPath(new URL("../providers/backends/windows-helper.ps1", import.meta.url));
    if (existsSync(asset)) return asset;
    throw new Error(`windows-helper-asset-missing: ${asset}`);
}

function brokerWindowsBootstrapScript(helper: ReturnType<typeof brokerWindowsHelperPaths>): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$ToolsHelper = '${helper.guestToolsHelperScript}'`,
        `$ScratchHelper = '${helper.guestHelperScript}'`,
        `$Downloads = '${helper.guestDownloadsDir}'`,
        "$BootstrapStdoutPath = Join-Path $Downloads 'ccc-guest-helper-bootstrap.stdout.txt'",
        "$BootstrapStderrPath = Join-Path $Downloads 'ccc-guest-helper-bootstrap.stderr.txt'",
        "$StdoutPath = Join-Path $Downloads 'ccc-guest-helper.stdout.txt'",
        "$StderrPath = Join-Path $Downloads 'ccc-guest-helper.stderr.txt'",
        "try {",
        "  New-Item -ItemType Directory -Force -Path $Downloads,(Split-Path $ScratchHelper) | Out-Null",
        "  Set-Content -Path $BootstrapStdoutPath -Value ('bootstrap-start ' + (Get-Date).ToString('o')) -Encoding UTF8",
        "  while (-not (Test-Path -LiteralPath $ToolsHelper)) {",
        "    Add-Content -Path $BootstrapStdoutPath -Value ('waiting-helper ' + (Get-Date).ToString('o'))",
        "    Start-Sleep -Milliseconds 500",
        "  }",
        "  Copy-Item -Force -LiteralPath $ToolsHelper -Destination $ScratchHelper",
        "  $Process = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$ScratchHelper) -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -WindowStyle Hidden -PassThru",
        "  Add-Content -Path $BootstrapStdoutPath -Value ('helper-pid ' + $Process.Id)",
        "  Set-Content -Path (Join-Path $Downloads 'ccc-guest-helper-bootstrap.ready.txt') -Value (Get-Date).ToString('o') -Encoding UTF8",
        "} catch {",
        "  Set-Content -Path $BootstrapStderrPath -Value $_.Exception.ToString() -Encoding UTF8",
        "  throw",
        "}",
        "",
    ].join("\n");
}

function brokerWindowsBootstrapLauncherScript(helper: ReturnType<typeof brokerWindowsHelperPaths>): string {
    const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${helper.guestBootstrapScript}"`;
    return [
        "Set Shell = CreateObject(\"WScript.Shell\")",
        `Shell.Run "${command.replace(/"/g, "\"\"")}", 0, False`,
        "",
    ].join("\r\n");
}

function writeBrokerWindowsConfig(ownerId: string, deviceId: string, create: Record<string, unknown>, normalized: NormalizedBrokerOptions): string {
    const configPath = brokerWindowsConfigPath(ownerId, deviceId);
    const helper = brokerWindowsHelperPaths(ownerId, deviceId);
    const windowsRoot = join(brokerRoot(), "owners", ownerId, "windows");
    for (const path of [helper.scratch, helper.tools, join(helper.scratch, "inbox"), join(helper.scratch, "outbox"), join(helper.scratch, "uploads"), helper.downloads]) {
        mkdirSync(path, { recursive: true });
    }
    for (const file of [helper.hostHelperScript, helper.hostBootstrapScript, helper.hostBootstrapLauncherScript, configPath]) {
        assertDeviceLabPathWithinRoot(windowsRoot, file, "windows-sandbox-workspace");
    }
    const helperAsset = readDeviceLabTextFile(
        brokerWindowsHelperAssetPath(normalized),
        "windows-sandbox-helper-asset",
        DEVICE_BROKER_WINDOWS_CONFIG_LIMIT_BYTES,
    );
    if (!helperAsset) throw new Error("windows-helper-asset-empty");
    writeFileAtomically(helper.hostHelperScript, helperAsset);
    writeFileAtomically(helper.hostBootstrapScript, brokerWindowsBootstrapScript(helper));
    writeFileAtomically(helper.hostBootstrapLauncherScript, brokerWindowsBootstrapLauncherScript(helper));
    const networking = create.networking === true ? "Enable" : "Disable";
    const clipboard = create.clipboard === true ? "Enable" : "Disable";
    const vgpu = create.vgpu === true ? "Enable" : "Disable";
    const memoryMb = typeof create.memoryMb === "number" && Number.isFinite(create.memoryMb) ? create.memoryMb : 4096;
    const mappedFolders = [
        [join(helper.scratch, "inbox"), "C:\\ccc\\scratch\\inbox", false],
        [join(helper.scratch, "outbox"), "C:\\ccc\\scratch\\outbox", false],
        [join(helper.scratch, "uploads"), "C:\\ccc\\scratch\\uploads", false],
        [helper.downloads, "C:\\ccc\\scratch\\downloads", false],
        [helper.tools, "C:\\ccc\\tools", true],
    ] as const;
    const config = [
        "<Configuration>",
        `  <VGpu>${escapeXml(vgpu)}</VGpu>`,
        `  <Networking>${escapeXml(networking)}</Networking>`,
        `  <ClipboardRedirection>${escapeXml(clipboard)}</ClipboardRedirection>`,
        `  <MemoryInMB>${escapeXml(memoryMb)}</MemoryInMB>`,
        "  <MappedFolders>",
        ...mappedFolders.flatMap(([hostFolder, sandboxFolder, readOnly]) => [
            "    <MappedFolder>",
            `      <HostFolder>${escapeXml(hostFolder)}</HostFolder>`,
            `      <SandboxFolder>${escapeXml(sandboxFolder)}</SandboxFolder>`,
            `      <ReadOnly>${readOnly ? "true" : "false"}</ReadOnly>`,
            "    </MappedFolder>",
        ]),
        "  </MappedFolders>",
        "  <LogonCommand>",
        `    <Command>wscript.exe //B ${escapeXml(helper.guestBootstrapLauncherScript)}</Command>`,
        "  </LogonCommand>",
        "</Configuration>",
        "",
    ].join("\n");
    writeFileAtomically(configPath, config);
    return configPath;
}

function createOwnerDeviceRecord(ownerId: string, parsed: CommandParamSuccess): unknown {
    if (parsed.backend === "android-emulator") return createBrokerAndroidRecord(ownerId, parsed, { timestamp: () => new Date().toISOString(), avdHome: () => androidAvdHome() });
    if (parsed.backend === "ios-simulator") return createBrokerIosRecord(ownerId, parsed, { timestamp: () => new Date().toISOString() });
    if (parsed.backend === "macos-vm") return createBrokerMacosRecord(ownerId, parsed, { timestamp: () => new Date().toISOString() });
    const create = parsed.create || {};
    const now = new Date().toISOString();
    const name = String(create.name || parsed.deviceId);

    if (parsed.backend === "windows-sandbox") {
        const configPath = brokerWindowsConfigPath(ownerId, parsed.deviceId);
        return brokerWindowsSandboxRecord(ownerId, parsed.deviceId, name, create, configPath, now);
    }
    if(isHyperVBackend(parsed.backend)){const incarnation=validHyperVIncarnationId(create.incarnationId)?create.incarnationId:null;return hyperVDeviceDefinition(ownerId,parsed,{name,timestamp:now,vmName:incarnation?hyperVVmName(ownerId,parsed.deviceId,incarnation):null,deviceRoot:hyperVDeviceRoot(ownerId,parsed.backend,parsed.deviceId),privateRoot:hyperVPrivateDeviceRoot(ownerId,parsed.backend,parsed.deviceId),validIncarnation:incarnation!==null});}

    return {
        id: parsed.deviceId,
        name,
        backend: parsed.backend,
        ownerId,
        status: "stopped",
        createdAt: now,
        updatedAt: now,
        authority: "host-broker",
    };
}

function createOwnerDeviceUniqueFields(parsed: CommandParamSuccess): Array<string | string[]> {
    if (parsed.backend === "android-emulator") return ["id", "avdName", "port"];
    if (parsed.backend === "ios-simulator") return brokerIosUniqueFields();
    if (parsed.backend === "macos-vm") return brokerMacosUniqueFields();
    if (isHyperVBackend(parsed.backend)) return hyperVCreateUniqueFields();
    return ["id"];
}

async function rollbackProviderCreateAfterConflict(
    parsed: CommandParamSuccess,
    device: Record<string, unknown>,
    existing: Record<string, unknown> | null,
    providerCommand: ProviderCommand | null | undefined,
    normalized: NormalizedBrokerOptions,
    hyperVDeadlineAt = Number.POSITIVE_INFINITY,
) {
    // Hyper-V's typed create mutates the host without executing its legacy planning descriptor.
    // A later seed, provision, or state-claim failure still has a VM to roll back.
    if (!isHyperVBackend(parsed.backend) && (!providerCommand || providerCommand.mode === "noop")) {
        return { attempted: false, ok: true, reason: "no-provider-resource-created" };
    }
    if (parsed.backend === "ios-simulator") return rollbackBrokerIosCreate(brokerIosLifecyclePorts(normalized), device, existing, nativeLifecyclePreparation(providerCommand)).then(renderBrokerProviderRollback);
    if(isHyperVBackend(parsed.backend))return renderHyperVCreateRollback(await brokerHyperVCreateStartApplication(normalized).rollbackCreate(parsed,device,existing,hyperVDeadlineAt));

    if (parsed.backend === "macos-vm") return rollbackBrokerMacosCreate(brokerMacosLifecyclePorts(normalized), device, existing, nativeLifecyclePreparation(providerCommand)).then(renderBrokerProviderRollback);
    return { attempted: false, ok: true, reason: "create-does-not-provision-a-provider-resource" };
}

function validAndroidEmulatorPort(port: unknown): port is number {
    return Number.isInteger(port)
        && Number(port) >= ANDROID_EMULATOR_PORT_MIN
        && Number(port) <= ANDROID_EMULATOR_PORT_MAX
        && Number(port) % 2 === 0;
}

function androidEmulatorPortAllocationLockFile() {
    return join(brokerRoot(), "broker", "locks", "android-emulator-ports.mutation.lock");
}

function allocatedAndroidEmulatorPorts(): Set<number> {
    const ports = new Set<number>();
    const ownersRoot = join(brokerRoot(), "owners");
    for (const ownerId of enumerateDeviceProjectIds(ownersRoot, (name) => /^[a-f0-9]{16}$/.test(name))) {
        const devices = readOwnerDevices(ownerId, "android");
        for (const device of devices) {
            const port = numberField(device, "port");
            if (validAndroidEmulatorPort(port)) ports.add(port);
        }
    }
    return ports;
}

type AndroidEmulatorPortAllocation =
    | { ok: true; port: number }
    | { ok: false; status: number; error: string; allowed?: string; detail?: string };

function resolveAndroidEmulatorCreatePort(ownerId: string, parsed: CommandParamSuccess, additionalUsedPorts: Iterable<number> = []): AndroidEmulatorPortAllocation {
    const allocation = observeAndroidPreviewPort(ownerId, parsed, additionalUsedPorts);
    if (allocation.kind === "allocated") return { ok: true, port: allocation.port };
    if (allocation.kind === "invalid") return { ok: false, status: 400, error: "invalid-android-emulator-port", allowed: `even integer ${ANDROID_EMULATOR_PORT_MIN}-${ANDROID_EMULATOR_PORT_MAX}` };
    if (allocation.kind === "inventory-failed") return { ok: false, status: 503, error: "android-emulator-port-inventory-unavailable", detail: allocation.detail };
    if (allocation.kind === "conflict") return { ok: false, status: 409, error: "android-emulator-port-conflict", detail: `port-${allocation.port}-already-allocated` };
    return { ok: false, status: 409, error: "android-emulator-port-pool-exhausted" };
}

const observeAndroidPreviewPort = createAndroidPreviewPortAllocation<CommandParamSuccess>({
    valid: port => validAndroidEmulatorPort(port),
    allocated: () => allocatedAndroidEmulatorPorts(),
    inventoryError: error => ownerDeviceStateErrorCode(error) || deviceLabProjectEnumerationErrorCode(error) || "android-emulator-port-inventory-read-failed",
    seed: (ownerId, parsed) => Number.parseInt(createHash("sha256").update(`${ownerId}\0${parsed.deviceId}`).digest("hex").slice(0, 8), 16),
}, ANDROID_EMULATOR_PORT_MIN, ANDROID_EMULATOR_PORT_MAX);

function androidEmulatorPortsFromAdbDevices(output: unknown): Set<number> {
    const ports = new Set<number>();
    for (const line of String(output || "").split(/\r?\n/)) {
        const match = line.trim().match(/^emulator-(\d+)\s+/);
        if (!match) continue;
        const port = Number(match[1]);
        if (validAndroidEmulatorPort(port)) ports.add(port);
    }
    return ports;
}

async function liveAndroidEmulatorPortsForAllocation(normalized: NormalizedBrokerOptions): Promise<
    | { ok: true; ports: Set<number> }
    | { ok: false; status: number; error: string; detail: string }> {
    const adb = providerExecutable("adb", normalized);
    if (!adb) return { ok: true, ports: new Set() };
    const result = await runBudgetedProviderCommand(normalized, { mode: "exec", provider: "adb", executable: adb, args: ["devices", "-l"] }, {
        timeoutMs: 10000,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    if (!commandSucceeded(result)) {
        return {
            ok: false,
            status: 503,
            error: "android-emulator-live-port-inventory-unavailable",
            detail: result.stderr || result.stdout || result.error || `adb-exit-${result.status ?? "unknown"}`,
        };
    }
    return { ok: true, ports: androidEmulatorPortsFromAdbDevices(result.stdout) };
}

async function liveAndroidAvdNames(normalized: NormalizedBrokerOptions): Promise<
    | { ok: true; names: Set<string> }
    | { ok: false; status: number; error: string; detail: string }> {
    const adb = providerExecutable("adb", normalized);
    if (!adb) {
        return {
            ok: false,
            status: 503,
            error: "android-emulator-runtime-inventory-unavailable",
            detail: "missing-adb",
        };
    }
    const inventory = await runBudgetedProviderCommand(normalized, {
        mode: "exec",
        provider: "adb",
        executable: adb,
        args: ["devices", "-l"],
    }, {
        timeoutMs: 10000,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    if (!commandSucceeded(inventory)) {
        return {
            ok: false,
            status: 503,
            error: "android-emulator-runtime-inventory-unavailable",
            detail: inventory.stderr || inventory.stdout || inventory.error || `adb-exit-${inventory.status ?? "unknown"}`,
        };
    }
    const emulatorLines = String(inventory.stdout || "").split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^emulator-\d+\s+/.test(line));
    const unavailable = emulatorLines.filter((line) => !/^emulator-\d+\s+device\b/.test(line));
    if (unavailable.length > 0) {
        return {
            ok: false,
            status: 503,
            error: "android-emulator-runtime-target-unavailable",
            detail: unavailable.join(", "),
        };
    }
    const names = new Set<string>();
    for (const line of emulatorLines) {
        const serial = /^(emulator-\d+)/.exec(line)?.[1];
        if (!serial) {
            return {
                ok: false,
                status: 503,
                error: "android-emulator-runtime-identity-unavailable",
                detail: "invalid-emulator-serial",
            };
        }
        const identity = await readAndroidAvdIdentityAsync(serial, args => runBudgetedProviderCommand(normalized, {
            mode: "exec",
            provider: "adb",
            executable: adb,
            args,
        }, {
            timeoutMs: 10000,
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        }));
        if (!identity.ok) {
            return {
                ok: false,
                status: 503,
                error: "android-emulator-runtime-identity-unavailable",
                detail: identity.detail,
            };
        }
        names.add(identity.name);
    }
    return { ok: true, names };
}

function approvedAndroidAvdRoot(recordedRoot: unknown, platform: NodeJS.Platform): string | null {
    if (typeof recordedRoot !== "string" || !recordedRoot) return null;
    const approved = resolve(androidAvdHome());
    const recorded = resolve(recordedRoot);
    const normalize = (value: string) => platform === "win32" ? value.toLowerCase() : value;
    return normalize(approved) === normalize(recorded) ? approved : null;
}

async function androidAvdProcessState(avdName: string, normalized: NormalizedBrokerOptions, timeoutMs = 10000, registeredName = false): Promise<
    | { ok: true; active: boolean }
    | { ok: false; status: number; error: string; detail: string }> {
    if (!/^[A-Za-z0-9._-]+$/.test(avdName)
        || (!registeredName && !ownedAndroidAvdName(avdName, avdName.slice(4, 20)))) {
        return { ok: false, status: 409, error: "android-avd-identity-unavailable", detail: "invalid-avd-name" };
    }
    const command: ProviderCommand = normalized.platform === "win32"
        ? {
            mode: "exec",
            provider: "process-inventory",
            executable: "powershell.exe",
            args: [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^(emulator|qemu-system-.*)\\.exe$' } | ForEach-Object { [string]$_.CommandLine }",
            ],
        }
        : {
            mode: "exec",
            provider: "process-inventory",
            executable: "/bin/ps",
            args: ["-eo", "args="],
        };
    const result = await runBudgetedProviderCommand(normalized, command, {
        timeoutMs,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    if (!commandSucceeded(result) || result.timedOut || result.outputLimitExceeded) {
        return {
            ok: false,
            status: 503,
            error: "android-emulator-process-inventory-unavailable",
            detail: result.stderr || result.stdout || result.error || `process-inventory-exit-${result.status ?? "unknown"}`,
        };
    }
    const escaped = avdName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegExp(`(?:^|\\s)(?:-avd(?:\\s+|=)["']?${escaped}(?=["'\\s]|$)|@${escaped}(?=\\s|$))`);
    return {
        ok: true,
        active: String(result.stdout || "").split(/\r?\n/).some((line) => matcher.test(line)),
    };
}

async function resolveAndroidEmulatorCreatePortForInvoke(
    ownerId: string,
    parsed: CommandParamSuccess,
    normalized: NormalizedBrokerOptions,
): Promise<AndroidEmulatorPortAllocation> {
    const observation = await allocateBrokerAndroidCreatePort(ownerId, parsed, {
        previewAllocation: (ownerId, parsed, additionalUsedPorts) => {const result = resolveAndroidEmulatorCreatePort(ownerId, parsed, additionalUsedPorts); if(result.ok) return result; const {status, ...facts} = result; return {...facts, reason: nativeAndroidFailureReason(status)};},
        livePorts: () => brokerAndroidLifecyclePorts(normalized).livePorts(),
    });
    if (observation.ok) return observation;
    const {reason, ...facts} = observation;
    return {...facts, status: reason === "invalid" ? 400 : reason === "provider-unavailable" ? 503 : reason === "provider-failed" ? 502 : reason === "state-write-failed" ? 500 : 409};
}


function physicalLeaseLocksDir(backend: string) {
    return join(brokerRoot(), "physical-leases", backend, "locks");
}

function physicalLeaseLockFile(backend: string, hardwareId: string) {
    return join(physicalLeaseLocksDir(backend), `${encodeURIComponent(hardwareId)}.json`);
}

function physicalLeaseMutationLockFile(backend: string, hardwareId: string) {
    return join(physicalLeaseLocksDir(backend), `${encodeURIComponent(hardwareId)}.mutation.lock`);
}

function readLeaseFile(file: string, backend?: string, hardwareId?: string) {
    return readPhysicalLeaseStateFile(file, backend, hardwareId);
}

function leaseExpiryFrom(updatedAt: string, ttlMs: number) {
    return new Date(new Date(updatedAt).getTime() + ttlMs).toISOString();
}

function leaseTtlMs(lease: Record<string, unknown> | null | undefined) {
    return observeLeaseDates.ttlMs(lease);
}

function leaseExpiresAt(lease: Record<string, unknown>) {
    return observeLeaseDates.expiresAt(lease);
}

function leaseExpired(lease: Record<string, unknown>, nowMs = Date.now()) {
    return observeLeaseDates.expired(lease, nowMs);
}

const observeLeaseDates = createLeaseDatePolicy({
    parse: read => Date.parse(read()),
    epoch: () => new Date(0).toISOString(),
    expiryFrom: (updatedAt, ttlMs) => leaseExpiryFrom(updatedAt, ttlMs),
}, DEVICE_BROKER_PHYSICAL_LEASE_TTL_MS);

function physicalDeviceLeaseMatches(ownerId: string, stateKey: string, deviceId: string, device: unknown) {
    if (!DEVICE_BROKER_PHYSICAL_BACKENDS.has(stateKey) || !device || typeof device !== "object") return false;
    const record = device as Record<string, unknown>;
    const hardwareId = stateKey === "android-device" ? field(record, "serial") : field(record, "udid");
    const lease = hardwareId ? readLeaseFile(physicalLeaseLockFile(stateKey, hardwareId), stateKey, hardwareId) : null;
    return Boolean(lease
        && !leaseExpired(lease)
        && lease.ownerId === ownerId
        && lease.deviceId === deviceId
        && typeof record.leaseClaimId === "string"
        && record.leaseClaimId.length > 0
        && lease.claimId === record.leaseClaimId
        && typeof record.leaseClaimNonce === "string"
        && record.leaseClaimNonce.length > 0
        && lease.claimNonce === record.leaseClaimNonce);
}

function refreshPhysicalDeviceLeaseForOperation(ownerId: string, match: DeviceToolMatch, deviceId: string, waitBudget?: AppiumRequestBudget): BrokerRpcResult | null {
    if (!DEVICE_BROKER_PHYSICAL_BACKENDS.has(match.stateKey)) return null;
    const hardwareId = match.stateKey === "android-device" ? field(match.device, "serial") : field(match.device, "udid");
    const claimId = field(match.device, "leaseClaimId");
    const claimNonce = field(match.device, "leaseClaimNonce");
    const heartbeat = hardwareId && claimId && claimNonce
        ? heartbeatPhysicalBrokerLease(ownerId, {
            backend: match.stateKey,
            hardwareId,
            deviceId,
            claimId,
            claimNonce,
        }, waitBudget)
        : null;
    if (heartbeat?.status === 200) return null;
    const leaseError = heartbeat?.payload && typeof heartbeat.payload === "object" && !Array.isArray(heartbeat.payload)
        ? field(heartbeat.payload as Record<string, unknown>, "error")
        : null;
    return {
        status: 409,
        payload: {
            ok: false,
            error: "physical-device-not-attached",
            ownerId,
            backend: match.backend,
            deviceId,
            ...(leaseError ? { leaseError } : {}),
            remedy: "attach the physical device before using host-backed device tools",
        },
    };
}


function writeLeaseFile(file: string, lease: Record<string, unknown>) {
    validatePhysicalLease(lease);
    writeJsonFileAtomically(file, lease);
}

function startBrokerPhysicalLeaseHeartbeat(ownerId: string, backend: string, hardwareId: string, deviceId: string, options: { ttlMs?: number; claimId?: string; claimNonce?: string } = {}) {
    return brokerPhysicalLeases.startHeartbeat(ownerId, backend, hardwareId, deviceId, options);
}

function stopAllBrokerPhysicalLeaseHeartbeats() {
    brokerPhysicalLeases.stopAllHeartbeats();
}

type PhysicalLeaseDirectoryScan =
    | { ok: true; entries: Array<{ file: string; hardwareId: string }> }
    | { ok: false; status: number; payload: Record<string, unknown> };

type PhysicalLeaseDirectoryInspection =
    | { ok: true; exists: boolean }
    | { ok: false; status: number; payload: Record<string, unknown> };

function physicalLeaseDirectoryFailure(backend: string, detail: string): PhysicalLeaseDirectoryInspection {
    return {
        ok: false,
        status: 409,
        payload: {
            ok: false,
            error: "physical-lease-directory-invalid",
            backend,
            detail,
        },
    };
}

function inspectPhysicalLeaseDirectory(backend: string): PhysicalLeaseDirectoryInspection {
    const root = brokerRoot();
    const directories = [
        root,
        join(root, "physical-leases"),
        join(root, "physical-leases", backend),
        physicalLeaseLocksDir(backend),
    ];
    for (const directory of directories) {
        let stat;
        try {
            stat = lstatSync(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, exists: false };
            return physicalLeaseDirectoryFailure(backend, "physical-lease-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            return physicalLeaseDirectoryFailure(backend, "physical-lease-directory-path-invalid");
        }
    }
    return { ok: true, exists: true };
}

function ensurePhysicalLeaseDirectory(backend: string): PhysicalLeaseDirectoryInspection {
    const root = brokerRoot();
    const directories = [
        root,
        join(root, "physical-leases"),
        join(root, "physical-leases", backend),
        physicalLeaseLocksDir(backend),
    ];
    for (const directory of directories) {
        try {
            mkdirSync(directory, { recursive: directory === root, mode: 0o700 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                return physicalLeaseDirectoryFailure(backend, "physical-lease-directory-create-failed");
            }
        }
        let stat;
        try {
            stat = lstatSync(directory);
        } catch {
            return physicalLeaseDirectoryFailure(backend, "physical-lease-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            return physicalLeaseDirectoryFailure(backend, "physical-lease-directory-path-invalid");
        }
    }
    return { ok: true, exists: true };
}

function scanPhysicalLeaseDirectory(backend: string): PhysicalLeaseDirectoryScan {
    const scan = observeLeaseDirectory(backend);
    if (scan.kind === "entries") return { ok: true, entries: scan.entries };
    if (scan.kind === "native-refusal") return scan.evidence as Extract<PhysicalLeaseDirectoryInspection, { ok: false }>;
    if (scan.kind === "entry-cap") return { ok: false, status: 507, payload: {
        ok: false, error: "physical-lease-directory-entry-limit-exceeded", backend: scan.backend, limit: scan.limit,
    } };
    return { ok: false, status: 409, payload: {
        ok: false, error: "physical-lease-directory-invalid", backend: scan.backend, detail: scan.detail,
    } };
}

const observeLeaseDirectory = createLeaseDirectoryScan({
    root: backend => physicalLeaseLocksDir(backend),
    inspect: backend => inspectPhysicalLeaseDirectory(backend),
    assertRoot: root => assertDeviceLabPathWithinRoot(brokerRoot(), root, "physical-lease-directory"),
    open: root => opendirSync(root),
    entryFile: (root, entry) => join(root, entry.name),
    errorCode: error => deviceLabStateFileErrorCode(error),
}, DEVICE_BROKER_PHYSICAL_LEASE_DIRECTORY_ENTRY_LIMIT);

function listPhysicalLeases(ownerId: string, backend: string) {
    return observePhysicalLeases(ownerId, backend);
}

const observePhysicalLeases = createLeaseList<string, PhysicalLeaseDirectoryScan>(
    backend => scanPhysicalLeaseDirectory(backend),
    {
        read: (file, backend, hardwareId) => readLeaseFile(file, backend, hardwareId),
        expired: lease => leaseExpired(lease),
        expiresAt: lease => leaseExpiresAt(lease),
        ttlMs: lease => leaseTtlMs(lease),
    },
);

function nativeLeaseFailure(status: number, payload: Record<string, unknown>): LeaseFailure {
    const error = typeof payload.error === "string" ? payload.error : "physical-lease-directory-invalid";
    if (status === 400) return { kind: "invalid", error, ...(Array.isArray(payload.allowed) ? { allowed: payload.allowed.filter((item): item is string => typeof item === "string") } : {}) };
    if (status === 403) return { kind: "forbidden", error, ...(cleanupRecord(payload.conflict) ? { conflict: payload.conflict } : {}) };
    if (status === 404) return cleanupRecord(payload.lease) && typeof payload.pruned === "boolean"
        ? { kind: "expired", error, lease: payload.lease, pruned: payload.pruned }
        : { kind: "missing", error };
    if (error === "physical-lease-directory-invalid") return { kind: "directory-refused", error, ...(typeof payload.backend === "string" ? { backend: payload.backend } : {}), ...(payload.detail === undefined ? {} : { detail: payload.detail }) };
    if (typeof payload.limit === "number") return { kind: "scan-limit", error, limit: payload.limit, ...(typeof payload.backend === "string" ? { backend: payload.backend } : {}) };
    return { kind: "conflict", error, ...(cleanupRecord(payload.lease) ? { lease: payload.lease } : {}), ...(cleanupRecord(payload.conflict) ? { conflict: payload.conflict } : {}) };
}
const brokerPhysicalLeases = createBrokerPhysicalLeasesApplication<ReturnType<typeof setInterval>>({
    parse: value => Date.parse(value()), epoch: () => new Date(0).toISOString(), expiryFrom: (updatedAt, ttlMs) => leaseExpiryFrom(updatedAt, ttlMs),
    prepareDirectory: backend => { const observed = ensurePhysicalLeaseDirectory(backend); return observed.ok ? observed : { ok: false, failure: nativeLeaseFailure(observed.status, observed.payload) }; },
    inspectDirectory: backend => { const observed = inspectPhysicalLeaseDirectory(backend); return observed.ok ? observed : { ok: false, failure: nativeLeaseFailure(observed.status, observed.payload) }; },
    scan: backend => { const observed = scanPhysicalLeaseDirectory(backend); return observed.ok ? observed : { ok: false, failure: nativeLeaseFailure(observed.status, observed.payload) }; }, leaseFile: (backend, hardwareId) => physicalLeaseLockFile(backend, hardwareId),
    withHardwareLock: (backend, hardwareId, operation, waitBudget) => withSharedMutationLock(physicalLeaseMutationLockFile(backend, hardwareId), operation, {waitBudget}),
    read: (file, backend, hardwareId) => readLeaseFile(file, backend, hardwareId),
    write: (file, lease) => { writeLeaseFile(file, lease); return undefined; },
    remove: file => { unlinkSync(file); return undefined; }, fileExists: file => existsSync(file),
    timestamp: () => new Date().toISOString(), nowMs: () => Date.now(), newClaimId: () => randomBytes(16).toString("hex"),
    schedule: (callback, intervalMs) => ({handle: setInterval(callback, intervalMs)}),
    cancel: timer => { clearInterval(timer); return undefined; },
    unref: timer => { timer.unref?.(); return undefined; },
});
function claimPhysicalLease(ownerId: string, params: unknown): BrokerRpcResult { return renderLeaseOutcome(brokerPhysicalLeases.claim(ownerId, params)); }
function heartbeatPhysicalBrokerLease(ownerId: string, params: unknown, waitBudget?: AppiumRequestBudget) { return renderLeaseOutcome(brokerPhysicalLeases.heartbeat(ownerId, params, waitBudget)); }
function physicalLeaseReleaseConflict(ownerId: string, parsed: LeaseParamSuccess, existing: Record<string, unknown> | null): BrokerRpcResult | null { const failure = brokerPhysicalLeases.releaseConflict(ownerId, parsed, existing); return failure ? leaseParamError(failure) : null; }
function completePhysicalBrokerLeaseRelease(ownerId: string, parsed: LeaseParamSuccess, file: string, existing: Record<string, unknown>): BrokerRpcResult { return renderLeaseOutcome(brokerPhysicalLeases.completeRelease(ownerId, parsed, file, existing)); }
function restorePhysicalBrokerLeaseRelease(ownerId: string, parsed: LeaseParamSuccess, file: string, existing: Record<string, unknown>) { return renderCleanupRollback(brokerPhysicalLeases.restoreReleased(ownerId, parsed, file, existing)); }
function releasePhysicalBrokerLease(ownerId: string, params: unknown) { return renderLeaseOutcome(brokerPhysicalLeases.release(ownerId, params)); }
function prunePhysicalBrokerLeases(ownerId: string, params: unknown) { return renderLeaseOutcome(brokerPhysicalLeases.prune(ownerId, params)); }

function listPhysicalBrokerLeases(ownerId: string, params: unknown) {
    const parsed = validateLeaseParams(params, "list");
    if (!parsed.ok) return leaseParamError(parsed);
    const listed = listPhysicalLeases(ownerId, parsed.backend);
    if (!listed.ok) return { status: listed.status, payload: listed.payload };
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                leases: listed.leases,
            },
        },
    };
}

function physicalDeviceId(backend: string, identity: string) { return `${backend}-${createHash("sha256").update(identity).digest("hex").slice(0, 10)}`; }
function validateAttachParams(params: unknown): AttachParamError | AttachParamSuccess { const parsed = validatePhysicalAttachParams(params, physicalDeviceId); return parsed.ok ? parsed : { ...parsed, status: 400 }; }

function attachParamError(parsed: AttachParamError) {
    return {
        status: parsed.status,
        payload: {
            ok: false,
            error: parsed.error,
            ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
        },
    };
}

function parseAdbDevices(text: string) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("List of devices"))
        .map((line) => {
            const [serial, state, ...detailParts] = line.split(/\s+/);
            const details = Object.fromEntries(detailParts.map((part) => {
                const index = part.indexOf(":");
                return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, true];
            }));
            return { serial, state: state || "unknown", details };
        })
        .filter((device) => device.serial);
}

function androidHostDeviceInventory(normalized: NormalizedBrokerOptions) {
    const adb = executableFor("adb", normalized);
    const command = normalized.commandRunner({ mode: "exec", provider: "adb", executable: adb, args: ["devices", "-l"] }, {
        timeoutMs: Math.max(normalized.commandTimeoutMs, DEVICE_BROKER_ANDROID_INVENTORY_TIMEOUT_MS),
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    const devices = commandSucceeded(command)
        ? parseAdbDevices(command.stdout || "").map((device) => ({
            ...device,
            connection: String(device.serial).includes(":") ? "wifi" : "usb",
            emulator: String(device.serial).startsWith("emulator-"),
            attachable: device.state === "device" && !String(device.serial).startsWith("emulator-"),
            reason: device.state === "device"
                ? String(device.serial).startsWith("emulator-") ? "emulator-not-physical" : "ready"
                : `adb-state-${device.state}`,
        }))
        : [];
    return {
        provider: "adb",
        command: {
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: command.status,
            stderr: command.stderr,
            error: command.error,
            timedOut: command.timedOut,
        },
        ok: commandSucceeded(command),
        devices,
        count: devices.length,
    };
}



function parseXctraceDevices(text: string) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.endsWith(":") && !line.includes("Simulator"))
        .map((line) => {
            const matches = [...line.matchAll(/\(([^()]*)\)/g)].map((match) => match[1]);
            const udid = matches.find((value) => /^[A-Fa-f0-9-]{8,}$/.test(value));
            if (!udid) return null;
            const version = matches.find((value) => value !== udid && /\d/.test(value)) || null;
            const name = line.split(" (")[0].trim();
            if (!/\b(iPhone|iPad|iPod)\b/i.test(name)) return null;
            const markers = matches.filter((value) => value !== udid && value !== version);
            const connection = markers.some((value) => /^(network|wifi|wi-fi)$/i.test(value.trim())) ? "wifi" : "usb";
            const availability = markers.some((value) => /^(unavailable|not available|disconnected)$/i.test(value.trim())) ? "unavailable" : "available";
            return { name, udid, version, connection, availability, raw: line };
        })
        .filter(Boolean) as Array<{ name: string; udid: string; version: string | null; connection: string; availability: string; raw: string }>;
}













function claimOrReattachPhysicalOwnerDevice(
    ownerId: string,
    stateKey: string,
    device: Record<string, unknown>,
    hardwareField: "serial" | "udid",
) {
    return ownerRepository.claimOrReattachPhysical(ownerId, stateKey, device, hardwareField);
}





function appleTrustStatus(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) { return renderAppleTrustOutcome(brokerPhysicalDevicesApplication(normalized).trust(ownerId, params)); }

function attachPhysicalDevice(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) { return renderPhysicalAttachOutcome(brokerPhysicalDevicesApplication(normalized).attach(ownerId, params)); }

function detachPhysicalDevice(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) { return renderPhysicalDetachOutcome(brokerPhysicalDevicesApplication(normalized).detach(ownerId, params), redactBrokerDeviceSecrets); }

async function withPhysicalDeviceOperation(
    ownerId: string,
    params: unknown,
    operation: () => Promise<BrokerRpcResult> | BrokerRpcResult,
): Promise<BrokerRpcResult> {
    const parsed = validateAttachParams(params);
    if (!parsed.ok) return attachParamError(parsed);
    try {
        return await withOwnerDeviceOperation(ownerId, parsed.stateKey, parsed.deviceId, operation);
    } catch (error) {
        if (!isDeviceOperationLockTimeout(error)) throw error;
        return deviceOperationLockFailure(ownerId, parsed.backend, parsed.deviceId, error);
    }
}

function listAttachedPhysicalDevices(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateLeaseParams(params, "list");
    if (!parsed.ok) return leaseParamError(parsed);
    const observation = observePhysicalComposite(ownerId, parsed.backend, normalized);
    if (observation.kind === "lease-refused") return { status: observation.evidence.status, payload: observation.evidence.payload };
    return { status: 200, payload: { ok: true, result: observation.value } };
}

const observePhysicalComposite = createPhysicalComposite({
    leases: (ownerId, backend) => listPhysicalLeases(ownerId, backend),
    androidHost: (normalized: NormalizedBrokerOptions) => androidHostDeviceInventory(normalized),
    devices: (ownerId, backend) => readOwnerDevices(ownerId, backend),
});

function brokerSlug(value: unknown): string {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "device";
}

function defaultDeviceIdForBackend(backend: string, name: string): string {
    const suffix = brokerSlug(name);
    if (backend === "android-emulator") return `android-${suffix}`;
    if (backend === "ios-simulator") return `ios-${suffix}`;
    if (backend === "windows-sandbox") return `windows-${suffix}`;
    return suffix;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
    const value = input[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
    const value = input[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
    const value = input[key];
    return typeof value === "boolean" ? value : undefined;
}

function createCommandParams(backend: string, input: Record<string, unknown>): Record<string, unknown> | null {
    const name = optionalString(input, "name");
    if (!name) return null;
    return {
        name,
        avdName: optionalString(input, "avdName"),
        port: optionalNumber(input, "port"),
        systemImage: optionalString(input, "systemImage"),
        deviceProfile: optionalString(input, "deviceProfile"),
        createAvd: optionalBoolean(input, "createAvd"),
        headless: optionalBoolean(input, "headless"),
        minimized: optionalBoolean(input, "minimized"),
        simulatorName: optionalString(input, "simulatorName"),
        deviceType: optionalString(input, "deviceType"),
        runtime: optionalString(input, "runtime"),
        udid: optionalString(input, "udid"),
        createSimulator: optionalBoolean(input, "createSimulator"),
        networking: optionalBoolean(input, "networking"),
        clipboard: optionalBoolean(input, "clipboard"),
        vgpu: optionalBoolean(input, "vgpu"),
        memoryMb: optionalNumber(input, "memoryMb"),
        provider: optionalString(input, "provider"),
        image: optionalString(input, "image"),
        sourceImage: optionalString(input, "sourceImage"),
        baseImageSha256: optionalString(input, "baseImageSha256"),
        baseImageGeneration: optionalNumber(input, "baseImageGeneration"),
        profile: optionalString(input, "profile"),
        switchName: optionalString(input, "switchName"),
        networkAddress: optionalString(input, "networkAddress"),
        macAddress: optionalString(input, "macAddress"),
        networkGateway: optionalString(input, "networkGateway"),
        networkPrefix: optionalString(input, "networkPrefix"),
        outboundPolicy: optionalString(input, "outboundPolicy"),
        incarnationId: optionalString(input, "incarnationId"),
        secureBootTemplate: optionalString(input, "secureBootTemplate"),
        vmId: optionalString(input, "vmId"),
        cpus: optionalNumber(input, "cpus"),
        nestedVirtualization: optionalBoolean(input, "nestedVirtualization"),
        diskMaxBytes: optionalNumber(input, "diskMaxBytes"),
        sshHost: optionalString(input, "sshHost"),
        sshPort: optionalNumber(input, "sshPort"),
        sshUser: optionalString(input, "sshUser"),
        sshKeyPath: optionalString(input, "sshKeyPath"),
        sshPassword: optionalString(input, "sshPassword"),
        backend,
    };
}

function validateCommandParams(params: unknown, admittedDeviceId?: string): CommandParamError | CommandParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-command-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    const stateKey = DEVICE_BROKER_COMMAND_BACKENDS.get(backend);
    if (!stateKey) {
        return { ok: false, status: 400, error: "invalid-command-backend", allowed: [...DEVICE_BROKER_COMMAND_BACKENDS.keys()] };
    }
    const command = typeof input.command === "string" ? input.command : "";
    if (!DEVICE_BROKER_LIFECYCLE_COMMANDS.has(command)) {
        return { ok: false, status: 400, error: "unsupported-lifecycle-command", allowed: [...DEVICE_BROKER_LIFECYCLE_COMMANDS] };
    }
    if (command === "device_create" && !DEVICE_BROKER_CREATABLE_BACKENDS.has(backend)) {
        return { ok: false, status: 400, error: "invalid-create-backend", allowed: [...DEVICE_BROKER_CREATABLE_BACKENDS] };
    }
    if (command === "device_reboot" && !isHyperVBackend(backend)) {
        return { ok: false, status: 400, error: "invalid-reboot-backend", allowed: [...DEVICE_BROKER_HYPER_V_BACKENDS] };
    }
    const managedVmCreate = command === "device_create" && (isHyperVBackend(backend) || backend === "macos-vm");
    if (managedVmCreate && input.deviceId !== undefined) {
        return { ok: false, status: 400, error: "vm-create-device-id-not-supported" };
    }
    if (managedVmCreate && backend === "linux-vm" && input.labId !== undefined) {
        return { ok: false, status: 400, error: "linux-vm-create-lab-id-not-supported" };
    }
    const create = command === "device_create" ? createCommandParams(backend, input) : undefined;
    if (input.nestedVirtualization !== undefined && (command !== "device_create" || backend !== "windows-vm" || typeof input.nestedVirtualization !== "boolean")) {
        return { ok: false, status: 400, error: "nested-virtualization-requires-windows-vm-create-boolean" };
    }
    if (command === "device_create" && !create) {
        return { ok: false, status: 400, error: "invalid-device-name" };
    }
    if (command === "device_create" && backend === "linux-vm" && create?.networking === false) {
        return { ok: false, status: 400, error: "linux-vm-networking-required" };
    }
    // windows-vm joins linux-vm here because readiness is now the only place the provisioning
    // media is removed and the only place containment runs. `waitForBoot: false` skipped the whole
    // readiness block, so a plain `device_start { waitForBoot: false }` returned 200 success with
    // the guest Running and CCC_UNATTEND still mounted — a DVD carrying the local Administrator
    // password as PlainText, readable by anything inside the guest. No failure required, and
    // nothing reported it, because on the success path there is no state write to carry a warning.
    // Earlier contracts removed the media on the first successful readiness, so moving the scrub
    // guarantee onto readiness is what turned this from a slow path into an open door.
    if ((backend === "linux-vm" || backend === "windows-vm")
        && (command === "device_start" || command === "device_reboot")
        && input.waitForBoot === false) {
        return {
            ok: false,
            status: 400,
            error: backend === "linux-vm"
                ? "linux-vm-bootstrap-requires-boot-wait"
                : "windows-vm-bootstrap-requires-boot-wait",
            // A bare code leaves a caller that set waitForBoot:false to skip a slow boot with no
            // idea what to do instead. Say what the wait is for and what to reach for.
            detail: backend === "linux-vm"
                ? "linux-vm start and reboot must wait for boot: bootstrap networking is torn down on the readiness path. Omit waitForBoot, or raise bootTimeoutMs if the guest is slow."
                : "windows-vm start and reboot must wait for boot: the readiness path is what removes the provisioning media and contains a guest whose first-logon scrub did not run. Omit waitForBoot, or raise bootTimeoutMs if the guest is slow.",
        };
    }
    const deviceId = typeof input.deviceId === "string" && input.deviceId.trim()
        ? input.deviceId.trim()
        : managedVmCreate
            ? admittedDeviceId || ""
            : command === "device_create"
            ? defaultDeviceIdForBackend(backend, String(create?.name || "device"))
            : "";
    if (!deviceId || deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId)) {
        return { ok: false, status: 400, error: "invalid-device-id" };
    }
    const dryRun = input.dryRun === true;
    return {
        ok: true,
        backend,
        stateKey,
        command,
        deviceId,
        force: input.force === true,
        ...(typeof input.startIfStopped === "boolean" ? { startIfStopped: input.startIfStopped } : {}),
        dryRun,
        ...(typeof input.headless === "boolean" ? { headless: input.headless } : {}),
        ...(typeof input.minimized === "boolean" ? { minimized: input.minimized } : {}),
        ...(typeof input.waitForBoot === "boolean" ? { waitForBoot: input.waitForBoot } : {}),
        ...(typeof input.bootTimeoutMs === "number" && Number.isFinite(input.bootTimeoutMs) ? { bootTimeoutMs: input.bootTimeoutMs } : {}),
        ...(typeof input.deleteAvd === "boolean" ? { deleteAvd: input.deleteAvd } : {}),
        ...(typeof input.deleteSimulator === "boolean" ? { deleteSimulator: input.deleteSimulator } : {}),
        ...(isHyperVBackend(backend)
            && command === "device_delete"
            && typeof input.preserveNetwork === "boolean"
            ? { preserveNetwork: input.preserveNetwork }
            : {}),
        ...(create ? { create } : {}),
    };
}

function admitCommandParams(params: unknown): CommandParamError | CommandParamSuccess {
    const validated = validateCommandParams(params, "vm-admission");
    if (!validated.ok || validated.command !== "device_create"
        || (!isHyperVBackend(validated.backend) && validated.backend !== "macos-vm")) return validated;
    return { ...validated, deviceId: `${validated.backend === "macos-vm" ? "macos" : validated.backend}-${randomUUID()}` };
}

function commandParamError(parsed: CommandParamError) {
    return {
        status: parsed.status,
        payload: {
            ok: false,
            error: parsed.error,
            ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
            ...(parsed.detail ? { detail: parsed.detail } : {}),
        },
    };
}

function javaHomeForAppium(normalized: NormalizedBrokerOptions) {
    if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
    const javaName = normalized.platform === "win32" ? "java.exe" : "java";
    const candidates = normalized.platform === "win32"
        ? [
            process.env.ProgramFiles ? join(process.env.ProgramFiles, "Android", "Android Studio", "jbr") : "",
            process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Android Studio", "jbr") : "",
        ]
        : normalized.platform === "darwin"
            ? ["/Applications/Android Studio.app/Contents/jbr/Contents/Home"]
            : ["/opt/android-studio/jbr"];
    for (const candidate of candidates.filter(Boolean)) {
        if (existsSync(join(candidate, "bin", javaName))) return candidate;
    }
    const java = resolveExecutablePath(javaName);
    return java && existsSync(java) ? dirname(dirname(java)) : null;
}

export function windowsHiddenChildProcessPreloadScript() {
    return [
        '"use strict";',
        'const childProcess = require("node:child_process");',
        'const { syncBuiltinESMExports } = require("node:module");',
        'const marker = Symbol.for("ccc.windowsHiddenChildProcesses");',
        'if (!childProcess[marker]) {',
        '  const hidden = (options) => ({ ...(options && typeof options === "object" ? options : {}), windowsHide: true });',
        '  const spawn = childProcess.spawn;',
        '  childProcess.spawn = function(command, args, options) {',
        '    return Array.isArray(args) ? spawn.call(this, command, args, hidden(options)) : spawn.call(this, command, hidden(args));',
        '  };',
        '  const spawnSync = childProcess.spawnSync;',
        '  childProcess.spawnSync = function(command, args, options) {',
        '    return Array.isArray(args) ? spawnSync.call(this, command, args, hidden(options)) : spawnSync.call(this, command, hidden(args));',
        '  };',
        '  const exec = childProcess.exec;',
        '  childProcess.exec = function(command, options, callback) {',
        '    return typeof options === "function" ? exec.call(this, command, hidden(), options) : exec.call(this, command, hidden(options), callback);',
        '  };',
        '  const execSync = childProcess.execSync;',
        '  childProcess.execSync = function(command, options) { return execSync.call(this, command, hidden(options)); };',
        '  const execFile = childProcess.execFile;',
        '  childProcess.execFile = function(file, args, options, callback) {',
        '    if (!Array.isArray(args)) return typeof args === "function" ? execFile.call(this, file, hidden(), args) : execFile.call(this, file, [], hidden(args), options);',
        '    return typeof options === "function" ? execFile.call(this, file, args, hidden(), options) : execFile.call(this, file, args, hidden(options), callback);',
        '  };',
        '  const execFileSync = childProcess.execFileSync;',
        '  childProcess.execFileSync = function(file, args, options) {',
        '    return Array.isArray(args) ? execFileSync.call(this, file, args, hidden(options)) : execFileSync.call(this, file, [], hidden(args));',
        '  };',
        '  const fork = childProcess.fork;',
        '  childProcess.fork = function(modulePath, args, options) {',
        '    return Array.isArray(args) ? fork.call(this, modulePath, args, hidden(options)) : fork.call(this, modulePath, [], hidden(args));',
        '  };',
        '  Object.defineProperty(childProcess, marker, { value: true });',
        '  syncBuiltinESMExports();',
        '}',
        '',
    ].join("\n");
}

function ensureBrokerLauncherDirectory(directory: string): void {
    const root = resolve(brokerRoot());
    const target = resolve(directory);
    const child = relative(root, target);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new Error("windows-provider-launcher-path-outside-root");
    }
    const segments = child ? child.split(sep) : [];
    let current = root;
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        for (const segment of ["", ...segments]) {
            if (segment) {
                current = join(current, segment);
                try {
                    mkdirSync(current, { mode: 0o700 });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                }
            }
            const stat = lstatSync(current);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("windows-provider-launcher-directory-invalid");
        }
    } catch (error) {
        if (error instanceof Error && error.message === "windows-provider-launcher-directory-invalid") throw error;
        throw new Error("windows-provider-launcher-directory-unavailable");
    }
}

function createExclusiveBrokerLauncher(directory: string, prefix: string, extension: string, content: string): string {
    ensureBrokerLauncherDirectory(directory);
    const bytes = Buffer.from(content, "utf8");
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const path = join(directory, `${prefix}-${randomBytes(16).toString("hex")}.${extension}`);
        let descriptor: number | null = null;
        try {
            descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
            let offset = 0;
            while (offset < bytes.length) {
                const count = writeSync(descriptor, bytes, offset, bytes.length - offset);
                if (count <= 0) throw new Error("windows-provider-launcher-write-failed");
                offset += count;
            }
            try { fchmodSync(descriptor, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
            const opened = fstatSync(descriptor);
            const current = lstatSync(path);
            ensureBrokerLauncherDirectory(directory);
            if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.nlink !== 1 || current.nlink !== 1
                || opened.size !== bytes.length || current.size !== bytes.length
                || (opened.dev !== 0 && current.dev !== 0 && opened.dev !== current.dev)
                || (opened.ino !== 0 && current.ino !== 0 && opened.ino !== current.ino)) {
                throw new Error("windows-provider-launcher-file-invalid");
            }
            closeSync(descriptor);
            descriptor = null;
            return path;
        } catch (error) {
            if (descriptor !== null) closeSync(descriptor);
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            if (error instanceof Error && error.message.startsWith("windows-provider-launcher-")) throw error;
            throw new Error("windows-provider-launcher-create-failed");
        }
    }
    throw new Error("windows-provider-launcher-create-failed");
}

function brokerLauncherMatches(path: string, content: string): boolean {
    try {
        assertDeviceLabPathWithinRoot(brokerRoot(), path, "windows-provider-launcher");
        ensureBrokerLauncherDirectory(dirname(path));
        return readDeviceLabTextFile(path, "windows-provider-launcher", Buffer.byteLength(content) + 1) === content;
    } catch {
        return false;
    }
}

let cachedWindowsHiddenPreload: { root: string; path: string; content: string } | null = null;

function windowsHiddenChildProcessPreloadPath() {
    const content = windowsHiddenChildProcessPreloadScript();
    const root = resolve(brokerRoot());
    if (cachedWindowsHiddenPreload?.root === root
        && cachedWindowsHiddenPreload.content === content
        && brokerLauncherMatches(cachedWindowsHiddenPreload.path, content)) {
        return cachedWindowsHiddenPreload.path;
    }
    const path = createExclusiveBrokerLauncher(join(root, "broker", "launchers"), "hidden-child-processes", "cjs", content);
    cachedWindowsHiddenPreload = { root, path, content };
    return path;
}

function appendNodeRequireOption(nodeOptions: string | undefined, preloadPath: string) {
    const normalizedPath = preloadPath.replace(/\\/g, "/").replace(/"/g, '\\"');
    if (nodeOptions?.includes(normalizedPath)) return nodeOptions.trim();
    return [nodeOptions?.trim(), `--require="${normalizedPath}"`].filter(Boolean).join(" ");
}

export function hiddenProviderCommandEnv(env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform = process.platform) {
    if (platform !== "win32") return env;
    const merged = { ...(env || {}) };
    merged.NODE_OPTIONS = appendNodeRequireOption(merged.NODE_OPTIONS ?? process.env.NODE_OPTIONS, windowsHiddenChildProcessPreloadPath());
    return merged;
}

function appiumCommandEnv(backend: string, normalized: NormalizedBrokerOptions) {
    const env: NodeJS.ProcessEnv = {};
    if (normalized.platform === "win32") {
        env.NODE_OPTIONS = hiddenProviderCommandEnv(undefined, normalized.platform)?.NODE_OPTIONS;
    }
    if (backend.startsWith("android")) {
        const adb = providerExecutable("adb", normalized);
        const discoveredSdkRoot = adb && basename(dirname(adb)).toLowerCase() === "platform-tools"
            ? dirname(dirname(adb))
            : null;
        const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || discoveredSdkRoot;
        if (sdkRoot) {
            env.ANDROID_HOME = sdkRoot;
            env.ANDROID_SDK_ROOT = sdkRoot;
        }
        const javaHome = javaHomeForAppium(normalized);
        if (javaHome) env.JAVA_HOME = javaHome;
    }
    return Object.keys(env).length > 0 ? env : undefined;
}

async function readBoundedAppiumResponse(response: Response) {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        return {
            ok: false as const,
            error: "appium-response-too-large",
            declaredBytes: Number(declaredLength),
            maxBytes: DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES,
        };
    }
    if (!response.body) return { ok: true as const, text: "", bytes: 0 };

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES) {
                await reader.cancel().catch(() => undefined);
                return {
                    ok: false as const,
                    error: "appium-response-too-large",
                    receivedBytes: total,
                    maxBytes: DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES,
                };
            }
            chunks.push(Buffer.from(value));
        }
        return { ok: true as const, text: Buffer.concat(chunks, total).toString("utf8"), bytes: total };
    } finally {
        reader.releaseLock();
    }
}

async function fetchAppiumJson(url: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(DEVICE_BROKER_APPIUM_FETCH_MAX_TIMEOUT_MS, Math.max(1, options.timeoutMs || DEVICE_BROKER_COMMAND_TIMEOUT_MS)));
    try {
        const response = await fetch(url, {
            method: options.method || "GET",
            signal: controller.signal,
            redirect: "manual",
            headers: options.body === undefined ? undefined : { "content-type": "application/json" },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => undefined);
            return {
                ok: false,
                status: response.status,
                body: { error: "appium-redirect-disallowed" },
            };
        }
        const bounded = await readBoundedAppiumResponse(response);
        if (!bounded.ok) {
            return {
                ok: false,
                status: response.status,
                body: bounded,
            };
        }
        const text = bounded.text;
        let body: unknown = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = { raw: truncateOutput(text, DEVICE_BROKER_COMMAND_OUTPUT_LIMIT) };
        }
        return { ok: response.ok, status: response.status, body };
    } catch (error) {
        return {
            ok: false,
            status: null,
            body: {
                error: error instanceof Error && error.name === "AbortError" ? "timeout" : error instanceof Error ? error.message : String(error),
            },
        };
    } finally {
        clearTimeout(timer);
    }
}

export { appiumWebDriverRequestTimeoutMs } from "./device-lab/domain/broker-appium.js";


function verifyBrokerOwnedAppiumListener(appium: unknown, normalized: NormalizedBrokerOptions, parentRemainingMs?: () => number): BrokerAppiumVerification {
    const remainingMs = captureBrokerNativeRemainingMs(parentRemainingMs);
    const runtime = brokerOwnedAppiumRuntime(appium);
    const endpoint = brokerOwnedAppiumEndpoint(appium);
    if (!endpoint.ok) return { ...endpoint, runtime };
    const { port, serverUrl } = endpoint;
    if (!normalized.strictAppiumPortOwnership) {
        if (!brokerProcessRemainingMs(remainingMs)) return { ok: false, error: "appium-port-listener-unavailable", runtime, port, serverUrl };
        return port && serverUrl
            ? { ok: true, runtime, port, serverUrl, simulated: true }
            : { ok: false, error: "appium-runtime-metadata-incomplete", port, serverUrl };
    }
    if (!runtime || !port || !serverUrl) {
        return { ok: false, error: "appium-runtime-metadata-incomplete", port, serverUrl };
    }
    if (typeof runtime.runtimeId !== "string" || runtime.runtimeId.length === 0 || !runtime.processIdentity) {
        return { ok: false, error: "appium-runtime-process-identity-missing", runtime, port, serverUrl };
    }
    const observation = remainingMs
        ? inspectDeviceRuntimeProcessIdentity(runtime.processIdentity, runtime.pid, { remainingMs })
        : inspectDeviceRuntimeProcessIdentity(runtime.processIdentity, runtime.pid);
    if (observation.status !== "match") {
        return {
            ok: false,
            error: observation.status === "mismatch"
                ? "appium-runtime-process-identity-mismatch"
                : "appium-runtime-process-identity-unavailable",
            runtime,
            port,
            serverUrl,
            observation,
        };
    }
    if (!brokerProcessRemainingMs(remainingMs)) return { ok: false, error: "appium-port-listener-unavailable", runtime, port, serverUrl, observation };
    const listener = remainingMs
        ? normalized.portProcessResolver(port, normalized.platform, remainingMs)
        : normalized.portProcessResolver(port, normalized.platform);
    if (!listener) {
        return { ok: false, error: "appium-port-listener-unavailable", runtime, port, serverUrl, observation };
    }
    if (listener.pid !== runtime.pid) {
        return {
            ok: false,
            error: "appium-port-listener-identity-mismatch",
            runtime,
            port,
            serverUrl,
            observation,
            listener,
        };
    }
    if (!brokerProcessRemainingMs(remainingMs)) return { ok: false, error: "appium-port-listener-unavailable", runtime, port, serverUrl, observation, listener };
    return { ok: true, runtime, port, serverUrl, observation, listener };
}

export function windowsProcessTreeOutcome(status: number | null, output: string, aliveAfter: boolean) {
    const stale = !aliveAfter || /not found|no running instance|not recognized/i.test(output);
    return {
        ok: status === 0 || stale,
        stale,
    };
}

function terminateWindowsProcessTree(
    pid: number,
    expectedIdentity?: DeviceRuntimeProcessIdentity,
    forceTreeAttempt = false,
    expectedStartToken?: string,
    authorize: () => boolean = () => true,
    remainingMs?: () => number,
) {
    const hasTime = () => brokerProcessRemainingMs(remainingMs) > 0;
    const exhausted = () => ({ attempted: false, ok: false, stale: false, pid, signal: "SIGTERM" as const, status: null, error: "runtime-process-identity-unavailable" });
    if (!hasTime()) return exhausted();
    if (expectedIdentity) {
        const observation = inspectDeviceRuntimeProcessIdentity(expectedIdentity, pid, { remainingMs });
        if (observation.status === "exited" && !forceTreeAttempt) {
            return {
                attempted: false,
                ok: true,
                stale: true,
                pid,
                signal: "SIGTERM" as const,
                status: null,
                observation,
                error: undefined,
            };
        }
        if (observation.status !== "match") {
            return {
                attempted: false,
                ok: false,
                stale: false,
                pid,
                signal: "SIGTERM" as const,
                status: null,
                observation,
                error: observation.status === "mismatch"
                    ? "runtime-process-identity-mismatch"
                    : "runtime-process-identity-unavailable",
            };
        }
    }
    if (!forceTreeAttempt && probeDeviceRuntimeProcessLiveness(pid) === "exited") {
        return {
            attempted: false,
            ok: true,
            stale: true,
            pid,
            signal: "SIGTERM" as const,
            status: null,
            error: undefined,
        };
    }
    if (!hasTime()) return exhausted();
    if (expectedStartToken && readDeviceRuntimeProcessStartToken(pid, { platform: "win32", remainingMs }) !== expectedStartToken) {
        return {
            attempted: false,
            ok: false,
            stale: false,
            pid,
            signal: "SIGTERM" as const,
            status: null,
            error: "runtime-process-start-token-mismatch",
        };
    }
    if (!hasTime()) return exhausted();
    const startToken = expectedStartToken || expectedIdentity?.startToken;
    if (!startToken) {
        return {
            attempted: false,
            ok: false,
            stale: false,
            pid,
            signal: "SIGTERM" as const,
            status: null,
            error: "runtime-process-start-token-unavailable",
        };
    }
    if (!authorize()) return { attempted: false, ok: false, stale: false, pid, reason: "runtime-termination-not-authorized" };
    if (!hasTime()) return exhausted();
    const result = terminateWindowsProcessByStartToken(pid, startToken, 10000, undefined, remainingMs);
    return {
        attempted: true,
        ok: result.ok,
        stale: probeDeviceRuntimeProcessLiveness(pid) === "exited",
        pid,
        signal: "SIGTERM" as const,
        status: result.status,
        error: result.ok ? undefined : result.reason || result.error || `process handle termination exited ${result.status}`,
    };
}

export type BrokerProcessTreeCleanup = {
    attempted: boolean;
    ok: boolean;
    stale?: boolean;
    pid: number;
    signal: "SIGKILL";
    platform: NodeJS.Platform;
    error?: string;
};

type BrokerProcessTreeCleanupOptions = {
    platform?: NodeJS.Platform;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    terminateWindowsTree?: (pid: number) => { attempted?: boolean; ok: boolean; stale?: boolean; error?: string };
    expectedIdentity?: DeviceRuntimeProcessIdentity | null;
    readIdentity?: (pid: number) => DeviceRuntimeProcessIdentity | null;
    requireIdentity?: boolean;
    remainingMs?: () => number;
};

function brokerProcessRemainingMs(remainingMs?: () => number): number {
    if (!remainingMs) return Infinity;
    const remaining = remainingMs();
    return Number.isFinite(remaining) && remaining >= 1 ? Math.floor(remaining) : 0;
}

/** Terminates a process tree whose root was spawned by this broker invocation. */
export function terminateBrokerSpawnedProcessTree(
    pid: unknown,
    options: BrokerProcessTreeCleanupOptions = {},
): BrokerProcessTreeCleanup {
    const platform = options.platform || process.platform;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
        return { attempted: false, ok: false, pid: 0, signal: "SIGKILL", platform, error: "spawned-process-pid-missing" };
    }
    const exhausted = () => ({ attempted: false, ok: false, pid, signal: "SIGKILL" as const, platform, error: "spawned-process-identity-unavailable" });
    if (!brokerProcessRemainingMs(options.remainingMs)) return exhausted();
    if (options.requireIdentity) {
        if (!options.expectedIdentity) {
            return { attempted: false, ok: false, pid, signal: "SIGKILL", platform, error: "spawned-process-identity-missing" };
        }
        const observation = inspectDeviceRuntimeProcessIdentity(options.expectedIdentity, pid, {
            platform,
            ...(options.readIdentity ? { readIdentity: options.readIdentity } : {}),
            remainingMs: options.remainingMs,
        });
        if (observation.status === "exited") {
            return { attempted: false, ok: true, stale: true, pid, signal: "SIGKILL", platform };
        }
        if (observation.status !== "match") {
            return {
                attempted: false,
                ok: false,
                pid,
                signal: "SIGKILL",
                platform,
                error: observation.status === "mismatch"
                    ? "spawned-process-identity-mismatch"
                    : "spawned-process-identity-unavailable",
            };
        }
    }
    if (!brokerProcessRemainingMs(options.remainingMs)) return exhausted();
    if (platform === "win32") {
        const outcome = (options.terminateWindowsTree || ((value: number) => terminateWindowsProcessTree(
            value,
            options.expectedIdentity || undefined,
            true,
            options.expectedIdentity?.startToken,
            undefined,
            options.remainingMs,
        )))(pid);
        return {
            attempted: outcome.attempted !== false,
            ok: outcome.ok,
            ...(outcome.stale === true ? { stale: true } : {}),
            pid,
            signal: "SIGKILL",
            platform,
            ...(outcome.error ? { error: outcome.error } : {}),
        };
    }
    try {
        // Backend/provider wrappers are spawned as POSIX process-group leaders.
        (options.kill || process.kill)(-pid, "SIGKILL");
        return { attempted: true, ok: true, pid, signal: "SIGKILL", platform };
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : null;
        return {
            attempted: true,
            ok: code === "ESRCH",
            ...(code === "ESRCH" ? { stale: true } : {}),
            pid,
            signal: "SIGKILL",
            platform,
            ...(code === "ESRCH" ? {} : { error: error instanceof Error ? error.message : String(error) }),
        };
    }
}

type BrokerProcessTreeCleanupAsyncOptions = Omit<BrokerProcessTreeCleanupOptions, "readIdentity" | "terminateWindowsTree"> & {
    readIdentity?: (pid: number) => DeviceRuntimeProcessIdentity | null | PromiseLike<DeviceRuntimeProcessIdentity | null>;
    terminateWindowsTree?: (pid: number) => { attempted?: boolean; ok: boolean; stale?: boolean; error?: string } | PromiseLike<{ attempted?: boolean; ok: boolean; stale?: boolean; error?: string }>;
};

/** Await exact native identity/termination without blocking the broker event loop. */
export async function terminateBrokerSpawnedProcessTreeAsync(
    pid: unknown,
    options: BrokerProcessTreeCleanupAsyncOptions = {},
): Promise<BrokerProcessTreeCleanup> {
    const platform = options.platform || process.platform;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
        return { attempted: false, ok: false, pid: 0, signal: "SIGKILL", platform, error: "spawned-process-pid-missing" };
    const exhausted = (): BrokerProcessTreeCleanup => ({ attempted: false, ok: false, pid, signal: "SIGKILL", platform, error: "spawned-process-identity-unavailable" });
    if (!brokerProcessRemainingMs(options.remainingMs)) return exhausted();
    if (options.requireIdentity) {
        if (!options.expectedIdentity)
            return { attempted: false, ok: false, pid, signal: "SIGKILL", platform, error: "spawned-process-identity-missing" };
        const observation = await inspectDeviceRuntimeProcessIdentityAsync(options.expectedIdentity, pid, {
            platform, ...(options.readIdentity ? { readIdentity: options.readIdentity } : {}), remainingMs: options.remainingMs,
        });
        if (observation.status === "exited")
            return { attempted: false, ok: true, stale: true, pid, signal: "SIGKILL", platform };
        if (observation.status !== "match")
            return { attempted: false, ok: false, pid, signal: "SIGKILL", platform,
                error: observation.status === "mismatch" ? "spawned-process-identity-mismatch" : "spawned-process-identity-unavailable" };
    }
    if (!brokerProcessRemainingMs(options.remainingMs)) return exhausted();
    if (platform === "win32") {
        const outcome = await (options.terminateWindowsTree || ((value: number) => terminateWindowsProcessTreeAsync(
            value, options.expectedIdentity || undefined, true, options.expectedIdentity?.startToken, undefined, options.remainingMs,
        )))(pid);
        return {
            attempted: outcome.attempted !== false, ok: outcome.ok,
            ...(outcome.stale === true ? { stale: true } : {}), pid, signal: "SIGKILL", platform,
            ...("error" in outcome && outcome.error ? { error: outcome.error } : {}),
        };
    }
    try {
        (options.kill || process.kill)(-pid, "SIGKILL");
        return { attempted: true, ok: true, pid, signal: "SIGKILL", platform };
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : null;
        return { attempted: true, ok: code === "ESRCH", ...(code === "ESRCH" ? { stale: true } : {}), pid, signal: "SIGKILL", platform,
            ...(code === "ESRCH" ? {} : { error: error instanceof Error ? error.message : String(error) }) };
    }
}

function windowsBrokerPortProcessProbeScript(pid: number): string {
    return [
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
        `$h = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
        "if (-not $p -or -not $h) { exit 1 }",
        `[pscustomobject]@{ pid = [int]$p.ProcessId; commandLine = [string]$p.CommandLine; startToken = ${windowsStartTokenExpression("$h")} } | ConvertTo-Json -Compress`,
    ].join("; ");
}

function parseWindowsBrokerPortProcessProbe(listener: BrokerPortProcess, output: string): BrokerPortProcess | null {
    try {
        const parsed = JSON.parse(output) as { pid?: unknown; commandLine?: unknown; startToken?: unknown };
        const pid = Number(parsed.pid);
        const commandLine = typeof parsed.commandLine === "string" ? parsed.commandLine.replace(/\r?\n/g, " ").trim() : "";
        const startToken = typeof parsed.startToken === "string" ? `windows:${parsed.startToken}` : "";
        if (pid === listener.pid && commandLine && startToken) {
            const processIdentity = { pid, startToken, commandHash: createHash("sha256").update(commandLine).digest("hex") };
            return { pid, commandLine, processIdentity, processStartToken: startToken };
        }
    } catch {
        // Fall through to the locale-independent netstat listener lookup.
    }
    return null;
}

async function discoverWindowsBrokerPortProcessAsync(port: number, parentRemainingMs?: () => number): Promise<BrokerPortProcess | null> {
    const remainingMs = captureBrokerNativeRemainingMs(parentRemainingMs);
    if (!brokerProcessRemainingMs(remainingMs)) return null;
    const netstatPath = await canonicalWindowsSystemExecutablePathAsync("netstat.exe");
    const netstatTimeout = Math.min(5000, brokerProcessRemainingMs(remainingMs));
    if (!netstatTimeout) return null;
    const netstat = netstatPath ? await defaultProviderCommandRunnerAsync({
        mode: "exec", provider: "process-inventory", executable: netstatPath, args: ["-ano", "-p", "tcp"],
    }, {
        timeoutMs: netstatTimeout, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        ...(remainingMs ? { remainingMs } : {}),
    }) : { status: null, stdout: "" };
    if (!brokerProcessRemainingMs(remainingMs)) return null;
    const listener = netstat.status === 0 ? parseWindowsBrokerNetstatListenerForTest(netstat.stdout || "", port) : null;
    if (!listener) return null;
    const powershell = await canonicalWindowsPowerShellPathAsync();
    const timeout = Math.min(10000, brokerProcessRemainingMs(remainingMs));
    if (!timeout) return listener;
    const result = powershell ? await defaultProviderCommandRunnerAsync({
        mode: "exec", provider: "process-inventory", executable: powershell,
        args: hiddenWindowsPowerShellArgs(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsBrokerPortProcessProbeScript(listener.pid)]),
    }, {
        timeoutMs: timeout, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        ...(remainingMs ? { remainingMs } : {}),
    }) : { status: null, stdout: "" };
    if (!brokerProcessRemainingMs(remainingMs)) return listener;
    if (result.status === 0 && result.stdout) {
        const observed = parseWindowsBrokerPortProcessProbe(listener, result.stdout);
        if (observed) return observed;
    }
    const processIdentity = await readDeviceRuntimeProcessIdentityAsync(listener.pid, { platform: "win32", ...(remainingMs ? { remainingMs } : {}) });
    if (!brokerProcessRemainingMs(remainingMs)) return listener;
    return { ...listener, processIdentity, processStartToken: processIdentity?.startToken ?? null };
}

async function terminateWindowsProcessTreeAsync(
    pid: number,
    expectedIdentity?: DeviceRuntimeProcessIdentity,
    forceTreeAttempt = false,
    expectedStartToken?: string,
    authorize: () => boolean = () => true,
    remainingMs?: () => number,
) {
    const hasTime = () => brokerProcessRemainingMs(remainingMs) > 0;
    const exhausted = () => ({ attempted: false, ok: false, stale: false, pid, signal: "SIGTERM" as const, status: null, error: "runtime-process-identity-unavailable" });
    const unauthorized = () => ({ attempted: false, ok: false, stale: false, pid, reason: "runtime-termination-not-authorized" });
    if (!hasTime()) return exhausted();
    // Async callers carry the complete saved incarnation. Legacy token-only
    // callers keep the synchronous entry; a token alone does not admit this path.
    if (!expectedIdentity) return {
        attempted: false, ok: false, stale: false, pid, signal: "SIGTERM" as const,
        status: null, error: "runtime-process-start-token-unavailable",
    };
    const observation = await inspectDeviceRuntimeProcessIdentityAsync(expectedIdentity, pid, { platform: "win32", remainingMs });
    if (!authorize()) return unauthorized();
    if (!hasTime()) return exhausted();
    if (observation.status === "exited" && !forceTreeAttempt) return {
        attempted: false, ok: true, stale: true, pid, signal: "SIGTERM" as const,
        status: null, observation, error: undefined,
    };
    if (observation.status !== "match") return {
        attempted: false, ok: false, stale: false, pid, signal: "SIGTERM" as const, status: null, observation,
        error: observation.status === "mismatch" ? "runtime-process-identity-mismatch" : "runtime-process-identity-unavailable",
    };
    if (!forceTreeAttempt && probeDeviceRuntimeProcessLiveness(pid) === "exited") return {
        attempted: false, ok: true, stale: true, pid, signal: "SIGTERM" as const, status: null, error: undefined,
    };
    if (!hasTime()) return exhausted();
    if (expectedStartToken && observation.current?.startToken !== expectedStartToken) return {
        attempted: false, ok: false, stale: false, pid, signal: "SIGTERM" as const,
        status: null, error: "runtime-process-start-token-mismatch",
    };
    const startToken = expectedStartToken || expectedIdentity.startToken;
    if (!startToken) return {
        attempted: false, ok: false, stale: false, pid, signal: "SIGTERM" as const,
        status: null, error: "runtime-process-start-token-unavailable",
    };
    if (!authorize()) return unauthorized();
    if (!hasTime()) return exhausted();
    // The native helper awaits trusted executable resolution before signalling.
    // Its later allowance check must recheck authority, not only elapsed time.
    const nativeRemainingMs = captureBrokerNativeRemainingMs(() => authorize()
        ? Math.min(11000, brokerProcessRemainingMs(remainingMs)) : 0)!;
    const result = await terminateWindowsProcessByStartTokenAsync(pid, startToken, 10000, undefined, nativeRemainingMs);
    const authorized = authorize();
    const stale = probeDeviceRuntimeProcessLiveness(pid) === "exited";
    return {
        attempted: true, ok: result.ok && authorized, stale, pid, signal: "SIGTERM" as const,
        status: result.status,
        ...(!authorized ? { reason: "runtime-termination-not-authorized" } : {}),
        error: result.ok && authorized ? undefined : !authorized ? "runtime-termination-not-authorized"
            : result.reason || result.error || `process handle termination exited ${result.status}`,
    };
}

async function terminateBrokerOwnedAppiumAsync(appium: unknown, normalized?: NormalizedBrokerOptions, stillCurrent: () => boolean = () => true) {
    if (!stillCurrent()) return { attempted: false, ok: false, reason: "owner-device-state-conflict" };
    const runtime = brokerOwnedAppiumRuntime(appium);
    if (!runtime) return { attempted: false, ok: true };
    if (normalized && !normalized.usesDefaultCommandRunner)
        return { attempted: false, ok: true, simulated: true, reason: "injected-command-runner" };
    const remainingMs = normalized?.cleanupDeadlineAt !== undefined
        ? captureBrokerNativeRemainingMs(() => cleanupExitBudget(normalized, normalized.commandTimeoutMs)) : undefined;
    const authorized = () => stillCurrent() && brokerProcessRemainingMs(remainingMs) > 0;
    if (!authorized()) return { attempted: false, ok: false, reason: "runtime-termination-not-authorized" };
    if (runtime.processIdentity != null && (!cleanupRecord(runtime.processIdentity) || runtime.processIdentity.pid !== runtime.pid))
        return { attempted: false, ok: false, reason: "runtime-process-identity-unavailable" };
    if (typeof runtime.runtimeId !== "string" || !runtime.processIdentity) {
        const liveness = probeDeviceRuntimeProcessLiveness(runtime.pid);
        if (liveness === "exited") return { attempted: false, ok: true, stale: true, reason: "runtime-process-exited" };
        return {
            attempted: false, ok: false,
            reason: liveness === "alive" ? "runtime-process-identity-missing" : "runtime-process-identity-unavailable", liveness,
        };
    }
    const serverPid = runtime.pid;
    if (!cleanupRecord(runtime.processIdentity) || runtime.processIdentity.pid !== serverPid)
        return { attempted: false, ok: false, reason: "runtime-process-identity-unavailable" };
    if (process.platform === "win32") {
        const port = brokerOwnedAppiumPort(appium);
        const listener = port ? await discoverWindowsBrokerPortProcessAsync(port, () => authorized()
            ? Math.min(Number.MAX_SAFE_INTEGER, brokerProcessRemainingMs(remainingMs)) : 0) : null;
        if (!authorized()) return { attempted: false, ok: false, reason: "runtime-termination-not-authorized" };
        const listenerIsManagedAppium = normalized && listener?.commandLine
            ? managedAppiumCommandLine(listener.commandLine, packageRootForBroker(), brokerAppiumRuntimeRoot()) : false;
        const separateManagedListener = listenerIsManagedAppium && listener && listener.pid !== serverPid ? listener : null;
        const listenerIdentity = separateManagedListener
            ? await readDeviceRuntimeProcessIdentityAsync(separateManagedListener.pid, { remainingMs }) : null;
        if (!authorized()) return { attempted: false, ok: false, reason: "runtime-termination-not-authorized" };
        if (separateManagedListener && !listenerIdentity) return {
            attempted: false, ok: false, error: "appium-listener-process-identity-unavailable",
            listener: separateManagedListener, listenerPort: port,
        };
        const processTree = await terminateWindowsProcessTreeAsync(serverPid, runtime.processIdentity as DeviceRuntimeProcessIdentity,
            false, undefined, authorized, remainingMs);
        if (!authorized()) return { ...processTree, ok: false, reason: "runtime-termination-not-authorized" };
        if (!processTree.ok) {
            const ended = await waitForExpectedRuntimeExitAsync(runtime.processIdentity,
                normalized ? cleanupExitBudget(normalized, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS) : DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS,
                normalized ? { now: normalized.hyperVMonotonicNow } : {}) === "ended";
            if (!authorized()) return { ...processTree, ok: false, reason: "runtime-termination-not-authorized" };
            // A listener discovered on the port is never independently owned.
            return ended && !separateManagedListener ? { ...processTree, ok: true, stale: true } : processTree;
        }
        if (separateManagedListener && !processTree.attempted)
            return { ...processTree, ok: false, reason: "appium-listener-runtime-unverified" };
        const listenerEnded = listenerIdentity && separateManagedListener
            ? await waitForExpectedRuntimeExitAsync(listenerIdentity,
                normalized ? cleanupExitBudget(normalized, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS) : DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS,
                normalized ? { now: normalized.hyperVMonotonicNow } : {}) === "ended" : true;
        if (!authorized()) return { ...processTree, ok: false, reason: "runtime-termination-not-authorized" };
        const listenerTree = separateManagedListener ? {
            attempted: false, ok: listenerEnded, pid: separateManagedListener.pid,
            ...(!listenerEnded ? { reason: "appium-listener-runtime-unverified" } : {}),
        } : null;
        return {
            ...processTree, ok: processTree.ok && (!listenerTree || listenerTree.ok), processTree,
            ...(listenerTree ? { listenerTree, listenerPort: port } : {}),
        };
    }
    return signalDeviceRuntimeProcessAsync(runtime, "SIGTERM", { remainingMs, kill: (pid, signal) => {
        if (!authorized()) throw new Error("runtime-termination-not-authorized");
        process.kill(pid, signal);
    } });
}

async function cleanupAppiumTerminationAsync(appium: unknown, normalized: NormalizedBrokerOptions, stillCurrent: () => boolean): Promise<CleanupTermination> {
    const refused = (reason: string): CleanupTermination => ({ ok: false, ended: false, receipt: { attempted: false, ok: false, reason } });
    const authorized = () => cleanupExitBudget(normalized, 1) > 0 && stillCurrent();
    if (cleanupExitBudget(normalized, 1) <= 0) return refused("cleanup-operation-deadline-exceeded");
    if (!stillCurrent()) return refused("owner-device-state-conflict");
    const runtime = brokerOwnedAppiumRuntime(appium);
    if (!runtime) {
        const associationOnly = cleanupRecord(appium) && appium.serverPid == null && appium.pid == null
            && appium.processIdentity == null && appium.processOwner == null && appium.startedBy == null
            && (typeof appium.sessionId === "string" || typeof appium.serverUrl === "string");
        return associationOnly ? { ok: true, ended: true, receipt: { attempted: false, ok: true } } : refused("runtime-process-metadata-unverified");
    }
    const receipt = await terminateBrokerOwnedAppiumAsync(appium, normalized, authorized);
    if (!stillCurrent()) return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "owner-device-state-conflict" } };
    if (cleanupExitBudget(normalized, 1) <= 0) return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "cleanup-operation-deadline-exceeded" } };
    if (!normalized.usesDefaultCommandRunner) return { ok: receipt.ok, ended: receipt.ok, receipt };
    if ("stale" in receipt && receipt.stale === true && receipt.ok) return { ok: true, ended: true, receipt };
    if (!cleanupRecord(runtime.processIdentity) || runtime.processIdentity.pid !== runtime.pid)
        return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "runtime-process-identity-unavailable" } };
    if (process.platform === "win32" && !receipt.ok) return { ok: false, ended: false, receipt };
    if (process.platform === "win32" && "processTree" in receipt && receipt.ok) return { ok: true, ended: true, receipt };
    const observed = await waitForExpectedRuntimeExitAsync(runtime.processIdentity,
        cleanupExitBudget(normalized, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS), { now: normalized.hyperVMonotonicNow });
    if (!stillCurrent()) return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "owner-device-state-conflict" } };
    if (cleanupExitBudget(normalized, 1) <= 0) return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "cleanup-operation-deadline-exceeded" } };
    if (observed === "ended") return { ok: true, ended: true, receipt: { ...receipt, ok: true } };
    if (!receipt.ok || observed !== "still-running") return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "runtime-process-exit-unverified" } };
    if (!authorized() || cleanupExitBudget(normalized, 500) < 500)
        return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "runtime-termination-not-authorized" } };
    const force = await signalDeviceRuntimeProcessAsync(runtime, "SIGKILL", {
        remainingMs: () => cleanupExitBudget(normalized, 500), kill: (pid, signal) => {
            if (!authorized()) throw new Error("runtime-termination-not-authorized");
            process.kill(pid, signal);
        },
    });
    if (!authorized()) return { ok: false, ended: false, receipt: { ...receipt, ok: false, force, reason: "runtime-termination-not-authorized" } };
    const ended = force.ok && await waitForExpectedRuntimeExitAsync(runtime.processIdentity,
        cleanupExitBudget(normalized, 500), { now: normalized.hyperVMonotonicNow }) === "ended";
    if (!authorized()) return { ok: false, ended: false, receipt: { ...receipt, ok: false, force, reason: "runtime-termination-not-authorized" } };
    return { ok: ended, ended, receipt: { ...receipt, ok: ended, force, ...(!ended ? { reason: "runtime-process-exit-unverified" } : {}) } };
}

async function cleanupRecordingTerminationAsync(recording: Record<string, unknown>, normalized: NormalizedBrokerOptions, stillCurrent: () => boolean): Promise<CleanupTermination> {
    const authorized = () => cleanupExitBudget(normalized, 1) > 0 && stillCurrent();
    if (cleanupExitBudget(normalized, 1) <= 0) return { ok: false, ended: false, receipt: { attempted: false, ok: false, reason: "cleanup-operation-deadline-exceeded" } };
    if (!stillCurrent()) return { ok: false, ended: false, receipt: { attempted: false, ok: false, reason: "owner-device-state-conflict" } };
    const owned = recording.authority === "host-broker" && recording.processOwner === "host-broker"
        && recording.startedBy === "broker.device.recording.start";
    const receipt = !owned ? { attempted: false, ok: false, reason: "recording-process-not-broker-owned" }
        : !normalized.usesDefaultCommandRunner ? { attempted: false, ok: true, simulated: true, reason: "injected-command-runner" }
            : await signalDeviceRuntimeProcessAsync(recording, "SIGINT", {
                remainingMs: () => cleanupExitBudget(normalized, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS), kill: (pid, signal) => {
                    if (!authorized()) throw new Error("runtime-termination-not-authorized");
                    process.kill(pid, signal);
                },
            });
    if (!stillCurrent()) return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "owner-device-state-conflict" } };
    if (cleanupExitBudget(normalized, 1) <= 0) return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "cleanup-operation-deadline-exceeded" } };
    if (!normalized.usesDefaultCommandRunner) return { ok: receipt.ok, ended: receipt.ok, receipt };
    if ("reason" in receipt && receipt.reason === "recording-process-not-broker-owned") return { ok: false, ended: false, receipt };
    if (!cleanupRecord(recording.processIdentity) || recording.processIdentity.pid !== recording.pid)
        return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "runtime-process-identity-unavailable" } };
    if ("stale" in receipt && receipt.stale === true && receipt.ok) return { ok: true, ended: true, receipt };
    const ended = await waitForExpectedRuntimeExitAsync(recording.processIdentity,
        cleanupExitBudget(normalized, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS), { now: normalized.hyperVMonotonicNow }) === "ended";
    if (!stillCurrent()) return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "owner-device-state-conflict" } };
    if (cleanupExitBudget(normalized, 1) <= 0) return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "cleanup-operation-deadline-exceeded" } };
    return { ok: ended, ended, receipt: { ...receipt, ok: ended, ...(!ended ? { reason: "runtime-process-exit-unverified" } : {}) } };
}

function normalizedWindowsCommandLine(value: string) {
    return value.replace(/\\/g, "/").toLowerCase();
}

export function managedAppiumCommandLine(commandLine: string, packageRoot: string, runtimeRoot: string, _brokerMetadata = false) {
    const normalizedCommandLine = normalizedWindowsCommandLine(commandLine);
    const normalizedPackageRoot = normalizedWindowsCommandLine(packageRoot);
    const normalizedRuntimeRoot = normalizedWindowsCommandLine(runtimeRoot);
    const appiumCommand = /(?:^|[\/])appium(?:[\/]|\.cmd|\.js|\s)/i.test(normalizedCommandLine);
    const managedPath = normalizedCommandLine.includes(normalizedRuntimeRoot)
        || normalizedCommandLine.includes(`${normalizedPackageRoot}/node_modules/appium`)
        || normalizedCommandLine.includes(`${normalizedPackageRoot}/appium-runtime/node_modules/appium`);
    return appiumCommand && managedPath;
}

function terminateManagedAppiumPortListener(port: number, normalized: NormalizedBrokerOptions) {
    if (!normalized.strictAppiumPortOwnership) return { attempted: false, ok: true, simulated: true };
    const listener = normalized.portProcessResolver(port, normalized.platform);
    if (!listener) return { attempted: false, ok: true };
    return {
        attempted: false,
        ok: false,
        blocked: true,
        error: "appium-port-occupied-after-allocation",
        port,
        listener,
    };
}

function terminateBrokerOwnedAppium(appium: unknown, normalized?: NormalizedBrokerOptions, stillCurrent: () => boolean = () => true) {
    if (!stillCurrent()) return { attempted: false, ok: false, reason: "owner-device-state-conflict" };
    const runtime = brokerOwnedAppiumRuntime(appium);
    if (!runtime) return { attempted: false, ok: true };
    if (normalized && !normalized.usesDefaultCommandRunner) {
        return { attempted: false, ok: true, simulated: true, reason: "injected-command-runner" };
    }
    if (runtime.processIdentity != null && (!cleanupRecord(runtime.processIdentity) || runtime.processIdentity.pid !== runtime.pid))
        return { attempted: false, ok: false, reason: "runtime-process-identity-unavailable" };
    if (typeof runtime.runtimeId !== "string" || !runtime.processIdentity) {
        const liveness = probeDeviceRuntimeProcessLiveness(runtime.pid);
        if (liveness === "exited") {
            return { attempted: false, ok: true, stale: true, reason: "runtime-process-exited" };
        }
        return {
            attempted: false,
            ok: false,
            reason: liveness === "alive" ? "runtime-process-identity-missing" : "runtime-process-identity-unavailable",
            liveness,
        };
    }
    const serverPid = runtime.pid;
    if (!cleanupRecord(runtime.processIdentity) || runtime.processIdentity.pid !== serverPid)
        return { attempted: false, ok: false, reason: "runtime-process-identity-unavailable" };
    if (process.platform === "win32") {
        const port = brokerOwnedAppiumPort(appium);
        const listener = port ? discoverWindowsBrokerPortProcess(port) : null;
        const listenerIsManagedAppium = normalized && listener?.commandLine
            ? managedAppiumCommandLine(listener.commandLine, packageRootForBroker(), brokerAppiumRuntimeRoot())
            : false;
        const separateManagedListener = listenerIsManagedAppium && listener && listener.pid !== serverPid ? listener : null;
        const listenerIdentity = separateManagedListener
            ? readDeviceRuntimeProcessIdentity(separateManagedListener.pid)
            : null;
        if (separateManagedListener && !listenerIdentity) {
            return {
                attempted: false,
                ok: false,
                error: "appium-listener-process-identity-unavailable",
                listener: separateManagedListener,
                listenerPort: port,
            };
        }
        const processTree = terminateWindowsProcessTree(serverPid, runtime.processIdentity as DeviceRuntimeProcessIdentity, false, undefined, stillCurrent);
        if (!processTree.ok) {
            const ended = waitForExpectedRuntimeExitSync(runtime.processIdentity,
                normalized ? cleanupExitBudget(normalized, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS) : DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS) === "ended";
            // Predecessor exit does not bind a newly discovered listener to that runtime.
            return ended && !separateManagedListener ? { ...processTree, ok: true, stale: true } : processTree;
        }
        if (separateManagedListener && !processTree.attempted)
            return { ...processTree, ok: false, reason: "appium-listener-runtime-unverified" };
        // The owned handle-tree operation terminates its verified descendants.
        // A process discovered on a port is not independently owned by this runtime.
        const listenerEnded = listenerIdentity && separateManagedListener
            ? waitForExpectedRuntimeExitSync(listenerIdentity,
                normalized ? cleanupExitBudget(normalized, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS) : DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS) === "ended"
            : true;
        const listenerTree = separateManagedListener ? { attempted: false, ok: listenerEnded, pid: separateManagedListener.pid,
            ...(!listenerEnded ? { reason: "appium-listener-runtime-unverified" } : {}) } : null;
        return {
            ...processTree,
            ok: processTree.ok && (!listenerTree || listenerTree.ok),
            processTree,
            ...(listenerTree ? { listenerTree, listenerPort: port } : {}),
        };
    }
    return signalDeviceRuntimeProcess(runtime, "SIGTERM", { kill: (pid, signal) => {
        if (!stillCurrent()) throw new Error("runtime-termination-not-authorized");
        process.kill(pid, signal);
    } });
}

async function terminateBrokerOwnedAppiumAndWait(appium: unknown, normalized: NormalizedBrokerOptions) {
    const pid = brokerOwnedAppiumPid(appium);
    const signal = terminateBrokerOwnedAppium(appium, normalized);
    if (!signal.ok) return { ...signal, exited: false, exitVerified: true };
    if (!pid || process.platform === "win32") {
        return { ...signal, exited: true, exitVerified: true };
    }
    if (!normalized.usesDefaultCommandRunner) {
        return { ...signal, exited: true, exitVerified: false };
    }
    if (await waitForProcessExit(pid, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS)) {
        return { ...signal, exited: true, exitVerified: true };
    }
    const runtime = brokerOwnedAppiumRuntime(appium);
    const force = runtime ? signalDeviceRuntimeProcess(runtime, "SIGKILL") : { attempted: false, ok: false, reason: "runtime-process-metadata-missing" };
    const exited = force.ok && await waitForProcessExit(pid, 500);
    return {
        ...signal,
        ok: exited,
        exited,
        exitVerified: true,
        force,
        ...(!exited ? { error: ("error" in force && force.error) || "appium-process-still-running" } : {}),
    };
}

function signalBrokerOwnedRecording(recording: Record<string, unknown>, normalized: NormalizedBrokerOptions, signal: NodeJS.Signals, authorize: () => boolean = () => true) {
    const owned = recording.authority === "host-broker"
        && recording.processOwner === "host-broker"
        && recording.startedBy === "broker.device.recording.start";
    if (!owned) return { attempted: false, ok: false, reason: "recording-process-not-broker-owned" };
    if (!normalized.usesDefaultCommandRunner) {
        return { attempted: false, ok: true, simulated: true, reason: "injected-command-runner" };
    }
    return signalDeviceRuntimeProcess(recording, signal, { kill: (pid, selectedSignal) => {
        if (!authorize()) throw new Error("runtime-termination-not-authorized");
        process.kill(pid, selectedSignal);
    } });
}


function cleanupExitBudget(normalized: NormalizedBrokerOptions, cap: number) {
    return Math.max(0, Math.min(cap, (normalized.cleanupDeadlineAt ?? Number.POSITIVE_INFINITY) - normalized.hyperVMonotonicNow()));
}

class CleanupOperationDeadlineError extends Error {
    constructor() { super("cleanup-operation-deadline-exceeded"); }
}
function assertCleanupDeadline(normalized: NormalizedBrokerOptions) {
    if (cleanupExitBudget(normalized, 1) <= 0) throw new CleanupOperationDeadlineError();
}
function runLifecycleEffect(normalized: NormalizedBrokerOptions, command: ProviderCommand, options: ProviderCommandRunnerOptions) {
    const execution = normalized.commandRunner(command, options);
    if (normalized.cleanupObservation) normalized.cleanupObservation.execution = execution;
    return execution;
}

function cleanupAppiumTermination(appium: unknown, normalized: NormalizedBrokerOptions, stillCurrent: () => boolean): CleanupTermination {
    const refused = (reason: string): CleanupTermination => ({ ok: false, ended: false, receipt: { attempted: false, ok: false, reason } });
    const authorized = () => cleanupExitBudget(normalized, 1) > 0 && stillCurrent();
    if (cleanupExitBudget(normalized, 1) <= 0) return refused("cleanup-operation-deadline-exceeded");
    if (!stillCurrent()) return refused("owner-device-state-conflict");
    const runtime = brokerOwnedAppiumRuntime(appium);
    if (!runtime) {
        // A session association without process metadata has no owned process to terminate.
        const associationOnly = cleanupRecord(appium) && appium.serverPid == null && appium.pid == null
            && appium.processIdentity == null && appium.processOwner == null && appium.startedBy == null
            && (typeof appium.sessionId === "string" || typeof appium.serverUrl === "string");
        return associationOnly ? { ok: true, ended: true, receipt: { attempted: false, ok: true } }
            : refused("runtime-process-metadata-unverified");
    }
    const receipt = terminateBrokerOwnedAppium(appium, normalized, authorized);
    if (!normalized.usesDefaultCommandRunner) return { ok: receipt.ok, ended: receipt.ok, receipt };
    if ("stale" in receipt && receipt.stale === true && receipt.ok)
        return { ok: true, ended: true, receipt };
    if (!cleanupRecord(runtime.processIdentity) || runtime.processIdentity.pid !== runtime.pid)
        return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "runtime-process-identity-unavailable" } };
    if (process.platform === "win32" && !receipt.ok) return { ok: false, ended: false, receipt };
    // The Windows handle-bound tree helper already waits for the verified process.
    if (process.platform === "win32" && "processTree" in receipt && receipt.ok)
        return { ok: true, ended: true, receipt };
    const observed = waitForExpectedRuntimeExitSync(runtime.processIdentity, cleanupExitBudget(normalized, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS));
    if (observed === "ended") return { ok: true, ended: true, receipt: { ...receipt, ok: true } };
    if (!receipt.ok || observed !== "still-running")
        return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "runtime-process-exit-unverified" } };
    if (!authorized() || cleanupExitBudget(normalized, 500) < 500) return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "runtime-termination-not-authorized" } };
    const force = signalDeviceRuntimeProcess(runtime, "SIGKILL", { kill: (pid, signal) => {
        if (!authorized()) throw new Error("runtime-termination-not-authorized");
        process.kill(pid, signal);
    } });
    const ended = force.ok && waitForExpectedRuntimeExitSync(runtime.processIdentity, cleanupExitBudget(normalized, 500)) === "ended";
    return { ok: ended, ended, receipt: { ...receipt, ok: ended, force, ...(!ended ? { reason: "runtime-process-exit-unverified" } : {}) } };
}

function cleanupRecordingTermination(recording: Record<string, unknown>, normalized: NormalizedBrokerOptions, stillCurrent: () => boolean): CleanupTermination {
    const authorized = () => cleanupExitBudget(normalized, 1) > 0 && stillCurrent();
    if (cleanupExitBudget(normalized, 1) <= 0) return { ok: false, ended: false, receipt: { attempted: false, ok: false, reason: "cleanup-operation-deadline-exceeded" } };
    if (!stillCurrent()) return { ok: false, ended: false, receipt: { attempted: false, ok: false, reason: "owner-device-state-conflict" } };
    const receipt = signalBrokerOwnedRecording(recording, normalized, "SIGINT", authorized);
    if (!normalized.usesDefaultCommandRunner) return { ok: receipt.ok, ended: receipt.ok, receipt };
    if ("reason" in receipt && receipt.reason === "recording-process-not-broker-owned") return { ok: false, ended: false, receipt };
    if (!cleanupRecord(recording.processIdentity) || recording.processIdentity.pid !== recording.pid)
        return { ok: false, ended: false, receipt: { ...receipt, ok: false, reason: "runtime-process-identity-unavailable" } };
    if ("stale" in receipt && receipt.stale === true && receipt.ok) return { ok: true, ended: true, receipt };
    const ended = waitForExpectedRuntimeExitSync(recording.processIdentity, cleanupExitBudget(normalized, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS)) === "ended";
    return { ok: ended, ended, receipt: { ...receipt, ok: ended, ...(!ended ? { reason: "runtime-process-exit-unverified" } : {}) } };
}

type PhysicalLeaseReleaseGuard = {
    attempted: boolean;
    parsed: LeaseParamSuccess | null;
    file: string | null;
    existing: Record<string, unknown> | null;
    preflight: BrokerRpcResult | null;
};

function withOwnerPhysicalLeaseReleaseGuard<T>(
    ownerId: string,
    stateKey: string,
    record: Record<string, unknown>,
    operation: (guard: PhysicalLeaseReleaseGuard) => T,
): T {
    const hardwareId = stateKey === "android-device"
        ? (typeof record.serial === "string" ? record.serial : "")
        : (typeof record.udid === "string" ? record.udid : "");
    if (!hardwareId) return operation({ attempted: false, parsed: null, file: null, existing: null, preflight: null });
    const parsed = validateLeaseParams({
        backend: stateKey,
        hardwareId,
        deviceId: record.id,
        claimId: record.leaseClaimId,
        claimNonce: record.leaseClaimNonce,
    }, "release");
    if (!parsed.ok) {
        return operation({ attempted: true, parsed: null, file: null, existing: null, preflight: leaseParamError(parsed) });
    }
    const file = physicalLeaseLockFile(parsed.backend, parsed.hardwareId);
    return withSharedMutationLock(physicalLeaseMutationLockFile(parsed.backend, parsed.hardwareId), () => {
        const existing = readLeaseFile(file, parsed.backend, parsed.hardwareId);
        return operation({
            attempted: true,
            parsed,
            file,
            existing,
            preflight: physicalLeaseReleaseConflict(ownerId, parsed, existing),
        });
    });
}

function cleanupOwnerPhysicalLease(ownerId: string, guard: PhysicalLeaseReleaseGuard) {
    if (guard.preflight && guard.preflight.status !== 404) {
        return { attempted: guard.attempted, ok: false, status: guard.preflight.status, payload: guard.preflight.payload };
    }
    if (!guard.attempted || !guard.parsed || !guard.file || !guard.existing) {
        return {
            attempted: guard.attempted,
            ok: true,
            ...(guard.preflight ? { status: guard.preflight.status, payload: guard.preflight.payload } : {}),
        };
    }
    const released = completePhysicalBrokerLeaseRelease(ownerId, guard.parsed, guard.file, guard.existing);
    return { attempted: true, ok: true, status: released.status, payload: released.payload };
}





function cleanupLeaseGuard(guard: PhysicalLeaseReleaseGuard): CleanupLeaseGuard<PhysicalLeaseReleaseGuard> {
    const failure = guard.preflight && cleanupRecord(guard.preflight.payload)
        ? nativeLeaseFailure(guard.preflight.status, guard.preflight.payload) : null;
    return {
        handle: guard, attempted: guard.attempted,
        admission: failure ? failure.kind === "missing" ? { kind: "missing", failure } : { kind: "refused", failure }
            : guard.parsed && guard.file && guard.existing ? { kind: "exact" } : { kind: "no-identity" },
        canRestore: Boolean(guard.parsed && guard.file && guard.existing),
    };
}
function releaseCleanupLease(ownerId: string, envelope: CleanupLeaseGuard<PhysicalLeaseReleaseGuard>): import('./device-lab/domain/broker-owner-cleanup.js').CleanupLeaseResult {
    if (envelope.admission.kind === "refused") return { kind: "refused", attempted: envelope.attempted, ok: false, failure: envelope.admission.failure };
    if (envelope.admission.kind === "missing") return { kind: "missing", attempted: true, ok: true, failure: envelope.admission.failure };
    const guard = envelope.handle;
    if (!guard.parsed || !guard.file || !guard.existing) return { kind: "no-identity", attempted: false, ok: true };
    const released = brokerPhysicalLeases.completeRelease(ownerId, guard.parsed, guard.file, guard.existing);
    return { kind: "released", attempted: true, ok: true, lease: released.lease };
}
function restoreCleanupLease(ownerId: string, envelope: CleanupLeaseGuard<PhysicalLeaseReleaseGuard>): import('./device-lab/domain/broker-owner-cleanup.js').CleanupRollback {
    const guard = envelope.handle;
    if (!guard.parsed || !guard.file || !guard.existing) return { kind: "not-needed", attempted: false, ok: true };
    return brokerPhysicalLeases.restoreReleased(ownerId, guard.parsed, guard.file, guard.existing);
}
function brokerOwnerCleanupApplication(normalized: NormalizedBrokerOptions) {
    // Each request gets its own application; its device operations run serially.
    let deviceOptions = normalized;
    const ports: BrokerOwnerCleanupPorts<PhysicalLeaseReleaseGuard, ProviderCommandResult> = {
        stateKeys: DEVICE_BROKER_BACKEND_STATE_KEYS,
        backendAliases: DEVICE_BROKER_COMMAND_BACKENDS,
        stateBackends: DEVICE_BROKER_STATE_BACKENDS,
        read: readOwnerDevices,
        equal: isDeepStrictEqual,
        publish: (ownerId, stateKey, deviceId, expected, replacement) => publishLifecycleDevice(deviceOptions, ownerId, stateKey, deviceId, expected, () => replacement),
        withDeviceOperation: (ownerId, stateKey, deviceId, operation) => withOwnerDeviceOperation(ownerId, stateKey, deviceId, () => {
            deviceOptions = { ...normalized, cleanupDeadlineAt: Math.min(normalized.cleanupDeadlineAt ?? Number.POSITIVE_INFINITY, normalized.hyperVMonotonicNow() + normalized.commandTimeoutMs) };
            return operation();
        }, { remaining: () => (normalized.cleanupDeadlineAt ?? Number.POSITIVE_INFINITY) - normalized.hyperVMonotonicNow() }),
        withLeaseGuard: (ownerId, stateKey, record, operation) => withOwnerPhysicalLeaseReleaseGuard(ownerId, stateKey, record, guard => {
            const observed = cleanupLeaseGuard(guard);
            return operation(cleanupExitBudget(deviceOptions, 1) > 0 ? observed : {
                ...observed, admission: { kind: "refused", failure: { kind: "conflict", error: "cleanup-operation-deadline-exceeded" } },
            });
        }),
        releaseLease: (ownerId, guard) => cleanupExitBudget(deviceOptions, 1) > 0 ? releaseCleanupLease(ownerId, guard)
            : { kind: "refused", attempted: false, ok: false, failure: { kind: "conflict", error: "cleanup-operation-deadline-exceeded" } },
        restoreLease: restoreCleanupLease,
        terminateAppium: (runtime, stillCurrent) => cleanupAppiumTermination(runtime, deviceOptions, stillCurrent),
        signalRecording: (runtime, stillCurrent) => cleanupRecordingTermination(runtime, deviceOptions, stillCurrent),
        auxiliaryAsyncEffects: target => target.stateKey === "android" || target.stateKey === "macos" ? {
            terminateAppium: (runtime, current) => cleanupAppiumTerminationAsync(runtime, deviceOptions, current),
            signalRecording: (runtime, current) => cleanupRecordingTerminationAsync(runtime, deviceOptions, current),
        } : null,
        cancelWatchdog: (ownerId, deviceId) => cleanupExitBudget(deviceOptions, 1) > 0
            ? cancelBrokerWindowsMinimizeWatchdog(ownerId, deviceId)
            : { attempted: false, ok: false, reason: "cleanup-operation-deadline-exceeded" },
        stopLocked: (ownerId, target, record) => cleanupVirtualStopLocked(ownerId, target, record, deviceOptions),
        timestamp: () => new Date().toISOString(),
        stateErrorCode: error => ownerDeviceStateErrorCode(error) || null,
        isDeviceLockTimeout: isDeviceOperationLockTimeout,
    };
    return createBrokerOwnerCleanupApplication(ports);
}
function observePhysicalCommand(normalized: NormalizedBrokerOptions, command: ProviderCommand) {
    const execution = normalized.commandRunner(command, { timeoutMs: normalized.commandTimeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
    return { status: execution.status, error: execution.error, stdout: execution.stdout, stderr: execution.stderr, timedOut: execution.timedOut, receipt: { command, execution } };
}
function brokerPhysicalDevicesApplication(normalized: NormalizedBrokerOptions) {
    const ports: BrokerPhysicalDevicesPorts<PhysicalLeaseReleaseGuard, NativePhysicalReceipt> = {
        deriveDeviceId: physicalDeviceId,
        read: readOwnerDevices,
        androidInventory: () => androidHostDeviceInventory(normalized),
        connectAndroid: target => normalizePhysicalExecution(observePhysicalCommand(normalized, { mode: "exec", provider: "adb", executable: executableFor("adb", normalized), args: ["connect", target] })),
        appleInventory: () => normalizeAppleInventory(observePhysicalCommand(normalized, { mode: "exec", provider: "xcrun", executable: executableFor("xcrun", normalized), args: ["xctrace", "list", "devices"] }), parseXctraceDevices),
        nonce: () => randomBytes(16).toString("hex"),
        timestamp: () => new Date().toISOString(),
        claimLease: (owner, request) => brokerPhysicalLeases.claim(owner, request),
        releaseClaim: (owner, request) => brokerPhysicalLeases.release(owner, request),
        claimDevice: claimOrReattachPhysicalOwnerDevice,
        heartbeat: (ownerId, backend, hardwareId, deviceId, lease, nonce) => startBrokerPhysicalLeaseHeartbeat(ownerId, backend, hardwareId, deviceId, { ttlMs: leaseTtlMs(lease), claimId: typeof lease?.claimId === "string" ? lease.claimId : undefined, claimNonce: nonce }),
        withDetachLease: (ownerId, parsed, device, operation) => {
            const hardwareId = parsed.backend === "android-device" ? String(device.serial || "") : String(device.udid || "");
            const releaseParams = hardwareId ? validateLeaseParams({ backend: parsed.backend, hardwareId, deviceId: parsed.deviceId, claimId: device.leaseClaimId, claimNonce: device.leaseClaimNonce }, "release") : null;
            if (releaseParams && !releaseParams.ok) return { kind: "scope-refused", failure: releaseParams };
            if (!releaseParams || !hardwareId) return operation(cleanupLeaseGuard({ attempted: false, parsed: null, file: null, existing: null, preflight: null }));
            const directory = inspectPhysicalLeaseDirectory(releaseParams.backend);
            if (!directory.ok) return { kind: "scope-refused", failure: nativeLeaseFailure(directory.status, directory.payload) };
            if (!directory.exists) return operation(cleanupLeaseGuard({ attempted: true, parsed: null, file: null, existing: null, preflight: { status: 404, payload: { ok: false, error: "physical-lease-not-found" } } }));
            const file = physicalLeaseLockFile(releaseParams.backend, releaseParams.hardwareId);
            return withSharedMutationLock(physicalLeaseMutationLockFile(releaseParams.backend, releaseParams.hardwareId), () => {
                const existing = readLeaseFile(file, releaseParams.backend, releaseParams.hardwareId);
                return operation(cleanupLeaseGuard({ attempted: true, parsed: releaseParams, file, existing, preflight: physicalLeaseReleaseConflict(ownerId, releaseParams, existing) }));
            });
        },
        withLeaseGuard: (ownerId, stateKey, record, operation) => withOwnerPhysicalLeaseReleaseGuard(ownerId, stateKey, record, guard => operation(cleanupLeaseGuard(guard))),
        releaseLease: releaseCleanupLease,
        restoreLease: restoreCleanupLease,
        removeDevice: (ownerId, stateKey, deviceId) => ownerRepository.removeDevice(ownerId, stateKey, deviceId),
        auxiliary: (ownerId, request, expected) => brokerOwnerCleanupApplication(normalized).auxiliary(ownerId, request, expected),
        publish: (ownerId, stateKey, deviceId, expected, replacement) => transitionOwnerLifecycleDevice(ownerId, stateKey, deviceId, expected, () => replacement),
        observePhysicalStop: backend => {
            const command: ProviderCommand = { mode: "noop", provider: backend, reason: backend === "android-device" ? "physical Android stop/delete does not power off or disconnect the real device" : "physical iOS stop/delete does not power off, erase, or disconnect the real device" };
            return normalizePhysicalExecution(observePhysicalCommand(normalized, command));
        },
        clone: structuredClone,
    };
    return createBrokerPhysicalDevicesApplication(ports);
}

function cleanupOwnerRuntime(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) { return brokerOwnerCleanupApplication(normalized).cleanup(ownerId, params).then(renderOwnerCleanupOutcome); }

function validateAppiumListParams(params: unknown): AppiumParamError | AppiumListParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-appium-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    const stateKey = DEVICE_BROKER_APPIUM_BACKENDS.get(backend);
    if (!stateKey) {
        return { ok: false, status: 400, error: "invalid-appium-backend", allowed: [...DEVICE_BROKER_APPIUM_BACKENDS.keys()] };
    }
    return { ok: true, backend, stateKey };
}

function field(device: unknown, name: string): string | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "string" && value ? value : null;
}

function numberField(device: unknown, name: string): number | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function executableFor(provider: string, normalized: NormalizedBrokerOptions) {
    return providerExecutable(provider, normalized) || provider;
}

function isGuid(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function randomGuid(): string {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hyperVImageRoot(): string {
    return hyperVImageStoreRoot(brokerPrivateRoot());
}

function readHyperVImageManifestMetadata(profile: HyperVImageProfile) {
    return readHyperVImageManifestMetadataFromStore(brokerPrivateRoot(), profile);
}

function resolveHyperVImageForCreate(
    ownerId: string,
    parsed: CommandParamSuccess,
    params: unknown,
    normalized: NormalizedBrokerOptions,
    deadlineAt = Number.POSITIVE_INFINITY,
) {
    return resolveHyperVImageForCreateFromStore(ownerId, parsed, params, {
        cwd: normalized.cwd,
        privateRoot: brokerPrivateRoot(),
        now: normalized.hyperVMonotonicNow,
        resolveExecutable: (name) => providerExecutable(name, normalized),
        run: (command, options) => hyperVProviderCommandRunner(normalized, command, options),
        limits: {
            acquireTimeoutMs: DEVICE_BROKER_HYPER_V_IMAGE_ACQUIRE_TIMEOUT_MS,
            prepareTimeoutMs: DEVICE_BROKER_HYPER_V_IMAGE_PREPARE_TIMEOUT_MS,
            lockWaitMs: DEVICE_BROKER_HYPER_V_IMAGE_LOCK_WAIT_MS,
            commandOutputBytes: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        },
    }, deadlineAt);
}

function hyperVNetworkStateRuntime(): HyperVNetworkStateRuntime {
    return {
        privateRoot: brokerPrivateRoot(),
        assertSafePath: assertNoSymlinkPathComponents,
    };
}

// Elevation log lines are a fixed word, ISO times and bounded enums or numbers only: never a
// path, a VM or switch name, or host text. A line that cannot be written must not change how an
// administrator transaction ends, except REQUEST, below.
function writeHyperVElevationLogLine(line: string): void {
    try {
        process.stderr.write(`${line}\n`);
    } catch {
        // The transaction's own result is what reports it.
    }
}

/**
 * Run one broker administrator transaction. The gate decides whether it may prompt at all, and
 * `withElevatedHyperVNetworkExecutor` stays the only way a prompt starts. `elevation` is read
 * only once the gate admits the attempt, so a suppressed transaction never resolves the elevated
 * PowerShell and a queued one does not materialize its native allowance while it waits.
 */
function withHyperVAdministratorExecutor<Result>(
    purpose: DeviceLabHyperVAdministratorPurpose | undefined,
    elevation: () => Pick<WithElevatedHyperVNetworkExecutorOptions, "executable" | "deadlineUnixMilliseconds" | "spawnRelay" | "maximumDurationMilliseconds">,
    operation: (executor: HyperVWindowsExecutor) => Result | Promise<Result>,
    bounds?: { remainingMilliseconds?: () => number; monotonicNow?: () => number },
): Promise<Result> {
    const purposeLabel = purpose === "ensure" || purpose === "cleanup" ? purpose : "unspecified";
    const monotonicNow = bounds?.monotonicNow ?? (() => performance.now());
    // After a declined or unanswered prompt the gate runs the transaction against
    // an executor that fails every call: no relay, no REQUEST line, no second UAC.
    return withHyperVElevationGate((onAcquisitionSettled) => {
        const attemptStartedAt = monotonicNow();
        let requestedAt: number | null = null;
        return withElevatedHyperVNetworkExecutor({
            ...elevation(),
            monotonicNow,
            // Unguarded on purpose: if this line cannot be written the relay reports request-failed
            // and never reaches RunAs, so no prompt goes unlogged. The sentence stays at the end of
            // the line so an existing search for it still matches.
            onBeforeElevation: () => {
                const now = new Date().toISOString();
                process.stderr.write(
                    `REQUEST ${now} pid=${process.pid} purpose=${purposeLabel} `
                    + "Windows is asking for Administrator permission via UAC to configure Hyper-V host networking\n",
                );
                requestedAt = monotonicNow();
            },
            onAcquisitionSettled: (settlement) => {
                // Timed from the REQUEST line, or from the start of the attempt when the relay
                // settled before it asked. A null code on an unready relay means the scope closed
                // before the relay reported anything.
                const settledAt = monotonicNow();
                const outcome = settlement.ready
                    ? "ready"
                    : settlement.code ?? "hyper-v-network-elevation-scope-closed";
                const elapsedMs = Math.max(0, Math.floor(settledAt - (requestedAt ?? attemptStartedAt)));
                writeHyperVElevationLogLine(
                    `ELEVATION ${new Date().toISOString()} outcome=${outcome} elapsedMs=${elapsedMs}`,
                );
                onAcquisitionSettled(settlement);
            },
        }, operation);
    }, (executor) => {
        writeHyperVElevationLogLine(
            `SUPPRESSED ${new Date().toISOString()} purpose=${purposeLabel} code=hyper-v-network-elevation-suppressed`,
        );
        return operation(executor);
    }, bounds?.remainingMilliseconds ? { remainingMilliseconds: bounds.remainingMilliseconds } : undefined);
}

export const withHyperVAdministratorExecutorForTest = withHyperVAdministratorExecutor;

function hyperVNetworkRuntime(
    normalized: NormalizedBrokerOptions,
    deadlineAt = Number.POSITIVE_INFINITY,
): HyperVNetworkRuntime {
    const readDevices = cachedHyperVOwnerDevicesReader(readOwnerDevices);
    const powershell = providerExecutable("powershell.exe", normalized)
        || providerExecutable("pwsh", normalized)
        || providerExecutable("powershell", normalized);
    return {
        ...hyperVNetworkStateRuntime(),
        now: normalized.hyperVMonotonicNow,
        resolveExecutable: (name) => providerExecutable(name, normalized),
        resolveElevationExecutable: hyperVElevationExecutable,
        run: (command, options) => hyperVProviderCommandRunner(normalized, command, options),
        commandOutputBytes: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        allocationReferenced: (allocation) => hyperVNetworkAllocationReferenced(allocation, readDevices),
        hostFabric: powershell
            ? {
                kind: "typed",
                client: createDeviceLabHyperVWindowsNetworkClient({
                    executable: powershell,
                    timeoutMilliseconds: () => hyperVRemainingTimeout(deadlineAt, 120_000, normalized.hyperVMonotonicNow),
                    now: normalized.hyperVMonotonicNow,
                    run: (command, options) => hyperVProviderCommandRunner(normalized, command, options),
                    ...(normalized.usesDefaultCommandRunner
                        ? { session: brokerHyperVWindowsSession(powershell) }
                        : {}),
                }),
                withAdministratorClient: async <Result>(operation: (
                    client: ReturnType<typeof createHyperVWindowsNetworkClient>,
                ) => Result | Promise<Result>, purpose?: DeviceLabHyperVAdministratorPurpose) => normalized.usesDefaultCommandRunner
                    ? withHyperVAdministratorExecutor(purpose, () => {
                        const executable = hyperVElevationExecutable(powershell);
                        const maximumDurationMilliseconds = deadlineAt === Number.POSITIVE_INFINITY
                            ? 180_000
                            : Math.floor(deadlineAt - normalized.hyperVMonotonicNow());
                        if (maximumDurationMilliseconds <= 0) throw new HyperVOperationDeadlineError();
                        return { executable, deadlineUnixMilliseconds: Date.now() + maximumDurationMilliseconds, maximumDurationMilliseconds };
                    }, (executor) => operation(createHyperVWindowsNetworkClient(executor)), {
                        remainingMilliseconds: () => deadlineAt - normalized.hyperVMonotonicNow(),
                        monotonicNow: normalized.hyperVMonotonicNow,
                    })
                    : operation(createDeviceLabHyperVWindowsNetworkClient({
                        executable: powershell,
                        timeoutMilliseconds: () => hyperVRemainingTimeout(deadlineAt, 120_000, normalized.hyperVMonotonicNow),
                        now: normalized.hyperVMonotonicNow,
                        run: (command, options) => hyperVProviderCommandRunner(normalized, command, options),
                    })),
            }
            : {
                kind: "unavailable",
            },
    };
}

/**
 * Ensure the Hyper-V host fabric for `ccc devices setup hyper-v`.
 *
 * Setup used to carry its own hand-written PowerShell ensure, which meant the
 * host's adoption, repair and rollback policy existed twice and could drift.
 * It now takes the same typed path the broker takes on device create, against
 * the same state file, so there is one implementation of that policy.
 */
export type { HyperVNetworkFabricResult };

export async function ensureHyperVHostNetworkForSetup(
    options: DeviceBrokerOptions = {},
    deadlineAt = Number.POSITIVE_INFINITY,
): Promise<HyperVNetworkFabricResult> {
    const normalized = normalizeBrokerOptions(options);
    const localDeadlineAt = Number.isFinite(deadlineAt)
        ? normalized.hyperVMonotonicNow() + Math.max(0, deadlineAt - Date.now())
        : deadlineAt;
    return ensureHyperVHostNetworkFabricWithRuntime(hyperVNetworkRuntime(normalized, localDeadlineAt), localDeadlineAt);
}

function ensureHyperVNetworkAllocation(
    ownerId: string,
    deviceId: string,
    incarnationId: string,
    normalized: NormalizedBrokerOptions,
    deadlineAt = Number.POSITIVE_INFINITY,
) {
    return ensureHyperVNetworkAllocationWithRuntime(
        hyperVNetworkRuntime(normalized, deadlineAt),
        ownerId,
        deviceId,
        incarnationId,
        deadlineAt,
    );
}

function releaseHyperVNetworkAllocationAndCleanup(
    ownerId: string,
    deviceId: string,
    incarnationId: string | null | undefined,
    normalized: NormalizedBrokerOptions,
    deadlineAt = Number.POSITIVE_INFINITY,
    options: { readonly preserveManagedFabric?: boolean } = {},
) {
    return releaseHyperVNetworkAllocationAndCleanupWithRuntime(
        hyperVNetworkRuntime(normalized, deadlineAt),
        ownerId,
        deviceId,
        incarnationId,
        deadlineAt,
        options,
    );
}

function validateHyperVLinuxSshHostIdentity(
    ownerId: string,
    deviceId: string,
    hostPublicKeyPath: string,
    knownHostsPath: string,
    networkAddress: string,
    expectedFingerprint: string,
): boolean {
    return validateHyperVLinuxSshHostIdentityWithRuntime(
        hyperVNetworkStateRuntime(),
        ownerId,
        deviceId,
        hostPublicKeyPath,
        knownHostsPath,
        networkAddress,
        expectedFingerprint,
    );
}

function persistHyperVLinuxSshHostIdentity(
    ownerId: string,
    stateKey: string,
    deviceId: string,
    hostPublicKeyPath: string,
    knownHostsPath: string,
    networkAddress: string,
    fingerprint: string,
    publication?: { expected: unknown; committed?: unknown },
): boolean {
    let persisted = false;
    const replace = (current: Record<string, unknown>) => {
        if (current.sshHostPublicKeyPath !== hostPublicKeyPath
            || current.sshKnownHostsPath !== knownHostsPath
            || current.networkAddress !== networkAddress
            || !validateHyperVLinuxSshHostIdentity(
                ownerId,
                deviceId,
                hostPublicKeyPath,
                knownHostsPath,
                networkAddress,
                fingerprint,
            )) return current;
        persisted = true;
        return {
            ...current,
            sshHostKeyFingerprint: fingerprint,
            sshHostKeySource: "authenticated-bootstrap",
            updatedAt: new Date().toISOString(),
        };
    };
    if (publication) {
        const transition = transitionOwnerLifecycleDevice(ownerId, stateKey, deviceId, publication.expected, replace);
        if (transition.matched && persisted) publication.committed = structuredClone(transition.device);
    } else {
        ownerRepository.updateDevice(ownerId, stateKey, deviceId, replace);
    }
    return persisted;
}

function reconcileHyperVLinuxSshHostIdentity(
    ownerId: string,
    stateKey: string,
    deviceId: string,
    hostPublicKeyPath: string,
    knownHostsPath: string,
    networkAddress: string,
    publication?: { expected: unknown; committed?: unknown },
): { fingerprint: string } | null {
    return reconcileHyperVLinuxSshHostIdentityWithRuntime(
        hyperVNetworkStateRuntime(),
        ownerId,
        deviceId,
        hostPublicKeyPath,
        knownHostsPath,
        networkAddress,
        (fingerprint) => persistHyperVLinuxSshHostIdentity(
            ownerId,
            stateKey,
            deviceId,
            hostPublicKeyPath,
            knownHostsPath,
            networkAddress,
            fingerprint,
            publication,
        ),
    );
}



function hyperVOperationJournalPath(ownerId: string, backend: string, deviceId: string): string {
    return hyperVOperationJournalFilePath(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        backend,
        deviceId,
    );
}

function readHyperVOperationJournal(ownerId: string, backend: string, deviceId: string): HyperVOperationJournal | null {
    return readHyperVOperationJournalFile(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        backend,
        deviceId,
    );
}

function writeHyperVOperationJournal(ownerId: string, parsed: CommandParamSuccess): { ok: true; path: string } | { ok: false; error: string } {
    return writeHyperVOperationJournalFile(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        parsed,
    );
}

function clearHyperVOperationJournal(ownerId: string, backend: string, deviceId: string): void {
    clearHyperVOperationJournalFile(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        backend,
        deviceId,
    );
}

function brokerHyperVStopDeleteApplication(normalized: NormalizedBrokerOptions) {
    const client = (executable: string, deadlineAt: number, timeoutCap: number) => createDeviceLabHyperVWindowsClient({
        executable, now: normalized.hyperVMonotonicNow,timeoutMilliseconds: () => hyperVRemainingTimeout(deadlineAt, timeoutCap, normalized.hyperVMonotonicNow),
        run: (command, options) => hyperVProviderCommandRunner(normalized, command, options),
        ...(normalized.usesDefaultCommandRunner ? { session: brokerHyperVWindowsSession(executable) } : {}),
    });
    const identity = (owner: string, journal: HyperVOperationEvidence) => {
        const selector: {kind: "id"; id: string} = {kind: "id", id: journal.vmId};
        return {selector,expectedName:journal.vmName,expectedNotes:ownershipMarker(owner,journal.deviceId,journal.incarnationId)};
    };
    const ports: HyperVStopDeletePorts<NativeHyperVConnection, ProviderCommandResult> = {
        read: (owner,state) => readOwnerDevices(owner,state), incarnation: device => hyperVDeviceIncarnationId(device),
        validIncarnation: validHyperVIncarnationId, connection: provider => nativeHyperVConnection(normalized,provider),
        prepareStopDelete: (owner, request, device) => {
            const command = providerCommandFor(owner, request, device, normalized);
            if ("error" in command) return {kind: "unavailable", error: command.error, missing: command.missing};
            return {kind: "prepared", connection: {executable: command.executable || "powershell.exe", plannedCommand: command}};
        },
        readJournal: readHyperVOperationJournal, writeJournal: (owner,request,capturedTarget,deadline) => {
            if (!capturedTarget) return writeHyperVOperationJournal(owner,request);
            let result: ReturnType<typeof writeHyperVOperationJournal> = {ok:false,error:"hyper-v-snapshot-state-conflict"};
            ownerRepository.withSnapshotRepairTarget(owner,request.stateKey,request.deviceId,capturedTarget,current => {
                assertHyperVOperationDeadline(deadline ?? Number.POSITIVE_INFINITY, normalized.hyperVMonotonicNow);
                result = writeHyperVOperationJournalFile({...hyperVJournalPersistenceRuntime(),readDevices:()=>[current]},owner,request);
                return true;
            });
            return result;
        },
        clearJournal: (owner,backend,id) => {clearHyperVOperationJournal(owner,backend,id); return undefined;},
        readSnapshotJournal: readHyperVSnapshotJournal,
        repairSnapshots: (owner,backend,id,device,connection,deadline) => observeHyperVSnapshotJournal(owner,backend,id,device,connection.executable,normalized,undefined,deadline),
        clearSnapshotJournal: (owner,backend,id,capturedTarget,capturedJournal,deadline) => ownerRepository.withSnapshotRepairTarget(owner,backend,id,capturedTarget,() => {
            let currentJournal: HyperVSnapshotJournal | null;
            try { currentJournal = readHyperVSnapshotJournal(owner,backend,id); }
            catch { return false; }
            if (!isDeepStrictEqual(currentJournal,capturedJournal)) return false;
            assertHyperVOperationDeadline(deadline, normalized.hyperVMonotonicNow);
            clearHyperVSnapshotJournal(hyperVJournalPersistenceRuntime(),owner,backend,id);
            return true;
        }),
        replayObservation: (connection,owner,journal,media,deadline) => reconcileDeviceLabHyperVOperation(client(connection.executable,deadline,journal.command==="device_delete"?120000:30000),{ownerId:owner,journal,auxiliaryMediaPaths:media}),
        replayPower: async (connection,owner,journal,action,turnOff,deadline) => {
            const native=client(connection.executable,deadline,journal.command==="device_delete"?120000:30000);
            if(action==="start")await native.startVM(identity(owner,journal));
            else await native.stopVM({...identity(owner,journal),mode:turnOff?"turn-off":"shutdown",force:true});
        },
        replayRemoveVm: async (connection,owner,journal,media,deadline) => {
            await client(connection.executable,deadline,120000).removeVM({selector:identity(owner,journal).selector,force:true,guard:{
                expectedName:journal.vmName,expectedNotes:ownershipMarker(owner,journal.deviceId,journal.incarnationId),
                expectedDiskPaths:[journal.diskPath],ownedDiskDirectory:win32.dirname(journal.diskPath),expectedDvdPaths:media,
            }});
        },
        removeHostFiles: async (connection,root,paths,checkpointDirectory,deadline) => {
            await client(connection.executable,deadline,120000).removeHostFiles({rootDirectory:root,paths,...(checkpointDirectory?{checkpointDiskDirectory:checkpointDirectory}:{})});
        },
        deviceRoot: hyperVDeviceRoot, windowsDirectory: path => win32.dirname(path),
        replayPublish: (owner,backend,id,replacement) => ownerRepository.replayPublish(owner,backend,id,replacement),
        cleanupAuxiliary: (owner,request,expected) => cleanupLifecycleAuxiliaryRuntime(owner,request,normalized,expected),
        clone: value => structuredClone(value),
        executeStop: async (owner,request,device,connection,deadline) => {
            forgetHyperVConsoleFrame(hyperVConsoleFrameKey(owner,request.backend,request.deviceId));
            const outcome = await hyperVTypedPowerObservation(normalized,{
            executable: connection.executable,ownerId:owner,deviceId:request.deviceId,incarnationId:hyperVDeviceIncarnationId(device)||"",
            vmId:field(device,"vmId")||"",vmName:field(device,"vmName")||"",
        },"stop",deadline,120000,{force:request.force,memoryMb:numberField(device,"memoryMb")||4096,cpus:numberField(device,"cpus")||2});
            if (normalized.cleanupObservation && outcome.execution.receipt)
                normalized.cleanupObservation.execution = outcome.execution.receipt;
            return outcome;
        },
        executeDelete: async (owner,request,device,connection,deadline) => {
            forgetHyperVConsoleFrame(hyperVConsoleFrameKey(owner,request.backend,request.deviceId));
            return hyperVTypedDeleteObservation(normalized,{
            executable: connection.executable,ownerId:owner,backend:request.backend,deviceId:request.deviceId,incarnationId:hyperVDeviceIncarnationId(device)||"",
            vmId:field(device,"vmId")||"",vmName:field(device,"vmName")||"",diskPath:field(device,"diskPath")||"",
        },deadline);
        },
        samePath: (left,right) => resolve(left)===resolve(right),
        releaseNetwork: (owner,id,incarnation,deadline,preserve) => releaseHyperVNetworkAllocationAndCleanup(owner,id,incarnation,normalized,deadline,{preserveManagedFabric:preserve}),
        cleanupArtifacts: cleanupHyperVDeviceArtifacts,
        publish: (...args) => publishLifecycleDevice(normalized, ...args),
        stateErrorCode: ownerDeviceStateErrorCode, stateFailure: nativeHyperVStateFailure,
        errorCode: hyperVBoundedErrorCode, diagnosticCode: (execution, fallback) => hyperVProviderDiagnosticCode(nativeHyperVExecutionReceipt(execution), fallback),
        assertDeadline: deadline=>{assertHyperVOperationDeadline(deadline, normalized.hyperVMonotonicNow);return undefined;}, deadlineExpired:deadline=>hyperVOperationDeadlineExpired(deadline, normalized.hyperVMonotonicNow),
        timestamp:()=>new Date().toISOString(),
    };
    return createHyperVStopDeleteApplication(ports);
}

/** Runs the real Hyper-V create transaction. The legacy descriptor remains a validation and
 * dry-run artifact; no generated New-VM program is executed on this path. */
function brokerHyperVCreateSession(normalized:NormalizedBrokerOptions,executable:string,deadlineAt:number) {
    let failed=false;
    const options={executable,now: normalized.hyperVMonotonicNow,timeoutMilliseconds:()=>hyperVRemainingTimeout(deadlineAt, 30000, normalized.hyperVMonotonicNow),
        run:async(command:ProviderCommand,limits:ProviderCommandRunnerOptions)=>{const result=await hyperVProviderCommandRunner(normalized,command,limits);if(!commandSucceeded(result))failed=true;return result;},
        record:(result:{status?:number|null;error?:string;timedOut?:boolean;outputLimitExceeded?:boolean})=>{if(result.status!==0||result.error||result.timedOut||result.outputLimitExceeded)failed=true;},
        ...(normalized.usesDefaultCommandRunner?{session:brokerHyperVWindowsSession(executable)}:{}),
    };
    return {client:createDeviceLabHyperVWindowsClient(options),networkClient:createDeviceLabHyperVWindowsNetworkClient(options),failed:()=>failed};
}
function nativeHyperVParamFailure(parsed: CommandParamError): HyperVLifecycleOutcome<NativeHyperVConnection, ProviderCommandResult> {
    return {kind: "admission-refused", reason: parsed.status === 403 ? "forbidden" : parsed.status === 404 ? "missing" : parsed.status === 409 ? "conflict" : "invalid", error: parsed.error, allowed: parsed.allowed, detail: parsed.detail, journalDisposition: "clear", recoveryDisposition: "required"};
}

function nativeHyperVLifecyclePlanning(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions, expected?: {device?: unknown}, admittedDeviceId?: string): HyperVLifecyclePlan<NativeHyperVConnection, ProviderCommandResult> {
    const parsed = validateCommandParams(params, admittedDeviceId);
    if (!parsed.ok) return {kind: "plan-refused", failure: nativeHyperVParamFailure(parsed)};
    const observation = observeLifecyclePreview(ownerId, parsed, normalized, false, expected);
    const base = {ownerId, backend: parsed.backend, deviceId: parsed.deviceId};
    const refuse = (reason: "invalid" | "missing" | "conflict" | "provider-unavailable" | "state-write-failed", error: string, facts: {detail?: string; allowed?: string | string[]; conflicts?: string[]; remedy?: string} = {}): HyperVLifecyclePlan<NativeHyperVConnection, ProviderCommandResult> => {
        if (reason === "state-write-failed") return {kind: "plan-refused", failure: {...base, ...facts, kind: "operation-failed", reason, error, journalDisposition: "clear", recoveryDisposition: "required"}};
        return {kind: "plan-refused", failure: {...base, ...facts, kind: "admission-refused", reason, error, journalDisposition: "clear", recoveryDisposition: "required"}};
    };
    switch (observation.kind) {
        case "state-failed": return {kind: "plan-refused", failure: {kind: "operation-failed", ...nativeHyperVStateFailure(observation.error, parsed), journalDisposition: "clear", recoveryDisposition: "required"}};
        case "allocation-failed": return refuse("conflict", observation.evidence.error, {detail: observation.evidence.detail, allowed: observation.evidence.allowed});
        case "already-exists": return refuse("conflict", "owner-device-already-exists");
        case "not-found": return refuse("missing", "owner-device-not-found");
        case "not-attached": return refuse("conflict", "physical-device-not-attached", {remedy: "attach the physical device before starting it"});
        case "missing-delete": return {kind: "planned", ...observation.value, device: null, idempotent: true, availability: {kind: "not-required"}};
        default: {
            const {providerPlan, providerAvailable: _providerAvailable, ...value} = observation.value;
            if (providerPlan == null) return {kind: "planned", ...value, availability: {kind: "not-required"}};
            if ("error" in providerPlan) return {kind: "planned", ...value, availability: {kind: "unavailable", error: providerPlan.error, missing: providerPlan.missing}};
            if (providerPlan.mode !== "exec" && providerPlan.mode !== "detached" && providerPlan.mode !== "noop") return {kind: "planned", ...value, availability: {kind: "unavailable", error: "missing-provider-command", missing: []}};
            if (providerPlan.mode === "noop") return {kind: "planned", ...value, availability: {kind: "not-required"}};
            if (!("executable" in providerPlan) || typeof providerPlan.executable !== "string" || !providerPlan.executable) return {kind: "planned", ...value, availability: {kind: "unavailable", error: "missing-provider-command", missing: ["powershell"]}};
            return {kind: "planned", ...value, availability: {kind: "available", connection: {executable: providerPlan.executable, plannedCommand: {...providerPlan, mode: providerPlan.mode}}}};
        }
    }
}

function nativeHyperVStateFailure(error: unknown, request: {backend: string; stateKey: string}) {
    const code = ownerDeviceStateErrorCode(error);
    if (!code) throw error;
    return {reason: code === "owner-devices-file-too-large" || code === "owner-devices-state-read-failed" ? "state-write-failed" as const : "conflict" as const, error: code, backend: request.backend, stateKey: request.stateKey};
}

type NativeHyperVProvisionMedia = ReturnType<typeof hyperVGuestProvisionMediaCommand>;

function nativeHyperVConnection(normalized: NormalizedBrokerOptions, provider: "powershell" | "ssh"): NativeHyperVConnection | null {
    const executable = provider === "ssh"
        ? providerExecutable("ssh", normalized)
        : providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
    return executable ? { executable } : null;
}

function nativeHyperVObservation(receipt: ProviderCommandResult): HyperVNativeExecution<ProviderCommandResult> {
    return {
        required: receipt.mode !== "noop", dispatched: receipt.mode !== "noop", ok: commandSucceeded(receipt),
        ...(receipt.error !== undefined ? {failureCode: receipt.error} : {}),
        ...(receipt.typedCreateInvalidResult !== undefined ? {invalidResult: receipt.typedCreateInvalidResult} : {}),
        ...(receipt.typedCreateOperation !== undefined ? {operation: receipt.typedCreateOperation} : {}),
        ...(receipt.typedCreateNativeDiagnostics !== undefined ? {nativeDiagnostics: receipt.typedCreateNativeDiagnostics} : {}),
        receipt,
    };
}

function brokerHyperVCreateStartApplication(normalized:NormalizedBrokerOptions) {
    const ports:HyperVCreateStartPorts<ReturnType<typeof brokerHyperVCreateSession>, NativeHyperVConnection, ProviderCommandResult, NativeHyperVProvisionMedia>={
        connection: provider => nativeHyperVConnection(normalized, provider), validIncarnation:validHyperVIncarnationId,
        deviceRoot:hyperVDeviceRoot,privateRoot:hyperVPrivateDeviceRoot,
        ownerImageRoot:owner=>join(brokerPrivateRoot(),"owners",owner,"images","hyper-v"),imageRoot:hyperVImageRoot,
        assertImagePath:(root,path)=>{assertDeviceLabPathWithinRoot(root,path,"hyper-v-base-image");return undefined;},exists:existsSync,
        incarnationRecord:readHyperVIncarnationRecord,vmName:hyperVVmName,marker:ownershipMarker,
        createSession:(connection,deadline)=>brokerHyperVCreateSession(normalized,connection.executable,deadline),
        creationEffects:session=>deviceLabVmCreationPorts({...session,now:normalized.hyperVMonotonicNow}),executionFailed:session=>session.failed(),
        vhd:(session,path)=>session.client.getVHD(path),vhdError:hyperVCreateVhdReadError,inspectVhd:inspectHyperVCreateVhd,
        hostCapacity:(memoryMb,cpus)=>{assertHyperVHostCapacity({memoryMb,cpus});return undefined;},
        prepareCreateDirectories: async (connection, paths, timeoutMs, outputLimit) => {
            const receipt = await hyperVProviderCommandRunner(normalized, hyperVCreatePrologueCommand({executable: connection.executable, baseImageRoot: paths.imageRoot, baseImagePath: paths.imagePath, deviceRoot: paths.deviceRoot, diskPath: paths.diskPath}), {timeoutMs, outputLimit});
            const ok = commandSucceeded(receipt);
            return {
                ok, observation: ok ? parseHyperVCreatePrologueObservation(receipt.stdout || "") : null,
                partial: ok ? null : parseHyperVCreatePrologueFailure(receipt.stdout || ""),
                execution: nativeHyperVObservation(receipt),
            };
        },
        samePath:(left,right)=>resolve(left)===resolve(right),directory:dirname,windowsDirectory:win32.dirname,
        sameWindowsPath:(left,right)=>left!==null&&win32.normalize(left).toLowerCase()===win32.normalize(right).toLowerCase(),
        cloneDisk:async(request,created)=>{await cloneHyperVBaseImage({...request,now:normalized.hyperVMonotonicNow,onDestinationCreated:path=>{created(path);}});},
        observePlannedPower: async (connection, timeoutMs, outputLimit) => {
            if (!connection.plannedCommand) throw new Error("missing-provider-command");
            const receipt = await hyperVProviderCommandRunner(normalized, connection.plannedCommand, {timeoutMs, outputLimit});
            const ok = commandSucceeded(receipt);
            return {ok, observation: ok ? parseHyperVVmObservation(receipt.stdout || "") : null, execution: nativeHyperVObservation(receipt)};
        },
        remaining:(deadline,maximum)=>hyperVRemainingTimeout(deadline,maximum,normalized.hyperVMonotonicNow),assertDeadline:deadline=>{assertHyperVOperationDeadline(deadline, normalized.hyperVMonotonicNow);return undefined;},deadlineExpired:deadline=>hyperVOperationDeadlineExpired(deadline, normalized.hyperVMonotonicNow),
        errorInfo:error=>error instanceof HyperVWindowsError?{code:error.code,category:error.category}:null,
        typedErrorCode:hyperVTypedErrorCode,typedErrorOperation:error=>hyperVTypedErrorOperation(error)??null,nativeDiagnostics:hyperVTypedNativeDiagnostics,
        diagnosticCode:(execution,fallback)=>hyperVProviderDiagnosticCode(nativeHyperVExecutionReceipt(execution),fallback),boundedErrorCode:hyperVBoundedErrorCode,
        removeCreateArtifact: async (connection, target, timeoutMs, outputLimit) => commandSucceeded(await hyperVProviderCommandRunner(normalized, hyperVCreateCompensationCommand({executable: connection.executable, ...target}), {timeoutMs, outputLimit})),
        compensationOrder:planHyperVVirtualMachineCreationCompensation,vms:(session,id)=>session.client.getVM({kind:"id",id}),disks:(session,id)=>session.client.getVMHardDiskDrives({kind:"id",id}),
        removeVM:(session,request)=>session.client.removeVM(request),
        recoverVM:async(connection,request,deadline)=>{const executable = connection.executable; const client=createDeviceLabHyperVWindowsClient({executable,run:(command,limits)=>hyperVProviderCommandRunner(normalized,command,limits),now: normalized.hyperVMonotonicNow,timeoutMilliseconds:()=>hyperVRemainingTimeout(deadline, 120000, normalized.hyperVMonotonicNow),...(normalized.usesDefaultCommandRunner?{session:brokerHyperVWindowsSession(executable)}:{})});return deleteDeviceLabHyperVVm(client,request);},
        releaseNetwork:(owner,id,incarnation,deadline,preserve)=>releaseHyperVNetworkAllocationAndCleanup(owner,id,incarnation,normalized,deadline,{preserveManagedFabric:preserve}),
        read:readOwnerDevices,incarnation:hyperVDeviceIncarnationId,stateErrorCode:ownerDeviceStateErrorCode,stateFailure:nativeHyperVStateFailure,
        hasNetworkAllocation: (owner, id) => Boolean(readDeviceLabStateFile(
            join(brokerPrivateRoot(), "network", "hyper-v.json"), decodeHyperVNetworkState,
            "hyper-v-network-state", 256 * 1024,
        )?.allocations.some(allocation => allocation.ownerId === owner && allocation.deviceId === id)),
        readJournal:readHyperVOperationJournal,writeJournal:writeHyperVOperationJournal,
        clearJournal:(owner,backend,id)=>{clearHyperVOperationJournal(owner,backend,id);return undefined;},
        readSnapshotJournal:readHyperVSnapshotJournal,repairSnapshots:(owner,backend,id,device,connection,deadline)=>observeHyperVSnapshotJournal(owner,backend,id,device,connection.executable,normalized,undefined,deadline),
        journalPath:hyperVOperationJournalPath,snapshotJournalPath:hyperVSnapshotJournalPath,
        forgetConsole:(owner,backend,id)=>{forgetHyperVConsoleFrame(hyperVConsoleFrameKey(owner,backend,id));return undefined;},
        reconcileOperation:(owner,backend,id,deadline,preserve)=>brokerHyperVStopDeleteApplication(normalized).reconcile(owner,backend,id,deadline,preserve),
        planning: (owner, params, expected, admittedDeviceId) => nativeHyperVLifecyclePlanning(owner, params, normalized, expected, admittedDeviceId),
        parse: (params, admittedDeviceId) => {
            const parsed = validateCommandParams(params, admittedDeviceId);
            if (!parsed.ok) return {ok: false, failure: nativeHyperVParamFailure(parsed)};
            if (parsed.command === "device_create" || parsed.command === "device_start" || parsed.command === "device_reboot") return {ok: true, request: {...parsed, command: parsed.command}};
            return {ok: false, failure: {kind: "admission-refused", reason: "unsupported", error: "unsupported-command", backend: parsed.backend, command: parsed.command, journalDisposition: "clear", recoveryDisposition: "required"}};
        },
        resolveImage:(owner,request,params,deadline)=>resolveHyperVImageForCreate(owner,request,params,normalized,deadline),
        allocateNetwork:(owner,id,incarnation,deadline)=>ensureHyperVNetworkAllocation(owner,id,incarnation,normalized,deadline),
        writeIncarnation:(owner,backend,id,incarnation)=>{writeHyperVIncarnationRecord(owner,backend,id,incarnation);return undefined;},
        newIncarnation:()=>randomBytes(16).toString("hex"),deadlineError:error=>error instanceof HyperVOperationDeadlineError?error.code:null,
        imageProfile:hyperVImageProfile,imageVirtualSize:profile=>readHyperVImageManifestMetadata(profile).virtualSizeBytes,quota:DEVICE_BROKER_HYPER_V_OWNER_QUOTA,
        now:normalized.hyperVMonotonicNow,timestamp:()=>new Date().toISOString(),sleep,passwordEntropy:()=>randomBytes(24).toString("base64url"),
        ensurePrivateRoot:(owner,backend,id)=>{ensureHyperVPrivateDeviceRoot(owner,backend,id);return undefined;},
        assertPrivateRoot:(owner,backend,id,root)=>{assertHyperVPrivateDeviceRoot(owner,backend,id,root);return undefined;},
        readable:(path,label,limit)=>withDeviceLabReadableFile(path,label,limit,()=>true)===true,
        mediaRetained:path=>{try{assertNoSymlinkPathComponents(path,"hyper-v-guest-provisioning-media");lstatSync(path);return true;}catch(error){return !error||typeof error!=="object"||!("code" in error)||error.code!=="ENOENT";}},
        observeWindowsReadiness: outcome => deviceLabWindowsReadinessObservation<ProviderCommandResult>(outcome),
        readinessFailure: (backend, error, source) => deviceLabHyperVReadinessFailure<ProviderCommandResult>(backend, error, source),
        seedFailureCode:linuxSeedFailureCode,
        prepareLinuxSeed: (connection, request) => {
            const command = hyperVLinuxSeedCommand({executable: connection.executable, ...request});
            return async (timeoutMs, outputLimit) => {
                const receipt = await hyperVProviderCommandRunner(normalized, command, {timeoutMs, outputLimit});
                return {ok: commandSucceeded(receipt), observation: decodeHyperVLinuxSeedObservation(receipt.stdout), execution: nativeHyperVObservation(receipt)};
            };
        },
        prepareWindowsProvisionMedia: (connection, request) => hyperVGuestProvisionMediaCommand({executable: connection.executable, ...request}),
        probeLinuxReadiness: async (connection, request, timeoutMs, outputLimit) => deviceLabHyperVLinuxReadinessObservation(await hyperVProviderCommandRunner(normalized, hyperVLinuxSshReadyCommand({executable: connection.executable, ...request}), {timeoutMs, outputLimit})),
        finalizeLinuxNetwork: async (connection, request, timeoutMs, outputLimit) => {
            const receipt = await hyperVProviderCommandRunner(normalized, hyperVLinuxNetworkFinalizeCommand({executable: connection.executable, ...request}), {timeoutMs, outputLimit});
            return {ok: commandSucceeded(receipt), execution: nativeHyperVObservation(receipt)};
        },
        probeLinuxGui: async (connection, request, timeoutMs, outputLimit) => deviceLabHyperVLinuxGuiReadinessObservation(await hyperVProviderCommandRunner(normalized, hyperVLinuxGuiReadyCommand({executable: connection.executable, ...request}), {timeoutMs, outputLimit})),
        prepareLinuxGui: async (connection, request, timeoutMs, outputLimit) => deviceLabHyperVLinuxGuiReadinessObservation(await hyperVProviderCommandRunner(normalized, hyperVLinuxGuiPrepareCommand({executable: connection.executable, ...request}), {timeoutMs, outputLimit})),
        inspectSeed:(connection,request,deadline)=>inspectDeviceLabHyperVLinuxSeedTarget({executable: connection.executable, ...request,run:(command,limits)=>hyperVProviderCommandRunner(normalized,command,limits),now: normalized.hyperVMonotonicNow,timeoutMilliseconds:()=>hyperVRemainingTimeout(deadline, 180000, normalized.hyperVMonotonicNow),...(normalized.usesDefaultCommandRunner?{session:brokerHyperVWindowsSession(connection.executable)}:{})}),
        attachSeed:(connection,request,deadline)=>attachDeviceLabHyperVLinuxSeedMedia({executable: connection.executable, ...request,run:(command,limits)=>hyperVProviderCommandRunner(normalized,command,limits),now: normalized.hyperVMonotonicNow,timeoutMilliseconds:()=>hyperVRemainingTimeout(deadline, 180000, normalized.hyperVMonotonicNow),...(normalized.usesDefaultCommandRunner?{session:brokerHyperVWindowsSession(connection.executable)}:{})}),
        provision: async (connection, request, deadline) => {
            const result = await provisionDeviceLabHyperVWindowsGuest({executable: connection.executable, mediaCommand: request.media, ...request,run:(command,limits)=>hyperVProviderCommandRunner(normalized,command,limits),now: normalized.hyperVMonotonicNow,timeoutMilliseconds:()=>hyperVRemainingTimeout(deadline, 180000, normalized.hyperVMonotonicNow),...(normalized.usesDefaultCommandRunner?{session:brokerHyperVWindowsSession(connection.executable)}:{})});
            return {ok: result.ok, observation: result.observation, execution: nativeHyperVObservation(result.execution)};
        },
        windowsReadiness:(connection,root,mediaPath)=>deviceLabWindowsReadinessPorts({executable: connection.executable,now: normalized.hyperVMonotonicNow,timeoutMilliseconds:1,run:(command,limits)=>hyperVProviderCommandRunner(normalized,command,limits),removeProvisioningMedia:()=>{
            assertDeviceLabPathWithinRoot(root,mediaPath,"hyper-v-guest-provisioning-media");assertNoSymlinkPathComponents(mediaPath,"hyper-v-guest-provisioning-media");
            try{const media=lstatSync(mediaPath);if(!media.isFile()||media.isSymbolicLink())throw new Error("hyper-v-guest-provisioning-media-invalid");}catch(error){if(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT")return;throw error;}
            rmSync(mediaPath);
        }}),
        power: (connection, identity, operation, deadline, cap, options) => hyperVTypedPowerObservation(normalized, {executable: connection.executable, ...identity}, operation, deadline, cap, options),
        bootstrapProbe: async (connection, request) => {
            const observed = await hyperVProbeBootstrapNetwork(normalized, {executable: connection.executable, ...request});
            const failureCode = observed.observation?.diagnosticCode
                || (observed.observation ? null : commandSucceeded(observed.execution)
                    ? "hyper-v-bootstrap-network-response-invalid"
                    : hyperVProviderDiagnosticCode(observed.execution, "hyper-v-bootstrap-network-probe-failed") || "hyper-v-bootstrap-network-probe-failed");
            return {
                diagnostics: {status: typeof observed.execution.status === "number" ? observed.execution.status : null},
                failureCode, observation: observed.observation, execution: nativeHyperVObservation(observed.execution),
            };
        },
        bootstrapCleanup: async (connection, request, mac) => { const observed = await hyperVCleanupBootstrapNetwork(normalized, {executable: connection.executable, ...request}, mac); return {execution: nativeHyperVObservation(observed.execution), observation: observed.observation}; },
        bootDiagnostic:(connection,request,deadline)=>readDeviceLabHyperVGuestBootDiagnostic({executable: connection.executable, ...request,now: normalized.hyperVMonotonicNow,timeoutMilliseconds:()=>hyperVRemainingTimeout(deadline, 15000, normalized.hyperVMonotonicNow),run:(command,limits)=>hyperVProviderCommandRunner(normalized,command,limits),...(normalized.usesDefaultCommandRunner?{session:brokerHyperVWindowsSession(connection.executable)}:{})}),
        validateHostIdentity:validateHyperVLinuxSshHostIdentity,
        reconcileHostIdentity:(owner,state,id,hostPath,knownPath,address,expected)=>{const publication:{expected:unknown;committed?:unknown}={expected};const identity=reconcileHyperVLinuxSshHostIdentity(owner,state,id,hostPath,knownPath,address,publication);return {identity,...(publication.committed!==undefined?{committed:publication.committed}:{})};},
        claim:(owner,state,device,fields,deadline)=>ownerRepository.claim(owner,state,device,fields,()=>{
            assertHyperVOperationDeadline(deadline,normalized.hyperVMonotonicNow);
            return undefined;
        }),
        publish:(owner,state,id,expected,replace)=>transitionOwnerLifecycleDevice(owner,state,id,expected,current=>{
            const replacement=replace(current);
            if(!replacement||typeof replacement!=="object"||!("lastBootCheck" in replacement))return replacement;
            const check=replacement.lastBootCheck;
            if(!check||typeof check!=="object"||!("readiness" in check)||!check.readiness)return replacement;
            // Serialize opaque trace evidence only inside the existing exact-predecessor publication.
            return {...replacement,lastBootCheck:{...check,readiness:publicHyperVReadinessTrace(check.readiness as HyperVLinuxGuestReadyTrace)}};
        }),
        maxBootTimeout:DEVICE_BROKER_HYPER_V_MAX_BOOT_TIMEOUT_MS,windowsNoProgressTimeout:DEVICE_BROKER_HYPER_V_WINDOWS_NO_PROGRESS_TIMEOUT_MS,linuxGuiTimeout:DEVICE_BROKER_HYPER_V_LINUX_GUI_TIMEOUT_MS,
        cleanupArtifacts:cleanupHyperVDeviceArtifacts,outputLimit:DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    };
    return createHyperVCreateStartApplication(ports);
}


type NativeLifecycleCommand = ProviderCommand | {error: string; missing: string[]};







function planBrokerWindowsSandboxCommand(ownerId: string, parsed: CommandParamSuccess, device: unknown, ports: {
    executable(name: string): string;
    stopRuntimeId(owner: string, device: unknown): string | null;
    readConfig(owner: string, id: string, path: string | null): {
        ok: true;
        config: string;
    } | {
        ok: false;
        error: string;
        missing: string[];
    };
    newRuntimeId(): string;
}): NativeLifecycleCommand {
    if (parsed.command === 'device_status')
        return { mode: 'noop', provider: 'wsb', reason: 'Windows Sandbox status/delete is represented by owner state in this broker layer' };
    const executable = ports.executable('wsb');
    const status = String((device as {
        status?: unknown;
    })?.status || '').toLowerCase();
    if (parsed.command === 'device_stop' || (parsed.command === 'device_delete' && ['running', 'booted', 'started', 'starting'].includes(status))) {
        const sandboxId = ports.stopRuntimeId(ownerId, device);
        if (!sandboxId)
            return { error: 'missing-provider-metadata', missing: ['sandboxId GUID'] };
        return { mode: 'exec', provider: 'wsb', executable: executable || undefined, args: ['stop', '--id', sandboxId], sandboxId };
    }
    if (parsed.command === 'device_delete')
        return { mode: 'noop', provider: 'wsb', reason: 'Stopped Windows Sandbox delete is represented by owner state in this broker layer' };
    const config = ports.readConfig(ownerId, parsed.deviceId, field(device, 'configPath') || field(device, 'wsbConfigPath'));
    if (!config.ok)
        return { error: config.error, missing: config.missing };
    const existing = field(device, 'sandboxId');
    const sandboxId = existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing) ? existing : ports.newRuntimeId();
    const minimized = typeof parsed.minimized === 'boolean' ? parsed.minimized : (device as {
        minimized?: unknown;
    })?.minimized !== false;
    return { mode: 'exec', provider: 'wsb', executable: executable || undefined, args: ['start', '--id', sandboxId, '--config', config.config], sandboxId, waitForExit: false, ...(minimized ? { windowStyle: 'minimized' as const } : {}) };
}





function nativeMetadataDescription(purpose: BrokerMacosMetadataPurpose): string {
    if (purpose === "image-unset") return "macOS VM device_create without image writes owner-scoped broker metadata";
    if (purpose === "stopped-definition-delete") return "Stopped macOS VM delete without providerInstance deletes only owner broker metadata";
    return "device_create writes owner-scoped broker metadata";
}
function nativeLifecyclePreparation(command: NativeLifecycleCommand | null | undefined) {
    if (!command)
        return { kind: "metadata-only" as const, purpose: "definition-only" as const };
    if ("error" in command)
        return { kind: "unavailable" as const, error: command.error, missing: command.missing };
    if (command.mode === "noop") {
        const purpose: BrokerMacosMetadataPurpose = command.reason === nativeMetadataDescription("stopped-definition-delete")
            ? "stopped-definition-delete" : command.reason === nativeMetadataDescription("image-unset") ? "image-unset" : "definition-only";
        return { kind: "metadata-only" as const, purpose };
    }
    return { kind: "ready" as const, effect: new NativeProviderLifecycleEffect(command), mode: command.mode, provider: command.provider, canCompensate: Boolean(command.executable), bootEligible: command.provider === "tart" && command.mode === "detached" && Boolean(command.executable) };
}
function nativePreparedCommand(prepared: {
    kind: "ready";
    effect: NativeProviderLifecycleEffect;
} | {
    kind: "metadata-only";
    purpose?: BrokerMacosMetadataPurpose;
} | {
    kind: "unavailable";
    error: string;
    missing: string[];
}, metadataReason = "device_create writes owner-scoped broker metadata"): NativeLifecycleCommand {
    if (prepared.kind === "unavailable")
        return { error: prepared.error, missing: prepared.missing };
    if (prepared.kind === "ready")
        return prepared.effect.command;
    return { mode: "noop", provider: "host-broker-state", reason: prepared.purpose ? nativeMetadataDescription(prepared.purpose) : metadataReason };
}
function planBrokerAndroidCreateCommand(owner: string, parsed: CommandParamSuccess, normalized: NormalizedBrokerOptions, create = parsed.create || {}) {
    return nativePreparedCommand(planBrokerAndroidCreate(owner, parsed, brokerAndroidPreparationPorts(normalized), create));
}
function planBrokerAndroidExistingCommand(owner: string, parsed: CommandParamSuccess, device: unknown, normalized: NormalizedBrokerOptions) {
    return nativePreparedCommand(planBrokerAndroidExisting(owner, parsed, device, brokerAndroidPreparationPorts(normalized)), parsed.deleteAvd === false
        ? "Android emulator deleteAvd=false deletes only owner broker metadata" : "Owner-scoped Android AVD artifacts are removed through identity-fenced storage cleanup");
}
function planBrokerIosCreateCommand(owner: string, parsed: CommandParamSuccess, normalized: NormalizedBrokerOptions, create = parsed.create || {}) {
    return nativePreparedCommand(semanticIosCreate(owner, parsed, brokerIosLifecyclePorts(normalized), create));
}
function planBrokerIosExistingCommand(owner: string, parsed: CommandParamSuccess, device: unknown, normalized: NormalizedBrokerOptions) {
    return nativePreparedCommand(semanticIosExisting(owner, parsed, device, brokerIosLifecyclePorts(normalized)));
}
function planBrokerMacosCreateCommand(owner: string, parsed: CommandParamSuccess, normalized: NormalizedBrokerOptions, create = parsed.create || {}) {
    return nativePreparedCommand(semanticMacosCreate(owner, parsed, brokerMacosLifecyclePorts(normalized), create));
}
function planBrokerMacosExistingCommand(owner: string, parsed: CommandParamSuccess, device: unknown, normalized: NormalizedBrokerOptions) {
    return nativePreparedCommand(semanticMacosExisting(owner, parsed, device, brokerMacosLifecyclePorts(normalized)));
}
function providerCommandForCreate(ownerId: string, parsed: CommandParamSuccess, normalized: NormalizedBrokerOptions): ProviderCommand | { error: string; missing: string[] } {
    const create = parsed.create || {};
    if (parsed.backend === "android-emulator" && create.createAvd === true) return planBrokerAndroidCreateCommand(ownerId, parsed, normalized, create);
    if (parsed.backend === "ios-simulator" && create.createSimulator === true) return planBrokerIosCreateCommand(ownerId, parsed, normalized, create);
    if (isHyperVBackend(parsed.backend)) {
        const linuxGuest = parsed.backend === "linux-vm";
        const image = typeof create.image === "string" && create.image ? create.image : null;
        if (!image) return { error: "hyper-v-base-image-not-prepared", missing: ["prepared image or sourceImage VHDX"] };
        const baseImageSha256 = typeof create.baseImageSha256 === "string" ? create.baseImageSha256 : null;
        if (!baseImageSha256) return { error: "hyper-v-base-image-hash-missing", missing: ["verified base image SHA-256"] };
        const baseImageGeneration = create.baseImageGeneration === 1 || create.baseImageGeneration === 2 ? create.baseImageGeneration : null;
        if (!baseImageGeneration) return { error: "hyper-v-base-image-generation-missing", missing: ["verified base image generation"] };
        const powershell = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
        if (!powershell) return { error: "missing-provider-command", missing: ["powershell"] };
        const globalBaseImageRoot = hyperVImageRoot();
        const ownerBaseImageRoot = join(brokerPrivateRoot(), "owners", ownerId, "images", "hyper-v");
        let baseImageRoot: string | null = null;
        try {
            for (const candidate of [ownerBaseImageRoot, globalBaseImageRoot]) {
                try {
                    assertDeviceLabPathWithinRoot(candidate, image, "hyper-v-base-image");
                    baseImageRoot = candidate;
                    break;
                } catch {
                    // Continue until the image is fenced by an accepted cache root.
                }
            }
            if (!baseImageRoot) throw new Error("hyper-v-base-image-outside-cache");
            const imageStat = lstatSync(image);
            if (!imageStat.isFile() || imageStat.isSymbolicLink()) throw new Error("hyper-v-base-image-invalid");
        } catch {
            return { error: "hyper-v-base-image-invalid", missing: [`regular VHDX below ${ownerBaseImageRoot} or ${globalBaseImageRoot}`] };
        }
        const deviceRoot = hyperVDeviceRoot(ownerId, parsed.backend, parsed.deviceId);
        const diskPath = join(deviceRoot, "disks", "root.vhdx");
        try {
            return hyperVCreateCommand({
                executable: powershell,
                ownerId,
                deviceId: parsed.deviceId,
                incarnationId: validHyperVIncarnationId(create.incarnationId)
                    ? create.incarnationId
                    : parsed.dryRun
                        ? "0".repeat(32)
                        : (() => { throw new Error("hyper-v-incarnation-id-invalid"); })(),
                vmName: hyperVVmName(ownerId, parsed.deviceId, validHyperVIncarnationId(create.incarnationId)
                    ? create.incarnationId
                    : parsed.dryRun
                        ? "0".repeat(32)
                        : (() => { throw new Error("hyper-v-incarnation-id-invalid"); })()),
                baseImagePath: image,
                baseImageSha256,
                baseImageGeneration,
                baseImageRoot: baseImageRoot!,
                deviceRoot,
                diskPath,
                memoryMb: typeof create.memoryMb === "number" ? create.memoryMb : 4096,
                cpus: typeof create.cpus === "number" ? create.cpus : 2,
                nestedVirtualization: create.nestedVirtualization === true,
                diskMaxBytes: typeof create.diskMaxBytes === "number" ? create.diskMaxBytes : 0,
                switchName: typeof create.switchName === "string" ? create.switchName : null,
                macAddress: typeof create.macAddress === "string" ? create.macAddress : null,
                networking: create.networking !== false,
                bootstrapDhcp: linuxGuest,
                checkpointType: linuxGuest ? "Production" : "ProductionOnly",
                ...hyperVSecureBootConfiguration(parsed.backend),
            });
        } catch (error) {
            return { error: error instanceof Error ? error.message : "invalid-hyper-v-create-options", missing: [] };
        }
    }
    if (parsed.backend === "macos-vm") return planBrokerMacosCreateCommand(ownerId, parsed, normalized, create);
    return { mode: "noop", provider: "host-broker-state", reason: "device_create writes owner-scoped broker metadata" };
}

function brokerIosSimulatorPrefix(ownerId: string): string {
    return `ccc-${ownerId}-`;
}

function resolveBrokerOwnedIosSimulatorTarget(ownerId: string, device: unknown, normalized: NormalizedBrokerOptions, options?: {timeoutMs: number; outputLimit: number}) {
    const simulatorName = field(device, "simulatorName");
    const recordedUdid = field(device, "udid");
    if (!simulatorName || !simulatorName.startsWith(brokerIosSimulatorPrefix(ownerId))) {
        return { ok: false as const, error: "ios-simulator-not-owner-scoped", missing: ["owner-prefixed simulatorName"] };
    }
    const executable = executableFor("xcrun", normalized);
    const inventory = normalized.commandRunner({
        mode: "exec",
        provider: "xcrun",
        executable,
        args: ["simctl", "list", "devices", "-j"],
    }, {
        timeoutMs: Math.min(normalized.commandTimeoutMs, 30000, options?.timeoutMs ?? Infinity),
        outputLimit: Math.min(DEVICE_BROKER_COMMAND_OUTPUT_LIMIT, options?.outputLimit ?? Infinity),
    });
    if (!commandSucceeded(inventory)) {
        return { ok: false as const, error: "ios-simulator-owner-inventory-unavailable", missing: ["readable simctl device inventory"], inventory };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(inventory.stdout || "{}");
    } catch {
        return { ok: false as const, error: "ios-simulator-owner-inventory-invalid", missing: ["valid simctl JSON device inventory"], inventory };
    }
    const groups = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && (parsed as { devices?: unknown }).devices && typeof (parsed as { devices?: unknown }).devices === "object"
        && !Array.isArray((parsed as { devices?: unknown }).devices)
        ? Object.values((parsed as { devices: Record<string, unknown> }).devices)
        : [];
    const simulators = groups.flatMap((group) => Array.isArray(group) ? group : [])
        .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate)));
    const matches = recordedUdid
        ? simulators.filter((candidate) => field(candidate, "udid") === recordedUdid)
        : simulators.filter((candidate) => field(candidate, "name") === simulatorName);
    if (matches.length !== 1) {
        return { ok: false as const, error: "ios-simulator-owner-identity-unverified", missing: ["exactly one matching host simulator"], matchCount: matches.length, inventory };
    }
    const hostName = field(matches[0], "name");
    const hostUdid = field(matches[0], "udid");
    if (hostName !== simulatorName || !hostName.startsWith(brokerIosSimulatorPrefix(ownerId)) || !hostUdid) {
        return { ok: false as const, error: "ios-simulator-owner-identity-mismatch", missing: ["matching owner-prefixed host simulator name and UDID"], hostName, hostUdid, inventory };
    }
    return { ok: true as const, target: hostUdid, simulatorName: hostName, state: field(matches[0], "state"), inventory };
}

function providerCommandFor(ownerId: string, parsed: CommandParamSuccess, device: unknown, normalized: NormalizedBrokerOptions): ProviderCommand | { error: string; missing: string[] } {
    if (parsed.backend === "android-emulator") return planBrokerAndroidExistingCommand(ownerId, parsed, device, normalized);

    if (parsed.backend === "android-device") {
        const serial = field(device, "serial");
        if ((parsed.command === "device_status" || parsed.command === "device_start") && serial) {
            return { mode: "exec", provider: "adb", executable: executableFor("adb", normalized), args: ["-s", serial, "get-state"] };
        }
        if (parsed.command === "device_status" || parsed.command === "device_start") return { error: "missing-provider-metadata", missing: ["serial"] };
        return { mode: "noop", provider: "android-device", reason: "physical Android stop/delete does not power off or disconnect the real device" };
    }

    if (parsed.backend === "ios-simulator") return planBrokerIosExistingCommand(ownerId, parsed, device, normalized);

    if (parsed.backend === "ios-device") {
        const udid = field(device, "udid");
        if (parsed.command === "device_status" || parsed.command === "device_start") {
            if (!udid) return { error: "missing-provider-metadata", missing: ["udid"] };
            return { mode: "exec", provider: "xcrun", executable: executableFor("xcrun", normalized), args: ["devicectl", "device", "info", "details", "--device", udid] };
        }
        return { mode: "noop", provider: "ios-device", reason: "physical iOS stop/delete does not power off, erase, or disconnect the real device" };
    }

    if (parsed.backend === "windows-sandbox") return planBrokerWindowsSandboxCommand(ownerId,parsed,device,{executable: name => executableFor(name, normalized), stopRuntimeId: brokerWindowsSandboxIdForStop, readConfig: readBrokerWindowsLifecycleConfig, newRuntimeId: randomGuid});

    if (isHyperVBackend(parsed.backend)) {
        const powershell = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
        if (!powershell) return { error: "missing-provider-command", missing: ["powershell"] };
        const vmName = field(device, "vmName");
        const vmId = field(device, "vmId");
        const diskPath = field(device, "diskPath");
        const incarnationId = device && typeof device === "object" && !Array.isArray(device)
            ? hyperVDeviceIncarnationId(device as Record<string, unknown>)
            : null;
        if (!vmName || !vmId || !incarnationId) return { error: "missing-provider-metadata", missing: ["vmName", "vmId", "incarnationId"] };
        const expectedVmName = hyperVVmName(ownerId, parsed.deviceId, incarnationId);
        const expectedDeviceRoot = hyperVDeviceRoot(ownerId, parsed.backend, parsed.deviceId);
        const expectedDiskPath = join(expectedDeviceRoot, "disks", "root.vhdx");
        if (vmName !== expectedVmName || (diskPath && resolve(diskPath) !== resolve(expectedDiskPath))) {
            return { error: "invalid-provider-metadata", missing: ["canonical owner-scoped Hyper-V VM name and disk path"] };
        }
        const options = { executable: powershell, ownerId, deviceId: parsed.deviceId, incarnationId, vmName, vmId, diskPath };
        try {
            if (parsed.command === "device_status") return hyperVStatusCommand(options);
            if (parsed.command === "device_start") return hyperVStartCommand({
                ...options,
                memoryMb: numberField(device, "memoryMb") || 4096,
                cpus: numberField(device, "cpus") || 2,
            });
            if (parsed.command === "device_stop") return hyperVStopCommand(options, parsed.force);
            if (parsed.command === "device_reboot") return hyperVRebootCommand({
                ...options,
                force: parsed.force,
                startIfStopped: parsed.startIfStopped,
            });
            if (!diskPath) return { error: "missing-provider-metadata", missing: ["diskPath"] };
            return hyperVDeleteCommand({
                ...options,
                diskPath,
                auxiliaryMediaPaths: [join(expectedDeviceRoot, "disks", parsed.backend === "linux-vm" ? "cidata.iso" : "autounattend.iso")],
            });
        } catch (error) {
            return { error: error instanceof Error ? error.message : "invalid-hyper-v-lifecycle-options", missing: [] };
        }
    }

    if (parsed.backend === "macos-vm") return planBrokerMacosExistingCommand(ownerId, parsed, device, normalized);

    return { error: "unsupported-provider-command", missing: [] };
}

function truncateOutput(value: unknown, limit: number) {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
    return text.length > limit ? text.slice(0, limit) : text;
}

function executableExtensions(executable: string): string[] {
    return process.platform === "win32" && !/\.[^\\/]+$/.test(executable)
        ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
        : [""];
}

function resolveExecutablePath(executable: string): string | null {
    if (executable.includes("/") || executable.includes("\\")) {
        try {
            accessSync(executable, fsConstants.X_OK);
            return executable;
        } catch {
            return null;
        }
    }
    for (const pathEntry of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
        for (const extension of executableExtensions(executable)) {
            try {
                const candidate = join(pathEntry, `${executable}${extension}`);
                accessSync(candidate, fsConstants.X_OK);
                return candidate;
            } catch {
                // Continue PATH lookup without invoking a shell.
            }
        }
    }
    return null;
}

function androidExecutableNames(name: string): string[] {
    if (/\.(exe|bat|cmd)$/i.test(name)) return [name];
    return process.platform === "win32" ? [name, `${name}.exe`, `${name}.bat`, `${name}.cmd`] : [name];
}

function androidToolSubdirs(sdk: string, name: string): string[] {
    if (name === "emulator") return [join(sdk, "emulator")];
    if (name === "avdmanager") {
        const subdirs = [join(sdk, "cmdline-tools", "latest", "bin"), join(sdk, "cmdline-tools", "bin"), join(sdk, "tools", "bin")];
        const cmdlineTools = join(sdk, "cmdline-tools");
        try {
            for (const entry of readdirSync(cmdlineTools, { withFileTypes: true })) {
                if (entry.isDirectory()) subdirs.push(join(cmdlineTools, entry.name, "bin"));
            }
        } catch {
            // Ignore absent SDK command-line tools directory.
        }
        return [...new Set(subdirs)];
    }
    return [join(sdk, "platform-tools")];
}

function androidSdkCandidates(): string[] {
    const candidates = [
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : null,
        process.env.APPDATA ? join(process.env.APPDATA, "Android", "Sdk") : null,
        join(homedir(), "AppData", "Local", "Android", "Sdk"),
        join(homedir(), "Android", "Sdk"),
        join(homedir(), "Library", "Android", "sdk"),
        "/opt/android-sdk",
        "/usr/local/android-sdk",
    ];
    return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

function findMacosProvider(name: string): string | null {
    const fromPath = resolveExecutablePath(name);
    if (fromPath) return fromPath;
    for (const base of DEVICE_BROKER_MACOS_PROVIDER_PATHS) {
        const candidate = join(base, name);
        try {
            accessSync(candidate, fsConstants.X_OK);
            return candidate;
        } catch {
            // Continue Homebrew/system fallback lookup for launchd's minimal PATH.
        }
    }
    return null;
}

function findAndroidTool(name: string, normalized: NormalizedBrokerOptions): string | null {
    const injected = normalized.providerPaths[name];
    if (injected) return injected;
    const fromPath = resolveExecutablePath(name);
    if (fromPath) return fromPath;
    for (const sdk of androidSdkCandidates()) {
        for (const subdir of androidToolSubdirs(sdk, name)) {
            for (const executable of androidExecutableNames(name)) {
                const candidate = join(subdir, executable);
                try {
                    accessSync(candidate, fsConstants.X_OK);
                    return candidate;
                } catch {
                    // Continue SDK lookup.
                }
            }
        }
    }
    return null;
}

function executableExists(executable: string) {
    return Boolean(resolveExecutablePath(executable));
}

function quoteWindowsCommandArg(value: string): string {
    if (!/[ \t"&|<>^]/.test(value)) return value;
    return `"${value.replace(/(["^&|<>])/g, "^$1")}"`;
}

function assertSafeWindowsCommandArguments(values: string[]): void {
    for (const value of values) {
        if (/[\r\n]/.test(value)) throw new Error("windows-command-argument-newline-rejected");
        if (value.includes("%")) throw new Error("windows-command-argument-percent-expansion-rejected");
    }
}

function quotePowerShellSingleString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function powershellEncodedCommand(script: string): string {
    return Buffer.from(script, "utf16le").toString("base64");
}

function quoteWindowsProcessArgument(value: string): string {
    if (value.length === 0) return '""';
    if (!/[ \t\r\n"]/.test(value)) return value;
    let result = '"';
    let backslashes = 0;
    for (const char of value) {
        if (char === "\\") {
            backslashes += 1;
        } else if (char === '"') {
            result += "\\".repeat((backslashes * 2) + 1);
            result += '"';
            backslashes = 0;
        } else {
            result += "\\".repeat(backslashes);
            result += char;
            backslashes = 0;
        }
    }
    result += "\\".repeat(backslashes * 2);
    result += '"';
    return result;
}

export function windowsHiddenVbsLauncherScript(executable: string, args: string[]): string {
    assertSafeWindowsCommandArguments([executable, ...args]);
    const commandLine = [quoteWindowsCommandArg(executable), ...args.map(quoteWindowsCommandArg)].join(" ");
    const hiddenCommand = `%ComSpec% /d /s /c "${commandLine} >NUL 2>NUL"`;
    return [
        "Set Shell = CreateObject(\"WScript.Shell\")",
        `Shell.Run "${hiddenCommand.replace(/"/g, "\"\"")}", 0, False`,
        "",
    ].join("\r\n");
}

function windowsHiddenVbsLauncherPrefix(command: ProviderCommand): string {
    const digest = createHash("sha256")
        .update(JSON.stringify({ executable: command.executable || "", args: command.args || [] }))
        .digest("hex")
        .slice(0, 16);
    return digest;
}

function safeWindowsLauncherProvider(provider: string): string {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(provider)) throw new Error("windows-provider-launcher-provider-invalid");
    return provider;
}

export function windowsHiddenVbsLauncherInvocation(command: ProviderCommand): { executable?: string; args: string[]; cleanupPath?: string } {
    if (!command.executable) return { executable: command.executable, args: command.args || [] };
    const provider = safeWindowsLauncherProvider(command.provider || "provider");
    const launcherPath = createExclusiveBrokerLauncher(
        join(brokerRoot(), "launchers", provider),
        windowsHiddenVbsLauncherPrefix(command),
        "vbs",
        windowsHiddenVbsLauncherScript(command.executable, command.args || []),
    );
    return { executable: "wscript.exe", args: ["//B", launcherPath], cleanupPath: launcherPath };
}

function detachedProviderCommandSpawn(command: ProviderCommand): { executable?: string; args: string[]; cleanupPath?: string } {
    if (process.platform === "win32" && command.windowsHiddenLauncher) {
        return windowsHiddenVbsLauncherInvocation(command);
    }
    return providerCommandSpawn(command);
}

function removeWindowsLauncher(path: string | undefined): void {
    if (!path) return;
    try { unlinkSync(path); } catch { /* launcher cleanup is best-effort */ }
}

function scheduleWindowsLauncherCleanup(path: string | undefined, child: ReturnType<typeof spawn>): void {
    if (!path) return;
    const timer = setTimeout(() => removeWindowsLauncher(path), 60000);
    timer.unref();
    child.once("close", () => {
        clearTimeout(timer);
        removeWindowsLauncher(path);
    });
}

function windowsMinimizedStartProcessInvocation(command: ProviderCommand): { executable?: string; args: string[] } | null {
    if (!command.executable) return null;
    const waitForExit = command.waitForExit !== false;
    const waitFlags = waitForExit ? " -Wait" : "";
    const exitCheck = waitForExit ? "if ($null -ne $Process.ExitCode) { exit $Process.ExitCode }" : "";
    const argumentLine = (command.args || []).map(quoteWindowsProcessArgument).join(" ");
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$Executable = ${quotePowerShellSingleString(command.executable)}`,
        `$Arguments = ${quotePowerShellSingleString(argumentLine)}`,
        `$Process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Minimized${waitFlags} -PassThru`,
        exitCheck,
        "exit 0",
    ].filter(Boolean).join("\n");
    return {
        executable: "powershell.exe",
        args: ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(script)],
    };
}

export function windowsSandboxWindowHandleSnapshotArgs(): string[] {
    const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$Handles = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and (($_.ProcessName -match 'WindowsSandbox|wsb') -or ($_.MainWindowTitle -like '*Windows Sandbox*')) } | ForEach-Object { [Int64]$_.MainWindowHandle } | Select-Object -Unique)",
        "$Handles | ConvertTo-Json -Compress",
        "exit 0",
    ].join("\n");
    return ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(script)];
}

export function windowsSandboxWindowHandlesFromOutput(stdout: string): number[] | null {
    const trimmed = String(stdout || "").trim();
    if (!trimmed) return [];
    try {
        const parsed = JSON.parse(trimmed);
        const values = Array.isArray(parsed) ? parsed : [parsed];
        return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))];
    } catch {
        return null;
    }
}

export function windowsSandboxMinimizeWatchdogArgs(timeoutMs = DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS, startedAfter = "", cancelPath = "", baselineHandles: number[] | null = null, resultPath = ""): string[] {
    const boundedTimeoutMs = Math.min(600000, Math.max(1000, Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS));
    const boundedStartedAfter = Number.isNaN(Date.parse(startedAfter)) ? new Date().toISOString() : new Date(startedAfter).toISOString();
    const normalizedBaselineHandles = Array.isArray(baselineHandles)
        ? [...new Set(baselineHandles.filter((value) => Number.isSafeInteger(value) && value > 0))]
        : [];
    const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$Signature = @'",
        "using System;",
        "using System.Runtime.InteropServices;",
        "public static class CccNativeWindow {",
        "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
        "}",
        "'@",
        "Add-Type -TypeDefinition $Signature -ErrorAction SilentlyContinue | Out-Null",
        `$StartedAfter = [DateTime]::Parse('${boundedStartedAfter.replace(/'/g, "''")}').ToUniversalTime()`,
        `$HasBaselineSnapshot = $${Array.isArray(baselineHandles) ? "true" : "false"}`,
        `$BaselineHandles = @(${normalizedBaselineHandles.join(",")})`,
        `$CancelPath = '${cancelPath.replace(/'/g, "''")}'`,
        `$ResultPath = '${resultPath.replace(/'/g, "''")}'`,
        `$Deadline = (Get-Date).AddMilliseconds(${boundedTimeoutMs})`,
        "$Minimized = $false",
        "while ((Get-Date) -lt $Deadline -and (-not $CancelPath -or -not (Test-Path -LiteralPath $CancelPath))) {",
        "  $Handles = @()",
        "  try {",
        "    $Handles = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {",
        "      $Handle = [Int64]$_.MainWindowHandle",
        "      $Candidate = $Handle -ne 0 -and (($_.ProcessName -match 'WindowsSandbox|wsb') -or ($_.MainWindowTitle -like '*Windows Sandbox*'))",
        "      $NewHandle = $HasBaselineSnapshot -and -not ($BaselineHandles -contains $Handle)",
        "      $NewProcess = (-not $HasBaselineSnapshot) -and $_.StartTime.ToUniversalTime() -ge $StartedAfter",
        "      $Candidate -and ($NewHandle -or $NewProcess)",
        "    } | ForEach-Object { [Int64]$_.MainWindowHandle } | Select-Object -Unique)",
        "  } catch {}",
        "  foreach ($Handle in $Handles) { if ([CccNativeWindow]::ShowWindowAsync([IntPtr]$Handle, 6)) { $Minimized = $true } }",
        "  if ($Minimized) {",
        "    if ($ResultPath) { Set-Content -LiteralPath $ResultPath -Value 'minimized' -NoNewline -Encoding Ascii }",
        "    break",
        "  }",
        "  Start-Sleep -Milliseconds 250",
        "}",
        "if (-not $Minimized -and $ResultPath -and -not (Test-Path -LiteralPath $ResultPath)) { Set-Content -LiteralPath $ResultPath -Value 'not-minimized' -NoNewline -Encoding Ascii }",
        "exit 0",
    ].join("\n");
    return ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(script)];
}

export function providerCommandSpawn(command: ProviderCommand, platform: NodeJS.Platform = process.platform): { executable?: string; args: string[] } {
    const executable = command.executable;
    const args = platform === "win32"
        && executable
        && /^(?:powershell|pwsh)(?:\.exe)?$/i.test(win32.basename(executable))
        ? hiddenWindowsPowerShellArgs(command.args || [])
        : command.args || [];
    if (platform === "win32" && command.windowStyle === "minimized") {
        const invocation = windowsMinimizedStartProcessInvocation(command);
        if (invocation) return invocation;
    }
    if (platform === "win32" && executable && /\.(bat|cmd)$/i.test(executable)) {
        assertSafeWindowsCommandArguments([executable, ...args]);
        const commandLine = [quoteWindowsCommandArg(executable), ...args.map(quoteWindowsCommandArg)].join(" ");
        return { executable: "cmd.exe", args: ["/d", "/s", "/c", commandLine] };
    }
    return { executable, args };
}

export function hiddenChildProcessOptions<T extends object>(options: T): T & { windowsHide: true } {
    return { ...options, windowsHide: true };
}

function packageRootForBroker(): string {
    return resolve(fileURLToPath(new URL("../", import.meta.url)));
}

type DeviceLabBackendInvocation = {
    modulePath: string;
    handlerName: string;
    supportedBackends: string[];
};

function deviceLabBackendInvocation(_normalized: NormalizedBrokerOptions, backend: string | null): DeviceLabBackendInvocation | null {
    const backendRoot = fileURLToPath(new URL("../providers/backends/", import.meta.url));
    if (backend === "windows-sandbox") {
        return {
            modulePath: join(backendRoot, "windows-sandbox.mjs"),
            handlerName: "handleWindowsTool",
            supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
        };
    }
    if (backend === "macos-vm") {
        return {
            modulePath: join(backendRoot, "macos-vm.mjs"),
            handlerName: "handleMacosTool",
            supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
        };
    }
    if (backend === "android-emulator") {
        return {
            modulePath: join(backendRoot, "android.mjs"),
            handlerName: "handleAndroidTool",
            supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
        };
    }
    if (backend === "android-device") {
        return {
            modulePath: join(backendRoot, "android-device.mjs"),
            handlerName: "handleAndroidRealTool",
            supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
        };
    }
    if (backend === "ios-simulator") {
        return {
            modulePath: join(backendRoot, "ios-simulator.mjs"),
            handlerName: "handleIosTool",
            supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
        };
    }
    if (backend === "ios-device") {
        return {
            modulePath: join(backendRoot, "ios-device.mjs"),
            handlerName: "handleIosRealTool",
            supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
        };
    }
    return null;
}

type BrokerBackendChildResult = {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    error?: Error;
    timedOut: boolean;
    cleanup?: BrokerProcessTreeCleanup;
};

function captureBrokerCommandAllowance(options: Pick<ProviderCommandRunnerOptions, "timeoutMs" | "cleanupGraceMs" | "wrapperTimeoutMs" | "remainingMs">) {
    const startedAt = performance.now();
    const timeoutMs = Math.max(1, options.timeoutMs);
    const cleanupGraceMs = Math.min(10000, Math.max(1, options.cleanupGraceMs ?? 1000));
    const wrapperTimeoutMs = Math.max(1, options.wrapperTimeoutMs ?? (timeoutMs + cleanupGraceMs + 15000));
    const commandDeadlineAt = startedAt + timeoutMs;
    const wrapperDeadlineAt = startedAt + wrapperTimeoutMs;
    const completionDeadlineAt = commandDeadlineAt + 15000 + cleanupGraceMs;
    const fallbackDeadlineAt = Math.min(completionDeadlineAt, wrapperDeadlineAt + 15000 + cleanupGraceMs);
    const remainingMs = (deadlineAt: number, observedAt = performance.now()) => {
        const remaining = deadlineAt - observedAt;
        let parent = Infinity;
        if (options.remainingMs) { try { parent = options.remainingMs(); } catch { parent = 0; } }
        const bounded = Math.min(remaining, parent);
        return Number.isFinite(bounded) && bounded >= 1 ? Math.floor(bounded) : 0;
    };
    return { timeoutMs, cleanupGraceMs, wrapperTimeoutMs, commandDeadlineAt, wrapperDeadlineAt, completionDeadlineAt, fallbackDeadlineAt, remainingMs };
}

export function runBrokerBackendChild(
    script: string,
    input: string,
    options: {
        cwd: string;
        env?: NodeJS.ProcessEnv;
        timeoutMs: number;
        outputLimit: number;
        cleanupGraceMs?: number;
        terminateTree?: (pid: number | undefined) => BrokerProcessTreeCleanup;
    },
): Promise<BrokerBackendChildResult> {
    const allowance = captureBrokerCommandAllowance(options);
    return new Promise((resolveResult) => {
        const commandRemainingMs = () => allowance.remainingMs(allowance.commandDeadlineAt);
        const completionRemainingMs = () => allowance.remainingMs(allowance.completionDeadlineAt);
        const timeoutError = () => new Error(`device-lab backend tool timed out after ${options.timeoutMs}ms`);
        if (!commandRemainingMs()) {
            resolveResult({ status: null, signal: null, stdout: "", stderr: "", error: timeoutError(), timedOut: true });
            return;
        }
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], hiddenChildProcessOptions({
            cwd: options.cwd,
            ...(options.env ? { env: options.env } : {}),
            detached: process.platform !== "win32",
        }));
        const spawnedProcessIdentity = readDeviceRuntimeProcessIdentity(child.pid, { remainingMs: commandRemainingMs });
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let outputBytes = 0;
        let settled = false;
        let timedOut = false;
        let childError: Error | undefined;
        let nativeFailure: { status: number | null; signal: NodeJS.Signals | null } | undefined;
        let cleanup: BrokerProcessTreeCleanup | undefined;
        let timer: NodeJS.Timeout | undefined;
        let forceSettleTimer: NodeJS.Timeout | undefined;
        const cleanupFailureError = () => cleanup && !cleanup.ok
            ? `process-tree cleanup failed${cleanup.error ? `: ${cleanup.error}` : ""}`
            : null;
        const terminateTree = () => {
            if (cleanup) return;
            cleanup = options.terminateTree && completionRemainingMs()
                ? options.terminateTree(child.pid)
                : terminateBrokerSpawnedProcessTree(child.pid, {
                    expectedIdentity: spawnedProcessIdentity,
                    requireIdentity: true,
                    remainingMs: completionRemainingMs,
                });
            const cleanupFailure = cleanupFailureError();
            if (cleanupFailure) {
                childError = new Error(childError ? `${childError.message}; ${cleanupFailure}` : cleanupFailure);
            }
            if (!forceSettleTimer) {
                forceSettleTimer = setTimeout(() => {
                    if (!childError) childError = new Error("device-lab backend child did not close after process-tree cleanup");
                    child.stdin?.destroy();
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    child.unref();
                    finish(null, null);
                }, Math.min(allowance.cleanupGraceMs, completionRemainingMs()));
                forceSettleTimer.unref();
            }
        };
        const finish = (status: number | null, signal: NodeJS.Signals | null) => {
            if (settled) return;
            if (!childError && !nativeFailure && !timedOut && status === 0 && !commandRemainingMs()) {
                timedOut = true;
                childError = timeoutError();
                terminateTree();
            }
            if (nativeFailure && !timedOut && status === null) ({ status, signal } = nativeFailure);
            settled = true;
            if (timer) clearTimeout(timer);
            if (forceSettleTimer) clearTimeout(forceSettleTimer);
            resolveResult({
                status,
                signal,
                stdout: stdout.toString("utf8"),
                stderr: stderr.toString("utf8"),
                error: childError,
                timedOut,
                cleanup,
            });
        };
        const append = (target: "stdout" | "stderr", chunk: Buffer) => {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = Math.max(0, options.outputLimit - Math.min(outputBytes, options.outputLimit));
            if (remaining > 0) {
                if (target === "stdout") stdout = Buffer.concat([stdout, value.subarray(0, remaining)]);
                else stderr = Buffer.concat([stderr, value.subarray(0, remaining)]);
            }
            outputBytes += value.length;
            if (!childError && outputBytes > options.outputLimit) {
                childError = new Error("device-lab backend output exceeded limit");
                terminateTree();
            }
        };
        child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
        child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
        child.once("error", (error) => {
            if (!childError) childError = error;
            finish(null, null);
        });
        child.once("exit", (status, signal) => {
            if (!timedOut && !childError && (status !== 0 || signal)) nativeFailure = { status, signal };
        });
        child.once("close", finish);
        const expire = () => {
            if (!childError && !nativeFailure) {
                timedOut = true;
                childError = timeoutError();
            }
            terminateTree();
        };
        const remaining = commandRemainingMs();
        if (remaining) {
            timer = setTimeout(expire, remaining);
            child.stdin?.end(input);
        }
        else expire();
    });
}

function deviceLabBackendToolArgs(parsed: DeviceToolParamSuccess): Record<string, unknown> {
    const allowed = new Set([
        "handle",
        "backend",
        "action",
        "serial",
        "udid",
        "host",
        "port",
        "pairHost",
        "pairPort",
        "pairingCode",
        "connect",
        "deviceId",
        "command",
        "argv",
        "localPath",
        "remotePath",
        "path",
        "replace",
        "packageName",
        "component",
        "bundleId",
        "containerType",
        "limit",
        "snapshotName",
        "snapshotId",
        "force",
        "eraseSimulator",
        "confirmDestructive",
        "x",
        "y",
        "x1",
        "y1",
        "x2",
        "y2",
        "button",
        "key",
        "keyCode",
        "text",
        "direction",
        "amount",
        "durationMs",
        "orientation",
        "url",
        "permission",
        "service",
        "latitude",
        "longitude",
        "altitude",
        "level",
        "charging",
        "status",
        "wifi",
        "airplaneMode",
        "data",
        "enabled",
        "timeoutMs",
        "intervalMs",
        "timeLimitSec",
        "helperTimeoutMs",
        "maxDepth",
        "maxNodes",
        "minimized",
    ]);
    return Object.fromEntries(Object.entries(parsed.params).filter(([key]) => allowed.has(key)));
}

function boundedDeviceToolTimeoutMs(value: unknown, maximum: number, fallback: number): number {
    const requested = Number(value);
    if (!Number.isFinite(requested) || requested <= 0) return fallback;
    return Math.min(maximum, Math.max(1, Math.trunc(requested)));
}

export function deviceBrokerBackendToolTimeoutMs(tool: string, params: Record<string, unknown> = {}, commandTimeoutMs = DEVICE_BROKER_COMMAND_TIMEOUT_MS): number {
    const requestedHelperTimeoutMs = Number(params.helperTimeoutMs);
    const helperDeadlineMs = Number.isFinite(requestedHelperTimeoutMs) && requestedHelperTimeoutMs > 0
        ? boundedDeviceToolTimeoutMs(requestedHelperTimeoutMs, DEVICE_BROKER_MAX_HELPER_TIMEOUT_MS, DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_MS) + DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_BUFFER_MS
        : DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_MS;
    const requestedOperationTimeoutMs = Number(params.timeoutMs);
    const operationDeadlineMs = DEVICE_BROKER_BOUNDED_WAIT_TOOLS.has(tool) && Number.isFinite(requestedOperationTimeoutMs) && requestedOperationTimeoutMs > 0
        ? boundedDeviceToolTimeoutMs(requestedOperationTimeoutMs, DEVICE_BROKER_MAX_OPERATION_TIMEOUT_MS, DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_MS) + DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_BUFFER_MS
        : DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_MS;
    const boundedCommandTimeoutMs = boundedDeviceToolTimeoutMs(commandTimeoutMs, DEVICE_BROKER_MAX_OPERATION_TIMEOUT_MS, DEVICE_BROKER_COMMAND_TIMEOUT_MS);
    return Math.max(
        boundedCommandTimeoutMs,
        DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_MS,
        helperDeadlineMs,
        operationDeadlineMs,
    );
}

async function defaultBrokerDeviceToolRunner(ownerId: string, parsed: DeviceToolParamSuccess, match: DeviceToolMatch, normalized: NormalizedBrokerOptions): Promise<BrokerRpcResult> {
    const invocation = deviceLabBackendInvocation(normalized, match.backend);
    if (!invocation) {
        return {
            status: 501,
            payload: {
                ok: false,
                error: "broker-device-tool-backend-not-supported",
                backend: match.backend,
                tool: parsed.tool,
                supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
            },
        };
    }
    const { modulePath, handlerName } = invocation;
    if (!existsSync(modulePath)) {
        return { status: 500, payload: { ok: false, error: "device-lab-backend-module-missing", modulePath, tool: parsed.tool } };
    }
    const expectedOwnerId = canonicalDeviceLabOwnerId(normalized.cwd, normalized.profile);
    if (ownerId !== expectedOwnerId) {
        return {
            status: 409,
            payload: {
                ok: false,
                error: "broker-owner-basis-unavailable",
                ownerId,
                expectedOwnerId,
                tool: parsed.tool,
                message: "This broker can proxy desktop device tools only for the cwd/profile owner it was launched for.",
            },
        };
    }
    const script = [
        "import { readFileSync } from 'fs';",
        "const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');",
        "const { moduleUrl, tool, args, handlerName } = payload;",
        "const backend = await import(moduleUrl);",
        "if (!handlerName || typeof backend[handlerName] !== 'function') throw new Error(`Missing backend handler: ${handlerName || '<empty>'}`);",
        "const result = await backend[handlerName](tool, args);",
        "process.stdout.write(JSON.stringify({ result: result || null }));",
    ].join("\n");
    const invocationPayload = {
        moduleUrl: pathToFileURL(modulePath).href,
        handlerName,
        tool: parsed.tool,
        args: deviceLabBackendToolArgs(parsed),
    };
    const outputLimit = Math.max(DEVICE_BROKER_COMMAND_OUTPUT_LIMIT, 12 * 1024 * 1024);
    const timeoutMs = deviceBrokerBackendToolTimeoutMs(parsed.tool, parsed.params, normalized.commandTimeoutMs);
    const result = await runBrokerBackendChild(script, JSON.stringify(invocationPayload), {
        cwd: normalized.cwd,
        env: { ...process.env, CCC_PROFILE: normalized.profile || "" },
        timeoutMs,
        outputLimit,
    });
    if (result.status !== 0 || result.error) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "device-lab-backend-tool-failed",
                tool: parsed.tool,
                backend: match.backend,
                status: result.status,
                signal: result.signal,
                stdout: truncateOutput(result.stdout, DEVICE_BROKER_COMMAND_OUTPUT_LIMIT),
                stderr: truncateOutput(result.stderr, DEVICE_BROKER_COMMAND_OUTPUT_LIMIT),
                detail: result.error ? result.error.message : undefined,
                timedOut: result.timedOut,
                timeoutMs,
                ...(result.cleanup ? { cleanup: result.cleanup } : {}),
            },
        };
    }
    let parsedOutput: { result?: unknown } | null = null;
    try {
        parsedOutput = JSON.parse(result.stdout || "{}") as { result?: unknown };
    } catch {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "device-lab-backend-tool-invalid-json",
                tool: parsed.tool,
                backend: match.backend,
                stdout: truncateOutput(result.stdout, DEVICE_BROKER_COMMAND_OUTPUT_LIMIT),
                stderr: truncateOutput(result.stderr, DEVICE_BROKER_COMMAND_OUTPUT_LIMIT),
            },
        };
    }
    if (!parsedOutput?.result) {
        return { status: 404, payload: { ok: false, error: "owner-device-not-found", deviceId: parsed.deviceId, backend: match.backend, tool: parsed.tool } };
    }
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                tool: parsed.tool,
                deviceId: parsed.deviceId,
                backend: match.backend,
                stateKey: match.stateKey,
                provider: "device-lab-backend-child",
                mcpResult: parsedOutput.result,
            },
        },
    };
}

export function boundedProviderCommandRunnerScript() {
    const windowsTerminationScript = JSON.stringify(windowsHandleBoundTerminationScript());
    return String.raw`
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");

const payload = workerData.payload;
const control = new Int32Array(workerData.shared, 0, 4);
const transport = new Uint8Array(workerData.shared, 16);
const identityTransport = new Uint8Array(workerData.identityShared);
// Admission state: 3 pre-dispatch, 4 spawn/publication in flight, 5 publication settled, -1 revoked.
const admission = workerData.admissionShared ? new Int32Array(workerData.admissionShared, 0, 5) : null;
const failureTransport = admission ? new Uint8Array(workerData.admissionShared, 20) : null;
const windowsTerminationScript = ${windowsTerminationScript};
const outputLimit = Math.max(1, Number(payload.outputLimit) || 1);
const cleanupGraceMs = Math.min(10000, Math.max(1, Number(payload.cleanupGraceMs) || 1000));
const startedAt = performance.now();
let commandDeadlineAt = startedAt + Math.max(1, Number(payload.timeoutMs) || 1);
let completionDeadlineAt = commandDeadlineAt + 15000 + cleanupGraceMs;
let stdout = Buffer.alloc(0);
let stderr = Buffer.alloc(0);
let outputBytes = 0;
let commandError;
let nativeFailure;
let timedOut = false;
let outputLimitExceeded = false;
let cleanup;
let settled = false;
let timer;
let forceSettleTimer;
let child;
let spawnedIdentity;

function remainingMs(deadlineAt) {
    const remaining = deadlineAt - performance.now();
    return Number.isFinite(remaining) && remaining >= 1 ? Math.floor(remaining) : 0;
}
const commandRemainingMs = () => remainingMs(commandDeadlineAt);
const completionRemainingMs = () => remainingMs(completionDeadlineAt);
const cancelled = () => admission && Atomics.load(admission, 3) !== 0;

function boundedText(value, limit = 8192) {
    const input = String(value || "");
    return Buffer.byteLength(input) <= limit ? input : Buffer.from(input).subarray(0, limit).toString("utf8");
}

function recordFailure(failure) {
    if (!admission || Atomics.load(admission, 4) !== 0) return;
    const encoded = Buffer.from(JSON.stringify(failure), "utf8");
    if (encoded.length > failureTransport.length) return;
    failureTransport.set(encoded);
    Atomics.store(admission, 4, encoded.length);
}

function append(current, chunk) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, outputLimit - outputBytes);
    outputBytes += value.length;
    if (remaining > 0) current = Buffer.concat([current, value.subarray(0, remaining)]);
    if (outputBytes > outputLimit) {
        outputLimitExceeded = true;
        if (!commandError) {
            commandError = "spawn ENOBUFS: device-lab provider output exceeded limit";
            recordFailure({ error: commandError, outputLimitExceeded: true });
        }
    }
    return current;
}

function processIdentity(pid, remainingMs) {
    function probeTimeout() {
        if (!remainingMs) return 5000;
        const remaining = remainingMs();
        return Number.isFinite(remaining) && remaining >= 1 ? Math.min(5000, Math.floor(remaining)) : 0;
    }
    try {
        if (!probeTimeout()) return null;
        let startToken = "";
        let commandLine = "";
        if (process.platform === "linux") {
            const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
            const close = stat.lastIndexOf(")");
            const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/) : [];
            startToken = fields[19] ? "linux:" + fields[19] : "";
            if (!probeTimeout()) return null;
            commandLine = readFileSync("/proc/" + pid + "/cmdline").toString("utf8").split("\0").filter(Boolean).join(" ");
        } else if (process.platform === "win32") {
            if (typeof payload.windowsPowerShellPath !== "string" || !payload.windowsPowerShellPath) return null;
            const script = "$P = Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "' -ErrorAction SilentlyContinue; $H = Get-Process -Id " + pid + " -ErrorAction SilentlyContinue; if ($P -and $H) { [pscustomobject]@{ startToken = ${windowsStartTokenExpression("$H")}; commandLine = [string]$P.CommandLine } | ConvertTo-Json -Compress }";
            const timeout = probeTimeout();
            if (!timeout) return null;
            const observed = spawnSync(payload.windowsPowerShellPath, ["-WindowStyle", "Hidden", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout, windowsHide: true });
            const parsed = observed.status === 0 && observed.stdout && observed.stdout.trim() ? JSON.parse(observed.stdout) : null;
            startToken = parsed && typeof parsed.startToken === "string" ? "windows:" + parsed.startToken : "";
            commandLine = parsed && typeof parsed.commandLine === "string" ? parsed.commandLine : "";
        } else {
            let timeout = probeTimeout();
            if (!timeout) return null;
            const started = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout, windowsHide: true });
            timeout = probeTimeout();
            if (!timeout) return null;
            const command = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout, windowsHide: true });
            startToken = started.status === 0 && started.stdout ? "ps:" + started.stdout.trim() : "";
            commandLine = command.status === 0 && command.stdout ? command.stdout.trim() : "";
        }
        if (!startToken || !commandLine || !probeTimeout()) return null;
        return { pid, startToken, commandHash: createHash("sha256").update(commandLine).digest("hex") };
    } catch {
        return null;
    }
}

function publishIdentity(identity) {
    if (!identity) return;
    const encoded = Buffer.from(JSON.stringify(identity), "utf8");
    if (encoded.length > identityTransport.length) return;
    identityTransport.set(encoded);
    Atomics.store(control, 3, encoded.length);
    Atomics.notify(control, 3);
}

function terminateTree(pid, expectedIdentity) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return { attempted: false, ok: false, pid: 0, signal: "SIGKILL", platform: process.platform, error: "spawned-process-pid-missing" };
    }
    if (!expectedIdentity) {
        return { attempted: false, ok: false, pid, signal: "SIGKILL", platform: process.platform, error: "spawned-process-identity-missing" };
    }
    if (!completionRemainingMs()) {
        return { attempted: false, ok: false, pid, signal: "SIGKILL", platform: process.platform, error: "spawned-process-identity-unavailable" };
    }
    const currentIdentity = processIdentity(pid, completionRemainingMs);
    if (!currentIdentity) {
        if (completionRemainingMs() && child && (child.exitCode !== null || child.signalCode !== null)) {
            return { attempted: false, ok: true, stale: true, pid, signal: "SIGKILL", platform: process.platform };
        }
        return { attempted: false, ok: false, pid, signal: "SIGKILL", platform: process.platform, error: "spawned-process-identity-unavailable" };
    }
    if (currentIdentity.pid !== expectedIdentity.pid
        || currentIdentity.startToken !== expectedIdentity.startToken
        || currentIdentity.commandHash !== expectedIdentity.commandHash) {
        return { attempted: false, ok: false, pid, signal: "SIGKILL", platform: process.platform, error: "spawned-process-identity-mismatch" };
    }
    const remaining = completionRemainingMs();
    if (!remaining) {
        return { attempted: false, ok: false, pid, signal: "SIGKILL", platform: process.platform, error: "spawned-process-identity-unavailable" };
    }
    if (process.platform === "win32") {
        if (typeof payload.windowsPowerShellPath !== "string" || !payload.windowsPowerShellPath) {
            return { attempted: false, ok: false, pid, signal: "SIGKILL", platform: process.platform, error: "windows-system-powershell-unavailable" };
        }
        const result = spawnSync(payload.windowsPowerShellPath, ["-WindowStyle", "Hidden", "-NoProfile", "-NonInteractive", "-Command", windowsTerminationScript], {
            encoding: "utf8",
            windowsHide: true,
            timeout: Math.min(11000, remaining),
            env: {
                ...process.env,
                CCC_WINDOWS_TERMINATE_PID: String(pid),
                CCC_WINDOWS_TERMINATE_START_TOKEN: expectedIdentity.startToken,
                CCC_WINDOWS_TERMINATE_TIMEOUT_MS: String(Math.min(10000, remaining)),
            },
        });
        const output = boundedText(String(result.stdout || "") + "\n" + String(result.stderr || ""));
        const ok = result.status === 0 && completionRemainingMs() > 0;
        return {
            attempted: true,
            ok,
            pid,
            signal: "SIGKILL",
            platform: process.platform,
            ...(ok ? {} : {
                error: result.status === 3
                    ? "spawned-process-identity-mismatch"
                    : result.status === 0 ? "process-termination-timeout"
                    : output.trim() || (result.error && result.error.message) || "process handle termination failed",
            }),
        };
    }
    try {
        process.kill(-pid, "SIGKILL");
        return { attempted: true, ok: true, pid, signal: "SIGKILL", platform: process.platform };
    } catch (error) {
        const stale = error && error.code === "ESRCH";
        return {
            attempted: true,
            ok: stale,
            ...(stale ? { stale: true } : {}),
            pid,
            signal: "SIGKILL",
            platform: process.platform,
            ...(stale ? {} : { error: error instanceof Error ? error.message : String(error) }),
        };
    }
}

function terminateForFailure() {
    if (cleanup) return;
    cleanup = terminateTree(child && child.pid, spawnedIdentity);
    if (!cleanup.ok) {
        const detail = cleanup.error ? ": " + cleanup.error : "";
        commandError = boundedText((commandError ? commandError + "; " : "") + "process-tree cleanup failed" + detail);
    }
    forceSettleTimer = setTimeout(() => {
        if (!commandError && !nativeFailure) commandError = "device-lab provider child did not close after process-tree cleanup";
        publish(null, null);
    }, Math.min(cleanupGraceMs, completionRemainingMs()));
}

function expire() {
    if (settled) return;
    if (!commandError && !nativeFailure) {
        timedOut = true;
        commandError = "device-lab provider command timed out after " + payload.timeoutMs + "ms";
    }
    terminateForFailure();
}

function settleSpawnPublication() {
    if (admission && Atomics.compareExchange(admission, 0, 4, 5) === 4) Atomics.notify(admission, 0);
}

function publish(status, signal) {
    if (settled) return;
    settleSpawnPublication();
    if (!commandError && !timedOut && status === 0 && (!commandRemainingMs() || cancelled())) expire();
    if (nativeFailure && !timedOut && status === null) ({ status, signal } = nativeFailure);
    settled = true;
    clearTimeout(timer);
    clearTimeout(forceSettleTimer);
    let encoded = Buffer.from(JSON.stringify({
        status,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        ...(commandError ? { error: commandError } : {}),
        timedOut,
        outputLimitExceeded,
        ...(cleanup ? { cleanup } : {}),
    }), "utf8");
    if (encoded.length > transport.length) {
        encoded = Buffer.from(JSON.stringify({
            status: null,
            signal: null,
            stdout: "",
            stderr: "",
            error: "device-lab provider runner transport overflow",
            timedOut,
            outputLimitExceeded,
            ...(cleanup ? { cleanup } : {}),
        }), "utf8");
    }
    transport.set(encoded.subarray(0, transport.length));
    Atomics.store(control, 1, Math.min(encoded.length, transport.length));
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    if (parentPort) parentPort.postMessage({ done: true });
}

function admit() {
    if (!admission) {
        if (commandRemainingMs()) return true;
        expire(); publish(null, null); return false;
    }
    if (cancelled()) { expire(); publish(null, null); return false; }
    const requestedAt = performance.now();
    if (Atomics.compareExchange(admission, 0, 0, 1) !== 0) {
        commandError = "device-lab provider runner returned invalid admission";
        recordFailure({ error: commandError });
        publish(null, null);
        return false;
    }
    Atomics.compareExchange(control, 0, 0, 2);
    Atomics.notify(control, 0);
    if (parentPort) parentPort.postMessage({ admission: true });
    Atomics.wait(admission, 0, 1, Math.max(1, Number(payload.timeoutMs) || 1));
    if (cancelled()) { expire(); publish(null, null); return false; }
    const commandMs = Atomics.load(admission, 1);
    const completionMs = Atomics.load(admission, 2);
    if (commandMs <= 0 || completionMs < commandMs || Atomics.compareExchange(admission, 0, 2, 3) !== 2) {
        if (Atomics.load(admission, 0) === 1) expire();
        else {
            commandError = "device-lab provider runner returned invalid admission";
            recordFailure({ error: commandError });
        }
        publish(null, null);
        return false;
    }
    const admittedAt = performance.now();
    // Charging the whole local request round trip also covers grant delivery
    // while the parent event loop cannot publish cancellation.
    const transportMs = Math.max(0, admittedAt - requestedAt);
    commandDeadlineAt = admittedAt + Math.max(0, commandMs - transportMs);
    completionDeadlineAt = admittedAt + Math.max(0, completionMs - transportMs);
    return true;
}

if (admit()) {
    const spawnOptions = {
        cwd: payload.cwd || undefined,
        env: { ...process.env, ...(payload.env || {}) },
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
    };
    if (cancelled() || !commandRemainingMs() || (admission && Atomics.compareExchange(admission, 0, 3, 4) !== 3)) {
        expire();
        publish(null, null);
    } else {
        try {
            child = spawn(payload.executable, payload.args, spawnOptions);
        } catch (error) {
            commandError = boundedText(error instanceof Error ? error.message : String(error));
            recordFailure({ error: commandError });
            publish(null, null);
        }
        if (child) {
            Atomics.store(control, 2, Number.isInteger(child.pid) ? child.pid : 0);
            spawnedIdentity = processIdentity(child.pid, commandRemainingMs);
            publishIdentity(spawnedIdentity);
            settleSpawnPublication();
            Atomics.notify(control, 2);
            if (parentPort) parentPort.postMessage({ spawned: true, pid: child.pid });
            child.stdout.on("data", (chunk) => {
                stdout = append(stdout, chunk);
                if (outputBytes > outputLimit) terminateForFailure();
            });
            child.stderr.on("data", (chunk) => {
                stderr = append(stderr, chunk);
                if (outputBytes > outputLimit) terminateForFailure();
            });
            child.once("error", (error) => {
                if (cancelled()) expire();
                if (!commandError) {
                    commandError = boundedText(error instanceof Error ? error.message : String(error));
                    recordFailure({ error: commandError });
                }
            });
            child.once("exit", (status, signal) => {
                if (cancelled()) expire();
                if (!timedOut && !commandError && (status !== 0 || signal)) {
                    nativeFailure = { status, signal };
                    recordFailure(nativeFailure);
                }
            });
            child.once("close", publish);
            if (!spawnedIdentity && commandRemainingMs()) {
                setTimeout(() => {
                    if (settled) return;
                    if (!commandRemainingMs()) { expire(); return; }
                    if (!commandError && !nativeFailure) {
                        commandError = "device-lab provider process identity could not be established";
                        recordFailure({ error: commandError });
                    }
                    terminateForFailure();
                }, Math.min(100, commandRemainingMs()));
            }
            const remaining = commandRemainingMs();
            if (remaining && !cancelled()) {
                timer = setTimeout(expire, remaining);
                child.stdin.end(payload.input === undefined ? undefined : payload.input);
            }
            else expire();
            if (parentPort && admission) parentPort.on("message", () => { if (cancelled()) expire(); });
        }
    }
}
`;
}

function providerProcessIdentityFromShared(control: Int32Array, identityTransport: Uint8Array): DeviceRuntimeProcessIdentity | null {
    const length = Atomics.load(control, 3);
    if (length <= 0 || length > identityTransport.length) return null;
    try {
        const parsed = JSON.parse(Buffer.from(identityTransport.subarray(0, length)).toString("utf8")) as Partial<DeviceRuntimeProcessIdentity>;
        return typeof parsed.pid === "number"
            && Number.isInteger(parsed.pid)
            && parsed.pid > 0
            && typeof parsed.startToken === "string"
            && parsed.startToken.length > 0
            && typeof parsed.commandHash === "string"
            && /^[a-f0-9]{64}$/.test(parsed.commandHash)
            ? parsed as DeviceRuntimeProcessIdentity
            : null;
    } catch {
        return null;
    }
}

function serviceProviderWorkerAdmission(control: Int32Array, admission: Int32Array, allowance: ReturnType<typeof captureBrokerCommandAllowance>) {
    Atomics.compareExchange(control, 0, 2, 0);
    if (Atomics.load(admission, 0) !== 1) return;
    const observedAt = performance.now();
    const commandMs = allowance.remainingMs(allowance.commandDeadlineAt, observedAt);
    const completionMs = allowance.remainingMs(allowance.completionDeadlineAt, observedAt);
    if (!commandMs || !completionMs || !allowance.remainingMs(allowance.wrapperDeadlineAt, observedAt) || Atomics.load(admission, 3)) {
        Atomics.store(admission, 3, 1);
    } else {
        Atomics.store(admission, 1, commandMs);
        Atomics.store(admission, 2, completionMs);
        Atomics.compareExchange(admission, 0, 1, 2);
    }
    Atomics.notify(admission, 0);
}

function cancelProviderWorker(admission: Int32Array, worker: Worker) {
    Atomics.store(admission, 3, 1);
    Atomics.compareExchange(admission, 0, 3, -1);
    Atomics.notify(admission, 0);
    worker.postMessage({ cancel: true });
}

function providerWorkerPrimaryFailure(admission: Int32Array, failureTransport: Uint8Array): Partial<ProviderCommandResult> | null {
    const length = Atomics.load(admission, 4);
    if (length <= 0 || length > failureTransport.length) return null;
    try {
        const failure = JSON.parse(Buffer.from(failureTransport.subarray(0, length)).toString("utf8")) as Partial<ProviderCommandResult>;
        return failure && typeof failure === "object"
            && (typeof failure.error === "string" || (typeof failure.status === "number" && failure.status !== 0) || typeof failure.signal === "string")
            ? failure : null;
    } catch {
        return null;
    }
}

function providerWorkerExecution(control: Int32Array, transport: Uint8Array): Partial<ProviderCommandResult> {
    const length = Atomics.load(control, 1);
    if (length <= 0 || length > transport.length) throw new Error("invalid transport length");
    const execution = JSON.parse(Buffer.from(transport.subarray(0, length)).toString("utf8")) as Partial<ProviderCommandResult>;
    if (!execution || typeof execution !== "object" || Array.isArray(execution)) throw new Error("invalid transport result");
    return execution;
}

export function defaultProviderCommandRunner(command: ProviderCommand, options: ProviderCommandRunnerOptions): ProviderCommandResult {
    if (command.mode === "noop") {
        return { mode: "noop", provider: command.provider, stdout: command.reason || "", stderr: "", status: 0 };
    }
    if (!command.executable) {
        return { mode: command.mode, provider: command.provider, error: "missing-executable", status: null };
    }
    if (command.mode === "detached") {
        const commandEnv = hiddenProviderCommandEnv(command.env);
        if (!executableExists(command.executable)) {
            return { mode: "detached", provider: command.provider, executable: command.executable, args: command.args || [], status: null, error: "executable-not-found" };
        }
        try {
            const invocation = detachedProviderCommandSpawn(command);
            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(invocation.executable || command.executable, invocation.args, hiddenChildProcessOptions({
                    detached: true,
                    stdio: "ignore" as const,
                    ...(commandEnv ? { env: { ...process.env, ...commandEnv } } : {}),
                    ...(command.cwd ? { cwd: command.cwd } : {}),
                }));
            } catch (error) {
                removeWindowsLauncher(invocation.cleanupPath);
                throw error;
            }
            scheduleWindowsLauncherCleanup(invocation.cleanupPath, child);
            child.once("error", () => undefined);
            child.unref();
            if (child.pid === undefined) {
                return { mode: "detached", provider: command.provider, executable: command.executable, args: command.args || [], status: null, error: "detached-provider-launch-unconfirmed" };
            }
            return { mode: "detached", provider: command.provider, executable: command.executable, args: command.args || [], pid: child.pid, status: 0 };
        } catch (error) {
            return { mode: "detached", provider: command.provider, executable: command.executable, args: command.args || [], status: null, error: error instanceof Error ? error.message : String(error) };
        }
    }
    const allowance = captureBrokerCommandAllowance(options);
    const commandEnv = hiddenProviderCommandEnv(command.env);
    let invocation: ReturnType<typeof providerCommandSpawn>;
    try {
        invocation = providerCommandSpawn(command);
    } catch (error) {
        return {
            mode: "exec",
            provider: command.provider,
            executable: command.executable,
            args: command.args || [],
            status: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    const { timeoutMs, cleanupGraceMs, wrapperTimeoutMs } = allowance;
    const outputLimit = Math.max(1, Math.floor(options.outputLimit));
    // JSON can expand each raw control byte to a six-byte \\u00xx escape. The
    // fixed shared transport therefore reserves the exact bounded worst case.
    const transportCapacity = (outputLimit * 6) + (64 * 1024);
    const shared = new SharedArrayBuffer(16 + transportCapacity);
    const identityShared = new SharedArrayBuffer(4096);
    // The immutable first failure fits the existing 8192-byte diagnostic bound,
    // including the worst-case JSON escaping, independently of the final result.
    const admissionShared = new SharedArrayBuffer(20 + (64 * 1024));
    const control = new Int32Array(shared, 0, 4);
    const transport = new Uint8Array(shared, 16);
    const identityTransport = new Uint8Array(identityShared);
    const admission = new Int32Array(admissionShared, 0, 5);
    const failureTransport = new Uint8Array(admissionShared, 20);
    let worker: Worker;
    try {
        worker = new Worker(boundedProviderCommandRunnerScript(), {
            eval: true,
            workerData: {
                shared,
                identityShared,
                admissionShared,
                payload: {
                    executable: invocation.executable || command.executable,
                    args: invocation.args,
                    input: command.input,
                    cwd: command.cwd,
                    env: commandEnv,
                    timeoutMs,
                    outputLimit,
                    cleanupGraceMs,
                    windowsPowerShellPath: process.platform === "win32"
                        ? canonicalWindowsPowerShellPath()
                        : null,
                },
            },
        });
        worker.on("error", () => undefined);
        worker.unref();
    } catch (error) {
        return {
            mode: "exec",
            provider: command.provider,
            executable: command.executable,
            args: command.args || [],
            status: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    const cleanupProvider = () => {
        cancelProviderWorker(admission, worker);
        while (Atomics.load(admission, 0) === 4) {
            const remaining = allowance.remainingMs(allowance.fallbackDeadlineAt);
            if (!remaining) break;
            Atomics.wait(admission, 0, 4, remaining);
        }
        const pid = Atomics.load(control, 2);
        const expectedIdentity = providerProcessIdentityFromShared(control, identityTransport);
        const fallback = terminateBrokerSpawnedProcessTree(pid, {
            expectedIdentity,
            requireIdentity: true,
            remainingMs: () => allowance.remainingMs(allowance.fallbackDeadlineAt),
        });
        if (fallback.ok || !expectedIdentity || expectedIdentity.pid !== pid) return fallback;
        // Cancellation can finish qualified Worker cleanup while the parent
        // observes identity and attempts its own fallback.
        while (allowance.remainingMs(allowance.fallbackDeadlineAt)) {
            const state = Atomics.load(control, 0);
            if (state === 1) {
                try {
                    const published = providerWorkerExecution(control, transport).cleanup;
                    if (published?.ok === true && published.pid === pid
                        && published.platform === process.platform && published.signal === "SIGKILL"
                        && (published.attempted === true || (published.attempted === false && published.stale === true))
                        && allowance.remainingMs(allowance.fallbackDeadlineAt)) return published;
                } catch { /* Retain the failed fallback when transport is invalid. */ }
                return fallback;
            }
            Atomics.wait(control, 0, state, allowance.remainingMs(allowance.fallbackDeadlineAt));
        }
        return fallback;
    };
    const wrapperExpired = (execution: Partial<ProviderCommandResult> = { status: null, stdout: "", stderr: "" }) => {
        cancelProviderWorker(admission, worker);
        const cleanup = execution.cleanup || cleanupProvider();
        const primary = providerWorkerPrimaryFailure(admission, failureTransport);
        const error = `device-lab provider wrapper timed out after ${wrapperTimeoutMs}ms`;
        return { ...execution, ...primary, error: primary?.error ? `${primary.error}; ${error}` : error, timedOut: !primary, cleanup };
    };
    let execution: Partial<ProviderCommandResult>;
    while (Atomics.load(control, 0) !== 1) {
        serviceProviderWorkerAdmission(control, admission, allowance);
        const commandRemaining = allowance.remainingMs(allowance.commandDeadlineAt);
        if (!commandRemaining && !Atomics.load(admission, 3)) cancelProviderWorker(admission, worker);
        const wrapperRemaining = allowance.remainingMs(allowance.wrapperDeadlineAt);
        if (!wrapperRemaining) break;
        Atomics.wait(control, 0, 0, Math.min(wrapperRemaining, commandRemaining || wrapperRemaining));
    }
    if (Atomics.load(control, 0) !== 1) execution = wrapperExpired();
    else {
        try {
            execution = providerWorkerExecution(control, transport);
            if (execution.timedOut && !allowance.remainingMs(allowance.wrapperDeadlineAt) && !providerWorkerPrimaryFailure(admission, failureTransport)) execution = wrapperExpired(execution);
            else if (execution.status === 0 && !execution.error && !execution.timedOut) {
                if (!allowance.remainingMs(allowance.wrapperDeadlineAt)) execution = wrapperExpired(execution);
                else if (!allowance.remainingMs(allowance.commandDeadlineAt)) {
                    cancelProviderWorker(admission, worker);
                    execution = { ...execution, error: `device-lab provider command timed out after ${timeoutMs}ms`, timedOut: true, cleanup: cleanupProvider() };
                }
            }
        } catch {
            cancelProviderWorker(admission, worker);
            execution = { status: null, stdout: "", stderr: "", error: "device-lab provider runner returned invalid output", cleanup: cleanupProvider() };
        }
    }
    cancelProviderWorker(admission, worker);
    void worker.terminate();
    return {
        mode: "exec",
        provider: command.provider,
        executable: command.executable,
        args: command.args || [],
        ...(command.input !== undefined ? { input: command.input } : {}),
        ...execution,
        stdout: truncateOutput(execution.stdout, outputLimit),
        stderr: truncateOutput(execution.stderr, outputLimit),
    };
}

export async function defaultProviderCommandRunnerAsync(command: ProviderCommand, options: ProviderCommandRunnerOptions): Promise<ProviderCommandResult> {
    if (command.mode !== "exec") return defaultProviderCommandRunner(command, options);
    if (!command.executable) return { mode: command.mode, provider: command.provider, error: "missing-executable", status: null };
    const allowance = captureBrokerCommandAllowance(options);
    let invocation: ReturnType<typeof providerCommandSpawn>;
    try {
        invocation = providerCommandSpawn(command);
    } catch (error) {
        return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args || [], status: null, error: error instanceof Error ? error.message : String(error) };
    }
    const { timeoutMs, cleanupGraceMs, wrapperTimeoutMs } = allowance;
    const outputLimit = Math.max(1, Math.floor(options.outputLimit));
    const transportCapacity = (outputLimit * 6) + (64 * 1024);
    const shared = new SharedArrayBuffer(16 + transportCapacity);
    const identityShared = new SharedArrayBuffer(4096);
    const admissionShared = new SharedArrayBuffer(20 + (64 * 1024));
    const control = new Int32Array(shared, 0, 4);
    const transport = new Uint8Array(shared, 16);
    const identityTransport = new Uint8Array(identityShared);
    const admission = new Int32Array(admissionShared, 0, 5);
    const failureTransport = new Uint8Array(admissionShared, 20);
    const commandEnv = hiddenProviderCommandEnv(command.env);
    const windowsPowerShellPath = process.platform === "win32" ? await canonicalWindowsPowerShellPathAsync() : null;

    return await new Promise<ProviderCommandResult>((resolveResult) => {
        let worker: Worker;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        let commandTimer: NodeJS.Timeout | undefined;
        let handoffTimer: NodeJS.Timeout | undefined;
        let pendingCleanup: (() => Promise<void>) | undefined;
        let cleanupInFlight = false;
        let workerUnavailable = false;
        const result = (execution: Partial<ProviderCommandResult>): ProviderCommandResult => ({
            mode: "exec",
            provider: command.provider,
            executable: command.executable,
            args: command.args || [],
            ...(command.input !== undefined ? { input: command.input } : {}),
            ...execution,
            stdout: truncateOutput(execution.stdout, outputLimit),
            stderr: truncateOutput(execution.stderr, outputLimit),
        });
        const finish = (execution: Partial<ProviderCommandResult>) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (commandTimer) clearTimeout(commandTimer);
            if (handoffTimer) clearTimeout(handoffTimer);
            cancelProviderWorker(admission, worker);
            void worker.terminate();
            resolveResult(result(execution));
        };
        const cleanupProvider = async (): Promise<BrokerProcessTreeCleanup> => {
            const pid = Atomics.load(control, 2);
            const expectedIdentity = providerProcessIdentityFromShared(control, identityTransport);
            const fallback = await terminateBrokerSpawnedProcessTreeAsync(pid, {
                expectedIdentity,
                requireIdentity: true,
                remainingMs: () => allowance.remainingMs(allowance.fallbackDeadlineAt),
            });
            if (fallback.ok || !expectedIdentity || expectedIdentity.pid !== pid) return fallback;
            // Worker cancellation can finish its qualified tree cleanup while the
            // parent awaits identity. Preserve that completed invocation's proof.
            while (allowance.remainingMs(allowance.fallbackDeadlineAt)) {
                if (Atomics.load(control, 0) === 1) {
                    try {
                        const published = providerWorkerExecution(control, transport).cleanup;
                        if (published?.ok === true && published.pid === pid
                            && published.platform === process.platform && published.signal === "SIGKILL"
                            && (published.attempted === true || (published.attempted === false && published.stale === true))
                            && allowance.remainingMs(allowance.fallbackDeadlineAt)) return published;
                    } catch { /* Retain the failed fallback when transport is invalid. */ }
                    return fallback;
                }
                if (workerUnavailable) return fallback;
                await sleep(Math.min(10, allowance.remainingMs(allowance.fallbackDeadlineAt)));
            }
            return fallback;
        };
        const finishHandoff = (waitExpired = false) => {
            if (!pendingCleanup) return false;
            if (!waitExpired && !workerUnavailable && Atomics.load(admission, 0) === 4 && allowance.remainingMs(allowance.fallbackDeadlineAt)) return true;
            const complete = pendingCleanup;
            pendingCleanup = undefined;
            if (handoffTimer) clearTimeout(handoffTimer);
            cleanupInFlight = true;
            void complete().catch(error => {
                const primary = providerWorkerPrimaryFailure(admission, failureTransport);
                finish({ status: null, stdout: "", stderr: "", ...primary, error: primary?.error || (error instanceof Error ? error.message : String(error)) });
            });
            return false;
        };
        const afterSpawnPublication = (complete: () => Promise<void>) => {
            if (settled || pendingCleanup || cleanupInFlight) return;
            cancelProviderWorker(admission, worker);
            pendingCleanup = complete;
            if (finishHandoff()) {
                const remaining = allowance.remainingMs(allowance.fallbackDeadlineAt);
                if (!remaining) finishHandoff();
                else {
                    handoffTimer = setTimeout(() => finishHandoff(true), remaining);
                    handoffTimer.unref();
                }
            }
        };
        const wrapperExpired = (execution: Partial<ProviderCommandResult> = { status: null, stdout: "", stderr: "" }) => {
            afterSpawnPublication(async () => {
                const cleanup = execution.cleanup || await cleanupProvider();
                const primary = providerWorkerPrimaryFailure(admission, failureTransport);
                const error = `device-lab provider wrapper timed out after ${wrapperTimeoutMs}ms`;
                finish({ ...execution, ...primary, error: primary?.error ? `${primary.error}; ${error}` : error, timedOut: !primary, cleanup });
            });
        };
        const finishFromTransport = () => {
            if (settled || pendingCleanup || cleanupInFlight) return;
            try {
                let execution = providerWorkerExecution(control, transport);
                if (execution.timedOut && !allowance.remainingMs(allowance.wrapperDeadlineAt) && !providerWorkerPrimaryFailure(admission, failureTransport)) { wrapperExpired(execution); return; }
                if (execution.status === 0 && !execution.error && !execution.timedOut) {
                    if (!allowance.remainingMs(allowance.wrapperDeadlineAt)) { wrapperExpired(execution); return; }
                    if (!allowance.remainingMs(allowance.commandDeadlineAt)) {
                        afterSpawnPublication(async () => finish({ ...execution, error: `device-lab provider command timed out after ${timeoutMs}ms`, timedOut: true, cleanup: await cleanupProvider() }));
                        return;
                    }
                }
                finish(execution);
            } catch {
                afterSpawnPublication(async () => finish({ status: null, stdout: "", stderr: "", error: "device-lab provider runner returned invalid output", cleanup: await cleanupProvider() }));
            }
        };
        try {
            worker = new Worker(boundedProviderCommandRunnerScript(), {
                eval: true,
                workerData: {
                    shared,
                    identityShared,
                    admissionShared,
                    payload: {
                        executable: invocation.executable || command.executable,
                        args: invocation.args,
                        input: command.input,
                        cwd: command.cwd,
                        env: commandEnv,
                        timeoutMs,
                        outputLimit,
                        cleanupGraceMs,
                        windowsPowerShellPath,
                    },
                },
            });
        } catch (error) {
            resolveResult(result({ status: null, error: error instanceof Error ? error.message : String(error) }));
            return;
        }
        worker.on("message", (message: unknown) => {
            finishHandoff();
            if (settled || pendingCleanup || cleanupInFlight || !message || typeof message !== "object") return;
            if ((message as { admission?: unknown }).admission === true) serviceProviderWorkerAdmission(control, admission, allowance);
            if ((message as { done?: unknown }).done === true) finishFromTransport();
        });
        worker.once("error", (error) => {
            if (settled || cleanupInFlight) return;
            workerUnavailable = true;
            if (pendingCleanup) { finishHandoff(); return; }
            afterSpawnPublication(async () => {
                const primary = providerWorkerPrimaryFailure(admission, failureTransport);
                finish({ status: null, stdout: "", stderr: "", ...primary, error: primary?.error || error.message, cleanup: await cleanupProvider() });
            });
        });
        worker.once("exit", () => {
            workerUnavailable = true;
            if (pendingCleanup) finishHandoff();
            else if (!settled && !cleanupInFlight) finishFromTransport();
        });
        worker.unref();
        const commandRemaining = allowance.remainingMs(allowance.commandDeadlineAt);
        if (commandRemaining) {
            commandTimer = setTimeout(() => cancelProviderWorker(admission, worker), commandRemaining);
            commandTimer.unref();
        } else cancelProviderWorker(admission, worker);
        const wrapperRemaining = allowance.remainingMs(allowance.wrapperDeadlineAt);
        if (wrapperRemaining) {
            timer = setTimeout(() => {
                if (Atomics.load(control, 0) === 1) finishFromTransport();
                else wrapperExpired();
            }, wrapperRemaining);
            timer.unref();
        } else wrapperExpired();
    });
}

async function runBudgetedProviderCommand(normalized: NormalizedBrokerOptions, command: ProviderCommand, settings: ProviderCommandRunnerOptions): Promise<ProviderCommandResult> {
    if (normalized.cleanupDeadlineAt !== undefined) {
        assertCleanupDeadline(normalized);
        const available = Math.floor(cleanupExitBudget(normalized, Infinity));
        // Keep the existing native cleanup grace INSIDE the captured parent
        // allowance; spending it all on execution would leave no kill authority.
        const cleanupReserve = normalized.usesDefaultCommandRunner && command.mode === "exec"
            ? Math.min(10000, Math.max(1, Math.floor(settings.cleanupGraceMs ?? 1000))) : 0;
        if (cleanupReserve && available <= cleanupReserve + 1) throw new CleanupOperationDeadlineError();
        settings = { ...settings, timeoutMs: Math.max(1, Math.min(settings.timeoutMs, available - cleanupReserve)),
            remainingMs: () => cleanupExitBudget(normalized, Infinity) };
    }
    return hyperVProviderCommandRunner(normalized, command, settings);
}

function hyperVProviderCommandRunner(normalized: NormalizedBrokerOptions, command: ProviderCommand, options: ProviderCommandRunnerOptions): Promise<ProviderCommandResult> {
    return normalized.usesDefaultCommandRunner
        ? defaultProviderCommandRunnerAsync(command, options)
        : Promise.resolve(normalized.commandRunner(command, options));
}

async function hyperVTypedStatusExecution(
    normalized: NormalizedBrokerOptions,
    identity: { executable: string; ownerId: string; deviceId: string; incarnationId: string; vmId: string; vmName: string },
    deadlineAt: number,
    timeoutCap: number,
    requireCompleteVhdChain = false,
    now: () => number = () => Date.now(),
    parentDeadlineAt?: number,
): Promise<ProviderCommandResult> {
    let parentDeadlineError: HyperVOperationDeadlineError | null = null;
    const timeoutMilliseconds = () => {
        if (parentDeadlineAt === undefined) return hyperVRemainingTimeout(deadlineAt, timeoutCap, now);
        const observedNow = now();
        try { hyperVRemainingTimeout(parentDeadlineAt, timeoutCap, () => observedNow); }
        catch (error) {
            if (error instanceof HyperVOperationDeadlineError) parentDeadlineError = error;
            throw error;
        }
        return hyperVRemainingTimeout(deadlineAt, timeoutCap, () => observedNow);
    };
    const result = await observeDeviceLabHyperVStatus({
        executable: identity.executable,
        run: (command, options) => hyperVProviderCommandRunner(normalized, command, options),
        now: normalized.hyperVMonotonicNow,timeoutMilliseconds,
        ...(parentDeadlineAt === undefined ? {} : { isDeadlineError: (error: unknown) => parentDeadlineError !== null && error === parentDeadlineError }),
        ...(normalized.usesDefaultCommandRunner ? { session: brokerHyperVWindowsSession(identity.executable) } : {}),
        vmId: identity.vmId,
        vmName: identity.vmName,
        expectedNotes: ownershipMarker(identity.ownerId, identity.deviceId, identity.incarnationId),
        ownerId: identity.ownerId,
        requireCompleteVhdChain,
    });
    return {
        mode: "exec", provider: "hyper-v", executable: identity.executable, args: [],
        status: result.ok ? 0 : 1,
        stdout: result.ok ? JSON.stringify(result.observation) : "",
        ...(result.ok ? {} : { stderr: result.code, error: result.code, ...(result.code === "hyper-v-status-timeout" ? { timedOut: true } : {}) }),
    };
}

async function hyperVTypedPowerObservation(
    normalized: NormalizedBrokerOptions,
    identity: { executable: string; ownerId: string; deviceId: string; incarnationId: string; vmId: string; vmName: string },
    operation: DeviceLabHyperVPowerOptions["operation"],
    deadlineAt: number,
    timeoutCap: number,
    options: { force?: boolean; startIfStopped?: boolean; memoryMb?: number; cpus?: number } = {},
): Promise<HyperVPowerObservation<ProviderCommandResult>> {
    const result = await executeDeviceLabHyperVPower({
        executable: identity.executable,
        run: (command, runOptions) => hyperVProviderCommandRunner(normalized, command, runOptions),
        now: normalized.hyperVMonotonicNow,timeoutMilliseconds: () => hyperVRemainingTimeout(deadlineAt, timeoutCap, normalized.hyperVMonotonicNow),
        ...(normalized.usesDefaultCommandRunner ? { session: brokerHyperVWindowsSession(identity.executable) } : {}),
        vmId: identity.vmId,
        vmName: identity.vmName,
        expectedNotes: ownershipMarker(identity.ownerId, identity.deviceId, identity.incarnationId),
        operation,
        ...options,
    });
    const receipt: ProviderCommandResult = {
        mode: "exec", provider: "hyper-v", executable: identity.executable, args: [],
        status: result.ok ? 0 : 1,
        stdout: result.ok ? JSON.stringify(result.observation) : "",
        ...(result.ok ? {} : { stderr: result.code, error: result.code,
            ...(result.capacity ? { capacity: result.capacity } : {}),
            ...(result.code === "hyper-v-lifecycle-timeout" ? { timedOut: true } : {}) }),
    };
    return {
        ok: result.ok,
        observation: result.ok ? result.observation : null,
        execution: nativeHyperVObservation(receipt),
    };
}

async function hyperVTypedDeleteObservation(
    normalized: NormalizedBrokerOptions,
    identity: { executable: string; ownerId: string; backend: string; deviceId: string; incarnationId: string; vmId: string; vmName: string; diskPath: string },
    deadlineAt: number,
): Promise<HyperVTerminalResult<ProviderCommandResult>> {
    try {
        const deviceRoot = hyperVDeviceRoot(identity.ownerId, identity.backend, identity.deviceId);
        const client = createDeviceLabHyperVWindowsClient({
            executable: identity.executable,
            run: (command, options) => hyperVProviderCommandRunner(normalized, command, options),
            now: normalized.hyperVMonotonicNow,timeoutMilliseconds: () => hyperVRemainingTimeout(deadlineAt, 120000, normalized.hyperVMonotonicNow),
            ...(normalized.usesDefaultCommandRunner ? { session: brokerHyperVWindowsSession(identity.executable) } : {}),
        });
        const outcome = await deleteDeviceLabHyperVVm(client, {
            vmId: identity.vmId,
            vmName: identity.vmName,
            ownershipNotes: ownershipMarker(identity.ownerId, identity.deviceId, identity.incarnationId),
            deviceRoot,
            diskPath: identity.diskPath,
            auxiliaryMediaPaths: [join(deviceRoot, "disks", identity.backend === "linux-vm" ? "cidata.iso" : "autounattend.iso")],
        });
        assertHyperVOperationDeadline(deadlineAt, normalized.hyperVMonotonicNow);
        const receipt: ProviderCommandResult = {
            mode: "exec", provider: "hyper-v", executable: identity.executable, args: [],
            status: 0,
            stdout: JSON.stringify({
                ok: true, vmId: outcome.vmId, vmName: identity.vmName, state: "Off", status: "",
                deleted: true, diskPath: identity.diskPath,
                ...(outcome.alreadyMissing ? { alreadyMissing: true } : {}),
            }),
        };
        return {
            ok: true,
            observation: outcome.vmId === null ? null : {
                vmId: outcome.vmId.toLowerCase(), vmName: identity.vmName, state: "Off", status: "", diskPath: identity.diskPath,
            },
            execution: nativeHyperVObservation(receipt),
        };
    } catch (cause) {
        const code = hyperVBoundedErrorCode(cause, "hyper-v-delete-command-failed");
        return {
            ok: false, observation: null,
            execution: nativeHyperVObservation({
                mode: "exec", provider: "hyper-v", executable: identity.executable, args: [],
                status: 1, error: code, stderr: code,
                ...(hyperVOperationDeadlineExpired(deadlineAt, normalized.hyperVMonotonicNow) ? { timedOut: true } : {}),
            }),
        };
    }
}

function commandSucceeded(result: ProviderCommandResult) {
    return result.status === 0 && !result.error;
}

function hyperVBootstrapNetworkOptions(
    normalized: NormalizedBrokerOptions,
    executable: string,
    deadlineAt: number,
): DeviceLabHyperVWindowsClientOptions {
    return {
        executable,
        now: normalized.hyperVMonotonicNow,timeoutMilliseconds: () => hyperVRemainingTimeout(deadlineAt, 30_000, normalized.hyperVMonotonicNow),
        run: (command, options) => hyperVProviderCommandRunner(normalized, command, options),
        // An injected runner owns execution; only the default runner uses a broker session.
        ...(normalized.usesDefaultCommandRunner ? { session: brokerHyperVWindowsSession(executable) } : {}),
    };
}

type HyperVBootstrapVmIdentity = {
    readonly executable: string;
    readonly ownerId: string;
    readonly deviceId: string;
    readonly incarnationId: string;
    readonly vmName: string;
    readonly vmId: string | null | undefined;
    readonly deadlineAt: number;
};

function hyperVOwnedVmIdentity(identity: HyperVBootstrapVmIdentity): DeviceLabHyperVOwnedVm {
    return {
        vmId: identity.vmId || "",
        vmName: identity.vmName,
        ownershipMarker: ownershipMarker(identity.ownerId, identity.deviceId, identity.incarnationId),
    };
}

/**
 * Compose the broker's operation allowance and owner identity for bootstrap discovery.
 */
function hyperVProbeBootstrapNetwork(
    normalized: NormalizedBrokerOptions,
    identity: HyperVBootstrapVmIdentity,
) {
    return probeDeviceLabHyperVBootstrapNetwork(
        hyperVBootstrapNetworkOptions(normalized, identity.executable, identity.deadlineAt),
        hyperVOwnedVmIdentity(identity),
    );
}

/**
 * Compose the same owner fence and allowance for removal and containment confirmation.
 */
function hyperVCleanupBootstrapNetwork(
    normalized: NormalizedBrokerOptions,
    identity: HyperVBootstrapVmIdentity,
    managedMacAddress: string,
) {
    return cleanupDeviceLabHyperVBootstrapNetwork(
        hyperVBootstrapNetworkOptions(normalized, identity.executable, identity.deadlineAt),
        hyperVOwnedVmIdentity(identity),
        managedMacAddress,
    );
}

function providerFailureDetail(result: ProviderCommandResult): string {
    const parts = [
        result.error ? `error: ${result.error}` : "",
        result.stderr ? `stderr: ${result.stderr}` : "",
        result.stdout ? `stdout: ${result.stdout}` : "",
    ].filter(Boolean);
    return truncateOutput(parts.join("\n") || `provider exited with status ${String(result.status)}`, 8192);
}

export function hyperVLinuxGuestReadyTraceFailureCode(trace:HyperVLinuxGuestReadyTrace|null,fallback:string):string{return coreLinuxTraceFailure(trace,fallback);}
export function compareHyperVLinuxEd25519HostKeyFingerprint(expectedFingerprint:string,sshDiagnostic:string):{observed:boolean;matchesExpected:boolean|null}{return coreLinuxFingerprint(expectedFingerprint,parseHyperVLinuxEd25519HostKeyFingerprints(sshDiagnostic));}

function commandToleratesMissingMacosVmDelete(parsed: CommandParamSuccess, result: ProviderCommandResult) {
    if (parsed.backend !== "macos-vm" || parsed.command !== "device_delete" || !parsed.force) return false;
    if (result.provider !== "tart") return false;
    const output = `${result.stderr || ""}\n${result.stdout || ""}`.toLowerCase();
    return output.includes("does not exist") || output.includes("not found");
}

function collectGuids(value: unknown, output = new Set<string>()) {
    if (typeof value === "string") {
        for (const match of value.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
            output.add(match[0].toLowerCase());
        }
        return output;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectGuids(item, output);
        return output;
    }
    if (value && typeof value === "object") {
        for (const item of Object.values(value)) collectGuids(item, output);
    }
    return output;
}

export function windowsSandboxSessionIdsFromBrokerListOutput(stdout: string) {
    try {
        return [...collectGuids(JSON.parse(stdout))];
    } catch {
        return [...collectGuids(stdout)];
    }
}

function sleepSync(ms: number) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

export function waitForBrokerWindowsMinimizeConfirmation(resultPath: string, timeoutMs = DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_CONFIRM_TIMEOUT_MS): ProviderCommandResult {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
        if (existsSync(resultPath)) {
            let result: string;
            try {
                const content = readDeviceLabTextFile(resultPath, "windows-sandbox-minimize-result", DEVICE_BROKER_WINDOWS_MINIMIZE_RESULT_LIMIT_BYTES);
                if (content === null) throw new Error("windows-sandbox-minimize-result-missing");
                result = content.trim();
            } catch (error) {
                return {
                    mode: "exec",
                    provider: "windows-sandbox-window",
                    status: 1,
                    stdout: "",
                    stderr: `Windows Sandbox window minimization result is invalid: ${deviceLabStateFileErrorCode(error) || (error instanceof Error ? error.message : String(error))}`,
                };
            }
            return {
                mode: "exec",
                provider: "windows-sandbox-window",
                status: result === "minimized" ? 0 : 1,
                stdout: result,
                stderr: result === "minimized" ? "" : `Windows Sandbox window minimization reported ${result || "an empty result"}`,
            };
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        sleepSync(Math.min(250, remainingMs));
    }
    return {
        mode: "exec",
        provider: "windows-sandbox-window",
        status: null,
        timedOut: true,
        stdout: "",
        stderr: "",
        error: `Windows Sandbox window was not minimized within ${timeoutMs}ms`,
    };
}

function mutateDeviceAfterCommand(ownerId: string, parsed: CommandParamSuccess, device: unknown) {
    if (parsed.command === "device_status") return { found: true, matched: true, device };
    if (parsed.backend === "ios-simulator" || parsed.backend === "macos-vm") {
        const kind = parsed.command === "device_start" || parsed.command === "device_reboot" ? "start" : parsed.command === "device_delete" ? "delete" : "stop";
        return transitionOwnerLifecycleDevice(ownerId, parsed.stateKey, parsed.deviceId, device, candidate => {
            const replacement = parsed.backend === "ios-simulator" ? brokerIosReplacement(candidate, { kind }) : brokerMacosReplacement(candidate, { kind, boot: null });
            return replacement === null ? null : { ...replacement, updatedAt: new Date().toISOString() };
        });
    }
    if (parsed.command === "device_delete") {
        return transitionOwnerLifecycleDevice(ownerId, parsed.stateKey, parsed.deviceId, device, () => null);
    }
    const physical = parsed.stateKey === "android-device" || parsed.stateKey === "ios-device";
    const status = physical
        ? parsed.command === "device_start" ? "attached" : "detached"
        : parsed.command === "device_start" || parsed.command === "device_reboot" ? "running" : "stopped";
    return transitionOwnerLifecycleDevice(ownerId, parsed.stateKey, parsed.deviceId, device, (candidate) => {
        return {
            ...(candidate as object),
            status,
            ...(physical && parsed.command === "device_stop" ? { leaseClaimId: null, leaseClaimNonce: null } : {}),
            updatedAt: new Date().toISOString(),
        };
    });
}

function cancelBrokerWindowsMinimizeWatchdog(ownerId: string, deviceId: string) {
    const cancelPath = brokerWindowsHelperPaths(ownerId, deviceId).minimizeWatchdogCancelPath;
    try {
        mkdirSync(dirname(cancelPath), { recursive: true });
        writeFileSync(cancelPath, new Date().toISOString(), { mode: 0o600 });
        return { attempted: true, ok: true, cancelPath };
    } catch (error) {
        return {
            attempted: true,
            ok: false,
            cancelPath,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function cleanupLifecycleAuxiliaryRuntime(ownerId: string, parsed: CommandParamSuccess, normalized: NormalizedBrokerOptions, expected: unknown) {
    const outcome = brokerOwnerCleanupApplication(normalized).auxiliary(ownerId, parsed, expected);
    if (normalized.cleanupObservation) normalized.cleanupObservation.auxiliary = outcome;
    return outcome;
}

async function cleanupLifecycleAuxiliaryRuntimeAsync(ownerId: string, parsed: CommandParamSuccess, normalized: NormalizedBrokerOptions, expected: unknown) {
    const outcome = await brokerOwnerCleanupApplication(normalized).auxiliaryAsync(ownerId, parsed, expected, {
        terminateAppium: (runtime, stillCurrent) => cleanupAppiumTerminationAsync(runtime, normalized, stillCurrent),
        signalRecording: (runtime, stillCurrent) => cleanupRecordingTerminationAsync(runtime, normalized, stillCurrent),
    });
    if (normalized.cleanupObservation) normalized.cleanupObservation.auxiliary = outcome;
    return outcome;
}

function redactBrokerDeviceSecrets(device: unknown) {
    if (!device || typeof device !== "object") return device;
    const record = device as Record<string, unknown>;
    const {
        avdRoot,
        privateRoot,
        sshPrivateKeyPath,
        sshHostPrivateKeyPath,
        guestCredentialPath,
        ...publicRecord
    } = record;
    const ssh = publicRecord.ssh;
    if (!ssh || typeof ssh !== "object") return publicRecord;
    const {
        password,
        privateRoot: sshPrivateRoot,
        sshPrivateKeyPath: nestedPrivateKeyPath,
        sshHostPrivateKeyPath: nestedHostPrivateKeyPath,
        guestCredentialPath: nestedCredentialPath,
        ...publicSsh
    } = ssh as Record<string, unknown>;
    return {
        ...publicRecord,
        ssh: {
            ...publicSsh,
            ...(password ? { passwordConfigured: true } : {}),
        },
    };
}

function redactBrokerCreateSecrets(create: unknown) {
    if (!create || typeof create !== "object" || !("sshPassword" in create)) return create;
    const { sshPassword, ...publicCreate } = create as Record<string, unknown>;
    return {
        ...publicCreate,
        ...(sshPassword ? { sshPasswordConfigured: true } : {}),
    };
}

function hyperVCreateConfigurationConflicts(device: Record<string, unknown>, parsed: CommandParamSuccess): string[] {
    return hyperVPreviewConflicts(device, parsed, () => hyperVSecureBootConfiguration(parsed.backend));
}

function lifecycleCommandPlanning(ownerId: string, params: unknown, normalized?: NormalizedBrokerOptions, redactSecrets = true, expected?: {
    device?: unknown;
}, admittedDeviceId?: string) {
    const parsed = admittedDeviceId ? validateCommandParams(params, admittedDeviceId) : admitCommandParams(params);
    if (!parsed.ok) {
        const response = commandParamError(parsed);
        return { response, result: undefined };
    }
    const observation = observeLifecyclePreview(ownerId, parsed, normalized, redactSecrets, expected);
    if (observation.kind === "state-failed") {
        const response = ownerDeviceStateFailure(observation.error, { backend: parsed.backend, stateKey: parsed.stateKey });
        return { response, result: undefined };
    }
    if (observation.kind === "allocation-failed") {
        const allocation = observation.evidence;
        {
            const response = { status: allocation.status, payload: { ok: false, error: allocation.error, ...(allocation.allowed ? { allowed: allocation.allowed } : {}), ...(allocation.detail ? { detail: allocation.detail } : {}), ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
            return { response, result: undefined };
        }
    }
    if (observation.kind === "already-exists") {
        const response = { status: 409, payload: { ok: false, error: "owner-device-already-exists", ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
        return { response, result: undefined };
    }
    if (observation.kind === "not-found") {
        const response = { status: 404, payload: { ok: false, error: "owner-device-not-found", ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
        return { response, result: undefined };
    }
    if (observation.kind === "not-attached") {
        const response = { status: 409, payload: { ok: false, error: "physical-device-not-attached", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, remedy: "attach the physical device before starting it" } };
        return { response, result: undefined };
    }
    if (observation.kind === "missing-delete") {
        const response = { status: 200, payload: { ok: true, result: { ...observation.value, device: null, idempotent: true, alreadyMissing: true, providerCommand: null, execution: { mode: "idempotent", providerExecution: "not-required", mutatesHost: false } } } };
        return { response, result: response.payload.result };
    }
    const { providerPlan, providerAvailable, ...selected } = observation.value;
    const value = observation.kind === "create" ? {...selected, create: redactSecrets && isHyperVBackend(parsed.backend) ? observation.value.create : redactBrokerCreateSecrets(observation.value.create)} : selected;
    {
        const response = { status: 200, payload: { ok: true, result: { ...value, providerCommand: providerPlan, execution: { mode: "planned", providerExecution: providerAvailable ? "available" : "deferred", mutatesHost: false } } } };
        return { response, result: response.payload.result };
    }
}

function lifecycleCommandPlan(ownerId:string,params:unknown,normalized?:NormalizedBrokerOptions,redactSecrets=true,expected?:{device?:unknown},admittedDeviceId?:string){return lifecycleCommandPlanning(ownerId,params,normalized,redactSecrets,expected,admittedDeviceId).response;}


class NativeLifecyclePreviewPlan {
    constructor(private readonly command: ReturnType<typeof providerCommandForCreate> | ReturnType<typeof providerCommandFor> | undefined, private readonly deferredHyperV = false) { }
    unwrap() {
        return this.deferredHyperV ? { mode: "powershell" as const, provider: "hyper-v" as const } : this.command;
    }
}

function observeLifecyclePreview(ownerId: string, parsed: CommandParamSuccess, normalized: NormalizedBrokerOptions | undefined, redactSecrets: boolean, expected?: {
    device?: unknown;
}) {
    const deferredHyperVPlan = new NativeLifecyclePreviewPlan(undefined, true);
    const observation = createLifecyclePreview<CommandParamSuccess, NormalizedBrokerOptions, NativeLifecyclePreviewPlan, AndroidEmulatorPortAllocation>({
        read: (ownerId, parsed: CommandParamSuccess) => {
            const devices = readOwnerDevices(ownerId, parsed.stateKey);
            if (expected)
                expected.device = structuredClone(devices.find(candidate => candidate && typeof candidate === "object" && (candidate as {
                    id?: unknown;
                }).id === parsed.deviceId));
            return devices;
        },
        hyperV: parsed => isHyperVBackend(parsed.backend),
        validIncarnation: () => true,
        incarnation: device => hyperVDeviceIncarnationId(device),
        conflicts: (device, parsed) => hyperVCreateConfigurationConflicts(device, parsed),
        androidPort: (ownerId, parsed) => resolveAndroidEmulatorCreatePort(ownerId, parsed),
        createDefinition: (ownerId, parsed) => createOwnerDeviceRecord(ownerId, parsed),
        assertWritable: read => assertOwnerDeviceStateWritable(read(), DEVICE_BROKER_INVENTORY_FILE_LIMIT),
        createPlan: (ownerId, parsed, normalized: NormalizedBrokerOptions) => redactSecrets && isHyperVBackend(parsed.backend) ? deferredHyperVPlan : new NativeLifecyclePreviewPlan(providerCommandForCreate(ownerId, parsed, normalized)),
        existingPlan: (ownerId, parsed, device, normalized) => redactSecrets && isHyperVBackend(parsed.backend) ? deferredHyperVPlan : new NativeLifecyclePreviewPlan(providerCommandFor(ownerId, parsed, device, normalized)),
        attachmentMatches: (ownerId, parsed, device) => physicalDeviceLeaseMatches(ownerId, parsed.stateKey, parsed.deviceId, device),
    })(ownerId, parsed, normalized);
    const unwrapped = observation.kind === "create"
        ? { ...observation, value: { ...observation.value, providerPlan: observation.value.providerPlan ? observation.value.providerPlan.unwrap() : null } }
        : observation.kind === "existing"
            ? { ...observation, value: { ...observation.value, providerPlan: observation.value.providerPlan ? observation.value.providerPlan.unwrap() : null } }
            : observation;
    if (!redactSecrets)
        return unwrapped;
    if (unwrapped.kind === "create")
        return { ...unwrapped, value: { ...unwrapped.value,
                device: redactBrokerDeviceSecrets(unwrapped.value.device),
                create: isHyperVBackend(parsed.backend) ? publicHyperVCreateConfiguration({ ...unwrapped.value.create, ...hyperVSecureBootConfiguration(parsed.backend) }) : redactBrokerCreateSecrets(unwrapped.value.create),
                providerPlan: normalized && isHyperVBackend(parsed.backend) ? { mode: "powershell", provider: "hyper-v" } : unwrapped.value.providerPlan } };
    if (unwrapped.kind === "existing")
        return { ...unwrapped, value: { ...unwrapped.value,
                device: isHyperVBackend(parsed.backend) ? redactHyperVDeviceSecrets(unwrapped.value.device) : redactBrokerDeviceSecrets(unwrapped.value.device),
                providerPlan: normalized && isHyperVBackend(parsed.backend) ? { mode: "powershell", provider: "hyper-v" } : unwrapped.value.providerPlan } };
    return unwrapped;
}

type NativeAndroidRuntime = {adb: string; emulator: string};
function brokerAndroidPreparationPorts(normalized: NormalizedBrokerOptions): BrokerAndroidPreparationPorts<NativeAndroidRuntime, NativeProviderLifecycleEffect> {
    const ready = (command: ProviderCommand) => ({ kind: "ready" as const, effect: new NativeProviderLifecycleEffect(command), mode: command.mode, provider: command.provider });
    return {
        captureRuntime: () => ({ adb: executableFor("adb", normalized), emulator: executableFor("emulator", normalized) }), ownedAvdName: ownedAndroidAvdName,
        prepareCreate: ({ avdName, systemImage, deviceProfile }) => ready({ mode: "exec", provider: "avdmanager", executable: executableFor("avdmanager", normalized), args: ["create", "avd", "--name", avdName, "--package", systemImage, "--force", ...(deviceProfile ? ["--device", deviceProfile] : [])], input: "no\n" }),
        prepareStatus: (runtime, serial) => ready({ mode: "exec", provider: "adb", executable: runtime.adb, args: ["-s", serial, "get-state"] }),
        prepareStop: (runtime, serial) => ready({ mode: "exec", provider: "adb", executable: runtime.adb, args: ["-s", serial, "emu", "kill"] }),
        prepareStart: (runtime, facts) => ready({ mode: "detached", provider: "emulator", executable: runtime.emulator, args: ["-avd", facts.avdName, ...(facts.port ? ["-port", String(facts.port)] : []), ...(facts.headless ? ["-no-window", "-no-audio"] : []), "-netsim-args", "--no-cli-ui --no-web-ui"], windowsHiddenLauncher: true }),
    };
}
function nativeAndroidFailureReason(status: number) {
    return status === 400 ? "invalid" as const : status === 503 ? "provider-unavailable" as const : status === 502 ? "provider-failed" as const : status === 500 ? "state-write-failed" as const : "conflict" as const;
}
function brokerAndroidLifecyclePorts(normalized: NormalizedBrokerOptions): BrokerAndroidEmulatorLifecyclePorts<NativeProviderLifecycleEffect, NativeBrokerExecutionReceipt> {
    return {
        executePrepared: async (effect, options) => { const receipt = await runBudgetedProviderCommand(normalized, effect.command, options); if (normalized.cleanupObservation) normalized.cleanupObservation.execution = receipt; return nativeLifecycleObservation(receipt); },
        observeStopInventory: async (effect, serial, options) => {
            const receipt = await runBudgetedProviderCommand(normalized, effect.command, options);
            const lines = String(receipt.stdout || "").split(/\r?\n/).map(line => line.trim());
            return { ...nativeLifecycleObservation(receipt),
                available: !receipt.timedOut && !receipt.outputLimitExceeded && lines.includes("List of devices attached"),
                serialPresent: lines.some(line => line.split(/\s+/)[0] === serial),
            };
        },
        observeBootProbe: async (effect, options) => {
            const receipt = await runBudgetedProviderCommand(normalized, effect.command, options);
            return { ...nativeLifecycleObservation(receipt), ready: String(receipt.stdout || "").trim() === "1" };
        },
        metadataObservation: (purpose, options) => purpose === "create" ? nativeLifecycleObservation({ mode: "noop", provider: "host-broker-state", status: 0, stdout: "", stderr: "" })
            : nativeLifecycleObservation(normalized.commandRunner({ mode: "noop", provider: "host-broker-state", reason: purpose === "delete-metadata" ? "Android emulator deleteAvd=false deletes only owner broker metadata" : "Android AVD artifacts are removed by identity-fenced storage cleanup" }, options)),
        prepareStopInventory: () => { const adb = executableFor("adb", normalized); return adb ? { kind: "ready", effect: new NativeProviderLifecycleEffect({ mode: "exec", provider: "adb", executable: adb, args: ["devices", "-l"] }) } : { kind: "unavailable" }; },
        prepareBootProbe: serial => {
            const adb = executableFor("adb", normalized);
            return adb && serial ? { kind: "ready", effect: new NativeProviderLifecycleEffect({ mode: "exec", provider: "adb", executable: adb, args: ["-s", serial, "shell", "getprop", "sys.boot_completed"] }) }
                : { kind: "unavailable", observation: nativeLifecycleObservation({ mode: "exec", provider: "adb", executable: adb || undefined, args: serial ? ["-s", serial, "shell", "getprop", "sys.boot_completed"] : [], status: null, stdout: "", stderr: "", error: serial ? "missing-executable: adb" : "missing-provider-metadata: serial or port" }) };
        },
        now: () => performance.now(), sleep, timestamp: () => new Date().toISOString(), runtimeId: randomUUID, avdHome: androidAvdHome,
        validPort: validAndroidEmulatorPort,
        livePorts: async () => { const result = await liveAndroidEmulatorPortsForAllocation(normalized); if (result.ok)
            return result; const { status, ...facts } = result; return { ...facts, reason: nativeAndroidFailureReason(status) }; },
        liveAvds: async () => { const result = await liveAndroidAvdNames(normalized); if (result.ok)
            return result; const { status, ...facts } = result; return { ...facts, reason: nativeAndroidFailureReason(status) }; },
        avdProcesses: async (name, timeout, registered) => { const result = await androidAvdProcessState(name, normalized, timeout, registered); if (result.ok)
            return result; const { status, ...facts } = result; return { ...facts, reason: nativeAndroidFailureReason(status) }; },
        ownedAvdName: ownedAndroidAvdName, approvedAvdRoot: root => approvedAndroidAvdRoot(root, normalized.platform),
        avdArtifacts: (owner, root) => listOwnedAndroidAvdArtifactsAsync(owner, { root }),
        removeAvdArtifacts: (name, owner, root, verifyInactive) => removeOwnedAndroidAvdArtifactsAsync(name, owner, { root, verifyInactive }),
        claimDefinition: (owner, parsed, device) => claimOwnerDevice(owner, parsed.stateKey, device, createOwnerDeviceUniqueFields(parsed)),
        cleanupAuxiliary: (owner, parsed, expected) => cleanupLifecycleAuxiliaryRuntimeAsync(owner, parsed, normalized, expected),
        transition: (owner, parsed, expected, replace) => publishLifecycleDevice(normalized, owner, parsed.stateKey, parsed.deviceId, expected, candidate => {
            const replacement = replace(candidate);
            if (cleanupRecord(replacement) && cleanupRecord(replacement.lastBootCheck)) {
                const boot = replacement.lastBootCheck.result;
                if (cleanupRecord(boot) && boot.receipt instanceof NativeBrokerExecutionReceipt)
                    replacement.lastBootCheck.result = boot.receipt.value;
            }
            return replacement;
        }),
        stateErrorCode: ownerDeviceStateErrorCode, commandTimeoutMs: normalized.commandTimeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    };
}

function readBrokerWindowsLifecycleConfig(ownerId: string, deviceId: string, recordedPath: string | null): {
    ok: true;
    config: string;
} | {
    ok: false;
    error: string;
    missing: string[];
} {
    const configPath = recordedPath || brokerWindowsConfigPath(ownerId, deviceId);
    const root = join(brokerRoot(), "owners", ownerId, "windows");
    if (!pathWithin(root, configPath))
        return { ok: false, error: "invalid-provider-metadata", missing: ["owner-scoped configPath"] };
    if (!recordedPath) {
        try {
            lstatSync(configPath);
        }
        catch (error) {
            return (error as NodeJS.ErrnoException).code === "ENOENT"
                ? { ok: false, error: "missing-provider-metadata", missing: ["configPath"] }
                : { ok: false, error: "invalid-provider-metadata", missing: ["owner-scoped configPath readable"] };
        }
    }
    try {
        assertDeviceLabPathWithinRoot(root, configPath, "windows-sandbox-config");
        const config = readDeviceLabTextFile(configPath, "windows-sandbox-config", DEVICE_BROKER_WINDOWS_CONFIG_LIMIT_BYTES);
        if (config === null)
            throw new Error("windows-sandbox-config-missing");
        return { ok: true, config };
    }
    catch {
        return { ok: false, error: "invalid-provider-metadata", missing: ["owner-scoped configPath readable"] };
    }
}
function brokerWindowsLifecyclePorts(normalized: NormalizedBrokerOptions): BrokerWindowsSandboxLifecyclePorts<NativeProviderLifecycleEffect, NativeBrokerExecutionReceipt> {
    return {
        prepare: (owner, parsed, device) => {
            const command = planBrokerWindowsSandboxCommand(owner, parsed, device, { executable: name => executableFor(name, normalized), stopRuntimeId: brokerWindowsSandboxIdForStop, readConfig: readBrokerWindowsLifecycleConfig, newRuntimeId: randomGuid });
            if ("error" in command)
                return { kind: "unavailable", error: command.error, missing: command.missing };
            return { kind: "ready", handle: new NativeProviderLifecycleEffect(command), operationKind: command.mode === "noop" ? "metadata-only" : "runtime", sandboxId: command.sandboxId, minimized: command.windowStyle === "minimized" };
        },
        run: (handle, options) => nativeLifecycleObservation(runLifecycleEffect(normalized, handle.command, options), handle.command),
        listRuntime: (handle, options) => {
            const receipt = normalized.commandRunner({ mode: "exec", provider: "wsb", executable: handle.command.executable, args: ["list", "--raw"] }, options);
            const observed = nativeLifecycleObservation(receipt);
            return { ...observed, ids: observed.ok ? windowsSandboxSessionIdsFromBrokerListOutput(receipt.stdout || "") : [],
                ...(!observed.ok ? { error: receipt.error || "windows-sandbox-runtime-snapshot-failed" } : {}),
            };
        },
        isCanonicalConfig: (ownerId, deviceId, path) => resolve(path) === resolve(brokerWindowsConfigPath(ownerId, deviceId)),
        writeConfig: (ownerId, deviceId, device) => { writeBrokerWindowsConfig(ownerId, deviceId, device, normalized); return undefined; },
        claimSingleton: (ownerId, device, id) => claimBrokerWindowsSandboxLock(ownerId, device, id),
        releaseSingleton: (ownerId, device, id) => { releaseBrokerWindowsSandboxLock(ownerId, device, id, () => assertCleanupDeadline(normalized)); return undefined; },
        updateSingletonRuntimeId: (ownerId, device, claimed, runtime) => { updateBrokerWindowsSandboxLockRuntimeId(ownerId, device, claimed, runtime); return undefined; },
        helperPaths: (ownerId, deviceId) => brokerWindowsHelperPaths(ownerId, deviceId),
        removeMarker: path => { rmSync(path, { force: true }); return undefined; },
        snapshotWindows: options => {
            const receipt = normalized.commandRunner({ mode: "exec", provider: "powershell", executable: "powershell.exe", args: windowsSandboxWindowHandleSnapshotArgs() }, options);
            const observed = nativeLifecycleObservation(receipt);
            return { ...observed, handles: observed.ok ? windowsSandboxWindowHandlesFromOutput(receipt.stdout || "") : null };
        },
        launchWatchdog: (startedAfter, paths, handles, options) => {
            const receipt = normalized.commandRunner({ mode: "detached", provider: "powershell", executable: "powershell.exe", args: windowsSandboxMinimizeWatchdogArgs(DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS, startedAfter, paths.minimizeWatchdogCancelPath, handles, paths.minimizeWatchdogResultPath) }, options);
            const observed = nativeLifecycleObservation(receipt);
            return { ...observed, ...(!observed.ok ? { minimizeReason: "watchdog-launch-failed" as const,
                minimizeWarning: receipt.error || receipt.stderr || "Windows Sandbox started, but window minimization was not confirmed" } : {}) };
        },
        waitForMinimizeConfirmation: path => {
            const receipt = waitForBrokerWindowsMinimizeConfirmation(path);
            const observed = nativeLifecycleObservation(receipt);
            return { ...observed, ...(!observed.ok ? { minimizeReason: "not-confirmed" as const,
                minimizeWarning: receipt.error || receipt.stderr || "Windows Sandbox started, but window minimization was not confirmed" } : {}) };
        },
        cancelWatchdog: (ownerId, deviceId) => cancelBrokerWindowsMinimizeWatchdog(ownerId, deviceId),
        cleanupAuxiliary: (ownerId, parsed, expected) => cleanupLifecycleAuxiliaryRuntime(ownerId, parsed, normalized, expected),
        cleanArtifacts: (ownerId, deviceId) => normalized.windowsDeviceArtifactCleaner(ownerId, deviceId),
        inspectExpectedRecord: (ownerId, stateKey, deviceId, expected) => withSharedMutationLock(ownerDevicesMutationLockFile(ownerId, stateKey), () => {
            const device = readOwnerDevices(ownerId, stateKey).find(candidate => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === deviceId);
            return { found: Boolean(device), matched: Boolean(device && isDeepStrictEqual(device, expected)), device: device || null };
        }),
        publish: (ownerId, stateKey, deviceId, expected, change) => publishLifecycleDevice(normalized, ownerId, stateKey, deviceId, expected, candidate => {
            const replacement = brokerWindowsSandboxReplacement(candidate, change);
            if (replacement === null)
                return null;
            if (change.kind === "start" && typeof change.watchdog?.pid === "number") {
                (replacement.minimizeWatchdog as Record<string, unknown>).startedAt = new Date().toISOString();
            }
            return { ...replacement, updatedAt: new Date().toISOString() };
        }),
        now: () => performance.now(),
        timestampBefore: milliseconds => new Date(Date.now() - milliseconds).toISOString(),
        sleep: milliseconds => { sleepSync(milliseconds); return undefined; },
        get platform() { return normalized.platform; },
        get commandTimeoutMs() { return normalized.commandTimeoutMs; },
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    };
}

function nativeLifecycleObservation(receipt: ProviderCommandResult, preparedCommand?: ProviderCommand) {
    return { mode: receipt.mode, provider: receipt.provider, ok: commandSucceeded(receipt), pid: receipt.pid,
        typedCreateInvalidResult: receipt.typedCreateInvalidResult,
        receipt: new NativeBrokerExecutionReceipt(receipt, preparedCommand) };
}
function brokerIosLifecyclePorts(normalized: NormalizedBrokerOptions): BrokerIosSimulatorLifecyclePorts<NativeProviderLifecycleEffect> {
    return {
        execute: (effect, options) => nativeLifecycleObservation(runLifecycleEffect(normalized, effect.command, options)),
        executeShutdownIfCurrent: (owner, parsed, expected, effect, options) => {
            const waitMs = Math.floor(options.remainingMs());
            if (!(waitMs >= 1)) return {kind: "timed-out"};
            try {
                return withSharedMutationLock<BrokerIosConditionalShutdownExecution>(ownerDevicesMutationLockFile(owner, parsed.stateKey), () => {
                    const device = readOwnerDevices(owner, parsed.stateKey).find(candidate => cleanupRecord(candidate) && candidate.id === parsed.deviceId);
                    if (!device || !isDeepStrictEqual(device, expected)) return {kind: "state-conflict", found: Boolean(device), device: device || null};
                    const timeoutMs = Math.floor(options.remainingMs());
                    if (!(timeoutMs >= 1)) return {kind: "timed-out"};
                    return {kind: "executed", execution: nativeLifecycleObservation(runLifecycleEffect(normalized, effect.command, {timeoutMs, outputLimit: options.outputLimit}))};
                }, {waitMs, waitBudget: {remaining: options.remainingMs}});
            } catch (cause) {
                if (isDeviceOperationLockTimeout(cause) && !(Math.floor(options.remainingMs()) >= 1)) return {kind: "timed-out"};
                throw cause;
            }
        },
        executeCreate: (effect, options) => {
            const receipt = normalized.commandRunner(effect.command, options);
            return { ...nativeLifecycleObservation(receipt),
                createdUdid: commandSucceeded(receipt) && receipt.mode !== "noop" ? iosSimulatorCreatedUdid(receipt.stdout) : null,
            };
        },
        observeShutdown: (effect, owner, device, options) => {
            const command = effect.command;
            const target = command.args?.[2];
            if (command.mode !== "exec" || command.provider !== "xcrun" || command.args?.length !== 3
                || command.args[0] !== "simctl" || command.args[1] !== "shutdown" || !target) return {ok: false, state: null};
            const observed = resolveBrokerOwnedIosSimulatorTarget(owner, device, normalized, options);
            if (!observed.ok || observed.target !== target) return {ok: false, state: null};
            const state = observed.state;
            return state === "Shutdown" || state === "Booted" || state === "Shutting Down"
                ? {ok: true, state} : {ok: false, state: null};
        },
        prepareCreate: input => {
            const executable = executableFor("xcrun", normalized);
            const command: NativeLifecycleCommand = iosSimulatorCreateCommand({ ...input, executable });
            if ("error" in command)
                return { kind: "unavailable", error: command.error, missing: command.missing };
            return { kind: "ready", effect: new NativeProviderLifecycleEffect(command), provider: command.provider, canCompensate: Boolean(command.executable), bootEligible: false };
        },
        prepareExisting: ({ parsed, target }) => {
            const executable = executableFor("xcrun", normalized);
            const verb = parsed.command === "device_status" ? "list" : parsed.command === "device_start" ? "boot" : parsed.command === "device_stop" ? "shutdown" : "delete";
            const command: ProviderCommand = { mode: "exec", provider: "xcrun", executable, args: verb === "list" ? ["simctl", "list", "devices", target] : ["simctl", verb, target] };
            return { kind: "ready", effect: new NativeProviderLifecycleEffect(command), provider: "xcrun", canCompensate: Boolean(executable), bootEligible: false };
        },
        prepareDelete: (effect, target) => new NativeProviderLifecycleEffect(iosSimulatorDeleteCommand(effect.command.executable || "", target)),
        timestamp: () => new Date().toISOString(),
        verifyOwnedTarget: (owner, device) => resolveBrokerOwnedIosSimulatorTarget(owner, device, normalized),
        claimDefinition: (owner, parsed, device) => claimOwnerDevice(owner, parsed.stateKey, device, createOwnerDeviceUniqueFields(parsed)),
        cleanupAuxiliary: (owner, parsed, expected) => cleanupLifecycleAuxiliaryRuntime(owner, parsed, normalized, expected),
        publish: (owner, state, id, expected, change, options) => {
            const replacement = (candidate: Record<string, unknown>) => {
                const next = brokerIosReplacement(candidate, change);
                return next === null ? null : { ...next, updatedAt: new Date().toISOString() };
            };
            if (!options) return publishLifecycleDevice(normalized, owner, state, id, expected, replacement);
            const expired = Symbol("ios-shutdown-publication-deadline");
            let current: Record<string, unknown> | undefined;
            try {
                const publication = transitionOwnerLifecycleDevice(owner, state, id, expected, candidate => {
                    if (!(Math.floor(options.remainingMs()) >= 1)) { current = candidate; throw expired; }
                    return replacement(candidate);
                });
                if (normalized.cleanupObservation && publication.matched) normalized.cleanupObservation.changed = true;
                return publication;
            } catch (cause) {
                if (cause !== expired) throw cause;
                return {found: true, matched: true, device: current, deadlineExpired: true};
            }
        },
        now: normalized.hyperVMonotonicNow,
        sleep,
        stateErrorCode: ownerDeviceStateErrorCode,
        get commandTimeoutMs() { return cleanupExitBudget(normalized, normalized.commandTimeoutMs); },
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    };
}
function brokerMacosHelperFirstFailure(value: unknown): BrokerMacosHelperPreparation["firstFailure"] {
    if (!cleanupRecord(value) || typeof value.provider !== "string" || !["ssh", "scp"].includes(value.provider)
        || typeof value.connection !== "string" || !["refused", "reset", "closed", "timeout", "unreachable", "authentication", "other"].includes(value.connection)
        || !cleanupRecord(value.execution)) return undefined;
    const execution = value.execution;
    if (!(execution.status === null || typeof execution.status === "number" && Number.isSafeInteger(execution.status) && execution.status >= 0)
        || !(execution.signal === null || typeof execution.signal === "string" && Object.hasOwn(osConstants.signals, execution.signal))
        || typeof execution.timedOut !== "boolean") return undefined;
    return {provider: value.provider as "ssh" | "scp",
        execution: {status: execution.status as number | null, signal: execution.signal as string | null, timedOut: execution.timedOut},
        connection: value.connection as NonNullable<BrokerMacosHelperPreparation["firstFailure"]>["connection"]};
}

async function provisionBrokerMacosGuestHelper(ownerId: string, expected: unknown, device: Record<string, unknown>, options: {remainingMs: () => number; waitForReady: boolean}, normalized: NormalizedBrokerOptions): Promise<BrokerMacosHelperPreparation> {
    const failed = (error: string): BrokerMacosHelperPreparation => ({ok: false, skipped: false, error, helper: {status: "failed", provisioning: {status: "failed"}}});
    if (!(options.remainingMs() >= 1)) return failed("macos-helper-readiness-timeout");
    if (ownerId !== canonicalDeviceLabOwnerId(normalized.cwd, normalized.profile)
        || typeof device.id !== "string" || (device.ownerId !== undefined && device.ownerId !== ownerId)) return failed("broker-owner-basis-unavailable");
    const current = withSharedMutationLock(ownerDevicesMutationLockFile(ownerId, "macos"), () =>
        readOwnerDevices(ownerId, "macos").find(candidate => cleanupRecord(candidate) && candidate.id === device.id), {waitBudget: {remaining: options.remainingMs}});
    if (!current || !isDeepStrictEqual(current, expected)) return failed("owner-device-state-conflict");
    const invocation = deviceLabBackendInvocation(normalized, "macos-vm");
    if (!invocation || !existsSync(invocation.modulePath)) return failed("device-lab-backend-module-missing");
    const capturedNs = process.hrtime.bigint();
    const duration = Math.floor(options.remainingMs());
    if (!(Number.isFinite(duration) && duration >= 1)) return failed("macos-helper-readiness-timeout");
    const deadlineNs = (capturedNs + BigInt(duration) * 1000000n).toString();
    const script = [
        "import { readFileSync, writeSync } from 'fs';",
        "const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');",
        "const context = await import(new URL('../context.mjs', payload.moduleUrl));",
        "if (context.ownerId() !== payload.ownerId) throw new Error('broker-owner-basis-unavailable');",
        "const backend = await import(payload.moduleUrl);",
        "let reportedFirstFailure = false;",
        "const onFirstFailure = firstFailure => {",
        "  if (reportedFirstFailure) return;",
        "  reportedFirstFailure = true;",
        "  const line = JSON.stringify({firstFailure}) + '\\n';",
        "  if (Buffer.byteLength(line) <= 512) writeSync(1, line);",
        "};",
        "const result = await backend.prepareMacosGuestHelper(payload.device, payload.allowanceMs, payload.waitForReady, {deadlineNs: payload.deadlineNs, onFirstFailure});",
        "writeSync(1, JSON.stringify({result}) + '\\n');",
    ].join("\n");
    const receipt = await runBrokerBackendChild(script, JSON.stringify({moduleUrl: pathToFileURL(invocation.modulePath).href,
        ownerId, device, allowanceMs: duration, deadlineNs, waitForReady: options.waitForReady}), {
        cwd: normalized.cwd, env: {...process.env, ...normalized.env, CCC_PROFILE: normalized.profile || ""},
        timeoutMs: duration, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    let finalOutput = receipt.stdout;
    let firstFailure: BrokerMacosHelperPreparation["firstFailure"];
    const firstLineEnd = receipt.stdout.indexOf("\n");
    if (firstLineEnd >= 0 && Buffer.byteLength(receipt.stdout.slice(0, firstLineEnd + 1)) <= 512) {
        let frame: unknown;
        try {frame = JSON.parse(receipt.stdout.slice(0, firstLineEnd));} catch { /* An incomplete or malformed progress frame carries no observation. */ }
        if (cleanupRecord(frame) && Object.keys(frame).length === 1 && Object.hasOwn(frame, "firstFailure")) {
            firstFailure = brokerMacosHelperFirstFailure(frame.firstFailure);
            if (firstFailure) finalOutput = receipt.stdout.slice(firstLineEnd + 1);
        }
    }
    if (receipt.status !== 0 || receipt.error || receipt.signal || receipt.timedOut) {
        return {...failed(receipt.timedOut ? "macos-helper-readiness-timeout" : "macos-helper-prepare-failed"),
            execution: {status: receipt.status, signal: receipt.signal, timedOut: receipt.timedOut}, ...(firstFailure ? {firstFailure} : {})};
    }
    let value: unknown;
    try {value = (JSON.parse(finalOutput) as {result?: unknown}).result;} catch {return failed("macos-helper-prepare-invalid-result");}
    if (!cleanupRecord(value) || typeof value.ok !== "boolean" || typeof value.skipped !== "boolean" || !cleanupRecord(value.helper)) return failed("macos-helper-prepare-invalid-result");
    const helper = value.helper;
    const expectedStatus = value.ok ? value.skipped ? "skipped-missing-ssh" : "provisioned" : "failed";
    if (helper.status !== expectedStatus || value.ok && value.skipped) return failed("macos-helper-prepare-invalid-result");
    const ssh = cleanupRecord(device.ssh) ? device.ssh : {};
    const nativeProvisioning = cleanupRecord(helper.provisioning) ? helper.provisioning : {};
    const metadata: Record<string, unknown> = {
        status: expectedStatus,
        remoteScriptPath: cleanupRecord(device.helper) && typeof device.helper.remoteScriptPath === "string"
            ? device.helper.remoteScriptPath : `/tmp/ccc-${device.id}-guest-helper.sh`,
        ssh: {host: ssh.host, user: ssh.user, port: typeof ssh.port === "number" ? ssh.port : 22},
        provisioning: {status: expectedStatus,
            ...(["ssh", "scp", "ssh-scp", "local", "ssh-key-policy"].includes(String(nativeProvisioning.provider)) ? {provider: nativeProvisioning.provider} : {}),
            updatedAt: new Date().toISOString()},
    };
    const allowedErrors = ["macos-helper-readiness-timeout", "macos-helper-write-failed", "macos-helper-scp-failed", "macos-helper-chmod-failed", "macos-helper-prepare-failed"];
    const execution = cleanupRecord(value.execution) ? value.execution : null;
    const selectedExecution = execution ? {
        status: typeof execution.status === "number" && Number.isSafeInteger(execution.status) ? execution.status : null,
        signal: typeof execution.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(execution.signal) ? execution.signal : null,
        ...(typeof execution.timedOut === "boolean" ? {timedOut: execution.timedOut} : {}),
    } : undefined;
    if (value.ok && !(options.remainingMs() > 0)) return {...failed("macos-helper-readiness-timeout"), ...(selectedExecution ? {execution: selectedExecution} : {}), ...(firstFailure ? {firstFailure} : {})};
    return {ok: value.ok, skipped: value.skipped, helper: metadata,
        ...(!value.ok ? {error: allowedErrors.includes(String(value.error)) ? String(value.error) : "macos-helper-prepare-failed", ...(firstFailure ? {firstFailure} : {})} : {}),
        ...(selectedExecution ? {execution: selectedExecution} : {})};
}

function brokerMacosLifecyclePorts(normalized: NormalizedBrokerOptions): BrokerMacosVmLifecyclePorts<NativeProviderLifecycleEffect> {
    const remaining = normalized.macosCreateRemainingMs || normalized.macosStartRemainingMs;
    const claimRepository = remaining ? createBrokerOwnerRepository({...ownerRepositoryPorts,
        withLock: (ownerId, stateKey, operation) => withSharedMutationLock(ownerDevicesMutationLockFile(ownerId, stateKey), operation, {waitBudget: {remaining}}),
    }) : ownerRepository;
    const observed = (receipt: ProviderCommandResult) => {
        const output = `${receipt.stderr || ""}\n${receipt.stdout || ""}`.toLowerCase();
        return { ...nativeLifecycleObservation(receipt), resourceMissing: output.includes("does not exist") || output.includes("not found") };
    };
    return {
        executeMetadata: async (purpose, options) => {
            const receipt = await runBudgetedProviderCommand(normalized, { mode: "noop", provider: "host-broker-state", reason: nativeMetadataDescription(purpose) }, options);
            if (normalized.cleanupObservation) normalized.cleanupObservation.execution = receipt;
            return observed(receipt);
        },
        execute: async (effect, options) => {
            let receipt: ProviderCommandResult;
            try {receipt = await runBudgetedProviderCommand(normalized, effect.command, options);}
            catch (error) {
                // A successful clone's compensation may exhaust admission time.
                // Preserve the original claim failure and this refused cleanup.
                if (!normalized.macosCreateRemainingMs || effect.command.args?.[0] !== "delete" || !(error instanceof CleanupOperationDeadlineError)) throw error;
                receipt = {mode: effect.command.mode, provider: effect.command.provider, status: null, error: "macos-tart-create-budget-exhausted", timedOut: true};
            }
            if (normalized.cleanupObservation) normalized.cleanupObservation.execution = receipt;
            return observed(receipt);
        },
        prepareCreate: ({ provider, image, instance }) => {
            const command: ProviderCommand = { mode: "exec", provider, executable: executableFor(provider, normalized), args: ["clone", image, instance] };
            return { kind: "ready", effect: new NativeProviderLifecycleEffect(command), provider, canCompensate: Boolean(command.executable), bootEligible: false };
        },
        prepareExisting: ({ parsed, provider, instance, headless }) => {
            const executable = executableFor(provider, normalized);
            const command: ProviderCommand = parsed.command === "device_status" ? { mode: "exec", provider, executable, args: [provider === "tart" ? "get" : "status", instance] }
                : parsed.command === "device_start" ? { mode: provider === "tart" ? "detached" : "exec", provider, executable, args: provider === "tart" ? ["run", ...(headless ? ["--no-graphics"] : []), instance] : ["start", instance] }
                    : { mode: "exec", provider, executable, args: [parsed.command === "device_stop" ? "stop" : "delete", instance] };
            return { kind: "ready", effect: new NativeProviderLifecycleEffect(command), provider, canCompensate: Boolean(executable), bootEligible: command.mode === "detached" && Boolean(executable) };
        },
        prepareDelete: (effect, target) => new NativeProviderLifecycleEffect({ mode: "exec", provider: effect.command.provider, executable: effect.command.executable, args: ["delete", target] }),
        observeIp: async (effect, instance, resolver, options) => {
            const receipt = await runBudgetedProviderCommand(normalized, { mode: "exec", provider: "tart", executable: effect.command.executable, args: resolver === "arp" ? ["ip", "--resolver=arp", instance] : ["ip", instance] }, options);
            return { ...observed(receipt), address: String(receipt.stdout || "").trim() || null };
        },
        provisionGuestHelper: (ownerId, expected, device, options) => provisionBrokerMacosGuestHelper(ownerId, expected, device, options, normalized),
        timestamp: () => new Date().toISOString(), runtimeId: randomUUID, now: normalized.hyperVMonotonicNow, sleep,
        claimDefinition: (owner, parsed, device) => claimRepository.claim(owner, parsed.stateKey, device, createOwnerDeviceUniqueFields(parsed), remaining ? () => {assertCleanupDeadline(normalized); return undefined;} : undefined),
        cleanupAuxiliary: (owner, parsed, expected) => cleanupLifecycleAuxiliaryRuntimeAsync(owner, parsed, normalized, expected),
        publish: (owner, state, id, expected, change) => {
            const replace = (candidate: Record<string, unknown>) => {
                assertCleanupDeadline(normalized);
                const replacement = brokerMacosReplacement(candidate, change);
                if (replacement === null) return null;
                if (change.kind === "start" && cleanupRecord(replacement.lastBootCheck) && change.boot?.ok && change.boot.result)
                    replacement.lastBootCheck.result = change.boot.result.receipt instanceof NativeBrokerExecutionReceipt ? change.boot.result.receipt.value : change.boot.result;
                return { ...replacement, updatedAt: new Date().toISOString() };
            };
            if (!normalized.macosStartRemainingMs) return publishLifecycleDevice(normalized, owner, state, id, expected, replace);
            assertCleanupDeadline(normalized);
            return claimRepository.transitionLifecycle(owner, state, id, expected, replace);
        },
        stateErrorCode: ownerDeviceStateErrorCode, commandTimeoutMs: normalized.commandTimeoutMs,
        createTimeoutMs: Math.min(BROKER_MACOS_TART_CLONE_TIMEOUT_MS, normalized.explicitCommandTimeoutMs ?? BROKER_MACOS_TART_CLONE_TIMEOUT_MS),
        ...(remaining ? {remainingMs: remaining} : {}),
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    };
}

function nativePhysicalAdmission(ownerId: string, match: DeviceToolMatch, deviceId: string, budget?: AppiumRequestBudget): DeviceStatusPhysicalAdmission {
    if (!DEVICE_BROKER_PHYSICAL_BACKENDS.has(match.stateKey))
        return { kind: "admitted" };
    const hardwareId = match.stateKey === "android-device" ? field(match.device, "serial") : field(match.device, "udid");
    const claimId = field(match.device, "leaseClaimId");
    const claimNonce = field(match.device, "leaseClaimNonce");
    if (!hardwareId || !claimId || !claimNonce)
        return { kind: "refused" };
    const outcome = brokerPhysicalLeases.heartbeat(ownerId, { backend: match.stateKey, hardwareId, deviceId, claimId, claimNonce }, budget);
    return outcome.kind === "renewed" ? { kind: "admitted" } : { kind: "refused", failure: outcome };
}

function nativeStatusPreview(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions): DeviceStatusPreparation<NativeStatusConnection> {
    const parsed = validateCommandParams(params);
    if (!parsed.ok)
        return { kind: "refused", reason: "invalid", error: parsed.error, ...(parsed.allowed ? { allowed: parsed.allowed } : {}), ...(parsed.detail ? { detail: parsed.detail } : {}) };
    const observation = observeLifecyclePreview(ownerId, parsed, normalized, false);
    const base = { ownerId, backend: parsed.backend, deviceId: parsed.deviceId };
    switch (observation.kind) {
        case "state-failed": return { kind: "refused", ...nativeHyperVStateFailure(observation.error, parsed) };
        case "allocation-failed": return { kind: "refused", reason: observation.evidence.error === "invalid-android-emulator-port" ? "invalid" : observation.evidence.error === "android-emulator-port-inventory-unavailable" ? "provider-unavailable" : "conflict", ...base, error: observation.evidence.error, detail: observation.evidence.detail, allowed: observation.evidence.allowed };
        case "already-exists": return { kind: "refused", reason: "conflict", ...base, error: "owner-device-already-exists" };
        case "not-found": return { kind: "refused", reason: "missing", ...base, error: "owner-device-not-found" };
        case "not-attached": return { kind: "refused", reason: "conflict", ...base, error: "physical-device-not-attached", remedy: "attach the physical device before starting it" };
        case "missing-delete": return { kind: "prepared", plan: { ...observation.value, idempotent: true, availability: { kind: "not-required" } } };
        case "create":
        case "existing": {
            const { providerPlan, providerAvailable: _available, ...facts } = observation.value;
            if (!providerPlan)
                return { kind: "prepared", plan: { ...facts, availability: { kind: "not-required" } } };
            if ("error" in providerPlan)
                return { kind: "prepared", plan: { ...facts, availability: { kind: "unavailable", error: providerPlan.error, missing: providerPlan.missing } } };
            if (providerPlan.mode !== "exec" && providerPlan.mode !== "detached" && providerPlan.mode !== "noop")
                return { kind: "prepared", plan: { ...facts, availability: { kind: "unavailable", error: "missing-provider-command", missing: [] } } };
            return { kind: "prepared", plan: { ...facts, availability: { kind: "available", mode: providerPlan.mode, provider: providerPlan.provider,
                        connection: { command: { ...providerPlan, mode: providerPlan.mode } } } } };
        }
    }
}

function renderBrokerDeviceStatusWithDiagnostics(outcome: Parameters<typeof renderBrokerDeviceStatus>[0], params: unknown): BrokerRpcResult {
    const response = renderBrokerDeviceStatus(outcome, redactBrokerDeviceSecrets, providerFailureDetail);
    if (!params || typeof params !== "object" || (params as Record<string, unknown>).detail !== true
        || !("device" in outcome) || !desktopRecord(outcome.device)) return response;
    const incarnationId = hyperVDeviceIncarnationId(outcome.device);
    const payload = response.payload;
    if (!desktopRecord(payload)) return response;
    const result = payload.result;
    if (incarnationId && desktopRecord(result) && desktopRecord(result.device)) {
        return { ...response, payload: { ...payload, result: { ...result, device: { ...result.device, incarnationId } } } };
    }
    return response;
}

function brokerDeviceStatusApplication(normalized: NormalizedBrokerOptions) {
    const observed = (receipt: ProviderCommandResult, hyperV = false) => ({
        mode: receipt.mode, provider: receipt.provider, ok: commandSucceeded(receipt),
        adbState: hyperV ? null : String(receipt.stdout || "").trim().toLowerCase(),
        vm: hyperV && commandSucceeded(receipt) ? parseHyperVVmObservation(receipt.stdout || "") : null,
        receipt,
    });
    return createBrokerDeviceStatus<NativeStatusConnection, ProviderCommandResult>({
        preview: (owner, _request, params) => nativeStatusPreview(owner, params, normalized),
        refreshPhysicalLease: (owner, request, device) => nativePhysicalAdmission(owner, { stateKey: request.stateKey, backend: request.backend, device }, request.deviceId),
        observe: async connection => { const options = { timeoutMs: normalized.commandTimeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT }; const receipt = await runBudgetedProviderCommand(normalized, connection.command, options); return observed(receipt); },
        observeHyperVFallback: async (connection, deadline) => { const receipt = await hyperVProviderCommandRunner(normalized, connection.command, { timeoutMs: hyperVRemainingTimeout(deadline, 120000, normalized.hyperVMonotonicNow), outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT }); return observed(receipt, true); },
        typedStatus: async (connection, identity, deadline) => { const receipt = await hyperVTypedStatusExecution(normalized, { ...identity, executable: connection.command.executable || "powershell.exe" }, deadline, 120000, false, normalized.hyperVMonotonicNow); return observed(receipt, true); },
        incarnation: hyperVDeviceIncarnationId, validIncarnation: validHyperVIncarnationId,
        deadlineExpired: deadline => hyperVOperationDeadlineExpired(deadline, normalized.hyperVMonotonicNow),
        assertDeadline: deadline => { assertHyperVOperationDeadline(deadline, normalized.hyperVMonotonicNow); return undefined; },
        timestamp: () => new Date().toISOString(), diagnosticCode: (execution, fallback) => hyperVProviderDiagnosticCode(execution.receipt ?? execution, fallback),
        operationPending: (owner, backend, id) => existsSync(hyperVOperationJournalPath(owner, backend, id)),
        snapshotPending: (owner, backend, id) => existsSync(hyperVSnapshotJournalPath(owner, backend, id)),
        readDevices: readOwnerDevices, readOperationJournal: readHyperVOperationJournal, readSnapshotJournal: readHyperVSnapshotJournal,
        reconcileOperation: (owner, backend, id, deadline, preserveNetwork) => brokerHyperVStopDeleteApplication(normalized).reconcile(owner, backend, id, deadline, preserveNetwork),
        repairSnapshots: (owner, backend, id, device, connection, deadline) => observeHyperVSnapshotJournal(owner, backend, id, device, connection.command.executable || "powershell.exe", normalized, undefined, deadline),
        recoveryConnection: () => { const native = nativeHyperVConnection(normalized, "powershell"); return native ? { command: { mode: "exec", provider: "hyper-v", executable: native.executable, args: [] } } : null; },
        stateErrorCode: ownerDeviceStateErrorCode, stateFailure: nativeHyperVStateFailure, errorCode: hyperVBoundedErrorCode,
        withHostLock: (deadline, operation) => withSharedMutationLockAsync(brokerHyperVMutationLockPath(), operation, { waitMs: hyperVRemainingTimeout(deadline, DEVICE_BROKER_HYPER_V_HOST_LOCK_WAIT_MS, normalized.hyperVMonotonicNow), waitBudget: { remaining: () => deadline - normalized.hyperVMonotonicNow() }, staleMs: DEVICE_BROKER_HYPER_V_HOST_LOCK_STALE_MS }),
        lockTimedOut: isDeviceOperationLockTimeout,
    });
}

async function lifecycleCommandInvokeUnlocked(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions, physicalLeaseGuard?: PhysicalLeaseReleaseGuard, hyperVDeadlineAt = Number.POSITIVE_INFINITY, hyperVCleanupDeadlineAt = hyperVDeadlineAt, admittedDeviceId?: string): Promise<BrokerRpcResult> {
    const parsed = validateCommandParams(params, admittedDeviceId);
    if (!parsed.ok)
        return commandParamError(parsed);
    if (parsed.backend === "macos-vm" && parsed.command === "device_create"
        && existsSync(join(dirname(ownerDevicesFile(ownerId, parsed.stateKey)), parsed.deviceId))) {
        return { status: 409, payload: { ok: false, error: "owner-device-already-exists", ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
    }
    if (parsed.command === "device_status") return renderBrokerDeviceStatusWithDiagnostics(await brokerDeviceStatusApplication(normalized).execute(ownerId, { ...parsed, command: "device_status" }, params, hyperVDeadlineAt), params);
    if (isHyperVBackend(parsed.backend) && (parsed.command === "device_stop" || parsed.command === "device_delete")) {
        return renderHyperVStopDelete(await brokerHyperVStopDeleteApplication(normalized).invoke(ownerId, { ...parsed, command: parsed.command }, hyperVDeadlineAt, hyperVCleanupDeadlineAt));
    }
    if(isHyperVBackend(parsed.backend)&&(parsed.command==="device_create"||parsed.command==="device_start"||parsed.command==="device_reboot"))return renderHyperVCreateStart(await brokerHyperVCreateStartApplication(normalized).execute(ownerId,{...parsed,command:parsed.command},params,hyperVDeadlineAt,hyperVCleanupDeadlineAt));
    const androidCreateAvdRoot = parsed.backend === "android-emulator"
        && parsed.command === "device_create"
        && parsed.create?.createAvd === true
        ? androidAvdHome()
        : null;
    const expectedObservation: {
        device?: unknown;
    } = {};
    const plan = lifecycleCommandPlan(ownerId, params, normalized, false, expectedObservation, parsed.deviceId);
    let expectedDevice = expectedObservation.device;
    if (plan.status !== 200)
        return plan;
    if ((parsed.stateKey === "android-device" || parsed.stateKey === "ios-device") && parsed.command === "device_stop") {
        const planPayload = cleanupRecord(plan.payload) ? plan.payload : {};
        const result = "result" in planPayload && cleanupRecord(planPayload.result) ? planPayload.result : {};
        return renderPhysicalStopOutcome(brokerPhysicalDevicesApplication(normalized).stop(ownerId, parsed, result.device, expectedDevice), result, redactBrokerDeviceSecrets);
    }
    const payload = plan.payload as {
        result?: {
            create?: unknown;
            device?: unknown;
            idempotent?: boolean;
            execution?: {mode: string; providerExecution: string; mutatesHost: boolean};
            providerCommand?: ProviderCommand | {
                error: string;
                missing: string[];
            };
        };
    };
    if (parsed.dryRun) {
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ...(isHyperVBackend(parsed.backend)
                        ? redactHyperVResultSecrets(payload.result)
                        : { ...(payload.result || {}), device: redactBrokerDeviceSecrets(payload.result?.device) }),
                    invoked: false,
                    dryRun: true,
                    execution: {
                        mode: "dry-run",
                        providerExecution: "available",
                        mutatesHost: false,
                    },
                },
            },
        };
    }
    if (payload.result?.idempotent) {
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ...(isHyperVBackend(parsed.backend)
                        ? redactHyperVResultSecrets(payload.result)
                        : payload.result),
                    invoked: false,
                    dryRun: false,
                    execution: { mode: "idempotent", providerExecution: "not-required", mutatesHost: false },
                },
            },
        };
    }
    const publicContext = {ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, command: parsed.command, deleteAvd: parsed.deleteAvd, plan: payload.result};
    if (parsed.backend === "android-emulator" && ["device_create", "device_start", "device_stop", "device_delete"].includes(parsed.command)) {
        const lifecycle = createBrokerAndroidEmulatorLifecycle(brokerAndroidLifecyclePorts(normalized));
        const {providerCommand, execution: _publicExecution, ...facts} = payload.result || {};
        const input = {ownerId, parsed, plan: payload.result ? {...facts, create: parsed.create, preparation: nativeLifecyclePreparation(providerCommand)} : undefined, expectedDevice, createAvdRoot: androidCreateAvdRoot};
        const result = parsed.command === "device_create" ? await lifecycle.create(input) : parsed.command === "device_start" ? await lifecycle.start(input) : parsed.command === "device_stop" ? await lifecycle.stop(input) : await lifecycle.delete(input);
        return renderBrokerAndroidLifecycle(result, publicContext, redactBrokerDeviceSecrets, ownerDeviceStateFailure, providerFailureDetail);
    }
    if ((parsed.backend === "ios-simulator" || parsed.backend === "macos-vm") && ["device_create", "device_start", "device_stop", "device_delete"].includes(parsed.command)) {
        const {providerCommand, execution: _publicExecution, ...facts} = payload.result || {};
        const input = {ownerId, parsed, plan: payload.result ? {...facts, create: parsed.create, providerCommand: nativeLifecyclePreparation(providerCommand)} : undefined, expectedDevice};
        if (parsed.backend === "ios-simulator") {
            const lifecycle = createBrokerIosSimulatorLifecycle(brokerIosLifecyclePorts(normalized));
            const result = parsed.command === "device_create" ? await lifecycle.create(input) : parsed.command === "device_start" ? await lifecycle.start(input) : parsed.command === "device_stop" ? await lifecycle.stop(input) : await lifecycle.delete(input);
            return renderBrokerIosMacosLifecycle(result, publicContext, redactBrokerDeviceSecrets, ownerDeviceStateFailure, providerFailureDetail);
        }
        const lifecycle = createBrokerMacosVmLifecycle(brokerMacosLifecyclePorts(normalized));
        const result = parsed.command === "device_create" ? await lifecycle.create(input) : parsed.command === "device_start" ? await lifecycle.start(input) : parsed.command === "device_stop" ? await lifecycle.stop(input) : await lifecycle.delete(input);
        return renderBrokerIosMacosLifecycle(result, publicContext, redactBrokerDeviceSecrets, ownerDeviceStateFailure, providerFailureDetail);
    }
    if (parsed.backend === "windows-sandbox" && ["device_start", "device_stop", "device_delete"].includes(parsed.command)) {
        // Admit existing ownership before discovery, including prepared starts.
        // The actual singleton claim still follows the runtime snapshot.
        if (parsed.command === "device_start") readBrokerWindowsSandboxLock();
        const ports = brokerWindowsLifecyclePorts(normalized);
        const lifecycle = createBrokerWindowsSandboxLifecycle(ports);
        const command = payload.result?.providerCommand;
        const prepared = command && "mode" in command ? {kind: "ready" as const, handle: new NativeProviderLifecycleEffect(command), operationKind: command.mode === "noop" ? "metadata-only" as const : "runtime" as const, sandboxId: command.sandboxId, minimized: command.windowStyle === "minimized"}
            : command ? {kind: "unavailable" as const, error: command.error, missing: command.missing} : undefined;
        const input = {ownerId, parsed, device: payload.result?.device, prepared, expectedDevice};
        const result = parsed.command === "device_start" ? await lifecycle.start(input) : parsed.command === "device_stop" ? await lifecycle.stop(input) : await lifecycle.delete(input);
        return renderBrokerSandboxLifecycle(result, publicContext, redactBrokerDeviceSecrets, providerFailureDetail);
    }
    if (parsed.command === "device_create") {
        const providerCommand = payload.result?.providerCommand;
        if (providerCommand && "error" in providerCommand) {
            return {
                status: 400,
                payload: {
                    ok: false,
                    error: providerCommand.error,
                    missing: providerCommand.missing || [],
                    plan: payload.result || null,
                },
            };
        }
        let execution: ProviderCommandResult = { mode: "noop", provider: "host-broker-state", status: 0, stdout: "", stderr: "" };
        if (providerCommand && providerCommand.mode !== "noop") {
            execution =
                normalized.commandRunner(providerCommand, {
                    timeoutMs: normalized.commandTimeoutMs,
                    outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
                });
            if (!commandSucceeded(execution)) {
                return {
                    status: 502,
                    payload: {
                        ok: false,
                        error: execution.typedCreateInvalidResult === true
                            ? "hyper-v-create-invalid-result"
                            : "provider-command-failed",
                        detail: providerFailureDetail(execution),
                        result: {
                            ...(payload.result
                                ? {
                                    ...payload.result,
                                    device: redactBrokerDeviceSecrets(payload.result.device),
                                }
                                : {}),
                            invoked: true,
                            dryRun: false,
                            execution: {
                                mode: execution.mode,
                                providerExecution: "executed",
                                mutatesHost: false,
                                ...({ command: execution }),
                            },
                        },
                    },
                };
            }
        }
        let persistedParsed = parsed;
        let sandboxDevice: Record<string, unknown> | undefined;
        if (parsed.backend === "windows-sandbox") {
            const outcome = await createBrokerWindowsSandboxCreate({
                createRecord: (input: CommandParamSuccess) => createOwnerDeviceRecord(ownerId, input) as Record<string, unknown>,
                claimDefinition: (device: Record<string, unknown>) => claimOwnerDevice(ownerId, parsed.stateKey, device, createOwnerDeviceUniqueFields(persistedParsed)),
                publishConfig: (input: CommandParamSuccess) => writeBrokerWindowsConfig(ownerId, parsed.deviceId, input.create || {}, normalized),
                removeMatchingClaim: (id: unknown, createdAt: unknown) => ownerRepository.removeMatchingClaim(ownerId, parsed.stateKey, id, createdAt),
            }).create(persistedParsed);
            if (outcome.kind === "claim-exception") {
                const { error, rollback } = outcome;
                const failure = ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
                return { ...failure, payload: { ...(failure.payload as Record<string, unknown>), rollback } };
            }
            if (outcome.kind === "claim-conflict") {
                const { claim, rollback } = outcome;
                return { status: rollback.ok ? 409 : 502, payload: {
                        ok: false, error: rollback.ok ? claim.error : "owner-device-conflict-rollback-failed", ownerId,
                        backend: parsed.backend, deviceId: parsed.deviceId, field: claim.field, value: claim.value,
                        existing: redactBrokerDeviceSecrets(claim.existing), rollback,
                    } };
            }
            if (outcome.kind === "config-failure") {
                const { error } = outcome;
                return { status: 500, payload: {
                        ok: false, error: "windows-sandbox-config-write-failed", ownerId,
                        backend: parsed.backend, deviceId: parsed.deviceId,
                        detail: error instanceof Error ? error.message : String(error),
                    } };
            }
            sandboxDevice = outcome.device;
        }
        const device = sandboxDevice || createOwnerDeviceRecord(ownerId, persistedParsed) as Record<string, unknown>;
        if (parsed.backend !== "windows-sandbox") {
            let claim;
            try {
                claim = claimOwnerDevice(ownerId, parsed.stateKey, device, createOwnerDeviceUniqueFields(persistedParsed));
            }
            catch (error) {
                const rollback = await rollbackProviderCreateAfterConflict(persistedParsed, device, null, providerCommand && !("error" in providerCommand) ? providerCommand : null, normalized, hyperVCleanupDeadlineAt);
                if (!rollback.ok) {
                    return {
                        status: 502,
                        payload: {
                            ok: false,
                            error: "owner-device-state-rollback-failed",
                            ownerId,
                            backend: parsed.backend,
                            deviceId: parsed.deviceId,
                            stateError: ownerDeviceStateErrorCode(error) || "owner-state-write-failed",
                            rollback,
                        },
                    };
                }
                const failure = ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
                return {
                    ...failure,
                    payload: { ...(failure.payload as Record<string, unknown>), rollback },
                };
            }
            if (!claim.ok) {
                const rollback = await rollbackProviderCreateAfterConflict(persistedParsed, device, claim.existing, providerCommand && !("error" in providerCommand) ? providerCommand : null, normalized, hyperVCleanupDeadlineAt);
                return {
                    status: rollback.ok ? 409 : 502,
                    payload: {
                        ok: false,
                        error: rollback.ok ? claim.error : "owner-device-conflict-rollback-failed",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                        field: claim.field,
                        value: claim.value,
                        existing: redactBrokerDeviceSecrets(claim.existing),
                        rollback,
                    },
                };
            }
        }
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ...(payload.result || {}),
                    device: redactBrokerDeviceSecrets(device),
                    invoked: true,
                    dryRun: false,
                    execution: {
                        mode: execution.mode === "noop" ? "state" : execution.mode,
                        providerExecution: execution.mode === "noop" ? "broker-state" : "executed",
                        mutatesHost: true,
                        ...(execution.mode === "noop" ? {} : { command: execution }),
                            },
                },
            },
        };
    }
    const physicalTeardown = (parsed.stateKey === "android-device" || parsed.stateKey === "ios-device")
        && (parsed.command === "device_stop" || parsed.command === "device_delete");
    if (physicalTeardown && !physicalLeaseGuard) {
        const record = payload.result?.device as Record<string, unknown>;
        return withOwnerPhysicalLeaseReleaseGuard(ownerId, parsed.stateKey, record, (guard) => {
            if (guard.preflight && guard.preflight.status !== 404) {
                const physicalLeaseCleanup = cleanupOwnerPhysicalLease(ownerId, guard);
                return {
                    status: physicalLeaseCleanup.status === 409 ? 409 : 502,
                    payload: {
                        ok: false,
                        error: "physical-lease-cleanup-failed",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                        result: {
                            ...(payload.result || {}),
                            physicalLeaseCleanup,
                            invoked: false,
                            dryRun: false,
                        },
                    },
                };
            }
            return lifecycleCommandInvokeUnlocked(ownerId, params, normalized, guard, hyperVDeadlineAt, hyperVCleanupDeadlineAt, parsed.deviceId);
        });
    }
    const physicalUse = (parsed.stateKey === "android-device" || parsed.stateKey === "ios-device")
        && parsed.command === "device_start";
    if (physicalUse) {
        const device = payload.result?.device;
        if (!device || typeof device !== "object" || Array.isArray(device)) {
            return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
        }
        const leaseFailure = refreshPhysicalDeviceLeaseForOperation(ownerId, {
            stateKey: parsed.stateKey,
            backend: parsed.backend,
            device: device as Record<string, unknown>,
        }, parsed.deviceId);
        if (leaseFailure)
            return leaseFailure;
    }
    let providerCommand = payload.result?.providerCommand;
    if (!providerCommand || "error" in providerCommand) {
        return {
            status: 400,
            payload: {
                ok: false,
                error: providerCommand?.error || "missing-provider-command",
                missing: providerCommand?.missing || [],
                plan: isHyperVBackend(parsed.backend)
                    ? redactHyperVResultSecrets(payload.result)
                    : payload.result
                        ? {
                            ...payload.result,
                            device: redactBrokerDeviceSecrets(payload.result.device),
                        }
                        : null,
            },
        };
    }
    let effectiveProviderCommand = providerCommand;
    const auxiliaryCleanup = parsed.command === "device_stop" || parsed.command === "device_delete"
        ? cleanupLifecycleAuxiliaryRuntime(ownerId, parsed, normalized, expectedDevice)
        : null;
    if (auxiliaryCleanup?.committed)
        expectedDevice = structuredClone(auxiliaryCleanup.device);
    if (auxiliaryCleanup?.result.ok === false) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "auxiliary-runtime-cleanup-failed",
                result: {
                    ...(isHyperVBackend(parsed.backend)
                        ? redactHyperVResultSecrets(payload.result)
                        : payload.result || {}),
                    device: isHyperVBackend(parsed.backend)
                        ? redactHyperVDeviceSecrets(auxiliaryCleanup.device)
                        : redactBrokerDeviceSecrets(auxiliaryCleanup.device),
                    auxiliaryCleanup: auxiliaryCleanup.result,
                    invoked: false,
                    dryRun: false,
                    execution: {
                        mode: "preflight",
                        providerExecution: "blocked",
                        mutatesHost: auxiliaryCleanup.result.changed === true
                            || auxiliaryCleanup.result.appium.cleared === true
                            || auxiliaryCleanup.result.recording.cleared === true
                            || auxiliaryCleanup.result.minimizeWatchdog.cleared === true,
                    },
                },
            },
        };
    }
    let physicalLeaseCleanup: ReturnType<typeof cleanupOwnerPhysicalLease> | null = null;
    let execution =
            isHyperVBackend(parsed.backend)
                ? await hyperVProviderCommandRunner(normalized, effectiveProviderCommand, {
                    timeoutMs: hyperVRemainingTimeout(hyperVDeadlineAt, 120000, normalized.hyperVMonotonicNow),
                    outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
                })
                : normalized.commandRunner(effectiveProviderCommand, {
                    timeoutMs: normalized.commandTimeoutMs,
                    outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
                });
    const hyperVProviderDeadlineExpired = isHyperVBackend(parsed.backend) && hyperVOperationDeadlineExpired(hyperVDeadlineAt, normalized.hyperVMonotonicNow);
    if (hyperVProviderDeadlineExpired) {
        return {
            status: 504,
            payload: { ok: false, error: "hyper-v-operation-deadline-exceeded", ownerId, backend: parsed.backend, deviceId: parsed.deviceId },
        };
    }
    let success = !hyperVProviderDeadlineExpired && (commandSucceeded(execution)
        || commandToleratesMissingMacosVmDelete(parsed, execution));
    if (success && isHyperVBackend(parsed.backend)) {
        const observation = parsed.command === "device_delete"
            ? parseHyperVDeleteObservation(execution.stdout || "")
            : parseHyperVVmObservation(execution.stdout || "");
        const expectedVmId = String(field(payload.result?.device, "vmId") || "").toLowerCase();
        const expectedVmName = field(payload.result?.device, "vmName");
        const expectedDiskPath = field(payload.result?.device, "diskPath");
        success = Boolean(observation
            && expectedVmId
            && observation.vmId === expectedVmId
            && observation.vmName === expectedVmName
            && (parsed.command !== "device_delete" || resolve(observation.diskPath || "") === resolve(expectedDiskPath || "")));
    }
    if (success && physicalTeardown) {
        physicalLeaseCleanup = cleanupOwnerPhysicalLease(ownerId, physicalLeaseGuard!);
        if (!physicalLeaseCleanup.ok) {
            return {
                status: physicalLeaseCleanup.status === 409 ? 409 : 502,
                payload: {
                    ok: false,
                    error: "physical-lease-cleanup-failed",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                    result: {
                        ...(payload.result || {}),
                        physicalLeaseCleanup,
                        invoked: true,
                        dryRun: false,
                        execution: {
                            mode: execution.mode,
                            providerExecution: "executed",
                            mutatesHost: auxiliaryCleanup?.result.changed === true,
                            command: execution,
                        },
                    },
                },
            };
        }
    }
    // Hyper-V stop/delete are handled before the generic lifecycle execution above.
    let updatedDevice: unknown;
    let publication: ReturnType<typeof transitionOwnerLifecycleDevice> | undefined;
    try {
        updatedDevice = success
            ? (publication = mutateDeviceAfterCommand(ownerId, parsed, expectedDevice)).device
            : publication ? publication.device : updatedDevice || payload.result?.device;
    }
    catch (error) {
        if (!physicalTeardown || !physicalLeaseGuard?.parsed || !physicalLeaseGuard.file || !physicalLeaseGuard.existing || physicalLeaseCleanup?.status !== 200)
            throw error;
        const leaseRollback = restorePhysicalBrokerLeaseRelease(ownerId, physicalLeaseGuard.parsed, physicalLeaseGuard.file, physicalLeaseGuard.existing);
        return {
            status: leaseRollback.ok ? 500 : 502,
            payload: {
                ok: false,
                error: leaseRollback.ok ? "owner-state-write-failed" : "physical-lease-rollback-failed",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                detail: "physical-device-state-transition-failed",
                result: {
                    ...(payload.result || {}),
                    device: redactBrokerDeviceSecrets(auxiliaryCleanup?.device || payload.result?.device),
                    physicalLeaseCleanup,
                    leaseRollback,
                    invoked: true,
                    dryRun: false,
                    execution: {
                        mode: execution.mode,
                        providerExecution: "executed",
                        mutatesHost: auxiliaryCleanup?.result.changed === true,
                        command: execution,
                    },
                },
            },
        };
    }
    return {
        status: publication && !publication.matched ? 409 : success ? 200 : 502,
        payload: {
            ok: success && (!publication || publication.matched),
            ...(publication && !publication.matched ? {
                error: "owner-device-state-conflict",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                found: publication.found,
                ...(!success ? { providerFailure: "provider-command-failed" } : {}),
            } : {}),
            ...(success || (publication && !publication.matched) ? {} : {
                error: "provider-command-failed",
                detail: isHyperVBackend(parsed.backend)
                    ? hyperVProviderDiagnosticCode(execution, "hyper-v-provider-command-failed") || "hyper-v-provider-command-failed"
                    : providerFailureDetail(execution),
            }),
            result: {
                ...(isHyperVBackend(parsed.backend)
                    ? redactHyperVResultSecrets(payload.result)
                    : (payload.result || {})),
                providerCommand: isHyperVBackend(parsed.backend)
                    ? {
                        mode: effectiveProviderCommand.mode,
                        provider: effectiveProviderCommand.provider,
                    }
                    :
                        effectiveProviderCommand,
                device: isHyperVBackend(parsed.backend)
                    ? redactHyperVDeviceSecrets(updatedDevice)
                    : redactBrokerDeviceSecrets(updatedDevice),
                ...(auxiliaryCleanup ? { auxiliaryCleanup: auxiliaryCleanup.result } : {}),
                ...(physicalLeaseCleanup ? { physicalLeaseCleanup } : {}),
                invoked: true,
                dryRun: false,
                execution: {
                    mode: execution.mode,
                    providerExecution: "executed",
                    // Containment force-stops the guest on a FAILED start, so deriving this from
                    // `success` alone reported mutatesHost:false for an operation whose entire
                    // purpose was to change the host. That is the same invisible-mutation the
                    // containment work exists to remove, restated in the response envelope.
                    mutatesHost: success,
                    command: isHyperVBackend(parsed.backend)
                        ? {
                            ...redactProviderCommandInput(execution, true, success
                                ? undefined
                                : "hyper-v-provider-command-failed"),
                                    }
                        : execution,
                },
            },
        },
    };
}












async function lifecycleHyperVCommandInvokeLocked(ownerId:string,params:unknown,parsed:CommandParamSuccess,normalized:NormalizedBrokerOptions,deadlineAt=Number.POSITIVE_INFINITY,cleanupDeadlineAt=deadlineAt):Promise<BrokerRpcResult>{
    if(parsed.command==="device_create"||parsed.command==="device_start"||parsed.command==="device_reboot")return renderHyperVCreateStart(await brokerHyperVCreateStartApplication(normalized).invoke(ownerId,params,{...parsed,command:parsed.command},deadlineAt,cleanupDeadlineAt));
    assertHyperVOperationDeadline(deadlineAt, normalized.hyperVMonotonicNow);
    if(parsed.command==="device_stop"||parsed.command==="device_delete")return renderHyperVStopDelete(await brokerHyperVStopDeleteApplication(normalized).invoke(ownerId,{...parsed,command:parsed.command},deadlineAt,cleanupDeadlineAt));
    if (parsed.command === "device_status") return renderBrokerDeviceStatusWithDiagnostics(await brokerDeviceStatusApplication(normalized).invoke(ownerId, { ...parsed, command: "device_status" }, params, deadlineAt), params);
    return lifecycleCommandInvokeUnlocked(ownerId, params, normalized, undefined, deadlineAt, cleanupDeadlineAt, parsed.deviceId);
}


async function lifecycleCommandInvokeDeviceLocked(ownerId: string, params: unknown, parsed: CommandParamSuccess, normalized: NormalizedBrokerOptions, hyperVDeadlineAt: number, hyperVCleanupDeadlineAt: number): Promise<BrokerRpcResult> {
    if (parsed.command === "device_status") return renderBrokerDeviceStatusWithDiagnostics(await brokerDeviceStatusApplication(normalized).invoke(ownerId, { ...parsed, command: "device_status" }, params, hyperVDeadlineAt), params);
    if (isHyperVBackend(parsed.backend)) {
        try {
            return await withSharedMutationLockAsync(
                brokerHyperVMutationLockPath(),
                () => lifecycleHyperVCommandInvokeLocked(ownerId, params, parsed, normalized, hyperVDeadlineAt, hyperVCleanupDeadlineAt),
                { waitMs: hyperVRemainingTimeout(hyperVDeadlineAt, DEVICE_BROKER_HYPER_V_HOST_LOCK_WAIT_MS, normalized.hyperVMonotonicNow), waitBudget: { remaining: () => hyperVDeadlineAt - normalized.hyperVMonotonicNow() }, staleMs: DEVICE_BROKER_HYPER_V_HOST_LOCK_STALE_MS },
            );
        } catch (error) {
            if (!isDeviceOperationLockTimeout(error)) throw error;
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "hyper-v-host-operation-lock-failed",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                    detail: hyperVBoundedErrorCode(
                        error,
                        "hyper-v-host-operation-lock-failed",
                    ),
                },
            };
        }
    }
    if (parsed.backend !== "android-emulator" || (parsed.command !== "device_create" && parsed.command !== "device_start")) {
        return await lifecycleCommandInvokeUnlocked(ownerId, params, normalized, undefined, hyperVDeadlineAt, hyperVCleanupDeadlineAt, parsed.deviceId);
    }
    try {
        return await withSharedMutationLockAsync(
            androidEmulatorPortAllocationLockFile(),
            async () => {
                const initialPlan = lifecycleCommandPlan(ownerId, params, normalized, false);
                if (initialPlan.status !== 200) return initialPlan;
                if (parsed.dryRun) return await lifecycleCommandInvokeUnlocked(ownerId, params, normalized, undefined, hyperVDeadlineAt, hyperVCleanupDeadlineAt, parsed.deviceId);
                if (parsed.command === "device_start") {
                    return await lifecycleCommandInvokeUnlocked(ownerId, params, normalized, undefined, hyperVDeadlineAt, hyperVCleanupDeadlineAt, parsed.deviceId);
                }
                const allocation = await resolveAndroidEmulatorCreatePortForInvoke(ownerId, parsed, normalized);
                if (!allocation.ok) {
                    return {
                        status: allocation.status,
                        payload: {
                            ok: false,
                            error: allocation.error,
                            ...(allocation.allowed ? { allowed: allocation.allowed } : {}),
                            ...(allocation.detail ? { detail: allocation.detail } : {}),
                            ownerId,
                            backend: parsed.backend,
                            deviceId: parsed.deviceId,
                        },
                    };
                }
                return await lifecycleCommandInvokeUnlocked(ownerId, {
                    ...(params as Record<string, unknown>),
                    port: allocation.port,
                }, normalized);
            },
            { waitMs: DEVICE_BROKER_ANDROID_PORT_LOCK_WAIT_MS, staleMs: DEVICE_BROKER_ANDROID_PORT_LOCK_STALE_MS },
        );
    } catch (error) {
        if (!isDeviceOperationLockTimeout(error)) throw error;
        return {
            status: 409,
            payload: {
                ok: false,
                error: "android-emulator-port-allocation-lock-failed",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                detail: error instanceof Error ? error.message : String(error),
            },
        };
    }
}

async function cleanupVirtualStopLocked(ownerId: string, target: { backend: string; stateKey: string; deviceId: string }, expected: Record<string, unknown>, normalized: NormalizedBrokerOptions): Promise<CleanupStopOutcome<ProviderCommandResult>> {
    const current = readOwnerDevices(ownerId, target.stateKey).find(device => cleanupRecord(device) && device.id === target.deviceId);
    if (!isDeepStrictEqual(current, expected)) return { attempted: false, ok: false, error: "owner-device-state-conflict", changed: false, stateConflict: true };
    const params = { backend: target.backend, deviceId: target.deviceId, command: "device_stop", force: true };
    const parsed = admitCommandParams(params);
    if (!parsed.ok) return { attempted: false, ok: false, error: parsed.error, changed: false };
    const cleanupObservation: NonNullable<NormalizedBrokerOptions["cleanupObservation"]> = { changed: false };
    const deadline = Math.min(normalized.cleanupDeadlineAt ?? Number.POSITIVE_INFINITY, normalized.hyperVMonotonicNow() + normalized.commandTimeoutMs);
    let response: BrokerRpcResult;
    const options: NormalizedBrokerOptions = { ...normalized, cleanupObservation, cleanupDeadlineAt: deadline,
        commandRunner: (command, settings) => {
            assertCleanupDeadline(options);
            return normalized.commandRunner(command, { ...settings, timeoutMs: Math.max(1, Math.floor(cleanupExitBudget(options, settings.timeoutMs))) });
        } };
    try {
        response = await lifecycleCommandInvokeDeviceLocked(ownerId, params, parsed, options, deadline, deadline);
    } catch (error) {
        if (!(error instanceof HyperVOperationDeadlineError) && !(error instanceof CleanupOperationDeadlineError)) throw error;
        response = { status: 504, payload: { ok: false, error: error instanceof CleanupOperationDeadlineError ? error.message : error.code } };
    }
    const payload = cleanupRecord(response.payload) ? response.payload : {};
    const result = cleanupRecord(payload.result) ? payload.result : {};
    const execution = cleanupRecord(result.execution) ? result.execution : {};
    const auxiliary = cleanupObservation.auxiliary;
    // Include recovery publications even when a later provider or snapshot step refuses.
    const facts = { changed: auxiliary?.committed === true || cleanupObservation.changed,
        ...(auxiliary ? { auxiliary: auxiliary.result } : {}),
        ...(payload.error === "owner-device-state-conflict" || auxiliary?.result.stateConflict ? { stateConflict: true } : {}) };
    const receipt = cleanupRecord(execution.command) ? execution.command as ProviderCommandResult : cleanupObservation.execution;
    if (!receipt)
        return { attempted: false, ok: false, error: typeof payload.error === "string" ? payload.error : "provider-stop-not-executed",
            ...(Array.isArray(payload.missing) ? { missing: payload.missing as string[] } : {}), ...facts };
    const native = receipt;
    return { attempted: true, ok: payload.ok === true,
        observation: { ok: payload.ok === true, operationKind: native.mode === "noop" ? "metadata-only" : "runtime-stop", receipt: native }, ...facts };
}

function macosCreateRequestOptions(params: unknown, normalized: NormalizedBrokerOptions): NormalizedBrokerOptions | BrokerRpcResult {
    if (normalized.macosCreateRemainingMs || !params || typeof params !== "object" || Array.isArray(params)) return normalized;
    const input = params as Record<string, unknown>;
    if (!isBrokerMacosTartImageCreate({...input, provider: optionalString(input, "provider"), image: optionalString(input, "image")})) return normalized;
    const duration = input.requestTimeoutMs;
    if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > BROKER_MACOS_TART_CREATE_TIMEOUT_MS)) {
        return {status: 400, payload: {ok: false, error: "invalid-macos-tart-create-timeout"}};
    }
    const now = normalized.hyperVMonotonicNow;
    const deadline = now() + (typeof duration === "number" ? duration : BROKER_MACOS_TART_CREATE_TIMEOUT_MS);
    const boundedDeadline = Math.min(deadline, normalized.cleanupDeadlineAt ?? Infinity);
    return {...normalized, cleanupDeadlineAt: boundedDeadline,
        macosCreateRemainingMs: () => Math.max(0, boundedDeadline - now())};
}

async function lifecycleCommandInvoke(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = admitCommandParams(params);
    if (!parsed.ok) return commandParamError(parsed);
    const macosCreate = isBrokerMacosTartImageCreate({...parsed, ...parsed.create});
    if (macosCreate) {
        const captured = macosCreateRequestOptions(params, normalized);
        if ("status" in captured) return captured;
        normalized = captured;
    }
    const macosStart = parsed.backend === "macos-vm" && parsed.command === "device_start" && !parsed.dryRun;
    if (macosStart && !normalized.macosStartRemainingMs) {
        const now = normalized.hyperVMonotonicNow;
        const allowance = Number.isFinite(parsed.bootTimeoutMs) ? Math.min(600000, Math.max(1000, Number(parsed.bootTimeoutMs))) : 300000;
        const deadline = Math.min(now() + allowance, normalized.cleanupDeadlineAt ?? Infinity);
        normalized = {...normalized, cleanupDeadlineAt: deadline, macosStartRemainingMs: () => Math.max(0, deadline - now())};
    }
    const hyperVCleanupDeadlineAt = isHyperVBackend(parsed.backend) && !parsed.dryRun
        ? normalized.hyperVMonotonicNow() + (parsed.command === "device_create"
            ? DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS
            : hyperVLifecycleCleanupTimeoutMs(parsed.backend, parsed.command, hyperVLifecycleOperationTimeoutMs(parsed)))
        : Number.POSITIVE_INFINITY;
    const hyperVDeadlineAt = hyperVProviderDeadlineAt(parsed.backend, parsed.command, hyperVCleanupDeadlineAt);
    const executor: BrokerExecutorDescriptor = isHyperVBackend(parsed.backend) && parsed.dryRun && parsed.command === "device_create"
        ? { acquisitionOwner: "specialized", workflow: () => lifecycleHyperVCommandInvokeLocked(ownerId, params, parsed, normalized) }
        : {
            acquisitionOwner: "broker", stateKey: parsed.stateKey, backend: parsed.backend,
            waitBudget: macosCreate ? {remaining: normalized.macosCreateRemainingMs!} : macosStart ? {remaining: normalized.macosStartRemainingMs!} : isHyperVBackend(parsed.backend) ? { remaining: () => hyperVDeadlineAt - normalized.hyperVMonotonicNow() } : undefined,
            workflow: () => lifecycleCommandInvokeDeviceLocked(ownerId, params, parsed, normalized, hyperVDeadlineAt, hyperVCleanupDeadlineAt),
        };
    if (executor.acquisitionOwner !== "broker") return invokeBrokerExecutor(ownerId, parsed.deviceId, executor);
    try {
        return await invokeBrokerExecutor(ownerId, parsed.deviceId, executor);
    } catch (error) {
        if (macosCreate && (error instanceof CleanupOperationDeadlineError || isDeviceOperationLockTimeout(error) && !(normalized.macosCreateRemainingMs!() >= 1))) {
            return {status: 504, payload: {ok: false, error: "macos-tart-create-budget-exhausted", ownerId, backend: parsed.backend, deviceId: parsed.deviceId}};
        }
        if (macosStart && (error instanceof CleanupOperationDeadlineError || isDeviceOperationLockTimeout(error) && !(normalized.macosStartRemainingMs!() >= 1))) {
            return {status: 504, payload: {ok: false, error: "macos-start-budget-exhausted", ownerId, backend: parsed.backend, deviceId: parsed.deviceId}};
        }
        if (error instanceof HyperVOperationDeadlineError) {
            return {
                status: 504,
                payload: {
                    ok: false,
                    error: error.code,
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                },
            };
        }
        if (!isDeviceOperationLockTimeout(error)) throw error;
        return {
            status: 409,
            payload: {
                ok: false,
                error: "device-operation-lock-failed",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                detail: error instanceof Error ? error.message : String(error),
            },
        };
    }
}

function ownerDeviceNotFound(ownerId: string, backend: string, deviceId: string) {
    return {
        status: 404,
        payload: {
            ok: false,
            error: "owner-device-not-found",
            ownerId,
            backend,
            deviceId,
        },
    };
}

function appiumSessionStatus(ownerId: string, params: unknown) {
    const parsed = validateAppiumParams(params, "status");
    if (!parsed.ok) return renderBrokerAppium(appiumParamError(parsed));
    const observation = observeAppium.status(ownerId, parsed);
    if (observation.kind === "read-failed") return ownerDeviceStateFailure(observation.error, { backend: parsed.backend, stateKey: parsed.stateKey });
    if (observation.kind === "not-found") return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
    return { status: 200, payload: { ok: true, result: { ...observation.value, authority: "host-broker" } } };
}

function appiumSessionList(ownerId: string, params: unknown) {
    const parsed = validateAppiumListParams(params);
    if (!parsed.ok) {
        const {status, ...payload} = parsed;
        return {status, payload};
    }
    const observation = observeAppium.list(ownerId, parsed);
    if (observation.kind === "read-failed") return ownerDeviceStateFailure(observation.error, { backend: parsed.backend, stateKey: parsed.stateKey });
    const { sessions, ...value } = observation.value;
    return { status: 200, payload: { ok: true, result: { ...value, authority: "host-broker", sessions } } };
}

const observeAppium = createAppiumObservations({ read: (ownerId, stateKey) => readOwnerDevices(ownerId, stateKey) });

function transitionOwnerAppiumRuntime(
    ownerId: string,
    stateKey: string,
    deviceId: string,
    expected: unknown,
    replacement: Record<string, unknown> | null,
) {
    return ownerRepository.transitionAppium(ownerId, stateKey, deviceId, expected, replacement);
}

type AppiumRequestBudget = { remaining(): number };

type NativeAppiumRuntime = {
    kind: "injected" | "managed";
    packageRoot: string;
    runtimeRoot: string;
    sourcePackage: string;
    sourceLock: string;
    executable: string;
    entry: string;
    markerFile: string;
    installExecutable: string;
};
function nativeAppiumStateFailure(error: unknown, target: {
    backend: string;
    stateKey: string;
}): BrokerAppiumRefusal {
    const code = ownerDeviceStateErrorCode(error);
    if (!code)
        throw error;
    return { kind: "refused", reason: "state-read-failed", error: code, ...target };
}
function brokerAppiumApplication(normalized: NormalizedBrokerOptions) {
    const observation = (receipt: ProviderCommandResult) => ({ ok: commandSucceeded(receipt), pid: receipt.pid, processIdentity: receipt.processIdentity, receipt: new NativeBrokerExecutionReceipt(receipt) });
    return createBrokerAppiumApplication<NativeAppiumRuntime>({
        commandTimeoutMs: normalized.commandTimeoutMs, usesDefaultCommandRunner: normalized.usesDefaultCommandRunner,
        strictAppiumPortOwnership: normalized.strictAppiumPortOwnership,
        readDevices: readOwnerDevices, stateFailure: nativeAppiumStateFailure,
        notFound: (ownerId, backend, deviceId) => ({ kind: "refused", reason: "missing", error: "owner-device-not-found", ownerId, backend, deviceId }),
        publish: transitionOwnerAppiumRuntime, withDeviceOperation: withOwnerDeviceOperation,
        heartbeat: (owner, target, id, budget) => { const admission = nativePhysicalAdmission(owner, target, id, budget); return admission.kind === "admitted" ? null : { kind: "refused", reason: "conflict", error: "physical-device-not-attached", ownerId: owner, backend: target.backend, deviceId: id, ...(admission.failure ? { leaseError: admission.failure.error } : {}), remedy: "attach the physical device before using host-backed device tools" }; },
        isLockTimeout: isDeviceOperationLockTimeout,
        lockFailure: (ownerId, backend, deviceId, _error) => ({ kind: "refused", reason: "conflict", error: "device-operation-lock-failed", ownerId, backend, deviceId, detail: "device-operation-lock-failed" }),
        isProcessIdentityCurrent: (identity, pid) => inspectDeviceRuntimeProcessIdentity(identity, pid).status === "match",
        verifyListener: (appium, remainingMs) => { const receipt = verifyBrokerOwnedAppiumListener(appium, normalized, remainingMs); return receipt.ok ? {ok: true, serverUrl: receipt.serverUrl, ...(typeof receipt.port === "number" ? {port: receipt.port} : {}), receipt: new NativeAppiumVerificationReceipt(receipt)} : {ok: false, error: receipt.error, receipt: new NativeAppiumVerificationReceipt(receipt)}; },
        terminateRuntime: async (appium) => { const receipt = await terminateBrokerOwnedAppiumAndWait(appium, normalized); return {ok: receipt.ok, ...("error" in receipt && typeof receipt.error === "string" ? {error: receipt.error} : {}), ...("stale" in receipt ? {stale: receipt.stale === true} : {}), ...("attempted" in receipt ? {attempted: receipt.attempted === true} : {}), receipt: new NativeAppiumTerminationReceipt(receipt)}; },
        terminatePortListener: port => { const receipt = terminateManagedAppiumPortListener(port, normalized); return {ok: receipt.ok, ...("error" in receipt && typeof receipt.error === "string" ? {error: receipt.error} : {}), ...("stale" in receipt ? {stale: receipt.stale === true} : {}), ...("attempted" in receipt ? {attempted: receipt.attempted === true} : {}), receipt: new NativeAppiumTerminationReceipt(receipt)}; },
        portListener: port => normalized.portProcessResolver(port, normalized.platform),
        portSeed: (ownerId, backend, deviceId) => createHash("sha256").update(`${ownerId}:${backend}:${deviceId}:appium`).digest().readUInt16BE(0),
        resolveIosTarget: (owner, device) => resolveBrokerOwnedIosSimulatorTarget(owner, device, normalized),
        status: async (endpoint, timeoutMs) => {
            const response = await fetchAppiumJson(`${endpoint}/status`, {method: "GET", timeoutMs});
            const body = response.body as {value?: {ready?: unknown}} | null;
            return {ok: response.ok, ready: body?.value?.ready !== false, receipt: new NativeAppiumResponseReceipt(response)};
        },
        inspectSession: async (endpoint, sessionId, timeoutMs) => {
            const response = await fetchAppiumJson(`${endpoint}/session/${encodeURIComponent(sessionId)}`, {method: "GET", timeoutMs});
            return {ok: response.ok, receipt: new NativeAppiumResponseReceipt(response)};
        },
        createSession: async (endpoint, capabilities, timeoutMs) => {
            const response = await fetchAppiumJson(`${endpoint}/session`, {method: "POST", body: {capabilities: {alwaysMatch: capabilities}}, timeoutMs});
            const body = response.body as {value?: {sessionId?: unknown}; sessionId?: unknown} | null;
            const sessionId = typeof body?.value?.sessionId === "string" ? body.value.sessionId
                : typeof body?.sessionId === "string" ? body.sessionId : null;
            const text = response.ok ? "" : JSON.stringify(response.body || {}).toLowerCase();
            return {ok: response.ok, sessionId, instrumentationInitializationFailed: text.includes("instrumentation process cannot be initialized")
                || text.includes("uiautomator2 server cannot be started"), receipt: new NativeAppiumResponseReceipt(response)};
        },
        deleteSession: async (endpoint, sessionId, timeoutMs) => {
            const response = await fetchAppiumJson(`${endpoint}/session/${encodeURIComponent(sessionId)}`, {method: "DELETE", timeoutMs});
            return {ok: response.ok, receipt: new NativeAppiumResponseReceipt(response)};
        },
        sessionCommand: async (endpoint, sessionId, request, timeoutMs) => {
            const response = await fetchAppiumJson(`${endpoint}/session/${encodeURIComponent(sessionId)}${request.path}`, {
                method: request.method, body: request.method === "GET" ? undefined : request.body, timeoutMs,
            });
            return {ok: response.ok, receipt: new NativeAppiumResponseReceipt(response)};
        },
        captureRuntime: () => {
            const packageRoot = packageRootForBroker();
            const runtimeRoot = brokerAppiumRuntimeRoot();
            const kind = normalized.providerPaths.appium ? "injected" : "managed";
            return { kind, handle: { kind, packageRoot, runtimeRoot, installExecutable: "", sourcePackage: join(packageRoot, "appium-runtime", "package.json"), sourceLock: join(packageRoot, "appium-runtime", "package-lock.json"),
                    executable: normalized.providerPaths.appium || brokerAppiumRuntimeExecutable(normalized), entry: brokerAppiumRuntimeEntry(), markerFile: join(runtimeRoot, ".ccc-runtime.json") } };
        },
        runtimeReceipt: runtime => new NativeAppiumRuntimeReceipt(runtime),
        launchServer: async (runtime, request) => {
            const remainingMs = normalized.usesDefaultCommandRunner ? captureBrokerNativeRemainingMs(() => request.timeoutMs) : undefined;
            const args = ["server", "--port", String(request.port), "--base-path", "/"];
            if (request.backend.startsWith("android"))
                args.push("--allow-insecure", "uiautomator2:adb_shell");
            const command: ProviderCommand = { mode: "detached", provider: "appium", executable: runtime.kind === "injected" ? runtime.executable : process.execPath,
                args: runtime.kind === "injected" ? args : [runtime.entry, ...args], env: appiumCommandEnv(request.backend, normalized), cwd: runtime.runtimeRoot };
            return observation(normalized.usesDefaultCommandRunner ? await startDetachedProviderCommand(command, normalized, "Appium server", remainingMs)
                : normalized.commandRunner(command, { timeoutMs: request.timeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT }));
        },
        installAvailable: runtime => { runtime.installExecutable = resolveExecutablePath(normalized.platform === "win32" ? "npm.cmd" : "npm") || resolveExecutablePath("npm") || ""; return Boolean(runtime.installExecutable); },
        installRuntime: (runtime, timeoutMs) => observation(normalized.commandRunner({ mode: "exec", provider: "npm-appium-runtime",
            executable: runtime.installExecutable,
            args: ["ci", "--prefix", runtime.runtimeRoot, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"] }, { timeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT })),
        instrumentationAvailable: () => Boolean(providerExecutable("adb", normalized)),
        resetInstrumentation: (serial, step) => {
            const commands: Record<BrokerAppiumInstrumentationStep, string[]> = { "force-stop-server": ["shell", "am", "force-stop", "io.appium.uiautomator2.server"], "force-stop-test": ["shell", "am", "force-stop", "io.appium.uiautomator2.server.test"], "uninstall-server": ["uninstall", "io.appium.uiautomator2.server"], "uninstall-test": ["uninstall", "io.appium.uiautomator2.server.test"], "uninstall-settings": ["uninstall", "io.appium.settings"] };
            return observation(normalized.commandRunner({ mode: "exec", provider: "adb-appium-recovery", executable: providerExecutable("adb", normalized) || "adb", args: ["-s", serial, ...commands[step]] }, { timeoutMs: 30000, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT }));
        },
        instrumentationReceipt: serial => new NativeAppiumInstrumentationReceipt({ adb: providerExecutable("adb", normalized), serial }),
        readManifest: (runtime, kind) => {
            const file = kind === "package" ? runtime.sourcePackage : runtime.sourceLock;
            assertDeviceLabPathWithinRoot(runtime.packageRoot, file, kind === "package" ? "appium-runtime-package" : "appium-runtime-lock");
            return readDeviceLabTextFile(file, kind === "package" ? "appium-runtime-package" : "appium-runtime-lock", kind === "package" ? DEVICE_BROKER_APPIUM_PACKAGE_MANIFEST_LIMIT_BYTES : DEVICE_BROKER_APPIUM_LOCK_MANIFEST_LIMIT_BYTES);
        },
        stateErrorCode: error => deviceLabStateFileErrorCode(error) || null,
        isMissingFile: error => error !== null && (typeof error === "object" || typeof error === "function") && "code" in error && error.code === "ENOENT",
        ensureRuntimeDirectory: _runtime => { ensureBrokerAppiumRuntimeDirectory(); return undefined; },
        inspectRuntimeDirectory: _runtime => inspectBrokerAppiumRuntimeDirectory(), inspectNodeModules: _runtime => inspectBrokerAppiumNodeModulesDirectory(),
        entryIsValid: runtime => brokerAppiumRuntimeEntryIsValid(runtime.entry),
        readMarker: runtime => readDeviceLabStateFile(runtime.markerFile, value => value, "appium-runtime-marker", DEVICE_BROKER_APPIUM_RUNTIME_MARKER_LIMIT_BYTES),
        writeManifest: (runtime, kind, text) => { writeFileAtomically(join(runtime.runtimeRoot, kind === "package" ? "package.json" : "package-lock.json"), text); return undefined; },
        removeMarker: runtime => { unlinkSync(runtime.markerFile); return undefined; },
        writeMarker: (runtime, marker) => { writeJsonFileAtomically(runtime.markerFile, { ...marker, packageRoot: runtime.packageRoot }); return undefined; },
        manifestDigest: (packageText, lockText) => createHash("sha256").update(packageText).update(lockText).digest("hex"),
        withInstallLock: (operation, options) => withSharedMutationLock(brokerAppiumRuntimeInstallLockFile(), operation, options),
        timestamp: () => new Date().toISOString(), now: Date.now, monotonicNow: () => performance.now(), runtimeId: () => randomBytes(16).toString("hex"), sleep,
    });
}

async function handleBrokerRpcUnsafe(ownerId: string, body: unknown, normalized: NormalizedBrokerOptions, startedAt: string): Promise<BrokerRpcResult> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { status: 400, payload: { ok: false, error: "invalid-rpc-body" } };
    }
    const rpc = body as { method?: unknown; params?: unknown; ownerId?: unknown };
    const method = typeof rpc.method === "string" ? rpc.method : "";
    if (rpc.ownerId !== undefined && rpc.ownerId !== ownerId) {
        return { status: 403, payload: { ok: false, error: "owner-mismatch", ownerId } };
    }
    if (!method) return { status: 400, payload: { ok: false, error: "missing-method" } };
    if (LIFECYCLE_METHOD_RE.test(method)) {
        return {
            status: 501,
            payload: {
                ok: false,
                error: "method-not-implemented",
                method,
                deferred: "mutating backend command proxy is intentionally not implemented in this broker transport slice",
            },
        };
    }
    if (method === "broker.status") {
        return { status: 200, payload: { ok: true, result: deviceBrokerStatus({ ...normalized, startedAt, ownerId }) } };
    }
    if (method === "broker.service.manager") {
        const params = rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params) ? rpc.params as { action?: unknown; dryRun?: unknown; host?: unknown; port?: unknown } : {};
        const action = typeof params.action === "string" ? params.action : "status";
        const result = deviceBrokerService(action, {
            ...normalized,
            host: typeof params.host === "string" ? params.host : normalized.host,
            port: typeof params.port === "number" ? params.port : normalized.port,
            dryRun: params.dryRun === true,
            ownerId,
        });
        const error = "error" in result ? result.error : "";
        const status = result.ok
            ? 200
            : error === "service-manager-unsupported"
                ? 501
                : 400;
        return { status, payload: { ok: result.ok, ...(result.ok ? {} : { error: "service-manager-failed" }), result } };
    }
    if (method === "broker.inventory") {
        return { status: 200, payload: { ok: true, result: ownerInventory(ownerId, true) } };
    }
    if (method === "broker.backends") {
        return { status: 200, payload: { ok: true, result: await hostBackends(ownerId, normalized) } };
    }
    if (method === "broker.echo") {
        return { status: 200, payload: { ok: true, result: { ownerId, params: rpc.params ?? null } } };
    }
    if (method === "broker.cleanup.owner") return cleanupOwnerRuntime(ownerId, rpc.params, normalized);
    if (method === "broker.lease.claim") return claimPhysicalLease(ownerId, rpc.params);
    if (method === "broker.lease.list") return listPhysicalBrokerLeases(ownerId, rpc.params);
    if (method === "broker.lease.heartbeat") return heartbeatPhysicalBrokerLease(ownerId, rpc.params);
    if (method === "broker.lease.prune") return prunePhysicalBrokerLeases(ownerId, rpc.params);
    if (method === "broker.lease.release") return releasePhysicalBrokerLease(ownerId, rpc.params);
    if (method === "broker.physical.attach") return withPhysicalDeviceOperation(ownerId, rpc.params, () => attachPhysicalDevice(ownerId, rpc.params, normalized));
    if (method === "broker.physical.detach") return withPhysicalDeviceOperation(ownerId, rpc.params, () => detachPhysicalDevice(ownerId, rpc.params, normalized));
    if (method === "broker.physical.list") return listAttachedPhysicalDevices(ownerId, rpc.params, normalized);
    if (method === "broker.apple.trust") return appleTrustStatus(ownerId, rpc.params, normalized);
    if (method === "broker.command.plan") return lifecycleCommandPlan(ownerId, rpc.params, normalized);
    if (method === "broker.command.invoke") return lifecycleCommandInvoke(ownerId, rpc.params, normalized);
    if (method === "broker.device.tool.invoke") return invokeDeviceTool(ownerId, rpc.params, normalized);
    if (method === "broker.appium.status") return appiumSessionStatus(ownerId, rpc.params);
    if (method === "broker.appium.list") return appiumSessionList(ownerId, rpc.params);
    if (method === "broker.appium.record") return renderBrokerAppium(await brokerAppiumApplication(normalized).record(ownerId, rpc.params));
    if (method === "broker.appium.clear") return renderBrokerAppium(await brokerAppiumApplication(normalized).clear(ownerId, rpc.params));
    if (method === "broker.appium.start") return renderBrokerAppium(await brokerAppiumApplication(normalized).start(ownerId, rpc.params));
    if (method === "broker.appium.stop") return renderBrokerAppium(await brokerAppiumApplication(normalized).stop(ownerId, rpc.params));
    if (method === "broker.appium.session.ensure") return renderBrokerAppium(await brokerAppiumApplication(normalized).ensureSession(ownerId, rpc.params));
    if (method === "broker.appium.session.delete") return renderBrokerAppium(await brokerAppiumApplication(normalized).deleteSession(ownerId, rpc.params));
    if (method === "broker.appium.request") return renderBrokerAppium(await brokerAppiumApplication(normalized).request(ownerId, rpc.params));
    return { status: 404, payload: { ok: false, error: "unknown-method", method } };
}

async function handleBrokerRpc(ownerId: string, body: unknown, normalized: NormalizedBrokerOptions, startedAt: string): Promise<BrokerRpcResult> {
    try {
        return await handleBrokerRpcUnsafe(ownerId, body, normalized, startedAt);
    } catch (error) {
        if (ownerDeviceStateErrorCode(error)) return ownerDeviceStateFailure(error);
        const stateError = deviceLabStateFileErrorCode(error);
        if (stateError) {
            return {
                status: stateError.endsWith("-file-too-large") ? 413 : stateError.endsWith("-state-read-failed") ? 503 : 409,
                payload: { ok: false, error: stateError },
            };
        }
        throw error;
    }
}

function authorizeBrokerRpc(
    req: IncomingMessage,
    ownerId: string,
    body: unknown,
    startedAt: string,
): { ok: true } | { ok: false; status: number; error: string } {
    const token = req.headers["x-ccc-device-token"];
    const expected = existingDeviceBrokerOwnerToken(ownerId);
    if (!expected) {
        return { ok: false, status: 401, error: "invalid-owner-token" };
    }
    if (typeof token === "string") {
        const actualBytes = Buffer.from(token);
        const expectedBytes = Buffer.from(expected);
        if (actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)) {
            return { ok: true };
        }
    }
    const signature = req.headers["x-ccc-device-auth"];
    const timestamp = req.headers["x-ccc-device-auth-timestamp"];
    const nonce = req.headers["x-ccc-device-auth-nonce"];
    const claimedStartedAt = req.headers["x-ccc-device-broker-started-at"];
    const claimedStartToken = req.headers["x-ccc-device-broker-start-token"];
    const processStartToken = readDeviceRuntimeProcessStartToken(process.pid);
    const timestampMs = typeof timestamp === "string" ? Number(timestamp) : Number.NaN;
    const now = Date.now();
    if (typeof signature !== "string"
        || !/^[a-f0-9]{64}$/.test(signature)
        || !Number.isFinite(timestampMs)
        || Math.abs(now - timestampMs) > 60_000
        || typeof nonce !== "string"
        || !/^[a-f0-9]{32}$/.test(nonce)
        || claimedStartedAt !== startedAt
        || typeof claimedStartToken !== "string"
        || !processStartToken
        || claimedStartToken !== processStartToken) {
        return { ok: false, status: 401, error: "invalid-owner-token" };
    }
    const bodyHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const payload = ["v1", ownerId, String(timestamp), nonce, startedAt, processStartToken, bodyHash].join("\n");
    const expectedSignature = createHmac("sha256", expected).update(payload).digest("hex");
    const actualBytes = Buffer.from(signature, "hex");
    const expectedBytes = Buffer.from(expectedSignature, "hex");
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
        return { ok: false, status: 401, error: "invalid-owner-token" };
    }
    for (const [key, expiresAt] of brokerAuthNonces) {
        if (now > expiresAt) brokerAuthNonces.delete(key);
    }
    const nonceKey = `${ownerId}:${nonce}`;
    if (brokerAuthNonces.has(nonceKey)) return { ok: false, status: 409, error: "broker-auth-replay" };
    brokerAuthNonces.set(nonceKey, timestampMs + 60_000);
    return { ok: true };
}

function brokerRpcMutatesOwnerState(body: unknown): boolean {
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const rpc = body as { method?: unknown; params?: unknown };
    if (typeof rpc.method !== "string") return false;
    if (DEVICE_BROKER_MUTATING_RPC_METHODS.has(rpc.method)) return true;
    if (rpc.method !== "broker.device.tool.invoke") return false;
    const params = rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params)
        ? rpc.params as { tool?: unknown; backend?: unknown }
        : {};
    if (params.backend === undefined || params.backend === null || params.backend === "windows-vm" || params.backend === "linux-vm") return true;
    return typeof params.tool !== "string"
        || !DEVICE_BROKER_READ_ONLY_TOOL_METHODS.has(params.tool);
}

async function serializeBrokerOwnerMutation(ownerId: string, task: () => Promise<BrokerRpcResult>): Promise<BrokerRpcResult> {
    const previous = brokerOwnerMutationTails.get(ownerId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    brokerOwnerMutationTails.set(ownerId, current);
    await previous;
    try {
        return await task();
    } finally {
        release();
        if (brokerOwnerMutationTails.get(ownerId) === current) brokerOwnerMutationTails.delete(ownerId);
    }
}

export function createDeviceBrokerServer(options: DeviceBrokerOptions = {}): Server {
    const normalized = normalizeBrokerOptions(options);
    const startedAt = normalized.startedAt;
    const launchOwner = registerDeviceBrokerOwner(normalized.cwd, normalized.profile, options.ownerId);
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        try {
            const url = new URL(req.url || "/", `http://${req.headers.host || `${normalized.host}:${normalized.port}`}`);
            if (url.pathname === "/health") {
                if (req.method !== "GET") {
                    writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
                    return;
                }
                writeJson(res, 200, {
                    ok: true,
                    name: DEVICE_BROKER_NAME,
                    mode: "host-broker-daemon",
                    uptimeMs: Date.now() - Date.parse(startedAt),
                });
                return;
            }
            if (url.pathname === "/status") {
                if (req.method !== "GET") {
                    writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
                    return;
                }
                const address = server.address();
                const activePort = address && typeof address === "object" ? address.port : normalized.port;
                writeJson(res, 200, {
                    ok: true,
                    broker: deviceBrokerStatus({ ...normalized, port: activePort, startedAt }),
                });
                return;
            }
            if (url.pathname === "/v1/owner/resolve") {
                if (req.method !== "POST") {
                    writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST" });
                    return;
                }
                const body = await readRequestJson(req, DEVICE_BROKER_RPC_BODY_LIMIT, normalized.requestBodyTimeoutMs);
                if (!body.ok) {
                    writeJson(res, body.status, { ok: false, error: body.error }, body.error === "request-body-timeout" ? { connection: "close" } : {});
                    return;
                }
                const result = renderBrokerOwnerResolution(brokerOwners.resolve(body.body));
                writeJson(res, result.status, result.payload);
                return;
            }
            const ownerRpcMatch = /^\/v1\/owners\/([^/]+)\/rpc$/.exec(url.pathname);
            if (ownerRpcMatch) {
                if (req.method !== "POST") {
                    writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST" });
                    return;
                }
                const ownerId = decodeURIComponent(ownerRpcMatch[1]);
                if (!/^[a-f0-9]{16}$/.test(ownerId)) {
                    writeJson(res, 400, { ok: false, error: "invalid-owner-id" });
                    return;
                }
                if (!existingDeviceBrokerOwnerToken(ownerId)) {
                    writeJson(res, 401, { ok: false, error: "invalid-owner-token" });
                    return;
                }
                let ownerRegistration: DeviceBrokerOwnerRegistration | null;
                try {
                    ownerRegistration = ownerId === launchOwner.ownerId
                        ? launchOwner
                        : readDeviceBrokerOwnerRegistration(ownerId);
                } catch {
                    writeJson(res, 409, { ok: false, error: "project-owner-registration-invalid" });
                    return;
                }
                if (!ownerRegistration) {
                    writeJson(res, 404, { ok: false, error: "project-owner-unavailable" });
                    return;
                }
                const ownerNormalized: NormalizedBrokerOptions = {
                    ...normalized,
                    cwd: ownerRegistration.hostProjectPath,
                    profile: ownerRegistration.profile ?? undefined,
                };
                const body = await readRequestJson(req, DEVICE_BROKER_RPC_BODY_LIMIT, normalized.requestBodyTimeoutMs);
                if (!body.ok) {
                    writeJson(res, body.status, { ok: false, error: body.error }, body.error === "request-body-timeout" ? { connection: "close" } : {});
                    return;
                }
                const auth = authorizeBrokerRpc(req, ownerId, body.body, startedAt);
                if (!auth.ok) {
                    writeJson(res, auth.status, { ok: false, error: auth.error });
                    return;
                }
                const rpc = body.body && typeof body.body === "object" && !Array.isArray(body.body)
                    ? body.body as {method?: unknown; params?: unknown} : null;
                const requestNormalized = rpc?.method === "broker.command.invoke"
                    ? macosCreateRequestOptions(rpc.params, ownerNormalized) : ownerNormalized;
                if ("status" in requestNormalized) {
                    writeJson(res, requestNormalized.status, requestNormalized.payload);
                    return;
                }
                const dispatch = () => requestNormalized.macosCreateRemainingMs && !(requestNormalized.macosCreateRemainingMs() >= 1)
                    ? Promise.resolve({status: 504, payload: {ok: false, error: "macos-tart-create-budget-exhausted"}})
                    : handleBrokerRpc(ownerId, body.body, requestNormalized, startedAt);
                const result = brokerRpcMutatesOwnerState(body.body)
                    ? await serializeBrokerOwnerMutation(ownerId, dispatch)
                    : await dispatch();
                writeJson(res, result.status, result.payload);
                return;
            }
            if (req.method !== "GET") {
                writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
                return;
            }
            writeJson(res, 404, { ok: false, error: "not-found", path: url.pathname });
        } catch {
            if (!res.headersSent) {
                writeJson(res, 500, { ok: false, error: "broker-internal-error" });
            } else if (!res.writableEnded) {
                res.destroy();
            }
        }
    });
    server.once("close", stopAllBrokerPhysicalLeaseHeartbeats);
    // A reused PowerShell session outliving its broker holds a loaded Hyper-V module and a host
    // handle, which is worse than paying startup again. Tied to the same close event, but reference
    // counted: the session pool is process wide, and one server closing must not kill a child a
    // second server in the same process is mid-request on.
    server.once("close", retainBrokerHyperVWindowsSessions());
    return server;
}

export function formatDeviceBrokerStatus(options: DeviceBrokerOptions = {}, verbose = false): string {
    const status = deviceBrokerStatus(options);
    if (!verbose) return `Broker: not checked\n${status.url}\n`;
    const containerContext = process.env.container === "docker";
    const wiringIncomplete = containerContext
        ? status.state.rootExists !== true
            || status.containerContract.deviceStateMounted !== true
        : status.state.rootExists !== true
            || status.containerContract.deviceStateMounted !== true;
    const lines = [
        "=== CCC Device Broker ===",
        "",
        `name: ${status.name}`,
        `mode: ${status.mode}`,
        `host: ${status.host}`,
        `port: ${status.port}`,
        `url: ${status.url}`,
        `owner: ${status.ownerId}`,
        `cliProcessPid: ${status.process.pid}`,
        `state: ${status.state.root}`,
        `stateExists: ${status.state.rootExists}`,
        `runtimeFile: ${status.runtime.file}`,
        `runtimePresent: ${status.runtime.present}`,
        `ownerResolution: ${status.containerContract.ownerResolution}`,
        `environmentRequired: ${status.containerContract.environmentRequired}`,
        `deviceStateMounted: ${status.containerContract.deviceStateMounted}`,
        `startup: ${status.startupPolicy}`,
        `hostSupervision: status-only ${status.serviceManager.manager} diagnostics (${status.serviceManager.supported ? "available" : "unavailable"})`,
        `protocolVersion: ${status.protocolVersion}`,
    ];
    if (wiringIncomplete) {
        lines.push(
            "warning: device-lab container wiring is incomplete; the host-backed device state mount is unavailable from this container.",
            "remedy: restart or recreate ccc from the host so the project container has /home/ccc/.ccc/devices mounted.",
        );
    }
    return `${lines.join("\n")}\n`;
}

export function parseBrokerServeArgs(args: string[]): { host: string; port: number } {
    let host = DEVICE_BROKER_DEFAULT_HOST;
    const defaultPort = configuredDeviceBrokerPort() ?? DEVICE_BROKER_DEFAULT_PORT;
    let port = defaultPort;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--host" && args[i + 1]) {
            host = args[i + 1];
            i += 1;
        } else if (args[i] === "--port" && args[i + 1]) {
            port = Number(args[i + 1]);
            i += 1;
        }
    }
    return { host, port: Number.isInteger(port) ? port : defaultPort };
}

export function parseBrokerServiceArgs(args: string[]): { action: string; host: string; port: number; dryRun: boolean } {
    let action = "status";
    let host = DEVICE_BROKER_DEFAULT_HOST;
    const defaultPort = configuredDeviceBrokerPort() ?? DEVICE_BROKER_DEFAULT_PORT;
    let port = defaultPort;
    let dryRun = false;
    let actionSeen = false;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--dry-run" || args[i] === "--plan") {
            dryRun = true;
        } else if (args[i] === "--host" && args[i + 1]) {
            host = args[i + 1];
            i += 1;
        } else if (args[i] === "--port" && args[i + 1]) {
            port = Number(args[i + 1]);
            i += 1;
        } else if (!args[i].startsWith("--") && !actionSeen) {
            action = args[i];
            actionSeen = true;
        }
    }
    return { action, host, port: Number.isInteger(port) ? port : defaultPort, dryRun };
}

export function formatDeviceBrokerService(result: ReturnType<typeof deviceBrokerService>): string {
    const service = "service" in result ? result.service : null;
    const lines = [
        "=== CCC Device Broker Service ===",
        "",
        `action: ${"action" in result ? result.action : "unknown"}`,
        `ok: ${result.ok}`,
    ];
    if ("error" in result && result.error) lines.push(`error: ${result.error}`);
    if (service) {
        lines.push(`platform: ${service.platform}`);
        lines.push(`manager: ${service.manager}`);
        lines.push(`supported: ${service.supported}`);
        lines.push(`service: ${service.serviceName}`);
        lines.push(`definition: ${service.definitionPath || "(manager-owned)"}`);
        lines.push(`command: ${service.command.join(" ")}`);
    }
    if ("serviceOwner" in result) lines.push(`owner: ${result.serviceOwner?.ownerId || "(none)"}`);
    if ("ownedByCurrentOwner" in result) lines.push(`ownedByCurrentOwner: ${result.ownedByCurrentOwner}`);
    if ("dryRun" in result) lines.push(`dryRun: ${result.dryRun}`);
    if ("installed" in result) lines.push(`installed: ${result.installed ?? "unknown"}`);
    if ("running" in result) lines.push(`running: ${result.running ?? "unknown"}`);
    const diagnostics = "diagnostics" in result && Array.isArray(result.diagnostics) ? result.diagnostics : [];
    for (const diagnostic of diagnostics) lines.push(`diagnostic: ${diagnostic}`);
    const commands = service?.commands || [];
    if (commands.length > 0) {
        lines.push("commands:");
        for (const command of commands) lines.push(`  ${command.provider}: ${command.executable || "(missing)"} ${(command.args || []).join(" ")}`.trimEnd());
    }
    const results = "results" in result && Array.isArray(result.results) ? result.results : [];
    if (results.length > 0) {
        lines.push("results:");
        for (const command of results) lines.push(`  ${command.provider}: status=${command.status ?? "null"}${command.error ? ` error=${command.error}` : ""}`);
    }
    return `${lines.join("\n")}\n`;
}

export function startDeviceBrokerServe(
    args: string[],
    cwd = process.cwd(),
    profileOrFactory: string | typeof createDeviceBrokerServer | undefined = undefined,
    serverFactory: typeof createDeviceBrokerServer = createDeviceBrokerServer,
): number {
    const profile = typeof profileOrFactory === "string" ? profileOrFactory : undefined;
    const factory = typeof profileOrFactory === "function" ? profileOrFactory : serverFactory;
    const { host, port } = parseBrokerServeArgs(args);
    const startedAt = new Date().toISOString();
    const ownerId = deviceBrokerOwnerId(cwd, profile);
    const cliPath = process.argv[1] || fileURLToPath(new URL("./broker-entry.js", import.meta.url));
    const { runtimeFile } = normalizeBrokerOptions({ cwd, profile, host, port, startedAt, cliPath });
    const server = factory({ cwd, profile, host, port, startedAt, cliPath });
    deviceBrokerOwnerToken(ownerId);
    server.listen(port, host, () => {
        if (!args.includes("--runtime-managed-by-parent")) {
            writeHostBrokerRuntime(runtimeFile, {
                name: DEVICE_BROKER_NAME,
                managedBy: "ccc-host",
                ownerId,
                pid: process.pid,
                host,
                probeHost: DEVICE_BROKER_DEFAULT_HOST,
                hostCandidates: hostBrokerProbeCandidates(host, DEVICE_BROKER_DEFAULT_HOST),
                port,
                command: process.execPath,
                args: [cliPath, "devices", "broker", "serve", "--host", host, "--port", String(port)],
                cwd,
                profile: profile || null,
                startedAt,
            });
        }
        console.log(`ccc-device-broker listening on http://${host}:${port}`);
    });
    return 0;
}

export function deviceBrokerCli(args: string[], cwd = process.cwd(), profile?: string): number {
    const command = args[0] || "status";
    if (command === "status") {
        console.log(formatDeviceBrokerStatus({ cwd, profile }, args.includes("--verbose")));
        return 0;
    }
    if (command === "serve") {
        return startDeviceBrokerServe(args.slice(1), cwd, profile);
    }
    if (command === "service") {
        console.error([
            "Usage: ccc devices broker status",
            "Broker service repair is automatic; manual service verbs are internal diagnostics.",
        ].join("\n"));
        return 1;
    }
    console.error("Usage: ccc devices broker status");
    return 1;
}

export async function deviceBrokerCliAsync(
    args: string[],
    cwd = process.cwd(),
    profile?: string,
    hooks: { ensureHostBroker?: typeof ensureHostDeviceBroker; trustedCliPaths?: string[] } = {},
): Promise<number> {
    const command = args[0] || "status";
    if (command !== "status") return deviceBrokerCli(args, cwd, profile);

    const ensure = hooks.ensureHostBroker || ensureHostDeviceBroker;
    const readiness = await ensure({ cwd, profile, ...(hooks.trustedCliPaths ? { trustedCliPaths: hooks.trustedCliPaths } : {}) });
    const readinessRecord = readiness as Record<string, unknown>;
    if (!args.includes("--verbose")) {
        if (!readiness.ok) {
            const reason = "error" in readiness ? readiness.error : readiness.reason || "unknown";
            console.error(`Broker: unavailable (${reason})`);
            if ("diagnostics" in readiness && Array.isArray(readiness.diagnostics)) {
                for (const diagnostic of new Set(readiness.diagnostics)) console.error(String(diagnostic));
            }
            return 1;
        }
        const host = typeof readinessRecord.host === "string" ? readinessRecord.host : DEVICE_BROKER_DEFAULT_HOST;
        const port = Number.isInteger(readinessRecord.port) ? Number(readinessRecord.port) : DEVICE_BROKER_DEFAULT_PORT;
        console.log(`Broker: ready${readiness.launched === true ? " (started)" : ""}\nhttp://${host}:${port}`);
        return 0;
    }
    console.log(formatDeviceBrokerStatus({
        cwd,
        profile,
        ...(typeof readinessRecord.host === "string" ? { host: readinessRecord.host } : {}),
        ...(Number.isInteger(readinessRecord.port) ? { port: Number(readinessRecord.port) } : {}),
        ...(typeof readinessRecord.ownerId === "string" ? { ownerId: readinessRecord.ownerId } : {}),
    }, true));
    if (!readiness.ok) {
        console.error(`brokerReady: false`);
        console.error(`brokerRepairError: ${"error" in readiness ? readiness.error : readiness.reason || "unknown"}`);
        if ("diagnostics" in readiness && Array.isArray(readiness.diagnostics)) {
            for (const diagnostic of readiness.diagnostics) {
                console.error(`brokerRepairDiagnostic: ${diagnostic}`);
            }
        }
        return 1;
    }
    console.log(`brokerReady: true`);
    console.log(`brokerReused: ${readiness.reused === true}`);
    console.log(`brokerLaunched: ${readiness.launched === true}`);
    if (Number.isInteger(readinessRecord.verifiedProtocolVersion)) {
        console.log(`brokerVerifiedProtocolVersion: ${readinessRecord.verifiedProtocolVersion}`);
    }
    if (Number.isInteger(readinessRecord.verifiedBrokerPid)) {
        console.log(`brokerVerifiedPid: ${Number(readinessRecord.verifiedBrokerPid)}`);
    }
    if (typeof readinessRecord.verifiedBrokerStartedAt === "string") {
        console.log(`brokerVerifiedStartedAt: ${readinessRecord.verifiedBrokerStartedAt}`);
    }
    return 0;
}
